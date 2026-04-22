import { spawn } from 'child_process'
import { NextRequest, NextResponse } from 'next/server'
import { readdir, stat, readFile, rm, mkdir } from 'fs/promises'
import { join } from 'path'

// ─── Configuration ──────────────────────────────────────────────────────────

const SKIP_PATTERNS = [
  'node_modules/', '.git/', 'package-lock.json', 'yarn.lock',
  '.DS_Store', 'Thumbs.db', 'bun.lockb',
]

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'webp',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'gz', 'tar', 'zip', 'bz2', 'xz', '7z', 'rar',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
  'exe', 'dll', 'so', 'dylib', 'bin',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'sqlite', 'db',
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
  // HTTPS URLs: https://github.com/user/repo, https://gitlab.com/user/repo
  const httpsPattern = /^https:\/\/[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+\/[^\s]+\.git\/?$/
  // HTTPS URLs without .git: https://github.com/user/repo
  const httpsShortPattern = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/
  // SSH URLs: git@github.com:user/repo.git
  const sshPattern = /^git@[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+:[^\s]+\.git$/

  // SSRF FIX (Enhanced): Block private/internal IP ranges and cloud metadata endpoints.
  // Prevents Server-Side Request Forgery by rejecting URLs that point to
  // internal network resources.
  //
  // Attack vectors mitigated:
  // - IPv4 private ranges: 10.x, 172.16-31.x, 192.168.x
  // - Loopback: 127.x.x.x, localhost
  // - Link-local: 169.254.x.x (AWS metadata)
  // - IPv6 loopback: [::1], [::ffff:127.0.0.1]
  // - Octal notation: 0177.0.0.1 (= 127.0.0.1)
  // - Hexadecimal notation: 0x7f.0.0.1 (= 127.0.0.1)
  // - Numeric-only hostnames (DNS rebinding risk)
  try {
    const httpsMatch = url.match(/^https:\/\/([^\/]+)/)
    if (httpsMatch) {
      const hostname = httpsMatch[1].toLowerCase().replace(/^\[(.*)\]$/, '$1') // Strip IPv6 brackets

      // Block known internal hostnames
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        return false
      }

      // Block cloud metadata endpoints
      if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
        return false
      }

      // Check for IPv6 addresses (contains colons, not a port)
      if (hostname.includes(':')) {
        // IPv6 loopback and link-local
        if (hostname === '::1' || hostname === '::ffff:127.0.0.1' || hostname.startsWith('fe80:') || hostname.startsWith('fc00:') || hostname.startsWith('fd00:')) {
          return false
        }
        // IPv6 mapped IPv4 ::ffff:x.x.x.x — extract and check the IPv4 part
        const v6MappedMatch = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
        if (v6MappedMatch && isPrivateIPv4(v6MappedMatch[1])) {
          return false
        }
      }

      // Check for IPv4 dotted-decimal
      const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)/)
      if (ipMatch) {
        if (isPrivateIPv4(hostname)) {
          return false
        }
      }

      // Block octal-looking IPs (e.g., 0177.0.0.1, 0000.0.0.0)
      if (/^0\d+\./.test(hostname)) {
        return false
      }

      // Block hex-looking IPs (e.g., 0x7f.0.0.1, 0x0.0.0.0)
      if (/^0x[\da-f]+\./i.test(hostname)) {
        return false
      }

      // Block numeric-only hostnames (potential DNS rebinding vectors)
      // Allow: github.com, gitlab.com, etc. (contains letters)
      // Block: 127.0.0.1.nip.io, 2130706433 (decimal IP), etc.
      if (/^[\d.]+$/.test(hostname) && !ipMatch) {
        return false
      }
    }
  } catch {
    return false
  }

  return httpsPattern.test(url) || httpsShortPattern.test(url) || sshPattern.test(url)
}

/** Check if an IPv4 address is in a private/reserved range */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true // Invalid = block
  const [a, b] = parts
  if (a === 10) return true                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true   // 172.16.0.0/12
  if (a === 192 && b === 168) return true           // 192.168.0.0/16
  if (a === 169 && b === 254) return true           // 169.254.0.0/16 (link-local)
  if (a === 127) return true                        // 127.0.0.0/8 (loopback)
  if (a === 0) return true                          // 0.0.0.0/8
  if (a >= 224) return true                         // Multicast + reserved
  return false
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
      console.warn(`[GitImport] Max directory depth (${MAX_DIR_DEPTH}) exceeded at ${baseName}, skipping`)
      return
    }

    const entries = await readdir(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      // P2-API-8 FIX: Check total file count limit
      if (files.length >= MAX_TOTAL_FILES) {
        console.warn(`[GitImport] Max file count (${MAX_TOTAL_FILES}) reached, skipping remaining files`)
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

  // P3-3 FIX: Use crypto.randomUUID() for collision-safe temp directory names
  const workDir = `/tmp/git-branches-${crypto.randomUUID()}`

  try {
    await mkdir(workDir, { recursive: true })
    const branches = await getRemoteBranches(url, workDir)

    return NextResponse.json({
      success: true,
      branches,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: `Failed to fetch branches: ${message}` },
      { status: 500 },
    )
  } finally {
    // Cleanup
    try { await rm(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ─── POST Handler: Clone and read repo ──────────────────────────────────────

export async function POST(request: NextRequest) {
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
        { success: false, error: 'Invalid Git repository URL. Supported formats: https://github.com/user/repo, https://gitlab.com/user/repo, git@github.com:user/repo.git' },
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

    // P3-3 FIX: Use crypto.randomUUID() for collision-safe temp directory names
    const randomId = crypto.randomUUID()
    const tempDir = `/tmp/git-import-${randomId}`

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

    // Generic error — don't leak internal server details (temp paths, error messages)
    return NextResponse.json(
      { success: false, error: 'Failed to clone repository. Please check the URL and try again.' },
      { status: 500 },
    )
  }
}
