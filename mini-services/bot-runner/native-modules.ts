import { logger } from './logger'
import { spawn, execFile } from 'child_process'
import { readFile, writeFile, stat, readdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { join } from 'path'
import { appendDeployLog } from './log-manager'

// ─── Native Module Helpers ────────────────────────────────────────────────

/**
 * Test if the native module better-sqlite3 can actually be loaded.
 */
export async function testNativeModuleLoad(botDir: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath || 'node',
        ['-e', `try { require('better-sqlite3'); process.exit(0) } catch(e) { process.exit(1) }`],
        { cwd: botDir, timeout: 10000 },
      )
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('load failed')))
      child.on('error', reject)
    })
    return true
  } catch {
    return false
  }
}

export function getBuildToolsInstallCommand(): string {
  try {
    const osRelease = readFileSync('/etc/os-release', 'utf8')
    if (/ID=(?:ubuntu|debian)/.test(osRelease))
      return 'Ubuntu/Debian: sudo apt update && sudo apt install -y build-essential python3'
    if (/ID=(?:centos|rhel|rocky|alinux)/.test(osRelease))
      return 'CentOS/RHEL/Alibaba: sudo yum groupinstall "Development Tools" -y && sudo yum install python3-devel -y'
  } catch { /* not Linux */ }
  return '请安装 C++ 编译工具链和 Python3 开发头文件 (gcc/g++/make/python3-dev)'
}

// ─── Telegraf redactToken Patch ───────────────────────────────────────────

export async function patchTelegrafRedactToken(botDir: string): Promise<void> {
  try {
    const pkgPath = join(botDir, 'node_modules/telegraf/package.json')
    const pkgContent = await readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(pkgContent)
    const majorVersion = parseInt((pkg.version || '0').split('.')[0], 10)
    if (majorVersion >= 5) return
  } catch { /* ignore */ }

  const clientPaths = [
    join(botDir, 'node_modules/telegraf/lib/core/network/client.js'),
    join(botDir, 'node_modules/telegraf/src/core/network/client.js'),
  ]
  for (const clientPath of clientPaths) {
    try {
      let content = await readFile(clientPath, 'utf-8')
      const marker = 'error.message = error.message.replace'
      if (!content.includes(marker)) continue
      const lines = content.split('\n')
      let patched = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.includes(marker) && !line.includes('catch(_)')) {
          const trimmed = line.trim()
          if (trimmed.startsWith('error.message = error.message.replace')) {
            lines[i] = line.replace(
              /error\.message\s*=\s*error\.message\.replace\(([^;]+)\);?/,
              'try { error.message = error.message.replace($1); } catch(_) {}'
            )
            patched = true
          }
        }
      }
      if (patched) {
        content = lines.join('\n')
        await writeFile(clientPath, content, 'utf-8')
        logger.info('native-modules', `Fixed Telegraf redactToken in ${clientPath}`)
      }
    } catch { /* file not found */ }
  }
}

// ─── Rebuild Native Modules ───────────────────────────────────────────────

/**
 * Find the better-sqlite3 module directory (handles both npm and pnpm layouts).
 */
function findSqlite3Dir(nmPath: string): string | null {
  // npm: node_modules/better-sqlite3
  const npmPath = join(nmPath, 'better-sqlite3')
  try {
    const s = statSync(nmPath + '/better-sqlite3')
    if (s.isDirectory()) return npmPath
  } catch { /* not found */ }

  return null
}

// sync version for use in spawn callback
import { statSync } from 'fs'

/**
 * Compile better-sqlite3 using node-gyp rebuild.
 * Returns true on success, false on failure.
 */
function compileSqlite3(sqlite3Dir: string, botId: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'node-gyp', 'rebuild', '--release'], {
      cwd: sqlite3Dir,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stderr += chunk
      for (const line of chunk.split('\n')) {
        if (line.trim()) appendDeployLog(botId, line.trim())
      }
    })
    child.on('error', (err) => {
      appendDeployLog(botId, `⚠️ node-gyp 启动失败: ${err.message}`)
      resolve(false)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(true)
      } else {
        appendDeployLog(botId, `⚠️ node-gyp 编译退出码: ${code}${stderr ? '\n' + stderr.slice(-500) : ''}`)
        resolve(false)
      }
    })
  })
}

export async function rebuildNativeModules(botId: string, botDir: string): Promise<void> {
  const nmPath = join(botDir, 'node_modules')

  // Check if better-sqlite3 is even a dependency
  let sqlite3Dir = findSqlite3Dir(nmPath)
  if (!sqlite3Dir) return // No native module, nothing to do

  // Test if module is already loadable
  const canLoad = await testNativeModuleLoad(botDir)
  if (canLoad) return // Already compiled, nothing to do

  appendDeployLog(botId, '🔧 检测到原生模块 better-sqlite3 需要编译...')

  const buildHint = getBuildToolsInstallCommand()

  // Compile using node-gyp directly
  const ok = await compileSqlite3(sqlite3Dir, botId, 120000)
  if (!ok) {
    throw new Error(
      `better-sqlite3 编译失败。请确保安装了编译工具:\n${buildHint}`
    )
  }

  // Verify compilation succeeded
  const loadOk = await testNativeModuleLoad(botDir)
  if (!loadOk) {
    throw new Error(
      `better-sqlite3 编译后仍无法加载。请检查编译工具链:\n${buildHint}`
    )
  }

  appendDeployLog(botId, '✅ 原生模块编译完成并验证通过')
}

// ─── Package Manager ──────────────────────────────────────────────────────

export async function getPackageManager(): Promise<{ cmd: string; installArgs: string[]; addArgs: string[] }> {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return { cmd: npmCmd, installArgs: ['install', '--omit=dev'], addArgs: ['install'] }
}
