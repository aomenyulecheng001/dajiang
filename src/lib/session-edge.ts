/**
 * Edge-compatible session validation.
 * 
 * This module does NOT import db.ts (Prisma) to remain compatible with
 * Next.js Edge Runtime (which runs in a V8 isolate without Node.js APIs).
 * 
 * Used exclusively in middleware.ts for request authentication.
 */

import { safeUnref, logger } from '@/lib/logger'
import { generateHmacSecret, logMissingHmacSecret, isBuildPhase, hmacSignData, hmacVerifyData } from '@/lib/hmac-secret'

if (process.env.NODE_ENV === 'production' && (!process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL === 'http://localhost:3000')) {
  logger.error('session-edge', 'WARNING: NEXT_PUBLIC_APP_URL is not configured or set to localhost. Edge Runtime token validation may fail.')
  logger.error('session-edge', 'Set NEXT_PUBLIC_APP_URL to your actual application URL (e.g., "https://your-domain.com")')
}

// ─── Constants ──────────────────────────────────────────────────────────
function getHmacSecret(): string {
  if (typeof process !== 'undefined' && process.env?.HMAC_SECRET) {
    return process.env.HMAC_SECRET
  }
  if (isBuildPhase()) {
    return generateHmacSecret()
  }
  // SECURITY FIX (M1): Align Edge Runtime HMAC key loading with Node.js Runtime.
  // Previously, Edge Runtime would silently generate a random secret when
  // HMAC_SECRET was missing, while Node.js would process.exit(1) in production.
  // This could cause Edge and Node to use different keys, making all tokens
  // invalid in middleware. Now both runtimes follow the same logic.
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
    logMissingHmacSecret('edge')
    logger.error('session-edge', 'Generate HMAC secret with: openssl rand -hex 32')
    // Edge Runtime cannot call process.exit(), but we must not use a random key.
    // Return empty string — validateSessionEdge will reject all tokens,
    // which is fail-closed behavior.
    return ''
  }
  logMissingHmacSecret('edge')
  // Try .hmac-secret file for cross-runtime consistency
  // SECURITY FIX (M4): Use atomic file creation (O_EXCL via 'wx' flag) to
  // prevent race conditions when both Edge and Node.js runtimes start
  // simultaneously and both try to create the .hmac-secret file.
  // SECURITY FIX (L7): Use process.env.NEXT_RUNTIME check instead of
  // typeof require === 'function' for more reliable Edge Runtime detection.
  // typeof require can be truthy in some bundler configurations even in
  // Edge Runtime, leading to failed fs operations.
  try {
    const isEdgeRuntime = typeof process !== 'undefined' && (process as { env?: { NEXT_RUNTIME?: string } }).env?.NEXT_RUNTIME === 'edge'
    if (!isEdgeRuntime && typeof require === 'function') {
      const fs = require('fs') as typeof import('fs')
      const path = require('path') as typeof import('path')
      const secretFile = path.join(
        (process.env?.PROJECT_ROOT) || '/',
        '.hmac-secret',
      )
      if (fs.existsSync(secretFile)) {
        const existing = fs.readFileSync(secretFile, 'utf-8').trim()
        if (existing.length >= 32) {
          logger.info('session-edge', 'Loaded HMAC secret from .hmac-secret file')
          return existing
        }
      }
      // Generate and try to create the file atomically
      const secret = generateHmacSecret()
      try {
        const fd = fs.openSync(secretFile, 'wx', 0o600)
        fs.writeFileSync(fd, secret + '\n')
        fs.closeSync(fd)
        return secret
      } catch (e: unknown) {
        // EEXIST: another runtime created the file — read its content
        if (e instanceof Error && 'code' in e ? (e as NodeJS.ErrnoException).code === 'EEXIST' : false) {
          const existing = fs.readFileSync(secretFile, 'utf-8').trim()
          if (existing.length >= 32) {
            logger.info('session-edge', 'Loaded HMAC secret from .hmac-secret file (created by another runtime)')
            return existing
          }
        }
        // Other write errors — use in-memory secret
      }
      return secret
    }
  } catch {
    // Edge Runtime doesn't support require() — fall through
  }
  logger.error('session-edge', 'CRITICAL: No HMAC_SECRET available. Edge Runtime CANNOT validate tokens.')
  logger.error('session-edge', 'Set HMAC_SECRET env var or ensure .hmac-secret file exists.')
  logger.error('session-edge', 'All middleware auth checks will reject tokens until this is fixed.')
  return ''
}

const HMAC_SECRET = getHmacSecret()
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const tokenVersionEdgeCache = new Map<string, { version: number; cachedAt: number }>()
// SECURITY FIX (S4): Reduced Edge cache TTL from 10s to 3s to match Node.js
// tokenVersion cache TTL. This minimizes the window where a stale tokenVersion
// allows a revoked token to pass validation after password change.
const EDGE_CACHE_TTL_MS = 3 * 1000
const MAX_EDGE_CACHE_SIZE = 10000

// Cleanup interval runs every 15s for a 3s TTL cache.
// Entries are evicted after 3x TTL (9s) to allow brief grace periods.
const _edgeCacheCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of tokenVersionEdgeCache) {
    if (now - entry.cachedAt > EDGE_CACHE_TTL_MS * 3) {
      tokenVersionEdgeCache.delete(key)
    }
  }
}, 15 * 1000)
safeUnref(_edgeCacheCleanupInterval)

// SECURITY FIX (M2): Aligned SessionPayload type with session.ts.
// tokenVersion is required — old tokens without it are rejected by
// the validation logic (undefined !== number check).
interface SessionPayload {
  userId: string
  username: string
  createdAt: number
  tokenVersion: number
}

// ─── HMAC Verification (delegated to shared module) ──────────────────────
// DRY FIX (L1): hmacSign/hmacVerify are now in hmac-secret.ts to avoid
// duplication between session.ts and session-edge.ts.

async function hmacSign(data: string): Promise<string> {
  return hmacSignData(data, HMAC_SECRET)
}

async function hmacVerify(data: string, signature: string): Promise<boolean> {
  return hmacVerifyData(data, signature, HMAC_SECRET)
}

// ─── Base64URL ──────────────────────────────────────────────────────────
function base64UrlDecode(str: string): string {
  let padded = str.replace(/-/g, '+').replace(/_/g, '/')
  while (padded.length % 4) padded += '='
  return atob(padded)
}

// ─── Revocation Check via Internal API ──────────────────────────────────

// SECURITY FIX (S1): In-memory revocation cache to avoid making an HTTP call
// to /api/auth/revoke-check on every single request. Without this cache,
// each middleware-authenticated request triggers 2 internal HTTP calls
// (revoke-check + token-version), which can be exploited for DoS attacks
// that exhaust the Node.js HTTP connection pool and lock out all users.
const revokedSignatureCache = new Map<string, { revoked: boolean; cachedAt: number }>()
const REVOKE_CACHE_TTL_MS = 5 * 1000 // 5 seconds — balances freshness vs. load
const MAX_REVOKE_CACHE_SIZE = 10000

// SECURITY FIX (S-2): Track consecutive API failures to reduce grace period.
// After MAX_API_FAILURES_BEFORE_STRICT consecutive failures, the grace period
// drops to 0 (fail-closed) to prevent extended bypass windows during outages.
let _apiFailureCount = 0
const MAX_API_FAILURES_BEFORE_STRICT = 3

// Cleanup revoked signature cache periodically
const _revokeCacheCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of revokedSignatureCache) {
    if (now - entry.cachedAt > REVOKE_CACHE_TTL_MS * 3) {
      revokedSignatureCache.delete(key)
    }
  }
}, 30 * 1000)
safeUnref(_revokeCacheCleanupInterval)

/**
 * Check if a token signature has been revoked by calling the internal API.
 * Uses an in-memory cache to avoid HTTP calls on every request.
 * SECURITY FIX (S1): Previously, every request made an HTTP call to
 * /api/auth/revoke-check, which could be exploited for DoS attacks.
 */
async function isTokenRevokedEdge(signature: string): Promise<boolean> {
  const now = Date.now()
  const cached = revokedSignatureCache.get(signature)
  if (cached && now - cached.cachedAt < REVOKE_CACHE_TTL_MS) {
    return cached.revoked
  }

  try {
    const baseUrl = typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_APP_URL
      ? process.env.NEXT_PUBLIC_APP_URL
      : 'http://localhost:3000'
    const internalSecret = typeof process !== 'undefined' && process.env?.INTERNAL_API_SECRET
      ? process.env.INTERNAL_API_SECRET
      : ''
    const res = await fetch(`${baseUrl}/api/auth/revoke-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret,
      },
      body: JSON.stringify({ signature }),
      signal: AbortSignal.timeout(2000),
    })
    if (res.ok) {
      const data = await res.json()
      const revoked = data.revoked === true
      // SECURITY FIX (S-2): Reset API failure count on successful response
      _apiFailureCount = 0
      // Update cache
      if (revokedSignatureCache.size >= MAX_REVOKE_CACHE_SIZE) {
        let oldestKey: string | null = null
        let oldestTime = Infinity
        for (const [k, v] of revokedSignatureCache) {
          if (v.cachedAt < oldestTime) { oldestTime = v.cachedAt; oldestKey = k }
        }
        if (oldestKey) revokedSignatureCache.delete(oldestKey)
      }
      revokedSignatureCache.set(signature, { revoked, cachedAt: now })
      return revoked
    }
    // Fail-closed: if API returns non-200, treat as revoked
    return true
  } catch {
    // SECURITY FIX (S-2): Adaptive grace period based on consecutive API failures.
    // Increment failure counter and calculate grace period dynamically.
    _apiFailureCount++
    const gracePeriodMs = _apiFailureCount >= MAX_API_FAILURES_BEFORE_STRICT ? 0 : 5000
    // If we have a recent cache entry showing not-revoked, allow a brief grace period
    // to avoid locking out all users when the internal API is temporarily unreachable.
    if (cached && !cached.revoked && gracePeriodMs > 0 && now - cached.cachedAt < gracePeriodMs) {
      return false // Grace period based on last known-good state
    }
    // Fail-closed: no prior evidence that the token is valid
    logger.error('session-edge', 'Cannot check token revocation — treating as revoked for safety')
    return true
  }
}

// ─── Session Validation ─────────────────────────────────────────────────
export async function validateSessionEdge(token: string): Promise<{ userId: string; username: string } | null> {
  try {
    if (!HMAC_SECRET) {
      logger.error('session-edge', 'No HMAC secret — cannot validate any tokens')
      return null
    }

    const dotIndex = token.indexOf('.')
    if (dotIndex === -1) return null

    const payloadB64 = token.slice(0, dotIndex)
    const signature = token.slice(dotIndex + 1)

    const valid = await hmacVerify(payloadB64, signature)
    if (!valid) return null

    // SECURITY FIX (S1): Check revocation list via internal API.
    // Previously, Edge Runtime had no revocation check, allowing revoked tokens
    // (e.g., after logout) to pass middleware authentication.
    const isRevoked = await isTokenRevokedEdge(signature)
    if (isRevoked) return null

    const payloadStr = base64UrlDecode(payloadB64)
    const payload: SessionPayload = JSON.parse(payloadStr)

    if (Date.now() - payload.createdAt > SESSION_TTL_MS) {
      return null
    }

    if (payload.userId) {
      const now = Date.now()
      const cached = tokenVersionEdgeCache.get(payload.userId)
      let dbVersion: number | undefined

      // Only trust the cache if the token was created BEFORE the cache entry.
      // A token created after the cache was populated (e.g., a new session
      // issued on password/username change) must be validated against the
      // current DB state, because the cached tokenVersion may be stale.
      if (cached && now - cached.cachedAt < EDGE_CACHE_TTL_MS && payload.createdAt <= cached.cachedAt) {
        dbVersion = cached.version
      } else {
        try {
          const baseUrl = typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_APP_URL
            ? process.env.NEXT_PUBLIC_APP_URL
            : 'http://localhost:3000'
          const internalSecret = typeof process !== 'undefined' && process.env?.INTERNAL_API_SECRET
            ? process.env.INTERNAL_API_SECRET
            : ''
          const res = await fetch(`${baseUrl}/api/auth/token-version`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Secret': internalSecret,
            },
            body: JSON.stringify({ userId: payload.userId }),
            signal: AbortSignal.timeout(3000),
          })
          if (res.ok) {
            const data = await res.json()
            if (typeof data.tokenVersion === 'number') {
              dbVersion = data.tokenVersion as number
              if (tokenVersionEdgeCache.size >= MAX_EDGE_CACHE_SIZE) {
                let oldestKey: string | null = null
                let oldestTime = Infinity
                for (const [k, v] of tokenVersionEdgeCache) {
                  if (v.cachedAt < oldestTime) {
                    oldestTime = v.cachedAt
                    oldestKey = k
                  }
                }
                if (oldestKey) tokenVersionEdgeCache.delete(oldestKey)
              }
              tokenVersionEdgeCache.set(payload.userId, { version: dbVersion, cachedAt: now })
            }
          }
        } catch {
          // SECURITY FIX: Fail-closed — if we cannot verify tokenVersion, reject the token.
          // This prevents revoked tokens (e.g., after password change) from being accepted
          // when the token-version API is unreachable.
          logger.error('session-edge', 'Cannot verify tokenVersion — rejecting token for safety')
          return null
        }
      }

      // SECURITY FIX: If dbVersion is still undefined (API returned non-200), reject.
      // Previously this condition was `dbVersion !== undefined && dbVersion !== payload.tokenVersion`
      // which meant an unreachable API would skip the check entirely (fail-open).
      if (payload.tokenVersion === undefined || dbVersion === undefined || dbVersion !== payload.tokenVersion) {
        return null
      }
    }

    return { userId: payload.userId, username: payload.username }
  } catch {
    return null
  }
}
