import { logger } from './logger'
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
        logger.info('native-modules', `Fixed Telegraf redactToken in ${clientPath}`)
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

    const buildToolsHint = getBuildToolsInstallCommand()

    // Find the actual better-sqlite3 module directory (pnpm uses .pnpm store)
    let sqlite3Dir = join(nmPath, 'better-sqlite3')
    try {
      const s = await stat(sqlite3Dir)
      if (!s.isDirectory()) sqlite3Dir = ''
    } catch { sqlite3Dir = '' }

    if (!sqlite3Dir) {
      // Search pnpm virtual store for better-sqlite3
      try {
        const pnpmDir = join(nmPath, '.pnpm')
        const entries = await readdir(pnpmDir)
        const match = entries.find(e => e.startsWith('better-sqlite3'))
        if (match) sqlite3Dir = join(pnpmDir, match, 'node_modules', 'better-sqlite3')
      } catch { /* not found */ }
    }

    if (!sqlite3Dir) {
      appendDeployLog(botId, '⚠️ 找不到 better-sqlite3 模块目录')
      return
    }

    // Use node-gyp rebuild directly (bypasses pnpm's strict script isolation
    // which can't find prebuild-install). node-gyp rebuild --release works
    // reliably because it invokes g++/make directly from the module directory.
    const nodeGypCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const nodeGypArgs = ['--yes', 'node-gyp', 'rebuild', '--release']

    await new Promise<void>((resolve) => {
      const child = spawn(nodeGypCmd, nodeGypArgs, {
        cwd: sqlite3Dir,
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
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
        appendDeployLog(botId, `⚠️ 原生模块编译失败: ${err.message}`)
        appendDeployLog(botId, `   提示: ${buildToolsHint}`)
        resolve()
      })
      child.on('close', (code) => {
        if (code === 0) {
          appendDeployLog(botId, '✅ 原生模块编译完成')
          testNativeModuleLoad(nmPath).then(ok => {
            if (!ok) {
              appendDeployLog(botId, '⚠️ 编译后模块仍无法加载')
              appendDeployLog(botId, `   ${buildToolsHint}`)
            }
          }).catch(() => {})
        } else {
          appendDeployLog(botId, `⚠️ 原生模块编译退出码: ${code}`)
          appendDeployLog(botId, `   提示: ${buildToolsHint}`)
        }
        resolve()
      })
    })
  } catch { /* non-critical */ }
}

// ─── Package Manager ──────────────────────────────────────────────────────
// Always use npm — it has prebuilt binaries for native modules (better-sqlite3)
// avoiding the ELIFECYCLE issues that pnpm's strict mode causes.
export async function getPackageManager(): Promise<{ cmd: string; installArgs: string[]; addArgs: string[] }> {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return { cmd: npmCmd, installArgs: ['install', '--omit=dev'], addArgs: ['install'] }
}
