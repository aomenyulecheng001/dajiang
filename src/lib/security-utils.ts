/**
 * Security Utilities - Shared security functions for Bot Factory
 * 
 * This module provides centralized security functions to ensure consistent
 * security practices across the codebase.
 * 
 * FIX: Created to eliminate code duplication and ensure uniform security handling.
 */

import { createHash, timingSafeEqual } from 'crypto'
import { logger } from '@/lib/logger'

// ─── Path Validation ────────────────────────────────────────────────────────

/**
 * Validate that a target path is within an allowed base directory.
 * Prevents path traversal attacks.
 * 
 * @param basePath - The allowed base directory
 * @param targetPath - The path to validate
 * @returns true if the path is safe, false otherwise
 */
export function isPathWithinBase(basePath: string, targetPath: string): boolean {
  const normalizedBase = basePath.replace(/\\/g, '/').replace(/\/$/, '')
  const normalizedTarget = targetPath.replace(/\\/g, '/')
  
  // Check for path traversal attempts
  if (normalizedTarget.includes('..')) return false
  
  // Ensure target starts with base path
  return normalizedTarget.startsWith(normalizedBase + '/') || normalizedTarget === normalizedBase
}

/**
 * Validate a filename to prevent directory traversal and null byte injection.
 * 
 * @param filename - The filename to validate
 * @returns true if the filename is safe
 */
export function isValidFilename(filename: string): boolean {
  if (!filename || typeof filename !== 'string') return false
  if (filename.length === 0 || filename.length > 255) return false
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false
  if (filename.includes('\0')) return false
  if (filename === '.' || filename === '..') return false
  return true
}

// ─── Sensitive Env Var Key Patterns ──────────────────────────────────────────

/**
 * Env var key name patterns that should never be exposed to clients.
 * Used when filtering bot env var keys in API responses and Socket.IO events.
 *
 * ⚠️ CANONICAL SOURCE: src/lib/security-utils.ts
 * ⚠️ SYNC REQUIRED: When updating patterns, also update:
 *   - mini-services/bot-runner/handlers.ts (SENSITIVE_ENV_PATTERNS)
 *   - mini-services/bot-runner/log-manager.ts (SENSITIVE_PATTERNS)
 *
 * SECURITY FIX (M3): Added explicit documentation about the relationship
 * between this list and the bot-runner's copy, and added 'DATABASE_URL'
 * which was previously only in the bot-runner copy.
 */
export const SENSITIVE_ENV_KEY_PATTERNS = [
  'BOT_TOKEN', 'SECRET', 'PASSWORD', 'AUTH', 'APIKEY', 'API_KEY',
  'ACCESS_KEY', 'PRIVATE', 'CREDENTIAL', 'DATABASE_URL',
] as const

// ─── Sensitive Data Sanitization ────────────────────────────────────────────

/**
 * Patterns for detecting sensitive data in strings.
 * Used for log sanitization and error message redaction.
 *
 * ⚠️ CANONICAL SOURCE: src/lib/security-utils.ts
 * ⚠️ SYNC REQUIRED: When updating patterns, also update:
 *   - mini-services/bot-runner/handlers.ts (SENSITIVE_ENV_PATTERNS)
 *   - mini-services/bot-runner/log-manager.ts (SENSITIVE_PATTERNS)
 */
export const SENSITIVE_DATA_PATTERNS = {
  BOT_TOKEN: /\d{9,}:[a-zA-Z0-9_-]{30,}/,
  API_KEY: /(?:api[_-]?key|apikey)["\s:=]+[a-zA-Z0-9_-]{20,}/i,
  PASSWORD: /(?:password|passwd|pwd)["\s:=]+[^\s]+/i,
  // SECURITY FIX (M7): Narrowed SECRET pattern to avoid false positives on
  // generic "token" references (e.g., "tokenVersion", "token-based").
  // Now requires "secret" or "token" followed by a separator and a value
  // that looks like a real credential (20+ chars of hex/base64, or a
  // Bearer/JWT prefix). Generic short token references are excluded.
  SECRET: /(?:secret|signing[_-]?key|access[_-]?token|refresh[_-]?token)["\s:=]+[a-zA-Z0-9_-]{20,}/i,
  AUTH_HEADER: /authorization["\s:=]+bearer\s+[a-zA-Z0-9._-]+/i,
  JWT: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/,
  CONNECTION_STRING: /:\/\/[^:]+:[^@]+@/,
  // L2 FIXED: Avoid [\s\S]*? which causes catastrophic backtracking on long input.
  // Match content character by character, rejecting the end-marker sequence.
  PRIVATE_KEY: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----(?:[^-]|-(?!-{4}))*-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
}

/**
 * Redact sensitive information from a string.
 * 
 * @param text - The text to sanitize
 * @returns The sanitized text with sensitive data replaced
 */
function toGlobalRegex(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
}

export function redactSensitiveData(text: string): string {
  let sanitized = text
  
  sanitized = sanitized.replace(toGlobalRegex(SENSITIVE_DATA_PATTERNS.BOT_TOKEN), '[BOT_TOKEN_REDACTED]')
  
  sanitized = sanitized.replace(toGlobalRegex(SENSITIVE_DATA_PATTERNS.API_KEY), 'api_key=[REDACTED]')
  
  sanitized = sanitized.replace(toGlobalRegex(SENSITIVE_DATA_PATTERNS.PASSWORD), 'password=[REDACTED]')
  
  sanitized = sanitized.replace(toGlobalRegex(SENSITIVE_DATA_PATTERNS.SECRET), 'secret=[REDACTED]')
  
  sanitized = sanitized.replace(toGlobalRegex(SENSITIVE_DATA_PATTERNS.AUTH_HEADER), 'authorization=Bearer [REDACTED]')
  
  sanitized = sanitized.replace(toGlobalRegex(SENSITIVE_DATA_PATTERNS.JWT), '[JWT_REDACTED]')
  
  sanitized = sanitized.replace(toGlobalRegex(SENSITIVE_DATA_PATTERNS.CONNECTION_STRING), '://[USER]:[PASS]@')
  
  sanitized = sanitized.replace(toGlobalRegex(SENSITIVE_DATA_PATTERNS.PRIVATE_KEY), '[PRIVATE_KEY_REDACTED]')
  
  return sanitized
}

// ─── Timing-Safe Comparison ─────────────────────────────────────────────────

/**
 * Compare two strings in constant time to prevent timing attacks.
 * Uses SHA-256 hashing to handle strings of different lengths safely.
 *
 * LIMITATION: The initial `a.length !== b.length` branch check may reveal
 * that the strings have different lengths, but NOT their actual content.
 * This is acceptable for webhook secret validation where the attacker cannot
 * control the expected value's length. For scenarios where length must also
 * be secret, use a fixed-length token format (e.g., hex-encoded 32 bytes).
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal
 */
export function timingSafeCompare(a: string, b: string): boolean {
  // SECURITY FIX (S3): Pad both inputs to a fixed length before hashing to
  // eliminate timing variance from different-length inputs. Previously, different-
  // length strings caused different amounts of data to be hashed, potentially
  // leaking length information through timing analysis.
  try {
    const FIXED_LEN = 256
    const padStr = (s: string) => s.padEnd(FIXED_LEN, '\0').slice(0, FIXED_LEN)
    const hashA = createHash('sha256').update(padStr(a)).digest()
    const hashB = createHash('sha256').update(padStr(b)).digest()
    // Only return true if BOTH the hash matches AND the lengths match.
    // The hash comparison is timing-safe; the length check is not, but it
    // happens after the timing-safe comparison so it doesn't leak timing info
    // about the content — only whether the lengths happen to match.
    return timingSafeEqual(hashA, hashB) && a.length === b.length
  } catch {
    return false
  }
}

/**
 * Compare two buffers in constant time.
 * 
 * @param a - First buffer
 * @param b - Second buffer
 * @returns true if buffers are equal
 */
export function timingSafeBufferCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// ─── Error Response Helpers ─────────────────────────────────────────────────

/**
 * Standard error response structure.
 * FIX: Provides consistent error responses that don't leak sensitive information.
 */
export interface SecureErrorResponse {
  ok: false
  error: string
  code?: string
  // Details is intentionally excluded from public responses
}

/**
 * Pre-defined error responses that don't reveal system internals.
 * FIX: Prevents information leakage through error messages.
 */
export const SECURE_ERROR_RESPONSES = {
  // Authentication errors - don't reveal if user/bot exists
  INVALID_CREDENTIALS: { ok: false as const, error: 'Invalid credentials', code: 'AUTH_INVALID' },
  SESSION_EXPIRED: { ok: false as const, error: 'Session expired', code: 'AUTH_EXPIRED' },
  UNAUTHORIZED: { ok: false as const, error: 'Authentication required', code: 'AUTH_REQUIRED' },
  
  // Resource errors - don't reveal resource existence
  NOT_FOUND: { ok: false as const, error: 'Resource not found', code: 'NOT_FOUND' },
  FORBIDDEN: { ok: false as const, error: 'Access denied', code: 'FORBIDDEN' },
  
  // Validation errors
  INVALID_INPUT: { ok: false as const, error: 'Invalid input', code: 'INVALID_INPUT' },
  INVALID_ID: { ok: false as const, error: 'Invalid identifier', code: 'INVALID_ID' },
  
  // Rate limiting
  RATE_LIMITED: { ok: false as const, error: 'Too many requests', code: 'RATE_LIMITED' },
  
  // Server errors - generic message
  INTERNAL_ERROR: { ok: false as const, error: 'Internal server error', code: 'INTERNAL_ERROR' },
  SERVICE_UNAVAILABLE: { ok: false as const, error: 'Service temporarily unavailable', code: 'SERVICE_UNAVAILABLE' },
} as const

/**
 * Create a secure error response that doesn't leak sensitive information.
 * 
 * @param errorType - The type of error from SECURE_ERROR_RESPONSES
 * @param internalDetails - Internal details (logged but not sent to client)
 * @returns A secure error response
 */
export function createSecureError(
  errorType: keyof typeof SECURE_ERROR_RESPONSES,
  internalDetails?: unknown
): SecureErrorResponse {
  // Log internal details server-side
  if (internalDetails) {
    const sanitizedDetails = typeof internalDetails === 'string' 
      ? redactSensitiveData(internalDetails)
      : '[OBJECT]'
    logger.error('security-utils', `Error (${errorType}): ${sanitizedDetails}`)
  }
  
  return SECURE_ERROR_RESPONSES[errorType]
}

// ─── Input Validation ───────────────────────────────────────────────────────

/**
 * Validate a bot ID format.
 * 
 * @param botId - The bot ID to validate
 * @returns true if the ID format is valid
 */
export function isValidBotIdFormat(botId: string): boolean {
  if (!botId || typeof botId !== 'string') return false
  if (botId.length === 0 || botId.length > 100) return false
  // Allow alphanumeric, hyphens, underscores, and dots
  if (!/^[a-zA-Z0-9._-]+$/.test(botId)) return false
  // Block path traversal
  if (botId.includes('..')) return false
  // SECURITY FIX (M3): Block IDs starting with '.' to prevent hidden file
  // interactions (e.g., '.env', '.git'). Consistent with validateBotId() in validation.ts.
  if (botId.startsWith('.')) return false
  return true
}

/**
 * Validate a user ID format.
 * 
 * @param userId - The user ID to validate
 * @returns true if the ID format is valid
 */
export function isValidUserIdFormat(userId: string): boolean {
  if (!userId || typeof userId !== 'string') return false
  if (userId.length === 0 || userId.length > 100) return false
  // Allow alphanumeric, hyphens, underscores (cuid, uuid, etc.)
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) return false
  return true
}

/**
 * Sanitize a string for safe logging.
 * Removes control characters and truncates if too long.
 * 
 * @param str - The string to sanitize
 * @param maxLength - Maximum allowed length (default 1000)
 * @returns The sanitized string
 */
export function sanitizeForLogging(str: string, maxLength = 1000): string {
  if (!str || typeof str !== 'string') return ''
  
  // Remove control characters except newline and tab
  let sanitized = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  
  // Truncate if too long
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + '...[truncated]'
  }
  
  // Redact sensitive data
  return redactSensitiveData(sanitized)
}
