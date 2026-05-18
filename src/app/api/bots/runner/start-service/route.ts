import { spawn } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { NextResponse } from 'next/server'
import path from 'path'
import { resolveFromProjectRoot } from '@/lib/project-root'
import { validateSessionAsync } from '@/lib/session'
import { BOT_RUNNER_URL } from '@/lib/bot-runner-url'

// Track running service process
let serviceProcess: ReturnType<typeof spawn> | null = null

function isServiceRunning(): boolean {
  if (!serviceProcess) return false
  try {
    // Check if the process is still alive
    return !!(serviceProcess.pid && serviceProcess.kill(0))
  } catch {
    serviceProcess = null
    return false
  }
}

/**
 * P3-18/20 FIX: Kill any process listening on the given port.
 * Uses `lsof` on macOS/Linux, `fuser` on Linux as fallback,
 * or `netstat` as a last resort. All use pure spawn (no shell injection).
 */
function killExistingOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const proc = spawn('netstat', ['-ano', '-p', 'TCP'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.on('close', () => {
        const lines = stdout.split('\n')
        const portStr = `:${port}`
        for (const line of lines) {
          if (line.includes(portStr) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/)
            const pid = parseInt(parts[parts.length - 1], 10)
            if (!isNaN(pid) && pid > 0) {
              try {
                spawn('taskkill', ['/F', '/PID', String(pid)], { timeout: 5000 })
                resolve(true)
                return
              } catch { /* ignore */ }
            }
          }
        }
        resolve(false)
      })
      proc.on('error', () => resolve(false))
    } else {
      const commands: { cmd: string; args: string[] }[] = [
        { cmd: 'lsof', args: ['-ti', `:${port}`] },
        { cmd: 'fuser', args: [`${port}/tcp`, '-k'] },
      ]

      let tried = 0
      function tryNext(): void {
        if (tried >= commands.length) {
          resolve(false)
          return
        }
        const { cmd, args } = commands[tried]
        tried++
        const proc = spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        })

        let stdout = ''
        proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
        proc.stderr?.on('data', () => { /* ignore */ })

        proc.on('close', () => {
          const pids = cmd === 'fuser'
            ? [] // fuser handles killing itself
            : stdout.trim().split('\n').filter(Boolean)
          let killed = false
          if (cmd === 'fuser') {
            killed = true // fuser -k returns success if it killed something
          } else {
            for (const pidStr of pids) {
              const pid = parseInt(pidStr, 10)
              if (!isNaN(pid)) {
                try {
                  process.kill(pid, 'SIGKILL')
                  killed = true
                } catch {
                  // Process might already be dead
                }
              }
            }
          }
          if (killed) {
            resolve(true)
          } else {
            tryNext()
          }
        })

        proc.on('error', () => tryNext())

        // Safety timeout
        setTimeout(() => {
          try { proc.kill() } catch { /* ignore */ }
          tryNext()
        }, 5000)
      }

      tryNext()
    }
  })
}

/**
 * Find the bot-runner directory — ALWAYS prefer the real project root path,
 * NOT the .next/standalone/ path. The standalone directory's node_modules
 * only contains Next.js runtime deps, NOT socket.io/express that bot-runner needs.
 */
function findRunnerDir(): string | null {
  const projectRoot = resolveFromProjectRoot()

  // Strategy 1: Check project root first (ALWAYS preferred — has full node_modules)
  const rootRunnerDir = path.join(projectRoot, 'mini-services', 'bot-runner')
  const rootHasIndex = existsSync(path.join(rootRunnerDir, 'index.ts'))
  const rootHasPkg = existsSync(path.join(rootRunnerDir, 'package.json'))
  const rootHasModules = existsSync(path.join(rootRunnerDir, 'node_modules'))
  if ((rootHasIndex || rootHasPkg) && rootHasModules) {
    return rootRunnerDir
  }

  // Strategy 2: Project root exists but node_modules missing — still use it
  // (start-service route will auto-install deps)
  if (rootHasIndex || rootHasPkg) {
    return rootRunnerDir
  }

  // Strategy 3: Follow symlinks (the real path behind a symlink)
  try {
    const symlinkPath = path.join(projectRoot, 'mini-services', 'bot-runner')
    const realPath = realpathSync(symlinkPath)
    if (realPath !== symlinkPath) {  // Only if it's actually a symlink
      if (existsSync(path.join(realPath, 'index.ts')) || existsSync(path.join(realPath, 'package.json'))) {
        return realPath
      }
    }
  } catch {
    // ignore
  }

  // Strategy 4: Last resort — check standalone directory
  // WARNING: This path may not have all node_modules needed by bot-runner
  const cwd = process.cwd()
  const standaloneRunnerDir = path.join(cwd, 'mini-services', 'bot-runner')
  if (existsSync(path.join(standaloneRunnerDir, 'index.ts')) || existsSync(path.join(standaloneRunnerDir, 'package.json'))) {
    console.warn('[start-service] WARNING: Using standalone path for bot-runner — may lack node_modules')
    return standaloneRunnerDir
  }

  return null
}

export async function POST(request: Request) {
  try {
    // Defense in depth: validate auth token — check both Bearer header and cookie
    const authHeader = request.headers.get('authorization')
    const cookieToken = request.headers.get('cookie')?.match(/session_token=([^;]+)/)?.[1]
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : cookieToken || null
    const session = token ? await validateSessionAsync(token) : null
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // SECURITY FIX (SEC-108): Authorization check — only admin (first account) can
    // start the runner service. Starting the service kills existing processes and
    // spawns a new one, which is a privileged operation that should not be available
    // to all authenticated users.
    const { db } = await import('@/lib/db')
    const firstAccount = await db.account.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
    if (!firstAccount || firstAccount.id !== session.userId) {
      return NextResponse.json(
        { error: 'Forbidden: only admin can start the runner service' },
        { status: 403 }
      )
    }

    // Derive port from BOT_RUNNER_URL (supports custom host in containerized deployments)
    const PORT = parseInt(new URL(BOT_RUNNER_URL).port, 10) || 3001

    // First check: is the in-memory tracked service running?
    if (isServiceRunning()) {
      return NextResponse.json(
        {
          success: true,
          message: 'Bot runner service is already running',
          // SECURITY FIX (SEC-82): Removed pid from response to prevent
          // information leakage that could aid targeted attacks.
        },
        { status: 200 }
      )
    }

    // Second check: is there already a runner process listening on the port?
    // This covers the case where PM2 manages the bot-runner separately.
    try {
      const healthResp = await fetch(`${BOT_RUNNER_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (healthResp.ok) {
        const data = await healthResp.json()
        return NextResponse.json(
          {
            success: true,
            message: 'Bot runner service is already running (external process)',
            port: PORT,
            external: true,
          },
          { status: 200 }
        )
      }
    } catch {
      // Runner is not accessible, proceed to start it
    }

    // Find the bot-runner directory using robust path resolution
    const runnerDir = findRunnerDir()
    if (!runnerDir) {
      console.error('[start-service] Could not find bot-runner directory in any expected location')
      return NextResponse.json(
        {
          success: false,
          message: 'Bot runner directory not found. Ensure mini-services/bot-runner exists.',
        },
        { status: 500 }
      )
    }

    // Check that the runner directory has its own node_modules (critical for Bun module resolution)
    const runnerNodeModules = path.join(runnerDir, 'node_modules')
    if (!existsSync(runnerNodeModules)) {
      console.warn(`[start-service] Warning: ${runnerDir} does not have node_modules. Attempting bun install...`)
      // Try to install dependencies on-the-fly
      try {
        const installProc = spawn('bun', ['install'], {
          cwd: runnerDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000,
        })
        await new Promise<void>((resolve, reject) => {
          installProc.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`bun install exited with code ${code}`))
          })
          installProc.on('error', reject)
        })
        console.log(`[start-service] bun install completed in ${runnerDir}`)
      } catch (installErr) {
        console.error(`[start-service] bun install failed in ${runnerDir}:`, installErr)
      }
    }

    // Kill any existing process on the port (from previous crashed instances)
    await killExistingOnPort(PORT)

    // Brief delay to let the port free up
    await new Promise((r) => setTimeout(r, 500))

    // Resolve runner binary — prefer tsx (Node.js) over bun for production.
    // Bun intercepts spawn('node') calls which breaks native C++ modules (better-sqlite3).
    // PM2 also uses tsx, so this ensures consistency across all launch methods.
    const isDev = process.env.NODE_ENV !== 'production'
    let runnerCmd = 'tsx'
    let runnerArgs = isDev ? ['--watch', 'index.ts'] : ['index.ts']

    // SECURITY FIX: Only pass whitelisted env vars to bot-runner child process.
    // Passing all of process.env would leak ENCRYPTION_KEY, HMAC_SECRET, etc.
    const safeEnvVars: Record<string, string> = {
      PORT: String(PORT),
      NODE_ENV: process.env.NODE_ENV || 'development',
    }
    if (process.env.DATABASE_URL) safeEnvVars.DATABASE_URL = process.env.DATABASE_URL
    if (process.env.PATH) safeEnvVars.PATH = process.env.PATH
    if (process.env.HOME) safeEnvVars.HOME = process.env.HOME
    if (process.env.PROJECT_ROOT) safeEnvVars.PROJECT_ROOT = process.env.PROJECT_ROOT
    if (process.env.SERVER_ORIGIN) safeEnvVars.SERVER_ORIGIN = process.env.SERVER_ORIGIN
    if (process.env.BOT_RUNNER_URL) safeEnvVars.BOT_RUNNER_URL = process.env.BOT_RUNNER_URL

    // Resolve tsx binary path — in production standalone mode, bare 'tsx' might
    // not be in PATH. Try common locations.
    if (process.env.PATH) {
      const pathDirs = process.env.PATH.split(path.delimiter)
      const tsxCandidate = pathDirs.find(d => existsSync(path.join(d, 'tsx')) || existsSync(path.join(d, 'tsx.cmd')))
      if (!tsxCandidate) {
        // Try common global install locations
        const candidates = [
          '/usr/local/bin/tsx',
          '/usr/bin/tsx',
          path.join(process.env.HOME || '/root', '.local', 'share', 'pnpm', 'tsx'),
        ]
        for (const c of candidates) {
          if (existsSync(c)) {
            runnerCmd = c
            break
          }
        }
      }
    }

    console.log(`[start-service] Starting bot-runner: ${runnerCmd} ${runnerArgs.join(' ')} (cwd: ${runnerDir})`)

    serviceProcess = spawn(runnerCmd, runnerArgs, {
      cwd: runnerDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeEnvVars as unknown as NodeJS.ProcessEnv,
    })

    if (!serviceProcess) {
      return NextResponse.json(
        { success: false, message: 'Failed to spawn bot-runner process' },
        { status: 500 }
      )
    }

    // Log service output for debugging (stdout/stderr)
    serviceProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[bot-runner:${PORT}] ${data.toString().trimEnd()}`)
    })
    serviceProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[bot-runner:${PORT}] ${data.toString().trimEnd()}`)
    })
    serviceProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.warn(`[bot-runner:${PORT}] exited with code ${code}`)
      }
      serviceProcess = null
    })

    // Allow the parent process to exit independently
    serviceProcess.unref()

    // Wait a moment and verify the process started successfully
    await new Promise((r) => setTimeout(r, 1500))

    // Quick health check
    try {
      const healthResp = await fetch(`${BOT_RUNNER_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (healthResp.ok) {
        return NextResponse.json(
          {
            success: true,
            message: 'Bot runner service started and health check passed',
            port: PORT,
          },
          { status: 200 }
        )
      }
    } catch {
      // Health check failed — process may still be starting up
    }

    return NextResponse.json(
      {
        success: true,
        message: 'Bot runner service started (health check pending)',
        port: PORT,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error('Failed to start bot-runner service:', error)
    // SECURITY FIX: Don't leak raw error messages (may contain internal paths, module names)
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to start bot runner service',
      },
      { status: 500 }
    )
  }
}
