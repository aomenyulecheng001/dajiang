import { spawn } from 'child_process'
import { NextRequest, NextResponse } from 'next/server'
import { readdir, stat, readFile, rm, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { lookup } from 'dns/promises'
import { getCurrentUserId, getSecureClientIp } from '@/lib/api-helpers'
import { rateLimit, RATE_LIMIT_GIT_IMPORT, getRateLimitHeaders } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

// ─── Configuration ──────────────────────────────────────────────────────────

const SKIP_PATTERNS = [
  'node_modules/', '.git/', 'package-lock.json', 'yarn.lock', 'bun.lockb',
  '.DS_Store', 'Thumbs.db', '__pycache__/', '.venv/', 'venv/', '.tox/',
  '.mypy_cache/', '.pytest_cache/', 'dist/', 'build/', '.next/', '.nuxt/',
]

const BINARY_EXTENSIONS = new Set([
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

const MAX_FILE_SIZE = 1 * 1024 * 1024      // 1MB per file
const MAX_TOTAL_SIZE = 10 * 1024 * 1024    // 10MB total
const CLONE_TIMEOUT = 30_000                 // 30 seconds
// P2-API-8 FIX: Maximum directory depth and total file count limits
const MAX_DIR_DEPTH = 20
const MAX_TOTAL_FILES = 1000
// P2-API-9 FIX: Maximum git command output size
const MAX_GIT_OUTPUT_SIZE = 1 * 1024 * 1024  // 1MB

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidGitUrl(url: string): boolean {
  // SECURITY FIX (L-5): Only allow HTTPS URLs from whitelisted domains.
  // SSH URLs (git@... or ssh://...) are rejected entirely because they bypass
  // the domain whitelist and can reference internal servers not reachable via HTTPS.
  // HTTPS URLs: https://github.com/user/repo, https://gitlab.com/user/repo
  const httpsPattern = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\.git\/?$/
  // HTTPS URLs without .git: https://github.com/user/repo
  const httpsShortPattern = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/

  // Reject SSH URLs entirely
  if (/^git@/i.test(url) || /^ssh:\/\//i.test(url)) {
    return false
  }

  // SSRF FIX (Enhanced): Block private/internal IP ranges and cloud metadata endpoints.
  try {
    let hostname = ''

    const httpsMatch = url.match(/^https:\/\/([^\/]+)/)
    if (httpsMatch) {
      hostname = httpsMatch[1].toLowerCase().replace(/^\[(.*)\]$/, '$1')
    }

    if (hostname) {
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        return false
      }

      if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
        return false
      }

      if (hostname.includes(':')) {
        if (hostname === '::1' || hostname === '::ffff:127.0.0.1' || hostname.startsWith('fe80:') || hostname.startsWith('fc00:') || hostname.startsWith('fd00:')) {
          return false
        }
        const v6MappedMatch = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
        if (v6MappedMatch && isPrivateIPv4(v6MappedMatch[1])) {
          return false
        }
      }

      const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)/)
      if (ipMatch) {
        if (isPrivateIPv4(hostname)) {
          return false
        }
      }

      if (/^0\d+\./.test(hostname)) {
        return false
      }

      if (/^0x[\da-f]+\./i.test(hostname)) {
        return false
      }

      if (/^[\d.]+$/.test(hostname) && !ipMatch) {
        return false
      }
    }
  } catch {
    return false
  }

  return httpsPattern.test(url) || httpsShortPattern.test(url)
}

/** Check if an IPv4 address is in a private/reserved range */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true
  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a >= 224) return true
  return false
}

function isPrivateIP(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true
  if (ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) return true
  const v6MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v6MappedMatch && isPrivateIPv4(v6MappedMatch[1])) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && isPrivateIPv4(ip)) return true
  return false
}

async function validateResolvedHostname(hostname: string): Promise<boolean> {
  try {
    const result = await lookup(hostname)
    const ips = Array.isArray(result) ? result : [result]
    for (const addr of ips) {
      const ip = typeof addr === 'string' ? addr : addr.address
      if (isPrivateIP(ip) || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('fe80:') || ip === '0.0.0.0') {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function extractHostname(url: string): string {
  const httpsMatch = url.match(/^https:\/\/([^\/]+)/)
  if (httpsMatch) return httpsMatch[1].toLowerCase().replace(/^\[(.*)\]$/, '$1')
  const sshMatch = url.match(/^git@([^:]+):/)
  if (sshMatch) return sshMatch[1].toLowerCase()
  return ''
}

/**
 * Run a git command using spawn (no shell interpretation) to avoid injection.
 * P2-API-9 FIX: Added output size limit to prevent OOM from large git output.
 */
function runGit(args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, timeout })
    let stdout = ''
    let stderr = ''
    let outputOverflow = false
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      // P2-API-9 FIX: Check accumulated output size
      if (stdout.length > MAX_GIT_OUTPUT_SIZE) {
        outputOverflow = true
        proc.kill()
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_GIT_OUTPUT_SIZE) {
        outputOverflow = true
        proc.kill()
      }
    })
    proc.on('close', (code) => {
      if (outputOverflow) {
        reject(new Error('Git command output exceeded size limit'))
      } else if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr.trim() || `git exited with code ${code}`))
      }
    })
    proc.on('error', reject)
  })
}

function shouldSkipFile(filePath: string): boolean {
  return SKIP_PATTERNS.some((p) => filePath.includes(p))
}

function isBinaryFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return BINARY_EXTENSIONS.has(ext)
}

// ─── File Reading ───────────────────────────────────────────────────────────

async function readRepoFiles(dirPath: string): Promise<{
  files: Array<{ path: string; content: string; size: number }>
  totalSize: number
}> {
  const files: Array<{ path: string; content: string; size: number }> = []
  let totalSize = 0

  async function walkDir(currentDir: string, baseName: string, depth: number = 0) {
    // P2-API-8 FIX: Check directory depth limit
    if (depth > MAX_DIR_DEPTH) {
      logger.warn('git-import', `Max directory depth (${MAX_DIR_DEPTH}) exceeded at ${baseName}, skipping`)
      return
    }

    const entries = await readdir(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      // P2-API-8 FIX: Check total file count limit
      if (files.length >= MAX_TOTAL_FILES) {
        logger.warn('git-import', `Max file count (${MAX_TOTAL_FILES}) reached, skipping remaining files`)
        return
      }

      const fullPath = join(currentDir, entry.name)
      const relativePath = baseName ? `${baseName}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        // Skip hidden directories (except we keep .env files at file level)
        if (entry.name.startsWith('.') && entry.name !== '.env') continue
        await walkDir(fullPath, relativePath, depth + 1)
      } else if (entry.isSymbolicLink()) {
        // Skip symlinks to prevent path traversal attacks
        continue
      } else {
        if (shouldSkipFile(relativePath)) continue
        if (isBinaryFile(entry.name)) continue
        // Skip hidden files (except .env)
        if (entry.name.startsWith('.') && !entry.name.includes('env')) continue

        try {
          const fileStat = await stat(fullPath)
          if (fileStat.size > MAX_FILE_SIZE) continue

          totalSize += fileStat.size
          if (totalSize > MAX_TOTAL_SIZE) {
            throw new Error(`Total repository size exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB limit`)
          }

          const content = await readFile(fullPath, 'utf-8')
          files.push({
            path: relativePath,
            content,
            size: fileStat.size,
          })
        } catch {
          // Skip files that can't be read (permissions, encoding, etc.)
        }
      }
    }
  }

  await walkDir(dirPath, '')

  return { files, totalSize }
}

// ─── Branch Listing ────────────────────────────────────────────────────────

async function getRemoteBranches(url: string, workDir: string): Promise<string[]> {
  try {
    const stdout = await runGit(['ls-remote', '--heads', url], workDir, CLONE_TIMEOUT)

    const branches = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        // Line format: <sha>\trefs/heads/<branch-name>
        const match = line.match(/\trefs\/heads\/(.+)$/)
        return match ? match[1] : null
      })
      .filter((b): b is string => b !== null)

    return branches
  } catch {
    return []
  }
}

// ─── GET Handler: Fetch available branches ──────────────────────────────────

export async function GET(request: NextRequest) {
  // SECURITY FIX (M4): Defense-in-depth rate limiting at route level.
  // git clone is resource-intensive (30s timeout, filesystem I/O, DNS resolution).
  // While middleware applies RATE_LIMIT_GIT_IMPORT, this explicit check ensures
  // protection even if middleware is misconfigured or bypassed.
  const clientIp = getSecureClientIp(request)
  const rateResult = rateLimit.check(clientIp, RATE_LIMIT_GIT_IMPORT)
  if (!rateResult.success) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: getRateLimitHeaders(rateResult) }
    )
  }

  // SECURITY FIX (SEC-105): Defense-in-depth auth check independent of middleware.
  // git clone is resource-intensive; if middleware is ever misconfigured, this
  // prevents unauthenticated users from triggering git operations.
  const userId = await getCurrentUserId(request as unknown as Request)
  if (!userId) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const url = searchParams.get('url')

  if (!url) {
    return NextResponse.json(
      { success: false, error: 'Missing url parameter' },
      { status: 400 },
    )
  }

  if (!isValidGitUrl(url)) {
    return NextResponse.json(
      { success: false, error: 'Invalid Git repository URL' },
      { status: 400 },
    )
  }

  const hostname = extractHostname(url)
  if (hostname && !(await validateResolvedHostname(hostname))) {
    return NextResponse.json(
      { success: false, error: 'Invalid Git repository URL' },
      { status: 400 },
    )
  }

  // P3-3 FIX: Use crypto.randomUUID() for collision-safe temp directory names
  const workDir = join(tmpdir(), `git-branches-${crypto.randomUUID()}`)

  try {
    await mkdir(workDir, { recursive: true })
    const branches = await getRemoteBranches(url, workDir)

    return NextResponse.json({
      success: true,
      branches,
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'Failed to fetch branches' },
      { status: 500 },
    )
  } finally {
    // Cleanup
    try { await rm(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ─── POST Handler: Clone and read repo ──────────────────────────────────────

export async function POST(request: NextRequest) {
  // SECURITY FIX (M4): Defense-in-depth rate limiting at route level.
  const postClientIp = getSecureClientIp(request)
  const postRateResult = rateLimit.check(postClientIp, RATE_LIMIT_GIT_IMPORT)
  if (!postRateResult.success) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: getRateLimitHeaders(postRateResult) }
    )
  }

  // SECURITY FIX (SEC-105): Defense-in-depth auth check independent of middleware.
  const postUserId = await getCurrentUserId(request as unknown as Request)
  if (!postUserId) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // P1-FIX: Read body as text first with size limit to prevent memory exhaustion
    const bodyText = await request.text()
    if (Buffer.byteLength(bodyText, 'utf-8') > 10_000) {
      return NextResponse.json(
        { success: false, error: 'Request body too large' },
        { status: 413 },
      )
    }
    let body: { url?: string; branch?: string }
    try {
      body = JSON.parse(bodyText)
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON in request body' },
        { status: 400 },
      )
    }
    const { url, branch } = body

    // Validate URL
    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Repository URL is required' },
        { status: 400 },
      )
    }

    if (!isValidGitUrl(url)) {
      return NextResponse.json(
        { success: false, error: 'Invalid Git repository URL. Only HTTPS URLs from github.com, gitlab.com, or bitbucket.org are supported.' },
        { status: 400 },
      )
    }

    const postHostname = extractHostname(url)
    if (postHostname && !(await validateResolvedHostname(postHostname))) {
      return NextResponse.json(
        { success: false, error: 'Invalid Git repository URL' },
        { status: 400 },
      )
    }

    // Validate branch
    if (branch && typeof branch !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Branch must be a string' },
        { status: 400 },
      )
    }
    // SECURITY FIX (SEC-103): Validate branch name format to prevent unexpected
    // git behavior. While spawn() prevents shell injection, malicious branch names
    // could still cause git errors or resource consumption.
    if (branch) {
      if (branch.length > 200) {
        return NextResponse.json(
          { success: false, error: 'Branch name too long (max 200 characters)' },
          { status: 400 },
        )
      }
      // Only allow safe characters in branch names
      if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
        return NextResponse.json(
          { success: false, error: 'Branch name contains invalid characters' },
          { status: 400 },
        )
      }
      // Prevent branch names that look like git options
      if (branch.startsWith('-')) {
        return NextResponse.json(
          { success: false, error: 'Branch name cannot start with a dash' },
          { status: 400 },
        )
      }
    }

    // P3-3 FIX: Use crypto.randomUUID() for collision-safe temp directory names
    const randomId = crypto.randomUUID()
    const tempDir = join(tmpdir(), `git-import-${randomId}`)

    try {
      // Create temp directory
      await mkdir(tempDir, { recursive: true })

      // Build clone args (using spawn avoids shell injection)
      const cloneArgs = ['clone', '--depth', '1']
      if (branch) {
        cloneArgs.push('--branch', branch)
      }
      cloneArgs.push(url, join(tempDir, 'repo'))

      // Execute clone
      await runGit(cloneArgs, tempDir, CLONE_TIMEOUT)

      // Read files from cloned repo
      const repoDir = join(tempDir, 'repo')
      const { files, totalSize } = await readRepoFiles(repoDir)

      if (files.length === 0) {
        return NextResponse.json(
          { success: false, error: 'No readable files found in the repository' },
          { status: 422 },
        )
      }

      // Get branches
      const branches = await getRemoteBranches(url, tempDir)

      return NextResponse.json({
        success: true,
        files,
        branches,
        totalSize,
      })
    } finally {
      // Cleanup temp directory
      try { await rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'

    // Handle common git errors
    if (message.includes('Repository not found') || message.includes('does not appear to be a git repository')) {
      return NextResponse.json(
        { success: false, error: 'Repository not found. Please check the URL and ensure it is a public repository.' },
        { status: 404 },
      )
    }

    if (message.includes('fatal: remote error') || message.includes('could not read')) {
      return NextResponse.json(
        { success: false, error: 'Could not access the repository. It may be private or the URL may be incorrect.' },
        { status: 403 },
      )
    }

    if (message.includes('timed out') || message.includes('ETIMEDOUT') || message.includes('SIGTERM')) {
      return NextResponse.json(
        { success: false, error: 'Clone operation timed out. The repository may be too large or the network is slow.' },
        { status: 408 },
      )
    }

    if (message.includes('branch') && (message.includes('not found') || message.includes('did not match'))) {
      return NextResponse.json(
        { success: false, error: 'The specified branch was not found in the repository.' },
        { status: 422 },
      )
    }

    if (message.includes('Permission denied') || message.includes('could not read from remote repository') || message.includes('Host key verification failed')) {
      // SECURITY FIX (L-12): Generic error message — don't reveal SSH-specific details.
      return NextResponse.json(
        { success: false, error: 'Could not access the repository. It may be private or the URL may be incorrect.' },
        { status: 403 },
      )
    }

    if (message.includes('Total repository size exceeds')) {
      return NextResponse.json(
        { success: false, error: 'Repository is too large to import. Consider using a ZIP upload of just the bot source files.' },
        { status: 413 },
      )
    }

    // Generic error — don't leak internal server details (temp paths, error messages)
    return NextResponse.json(
      { success: false, error: 'Failed to clone repository. Please check the URL and try again.' },
      { status: 500 },
    )
  }
}
