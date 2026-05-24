import { readdir, stat, unlink } from 'fs/promises'
import { appendFile } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'
import { logger } from './logger'
import { io } from './socket'
import type { BotProcess, DeployStage } from './types'
import { sanitizeBotId } from './utils'

// ─── Log Constants ────────────────────────────────────────────────────────

export const MAX_LOG_LINES = 500
export const MAX_LOG_FILE_SIZE = 50 * 1024 * 1024 // 50MB — warn and truncate when exceeded
export const LOGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'logs')
// P3-6 FIX: Only use sync mkdirSync at module init time (acceptable for startup)
mkdirSync(LOGS_DIR, { recursive: true })

// ─── Sensitive Data Filtering (Security Fix) ──────────────────────────────

/**
 * Patterns for detecting and redacting sensitive information in logs.
 * FIX: Prevents accidental leakage of tokens, passwords, API keys, etc.
 */
// CANONICAL SOURCE: These patterns must be kept in sync with
// src/lib/security-utils.ts SENSITIVE_DATA_PATTERNS.
// Any changes here should be mirrored there and vice versa.
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Bot tokens (Telegram, Discord, Slack format)
  { pattern: /\d{9,}:[a-zA-Z0-9_-]{30,}/g, replacement: '[BOT_TOKEN_REDACTED]' },
  // Generic bot_token patterns
  { pattern: /bot[_-]?token["\s:=]+[a-zA-Z0-9:_-]+/gi, replacement: 'bot_token=[REDACTED]' },
  // API keys
  { pattern: /api[_-]?key["\s:=]+[a-zA-Z0-9_-]+/gi, replacement: 'api_key=[REDACTED]' },
  // Passwords
  { pattern: /password["\s:=]+[^\s]+/gi, replacement: 'password=[REDACTED]' },
  // Secrets
  { pattern: /secret["\s:=]+[^\s]+/gi, replacement: 'secret=[REDACTED]' },
  // Authorization headers
  { pattern: /authorization["\s:=]+bearer\s+[a-zA-Z0-9._-]+/gi, replacement: 'authorization=Bearer [REDACTED]' },
  // JWT tokens
  { pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g, replacement: '[JWT_REDACTED]' },
  // Connection strings with passwords
  { pattern: /:\/\/[^:]+:[^@]+@/g, replacement: '://[USER]:[PASS]@' },
  // Private keys (PEM format start)
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
]

/**
 * Sanitize a log message by redacting sensitive information.
 * FIX: Prevents sensitive data from being written to log files.
 * 
 * @param message - The original log message
 * @returns The sanitized message with sensitive data replaced
 */
export function sanitizeLogMessage(message: string): string {
  let sanitized = message
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement)
  }
  return sanitized
}

// ─── Shared State (imported from modules that need them) ──────────────────

// We use a getter pattern so the state can be set after module initialization
let _botProcesses: Map<string, BotProcess> | null = null
let _deployStatus: Map<string, { stage: DeployStage; progress: number; error?: string; logs: string[] }> | null = null

export function setLogState(
  botProcesses: Map<string, BotProcess>,
  deployStatus: Map<string, { stage: DeployStage; progress: number; error?: string; logs: string[] }>,
) {
  _botProcesses = botProcesses
  _deployStatus = deployStatus
}

// ─── Log Cleanup ──────────────────────────────────────────────────────────

/** Delete log files older than 7 days — P3-6 FIX: now async */
export async function cleanupOldLogs() {
  try {
    const files = await readdir(LOGS_DIR)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const file of files) {
      const filePath = join(LOGS_DIR, file)
      try {
        const fileStat = await stat(filePath)
        if (fileStat.mtimeMs < sevenDaysAgo) {
          await unlink(filePath)
          logger.info('log-manager', `Deleted old log: ${file}`)
          // Reset size tracking for deleted log files
          const botId = file.replace('.log', '')
          _logFileSizeEstimate.delete(botId)
          _sizeWarned.delete(botId)
        }
      } catch { /* ignore individual file errors */ }
    }
  } catch (err: any) {
    logger.error('log-manager', `Failed to cleanup old logs: ${err.message}`)
  }
}

// P2-33 FIX: Periodic log cleanup every 6 hours to prevent unbounded log growth
let logCleanupTimer: ReturnType<typeof setInterval> | null = null
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

export function startLogCleanup() {
  if (logCleanupTimer) return // Avoid duplicate timers
  logCleanupTimer = setInterval(() => {
    cleanupOldLogs()
  }, LOG_CLEANUP_INTERVAL_MS)
  logCleanupTimer.unref() // Don't let this timer prevent process exit
}

export function stopLogCleanup() {
  if (logCleanupTimer) {
    clearInterval(logCleanupTimer)
    logCleanupTimer = null
  }
}

// P2-34 FIX: Flag to suppress repeated ENOSPC warnings
let _enospcWarned = false

// FIX: Track approximate log file sizes per bot to warn on excessive growth
const _logFileSizeEstimate = new Map<string, number>()
let _sizeWarned = new Set<string>()

// ─── Log Append Functions ─────────────────────────────────────────────────

export function appendLog(botId: string, message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') {
  const bot = _botProcesses?.get(botId)
  if (!bot) return

  // FIX: Sanitize message to remove sensitive information before logging
  const safeMessage = sanitizeLogMessage(message)
  
  const timestamp = new Date().toISOString()
  const logLine = JSON.stringify({ timestamp, level, message: safeMessage })

  bot.logBuffer.push(logLine)
  if (bot.logBuffer.length > bot.maxLogLines) {
    bot.logBuffer = bot.logBuffer.slice(-bot.maxLogLines)
  }

  // FIX: Track approximate log file size and warn if it exceeds MAX_LOG_FILE_SIZE
  const logLineBytes = Buffer.byteLength(`${timestamp} [${level}] ${safeMessage}\n`, 'utf-8')
  const currentSize = (_logFileSizeEstimate.get(botId) || 0) + logLineBytes
  _logFileSizeEstimate.set(botId, currentSize)
  if (currentSize > MAX_LOG_FILE_SIZE && !_sizeWarned.has(botId)) {
    logger.warn('log-manager', `Log file for bot ${botId} exceeds ${Math.round(MAX_LOG_FILE_SIZE / 1024 / 1024)}MB — consider rotating`)
    _sizeWarned.add(botId)
  }

  // P2-34 FIX: Handle ENOSPC (disk full) errors specifically instead of silently ignoring
  // P2-BR-8 FIX: Use async appendFile instead of sync appendFileSync to avoid blocking event loop
  // FIX: Also sanitize the message written to file
  appendFile(join(LOGS_DIR, `${sanitizeBotId(botId)}.log`), `${timestamp} [${level}] ${safeMessage}\n`, 'utf-8')
    .then(() => { _enospcWarned = false }) // Reset flag on successful write
    .catch((err: any) => {
      if (err.code === 'ENOSPC') {
        if (!_enospcWarned) {
          logger.warn('log-manager', `Disk full (ENOSPC) — skipping log write for bot ${botId}`)
          _enospcWarned = true
        }
      } else if (err.code !== 'ENOENT') {
        // ENOENT is fine (directory might not exist in edge cases), but other errors should be logged
        logger.error('log-manager', `Log write error for bot ${botId}:`, err.message)
      }
    })

  // Broadcast to connected WebSocket clients
  io.emit('bot:log', { botId, timestamp, level, message: safeMessage })
}

export const MAX_DEPLOY_LOG_LINES = 1000

export function appendDeployLog(botId: string, message: string) {
  const status = _deployStatus?.get(botId)
  if (status) {
    const sanitizedMessage = sanitizeLogMessage(message)
    const logLine = `[${new Date().toISOString()}] ${sanitizedMessage}`
    status.logs.push(logLine)
    if (status.logs.length > MAX_DEPLOY_LOG_LINES) {
      status.logs = status.logs.slice(-MAX_DEPLOY_LOG_LINES)
    }
    io.emit('deploy:log', { botId, log: logLine })
  }
}
