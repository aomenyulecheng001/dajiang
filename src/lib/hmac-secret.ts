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
