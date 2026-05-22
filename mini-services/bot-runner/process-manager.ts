import { readdirSync, writeFileSync, unlinkSync } from 'fs'
import { readFile } from 'fs/promises'
import { spawn, execFile } from 'child_process'
import type { BotProcess } from './types'
// ─── Node.js Path for Bot Processes ────────────────────────────────────────
// When bot-runner runs under Node.js (via PM2 --interpreter tsx), there's no
// spawn interception. But we still want to find the best Node.js binary
// (newest version ≥ 16) for spawning bot child processes.
let _nodePath: string | null = null
async function getNodePath(): Promise<string> {
  if (_nodePath) return _nodePath
  try {
    const candidates: string[] = []
    // 1. BaoTa panel Node.js
    try {
      const btNodeBase = '/www/server/nodejs'
      const versions = readdirSync(btNodeBase).sort().reverse()
      for (const v of versions) {
        candidates.push(`${btNodeBase}/${v}/bin/node`)
      }
    } catch { /* no BT node */ }
    // 2. nodesource install (typically v18+)
    candidates.push('/usr/local/bin/node')
    // 3. System node (may be old)
    candidates.push('/usr/bin/node')

    // Find the NEWEST Node.js ≥ 16 (supports optional chaining, nullish coalescing)
    let bestPath: string | null = null
    let bestMajor = 0
    for (const candidate of candidates) {
      try {
        const ver = await new Promise<string>((resolve, reject) => {
          execFile(candidate, ['--version'], { timeout: 2000 }, (err, stdout) =>
            err ? reject(err) : resolve((stdout || '').trim())
          )
        })
        if (ver.startsWith('v')) {
          const major = parseInt(ver.slice(1).split('.')[0], 10)
          if (major >= 16 && major > bestMajor) {
            bestMajor = major
            bestPath = candidate
          }
        }
      } catch { /* not a valid node */ }
    }
    if (bestPath) {
      _nodePath = bestPath
      return bestPath
    }
  } catch { /* fallback */ }
  _nodePath = 'node'
  return 'node'
}

import { getBotDir, loadBotConfigAsync, CONFIG_DIR } from './utils'
import { appendLog } from './log-manager'
import { io } from './socket'

// ─── Safe Environment Whitelist ───────────────────────────────────────────

/** Environment variables explicitly passed to bot child processes.
 *  Host env vars are NEVER automatically forwarded — only explicitly listed keys
 *  from process.env are injected (PATH, HOME, LANG, LC_ALL). */
const SAFE_ENV_KEYS = new Set(['BOT_TOKEN', 'BOT_NAME', 'NODE_ENV', 'PATH', 'HOME', 'LANG', 'LC_ALL'])

const DANGEROUS_ENV_KEYS = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD',
  'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'PYTHONPATH', 'PYTHONHOME', 'CLASSPATH', 'SHLVL', 'BASH_FUNC_*',
])

// ─── Process Memory ───────────────────────────────────────────────────────

/**
 * P3-18/20 FIX: Get child process memory with cross-platform fallbacks.
 * P2-3 FIX: Uses readFile instead of execSync to avoid blocking shell.
 * P1 FIX: Changed from readFileSync to async readFile to avoid blocking the event loop.
 * Primary: /proc/{pid}/status VmRSS (Linux)
 * Fallback: `ps -o rss= -p {pid}` (macOS/Linux)
 * Fallback: `tasklist /FI "PID eq {pid}"` (Windows)
 * Returns 0 if all methods fail.
 */
export async function getChildProcessMemory(pid: number): Promise<number> {
  // Try /proc first (Linux — most accurate)
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf-8')
    const match = status.match(/VmRSS:\s*(\d+)\s*kB/)
    if (match) return parseInt(match[1]) * 1024 // Convert KB to bytes
  } catch {
    // Not Linux or process gone
  }

  // Try ps (macOS/Linux)
  try {
    const ps = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout || '')
      )
    })
    const rss = parseInt(ps.trim())
    if (!isNaN(rss)) return rss * 1024
  } catch {
    // ps not available
  }

  // Try tasklist (Windows)
  if (process.platform === 'win32') {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
          timeout: 2000,
          windowsHide: true,
        }, (err, stdout) =>
          err ? reject(err) : resolve((stdout || '').replace(/\0/g, ''))
        )
      })
      // Output format: "image name","PID","session name","session #","mem usage"
      const match = output.match(/"(\d+)"/)
      if (match) {
        const memMatch = output.match(/"([\d,]+) K"/)
        if (memMatch) {
          const memKB = parseInt(memMatch[1].replace(/,/g, ''))
          if (!isNaN(memKB)) return memKB * 1024
        }
      }
    } catch {
      // tasklist not available or process not found
    }
  }

  return 0
}

// ─── P2-BR-4 FIX: Track auto-restart timers for cleanup on shutdown ──────
const restartTimers = new Map<string, NodeJS.Timeout>()

export function clearAllRestartTimers(): void {
  for (const [botId, timer] of restartTimers.entries()) {
    clearTimeout(timer)
    restartTimers.delete(botId)
  }
}

/**
 * BUG FIX: Cancel a pending auto-restart timer for a specific bot.
 * This is essential when a manual restart/stop is initiated — without this,
 * the auto-restart timer from handleBotExit can fire and cause a double-start.
 */
export function cancelRestartTimer(botId: string): void {
  const timer = restartTimers.get(botId)
  if (timer) {
    clearTimeout(timer)
    restartTimers.delete(botId)
    appendLog(botId, '已取消自动重启定时器', 'info')
  }
}

// ─── Bot Exit Handler ─────────────────────────────────────────────────────

// ─── Intentional-stop tracking ─────────────────────────────────────────────
// When a manual stop/restart is initiated, we set this flag so that
// handleBotExit knows NOT to auto-restart, regardless of exit signal.
// Exported for use by the memory watchdog in monitor.ts.
export const intentionalStopSet = new Set<string>()

// ─── Memory-kill tracking ────────────────────────────────────────────────
// When the memory watchdog kills a process, we mark it here so handleBotExit
// knows the SIGTERM was NOT an intentional user stop, and allows auto-restart.
export const memoryKilledSet = new Set<string>()

/**
 * Mark a bot as intentionally stopping. This prevents auto-restart in handleBotExit
 * even if the process exits without a SIGTERM/SIGINT signal.
 * Call this before stopBotProcess() when doing a manual stop or restart.
 */
export function markIntentionalStop(botId: string): void {
  intentionalStopSet.add(botId)
}

/**
 * Clear the intentional-stop flag. Called after the process has exited
 * and the stop/restart sequence is complete.
 */
export function clearIntentionalStop(botId: string): void {
  intentionalStopSet.delete(botId)
}

// ─── Fast-Fail Detection ──────────────────────────────────────────────────
// If a bot exits very quickly after starting (within FAST_FAIL_THRESHOLD_MS),
// it's likely a permanent error (invalid token, bad config, missing dependency)
// rather than a transient issue. Auto-restarting in this case is useless and
// creates an annoying restart loop. We limit fast-fail restarts to FAST_FAIL_MAX_RESTARTS.
const FAST_FAIL_THRESHOLD_MS = 10_000 // 10 seconds — if bot exits within this time, it's a fast-fail
const FAST_FAIL_MAX_RESTARTS = 1        // Only try 1 restart for fast-fail (instead of 5)

// ─── Stop Timeout Tracking ──────────────────────────────────────────────────
// Track the maximum stop timeout from stopBotProcess so handleBotExit can clear it.
// Without this, the stop timeout could fire AFTER handleBotExit already processed
// the exit, emitting a duplicate and stale 'stopped' event.
const stopTimeouts = new Map<string, NodeJS.Timeout>()

/**
 * Register a stop timeout that should be cleared when the process exits normally.
 */
export function registerStopTimeout(botId: string, timer: NodeJS.Timeout): void {
  // Clear any existing timeout first
  const existing = stopTimeouts.get(botId)
  if (existing) clearTimeout(existing)
  stopTimeouts.set(botId, timer)
}

/**
 * Clear the stop timeout for a bot (called from handleBotExit when process exits normally).
 */
function clearStopTimeout(botId: string): void {
  const timer = stopTimeouts.get(botId)
  if (timer) {
    clearTimeout(timer)
    stopTimeouts.delete(botId)
  }
}

export async function handleBotExit(
  botId: string,
  code: number | null,
  signal: string | null,
  botProcesses: Map<string, BotProcess>,
  startBotProcess: (botId: string) => Promise<void>,
  exitedProcess?: ChildProcess,
): Promise<void> {
  const bot = botProcesses.get(botId)
  if (!bot) return

  // BUG FIX: Clear the stop timeout since the process exited on its own.
  // This prevents the timeout from firing after handleBotExit has already
  // processed the exit, which would emit a duplicate 'stopped' event.
  clearStopTimeout(botId)

  // BUG FIX: If a new process was started (e.g., re-deploy), ignore the exit
  // of the old process — it's stale and would corrupt the new process record.
  if (exitedProcess && bot.process && bot.process !== exitedProcess) {
    console.log(`[Exit] Ignoring stale process exit for ${botId} — a new process is already running`)
    return
  }
  // BUG FIX: Also ignore if the BotProcess record was replaced (e.g., deploy timeout
  // created a new record before old process exited). Without this, handleBotExit would
  // corrupt the new record by setting status='stopped' and stale exitCode.
  if (exitedProcess && !bot.process) {
    console.log(`[Exit] Ignoring stale process exit for ${botId} — process record was replaced`)
    return
  }

  const now = new Date()
  const uptime = bot.startedAt ? now.getTime() - new Date(bot.startedAt).getTime() : 0
  const isFastFail = uptime > 0 && uptime < FAST_FAIL_THRESHOLD_MS

  if (bot.status !== 'error') {
    bot.status = 'stopped'
  }
  bot.stoppedAt = now.toISOString()
  bot.exitCode = code
  bot.process = undefined
  bot.pid = undefined

  // P1-19 FIX: Remove running marker when bot exits (won't auto-restart unless handleBotExit restarts it)
  try { unlinkSync(`${CONFIG_DIR}/${botId}.running`) } catch { /* ignore */ }

  appendLog(botId, `进程已退出 (code: ${code}, signal: ${signal})`, code === 0 ? 'info' : 'error')
  io.emit('bot:status', { botId, status: bot.status, exitCode: code })

  // BUG FIX: Check intentional-stop flag in addition to SIGTERM/SIGINT.
  // When a manual stop/restart is initiated, the process may exit with
  // a non-SIGTERM signal (e.g., exit code 1 after receiving SIGTERM but
  // handling it as a graceful shutdown). We must NOT auto-restart in that case.
  // A memory-killed process receives SIGTERM, but it should NOT be treated as intentional
  const isMemoryKill = memoryKilledSet.has(botId)
  memoryKilledSet.delete(botId) // Always clean up
  const isIntentional = !isMemoryKill && (signal === 'SIGTERM' || signal === 'SIGINT' || intentionalStopSet.has(botId))

  // Always clear the intentional-stop flag after the process has exited
  intentionalStopSet.delete(botId)

  // BUG FIX: Also cancel any pending auto-restart timer from a previous crash.
  // Without this, a prior auto-restart timer could fire during/after a manual restart,
  // causing a double-start.
  cancelRestartTimer(botId)

  // Determine the effective max restarts based on fast-fail detection
  const effectiveMaxRestarts = isFastFail ? FAST_FAIL_MAX_RESTARTS : bot.maxRestarts

  if (!isIntentional && bot.restartCount < effectiveMaxRestarts) {
    bot.restartCount++
    bot.lastRestartAt = now.toISOString()

    if (isFastFail) {
      appendLog(botId, `进程快速退出 (运行 ${Math.round(uptime / 1000)}秒)，可能是配置错误 (如无效的 Bot Token)`, 'warn')
      appendLog(botId, `自动重启中... (第 ${bot.restartCount}/${effectiveMaxRestarts} 次，快速失败模式)`, 'warn')
    } else {
      appendLog(botId, `自动重启中... (第 ${bot.restartCount}/${bot.maxRestarts} 次)`, 'warn')
    }

    const delay = Math.min(1000 * Math.pow(2, bot.restartCount - 1), 10000) // exponential backoff, max 10s

    // P2-BR-4 FIX: Track the restart timer so it can be cancelled during shutdown
    const restartTimer = setTimeout(async () => {
      restartTimers.delete(botId) // Clean up tracking
      try {
        const config = await loadBotConfigAsync(botId)
        if (config) {
          appendLog(botId, '正在重启进程...', 'info')
          const bp = botProcesses.get(botId)
          if (bp) {
            bp.logBuffer = []
            await startBotProcess(botId)
          }
        } else {
          appendLog(botId, '无法自动重启: 未找到保存的配置', 'error')
        }
      } catch (e) {
        appendLog(botId, `自动重启失败: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
      }
    }, delay)
    restartTimers.set(botId, restartTimer)
  } else if (isIntentional) {
    bot.restartCount = 0 // Reset counter on intentional stop
  } else if (isFastFail) {
    // Fast-fail: set error status with helpful message
    bot.status = 'error'
    bot.error = '进程快速退出，可能是配置错误（如无效的 Bot Token、缺少依赖等）。请检查配置后重新部署。'
    appendLog(botId, `快速失败: 进程运行不足 ${FAST_FAIL_THRESHOLD_MS / 1000} 秒即退出，已停止自动重启。请检查 Bot Token 和配置是否正确。`, 'error')
    io.emit('bot:status', { botId, status: 'error', error: bot.error })
  } else {
    bot.status = 'error'
    bot.error = `已达最大重启次数 (${bot.maxRestarts})，机器人已停止`
    appendLog(botId, bot.error, 'error')
    io.emit('bot:status', { botId, status: 'error', error: bot.error })
  }
}

// ─── Message Detection ──────────────────────────────────────────────────────

/**
 * Detect Telegram message/update patterns from bot stdout and emit `bot:message`
 * events via Socket.IO so the frontend can record them in the BotMessage table.
 *
 * Common patterns from telegraf/grammY bots:
 *   - "Message from <name>: <text>"
 *   - "/command" invocations
 *   - "Update <id>" processing logs
 *   - Callback query patterns
 *
 * This is a best-effort heuristic — it won't catch 100% of messages,
 * but it provides meaningful stats data without requiring template changes.
 */
function detectAndEmitMessage(botId: string, line: string, botName: string): void {
  try {
    // Pattern 1: "Message from <name>: <text>" or "Message from <name> (<id>): <text>"
    const msgFromMatch = line.match(/Message\s+from\s+(.+?)(?:\s*\((\d+)\))?:\s*(.+)/i)
    if (msgFromMatch) {
      const userName = msgFromMatch[1]?.trim() || 'Unknown'
      const userId = msgFromMatch[2] || `user_${Date.now()}`
      const text = msgFromMatch[3]?.trim() || ''
      const command = text.startsWith('/') ? text.split(/\s/)[0] : undefined
      io.emit('bot:message', { botId, userId: String(userId), userName, text, command })
      return
    }

    // Pattern 2: Command invocation like "/start", "/help" etc. in log output
    const cmdMatch = line.match(/(?:command|cmd)\s*[:=]\s*(\/\w+)/i)
    if (cmdMatch) {
      const command = cmdMatch[1]
      io.emit('bot:message', { botId, userId: `cmd_user_${Date.now()}`, userName: '', text: command, command })
      return
    }

    // Pattern 3: Telegraf/grammY update processing like "Update #12345 received"
    const updateMatch = line.match(/Update\s+#?(\d+)/i)
    if (updateMatch && !line.includes('npm') && !line.includes('install')) {
      // Just count it as a generic message
      io.emit('bot:message', { botId, userId: `update_user`, userName: '', text: '', command: undefined })
      return
    }

    // Pattern 4: Generic "received message" or "new message" patterns
    const receivedMatch = line.match(/(?:received|got|new)\s+(?:a\s+)?message/i)
    if (receivedMatch) {
      io.emit('bot:message', { botId, userId: `msg_user_${Date.now()}`, userName: '', text: '', command: undefined })
      return
    }
  } catch {
    // Ignore detection errors — this is best-effort
  }
}

// ─── Start Bot Process ────────────────────────────────────────────────────

/**
 * Start a bot process. Uses module-level botProcesses Map and handleBotExitFn
 * (captured via closure in the caller scope). This design allows the function
 * to be called from event handlers without passing dependencies each time.
 *
 * @param botId - The bot identifier to start
 */
export async function startBotProcess(
  botId: string,
  _botProcesses?: Map<string, BotProcess>,
  _handleBotExitFn?: (botId: string, code: number | null, signal: string | null, exitedProcess?: ChildProcess) => Promise<void>,
): Promise<void> {
  const processes = _botProcesses ?? (globalThis as unknown as { __botProcesses?: Map<string, BotProcess> }).__botProcesses
  const handleExit = _handleBotExitFn ?? (globalThis as unknown as { __handleBotExitFn?: typeof _handleBotExitFn }).__handleBotExitFn

  if (!processes || !handleExit) return
  const bot = processes.get(botId)
  if (!bot) return

  // P1-FIX: Guard against double-start — prevent orphaned processes
  if (bot.status === 'running' || bot.status === 'stopping' || bot.status === 'starting') {
    console.warn(`[Start] Bot ${botId} is ${bot.status}, skipping start`)
    return
  }

  let botDir: string
  try {
    botDir = getBotDir(botId)
  } catch (e) {
    bot.status = 'error'
    bot.error = e instanceof Error ? e.message : 'Invalid bot directory path'
    appendLog(botId, `Error: ${bot.error}`, 'error')
    io.emit('bot:status', { botId, status: 'error', error: bot.error })
    return
  }

  // Build environment variables — SANDBOX ISOLATION: only pass whitelisted env vars
  const botToken = bot.envVars.BOT_TOKEN || ''
  if (!botToken || botToken === 'your-token-here') {
    bot.status = 'error'
    bot.error = 'BOT_TOKEN is missing or invalid. Please provide a valid Telegram bot token and deploy again.'
    appendLog(botId, `Error: ${bot.error}`, 'error')
    io.emit('bot:status', { botId, status: 'error', error: bot.error })
    return
  }

  // Only pass safe environment variables (no host secrets like ENCRYPTION_KEY)
  const safeEnv: Record<string, string> = {
    BOT_TOKEN: botToken,
    BOT_NAME: bot.name,
    NODE_ENV: 'production',
  }
  // Only pass PATH and HOME from host if they exist (needed for child process
  // to find executables like node/python). These are safe to expose.
  if (process.env.PATH) safeEnv.PATH = process.env.PATH
  if (process.env.HOME) safeEnv.HOME = process.env.HOME
  if (process.env.LANG) safeEnv.LANG = process.env.LANG
  if (process.env.LC_ALL) safeEnv.LC_ALL = process.env.LC_ALL

  // P0-5 FIX: Block dangerous env var keys that could break process isolation
  // DANGEROUS_ENV_KEYS is defined at module scope (after SAFE_ENV_KEYS).

  // Also inject the bot's own env vars from config (user-provided)
  for (const [k, v] of Object.entries(bot.envVars)) {
    if (SAFE_ENV_KEYS.has(k)) continue // Already set above (from host env)
    // BUG FIX: Use prefix check for BASH_FUNC_* since Set.has() doesn't support globs
    if (DANGEROUS_ENV_KEYS.has(k) || k.startsWith('BASH_FUNC_')) {
      console.warn(`[Security] Blocked dangerous env var: ${k}`)
      continue
    }
    safeEnv[k] = v
  }

  let command: string
  let args: string[] = []

  // Use entryPoint if available, otherwise fall back to default file names
  const ep = bot.entryPoint
  // P2-21 FIX: Validate entry point doesn't contain path traversal or flag injection
  const safeEp = (ep && !ep.includes('..') && !ep.startsWith('-') && !ep.startsWith('/') && !(process.platform === 'win32' && /^[a-zA-Z]:/.test(ep)))
    ? ep
    : undefined

  if (bot.language === 'python') {
    // FIX: Windows uses 'python' not 'python3'
    command = process.platform === 'win32' ? 'python' : 'python3'
    args = [safeEp && safeEp.endsWith('.py') ? safeEp : 'bot.py']
  } else if (bot.language === 'typescript') {
    // TypeScript: use tsx (Node.js TypeScript runner)
    // FIX: Windows may need .cmd extension for spawn
    command = process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    const scriptFile = safeEp && safeEp.endsWith('.ts') ? safeEp : 'index.ts'
    args = [scriptFile]
  } else {
    // JavaScript: use Node.js directly. No Bun spawn interception since
    // bot-runner runs under Node.js (via PM2 --interpreter tsx).
    const nodePath = await getNodePath()
    const scriptFile = safeEp && safeEp.endsWith('.js') ? safeEp : 'index.js'
    command = nodePath
    args = ['--max-old-space-size=256', scriptFile]
  }

  appendLog(botId, `启动进程: ${command} ${args.join(' ')}`, 'info')

  const child = spawn(command, args, {
    cwd: botDir,
    env: safeEnv as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  })

  bot.process = child
  bot.pid = child.pid
  bot.status = 'running'
  bot.startedAt = new Date().toISOString()
  bot.error = undefined // P1-FIX: Clear previous error when successfully starting
  bot.exitCode = undefined // Clear stale exit code from previous run
  bot.stoppedAt = undefined // Clear stale stoppedAt from previous run
  bot._stdinErrorHandler = false // Reset for new process — new stdin needs new error handler

  // P1-19 FIX: Create running marker for auto-restart after shutdown
  try { writeFileSync(`${CONFIG_DIR}/${botId}.running`, new Date().toISOString()) } catch { /* ignore */ }

  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n')
    lines.forEach(line => {
      if (line.trim()) {
        appendLog(botId, line.trim(), 'info')
        // Detect Telegram message/update patterns and emit bot:message event
        // so the frontend can record them in BotMessage table for stats.
        detectAndEmitMessage(botId, line.trim(), bot.name)
      }
    })
  })

  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n')
    lines.forEach(line => {
      if (line.trim()) {
        appendLog(botId, line.trim(), 'error')
      }
    })
  })

  child.on('error', (err) => {
    bot.status = 'error'
    bot.error = err.message
    appendLog(botId, `进程错误: ${err.message}`, 'error')
    io.emit('bot:status', { botId, status: 'error', error: err.message })
  })

  child.on('close', (code, signal) => {
    handleExit(botId, code, signal, child).catch(e => console.error(`[Process] handleExit error for ${botId}:`, e))
  })

  io.emit('bot:status', { botId, status: 'running', pid: child.pid })
}

// ─── Stop Bot Process ─────────────────────────────────────────────────────

export function stopBotProcess(botId: string, botProcesses: Map<string, BotProcess>): void {
  const bot = botProcesses.get(botId)

  // BUG FIX: Handle the case where the bot has no process reference.
  // This can happen when:
  //   1. The process crashed but handleBotExit hasn't fired yet
  //   2. The bot status is inconsistent (status says running but no process)
  //   3. The process was already killed externally
  // Previously, this silently returned without any feedback to the frontend,
  // causing the "stopping" spinner to spin forever.
  if (!bot?.process) {
    if (bot) {
      // Process reference is gone but bot record exists — force-set to stopped.
      // This ensures the frontend receives the status change and stops spinning.
      if (bot.status === 'running' || bot.status === 'stopping') {
        appendLog(botId, '进程引用已丢失，强制设为已停止', 'warn')
        bot.status = 'stopped'
        bot.process = undefined
        bot.pid = undefined
        bot.stoppedAt = new Date().toISOString()
        clearIntentionalStop(botId)
        try { unlinkSync(`${CONFIG_DIR}/${botId}.running`) } catch { /* ignore */ }
        io.emit('bot:status', { botId, status: 'stopped', exitCode: null })
      }
    }
    return
  }

  // BUG FIX: Mark as intentional stop so handleBotExit won't auto-restart.
  // This is critical for the restart flow where stopBotProcess is called
  // before a manual startBotProcess.
  markIntentionalStop(botId)

  // P1-19 FIX: Remove running marker so bot won't auto-start after shutdown
  try { unlinkSync(`${CONFIG_DIR}/${botId}.running`) } catch { /* ignore */ }

  // BUG FIX: Cancel any pending auto-restart timer from a previous crash.
  cancelRestartTimer(botId)

  bot.status = 'stopping'
  appendLog(botId, '正在停止进程...', 'warn')

  // CRITICAL FIX: Emit the 'stopping' status to the frontend so the UI
  // can show the correct state. Without this, the frontend never receives
  // a 'stopping' event — it stays as 'running' in botStatuses Map,
  // causing effectiveLocalPending to never clear, and the spinner spins forever.
  io.emit('bot:status', { botId, status: 'stopping' })

  // Store timer ref so we can clear it when process exits naturally
  // P2-BR-5 FIX: Capture process reference at timer creation time
  const procRef = bot.process

  // BUG FIX: Add a maximum timeout for the entire stop sequence.
  // If the process hasn't fully exited within 10 seconds (including after
  // SIGKILL), force-set the status to 'stopped' and notify the frontend.
  // This prevents the frontend from spinning forever if:
  //   - The process becomes a zombie
  //   - The 'close' event never fires (OS-level issues)
  //   - The process was killed but the event loop is blocked
  //   - Socket.IO disconnects before the 'stopped' event can be sent
  const stopTimeout = setTimeout(() => {
    stopTimeouts.delete(botId) // Clean up self
    const b = botProcesses.get(botId)
    if (b && (b.status === 'stopping' || b.status === 'running')) {
      appendLog(botId, '停止超时，强制设为已停止', 'warn')
      b.status = 'stopped'
      b.process = undefined
      b.pid = undefined
      b.stoppedAt = new Date().toISOString()
      clearIntentionalStop(botId)
      io.emit('bot:status', { botId, status: 'stopped', exitCode: null })
    }
  }, 10000)
  // Register the timeout so handleBotExit can clear it when the process exits normally
  registerStopTimeout(botId, stopTimeout)

  const forceKillTimer = setTimeout(() => {
    // BUG FIX: Only SIGKILL if the process hasn't been replaced by a new one
    // and is still running (exitCode === null means process hasn't exited yet).
    // Previously used !procRef.killed which is WRONG — Node.js sets killed=true
    // immediately after kill('SIGTERM'), so SIGKILL was NEVER actually sent.
    if (procRef && procRef.exitCode === null && bot.process === procRef) {
      appendLog(botId, '进程未响应 SIGTERM，强制终止...', 'warn')
      try { procRef.kill('SIGKILL') } catch { /* ignore */ }
    }
  }, 5000)

  // Clear force-kill timer and stop timeout if process exits before timeout
  if (procRef) {
    const onClose = () => {
      clearTimeout(forceKillTimer)
      // stopTimeout is cleaned up via registerStopTimeout/handleBotExit path
      // but also clear it here as a safety net for the case where
      // handleBotExit is not called (shouldn't happen, but defensive)
      const st = stopTimeouts.get(botId)
      if (st) { clearTimeout(st); stopTimeouts.delete(botId) }
    }
    procRef.once('close', onClose)
  }

  try {
    // Send SIGTERM first
    procRef.kill('SIGTERM')
  } catch (err: unknown) {
    clearTimeout(forceKillTimer)
    clearTimeout(stopTimeout)
    appendLog(botId, `停止进程失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
    bot.status = 'stopped'
    bot.process = undefined
    bot.pid = undefined
    bot.stoppedAt = new Date().toISOString()
    clearIntentionalStop(botId)
    io.emit('bot:status', { botId, status: 'stopped', exitCode: null })
  }
}
