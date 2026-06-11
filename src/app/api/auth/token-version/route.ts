import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { timingSafeCompare } from '@/lib/security-utils'
import { logger } from '@/lib/logger'

let _internalSecretChecked = false

// SECURITY FIX (L-3): Shannon entropy check for INTERNAL_API_SECRET.
// A secret with entropy < 3.0 bits/character is too predictable (e.g.,
// "abcdefghijklmnop" has low entropy despite passing length/repeating checks).
function shannonEntropy(str: string): number {
  const freq = new Map<string, number>()
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1)
  let entropy = 0
  const len = str.length
  for (const count of freq.values()) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function ensureInternalApiSecret(): void {
  if (_internalSecretChecked) return
  _internalSecretChecked = true
  if (!process.env.INTERNAL_API_SECRET && process.env.NODE_ENV === 'production') {
    logger.error('token-version', 'FATAL: INTERNAL_API_SECRET must be set (min 32 chars) in production.')
    process.exit(1)
  }
}

/**
 * Internal API endpoint for Edge Runtime to query tokenVersion.
 *
 * SECURITY: This endpoint is protected by a shared secret (INTERNAL_API_SECRET)
 * instead of a simple custom header. The middleware still requires authentication
 * for this route (it was removed from PUBLIC_ROUTES), providing defense-in-depth.
 *
 * The shared secret ensures that even if an attacker discovers this endpoint,
 * they cannot query arbitrary users' tokenVersion without knowing the secret.
 */
export async function POST(request: NextRequest) {
  ensureInternalApiSecret()
  // SECURITY FIX: Use shared secret instead of a trivially spoofable custom header.
  // The previous `X-Internal-Request: 1` header could be set by any external attacker.
  const internalSecret = process.env.INTERNAL_API_SECRET || ''
  const provided = request.headers.get('x-internal-secret') || ''

  // SECURITY FIX (SEC-79): Removed secret length from log message to prevent
  // information leakage that could aid brute-force attacks.
  if (!internalSecret || internalSecret.length < 32) {
    logger.error('token-version', 'INTERNAL_API_SECRET is not configured or too short (minimum 32 characters required)')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // SECURITY FIX (SEC-107): Reject low-entropy secrets (e.g., all same character).
  // A secret like "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" passes the length check but
  // is trivially guessable, allowing attackers to query tokenVersion for any user.
  if (/^(.)\1{31,}$/.test(internalSecret)) {
    logger.error('token-version', 'INTERNAL_API_SECRET is too weak (repeating characters). Use a cryptographically random secret.')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // SECURITY FIX (L-3): Reject secrets with Shannon entropy < 3.0.
  // Catches weak but non-repeating patterns like "abcdefghijklmnop".
  if (shannonEntropy(internalSecret) < 3.0) {
    logger.error('token-version', 'INTERNAL_API_SECRET has insufficient entropy. Use a cryptographically random secret.')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // SECURITY FIX (M1): Use shared timingSafeCompare instead of manual
  // constant-time comparison. The manual implementation had subtle issues
  // (padEnd is not constant-time) and duplicated logic that must be kept
  // in sync with security-utils.ts.
  if (!timingSafeCompare(provided, internalSecret)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let userId: string | null = null
  try {
    const body = await request.json()
    userId = body.userId ?? null
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
  }

  try {
    const account = await db.account.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    })
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ tokenVersion: account.tokenVersion })
  } catch {
    return NextResponse.json({ error: 'DB error' }, { status: 500 })
  }
}
