import { spawn, execFile } from 'child_process'
import { readFile, writeFile, stat, readdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { join } from 'path'
import { appendDeployLog } from './log-manager'

// ─── Native Module Helpers ────────────────────────────────────────────────
// These helpers detect and validate native C++ modules (better-sqlite3, etc.)
// for cross-platform deployment compatibility.

/**
 * Test if the native module (e.g., better-sqlite3) can actually be loaded
 * by Node.js. This catches version mismatches and platform incompatibilities
 * that simple file existence checks miss.
 */
export async function testNativeModuleLoad(nodeModulesPath: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath || 'node',
        ['-e', `try { require('better-sqlite3'); process.exit(0) } catch(e) { process.exit(1) }`],
        { cwd: nodeModulesPath, timeout: 10000 },
      )
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('load failed')))
      child.on('error', reject)
    })
    return true
  } catch {
    return false
  }
}

/**
 * Get OS-appropriate build tools install command.
 * Returns a human-readable command string for error messages.
 */
export function getBuildToolsInstallCommand(): string {
  try {
    const osRelease = readFileSync('/etc/os-release', 'utf8')
    if (/ID=(?:ubuntu|debian)/.test(osRelease))
      return 'Ubuntu/Debian: sudo apt update && sudo apt install -y build-essential python3'
    if (/ID=(?:centos|rhel|rocky|alinux)/.test(osRelease))
      return 'CentOS/RHEL/Alibaba: sudo yum groupinstall "Development Tools" -y && sudo yum install python3-devel -y'
  } catch { /* not Linux or cannot read */ }
  return '请安装 C++ 编译工具链和 Python3 开发头文件 (gcc/g++/make/python3-dev)'
}

// ─── Telegraf redactToken Patch ─────────────────────────────────────────────
// Telegraf's internal redactToken() tries to assign to error.message,
// which can be readonly on some Error subclasses, causing:
//   TypeError: Attempted to assign to readonly property.
// This function patches the Telegraf client.js to wrap the assignment in try-catch.
// The original code looks like:
//   function redactToken(error) { error.message = error.message.replace(/.../, '...'); throw error; }
// We replace it with:
//   function redactToken(error) { try { error.message = error.message.replace(/.../, '...'); } catch(_) {} throw error; }
export async function patchTelegrafRedactToken(botDir: string): Promise<void> {
  try {
    const pkgPath = join(botDir, 'node_modules/telegraf/package.json')
    const pkgContent = await readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(pkgContent)
    const majorVersion = parseInt((pkg.version || '0').split('.')[0], 10)
    if (majorVersion >= 5) return
  } catch { /* ignore, proceed with patch */ }

  const clientPaths = [
    join(botDir, 'node_modules/telegraf/lib/core/network/client.js'),
    join(botDir, 'node_modules/telegraf/src/core/network/client.js'),
  ]
  for (const clientPath of clientPaths) {
    try {
      let content = await readFile(clientPath, 'utf-8')
      const marker = 'error.message = error.message.replace'
      if (!content.includes(marker)) continue

      // Line-by-line approach: find the line with the assignment and wrap it in try-catch
      const lines = content.split('\n')
      let patched = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.includes(marker) && !line.includes('catch(_)')) {
          // Extract the assignment part, wrap in try { ... } catch(_) {}
          const trimmed = line.trim()
          if (trimmed.startsWith('error.message = error.message.replace')) {
            // Full line is the assignment — replace entirely
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
        console.log(`[Patch] Fixed Telegraf redactToken in ${clientPath}`)
      }
    } catch { /* file not found or patch failed */ }
  }
}

// ─── Rebuild Native Modules ──────────────────────────────────────────────────
// After pnpm/bun install, native C++ modules (like better-sqlite3) may not have
// their .node binary compiled. This function detects missing .node files and
// rebuilds them using `pnpm rebuild` or `npm rebuild`, which runs node-gyp
// under the real Node.js runtime.
//
// NATIVE FIX: Enhanced with actual load test - checks if the .node binary can
// actually be required by Node.js, not just if the file exists on disk.
// This catches cases where:
// - .node file was compiled for a different Node.js version
// - .node file was compiled for a different platform (e.g., macOS binary on Linux)
// - .node file is corrupted or incomplete
export async function rebuildNativeModules(botId: string, botDir: string): Promise<void> {
  // Check if any native module needs rebuilding by looking for missing .node files
  try {
    const nmPath = join(botDir, 'node_modules')
    let hasNativeModule = false

    // Check for better-sqlite3 specifically (most common native dependency)
    const candidatePaths = [
      join(nmPath, 'better-sqlite3'),
    ]

    for (const pattern of candidatePaths) {
      try {
        const s = await stat(pattern)
        if (s.isDirectory()) { hasNativeModule = true; break }
      } catch { /* not found */ }
    }

    if (!hasNativeModule) {
      try {
        const pnpmDir = join(nmPath, '.pnpm')
        const entries = await readdir(pnpmDir)
        if (entries.some(e => e.startsWith('better-sqlite3'))) {
          hasNativeModule = true
        }
      } catch { /* .pnpm dir not found */ }
    }

    if (!hasNativeModule) return

    // NATIVE FIX: Try to actually load the native module to verify it works.
    // This is more reliable than just checking if a .node file exists.
    const canLoadNative = await testNativeModuleLoad(nmPath)
    if (canLoadNative) return // Module loads fine, no rebuild needed

    appendDeployLog(botId, '🔧 检测到原生模块需要重新编译...')

    // Determine OS-appropriate build tools install command for error messages
    const buildToolsHint = getBuildToolsInstallCommand()
    const pm = await getPackageManager()
    const rebuildCmd = process.platform === 'win32'
      ? (pm.cmd === 'pnpm' ? 'pnpm.cmd' : pm.cmd === 'bun' ? 'bun.cmd' : 'npm.cmd')
      : (pm.cmd === 'pnpm' ? 'pnpm' : pm.cmd === 'bun' ? 'bun' : 'npm')
    const rebuildArgs = ['rebuild']

    await new Promise<void>((resolve, reject) => {
      const child = spawn(rebuildCmd, rebuildArgs, {
        cwd: botDir,
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        for (const line of chunk.split('\n')) {
          if (line.trim()) appendDeployLog(botId, line.trim())
        }
      })
      child.on('error', (err) => {
        appendDeployLog(botId, `⚠️ 原生模块重编译失败: ${err.message}`)
        appendDeployLog(botId, `   提示: ${buildToolsHint}`)
        resolve() // Non-critical, don't block deploy
      })
      child.on('close', (code) => {
        if (code === 0) {
          appendDeployLog(botId, '✅ 原生模块重编译完成')
          // Verify the rebuild worked by testing load again
          testNativeModuleLoad(nmPath).then(ok => {
            if (!ok) {
              appendDeployLog(botId, '⚠️ 重编译后模块仍无法加载，可能需要安装编译工具链')
              appendDeployLog(botId, `   ${buildToolsHint}`)
            }
          }).catch(() => {})
        } else {
          appendDeployLog(botId, `⚠️ 原生模块重编译退出码: ${code}`)
          appendDeployLog(botId, `   提示: ${buildToolsHint}`)
        }
        resolve() // Non-critical, don't block deploy
      })
    })
  } catch { /* non-critical */ }
}

// ─── Package Manager Detection ─────────────────────────────────────────────
// Prefer pnpm (installs native modules like better-sqlite3 for real Node.js),
// then bun, then npm as fallback.
export async function getPackageManager(): Promise<{ cmd: string; installArgs: string[]; addArgs: string[] }> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('pnpm', ['--version'], { timeout: 3000 }, (err) => err ? reject(err) : resolve())
    })
    return { cmd: 'pnpm', installArgs: ['install', '--prod'], addArgs: ['add'] }
  } catch { /* pnpm not found */ }

  const pathEnv = process.env.PATH || ''
  // Cross-platform PATH separator check
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const hasBun = pathEnv.split(pathSep).some(p => p.includes('bun')) ||
    process.env.BUN_INSTALL !== undefined

  if (hasBun) {
    return { cmd: 'bun', installArgs: ['install', '--production'], addArgs: ['add'] }
  }

  // FIX: On Windows, npm is npm.cmd — spawn() requires the full extension
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return { cmd: npmCmd, installArgs: ['install', '--omit=dev'], addArgs: ['install'] }
}
