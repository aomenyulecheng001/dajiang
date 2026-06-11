import { logger } from './logger'
import { spawn, execFile } from 'child_process'
import { readFile, writeFile, stat, readdir } from 'fs/promises'
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
        ['-e', `try { const D=require('better-sqlite3'); new D(':memory:').close(); process.exit(0) } catch(e) { process.exit(1) }`],
        // FIX (M4): Increase maxBuffer to 1MB. Default 200KB can overflow if
        // better-sqlite3 outputs compilation warnings during load, causing
        // testNativeModuleLoad to incorrectly return false and trigger
        // unnecessary recompilation.
        { cwd: botDir, timeout: 10000, maxBuffer: 1024 * 1024 },
      )
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('load failed')))
      child.on('error', reject)
    })
    return true
  } catch {
    return false
  }
}

// M11 FIXED: Changed from sync readFileSync to async readFile to avoid
// blocking the event loop during native module compilation.
export async function getBuildToolsInstallCommand(): Promise<string> {
  try {
    const osRelease = await readFile('/etc/os-release', 'utf8')
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
async function findSqlite3Dir(nmPath: string): Promise<string | null> {
  const npmPath = join(nmPath, 'better-sqlite3')
  try {
    const s = await stat(npmPath)
    if (s.isDirectory()) return npmPath
  } catch { /* not found */ }
  return null
}

/**
 * Compile better-sqlite3 using node-gyp rebuild.
 * Returns true on success, false on failure.
 */
function compileSqlite3(sqlite3Dir: string, botId: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const child = spawn(npxCmd, ['--yes', 'node-gyp', 'rebuild', '--release'], {
      cwd: sqlite3Dir,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
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
  let sqlite3Dir = await findSqlite3Dir(nmPath)
  if (!sqlite3Dir) return // No native module, nothing to do

  // Test if module is already loadable
  const canLoad = await testNativeModuleLoad(botDir)
  if (canLoad) return // Already compiled, nothing to do

  appendDeployLog(botId, '🔧 检测到原生模块 better-sqlite3 需要编译...')

  const buildHint = await getBuildToolsInstallCommand()

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

// ─── Prisma Client Generation ─────────────────────────────────────────────

/**
 * Check if the project uses Prisma by looking for @prisma/client in
 * package.json dependencies or a schema.prisma file.
 */
async function hasPrisma(botDir: string): Promise<boolean> {
  try {
    const pkgPath = join(botDir, 'package.json')
    const pkgContent = await readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(pkgContent)
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps['@prisma/client'] || deps['prisma']) return true
  } catch { /* package.json not found */ }
  try {
    await stat(join(botDir, 'prisma', 'schema.prisma'))
    return true
  } catch { /* no schema.prisma */ }
  return false
}

/**
 * Run `prisma generate` to generate the Prisma Client.
 * Needed because npm install runs with --ignore-scripts which skips
 * the postinstall script that normally runs prisma generate.
 * Without this, @prisma/client model methods (e.g., db.botConfig.findUnique)
 * won't exist at runtime and the bot will crash immediately on startup.
 */
export async function runPrismaGenerate(botId: string, botDir: string): Promise<void> {
  // Quick check: does this project use Prisma?
  if (!(await hasPrisma(botDir))) return

  appendDeployLog(botId, '🔧 检测到 Prisma，正在生成客户端...')

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'

  await new Promise<void>((resolve, reject) => {
    const child = spawn(npxCmd, ['prisma', 'generate'], {
      cwd: botDir,
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })

    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) appendDeployLog(botId, line.trim())
      }
    })
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stderr += chunk
      for (const line of chunk.split('\n')) {
        if (line.trim()) appendDeployLog(botId, line.trim())
      }
    })
    child.on('error', (err) => {
      appendDeployLog(botId, `❌ prisma generate 启动失败: ${err.message}`)
      reject(new Error(`prisma generate 启动失败: ${err.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        appendDeployLog(botId, '✅ Prisma Client 生成完成')
        resolve()
      } else {
        const detail = stderr.slice(-500) || `exit code: ${code}`
        reject(new Error(
          `Prisma Client 生成失败。请检查 schema.prisma 是否正确。\n${detail}`
        ))
      }
    })
  })
}

// ─── Package Manager ──────────────────────────────────────────────────────

// Shared npm flags for speed: skip scripts (handled separately),
// prefer local cache, skip audit/funding noise.
const NPM_SPEED_FLAGS = ['--prefer-offline', '--no-audit', '--no-fund']

export async function getPackageManager(): Promise<{ cmd: string; installArgs: string[]; addArgs: string[] }> {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return {
    cmd: npmCmd,
    installArgs: ['install', '--omit=dev', ...NPM_SPEED_FLAGS],
    addArgs: ['install', ...NPM_SPEED_FLAGS],
  }
}
