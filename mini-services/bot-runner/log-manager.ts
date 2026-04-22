import { readdir, stat, unlink } from 'fs/promises'
import { appendFile } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'
import { io } from './socket'
import type { BotProcess, DeployStage } from './types'
import { sanitizeBotId } from './utils'

// ─── Log Constants ────────────────────────────────────────────────────────

export const MAX_LOG_LINES = 500
export const LOGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'logs')
// P3-6 FIX: Only use sync mkdirSync at module init time (acceptable for startup)
mkdirSync(LOGS_DIR, { recursive: true })

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
          console.log(`[Cleanup] Deleted old log: ${file}`)
        }
      } catch { /* ignore individual file errors */ }
    }
  } catch (err: any) {
    console.error(`[Cleanup] Failed to cleanup old logs: ${err.message}`)
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

// ─── Log Append Functions ─────────────────────────────────────────────────

export function appendLog(botId: string, message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') {
  const bot = _botProcesses?.get(botId)
  if (!bot) return

  const timestamp = new Date().toISOString()
  const logLine = JSON.stringify({ timestamp, level, message })

  bot.logBuffer.push(logLine)
  if (bot.logBuffer.length > bot.maxLogLines) {
    bot.logBuffer = bot.logBuffer.slice(-MAX_LOG_LINES)
  }

  // P2-34 FIX: Handle ENOSPC (disk full) errors specifically instead of silently ignoring
  // P2-BR-8 FIX: Use async appendFile instead of sync appendFileSync to avoid blocking event loop
  appendFile(join(LOGS_DIR, `${sanitizeBotId(botId)}.log`), `${timestamp} [${level}] ${message}\n`, 'utf-8')
    .then(() => { _enospcWarned = false }) // Reset flag on successful write
    .catch((err: any) => {
      if (err.code === 'ENOSPC') {
        if (!_enospcWarned) {
          console.warn(`[LogManager] Disk full (ENOSPC) — skipping log write for bot ${botId}`)
          _enospcWarned = true
        }
      } else if (err.code !== 'ENOENT') {
        // ENOENT is fine (directory might not exist in edge cases), but other errors should be logged
        console.error(`[LogManager] Log write error for bot ${botId}:`, err.message)
      }
    })

  // Broadcast to connected WebSocket clients
  io.emit('bot:log', { botId, timestamp, level, message })
}

export function appendDeployLog(botId: string, message: string) {
  const status = _deployStatus?.get(botId)
  if (status) {
    status.logs.push(`[${new Date().toISOString()}] ${message}`)
    io.emit('deploy:progress', { botId, ...status })
  }
}
