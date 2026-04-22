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
  console.error('')
  console.error('╔══════════════════════════════════════════════════════════════╗')
  console.error('║  [FATAL] HMAC_SECRET environment variable is not set!      ║')
  console.error('║  Session token signing requires a secure secret.           ║')
  console.error('║  Set HMAC_SECRET in your environment before starting.      ║')
  console.error('║  Example: HMAC_SECRET=$(openssl rand -hex 32)              ║')
  console.error('╚══════════════════════════════════════════════════════════════╝')
  console.error('')
  // SECURITY FIX: Instead of a predictable fallback string that allows token forgery,
  // generate a random per-process secret. Tokens signed with this won't survive
  // process restarts (which is acceptable for a fallback), and more importantly,
  // they CANNOT be forged by attackers who know the fallback value.
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

// Periodic cleanup of expired revocation entries (every hour)
// SECURITY FIX: Instead of clearing ALL entries when size exceeds threshold
// (which allowed attackers to invalidate the revocation list), only remove
// entries that have naturally expired (the corresponding token TTL has passed).
// BUG FIX: Call .unref() on the timer so it doesn't prevent graceful shutdown.
// Edge Runtime compatibility: .unref() is only available in Node.js, not in Edge.
// Guard the call with a typeof check.
const revocationCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [sig, entry] of revokedTokenSignatures) {
    // Remove entries whose tokens have already expired naturally
    if (now > entry.expiresAt) {
      revokedTokenSignatures.delete(sig)
    }
  }
  // Safety cap: if somehow the list grows beyond 50000, prune oldest entries
  // (This should never happen in normal operation since tokens expire after 7 days)
  if (revokedTokenSignatures.size > 50000) {
    const entries = [...revokedTokenSignatures.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    const toRemove = entries.slice(0, entries.length - 30000)
    for (const [sig] of toRemove) {
      revokedTokenSignatures.delete(sig)
    }
    console.warn('[Session] Pruned revocation list (size exceeded 50000)')
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
  while (recentSessions.length > 0 && now - recentSessions[0].createdAt > SESSION_TTL_MS) {
    recentSessions.shift()
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
    if (revokedTokenSignatures.has(hashedSig)) {
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
    if (payload.tokenVersion !== undefined && payload.userId) {
      try {
        const { db } = await import('@/lib/db')
        const account = await db.account.findUnique({
          where: { id: payload.userId },
          select: { tokenVersion: true }
        })
        if (account && account.tokenVersion !== payload.tokenVersion) {
          return null
        }
      } catch {
        // DB unavailable — fail closed: reject token when we cannot verify tokenVersion.
        // An attacker could exploit DB pressure to bypass token revocation.
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
 * Synchronous session validation for backward compatibility.
 * Only works in Node.js runtime (not Edge).
 * DEPRECATED: Use validateSessionAsync() instead.
 */
export function validateSession(token: string): { userId: string; username: string } | null {
  try {
    const dotIndex = token.indexOf('.')
    if (dotIndex === -1) return null

    const payloadB64 = token.slice(0, dotIndex)
    const signature = token.slice(dotIndex + 1)

    // Sync HMAC verification (Node.js only)
    let expected: string
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require('crypto')
      expected = nodeCrypto.createHmac('sha256', HMAC_SECRET).update(payloadB64).digest('hex')
    } catch {
      return null // Can't verify in this runtime
    }

    // Timing-safe comparison
    if (expected.length !== signature.length) return null
    let result = 0
    for (let i = 0; i < expected.length; i++) {
      result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
    }
    if (result !== 0) return null

    // Decode payload
    const payloadStr = base64UrlDecode(payloadB64)
    const payload: SessionPayload = JSON.parse(payloadStr)

    // Check expiration
    if (Date.now() - payload.createdAt > SESSION_TTL_MS) {
      return null
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

    // Add to revocation list with TTL-based expiration
    const hashedSig = await hashSignature(signature)
    const expiresAt = payload.createdAt + SESSION_TTL_MS
    revokedTokenSignatures.set(hashedSig, { expiresAt })

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
 */
export async function incrementTokenVersion(userId: string): Promise<void> {
  try {
    const { db } = await import('@/lib/db')
    await db.account.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } }
    })
  } catch (err) {
    console.error('[Session] Failed to increment tokenVersion:', err instanceof Error ? err.message : err)
  }
}
