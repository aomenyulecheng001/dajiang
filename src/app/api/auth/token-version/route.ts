import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'

let _internalSecretChecked = false
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

  // SECURITY: Constant-time comparison that does NOT leak length information.
  // Pad both strings to the same length before comparing, then check length
  // match as part of the final result.
  const maxLen = Math.max(internalSecret.length, provided.length)
  const paddedSecret = internalSecret.padEnd(maxLen, '\0')
  const paddedProvided = provided.padEnd(maxLen, '\0')

  let secretMatch = 0
  for (let i = 0; i < maxLen; i++) {
    secretMatch |= paddedSecret.charCodeAt(i) ^ paddedProvided.charCodeAt(i)
  }
  if (secretMatch !== 0 || internalSecret.length !== provided.length) {
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
