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
import { handleBotExit, startBotProcess, stopBotProcess, clearAllRestartTimers, intentionalStopSet, memoryKilledSet, cancelRestartTimer, findAndKillOrphan, cleanupPidFile } from './process-manager'
import { registerHandlers } from './handlers'
import { startMonitoring, stopMonitoring } from './monitor'
import { logger } from './logger'

// ─── Shared State ────────────────────────────────────────────────────────

const botProcesses = new Map<string, BotProcess>()
const deployStatus = new Map<string, { stage: DeployStage; progress: number; error?: string; logs: string[] }>()

// ─── Runner Secret for HTTP Auth ────────────────────────────────────────────

function loadRunnerSecret(): string {
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
  logger.error('main', 'RUNNER_SECRET is empty in production. Refusing to start without authentication.')
  for (const [, bot] of botProcesses) {
    try { bot.process?.kill('SIGTERM') } catch { /* ignore */ }
  }
  process.exit(1)
}
if (!RUNNER_SECRET) {
  logger.warn('main', 'RUNNER_SECRET is empty — all HTTP endpoints are unauthenticated. Set RUNNER_SECRET for production.')
}

// ─── Wire Up Log Manager ─────────────────────────────────────────────────

setLogState(botProcesses, deployStatus)

// ─── Create Bound Process Functions ──────────────────────────────────────

async function boundStartBotProcess(botId: string): Promise<void> {
  await startBotProcess(botId, botProcesses, boundHandleBotExit)
}

async function boundHandleBotExit(botId: string, code: number | null, signal: string | null, exitedProcess?: import('child_process').ChildProcess): Promise<void> {
  await handleBotExit(botId, code, signal, botProcesses, boundStartBotProcess, exitedProcess)
}

function boundStopBotProcess(botId: string): void {
  stopBotProcess(botId, botProcesses)
}

// ─── Cleanup Old Logs ────────────────────────────────────────────────────

cleanupOldLogs().catch(() => {})
startLogCleanup()

// ─── Webhook HTTP Endpoint ───────────────────────────────────────────────

async function verifyWebhookSecret(req: IncomingMessage, botId: string, body?: string): Promise<boolean> {
  const signature = req.headers['x-webhook-signature'] as string | undefined
  const forwardedSecret = req.headers['x-webhook-secret'] as string | undefined

  const config = await loadBotConfigAsync(botId)
  if (!config) {
    logger.warn('webhook', `Unknown bot ${botId}, rejecting webhook`)
    return false
  }
  const storedSecret = config.envVars?.WEBHOOK_SECRET || config.webhookSecret

  if (!signature && !forwardedSecret) {
    if (storedSecret) {
      logger.warn('webhook', `No auth header for bot ${botId} with configured secret — rejecting`)
      return false
    }
    return true
  }
  if (!storedSecret) {
    return true
  }
  if (signature && body) {
    const expectedSig = `sha256=${createHmac('sha256', storedSecret).update(body).digest('hex')}`
    const expectedHash = createHash('sha256').update(expectedSig, 'utf-8').digest()
    const providedHash = createHash('sha256').update(signature, 'utf-8').digest()
    if (!timingSafeEqual(expectedHash, providedHash)) {
      logger.warn('webhook', `Invalid webhook signature for bot ${botId}`)
      return false
    }
    return true
  }
  if (forwardedSecret) {
    const tokenHash = createHash('sha256').update(forwardedSecret, 'utf-8').digest()
    const secretHash = createHash('sha256').update(storedSecret, 'utf-8').digest()
    if (!timingSafeEqual(tokenHash, secretHash)) {
      logger.warn('webhook', `Invalid webhook secret for bot ${botId}`)
      return false
    }
    return true
  }
  return false
}

httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
  try {
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
      const payload = JSON.stringify({ type: 'webhook', data: parsedBody }) + '\n'
      const canWrite = bot.process.stdin.write(payload)
      if (!canWrite) {
        logger.warn('webhook', `stdin backpressure for bot ${botId}, data buffered`)
      }
      if (!bot._stdinErrorHandler) {
        bot._stdinErrorHandler = true
        bot.process.stdin.on('error', (err: Error) => {
          logger.error('webhook', `stdin error for bot ${botId}`, err.message)
        })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Bot process not running' }))
    }
  }

  // ── HTTP cleanup endpoint for bot deletion ──
  if (req.method === 'DELETE' && req.url?.startsWith('/cleanup/')) {
    const rawBotId = req.url.replace('/cleanup/', '').split('?')[0]
    const botId = sanitizeBotId(rawBotId)

    if (!botId || botId !== rawBotId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Invalid bot ID' }))
      return
    }

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

    const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || 'unknown'
    logger.info('cleanup', `Cleaning up bot ${botId}`)
    logger.info('cleanup-audit', `bot=${botId} action=cleanup ip=${clientIp} running=${botProcesses.has(botId)}`)

    const botDir = getBotDir(botId)
    const configPath = `${CONFIG_DIR}/${botId}.json`
    const logPath = `${LOGS_DIR}/${botId}.log`
    const runningPath = `${CONFIG_DIR}/${botId}.running`

    // Wrap cleanup in a timeout — if it takes >15s, force-respond with an error.
    // The actual cleanup continues in the background.
    const CLEANUP_TIMEOUT_MS = 15_000
    let responded = false

    const cleanupPromise = (async (): Promise<{ processKilled: boolean; filesDeleted: boolean; reDeployed: boolean }> => {
      let processKilled = false

      // 1. Cancel auto-restart and mark as intentional stop
      cancelRestartTimer(botId)
      intentionalStopSet.add(botId)

      // 2. Kill any orphan process (survived from a previous bot-runner crash)
      try {
        processKilled = await findAndKillOrphan(botDir)
      } catch { /* non-critical */ }

      // 3. Stop the tracked process (if any)
      boundStopBotProcess(botId)

      // 4. Wait for tracked process to exit
      const bot = botProcesses.get(botId)
      if (bot?.process) {
        try {
          await new Promise<void>(resolve => {
            const exitTimeout = setTimeout(resolve, 5000)
            bot.process!.once('close', () => { clearTimeout(exitTimeout); resolve() })
          })
          processKilled = true
        } catch { /* ignore */ }
      }

      // 5. Check if bot was re-deployed while we were cleaning up
      const currentBot = botProcesses.get(botId)
      if (currentBot && (currentBot.status === 'running' || currentBot.status === 'starting')) {
        logger.info('cleanup', `Bot ${botId} was re-deployed, aborting cleanup`)
        return { processKilled: false, filesDeleted: false, reDeployed: true }
      }

      // 6. Clean up PID file explicitly (handleBotExit may not have fired)
      try { cleanupPidFile(botDir) } catch { /* ignore */ }

      // 7. Delete all bot files
      let filesDeleted = false
      try {
        await access(botDir).then(() => rm(botDir, { recursive: true, force: true })).catch(() => {})
        await access(configPath).then(() => rm(configPath, { force: true })).catch(() => {})
        await access(logPath).then(() => rm(logPath, { force: true })).catch(() => {})
        await access(runningPath).then(() => rm(runningPath, { force: true })).catch(() => {})
        filesDeleted = true
      } catch { /* cleanup errors are non-fatal */ }

      // 8. Remove from memory maps
      botProcesses.delete(botId)
      deployStatus.delete(botId)
      intentionalStopSet.delete(botId)
      memoryKilledSet.delete(botId)

      // 9. Notify all clients
      io.emit('bot:deleted', { botId })

      logger.info('cleanup', `Bot ${botId} fully removed`)
      logger.info('cleanup-audit', `bot=${botId} action=cleanup-complete ip=${clientIp} result=success`)

      return { processKilled, filesDeleted, reDeployed: false }
    })()

    // Race the cleanup against a hard timeout
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), CLEANUP_TIMEOUT_MS)
    )

    Promise.race([cleanupPromise, timeoutPromise]).then((result) => {
      if (responded) return
      responded = true

      if (result === 'timeout') {
        logger.warn('cleanup', `Cleanup timed out for bot ${botId} after ${CLEANUP_TIMEOUT_MS}ms`)
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Cleanup timeout — process may not have been fully stopped', processKilled: false, filesDeleted: false }))
        // Cleanup continues in background — the promise is still running
        return
      }

      if (result.reDeployed) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, skipped: 're-deployed', processKilled: false, filesDeleted: false }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, processKilled: result.processKilled, filesDeleted: result.filesDeleted }))
    }).catch((err) => {
      logger.error('cleanup', `Unhandled error for bot ${botId}`, err instanceof Error ? err.message : String(err))
      if (!responded) {
        responded = true
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Cleanup failed', processKilled: false, filesDeleted: false }))
      }
    })

    return
  }

  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
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

  if (!res.writableEnded) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Not found' }))
  }

  } catch (error) {
    logger.error('http', 'Unhandled request error', error instanceof Error ? error.message : String(error))
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
        const runningMarker = `${CONFIG_DIR}/${botId}.running`
        if (existsSync(runningMarker)) {
          const botEntry = botProcesses.get(botId)!
          botEntry._wasRunning = true
        }
        loaded++
      }
    }
    logger.info('startup', `Loaded ${loaded} bot configs from disk`)
  } catch (err: any) {
    logger.error('startup', `Failed to load bot configs: ${err.message}`)
  }
}

// ─── Start Server ────────────────────────────────────────────────────────

httpServer.listen(PORT, async () => {
  await recoverBotConfigs()

  const autoStartBots: string[] = []
  for (const [id, bot] of botProcesses.entries()) {
    if ((bot as any)._wasRunning) {
      autoStartBots.push(id)
      delete (bot as any)._wasRunning
    }
  }
  if (autoStartBots.length > 0) {
    logger.info('startup', `Auto-starting ${autoStartBots.length} previously running bot(s): ${autoStartBots.join(', ')}`)
    const BATCH_SIZE = parseInt(process.env.AUTO_START_BATCH_SIZE || '3', 10) || 3
    const BATCH_DELAY_MS = parseInt(process.env.AUTO_START_BATCH_DELAY_MS || '2000', 10) || 2000
    for (let i = 0; i < autoStartBots.length; i += BATCH_SIZE) {
      const batch = autoStartBots.slice(i, i + BATCH_SIZE)
      if (i > 0) {
        logger.info('startup', `Waiting ${BATCH_DELAY_MS}ms before next batch...`)
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
      }
      logger.info('startup', `Starting batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(autoStartBots.length / BATCH_SIZE)}: ${batch.join(', ')}`)
      await Promise.all(
        batch.map(botId =>
          boundStartBotProcess(botId).catch(err => logger.error('startup', `Failed to auto-start ${botId}`, err instanceof Error ? err.message : String(err)))
        )
      )
    }
  }

  logger.info('startup', `Bot Runner Service started on port ${PORT} (bots dir: ${BOTS_DIR})`)
})

// ─── Graceful Shutdown ──────────────────────────────────────────────────

function gracefulShutdown(signal: string) {
  logger.info('shutdown', `Received ${signal}, shutting down gracefully...`)
  stopMonitoring()
  stopLogCleanup()
  clearAllRestartTimers()

  const runningBots: string[] = []
  for (const [id, bot] of botProcesses.entries()) {
    if (bot.status === 'running' || bot.status === 'starting') {
      boundStopBotProcess(id)
      runningBots.push(id)
    }
  }

  if (runningBots.length > 0) {
    logger.info('shutdown', `Stopping ${runningBots.length} bot process(es): ${runningBots.join(', ')}`)
  }

  const forceExitTimer = setTimeout(() => {
    logger.warn('shutdown', 'Forced exit after timeout')
    process.exit(1)
  }, 5000)
  forceExitTimer.unref()

  httpServer.close(() => {
    logger.info('shutdown', 'HTTP server closed')
    process.exit(0)
  })

  io.disconnectSockets(true)
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
