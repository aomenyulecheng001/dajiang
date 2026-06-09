import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import type { BotProcess } from './types'
import { getChildProcessMemory, intentionalStopSet, cancelRestartTimer, memoryKilledSet } from './process-manager'
import { appendLog } from './log-manager'
import { io } from './socket'

// ─── CPU Usage Tracking ─────────────────────────────────────────────────

interface CpuSnapshot {
  utime: number  // user time in milliseconds
  stime: number  // system time in milliseconds
  startTime: number  // process start time (clock ticks)
  totalCpuMs: number  // total CPU time when snapshot was taken
  wallTimeMs: number  // wall clock time when snapshot was taken
}

/**
 * Read CPU usage data for a process from /proc/{pid}/stat (Linux only).
 * P3-18/20 NOTE: This returns null on macOS/Windows. On those platforms,
 * cpuUsage will default to 0. Cross-platform CPU monitoring would require
 * the `systeminformation` npm package or `os.cpus()` based heuristics.
 *
 * CROSS-PLATFORM NOTE: On Windows/macOS, this returns null and cpuUsage
 * defaults to 0. For production monitoring on these platforms, consider
 * using the `systeminformation` npm package or `os.cpus()` based heuristics.
 * The readProcessCpuCrossPlatform wrapper provides the extension point
 * for adding platform-specific implementations.
 *
 * P2-3 FIX: Uses readFileSync instead of execSync to avoid blocking shell.
 * Direct file reads are significantly faster and avoid shell interpretation.
 *
 * /proc/{pid}/stat format (relevant fields):
 *   field 14: utime  - user-mode CPU ticks
 *   field 15: stime  - kernel-mode CPU ticks
 *   field 22: starttime - process start time (ticks since boot)
 */
async function readProcCpu(pid: number): Promise<CpuSnapshot | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf-8')
    // The comm field (field 2) may contain spaces and parentheses, so we split from the end
    const lastParen = stat.lastIndexOf(')')
    if (lastParen === -1) return null

    const fields = stat.substring(lastParen + 2).trim().split(/\s+/)
    // Fields after comm: 1-based index from after ')'
    // utime = index 13 (0-based), stime = index 14, starttime = index 21
    const utime = parseInt(fields[11])
    const stime = parseInt(fields[12])
    const startTime = parseInt(fields[19])

    if (isNaN(utime) || isNaN(stime) || isNaN(startTime)) return null

    // Get total CPU time from /proc/stat (sum of all CPU times across cores)
    let totalCpuTicks = 0
    try {
      const cpuStat = await readFile('/proc/stat', 'utf-8')
      const firstLine = cpuStat.split('\n')[0] // cpu line is always first
      const cpuParts = firstLine.split(/\s+/).slice(1).map(Number)
      totalCpuTicks = cpuParts.reduce((sum, v) => sum + (isNaN(v) ? 0 : v), 0)
    } catch {
      totalCpuTicks = 0
    }

    // Get clock tick rate (typically 100 Hz on Linux)
    const hertz = 100

    return {
      utime: utime / hertz * 1000,  // Convert ticks to ms
      stime: stime / hertz * 1000,
      startTime,
      totalCpuMs: totalCpuTicks / hertz * 1000,
      wallTimeMs: Date.now(),
    }
  } catch {
    return null
  }
}

async function readProcessCpuCrossPlatform(pid: number): Promise<CpuSnapshot | null> {
  if (process.platform === 'linux') {
    return readProcCpu(pid)
  }
  return null
}

// Store previous CPU snapshots per bot
const cpuSnapshots = new Map<string, CpuSnapshot>()

/**
 * Calculate CPU usage percentage for a bot process.
 * Uses delta between current and previous snapshot.
 * Returns 0 if no previous data or unable to read.
 */
async function calculateCpuUsage(botId: string, pid: number): Promise<number> {
  const current = await readProcessCpuCrossPlatform(pid)

  if (!current) return 0

  const prev = cpuSnapshots.get(botId)
  cpuSnapshots.set(botId, current)

  if (!prev) return 0  // Need at least 2 snapshots to calculate delta

  // Calculate deltas
  const processDeltaMs = (current.utime + current.stime) - (prev.utime + prev.stime)
  const wallDeltaMs = current.wallTimeMs - prev.wallTimeMs

  if (wallDeltaMs <= 0) return 0

  // CPU usage = (process CPU time delta / wall time delta) * 100
  // Clamp to 0-100% (per core)
  const usage = (processDeltaMs / wallDeltaMs) * 100
  return Math.max(0, Math.min(100, Math.round(usage * 100) / 100))
}

// ─── Port Detection ───────────────────────────────────────────────────────
// Detect which TCP ports a bot child process is listening on. This is useful
// for bots with embedded HTTP servers (webhook mode, admin panels, etc.).

/**
 * Parse /proc/{pid}/net/tcp to find listening ports (Linux only).
 * Returns an array of port numbers the process is listening on.
 */
async function getListeningPortsLinux(pid: number): Promise<number[]> {
  const ports: number[] = []
  try {
    const tcp = await readFile(`/proc/${pid}/net/tcp`, 'utf-8')
    const lines = tcp.split('\n').slice(1) // Skip header
    for (const line of lines) {
      if (!line.trim()) continue
      const parts = line.trim().split(/\s+/)
      if (parts.length < 4) continue
      const localAddr = parts[1] // Format: HEXIP:HEXPORT
      const state = parts[3]     // 0A = LISTEN
      if (state !== '0A') continue
      const colonIdx = localAddr.lastIndexOf(':')
      if (colonIdx === -1) continue
      const hexPort = localAddr.slice(colonIdx + 1)
      const port = parseInt(hexPort, 16)
      if (port > 0 && port < 65536 && !ports.includes(port)) {
        ports.push(port)
      }
    }
    // Also check tcp6
    try {
      const tcp6 = await readFile(`/proc/${pid}/net/tcp6`, 'utf-8')
      const lines6 = tcp6.split('\n').slice(1)
      for (const line of lines6) {
        if (!line.trim()) continue
        const parts = line.trim().split(/\s+/)
        if (parts.length < 4) continue
        const state = parts[3]
        if (state !== '0A') continue
        const localAddr = parts[1]
        const colonIdx = localAddr.lastIndexOf(':')
        if (colonIdx === -1) continue
        const hexPort = localAddr.slice(colonIdx + 1)
        const port = parseInt(hexPort, 16)
        if (port > 0 && port < 65536 && !ports.includes(port)) {
          ports.push(port)
        }
      }
    } catch { /* tcp6 may not exist */ }
  } catch { /* /proc not available or permission denied */ }
  return ports
}

/**
 * Fallback: use netstat/ss to find listening ports for a PID (cross-platform).
 */
async function getListeningPortsFallback(pid: number): Promise<number[]> {
  const ports: number[] = []
  // Try ss first (modern Linux), then netstat
  const commands = [
    { cmd: 'ss', args: ['-tlnp'] },
    { cmd: 'netstat', args: ['-tlnp'] },
  ]
  for (const { cmd, args } of commands) {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(cmd, args, { timeout: 3000 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout || '')
        )
      })
      const lines = stdout.split('\n')
      for (const line of lines) {
        if (!line.includes(String(pid))) continue
        // ss format: LISTEN 0 128 *:3000 ...
        // netstat format: tcp 0 0 0.0.0.0:3000 ... LISTEN 1234/program
        const portMatch = line.match(/:(\d{1,5})\s/)
        if (portMatch) {
          const port = parseInt(portMatch[1], 10)
          if (port > 0 && port < 65536 && !ports.includes(port)) {
            ports.push(port)
          }
        }
      }
      if (ports.length > 0) break // Got results, stop trying
    } catch { /* command not available */ }
  }
  return ports
}

/**
 * Get all listening TCP ports for a process. Linux-first with fallback.
 */
async function getListeningPorts(pid: number): Promise<number[]> {
  if (process.platform === 'linux') {
    const ports = await getListeningPortsLinux(pid)
    if (ports.length > 0) return ports
  }
  return getListeningPortsFallback(pid)
}

// ─── Monitoring ──────────────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null

export function startMonitoring(botProcesses: Map<string, BotProcess>): void {
  // Avoid duplicate timers
  if (monitorTimer) return

  monitorTimer = setInterval(async () => {
    for (const [botId, bot] of botProcesses.entries()) {
      if (bot.status !== 'running' || !bot.process || !bot.process.pid) continue

      try {
        bot.memoryUsage = await getChildProcessMemory(bot.process.pid)
      } catch {
        // Ignore monitoring errors
      }

      // P1-6 FIX: Calculate actual CPU usage
      try {
        bot.cpuUsage = await calculateCpuUsage(botId, bot.process.pid)
      } catch {
        // If CPU calculation fails, leave previous value
      }

      // Detect listening TCP ports (for bots with embedded HTTP servers)
      // Refresh on every monitoring cycle to catch port changes after restart
      try {
        const ports = await getListeningPorts(bot.process.pid)
        bot.port = ports.length > 0 ? ports[0] : undefined
      } catch {
        // Port detection failure is non-critical
      }

      // Fallback: if process detection failed, check bot's env vars for PORT
      // This covers bots where port detection can't work (permission issues, non-Linux)
      if (!bot.port) {
        const portKeys = ['PORT', 'HTTP_PORT', 'WEBHOOK_PORT', 'SERVER_PORT', 'LISTEN_PORT']
        for (const key of portKeys) {
          const val = bot.envVars?.[key]
          if (val) {
            const parsed = parseInt(val, 10)
            if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
              bot.port = parsed
              break
            }
          }
        }
      }

      // Memory watchdog — auto-restart if exceeding limit
      // Only act if not already in memoryKilledSet (prevent re-triggering every 3s)
      if (bot.memoryUsage > bot.maxMemoryMb * 1024 * 1024 && bot.memoryUsage > 0 && !memoryKilledSet.has(botId)) {
        const memMb = Math.round(bot.memoryUsage / 1024 / 1024)
        appendLog(botId, `内存超限: ${memMb}MB > ${bot.maxMemoryMb}MB，正在重启...`, 'warn')
        // Mark as memory-killed so handleBotExit knows this is NOT an intentional stop
        // even though we use SIGTERM to kill the process.
        // Also prevents the watchdog from re-triggering on the next monitoring cycle.
        memoryKilledSet.add(botId)
        intentionalStopSet.delete(botId)
        cancelRestartTimer(botId)
        // Don't reset restartCount — respect maxRestarts limit to prevent infinite restart loops
        // for bots with persistent memory leaks. The user must manually restart after maxRestarts.
        if (bot.process && bot.process.pid) {
          const procRef = bot.process
          try { procRef.kill('SIGTERM') } catch { /* ignore */ }
          // SIGKILL fallback — same pattern as stopBotProcess.
          // Prevents orphaned processes that ignore SIGTERM from holding resources.
          const forceKillTimer = setTimeout(() => {
            // BUG FIX: Use exitCode === null instead of !procRef.killed.
            // Node.js sets killed=true immediately after SIGTERM, not when
            // the process actually exits (same bug as in stopBotProcess).
            if (procRef.exitCode === null && bot.process === procRef) {
              appendLog(botId, '内存超限进程未响应 SIGTERM，强制终止...', 'warn')
              try { procRef.kill('SIGKILL') } catch { /* ignore */ }
            }
          }, 10000)
          forceKillTimer.unref() // BUG FIX: Don't let this timer prevent graceful shutdown
          // Clear force-kill timer if process exits naturally
          procRef.once('close', () => { clearTimeout(forceKillTimer) })
        }
      }
    }

    // P2-35 FIX: Only broadcast resource data for running bots to reduce unnecessary data
    const resourceData: Record<string, { cpuUsage: number; memoryUsage: number; memoryUsageMb: number; status: string; pid?: number; restartCount: number; uptime?: number; port?: number }> = {}
    for (const [botId, bot] of botProcesses.entries()) {
      if (bot.status !== 'running') continue // Skip non-running bots
      resourceData[botId] = {
        cpuUsage: bot.cpuUsage,
        memoryUsage: bot.memoryUsage,
        memoryUsageMb: Math.round(bot.memoryUsage / 1024 / 1024 * 100) / 100,
        status: bot.status,
        pid: bot.pid,
        restartCount: bot.restartCount,
        uptime: bot.startedAt ? Math.floor((Date.now() - new Date(bot.startedAt).getTime()) / 1000) : undefined,
        port: bot.port,
      }
    }

    // P2-BR-6 FIX: Clean up cpuSnapshots entries for bots no longer in botProcesses.
    // Collect stale IDs first to avoid modifying the Map during iteration, which
    // is undefined behavior on some JS engines and can skip entries.
    const staleIds: string[] = []
    for (const botId of cpuSnapshots.keys()) {
      if (!botProcesses.has(botId)) {
        staleIds.push(botId)
      }
    }
    for (const botId of staleIds) {
      cpuSnapshots.delete(botId)
    }

    io.emit('resources:update', resourceData)
  }, 3000)
  monitorTimer.unref()
}

export function stopMonitoring(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
  cpuSnapshots.clear()
}
