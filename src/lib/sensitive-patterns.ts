/**
 * Sensitive Data Patterns — lightweight, Edge Runtime compatible.
 *
 * This module is deliberately free of Node.js API imports so that it can be
 * safely imported by logger.ts (and transitively by middleware.ts) without
 * triggering the "Node.js module in Edge Runtime" Turbopack warning.
 *
 * All data sanitization and pattern definitions live here. Node.js-specific
 * crypto functions (timingSafeEqual, createHash) remain in security-utils.ts.
 *
 * ⚠️ CANONICAL SOURCE: src/lib/sensitive-patterns.ts
 * ⚠️ SYNC REQUIRED: When updating patterns, also update:
 *   - mini-services/bot-runner/handlers.ts (SENSITIVE_ENV_PATTERNS)
 *   - mini-services/bot-runner/log-manager.ts (SENSITIVE_PATTERNS)
 *   - mini-services/bot-runner/logger.ts (SENSITIVE_PATTERNS)
 */

// ─── Sensitive Env Var Key Patterns ────────────────────────────────────────

export const SENSITIVE_ENV_KEY_PATTERNS = [
  'BOT_TOKEN', 'SECRET', 'PASSWORD', 'AUTH', 'APIKEY', 'API_KEY',
  'ACCESS_KEY', 'PRIVATE', 'CREDENTIAL', 'DATABASE_URL',
] as const

// ─── Sensitive Data Detection Patterns ─────────────────────────────────────

export const SENSITIVE_DATA_PATTERNS = {
  BOT_TOKEN: /\d{9,}:[a-zA-Z0-9_-]{30,}/,
  API_KEY: /(?:api[_-]?key|apikey)["\s:=]+[a-zA-Z0-9_-]{20,}/i,
  PASSWORD: /(?:password|passwd|pwd)["\s:=]+[^\s]+/i,
  SECRET: /(?:secret|signing[_-]?key|access[_-]?token|refresh[_-]?token)["\s:=]+[a-zA-Z0-9_-]{20,}/i,
  AUTH_HEADER: /authorization["\s:=]+bearer\s+[a-zA-Z0-9._-]+/i,
  JWT: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/,
  CONNECTION_STRING: /:\/\/[^:]+:[^@]+@/,
  // Uses non-backtracking pattern: matches any char not starting the end-marker
  PRIVATE_KEY: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----(?:[^-]|-(?!-{4}))*-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
}

// ─── Redaction ─────────────────────────────────────────────────────────────

function toGlobalRegex(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
}

/**
 * Redact sensitive information from a string.
 * Pure function — no Node.js APIs, safe for Edge Runtime.
 */
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

/**
 * Sanitize a string for safe logging.
 * Removes control characters and truncates if too long.
 */
export function sanitizeForLogging(str: string, maxLength = 1000): string {
  if (!str || typeof str !== 'string') return ''

  // Remove control characters except newline and tab
  let sanitized = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

  // Truncate if too long
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + '...[truncated]'
  }

  return redactSensitiveData(sanitized)
}
