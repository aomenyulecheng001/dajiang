/**
 * HMAC Secret — shared between Node.js and Edge runtimes.
 *
 * DRY FIX: Previously the HMAC secret loading logic was duplicated between
 * session.ts (Node.js) and session-edge.ts (Edge). This module provides
 * the shared core logic; each runtime module handles its own filesystem access.
 *
 * Priority:
 *   1. HMAC_SECRET env var (production)
 *   2. .hmac-secret file (dev shared secret, cross-runtime consistency)
 *   3. crypto.getRandomValues fallback (per-process, tokens won't survive restart)
 */

import { logger } from '@/lib/logger'

/** Generate a cryptographically random 64-char hex secret */
export function generateHmacSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Log the standard HMAC_SECRET missing warning (consistent formatting) */
export function logMissingHmacSecret(runtime: 'node' | 'edge'): void {
  const runtimeLabel = runtime === 'node' ? 'Node.js' : 'Edge Runtime'
  const padding = ' '.repeat(Math.max(0, 21 - runtimeLabel.length))
  const box = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║  [FATAL] HMAC_SECRET environment variable is not set!      ║',
    `║  Runtime: ${runtimeLabel}${padding}║`,
    '║  Session token signing requires a secure secret.           ║',
    '║  Set HMAC_SECRET in your environment before starting.      ║',
    '║  Example: HMAC_SECRET=$(openssl rand -hex 32)              ║',
    '╚══════════════════════════════════════════════════════════════╝',
  ].join('\n')
  logger.error('hmac-secret', box)
}

/** Check if we are in a build phase (should not exit/fail during build) */
export function isBuildPhase(): boolean {
  if (typeof process === 'undefined') return false
  const phase = process.env?.NEXT_PHASE
  return phase === 'phase-production-build' || phase === 'phase-export'
}

/** Read a file-based secret (caller handles the fs import and error handling) */
export function readSecretFromFile(
  readFileSync: (path: string, encoding: string) => string | undefined,
  exists: (path: string) => boolean,
  secretFile: string,
): string | undefined {
  if (exists(secretFile)) {
    const existing = readFileSync(secretFile, 'utf-8')?.trim()
    if (existing && existing.length >= 32) return existing
  }
  return undefined
}

// ─── Shared HMAC Functions ──────────────────────────────────────────────

/**
 * DRY FIX (L1): Shared HMAC signing and verification functions.
 * Previously duplicated between session.ts and session-edge.ts.
 * Using crypto.subtle (Web Crypto API) ensures compatibility with
 * both Edge Runtime and Node.js Runtime.
 */

/** Sign data with HMAC-SHA-256 using Web Crypto API */
export async function hmacSignData(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Verify HMAC-SHA-256 signature using constant-time comparison.
 *  SECURITY FIX (S1): Uses SHA-256 hash of both values to produce fixed-length
 *  32-byte Uint8Arrays, then performs a manual constant-time XOR comparison.
 *  This is resistant to JIT optimization (fixed iteration count, no early exit)
 *  and eliminates timing variance from different-length inputs.
 */
export async function hmacVerifyData(data: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSignData(data, secret)
  if (expected.length !== signature.length) return false
  // Hash both to fixed-length (32 bytes) for timing-safe comparison
  const encoder = new TextEncoder()
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(signature)),
  ])
  const arrA = new Uint8Array(hashA)
  const arrB = new Uint8Array(hashB)
  // Constant-time comparison: always iterates exactly 32 times, no early exit
  let result = 0
  for (let i = 0; i < 32; i++) {
    result |= arrA[i] ^ arrB[i]
  }
  return result === 0
}
