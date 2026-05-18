import { access, rm } from 'fs/promises'
import { join } from 'path'
import { Server } from 'socket.io'
import type { BotProcess, BotConfig, DeployStage } from './types'
import { getBotDir, loadBotConfigAsync, sanitizeBotId, CONFIG_DIR } from './utils'
import { MAX_LOG_LINES, LOGS_DIR } from './log-manager'
import { deployBot } from './deploy'
import { cancelRestartTimer, markIntentionalStop, clearIntentionalStop, intentionalStopSet, memoryKilledSet } from './process-manager'

// ─── Deploy Concurrency Control ──────────────────────────────────────────────
// BUG FIX: Use Map with abort flag instead of Set, so we can cancel in-progress
// deploys when the user clicks stop or requests a new deploy.
const activeDeploys = new Map<string, { aborted: boolean }>()

/** Cancel any active deploy for the given botId */
function cancelActiveDeploy(botId: string): void {
  const ctrl = activeDeploys.get(botId)
  if (ctrl) {
    ctrl.aborted = true
  }
}

// ─── P3-1 FIX: Extracted shared bot loading helper ─────────────────────────

const VALID_LANGS = ['javascript', 'typescript', 'python'] as const

/**
 * Load a bot's config from disk and create a BotProcess in memory.
 * Returns the bot if found/created, or undefined if no config exists.
 * Shared by bot:start, bot:restart, pm2:restart handlers.
 * P2-BR-10 FIX: Made async to use loadBotConfigAsync
 */
async function loadBotOrCreate(
  botId: string,
  botProcesses: Map<string, BotProcess>,
): Promise<BotProcess | undefined> {
  // Return existing if already in memory
  const existing = botProcesses.get(botId)
  if (existing) return existing

  // Try loading from disk
  const savedConfig = await loadBotConfigAsync(botId)
  if (!savedConfig) return undefined

  const lang = VALID_LANGS.includes(savedConfig.language as typeof VALID_LANGS[number])
    ? savedConfig.language
    : 'javascript'

  const bot: BotProcess = {
    id: botId,
    name: savedConfig.name,
    language: lang as 'javascript' | 'typescript' | 'python',
    status: 'stopped',
    envVars: savedConfig.envVars,
    logBuffer: [],
    maxLogLines: MAX_LOG_LINES,
    entryPoint: savedConfig.entryPoint,
    cpuUsage: 0,
    memoryUsage: 0,
    restartCount: 0,
    maxRestarts: 5,
    maxMemoryMb: 256,
  }
  botProcesses.set(botId, bot)
  console.log(`[Load] Loaded config from disk for ${botId}`)
  return bot
}

// ─── P1-4 FIX: Validate botId format ───────────────────────────────────────

function isValidBotId(botId: string): boolean {
  return typeof botId === 'string' && botId.length > 0 && botId.length <= 100
    && /^[a-zA-Z0-9._-]+$/.test(botId)
}

/**
 * FIX: Safe wrapper for sanitizeBotId that returns empty string on error
 * instead of throwing. Used in handlers where we want to silently ignore
 * invalid IDs rather than crash the handler.
 */
function safeSanitizeBotId(botId: string): string {
  try {
    return sanitizeBotId(botId)
  } catch {
    return ''
  }
}

// ─── Handler Registration ─────────────────────────────────────────────────

export function registerHandlers(
  io: Server,
  botProcesses: Map<string, BotProcess>,
  deployStatus: Map<string, { stage: DeployStage; progress: number; error?: string; logs: string[] }>,
  startBotProcess: (botId: string) => Promise<void>,
  stopBotProcess: (botId: string) => void,
): void {

  io.on('connection', (socket) => {
    console.log(`[Socket] 客户端连接: ${socket.id}`)

    // Send current state (filter out BOT_TOKEN from env var names)
const SENSITIVE_ENV_PATTERNS = ['BOT_TOKEN', 'SECRET', 'PASSWORD', 'AUTH', 'APIKEY', 'API_KEY', 'ACCESS_KEY', 'PRIVATE', 'CREDENTIAL', 'DATABASE_URL']

    socket.emit('init', {
      bots: Array.from(botProcesses.entries()).map(([id, bot]) => ({
        id: bot.id,
        name: bot.name,
        language: bot.language,
        status: bot.status,
        pid: bot.pid,
        startedAt: bot.startedAt,
        stoppedAt: bot.stoppedAt,
        exitCode: bot.exitCode,
        error: bot.error,
        envVars: Object.keys(bot.envVars).filter(k =>
          !SENSITIVE_ENV_PATTERNS.some(p => k.toUpperCase().includes(p))
        ),
      })),
    })

    // Deploy a bot
    socket.on('bot:deploy', async (data: { botId: string; config: BotConfig }) => {
      // P1-4 FIX: Validate botId
      if (!isValidBotId(data.botId)) {
        socket.emit('bot:status', { botId: data.botId, status: 'error', error: 'Invalid bot ID format' })
        return
      }
      const botId = safeSanitizeBotId(data.botId)
      if (!botId) {
        socket.emit('bot:status', { botId: data.botId, status: 'error', error: 'Invalid bot ID' })
        return
      }

      // BUG FIX: Cancel any existing deploy for this bot instead of rejecting.
      // Previously, a second deploy while one was in progress would show
      // "Deploy already in progress" error. Now we cancel the old deploy
      // and start a new one, making the UX much smoother.
      cancelActiveDeploy(botId)

      const abortCtrl = { aborted: false }
      activeDeploys.set(botId, abortCtrl)
      console.log(`[Deploy] ${data.config.name} (${botId})`)
      try {
        await deployBot(botId, data.config, botProcesses, deployStatus, startBotProcess, () => abortCtrl.aborted)
      } catch (err: unknown) {
        // BUG FIX: Catch deploy errors to prevent unhandled rejection.
        // Without this catch, Node.js 15+ would terminate the entire process,
        // killing ALL running bots. Common errors include:
        // - Compilation failures (TypeScript errors)
        // - Native module rebuild failures (better-sqlite3)
        // - Disk space exhaustion
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Deploy] ${data.config.name} (${botId}) failed:`, message)
        io.emit('bot:status', { botId, status: 'error', error: message })
        io.emit('deploy:progress', { botId, stage: 'error' as DeployStage, progress: 0, logs: [`❌ 部署失败: ${message}`] })
      } finally {
        // Only clean up if we're still the active deploy (not replaced by a newer one)
        if (activeDeploys.get(botId) === abortCtrl) {
          activeDeploys.delete(botId)
        }
      }
    })

    // Stop a bot
    socket.on('bot:stop', (data: { botId: string }) => {
      if (!isValidBotId(data.botId)) return
      const botId = safeSanitizeBotId(data.botId)
      if (!botId) return
      console.log(`[Stop] ${botId}`)

      // BUG FIX: Cancel any in-progress deploy for this bot.
      // Without this, stopping during a deploy doesn't prevent the deploy
      // from completing and starting the bot again.
      cancelActiveDeploy(botId)

      // BUG FIX: Cancel auto-restart timer and mark intentional stop on manual stop
      cancelRestartTimer(botId)
      stopBotProcess(botId)
    })

    // Start a bot (if already deployed)
    socket.on('bot:start', async (data: { botId: string }) => {
      if (!isValidBotId(data.botId)) {
        socket.emit('bot:status', { botId: data.botId, status: 'error', error: 'Invalid bot ID format' })
        return
      }
      const botId = safeSanitizeBotId(data.botId)
      if (!botId) {
        socket.emit('bot:status', { botId: data.botId, status: 'error', error: 'Invalid bot ID' })
        return
      }
      console.log(`[Start] ${botId}`)

      // BUG FIX: Cancel any pending auto-restart timer before manual start.
      // Without this, if the bot crashed and an auto-restart timer is pending,
      // both the manual start and the auto-restart could fire, causing a double-start.
      cancelRestartTimer(botId)
      clearIntentionalStop(botId)

      // P2-BR-10 FIX: loadBotOrCreate is now async
      const bot = await loadBotOrCreate(botId, botProcesses)
      if (bot && (bot.status === 'stopped' || bot.status === 'error')) {
        bot.logBuffer = []
        bot.restartCount = 0 // Reset restart count on manual start
        await startBotProcess(botId)
      } else if (!bot) {
        socket.emit('bot:status', { botId, status: 'error', error: 'Bot not found. Please deploy first.' })
      }
    })

    // Restart a bot
    socket.on('bot:restart', async (data: { botId: string }) => {
      if (!isValidBotId(data.botId)) {
        socket.emit('bot:status', { botId: data.botId, status: 'error', error: 'Invalid bot ID format' })
        return
      }
      const botId = safeSanitizeBotId(data.botId)
      if (!botId) {
        socket.emit('bot:status', { botId: data.botId, status: 'error', error: 'Invalid bot ID' })
        return
      }
      console.log(`[Restart] ${botId}`)

      // BUG FIX: Cancel any pending auto-restart timer to prevent double-start
      cancelRestartTimer(botId)

      // BUG FIX: Mark as intentional stop so handleBotExit won't auto-restart
      // even if the process exits with a non-SIGTERM signal
      markIntentionalStop(botId)

      // P2-BR-10 FIX: loadBotOrCreate is now async
      await loadBotOrCreate(botId, botProcesses)

      const bot = botProcesses.get(botId)
      const hadProcess = !!bot?.process

      stopBotProcess(botId)

      // BUG FIX: Use event-driven restart instead of fixed 3s timer.
      // The old approach had a race condition: if the process exited quickly
      // with a non-SIGTERM signal, handleBotExit's auto-restart could fire
      // before the 3s timer, causing a double-start. Now we listen for the
      // actual 'close' event on the child process.
      if (hadProcess && bot?.process) {
        const procRef = bot.process
        const restartTimeout = setTimeout(() => {
          // Fallback: if process hasn't exited after 5s, start anyway
          // (force-kill happens at 5s in stopBotProcess)
          const b = botProcesses.get(botId)
          if (b && b.status !== 'running') {
            b.restartCount = 0 // Reset restart count on manual restart
            b.logBuffer = []
            clearIntentionalStop(botId)
            startBotProcess(botId).catch(e => console.error('[Restart timeout] start failed:', e))
          }
        }, 6000)
        restartTimeout.unref()

        procRef.once('close', () => {
          clearTimeout(restartTimeout)
          const b = botProcesses.get(botId)
          if (b && b.status !== 'running') {
            b.restartCount = 0 // Reset restart count on manual restart
            b.logBuffer = []
            clearIntentionalStop(botId)
            startBotProcess(botId).catch(e => console.error('[Restart close] start failed:', e))
          }
        })
      } else {
        // No running process — start immediately
        const b = botProcesses.get(botId)
        if (b && b.status !== 'running') {
          b.restartCount = 0
          b.logBuffer = []
          clearIntentionalStop(botId)
          await startBotProcess(botId)
        }
      }
    })

    // Delete a bot
    socket.on('bot:delete', (data: { botId: string }) => {
      if (!isValidBotId(data.botId)) return
      const botId = safeSanitizeBotId(data.botId)
      if (!botId) return
      console.log(`[Delete] ${botId}`)
      // BUG FIX: Cancel auto-restart timer before stopping for delete
      cancelRestartTimer(botId)
      // Also cancel any in-progress deploy
      cancelActiveDeploy(botId)
      stopBotProcess(botId)

      // P2-BR-11 FIX: Wait for process to exit, then check it wasn't re-deployed before deleting files
      let deleteCalled = false
      const deleteFiles = async () => {
        if (deleteCalled) return // BUG FIX: Prevent double-emit of bot:deleted
        deleteCalled = true
        // Check if the bot was re-deployed while we were waiting
        if (botProcesses.has(botId) && botProcesses.get(botId)?.status === 'running') {
          console.log(`[Delete] Bot ${botId} was restarted, skipping file deletion`)
          return
        }
        const botDir = getBotDir(botId)
        try {
          await access(botDir).then(() => rm(botDir, { recursive: true, force: true })).catch(() => {})
        } catch { /* ignore */ }
        const configPath = join(CONFIG_DIR, `${botId}.json`)
        try {
          await access(configPath).then(() => rm(configPath, { force: true })).catch(() => {})
        } catch { /* ignore */ }
        const logPath = join(LOGS_DIR, `${botId}.log`)
        try {
          await access(logPath).then(() => rm(logPath, { force: true })).catch(() => {})
        } catch { /* ignore */ }
        botProcesses.delete(botId)
        deployStatus.delete(botId)
        // Clean up tracking sets to prevent memory leak and stale state
        intentionalStopSet.delete(botId)
        memoryKilledSet.delete(botId)
        io.emit('bot:deleted', { botId })
      }

      // Use event-driven approach: listen for process close event with timeout fallback
      const bot = botProcesses.get(botId)
      if (bot?.process) {
        const closeTimeout = setTimeout(deleteFiles, 5000)
        bot.process.once('close', () => {
          clearTimeout(closeTimeout)
          deleteFiles()
        })
      } else {
        deleteFiles()
      }
    })

    // Get bot logs
    socket.on('bot:logs', (data: { botId: string }) => {
      // BUG FIX: Validate botId like all other handlers
      if (!isValidBotId(data.botId)) return
      const botId = safeSanitizeBotId(data.botId)
      if (!botId) return
      const bot = botProcesses.get(botId)
      if (bot) {
        socket.emit('bot:logs', { botId, logs: bot.logBuffer.slice(-100) })
      }
    })

    // Get deploy status
    socket.on('deploy:status', (data: { botId: string }) => {
      if (!isValidBotId(data.botId)) return
      const botId = safeSanitizeBotId(data.botId)
      if (!botId) return
      const status = deployStatus.get(botId)
      socket.emit('deploy:progress', {
        botId,
        stage: status?.stage || 'idle',
        progress: status?.progress || 0,
        logs: status?.logs || [],
      })
    })

    // Recover a bot from saved config (re-deploy after restart)
    socket.on('bot:recover', async (data: { botId: string }) => {
      if (!isValidBotId(data.botId)) {
        socket.emit('bot:status', { botId: data.botId, status: 'error', error: 'Invalid bot ID format' })
        return
      }
      const botId = safeSanitizeBotId(data.botId)
      if (!botId) {
        socket.emit('bot:status', { botId: data.botId, status: 'error', error: 'Invalid bot ID' })
        return
      }

      // Cancel any existing deploy for this bot
      cancelActiveDeploy(botId)

      const abortCtrl = { aborted: false }
      activeDeploys.set(botId, abortCtrl)
      console.log(`[Recover] ${botId}`)
      try {
        const savedConfig = await loadBotConfigAsync(botId)
        if (!savedConfig) {
          socket.emit('bot:status', { botId, status: 'error', error: 'No saved config found for recovery' })
          return
        }
        const lang = VALID_LANGS.includes(savedConfig.language as typeof VALID_LANGS[number])
          ? savedConfig.language
          : 'javascript'
        await deployBot(botId, {
          name: savedConfig.name,
          botToken: savedConfig.envVars.BOT_TOKEN || '',
          language: lang as 'javascript' | 'typescript' | 'python',
          templateId: 'custom',
          envVars: savedConfig.envVars,
          projectFiles: savedConfig.projectFiles,
          customCode: savedConfig.customCode,
          dependencies: savedConfig.dependencies,
          entryPoint: savedConfig.entryPoint,
        }, botProcesses, deployStatus, startBotProcess, () => abortCtrl.aborted)
      } catch (err: unknown) {
        socket.emit('bot:status', { botId, status: 'error', error: err instanceof Error ? err.message : String(err) })
      } finally {
        if (activeDeploys.get(botId) === abortCtrl) {
          activeDeploys.delete(botId)
        }
      }
    })

    socket.on('disconnect', () => {
      console.log(`[Socket] 客户端断开: ${socket.id}`)
    })

    // ── PM2-style process management events ──────────────────────────────
    socket.on('pm2:list', (callback) => {
      const list = Array.from(botProcesses.entries()).map(([id, bot]) => ({
        id,
        name: bot.name,
        status: bot.status,
        pid: bot.pid,
        cpuUsage: bot.cpuUsage,
        memoryUsageMb: Math.round(bot.memoryUsage / 1024 / 1024 * 100) / 100,
        restartCount: bot.restartCount,
        startedAt: bot.startedAt,
        uptime: bot.startedAt ? Math.floor((Date.now() - new Date(bot.startedAt).getTime()) / 1000) : 0,
        port: bot.port,
      }))
      callback?.(list)
    })

    socket.on('pm2:restart', async (rawBotId: string, callback) => {
      try {
        if (!isValidBotId(rawBotId)) {
          callback?.({ success: false, error: 'Invalid bot ID format' })
          return
        }
        const botId = safeSanitizeBotId(rawBotId)
        if (!botId) {
          callback?.({ success: false, error: 'Invalid bot ID' })
          return
        }

        // BUG FIX: Cancel auto-restart timer and mark intentional stop
        cancelRestartTimer(botId)
        markIntentionalStop(botId)

        // P2-BR-10 FIX: loadBotOrCreate is now async
        await loadBotOrCreate(botId, botProcesses)

        const bot = botProcesses.get(botId)
        const hadProcess = !!bot?.process

        stopBotProcess(botId)

        // BUG FIX: Use event-driven restart (same as bot:restart)
        if (hadProcess && bot?.process) {
          const procRef = bot.process
          const restartTimeout = setTimeout(() => {
            const b = botProcesses.get(botId)
            if (b && b.status !== 'running') {
              b.restartCount = 0
              b.logBuffer = []
              clearIntentionalStop(botId)
              startBotProcess(botId).catch(e => console.error('[PM2 restart timeout] start failed:', e))
            }
          }, 6000)
          restartTimeout.unref()

          procRef.once('close', () => {
            clearTimeout(restartTimeout)
            const b = botProcesses.get(botId)
            if (b && b.status !== 'running') {
              b.restartCount = 0
              b.logBuffer = []
              clearIntentionalStop(botId)
              startBotProcess(botId).catch(e => console.error('[PM2 restart close] start failed:', e))
            }
          })
        } else {
          const b = botProcesses.get(botId)
          if (b && b.status !== 'running') {
            b.restartCount = 0
            b.logBuffer = []
            clearIntentionalStop(botId)
            await startBotProcess(botId)
          }
        }

        callback?.({ success: true })
      } catch (err: unknown) {
        callback?.({ success: false, error: err instanceof Error ? err.message : String(err) })
      }
    })

    socket.on('pm2:stop', (rawBotId: string, callback) => {
      try {
        if (!isValidBotId(rawBotId)) {
          callback?.({ success: false, error: 'Invalid bot ID format' })
          return
        }
        const botId = safeSanitizeBotId(rawBotId)
        if (!botId) {
          callback?.({ success: false, error: 'Invalid bot ID' })
          return
        }
        // Cancel any in-progress deploy and auto-restart timer
        cancelActiveDeploy(botId)
        cancelRestartTimer(botId)
        stopBotProcess(botId)
        callback?.({ success: true })
      } catch (err: unknown) {
        callback?.({ success: false, error: err instanceof Error ? err.message : String(err) })
      }
    })

    socket.on('pm2:delete', (rawBotId: string, callback) => {
      try {
        if (!isValidBotId(rawBotId)) {
          callback?.({ success: false, error: 'Invalid bot ID format' })
          return
        }
        const botId = safeSanitizeBotId(rawBotId)
        if (!botId) {
          callback?.({ success: false, error: 'Invalid bot ID' })
          return
        }
        console.log(`[PM2:Delete] ${botId}`)
        // BUG FIX: Cancel auto-restart timer and active deploy before stopping for delete
        cancelRestartTimer(botId)
        cancelActiveDeploy(botId)
        const bot = botProcesses.get(botId)
        stopBotProcess(botId)

        // P2-BR-13 FIX: Listen for process 'close' event with timeout fallback
        let deleteCalled = false
        const deleteFiles = async () => {
          if (deleteCalled) return // BUG FIX: Prevent double-emit/cleanup
          deleteCalled = true
          // Check if the bot was re-deployed while we were waiting
          if (botProcesses.has(botId) && botProcesses.get(botId)?.status === 'running') {
            console.log(`[PM2:Delete] Bot ${botId} was restarted, skipping file deletion`)
            callback?.({ success: false, error: 'Bot was restarted during deletion' })
            return
          }
          // Clean up all disk artifacts
          const botDir = getBotDir(botId)
          const configPath = join(CONFIG_DIR, `${botId}.json`)
          const logPath = join(LOGS_DIR, `${botId}.log`)

          try {
            await access(botDir).then(() => rm(botDir, { recursive: true, force: true })).catch(() => {})
            await access(configPath).then(() => rm(configPath, { force: true })).catch(() => {})
            await access(logPath).then(() => rm(logPath, { force: true })).catch(() => {})
          } catch { /* ignore cleanup errors */ }

          // Remove from memory
          botProcesses.delete(botId)
          deployStatus.delete(botId)
          // Clean up tracking sets to prevent memory leak and stale state
          intentionalStopSet.delete(botId)
          memoryKilledSet.delete(botId)

          console.log(`[PM2:Delete] ${botId} fully removed (memory + disk)`)
          callback?.({ success: true })
        }

        if (bot?.process) {
          // Wait for process to close, with a 5s timeout fallback
          const closeTimeout = setTimeout(() => {
            console.log(`[PM2:Delete] Timeout waiting for ${botId} to close, proceeding with deletion`)
            deleteFiles()
          }, 5000)
          bot.process.once('close', () => {
            clearTimeout(closeTimeout)
            deleteFiles()
          })
        } else {
          // No running process, delete immediately
          deleteFiles()
        }
      } catch (err: unknown) {
        console.error(`[PM2:Delete] Error deleting ${rawBotId}:`, err instanceof Error ? err.message : err)
        callback?.({ success: false, error: err instanceof Error ? err.message : String(err) })
      }
    })

    socket.on('pm2:resources', (rawBotId: string, callback) => {
      // BUG FIX: Validate botId like all other handlers
      if (!isValidBotId(rawBotId)) return callback?.(null)
      const botId = safeSanitizeBotId(rawBotId)
      if (!botId) return callback?.(null)
      const bot = botProcesses.get(botId)
      if (!bot) return callback?.(null)
      callback?.({
        cpuUsage: bot.cpuUsage,
        memoryUsage: bot.memoryUsage,
        memoryUsageMb: Math.round(bot.memoryUsage / 1024 / 1024 * 100) / 100,
        maxMemoryMb: bot.maxMemoryMb,
        restartCount: bot.restartCount,
        maxRestarts: bot.maxRestarts,
      })
    })
  })
}
