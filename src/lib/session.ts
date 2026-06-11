/**
 * Session Store — Stateless HMAC-signed tokens
 *
 * In Next.js 16, middleware runs in the Edge Runtime while API route handlers
 * run in the Node.js runtime. They don't share in-memory state, and Edge
 * Runtime doesn't support Node.js APIs like `fs` or `process.cwd()`.
 *
 * This module uses stateless HMAC-signed tokens that both runtimes can
 * verify using the Web Crypto API (`crypto.subtle`), which is available
 * in both Edge and Node.js runtimes.
 *
 * Token format: base64url(JSON({userId, username, createdAt})) + "." + hex(hmac)
 */

// ─── Configuration ──────────────────────────────────────────────────────

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const MAX_SESSIONS_PER_USER = 5
const MAX_TOTAL_SESSIONS = 1000

/**
 * HMAC secret — shared between Edge and Node.js runtimes.
 * In production, this should be loaded from an environment variable.
 * For single-instance dev/demo, a fixed secret is acceptable.
 */
import { generateHmacSecret, logMissingHmacSecret, isBuildPhase, hmacSignData, hmacVerifyData } from '@/lib/hmac-secret'
import { logger } from '@/lib/logger'

// ...

function getHmacSecret(): string {
  if (typeof process !== 'undefined' && process.env && process.env.HMAC_SECRET) {
    return process.env.HMAC_SECRET
  }
  if (isBuildPhase()) {
    // During build, a placeholder is fine — no tokens are validated
    return generateHmacSecret()
  }
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production') {
    logMissingHmacSecret('node')
    logger.error('session', 'Generate HMAC secret with: openssl rand -hex 32')
    process.exit(1)
  }
  logMissingHmacSecret('node')
  // BUG FIX (BUG-104): When HMAC_SECRET is not set, derive fallback from
  // .hmac-secret file so both Node.js and Edge runtimes share the same secret.
  // SECURITY FIX (M4): Use atomic file creation (O_EXCL via 'wx' flag) to
  // prevent race conditions when both Edge and Node.js runtimes start
  // simultaneously and both try to create the .hmac-secret file.
  try {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const secretFile = path.join(
      process.env.PROJECT_ROOT || process.cwd(),
      '.hmac-secret'
    )
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf-8').trim()
      if (existing.length >= 32) return existing
    }
    const secret = generateHmacSecret()
    try {
      // O_EXCL: fails if file already exists, preventing race condition
      const fd = fs.openSync(secretFile, 'wx', 0o600)
      fs.writeFileSync(fd, secret + '\n')
      fs.closeSync(fd)
      return secret
    } catch (e: unknown) {
      // EEXIST: another runtime created the file — read its content
      if (e instanceof Error && 'code' in e ? (e as NodeJS.ErrnoException).code === 'EEXIST' : false) {
        const existing = fs.readFileSync(secretFile, 'utf-8').trim()
        if (existing.length >= 32) return existing
      }
      // Other write errors — secret is still usable in memory
    }
    return secret
  } catch {
    // require('fs') may not be available in Edge Runtime
  }
  return generateHmacSecret()
}

const HMAC_SECRET = getHmacSecret()

if (typeof process !== 'undefined' && process.env && !process.env.HMAC_SECRET) {
  logger.error('session', 'HMAC_SECRET not set! Using random per-process secret. Tokens will not survive restarts. Set HMAC_SECRET env var for production.')
}

// ─── In-memory rate limiting for createSession (Node.js only) ───────────
// Prevent session creation abuse even with stateless tokens

const recentSessions: { userId: string; createdAt: number }[] = []

/**
 * Revocation entries with expiration time for TTL-based eviction.
 * Replaces the previous plain Set to prevent mass-clear attacks.
 */
interface RevocationEntry {
  expiresAt: number // When the token itself expires (SESSION_TTL_MS after creation)
}

const revokedTokenSignatures = new Map<string, RevocationEntry>()

let revocationsLoaded = false

import { appendFile, readFile as fsReadFile, mkdir, writeFile, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { resolveFromProjectRoot } from '@/lib/project-root'

const REVOCATION_FILE = resolveFromProjectRoot('.revoked-tokens')

// SECURITY FIX (M2): Write queue to serialize file operations on .revoked-tokens.
// Previously, concurrent logout requests could cause appendFile/writeFile races,
// potentially losing revocation records. This queue ensures all file writes
// happen sequentially.
let _fileWriteQueue: Promise<void> = Promise.resolve()

async function persistRevocation(tokenHash: string, expiresAt: number): Promise<void> {
  _fileWriteQueue = _fileWriteQueue.then(async () => {
    try {
      await appendFile(REVOCATION_FILE, `${tokenHash}:${expiresAt}\n`)
    } catch (error) {
      // SECURITY FIX (L-4): Retry once after 100ms on failure to handle transient
      // disk errors (e.g., temporary ENOSPC, EBUSY on Windows).
      try {
        await new Promise(resolve => setTimeout(resolve, 100))
        await appendFile(REVOCATION_FILE, `${tokenHash}:${expiresAt}\n`)
      } catch (retryError) {
        logger.error('session', 'CRITICAL: Failed to persist token revocation to disk after retry. Revocation is in-memory only and will be lost on restart.', retryError instanceof Error ? retryError.message : 'unknown')
      }
    }
  })
  await _fileWriteQueue
}

async function loadRevocations(): Promise<void> {
  try {
    if (!existsSync(REVOCATION_FILE)) { revocationsLoaded = true; return }
    const content = await fsReadFile(REVOCATION_FILE, 'utf-8')
    const now = Date.now()
    const lines = content.split('\n').filter(Boolean)
    for (const line of lines) {
      const [hash, expires] = line.split(':')
      if (hash && Number(expires) > now) {
        revokedTokenSignatures.set(hash, { expiresAt: Number(expires) })
      }
    }
    // BUG FIX: Only set revocationsLoaded=true on successful read.
    // Previously, catch also set this flag, meaning a failed file read
    // would allow revoked tokens to bypass the in-memory revocation check.
    revocationsLoaded = true
  } catch (error) {
    // SECURITY: If we cannot load the revocation list, do NOT set revocationsLoaded=true.
    // This causes validateSessionAsync to reject all tokens (fail-closed) until
    // the file can be read. This is safer than silently accepting revoked tokens.
    logger.error('session', 'CRITICAL: Failed to load revocation list — all tokens will be rejected until this is resolved.', error instanceof Error ? error.message : 'unknown')
    // Do NOT set revocationsLoaded = true here
  }
}

loadRevocations().catch((error) => {
  // SECURITY FIX (M2): Log top-level failure instead of silently swallowing.
  // The inner catch already handles fail-closed semantics (not setting revocationsLoaded=true),
  // but if anything unexpected escapes the inner catch, we need visibility.
  logger.error('session', 'CRITICAL: loadRevocations() top-level failure', error instanceof Error ? error.message : String(error))
})

const tokenVersionCache = new Map<string, { version: number; cachedAt: number }>()
// SECURITY FIX (S4): Reduced cache TTL from 10s to 3s to minimize the window
// where a stale tokenVersion allows a revoked token to pass Edge Runtime
// validation after password change. The trade-off is slightly more DB queries
// (at most 1 per user per 3s), which is acceptable for a single-admin system.
const TOKEN_VERSION_CACHE_TTL_MS = 3 * 1000

// M10 FIXED: Cleanup interval 10s matches 3s TTL (3.3× TTL).
// Entries older than TTL are removed promptly to prevent memory accumulation
// during high-frequency token validation (the single-admin system rarely exceeds
// a few entries, but the cleanup is defensive against cache key collisions).
const _tokenVersionCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of tokenVersionCache) {
    if (now - entry.cachedAt > TOKEN_VERSION_CACHE_TTL_MS) {
      tokenVersionCache.delete(key)
    }
  }
}, 10 * 1000)
if (typeof (_tokenVersionCleanupInterval as ReturnType<typeof setInterval> & { unref?: () => void }).unref === 'function') {
  (_tokenVersionCleanupInterval as ReturnType<typeof setInterval> & { unref: () => void }).unref()
}

// Periodic cleanup of expired revocation entries (every hour)
// SECURITY FIX: Instead of clearing ALL entries when size exceeds threshold
// (which allowed attackers to invalidate the revocation list), only remove
// entries that have naturally expired (the corresponding token TTL has passed).
// BUG FIX: Call .unref() on the timer so it doesn't prevent graceful shutdown.
// Edge Runtime compatibility: .unref() is only available in Node.js, not in Edge.
// Guard the call with a typeof check.
const revocationCleanupInterval = setInterval(async () => {
  const now = Date.now()
  for (const [sig, entry] of revokedTokenSignatures) {
    if (now > entry.expiresAt) {
      revokedTokenSignatures.delete(sig)
    }
  }
  // Safety cap: if somehow the list grows beyond 50000, prune oldest entries
  if (revokedTokenSignatures.size > 50000) {
    const entries = [...revokedTokenSignatures.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    const toRemove = entries.slice(0, entries.length - 30000)
    for (const [sig] of toRemove) {
      revokedTokenSignatures.delete(sig)
    }
    logger.warn('session', 'Pruned revocation list (size exceeded 50000)')
  }
  // SECURITY FIX (M2): Use write queue for compaction to avoid race with
  // concurrent persistRevocation appendFile calls.
  _fileWriteQueue = _fileWriteQueue.then(async () => {
    try {
      const validEntries: string[] = []
      for (const [hash, entry] of revokedTokenSignatures) {
        if (entry.expiresAt > now) {
          validEntries.push(`${hash}:${entry.expiresAt}`)
        }
      }
      // SECURITY FIX (L-10): Write-then-rename pattern for atomic compaction.
      // Write to a .tmp file first, then rename to the actual file.
      // Rename is atomic on most filesystems, preventing partial/corrupt writes.
      const tmpFile = REVOCATION_FILE + '.tmp'
      await writeFile(tmpFile, validEntries.join('\n') + (validEntries.length > 0 ? '\n' : ''), 'utf-8')
      await rename(tmpFile, REVOCATION_FILE)
    } catch (error) {
      logger.error('session', 'Failed to compact revocation file.', error instanceof Error ? error.message : 'unknown')
    }
  })
}, 60 * 60 * 1000)
// Only call .unref() in Node.js runtime (not available in Edge Runtime)
if (typeof (revocationCleanupInterval as ReturnType<typeof setInterval> & { unref?: () => void }).unref === 'function') {
  (revocationCleanupInterval as ReturnType<typeof setInterval> & { unref: () => void }).unref()
}

/** Hash a token signature for storage in the revocation set.
 *  SECURITY FIX: Use Web Crypto API (crypto.subtle) which works identically
 *  in both Edge and Node.js runtimes, fixing the revocation bypass where
 *  Edge Runtime fell back to storing raw signatures while Node.js stored SHA-256 hashes.
 */
async function hashSignature(sig: string): Promise<string> {
  const data = new TextEncoder().encode(sig)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Crypto Helpers (delegated to shared module) ────────────────────────
// DRY FIX (L1): hmacSign/hmacVerify are now in hmac-secret.ts to avoid
// duplication between session.ts and session-edge.ts.

async function hmacSign(data: string): Promise<string> {
  return hmacSignData(data, HMAC_SECRET)
}

async function hmacVerify(data: string, signature: string): Promise<boolean> {
  return hmacVerifyData(data, signature, HMAC_SECRET)
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): string {
  let padded = str.replace(/-/g, '+').replace(/_/g, '/')
  while (padded.length % 4) padded += '='
  return atob(padded)
}

// ─── Session Interface ──────────────────────────────────────────────────

interface SessionPayload {
  userId: string
  username: string
  createdAt: number
  tokenVersion: number
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Create a new session and return the HMAC-signed token.
 * Only called from Node.js runtime (API route handlers).
 *
 * SECURITY FIX (M4): Changed from sync to async to use crypto.subtle (Web Crypto API),
 * ensuring the HMAC signing implementation is identical to hmacVerify() used in
 * both Node.js and Edge runtimes. Previously, createSession used Node.js crypto.createHmac
 * while validation used crypto.subtle — though both produce identical HMAC-SHA-256 output,
 * maintaining a single implementation reduces the risk of future divergence.
 */
export async function createSession(userId: string, username: string, tokenVersion: number = 0): Promise<string> {
  // Clean up old entries from recentSessions
  const now = Date.now()
  const cutoff = now - SESSION_TTL_MS
  let startIdx = 0
  while (startIdx < recentSessions.length && recentSessions[startIdx].createdAt < cutoff) {
    startIdx++
  }
  if (startIdx > 0) {
    recentSessions.splice(0, startIdx)
  }

  // Enforce per-user session limit
  const userSessions = recentSessions.filter(s => s.userId === userId)
  if (userSessions.length >= MAX_SESSIONS_PER_USER) {
    // Remove oldest entries for this user
    const toRemove = userSessions
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, userSessions.length - MAX_SESSIONS_PER_USER + 1)
    for (const entry of toRemove) {
      const idx = recentSessions.indexOf(entry)
      if (idx !== -1) recentSessions.splice(idx, 1)
    }
  }

  // Global cap
  if (recentSessions.length >= MAX_TOTAL_SESSIONS) {
    recentSessions.splice(0, Math.floor(MAX_TOTAL_SESSIONS * 0.1))
  }

  const payload: SessionPayload = { userId, username, createdAt: now, tokenVersion }
  recentSessions.push(payload)

  const payloadStr = JSON.stringify(payload)
  const payloadB64 = base64UrlEncode(payloadStr)

  // Use the same hmacSign function as validation for consistency
  const signature = await hmacSign(payloadB64)

  return `${payloadB64}.${signature}`
}

/**
 * Validate a session token and return session data if valid.
 * Edge Runtime compatible — used by middleware.
 * This is async because crypto.subtle is async in Edge Runtime.
 */
export async function validateSessionAsync(token: string): Promise<{ userId: string; username: string } | null> {
  try {
    const dotIndex = token.indexOf('.')
    if (dotIndex === -1) return null

    const payloadB64 = token.slice(0, dotIndex)
    const signature = token.slice(dotIndex + 1)

    // Verify HMAC signature
    const valid = await hmacVerify(payloadB64, signature)
    if (!valid) return null

    // Check revocation list (in-memory for immediate revocation)
    // SECURITY FIX: hashSignature now uses Web Crypto API (consistent across Edge/Node)
    const hashedSig = await hashSignature(signature)
    if (revocationsLoaded && revokedTokenSignatures.has(hashedSig)) {
      return null
    }
    if (!revocationsLoaded) {
      logger.error('session', 'Revocation list not yet loaded — rejecting token for safety (fail-closed)')
      return null
    }

    // Decode payload
    const payloadStr = base64UrlDecode(payloadB64)
    const payload: SessionPayload = JSON.parse(payloadStr)

    // Check expiration
    if (Date.now() - payload.createdAt > SESSION_TTL_MS) {
      return null
    }

    // PERSISTENT REVOCATION CHECK: Verify tokenVersion against database.
    // When password is changed, tokenVersion is incremented in the Account table.
    // Any token created before the increment will have an outdated tokenVersion
    // and will be rejected — even after server restart (unlike in-memory Map).
    if (payload.userId) {
      try {
        const now = Date.now()
        const cached = tokenVersionCache.get(payload.userId)
        let dbVersion: number | undefined

        if (cached && now - cached.cachedAt < TOKEN_VERSION_CACHE_TTL_MS) {
          dbVersion = cached.version
        } else {
          const { db } = await import('@/lib/db')
          const account = await db.account.findUnique({
            where: { id: payload.userId },
            select: { tokenVersion: true }
          })
          if (!account) return null
          dbVersion = account.tokenVersion
          tokenVersionCache.set(payload.userId, { version: dbVersion, cachedAt: now })
        }

        if (payload.tokenVersion === undefined || dbVersion !== payload.tokenVersion) {
          return null
        }
      } catch {
        logger.error('session', 'DB unavailable during tokenVersion check — rejecting token for safety')
        return null
      }
    }

    return { userId: payload.userId, username: payload.username }
  } catch (e) {
    // L11 FIXED: Distinguish between expected failures (JSON parse, invalid format)
    // and unexpected errors (OOM, crypto failures). JSON parse errors are normal
    // for malformed tokens; other errors indicate a system problem worth logging.
    if (e instanceof SyntaxError) {
      // Malformed payload — expected for invalid tokens
    } else {
      logger.error('session', 'Unexpected error in validateSessionAsync', e instanceof Error ? e.message : String(e))
    }
    return null
  }
}

/**
 * Delete a session token (logout).
 * SECURITY FIX: Now async because hashSignature uses Web Crypto API
 * for consistent hashing across Edge and Node.js runtimes.
 */
export async function deleteSession(token: string): Promise<boolean> {
  try {
    const dotIndex = token.indexOf('.')
    if (dotIndex === -1) return false

    const signature = token.slice(dotIndex + 1)
    const valid = await hmacVerify(token.slice(0, dotIndex), signature)
    if (!valid) return false

    const payloadStr = base64UrlDecode(token.slice(0, dotIndex))
    const payload: SessionPayload = JSON.parse(payloadStr)

    const hashedSig = await hashSignature(signature)
    const expiresAt = payload.createdAt + SESSION_TTL_MS
    revokedTokenSignatures.set(hashedSig, { expiresAt })
    await persistRevocation(hashedSig, expiresAt)

    // Remove from recentSessions
    const idx = recentSessions.findIndex(
      s => s.userId === payload.userId && s.createdAt === payload.createdAt
    )
    if (idx !== -1) {
      recentSessions.splice(idx, 1)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Increment the tokenVersion for an account, invalidating all existing tokens.
 * This is persistent (stored in DB) and survives server restarts.
 * Called when: password is changed, account security action is taken.
 *
 * SECURITY FIX (SEC-22): No longer silently swallows errors. If the DB update
 * fails, the error propagates to the caller so it can handle the failure
 * appropriately (e.g., roll back the password change). Previously, a silent
 * failure meant old session tokens from other devices remained valid after a
 * password change, violating the user's security expectation.
 */
export async function incrementTokenVersion(userId: string): Promise<number> {
  tokenVersionCache.delete(userId)
  try {
    const { db } = await import('@/lib/db')
    const result = await db.account.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    })
    tokenVersionCache.set(userId, { version: result.tokenVersion, cachedAt: Date.now() })
    return result.tokenVersion
  } catch (error) {
    logger.error('session', 'Failed to increment tokenVersion.', error instanceof Error ? error.message : String(error))
    tokenVersionCache.delete(userId)
    throw error
  }
}

/**
 * Check if a token signature has been revoked.
 * Used by the internal revoke-check API endpoint for Edge Runtime.
 * SECURITY FIX (S1): Previously, Edge Runtime had no way to check the
 * revocation list, allowing revoked tokens to bypass middleware auth.
 */
export async function isTokenRevoked(signature: string): Promise<boolean> {
  if (!revocationsLoaded) return true // fail-closed
  const hashedSig = await hashSignature(signature)
  return revokedTokenSignatures.has(hashedSig)
}

/**
 * Invalidate the tokenVersion cache entry for a user.
 * Called when tokenVersion is updated externally (e.g., in a combined DB update
 * with password change) to ensure the next validation query fetches the fresh value.
 */
export function invalidateTokenVersionCache(userId: string): void {
  tokenVersionCache.delete(userId)
}
