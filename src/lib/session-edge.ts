/**
 * Edge-compatible session validation.
 * 
 * This module does NOT import db.ts (Prisma) to remain compatible with
 * Next.js Edge Runtime (which runs in a V8 isolate without Node.js APIs).
 * 
 * Used exclusively in middleware.ts for request authentication.
 */

if (process.env.NODE_ENV === 'production' && (!process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL === 'http://localhost:3000')) {
  console.error('WARNING: NEXT_PUBLIC_APP_URL is not configured or set to localhost. Edge Runtime token validation may fail.')
  console.error('Set NEXT_PUBLIC_APP_URL to your actual application URL (e.g., "https://your-domain.com")')
}

// ─── Constants ──────────────────────────────────────────────────────────
function getHmacSecret(): string {
  if (typeof process !== 'undefined' && process.env && process.env.HMAC_SECRET) {
    return process.env.HMAC_SECRET
  }
  console.error('[session-edge] FATAL: HMAC_SECRET environment variable is not set!')
  console.error('[session-edge] Using random per-process secret. Tokens will not survive restarts.')
  // BUG FIX (BUG-104): Same fix as session.ts — try to read the shared
  // .hmac-secret file so both Edge and Node.js runtimes use the same key.
  // Edge Runtime cannot use require('fs'), but it CAN use fetch() to read
  // the file via the internal API. However, since getHmacSecret() is called
  // at module load time (synchronously), we cannot use async fetch here.
  // Instead, we rely on the Node.js runtime (session.ts) to have already
  // created the .hmac-secret file, and we try to read it synchronously.
  // In practice, Edge Runtime middleware should always have HMAC_SECRET set.
  try {
    // In some Edge Runtime environments, Node.js APIs are partially available
    if (typeof require === 'function') {
      const fs = require('fs') as typeof import('fs')
      const path = require('path') as typeof import('path')
      const secretFile = path.join(
        (typeof process !== 'undefined' && process.env && process.env.PROJECT_ROOT) || '/',
        '.hmac-secret'
      )
      if (fs.existsSync(secretFile)) {
        const existing = fs.readFileSync(secretFile, 'utf-8').trim()
        if (existing.length >= 32) return existing
      }
    }
  } catch {
    // Edge Runtime doesn't support require() — fall through to random
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

const HMAC_SECRET = getHmacSecret()
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const tokenVersionEdgeCache = new Map<string, { version: number; cachedAt: number }>()
const EDGE_CACHE_TTL_MS = 30 * 1000
const MAX_EDGE_CACHE_SIZE = 10000

// SECURITY FIX (SEC-89): Reduced cleanup interval from 60 minutes to 5 minutes.
const _edgeCacheCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of tokenVersionEdgeCache) {
    if (now - entry.cachedAt > EDGE_CACHE_TTL_MS) {
      tokenVersionEdgeCache.delete(key)
    }
  }
}, 5 * 60 * 1000)
if (typeof (_edgeCacheCleanupInterval as ReturnType<typeof setInterval> & { unref?: () => void }).unref === 'function') {
  (_edgeCacheCleanupInterval as ReturnType<typeof setInterval> & { unref: () => void }).unref()
}

interface SessionPayload {
  userId: string
  username: string
  createdAt: number
  tokenVersion?: number
}

// ─── HMAC Verification ──────────────────────────────────────────────────
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
  if (expected.length !== signature.length) return false
  let result = 0
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return result === 0
}

// ─── Base64URL ──────────────────────────────────────────────────────────
function base64UrlDecode(str: string): string {
  let padded = str.replace(/-/g, '+').replace(/_/g, '/')
  while (padded.length % 4) padded += '='
  return atob(padded)
}

// ─── Session Validation ─────────────────────────────────────────────────
export async function validateSessionEdge(token: string): Promise<{ userId: string; username: string } | null> {
  try {
    const dotIndex = token.indexOf('.')
    if (dotIndex === -1) return null

    const payloadB64 = token.slice(0, dotIndex)
    const signature = token.slice(dotIndex + 1)

    const valid = await hmacVerify(payloadB64, signature)
    if (!valid) return null

    const payloadStr = base64UrlDecode(payloadB64)
    const payload: SessionPayload = JSON.parse(payloadStr)

    if (Date.now() - payload.createdAt > SESSION_TTL_MS) {
      return null
    }

    if (payload.userId) {
      const now = Date.now()
      const cached = tokenVersionEdgeCache.get(payload.userId)
      let dbVersion: number | undefined

      if (cached && now - cached.cachedAt < EDGE_CACHE_TTL_MS) {
        dbVersion = cached.version
      } else {
        try {
          const baseUrl = typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_APP_URL
            ? process.env.NEXT_PUBLIC_APP_URL
            : 'http://localhost:3000'
          const internalSecret = typeof process !== 'undefined' && process.env?.INTERNAL_API_SECRET
            ? process.env.INTERNAL_API_SECRET
            : ''
          const res = await fetch(`${baseUrl}/api/auth/token-version?userId=${encodeURIComponent(payload.userId)}`, {
            headers: { 'X-Internal-Secret': internalSecret },
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
          console.error('[session-edge] Cannot verify tokenVersion — rejecting token for safety')
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
