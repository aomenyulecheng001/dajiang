import { spawn } from 'child_process'
// P2-BR-9 FIX: Removed sync fs imports, using only async fs/promises
import { writeFile, mkdir, access, readFile, chmod } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import type { BotProcess, BotConfig, InstallResult, DeployStage } from './types'
import { patchTelegrafRedactToken, rebuildNativeModules, getPackageManager } from './native-modules'
import {
  sanitizeBotId,
  getBotDir,
  // P2-BR-9 FIX: Use async versions of all utils
  addDotenvSupportAsync,
  saveBotConfigAsync,
  hashDependencies,
  hashRequirements,
  readDepsHashAsync,
  readStoredDepsAsync,
  writeDepsHashAsync,
  computeDepsDiff,
} from './utils'
import { MAX_LOG_LINES, appendDeployLog } from './log-manager'
import { io } from './socket'
import { cancelRestartTimer, markIntentionalStop, clearIntentionalStop } from './process-manager'

// ─── P2-31 FIX: Shared helpers for dependency parsing and package.json generation ──────

/** P2-31 FIX: Parse a dependency string into name and version */
function parseDepString(dep: string): { name: string; version: string } {
  if (dep.startsWith('@')) {
    const slashIdx = dep.indexOf('/', 1)
    if (slashIdx !== -1) {
      const name = dep.substring(0, slashIdx)
      const rest = dep.substring(slashIdx + 1)
      const atIdx = rest.lastIndexOf('@')
      return { name, version: atIdx !== -1 ? rest.substring(atIdx + 1) : 'latest' }
    }
    return { name: dep, version: 'latest' }
  }
  const atIdx = dep.lastIndexOf('@')
  if (atIdx !== -1) {
    return { name: dep.substring(0, atIdx), version: dep.substring(atIdx + 1) }
  }
  return { name: dep, version: 'latest' }
}

/** P2-31 FIX: Write package.json for a bot project */
// P2-BR-9 FIX: Made async, uses writeFile instead of writeFileSync
async function writeBotPackageJson(botDir: string, botId: string, deps: string[], main: string) {
  const hasBetterSqlite3 = deps.some(d => d.includes('better-sqlite3'))
  const pkgJson = {
    name: `bot-${botId}`,
    version: '1.0.0',
    type: 'commonjs' as const,
    main,
    ...(hasBetterSqlite3 ? {
      pnpm: {
        onlyBuiltDependencies: ['better-sqlite3'],
      },
    } : {}),
    dependencies: {} as Record<string, string>,
  }
  for (const dep of deps) {
    const { name, version } = parseDepString(dep)
    pkgJson.dependencies[name] = version || 'latest'
  }
  await writeFile(join(botDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8')
}

// ─── Code Generation ──────────────────────────────────────────────────────

export async function generateBotFiles(botId: string, config: BotConfig): Promise<{ files: string[]; dependencies: string[] }> {
  const botDir = getBotDir(botId)
  // P2-BR-9 FIX: Use async mkdir
  await mkdir(botDir, { recursive: true })

  // ── Multi-file project (ZIP upload) ──────────────────────────────────
  if (config.projectFiles && config.projectFiles.length > 0) {
    appendDeployLog(botId, `📦 使用多文件项目部署 (${config.projectFiles.length} 个文件)...`)

    const writtenFiles: string[] = []
    const hasPackageJson = config.projectFiles.some((f) => f.path === 'package.json')

    // Write all project files, preserving directory structure
    const resolvedBotDir = resolve(botDir)
    for (const pf of config.projectFiles) {
      // P0-1 FIX: Validate path stays within botDir (prevent path traversal)
      if (!pf.path || pf.path.includes('..') || pf.path.startsWith('/') || (process.platform === 'win32' && /^[a-zA-Z]:/.test(pf.path))) {
        appendDeployLog(botId, `⚠️ 跳过危险文件路径: ${pf.path}`)
        continue
      }
      const resolvedPath = resolve(botDir, pf.path)
      // Cross-platform path containment check
      const isContained = resolvedPath.startsWith(resolvedBotDir + '/') || resolvedPath.startsWith(resolvedBotDir + '\\') || resolvedPath === resolvedBotDir
        || (process.platform === 'win32' && resolvedPath.toLowerCase().startsWith(resolvedBotDir.toLowerCase() + '\\'))
      if (!isContained) {
        appendDeployLog(botId, `⚠️ 跳过越界文件路径: ${pf.path}`)
        continue
      }
      const dir = dirname(resolvedPath)
      // P2-BR-9 FIX: Use async mkdir and writeFile
      await mkdir(dir, { recursive: true })
      await writeFile(resolvedPath, pf.content, 'utf-8')
      writtenFiles.push(pf.path)
    }

    // Collect dependencies from package.json if it exists
    let deps: string[] = config.dependencies || []
    if (!hasPackageJson && config.language !== 'python') {
      // P2-31 FIX: Use shared writeBotPackageJson helper instead of inline logic
      const main = config.entryPoint || (config.language === 'typescript' ? 'index.ts' : 'index.js')
      // P2-BR-9 FIX: writeBotPackageJson is now async
      await writeBotPackageJson(botDir, botId, deps, main)
      writtenFiles.push('package.json')
    }

    // Write .env file (only if there are env vars and no .env already in project files)
    const envEntries = Object.entries(config.envVars || {})
    const hasEnvFile = config.projectFiles.some((f) => f.path === '.env')
    if (envEntries.length > 0 && !hasEnvFile) {
      const envContent = envEntries
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('\n')
      // P2-BR-9 FIX: Use async writeFile
      await writeFile(join(botDir, '.env'), envContent, 'utf-8')
      // SECURITY: Restrict .env file permissions to owner-only (prevent token leakage)
      await chmod(join(botDir, '.env'), 0o600).catch(() => {})
      writtenFiles.push('.env')
    }

    // P2-BR-9 FIX: Use async addDotenvSupportAsync
    await addDotenvSupportAsync(botDir, config.language, config.entryPoint)

    appendDeployLog(botId, `✅ 写入 ${writtenFiles.length} 个项目文件`)
    return { files: writtenFiles, dependencies: deps }
  }

  // If user provided custom code, use it directly instead of template
  if (config.customCode && config.customCode.trim()) {
    appendDeployLog(botId, '📝 使用用户自定义代码...')

    const fileName = config.language === 'python' ? 'bot.py' : config.language === 'typescript' ? 'index.ts' : 'index.js'
    const filePath = join(botDir, fileName)
    // P2-BR-9 FIX: Use async writeFile
    await writeFile(filePath, config.customCode, 'utf-8')

    const writtenFiles: string[] = [fileName]

    // Parse dependencies from config or code (for Node.js)
    let deps: string[] = config.dependencies || []
    if (config.language !== 'python' && deps.length === 0) {
      // Auto-detect require() calls in the code
      const requireMatches = config.customCode.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || []
      const builtinModules = new Set(['fs', 'path', 'http', 'https', 'os', 'crypto', 'url', 'util', 'stream', 'events', 'child_process', 'net', 'tls', 'dns', 'buffer', 'querystring', 'assert', 'zlib'])
      for (const match of requireMatches) {
        const modMatch = match.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/)
        if (modMatch) {
          const mod = modMatch[1]
          // Skip relative paths and builtin modules
          if (!mod.startsWith('.') && !builtinModules.has(mod)) {
            const pkgName = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0]
            if (pkgName && !deps.includes(pkgName)) {
              deps.push(`${pkgName}`)
            }
          }
        }
      }
      // Always ensure telegraf for Telegram bots
      if (!deps.some(d => d.includes('telegraf')) && !config.customCode.includes('python-telegram-bot') && !config.customCode.includes('from telegram')) {
        deps.push('telegraf@^4.15.0')
      }
    }

    // Write package.json for Node.js projects
    if (config.language !== 'python') {
      // P2-31 FIX: Use shared writeBotPackageJson helper instead of inline logic
      const main = config.language === 'typescript' ? 'index.ts' : 'index.js'
      // P2-BR-9 FIX: writeBotPackageJson is now async
      await writeBotPackageJson(botDir, botId, deps, main)
      writtenFiles.push('package.json')
    } else {
      // Write requirements.txt for Python
      const pyDeps = config.dependencies || ['python-telegram-bot>=20.0']
      // P2-BR-9 FIX: Use async writeFile
      await writeFile(join(botDir, 'requirements.txt'), pyDeps.join('\n'), 'utf-8')
      writtenFiles.push('requirements.txt')
    }

    // Write .env file (only if there are env vars)
    const envEntries = Object.entries(config.envVars || {})
    if (envEntries.length > 0) {
      // BUG FIX: Always use JSON.stringify() for .env values.
      // The previous conditional quoting only wrapped values containing
      // quotes, newlines, or spaces. Values with $, #, backticks, or
      // other shell-special characters would be silently corrupted
      // (e.g., $HOME gets shell-expanded, # comment truncates the value).
      // JSON.stringify always produces a properly-quoted string that
      // dotenv parses correctly.
      const envContent = envEntries
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('\n')
      // P2-BR-9 FIX: Use async writeFile
      await writeFile(join(botDir, '.env'), envContent, 'utf-8')
      // SECURITY: Restrict .env file permissions to owner-only (prevent token leakage)
      await chmod(join(botDir, '.env'), 0o600).catch(() => {})
      writtenFiles.push('.env')
    }

    // P2-BR-9 FIX: Use async addDotenvSupportAsync
    await addDotenvSupportAsync(botDir, config.language, config.entryPoint)

    return { files: writtenFiles, dependencies: deps }
  }

  // No projectFiles and no customCode — cannot deploy
    throw new Error('No code provided. Upload project files or write custom code.')

}

// ─── Dependency Installation ──────────────────────────────────────────────

export async function installDependencies(botId: string, language: string, options?: { skipIfSame?: boolean }): Promise<InstallResult> {
  const botDir = getBotDir(botId)
  const skipIfSame = options?.skipIfSame ?? false

  // ── Incremental install: check deps hash ─────────────────────────────
  if (skipIfSame) {
    if (language === 'python') {
      // Python: hash requirements.txt content
      const reqPath = join(botDir, 'requirements.txt')
      // P2-BR-9 FIX: Use async access + readFile
      try {
        await access(reqPath)
        const newContent = await readFile(reqPath, 'utf-8')
        const newHash = hashRequirements(newContent)
        const oldHash = await readDepsHashAsync(botDir)

        if (oldHash !== null && oldHash === newHash) {
          // Hash exists and matches — skip install entirely
          return { status: 'skipped' }
        }

        // Hash missing or changed — fall through to full pip install below
        if (oldHash !== null) {
          appendDeployLog(botId, '📦 Python 依赖已变更，重新安装...')
        } else {
          appendDeployLog(botId, '📦 首次部署，完整安装 Python 依赖...')
        }
      } catch { /* requirements.txt doesn't exist, fall through */ }
    } else {
      // Node.js: hash package.json dependencies
      const pkgPath = join(botDir, 'package.json')
      // P2-BR-9 FIX: Use async access + readFile
      try {
        await access(pkgPath)
        const pkgContent = await readFile(pkgPath, 'utf-8')
        const newPkg = JSON.parse(pkgContent)
        const newDeps = newPkg.dependencies || {}
        const newHash = hashDependencies(newDeps)
        const oldHash = await readDepsHashAsync(botDir)

        if (oldHash !== null && oldHash === newHash) {
          // Hash exists and matches — skip install entirely
          return { status: 'skipped' }
        }

        // Hash missing or changed — try incremental install
        if (oldHash !== null) {
          const oldDeps = await readStoredDepsAsync(botDir) || {}
          const diff = computeDepsDiff(oldDeps, newDeps)
          const totalNew = diff.added.length + diff.changed.length

          if (totalNew > 0) {
            // Install only new/changed packages incrementally
            const installPkgs = [...diff.added, ...diff.changed]
            appendDeployLog(botId, `📦 增量安装: +${totalNew} 新依赖${diff.removed.length > 0 ? `, -${diff.removed.length} 移除` : ''}`)
            if (diff.added.length > 0) appendDeployLog(botId, `  + 新增: ${diff.added.join(', ')}`)
            if (diff.changed.length > 0) appendDeployLog(botId, `  ~ 变更: ${diff.changed.join(', ')}`)
            if (diff.removed.length > 0) appendDeployLog(botId, `  - 移除: ${diff.removed.join(', ')}`)

            let incrementalSuccess = false
            try {
              const safePkgs = installPkgs.filter(p => /^[a-zA-Z0-9@\/_.-]+$/.test(p))
              if (safePkgs.length !== installPkgs.length) {
                appendDeployLog(botId, `⚠️ Skipped packages with invalid characters`)
              }
              // P0-2 FIX: Use spawn with args array (no shell) to prevent command injection
              const pm = await getPackageManager()
              await new Promise<void>((resolvePromise, reject) => {
                const child = spawn(pm.cmd, [...pm.addArgs, ...safePkgs], {
                  cwd: botDir,
                  timeout: 120000,
                  stdio: ['pipe', 'pipe', 'pipe'],
                  shell: process.platform === 'win32',
                })
                let stdout = ''
                let stderr = ''
                child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
                child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
                child.on('error', (err) => {
                  appendDeployLog(botId, `⚠️ ${pm.cmd} spawn error: ${err.message}`)
                  reject(new Error('incremental failed'))
                })
                child.on('close', (code) => {
                  if (stdout) stdout.split('\n').forEach(line => { if (line.trim()) appendDeployLog(botId, line) })
                  if (stderr) stderr.split('\n').forEach(line => { if (line.trim()) appendDeployLog(botId, line) })
                  if (code !== 0 && code !== null) {
                    appendDeployLog(botId, `⚠️ 增量安装失败 (code: ${code})，回退到完整安装...`)
                    reject(new Error('incremental failed'))
                  } else {
                    resolvePromise()
                  }
                })
              })
              incrementalSuccess = true
            } catch {
              // Incremental failed — fall through to full install
            }

            if (incrementalSuccess) {
              // P2-BR-9 FIX: Use async writeDepsHashAsync
              await writeDepsHashAsync(botDir, newHash, newDeps)
              return { status: 'incremental', addedCount: totalNew, removedCount: diff.removed.length }
            }
          } else if (diff.removed.length > 0) {
            // Only removals — skip install, just update hash
            appendDeployLog(botId, `📦 仅依赖移除: -${diff.removed.length} (${diff.removed.join(', ')})`)
            // P2-BR-9 FIX: Use async writeDepsHashAsync
            await writeDepsHashAsync(botDir, newHash, newDeps)
            return { status: 'skipped' }
          }
        } else {
          // First deploy (no hash file) — do full install
          appendDeployLog(botId, '📦 首次部署，完整安装依赖...')
        }
      } catch {
        // package.json parse error — fall through to full install
      }
    }
  }

  // ── Full install ────────────────────────────────────────────────────
  // P0-2 FIX: Use spawn with args array (no shell) to prevent command injection
  let command: string
  let args: string[]

  if (language === 'python') {
    // BUG FIX: Don't overwrite requirements.txt with template defaults during full install.
    // generateBotFiles already wrote the correct requirements.txt with user's custom deps.
    // Overwriting would lose custom dependencies.
    command = process.platform === 'win32' ? 'pip' : 'pip3'
    args = ['install', '-r', 'requirements.txt']
  } else {
    const pm = await getPackageManager()
    command = pm.cmd
    args = pm.installArgs
  }

  return new Promise<InstallResult>((resolve, reject) => {
    // FIX: On Windows, spawn needs shell: true for .cmd/.bat files
    const child = spawn(command, args, {
      cwd: botDir,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })

    // OPT-5 FIX: Stream install output line-by-line in real-time instead of
    // buffering until process exits. This gives users immediate feedback about
    // which packages are being downloaded/installed during the deploy.
    let stderr = ''
    let stdoutBuffer = ''
    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stdoutBuffer += chunk
      // Emit each complete line as it arrives
      let newlineIdx: number
      while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1)
        if (line) appendDeployLog(botId, line)
      }
    })
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stderr += chunk
      // Also stream stderr lines for npm warnings/pip progress
      let lines = chunk.split('\n')
      for (const line of lines) {
        if (line.trim()) appendDeployLog(botId, line.trim())
      }
    })
    child.on('error', (err) => {
      reject(new Error(`依赖安装失败: ${err.message}`))
    })
    child.on('close', async (code) => {
      // Flush any remaining stdout that didn't end with a newline
      if (stdoutBuffer.trim()) {
        appendDeployLog(botId, stdoutBuffer.trim())
      }
      if (code !== 0 && code !== null) {
        reject(new Error(`依赖安装失败: ${stderr || `exit code ${code}`}`))
      } else {
        // Write deps hash after successful full install
        // P2-BR-9 FIX: Use async fs operations
        const hashBotDir = getBotDir(botId)
        if (language === 'python') {
          const reqPath = join(hashBotDir, 'requirements.txt')
          try {
            await access(reqPath)
            const content = await readFile(reqPath, 'utf-8')
            await writeDepsHashAsync(hashBotDir, hashRequirements(content), content)
          } catch { /* ignore */ }
        } else {
          const pkgPath = join(hashBotDir, 'package.json')
          try {
            await access(pkgPath)
            const pkgContent = await readFile(pkgPath, 'utf-8')
            const pkg = JSON.parse(pkgContent)
            await writeDepsHashAsync(hashBotDir, hashDependencies(pkg.dependencies || {}), pkg.dependencies || {})
          } catch { /* ignore */ }
        }
        resolve({ status: 'full' })
      }
    })
  })
}

// ─── Deploy Bot ───────────────────────────────────────────────────────────

export async function deployBot(
  botId: string,
  config: BotConfig,
  botProcesses: Map<string, BotProcess>,
  deployStatus: Map<string, { stage: DeployStage; progress: number; error?: string; logs: string[] }>,
  startBotProcess: (botId: string) => Promise<void>,
  isCancelled?: () => boolean,
): Promise<void> {
  const botDir = getBotDir(botId)

  // Validate BOT_TOKEN
  const botToken = config.envVars?.BOT_TOKEN || config.botToken || ''
  if (!botToken || botToken === 'your-token-here') {
    throw new Error('BOT_TOKEN is required and must be a valid Telegram bot token')
  }

  // ── Cancellation check helper ──────────────────────────────────────────
  // When a deploy is cancelled (user clicked stop or started a new deploy),
  // we abort cleanly: clean up state, emit 'stopped' status, and return.
  const checkCancelled = (): boolean => {
    if (!isCancelled?.()) return false
    // Deploy was cancelled — clean up
    appendDeployLog(botId, '⏹️ 部署已取消')
    const bot = botProcesses.get(botId)
    if (bot) {
      bot.status = 'stopped'
      bot.error = undefined
      bot.process = undefined
      bot.pid = undefined
    }
    deployStatus.delete(botId)
    // Clear deploy progress on client and emit stopped status
    io.emit('deploy:progress', { botId, stage: 'idle' as DeployStage, progress: 0, logs: [] })
    io.emit('bot:status', { botId, status: 'stopped' })
    return true
  }

  // BUG FIX: Stop existing process and cancel auto-restart before re-deploying.
  // Without this, re-deploying a running bot creates an orphaned process
  // (the old child process keeps running but we lose the reference).
  const existingBot = botProcesses.get(botId)
  if (existingBot?.process) {
    appendDeployLog(botId, '⏹️ 停止现有进程...')
    markIntentionalStop(botId)
    cancelRestartTimer(botId)
    const procRef = existingBot.process
    try {
      procRef.kill('SIGTERM')
    } catch { /* ignore if already dead */ }
    // BUG FIX: Add SIGKILL fallback (like stopBotProcess) to prevent orphaned processes
    // that ignore SIGTERM from holding resources the new deployment needs.
    const forceKill = setTimeout(() => {
      try { procRef.kill('SIGKILL') } catch { /* ignore */ }
    }, 10000)
    forceKill.unref()
    if (procRef.exitCode !== null) {
      clearTimeout(forceKill)
    } else {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 15000)
        procRef.once('close', () => {
          clearTimeout(forceKill)
          clearTimeout(timeout)
          resolve()
        })
      })
    }
  } else {
    // No running process, but still cancel any pending auto-restart timer
    cancelRestartTimer(botId)
    markIntentionalStop(botId)
  }

  // Check cancellation after stopping existing process
  if (checkCancelled()) return

  // Initialize bot process record
  botProcesses.set(botId, {
    id: botId,
    name: config.name,
    language: config.language,
    status: 'stopped',
    envVars: { ...config.envVars, BOT_TOKEN: botToken },
    logBuffer: [],
    maxLogLines: MAX_LOG_LINES,
    entryPoint: config.entryPoint,
    // Resource monitoring
    cpuUsage: 0,
    memoryUsage: 0,
    restartCount: 0,
    maxRestarts: 5,
    maxMemoryMb: 256,
  })

  // Persist config to disk for restart resilience
  // P2-BR-10 FIX: Use async saveBotConfig to avoid blocking event loop
  // BUG FIX: Include customCode and dependencies so recovery doesn't lose them
  await saveBotConfigAsync(botId, {
    envVars: { ...config.envVars, BOT_TOKEN: botToken },
    name: config.name,
    language: config.language,
    projectFiles: config.projectFiles,
    customCode: config.customCode,
    dependencies: config.dependencies,
    entryPoint: config.entryPoint,
    webhookSecret: (config as Record<string, unknown>).webhookSecret as string | undefined,
  })

  deployStatus.set(botId, {
    stage: 'idle',
    progress: 0,
    logs: [],
  })

  const updateStatus = (stage: DeployStage, progress: number) => {
    // Don't update status if deploy was cancelled
    if (isCancelled?.()) return
    deployStatus.set(botId, { stage, progress, logs: deployStatus.get(botId)?.logs || [] })
    io.emit('deploy:progress', { botId, stage, progress })
  }

  try {
    // Stage 1: Code Generation
    updateStatus('codeGen', 10)
    appendDeployLog(botId, '📝 正在生成代码...')
    await generateBotFiles(botId, config)
    appendDeployLog(botId, '✅ 代码生成完成')

    // Check cancellation after code generation
    if (checkCancelled()) return

    // Stage 2: Install Dependencies (incremental mode)
    updateStatus('installDeps', 30)
    appendDeployLog(botId, '📦 检查依赖变更...')
    const installResult = await installDependencies(botId, config.language, { skipIfSame: true })
    switch (installResult.status) {
      case 'skipped':
        appendDeployLog(botId, '⏭️ 依赖未变更，跳过安装')
        console.log(`[Deploy] ${botId}: ⏭️ 依赖未变更，跳过安装`)
        break
      case 'incremental':
        appendDeployLog(botId, `✅ 增量安装完成: +${installResult.addedCount} 新依赖${installResult.removedCount > 0 ? `, -${installResult.removedCount} 移除` : ''}`)
        console.log(`[Deploy] ${botId}: ✅ 增量安装完成`)
        break
      case 'full':
        appendDeployLog(botId, '✅ 依赖安装完成')
        console.log(`[Deploy] ${botId}: ✅ 依赖安装完成 (完整安装)`)
        break
    }

    // Check cancellation after dependency installation
    if (checkCancelled()) return

    // Patch Telegraf's redactToken bug (readonly error.message assignment)
    if (config.language !== 'python') {
      try {
        await patchTelegrafRedactToken(botDir)
      } catch { /* non-critical, continue deploy */ }
    }

    // Rebuild native modules (better-sqlite3, etc.) for the real Node.js runtime.
    // pnpm installs packages but native .node files may not be compiled if:
    //   - The install was intercepted by Bun (which can't compile native addons)
    //   - Build tools weren't available during install
    //   - Prebuilt binaries aren't available for the Node.js version
    if (config.language !== 'python') {
      try {
        await rebuildNativeModules(botId, botDir)
      } catch { /* non-critical, continue deploy */ }
    }

    // Stage 3: Build (TypeScript only)
    if (config.language === 'typescript') {
      updateStatus('build', 60)
      appendDeployLog(botId, '🔧 正在编译 TypeScript...')
      // P0-2 FIX: Use spawn (no shell) for TypeScript check
      // OPT-5 FIX: Stream TypeScript build output in real-time
      const pm = await getPackageManager()
      let tscCmd: string
      let tscArgs: string[]
      if (pm.cmd === 'pnpm') {
        tscCmd = 'pnpm'
        tscArgs = ['exec', 'tsc', '--noEmit']
      } else if (pm.cmd === 'bun') {
        tscCmd = 'bunx'
        tscArgs = ['tsc', '--noEmit']
      } else {
        tscCmd = 'npx'
        tscArgs = ['tsc', '--noEmit']
      }
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(tscCmd, tscArgs, {
          cwd: botDir,
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let tsBuffer = ''
        child.stdout?.on('data', (data: Buffer) => {
          const chunk = data.toString()
          tsBuffer += chunk
          let newlineIdx: number
          while ((newlineIdx = tsBuffer.indexOf('\n')) !== -1) {
            const line = tsBuffer.slice(0, newlineIdx).trim()
            tsBuffer = tsBuffer.slice(newlineIdx + 1)
            if (line) appendDeployLog(botId, line)
          }
        })
        child.stderr?.on('data', (data: Buffer) => {
          const chunk = data.toString()
          for (const line of chunk.split('\n')) {
            if (line.trim()) appendDeployLog(botId, line.trim())
          }
        })
        child.on('error', (err) => {
          appendDeployLog(botId, `❌ TypeScript 编译检查失败: ${err.message}`)
          reject(new Error(`TypeScript type check failed: ${err.message}`))
        })
        child.on('close', (code) => {
          // Flush remaining
          if (tsBuffer.trim()) appendDeployLog(botId, tsBuffer.trim())
          // BUG FIX: Fail deploy if TypeScript type check has errors
          if (code !== 0 && code !== null) {
            appendDeployLog(botId, '❌ TypeScript 类型检查失败')
            reject(new Error('TypeScript type check failed'))
          } else {
            resolve()
          }
        })
      })
      appendDeployLog(botId, '✅ 编译完成')
    } else {
      updateStatus('build', 60)
    }

    // Check cancellation before starting the bot
    if (checkCancelled()) return

    // Stage 4: Start
    updateStatus('start', 80)
    appendDeployLog(botId, '🚀 正在启动机器人...')
    await startBotProcess(botId)
    // BUG FIX: Clear intentional stop flag after successful process start.
    // Without this, the first crash after deploy would be treated as an intentional
    // stop and skip auto-restart (because markIntentionalStop was called earlier).
    clearIntentionalStop(botId)
    appendDeployLog(botId, '✅ 机器人已启动')

    // Wait a bit to check if process stays alive
    await new Promise(r => setTimeout(r, 2000))

    // Final cancellation check — don't set 'running' status if cancelled
    if (checkCancelled()) {
      // Bot was started but then cancelled — stop it
      const bot = botProcesses.get(botId)
      if (bot?.process) {
        try { bot.process.kill('SIGTERM') } catch { /* ignore */ }
      }
      return
    }

    const bot = botProcesses.get(botId)
    if (bot?.status === 'running') {
      updateStatus('running', 100)
      appendDeployLog(botId, '🎉 部署成功！机器人正在运行')
    } else {
      // BUG FIX: If the bot exited immediately after deploy, cancel any pending
      // auto-restart timer. The fast-fail detection in handleBotExit limits restarts,
      // but we also need to prevent the auto-restart from firing after deploy detects failure.
      cancelRestartTimer(botId)
      markIntentionalStop(botId)

      const errorMessage = bot?.exitCode !== null && bot?.exitCode !== undefined
        ? `❌ 部署失败: 机器人启动后立即退出 (code: ${bot.exitCode})。请检查 Bot Token 是否有效。`
        : '❌ 部署失败: 机器人未能正常启动'
      updateStatus('error', 80)
      appendDeployLog(botId, errorMessage)
    }
  } catch (err: any) {
    // Check if the error is due to cancellation
    if (isCancelled?.()) {
      checkCancelled() // Will clean up
      return
    }
    updateStatus('error', deployStatus.get(botId)?.progress || 0)
    appendDeployLog(botId, `❌ 部署失败: ${err.message}`)
    const bot = botProcesses.get(botId)
    if (bot) {
      bot.status = 'error'
      bot.error = err.message
    }
    // Cancel any auto-restart timer that might have been set by handleBotExit
    cancelRestartTimer(botId)
    markIntentionalStop(botId)
  }
}
