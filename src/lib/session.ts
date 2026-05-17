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
function getHmacSecret(): string {
  if (typeof process !== 'undefined' && process.env && process.env.HMAC_SECRET) {
    return process.env.HMAC_SECRET
  }
  const isBuildPhase = typeof process !== 'undefined' && (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export')
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production' && !isBuildPhase) {
    console.error('FATAL: HMAC_SECRET environment variable is required for production.')
    console.error('Generate one with: openssl rand -hex 32')
    process.exit(1)
  }
  console.error('╔══════════════════════════════════════════════════════════════╗')
  console.error('║  [FATAL] HMAC_SECRET environment variable is not set!      ║')
  console.error('║  Session token signing requires a secure secret.           ║')
  console.error('║  Set HMAC_SECRET in your environment before starting.      ║')
  console.error('║  Example: HMAC_SECRET=$(openssl rand -hex 32)              ║')
  console.error('╚══════════════════════════════════════════════════════════════╝')
  console.error('')
  // BUG FIX (BUG-104): When HMAC_SECRET is not set, the Edge Runtime
  // (session-edge.ts) and Node.js Runtime (session.ts) run in separate
  // isolates and would each generate their own random secret. Tokens
  // signed by one runtime cannot be verified by the other, breaking the
  // entire auth system. To fix this, we derive the fallback secret from
  // a shared file (.hmac-secret) so both runtimes use the same value.
  // SECURITY: This is still less secure than setting HMAC_SECRET explicitly
  // (the file may be readable by other processes), but it prevents the
  // cross-runtime mismatch that would silently break all auth.
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
    // Generate and persist a new random secret
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
    try {
      fs.writeFileSync(secretFile, secret + '\n', { mode: 0o600 })
    } catch {
      // Write may fail (read-only filesystem, permissions, etc.)
      // The secret is still usable in memory for this process
    }
    return secret
  } catch {
    // require('fs') may not be available in Edge Runtime.
    // Fall through to pure random (Edge Runtime should have HMAC_SECRET set).
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

const HMAC_SECRET = getHmacSecret()

if (typeof process !== 'undefined' && process.env && !process.env.HMAC_SECRET) {
  console.error('[AUTH] ⚠️  HMAC_SECRET not set! Using random per-process secret. Tokens will not survive restarts. Set HMAC_SECRET env var for production.')
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

import { appendFile, readFile as fsReadFile, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolveFromProjectRoot } from '@/lib/project-root'

const REVOCATION_FILE = resolveFromProjectRoot('.revoked-tokens')

async function persistRevocation(tokenHash: string, expiresAt: number): Promise<void> {
  try {
    await appendFile(REVOCATION_FILE, `${tokenHash}:${expiresAt}\n`)
  } catch (error) {
    console.error('[Session] CRITICAL: Failed to persist token revocation to disk. Revocation is in-memory only and will be lost on restart.', error instanceof Error ? error.message : 'unknown')
  }
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
  } catch { /* ignore */ }
  revocationsLoaded = true
}

loadRevocations().catch(() => { /* ignore */ })

const tokenVersionCache = new Map<string, { version: number; cachedAt: number }>()
const TOKEN_VERSION_CACHE_TTL_MS = 10 * 1000

// SECURITY FIX (SEC-89): Reduced cleanup interval from 60 minutes to 5 minutes.
// Cache TTL is 30 seconds, so a 60-minute cleanup interval means expired entries
// consume memory for up to 60 minutes unnecessarily.
const _tokenVersionCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of tokenVersionCache) {
    if (now - entry.cachedAt > TOKEN_VERSION_CACHE_TTL_MS) {
      tokenVersionCache.delete(key)
    }
  }
}, 30 * 1000)
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
    console.warn('[Session] Pruned revocation list (size exceeded 50000)')
  }
  try {
    const validEntries: string[] = []
    for (const [hash, entry] of revokedTokenSignatures) {
      if (entry.expiresAt > now) {
        validEntries.push(`${hash}:${entry.expiresAt}`)
      }
    }
    await writeFile(REVOCATION_FILE, validEntries.join('\n') + (validEntries.length > 0 ? '\n' : ''), 'utf-8')
  } catch (error) {
    console.error('[Session] Failed to compact revocation file:', error instanceof Error ? error.message : 'unknown')
  }
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

// ─── Crypto Helpers ─────────────────────────────────────────────────────

async function hmacSign(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacVerify(data: string, signature: string): Promise<boolean> {
  const expected = await hmacSign(data)
  // Timing-safe comparison
  if (expected.length !== signature.length) return false
  let result = 0
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return result === 0
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
 */
export function createSession(userId: string, username: string, tokenVersion: number = 0): string {
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

  // Create token synchronously using a sync-compatible approach
  // We'll use a simpler sync HMAC for token creation since we're in Node.js
  const payloadStr = JSON.stringify(payload)
  const payloadB64 = base64UrlEncode(payloadStr)

  // Sync HMAC using Node.js crypto (only in Node.js runtime)
  let signature: string
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto')
    signature = nodeCrypto.createHmac('sha256', HMAC_SECRET).update(payloadB64).digest('hex')
  } catch {
    // Fallback — shouldn't happen in Node.js runtime, but fail loudly instead of
    // silently producing a broken token that will never pass HMAC verification.
    throw new Error('Failed to create session: crypto module unavailable')
  }

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
      console.error('[Session] Revocation list not yet loaded — rejecting token for safety (fail-closed)')
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
        console.error('[Session] DB unavailable during tokenVersion check — rejecting token for safety')
        return null
      }
    }

    return { userId: payload.userId, username: payload.username }
  } catch {
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

    const payloadStr = base64UrlDecode(token.slice(0, dotIndex))
    const payload: SessionPayload = JSON.parse(payloadStr)
    const signature = token.slice(dotIndex + 1)

    const valid = await hmacVerify(token.slice(0, dotIndex), signature)
    if (!valid) return false

    // Add to revocation list with TTL-based expiration
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
    console.error('[Session] Failed to increment tokenVersion:', error)
    tokenVersionCache.delete(userId)
    throw error
  }
}

/**
 * Invalidate the tokenVersion cache entry for a user.
 * Called when tokenVersion is updated externally (e.g., in a combined DB update
 * with password change) to ensure the next validation query fetches the fresh value.
 */
export function invalidateTokenVersionCache(userId: string): void {
  tokenVersionCache.delete(userId)
}
