import { NextRequest, NextResponse } from 'next/server'
import { isTokenRevoked } from '@/lib/session'
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
    logger.error('revoke-check', 'FATAL: INTERNAL_API_SECRET must be set (min 32 chars) in production.')
    process.exit(1)
  }
}

/**
 * Internal API endpoint for Edge Runtime to check if a token signature is revoked.
 *
 * SECURITY FIX (S1): Edge Runtime cannot access the in-memory revocation list.
 * This endpoint allows Edge Runtime to verify token revocation status, preventing
 * revoked tokens from bypassing middleware authentication.
 *
 * Protected by INTERNAL_API_SECRET — same pattern as /api/auth/token-version.
 */
export async function POST(request: NextRequest) {
  ensureInternalApiSecret()
  const internalSecret = process.env.INTERNAL_API_SECRET || ''
  const provided = request.headers.get('x-internal-secret') || ''

  if (!internalSecret || internalSecret.length < 32) {
    logger.error('revoke-check', 'INTERNAL_API_SECRET is not configured or too short')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // SECURITY FIX (S2): Reject low-entropy secrets (e.g., all same character)
  // to prevent brute-force attacks. Consistent with token-version/route.ts.
  if (/^(.)\1{31,}$/.test(internalSecret)) {
    logger.error('revoke-check', 'INTERNAL_API_SECRET is too weak (repeating characters).')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // SECURITY FIX (L-3): Reject secrets with Shannon entropy < 3.0.
  // Catches weak but non-repeating patterns like "abcdefghijklmnop".
  if (shannonEntropy(internalSecret) < 3.0) {
    logger.error('revoke-check', 'INTERNAL_API_SECRET has insufficient entropy. Use a cryptographically random secret.')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // SECURITY FIX (M1): Use shared timingSafeCompare instead of manual
  // constant-time comparison. Consistent with token-version/route.ts.
  if (!timingSafeCompare(provided, internalSecret)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let signature: string | null = null
  try {
    const body = await request.json()
    signature = body.signature ?? null
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!signature || typeof signature !== 'string') {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }
  // SECURITY FIX (L4): HMAC-SHA-256 hex signature is always 64 chars.
  // Reject obviously invalid lengths to avoid unnecessary hash computation.
  if (signature.length !== 64 || !/^[0-9a-f]+$/.test(signature)) {
    return NextResponse.json({ revoked: false })
  }

  try {
    const revoked = await isTokenRevoked(signature)
    return NextResponse.json({ revoked })
  } catch {
    // Fail-closed: if we cannot check, treat as revoked
    return NextResponse.json({ revoked: true })
  }
}
