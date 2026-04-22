import { createHash } from 'crypto'
import { join, resolve, dirname } from 'path'
import { access, readFile, writeFile, mkdir, chmod } from 'fs/promises'
import { mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import type { DepsDiff } from './types'

// ─── Path Constants ───────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const PORT = parseInt(process.env.PORT || '3001', 10)
export const BOTS_DIR = resolve(__dirname, 'bots')
export const TEMPLATES_DIR = resolve(__dirname, 'templates')
export const CONFIG_DIR = resolve(__dirname, 'config')

// Ensure directories exist at startup (sync is acceptable during initialization)
mkdirSync(BOTS_DIR, { recursive: true })
mkdirSync(TEMPLATES_DIR, { recursive: true })
mkdirSync(CONFIG_DIR, { recursive: true })

// ─── Bot Helpers ──────────────────────────────────────────────────────────

/** Sanitize botId to only allow safe characters (prevent shell injection) */
export function sanitizeBotId(botId: string): string {
  // Only allow alphanumeric, hyphens, underscores, and dots
  const sanitized = botId.replace(/[^a-zA-Z0-9._-]/g, '')
  // Block path traversal: reject if result is .. or contains ..
  if (sanitized === '..' || sanitized.includes('..')) return ''
  return sanitized
}

// P3-3 FIX: Always sanitize botId to prevent path traversal
export function getBotDir(botId: string): string {
  const sanitized = sanitizeBotId(botId)
  if (!sanitized) return ''  // Invalid botId
  const dir = join(BOTS_DIR, sanitized)
  const resolved = resolve(dir)
  const botsDirResolved = resolve(BOTS_DIR)
  // Security: ensure the resolved path is within BOTS_DIR
  // Use both forward and backward slash checks for cross-platform compatibility
  if (!resolved.startsWith(botsDirResolved + '/') && 
      !resolved.startsWith(botsDirResolved + '\\') && 
      resolved !== botsDirResolved) {
    return ''  // Path traversal blocked
  }
  return resolved
}

// ─── Dependency Hash Helpers (Incremental Deploy) ─────────────────────────

/** Hash npm package.json dependencies object deterministically */
export function hashDependencies(deps: Record<string, string>): string {
  const sorted = JSON.stringify(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(sorted).digest('hex')
}

/** Hash Python requirements.txt content deterministically */
export function hashRequirements(content: string): string {
  const normalized = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .sort()
    .join('\n')
  return createHash('sha256').update(normalized).digest('hex')
}

/** Read previously stored dependency hash from deps-hash.json */
export async function readDepsHashAsync(botDir: string): Promise<string | null> {
  const hashPath = join(botDir, 'deps-hash.json')
  try {
    await access(hashPath)
  } catch {
    return null
  }
  try {
    const content = await readFile(hashPath, 'utf-8')
    const data = JSON.parse(content)
    return typeof data.hash === 'string' ? data.hash : null
  } catch {
    return null
  }
}

/** Read previously stored dependency object from deps-hash.json */
export async function readStoredDepsAsync(botDir: string): Promise<Record<string, string> | null> {
  const hashPath = join(botDir, 'deps-hash.json')
  try {
    await access(hashPath)
  } catch {
    return null
  }
  try {
    const content = await readFile(hashPath, 'utf-8')
    const data = JSON.parse(content)
    return (typeof data.deps === 'object' && data.deps !== null && !Array.isArray(data.deps))
      ? data.deps as Record<string, string>
      : null
  } catch {
    return null
  }
}

/** Write dependency hash + metadata to deps-hash.json */
export async function writeDepsHashAsync(botDir: string, hash: string, deps: Record<string, string> | string): Promise<void> {
  const hashPath = join(botDir, 'deps-hash.json')
  await writeFile(hashPath, JSON.stringify({
    hash,
    timestamp: new Date().toISOString(),
    deps,
  }, null, 2), 'utf-8')
}

/** Compute the diff between old and new npm dependencies */
export function computeDepsDiff(oldDeps: Record<string, string>, newDeps: Record<string, string>): DepsDiff {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []

  for (const [name, version] of Object.entries(newDeps)) {
    if (!(name in oldDeps)) {
      added.push(`${name}@${version}`)
    } else if (oldDeps[name] !== version) {
      changed.push(`${name}@${version}`)
    }
  }

  for (const name of Object.keys(oldDeps)) {
    if (!(name in newDeps)) {
      removed.push(name)
    }
  }

  return { added, removed, changed }
}

// ─── Dotenv Support ───────────────────────────────────────────────────────

/** Add dotenv to dependencies and prepend loading to entry file */
export async function addDotenvSupportAsync(botDir: string, language: string, entryPoint?: string) {
  // SECURITY FIX: Validate entryPoint doesn't contain path traversal
  // Block both Unix and Windows absolute paths, plus parent directory references
  if (entryPoint && (entryPoint.includes('..') || entryPoint.startsWith('/') || (process.platform === 'win32' && /^[a-zA-Z]:/.test(entryPoint)))) {
    console.warn(`[Security] Blocked dangerous path in entryPoint: ${entryPoint}`)
    entryPoint = undefined
  }

  if (language === 'python') {
    const entry = entryPoint || 'bot.py'
    const filePath = join(botDir, entry)
    try {
      await access(filePath)
      const content = await readFile(filePath, 'utf-8')
      await writeFile(filePath, `from dotenv import load_dotenv\nload_dotenv()\n\n${content}`, 'utf-8')
    } catch { /* file doesn't exist, skip */ }
    const reqPath = join(botDir, 'requirements.txt')
    try {
      await access(reqPath)
      const content = await readFile(reqPath, 'utf-8')
      if (!content.includes('python-dotenv')) {
        await writeFile(reqPath, `python-dotenv\n${content}`, 'utf-8')
      }
    } catch { /* file doesn't exist, skip */ }
  } else {
    const entry = entryPoint || (language === 'typescript' ? 'index.ts' : 'index.js')
    const filePath = join(botDir, entry)
    try {
      await access(filePath)
      const content = await readFile(filePath, 'utf-8')
      await writeFile(filePath, `require('dotenv').config();\n\n${content}`, 'utf-8')
    } catch { /* file doesn't exist, skip */ }
    const pkgPath = join(botDir, 'package.json')
    try {
      await access(pkgPath)
      const pkgContent = await readFile(pkgPath, 'utf-8')
      const pkg = JSON.parse(pkgContent)
      if (!pkg.dependencies?.dotenv) {
        pkg.dependencies.dotenv = '^16.0.0'
        await writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8')
      }
    } catch { /* ignore */ }
  }
}

// ─── Disk Persistence for envVars ─────────────────────────────────────────

import type { SavedBotConfig } from './types'

export async function saveBotConfigAsync(botId: string, config: SavedBotConfig) {
  const safeId = sanitizeBotId(botId)
  const configPath = join(CONFIG_DIR, `${safeId}.json`)
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
  // SECURITY: Restrict config file permissions (contains bot tokens)
  await chmod(configPath, 0o600).catch(() => {})
}

export async function loadBotConfigAsync(botId: string): Promise<SavedBotConfig | null> {
  const safeId = sanitizeBotId(botId)
  const configPath = join(CONFIG_DIR, `${safeId}.json`)
  try {
    await access(configPath)
  } catch {
    return null
  }
  try {
    const content = await readFile(configPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}
