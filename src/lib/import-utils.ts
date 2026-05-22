/**
 * Import utilities for Bot Factory — extracted from create-bot-dialog.tsx (P2-12)
 *
 * Contains file parsing, language detection, and dependency detection helpers
 * used by the Create Bot Dialog's import and git clone modes.
 */

import type { BotLanguage, ProjectFile } from '@/types/bot'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ParsedEnv {
  key: string
  value: string
  description?: string
}

export interface ImportFile {
  name: string
  size: number
  type: 'code' | 'env'
  content: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const SKIP_PATTERNS = ['node_modules/', '.git/', 'package-lock.json', 'yarn.lock', 'bun.lockb', '.DS_Store', 'Thumbs.db', '__pycache__/', '.venv/', 'venv/', '.tox/', '.mypy_cache/', '.pytest_cache/', 'dist/', 'build/', '.next/', '.nuxt/']
export const MAX_ZIP_SIZE = 10 * 1024 * 1024 // 10MB (compressed)
export const MAX_FILE_COUNT = 500 // Maximum number of files after extraction
export const MAX_SINGLE_FILE_SIZE = 1 * 1024 * 1024 // 1MB per extracted file
export const MAX_TOTAL_EXTRACTED_SIZE = 20 * 1024 * 1024 // 20MB total extracted content

// Comprehensive binary file extensions — must be skipped when reading as text
export const BINARY_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'webp', 'tiff', 'tif', 'avif',
  // Fonts
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  // Archives
  'gz', 'tar', 'zip', 'bz2', 'xz', '7z', 'rar', 'tgz',
  // Media
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv', 'flac', 'ogg', 'wma', 'wmv', 'webm',
  // Executables & binaries
  'exe', 'dll', 'so', 'dylib', 'bin', 'app', 'dmg', 'iso', 'img',
  // Documents (binary formats)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Databases
  'sqlite', 'sqlite3', 'db',
  // Java
  'jar', 'class',
  // Python compiled
  'pyc', 'pyo', 'pyd',
  // Lock files (binary)
  'lockb',
])

// ─── File Helpers ───────────────────────────────────────────────────────────

export function shouldSkipFile(path: string): boolean {
  // Normalize Windows backslashes to forward slashes for consistent matching
  const normalized = path.replace(/\\/g, '/')
  return SKIP_PATTERNS.some((p) => normalized.includes(p))
}

/** Check if a file extension indicates a binary file that should not be read as text */
export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext.toLowerCase())
}

/** Normalize ZIP entry path: convert backslashes, strip leading slashes, remove ./ prefix */
export function normalizeZipPath(path: string): string {
  // Convert Windows backslashes to forward slashes
  let normalized = path.replace(/\\/g, '/')
  // Strip leading slashes or ./ prefix (common in some ZIP tools)
  while (normalized.startsWith('/')) normalized = normalized.slice(1)
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  return normalized
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function getFileIcon(fileName: string): { icon: 'settings' | 'file-code' | 'file-text' | 'file'; className: string } {
  // Lazy imports avoided — use string-based icon name matching
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  if (['json', 'lock'].includes(ext)) return { icon: 'settings', className: 'text-amber-500' }
  if (['js', 'mjs', 'cjs'].includes(ext)) return { icon: 'file-code', className: 'text-yellow-500' }
  if (['ts', 'tsx', 'mts'].includes(ext)) return { icon: 'file-code', className: 'text-blue-500' }
  if (ext === 'py') return { icon: 'file-code', className: 'text-emerald-500' }
  if (['env', 'env.local', 'env.production'].includes(fileName) || fileName.includes('env')) return { icon: 'settings', className: 'text-orange-500' }
  if (['md', 'txt', 'readme'].includes(ext)) return { icon: 'file-text', className: 'text-zinc-400' }
  if (['yaml', 'yml', 'toml'].includes(ext)) return { icon: 'settings', className: 'text-emerald-500' }
  return { icon: 'file', className: 'text-zinc-400' }
}

// ─── Language Detection ─────────────────────────────────────────────────────

export function detectLanguage(fileName: string): BotLanguage {
  if (fileName.endsWith('.ts') || fileName.endsWith('.tsx') || fileName.endsWith('.mts')) return 'typescript'
  if (fileName.endsWith('.py')) return 'python'
  return 'javascript'
}

export function detectLanguageFromFiles(projectFiles: ProjectFile[]): BotLanguage {
  let tsCount = 0
  let pyCount = 0
  let jsCount = 0
  for (const file of projectFiles) {
    if (file.path.endsWith('.ts') || file.path.endsWith('.tsx')) tsCount++
    else if (file.path.endsWith('.py')) pyCount++
    else if (file.path.endsWith('.js') || file.path.endsWith('.mjs') || file.path.endsWith('.cjs')) jsCount++
  }
  if (tsCount > 0 && tsCount >= jsCount) return 'typescript'
  if (pyCount > 0 && pyCount >= jsCount) return 'python'
  return 'javascript'
}

// ─── Env File Parsing ──────────────────────────────────────────────────────

function guessEnvDescription(key: string): string {
  const lower = key.toLowerCase()
  const map: Record<string, string> = {
    token: 'Bot Token', api: 'API Endpoint', url: 'URL',
    port: 'Port', key: 'API Key', secret: 'Secret Key',
    id: 'ID', admin: 'Admin ID', group: 'Group ID',
    timeout: 'Timeout', lang: 'Language',
  }
  for (const [k, desc] of Object.entries(map)) {
    if (lower.includes(k)) return desc
  }
  return ''
}

export function parseEnvFile(content: string): ParsedEnv[] {
  const lines = content.split('\n')
  const envVars: ParsedEnv[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    const cleanValue = value.replace(/^["']|["']$/g, '')
    if (key) {
      envVars.push({ key, value: cleanValue, description: guessEnvDescription(key) })
    }
  }
  return envVars
}

// ─── Dependency Detection ──────────────────────────────────────────────────

export function detectDependencies(code: string): { name: string; version: string; isRequired: boolean; description: string }[] {
  const deps: { name: string; version: string; isRequired: boolean; description: string }[] = []
  const seen = new Set<string>()
  const builtins = ['express', 'path', 'fs', 'os', 'http', 'https', 'crypto', 'util', 'stream', 'events', 'child_process', 'net', 'url', 'querystring', 'buffer']

  // Detect CommonJS require() calls
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let match: RegExpExecArray | null
  while ((match = requireRegex.exec(code)) !== null) {
    const pkg = match[1]
    const pkgName = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0]
    if (seen.has(pkgName) || builtins.includes(pkgName) || pkg.startsWith('.')) continue
    seen.add(pkgName)
    deps.push({ name: pkgName, version: 'latest', isRequired: true, description: `${pkgName} package` })
  }

  // Detect ES module import statements: import ... from 'package'
  const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g
  while ((match = importRegex.exec(code)) !== null) {
    const pkg = match[1]
    const pkgName = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0]
    if (seen.has(pkgName) || builtins.includes(pkgName) || pkg.startsWith('.')) continue
    seen.add(pkgName)
    deps.push({ name: pkgName, version: 'latest', isRequired: true, description: `${pkgName} package` })
  }

  return deps
}

// ─── Bot Name Detection ───────────────────────────────────────────────────

export function detectBotName(code: string, fileName: string): string {
  const patterns = [
    /bot\.launch\(\s*\)\s*\.then\s*\(\s*\(\s*\)\s*=>\s*console\.log\s*\(\s*`?([^`)]+)`?\s*\)/,
    /name\s*[:=]\s*['"]([^'"]+)['"]/,
  ]
  for (const p of patterns) {
    const m = code.match(p)
    if (m) return m[1].trim()
  }
  return fileName.replace(/\.(js|ts|mjs|cjs|py)$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── Package Manifest Parsing ─────────────────────────────────────────────

export function parsePackageJson(content: string): {
  name?: string
  description?: string
  main?: string
  startScript?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} | null {
  try {
    const pkg = JSON.parse(content)
    return {
      name: pkg.name,
      description: pkg.description,
      main: pkg.main,
      startScript: pkg.scripts?.start,
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
    }
  } catch {
    return null
  }
}

export function parseRequirementsTxt(content: string): { name: string; version: string; isRequired: boolean; description: string }[] {
  const deps: { name: string; version: string; isRequired: boolean; description: string }[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([a-zA-Z0-9._-]+)\s*([><=!~]+)?\s*([\d.]+)?/)
    if (match) {
      deps.push({
        name: match[1],
        version: match[3] || 'latest',
        isRequired: true,
        description: `${match[1]} package`,
      })
    }
  }
  return deps
}

// ─── Entry Point Detection ─────────────────────────────────────────────────

const COMMON_ENTRY_POINTS = ['index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'app.ts', 'bot.js', 'bot.ts', 'server.js', 'server.ts', 'index.py', 'main.py', 'bot.py']

export function detectEntryPoint(files: ProjectFile[], packageJson: ProjectFile | undefined): string {
  // Try package.json first
  if (packageJson) {
    const parsed = parsePackageJson(packageJson.content)
    if (parsed?.main) return parsed.main
  }

  // Fall back to common entry point names
  const candidates = files.filter((f) => {
    const n = f.path.split('/').pop() || ''
    return COMMON_ENTRY_POINTS.includes(n)
  })
  if (candidates.length > 0) return candidates[0].path

  // Fall back to first code file
  const firstCode = files.find((f) => {
    const ext = f.path.split('.').pop()?.toLowerCase()
    return ['.js', '.ts', '.py'].includes(`.${ext}`)
  })
  return firstCode?.path || ''
}

export function detectBotNameFromPackage(packageJson: ProjectFile | undefined): string {
  if (!packageJson) return ''
  const parsed = parsePackageJson(packageJson.content)
  if (!parsed?.name) return ''
  return parsed.name.replace(/^@[^/]+\//, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function detectDescriptionFromPackage(packageJson: ProjectFile | undefined): string {
  if (!packageJson) return ''
  const parsed = parsePackageJson(packageJson.content)
  return parsed?.description || ''
}
