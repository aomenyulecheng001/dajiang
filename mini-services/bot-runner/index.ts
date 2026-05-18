/**
 * Bot Runner Service - Telegram Bot Process Manager
 * 
 * This service manages the lifecycle of Telegram bot processes:
 * - Generate bot code from custom code or project files
 * - Install dependencies (npm install / pip install)
 * - Start / Stop / Restart bot processes
 * - Stream real-time logs via WebSocket (Socket.IO)
 * - Health monitoring via heartbeat
 * - Inject environment variables
 * - Receive Telegram webhook updates via HTTP
 */

import { existsSync, readFileSync } from 'fs'
import { readdir, access, rm } from 'fs/promises'
import { randomBytes, timingSafeEqual, createHash, createHmac } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { BotProcess, DeployStage } from './types'
import { PORT, CONFIG_DIR, loadBotConfigAsync, BOTS_DIR, sanitizeBotId, getBotDir } from './utils'
import { MAX_LOG_LINES, setLogState, cleanupOldLogs, startLogCleanup, stopLogCleanup, LOGS_DIR } from './log-manager'

import { httpServer, io } from './socket'
import { handleBotExit, startBotProcess, stopBotProcess, clearAllRestartTimers, intentionalStopSet } from './process-manager'
import { registerHandlers } from './handlers'
import { startMonitoring, stopMonitoring } from './monitor'

// ─── Shared State ────────────────────────────────────────────────────────

const botProcesses = new Map<string, BotProcess>()
const deployStatus = new Map<string, { stage: DeployStage; progress: number; error?: string; logs: string[] }>()

// ─── Runner Secret for HTTP Auth ────────────────────────────────────────────

function loadRunnerSecret(): string {
  // P2-BR-10 NOTE: Sync fs at startup is acceptable — runs only once during initialization
  try {
    const secretPath = `${CONFIG_DIR}/runner-secret`
    if (existsSync(secretPath)) {
      return readFileSync(secretPath, 'utf-8').trim()
    }
  } catch { /* ignore */ }
  return ''
}

const RUNNER_SECRET = loadRunnerSecret()

if (!RUNNER_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] RUNNER_SECRET is empty in production. Refusing to start without authentication.')
  process.exit(1)
}
if (!RUNNER_SECRET) {
  console.warn('[WARN] RUNNER_SECRET is empty — all HTTP endpoints are unauthenticated. Set RUNNER_SECRET for production.')
}

// ─── Wire Up Log Manager ─────────────────────────────────────────────────

setLogState(botProcesses, deployStatus)

// ─── Create Bound Process Functions ──────────────────────────────────────

/** Bound startBotProcess that carries botProcesses reference */
async function boundStartBotProcess(botId: string): Promise<void> {
  await startBotProcess(botId, botProcesses, boundHandleBotExit)
}

/** Bound handleBotExit that carries botProcesses and startBotProcess references */
async function boundHandleBotExit(botId: string, code: number | null, signal: string | null, exitedProcess?: import('child_process').ChildProcess): Promise<void> {
  await handleBotExit(botId, code, signal, botProcesses, boundStartBotProcess, exitedProcess)
}

/** Bound stopBotProcess that carries botProcesses reference */
function boundStopBotProcess(botId: string): void {
  stopBotProcess(botId, botProcesses)
}

// ─── Cleanup Old Logs ────────────────────────────────────────────────────

// P3-6 FIX: cleanupOldLogs is now async — fire-and-forget at startup
cleanupOldLogs().catch(() => {})
startLogCleanup() // P2-33 FIX: Start periodic log cleanup every 6 hours

// ─── Webhook HTTP Endpoint ───────────────────────────────────────────────

/**
 * P0-4 FIX: Verify webhook secret passed from the Next.js API gateway.
 * The Next.js API already verifies the Telegram secret_token header,
 * but we add a second layer of defense here for direct HTTP access.
 *
 * Verification logic:
 * 1. If no X-Webhook-Secret header → allow (backward compat)
 * 2. If header present → load bot config and compare against stored webhookSecret
 * 3. If bot has no webhookSecret in config → allow (not configured)
 */
async function verifyWebhookSecret(req: IncomingMessage, botId: string, body?: string): Promise<boolean> {
  const signature = req.headers['x-webhook-signature'] as string | undefined
  const forwardedSecret = req.headers['x-webhook-secret'] as string | undefined

  if (!signature && !forwardedSecret) {
    const config = await loadBotConfigAsync(botId)
    if (!config) {
      console.warn(`[Webhook] Unknown bot ${botId}, rejecting webhook`)
      return false
    }
    const storedSecret = config.envVars?.WEBHOOK_SECRET || config.webhookSecret
    if (storedSecret) {
      console.warn(`[Webhook] No auth header for bot ${botId} with configured secret — rejecting`)
      return false
    }
    return true
  }
  const config = await loadBotConfigAsync(botId)
  if (!config) {
    console.warn(`[Webhook] Unknown bot ${botId}, rejecting webhook`)
    return false
  }
  const storedSecret = config.envVars?.WEBHOOK_SECRET || config.webhookSecret
  if (!storedSecret) {
    return true
  }
  if (signature && body) {
    const expectedSig = createHmac('sha256', storedSecret).update(body).digest('hex')
    const expectedHash = createHash('sha256').update(`sha256=${expectedSig}`, 'utf-8').digest()
    const providedHash = createHash('sha256').update(signature, 'utf-8').digest()
    if (!timingSafeEqual(expectedHash, providedHash)) {
      console.warn(`[Webhook] Invalid webhook signature for bot ${botId}`)
      return false
    }
    return true
  }
  if (forwardedSecret) {
    const tokenHash = createHash('sha256').update(forwardedSecret, 'utf-8').digest()
    const secretHash = createHash('sha256').update(storedSecret, 'utf-8').digest()
    if (!timingSafeEqual(tokenHash, secretHash)) {
      console.warn(`[Webhook] Invalid webhook secret for bot ${botId}`)
      return false
    }
    return true
  }
  return false
}

httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
  // CRITICAL FIX: Top-level try-catch to prevent hanging responses on errors.
  // Without this, any unhandled exception in the async handler leaves the
  // client waiting forever (no response sent, socket stays open).
  try {
  // Skip Socket.IO transport requests — Socket.IO handles these asynchronously,
  // and our catch-all 404 would fire before Socket.IO's async handler completes.
  if (req.url?.startsWith('/socket.io')) {
    return
  }

  if (req.method === 'POST' && req.url?.startsWith('/webhook/')) {
    const rawBotId = req.url.replace('/webhook/', '').split('?')[0]
    const botId = sanitizeBotId(rawBotId)

    if (!botId || botId !== rawBotId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Invalid bot ID' }))
      return
    }

    const MAX_WEBHOOK_BODY_SIZE = 1 * 1024 * 1024
    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of req) {
      totalSize += chunk.length
      if (totalSize > MAX_WEBHOOK_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
        return
      }
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString()

    if (!(await verifyWebhookSecret(req, botId, body))) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Invalid webhook secret' }))
      return
    }

    const bot = botProcesses.get(botId)
    if (bot?.process?.stdin && !bot.process.stdin.destroyed) {
      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      // P2-BR-12 FIX: Handle stdin.write() backpressure and errors
      const payload = JSON.stringify({ type: 'webhook', data: parsedBody }) + '\n'
      const canWrite = bot.process.stdin.write(payload)
      if (!canWrite) {
        // Backpressure: log warning but don't block the response
        console.warn(`[Webhook] stdin backpressure for bot ${botId}, data buffered`)
      }
      // Add error handler if not already present
      if (!bot._stdinErrorHandler) {
        bot._stdinErrorHandler = true
        bot.process.stdin.on('error', (err: Error) => {
          console.error(`[Webhook] stdin error for bot ${botId}:`, err.message)
        })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Bot process not running' }))
    }
  }

  // ── P2-1 FIX: HTTP cleanup endpoint for bot deletion ──
  // Called by Next.js API DELETE handler to stop process + clean disk
  if (req.method === 'DELETE' && req.url?.startsWith('/cleanup/')) {
    const rawBotId = req.url.replace('/cleanup/', '').split('?')[0]
    const botId = sanitizeBotId(rawBotId)

    if (!botId || botId !== rawBotId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Invalid bot ID' }))
      return
    }

    // P1-FIX: Require runner secret for cleanup endpoint
    // P2-BR-2 FIX: Use SHA-256 hashing + timing-safe comparison for cleanup auth
    // (same approach as webhook secret verification to prevent length-leak timing attacks)
    if (RUNNER_SECRET) {
      const authHeader = req.headers['x-runner-secret'] as string | undefined
      if (!authHeader) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
      }
      const tokenHash = createHash('sha256').update(authHeader, 'utf-8').digest()
      const secretHash = createHash('sha256').update(RUNNER_SECRET, 'utf-8').digest()
      if (!timingSafeEqual(tokenHash, secretHash)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
      }
    }

    // P2-30 FIX: Add 10-second timeout to cleanup handler
    let responded = false
    const cleanupTimeout = setTimeout(() => {
      if (!responded) {
        responded = true
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Cleanup timeout' }))
      }
    }, 10000)

    console.log(`[Cleanup] Cleaning up bot ${botId}`)

    // SEC FIX: Audit log for destructive cleanup operation.
    // Records who/when triggered cleanup, what was affected, and from which IP.
    const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || 'unknown'
    console.log(`[Cleanup-Audit] bot=${botId} action=cleanup ip=${clientIp} time=${new Date().toISOString()} running=${botProcesses.has(botId)}`)

    // Stop process if running
    boundStopBotProcess(botId)

    // Clean up disk
    const botDir = getBotDir(botId)
    const configPath = `${CONFIG_DIR}/${botId}.json`
    const logPath = `${LOGS_DIR}/${botId}.log`

    // P2-BR-1 FIX: Use async fs operations instead of sync to avoid blocking event loop
    ;(async () => {
      try {
        // BUG FIX: Wait for the bot process to actually exit before deleting files.
        // Previously, boundStopBotProcess sends SIGTERM but returns immediately —
        // the process may still be running when rm() executes. On Linux this can
        // leave zombie files; on Windows the files may be locked and deletion silently fails.
        const bot = botProcesses.get(botId)
        if (bot?.process) {
          await new Promise<void>(resolve => {
            const exitTimeout = setTimeout(resolve, 5000) // Max 5s wait
            bot.process!.once('close', () => { clearTimeout(exitTimeout); resolve() })
          })
        }

        await access(botDir).then(() => rm(botDir, { recursive: true, force: true })).catch(() => {})
        await access(configPath).then(() => rm(configPath, { force: true })).catch(() => {})
        await access(logPath).then(() => rm(logPath, { force: true })).catch(() => {})
      } catch { /* ignore cleanup errors */ }

      // Remove from memory
      botProcesses.delete(botId)
      deployStatus.delete(botId)
      // Clean up tracking sets to prevent memory leak
      intentionalStopSet.delete(botId)

      // Notify frontend to clean up stale runner state
      io.emit('bot:deleted', { botId })

      console.log(`[Cleanup] Bot ${botId} fully removed`)
      console.log(`[Cleanup-Audit] bot=${botId} action=cleanup-complete ip=${clientIp} time=${new Date().toISOString()} result=success`)
      if (!responded) {
        responded = true
        clearTimeout(cleanupTimeout)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }
    })()
    return
  }

  // P2-BR-7 FIX: Health check endpoint for container orchestration
  if (req.method === 'GET' && req.url === '/health') {
    // P0-4 FIX: Require runner-secret for health endpoint to prevent information leakage
    if (RUNNER_SECRET) {
      const authHeader = req.headers['x-runner-secret'] as string | undefined
      if (!authHeader) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
      }
      const tokenHash = createHash('sha256').update(authHeader, 'utf-8').digest()
      const secretHash = createHash('sha256').update(RUNNER_SECRET, 'utf-8').digest()
      if (!timingSafeEqual(tokenHash, secretHash)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // P1-FIX: Return 404 for unmatched routes (prevents hanging connections)
  if (!res.writableEnded) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Not found' }))
  }

  } catch (error) {
    // Top-level catch: handle unexpected errors (e.g., client disconnect during body read,
    // disk I/O errors, etc.) and ensure a response is always sent.
    console.error('[HTTP] Unhandled request error:', error)
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Internal server error' }))
    }
  }
})

// ─── Register Socket.IO Handlers ─────────────────────────────────────────

registerHandlers(io, botProcesses, deployStatus, boundStartBotProcess, boundStopBotProcess)

// ─── Start Resource Monitoring ───────────────────────────────────────────

startMonitoring(botProcesses)

// ─── Startup Recovery ────────────────────────────────────────────────────

/** Load bot configs from disk and create stopped BotProcess records */
// P2-BR-10 FIX: Made async to use loadBotConfigAsync and readdir
async function recoverBotConfigs() {
  try {
    const files = await readdir(CONFIG_DIR)
    const configFiles = files.filter(f => f.endsWith('.json'))
    let loaded = 0
    for (const file of configFiles) {
      const botId = file.replace('.json', '')
      if (botProcesses.has(botId)) continue
      const config = await loadBotConfigAsync(botId)
      if (config) {
        const validLangs = ['javascript', 'typescript', 'python']
        const lang = validLangs.includes(config.language) ? config.language : 'javascript'
        botProcesses.set(botId, {
          id: botId,
          name: config.name,
          language: lang as 'javascript' | 'typescript' | 'python',
          status: 'stopped',
          envVars: config.envVars,
          logBuffer: [],
          maxLogLines: MAX_LOG_LINES,
          entryPoint: config.entryPoint,
          cpuUsage: 0,
          memoryUsage: 0,
          restartCount: 0,
          maxRestarts: 5,
          maxMemoryMb: 256,
        })
        // P1-19 FIX: Track bots that were running before shutdown for auto-restart
        const runningMarker = `${CONFIG_DIR}/${botId}.running`
        if (existsSync(runningMarker)) {
          const botEntry = botProcesses.get(botId)!
          botEntry._wasRunning = true
        }
        loaded++
      }
    }
    console.log(`[Startup] Loaded ${loaded} bot configs from disk`)
  } catch (err: any) {
    console.error(`[Startup] Failed to load bot configs: ${err.message}`)
  }
}

// ─── Start Server ────────────────────────────────────────────────────────

httpServer.listen(PORT, async () => {
  // Recover bot configs from disk (stopped state, no auto-start)
  // Await to ensure configs are loaded before accepting connections
  await recoverBotConfigs()

  // P1-19 FIX: Auto-start bots that were running before shutdown
  const autoStartBots: string[] = []
  for (const [id, bot] of botProcesses.entries()) {
    if ((bot as any)._wasRunning) {
      autoStartBots.push(id)
      delete (bot as any)._wasRunning
    }
  }
  if (autoStartBots.length > 0) {
    console.log(`[Startup] Auto-starting ${autoStartBots.length} previously running bot(s): ${autoStartBots.join(', ')}`)
    for (const botId of autoStartBots) {
      await boundStartBotProcess(botId).catch(err => console.error(`[Startup] Failed to auto-start ${botId}:`, err))
    }
  }

  console.log(``)
  console.log(`🚀 Bot Runner Service`)
  console.log(`   Port: ${PORT}`)
  console.log(`   Bots Dir: ${BOTS_DIR}`)
  console.log(`   Templates: removed`)
  console.log(``)
})

// ─── Graceful Shutdown ──────────────────────────────────────────────────

/**
 * P1-9 FIX: Unified graceful shutdown handler.
 * Handles both SIGINT (Ctrl+C) and SIGTERM (Docker/containers/kill).
 */
function gracefulShutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`)
  stopMonitoring()
  stopLogCleanup() // P2-33 FIX: Stop periodic log cleanup on shutdown
  clearAllRestartTimers() // P2-BR-4 FIX: Cancel pending auto-restart timers

  // Stop all running bot processes
  const runningBots: string[] = []
  for (const [id, bot] of botProcesses.entries()) {
    if (bot.status === 'running' || bot.status === 'starting') {
      boundStopBotProcess(id)
      runningBots.push(id)
    }
  }

  if (runningBots.length > 0) {
    console.log(`   Stopping ${runningBots.length} bot process(es): ${runningBots.join(', ')}`)
  }

  // Force exit after timeout (in case any process hangs)
  const forceExitTimer = setTimeout(() => {
    console.log('   ⚠️  Forced exit after timeout')
    process.exit(1)
  }, 5000)
  forceExitTimer.unref() // Don't let this timer prevent Node.js from exiting naturally

  // Close HTTP server (stops accepting new connections)
  httpServer.close(() => {
    console.log('   HTTP server closed')
    process.exit(0)
  })

  // Also disconnect all Socket.IO clients
  io.disconnectSockets(true)
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
