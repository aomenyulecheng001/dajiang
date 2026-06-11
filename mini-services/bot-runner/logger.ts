// ⚠️ CANONICAL SOURCE: src/lib/security-utils.ts
// ⚠️ SYNC REQUIRED: When updating patterns, also update:
//   - mini-services/bot-runner/handlers.ts (SENSITIVE_ENV_PATTERNS)
//   - mini-services/bot-runner/log-manager.ts (SENSITIVE_PATTERNS)

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\d{9,}:[a-zA-Z0-9_-]{30,}/g, replacement: '[BOT_TOKEN_REDACTED]' },
  { pattern: /(?:api[_-]?key|apikey)["\s:=]+[a-zA-Z0-9_-]{20,}/gi, replacement: 'api_key=[REDACTED]' },
  { pattern: /(?:password|passwd|pwd)["\s:=]+[^\s]+/gi, replacement: 'password=[REDACTED]' },
  { pattern: /(?:secret|signing[_-]?key|access[_-]?token|refresh[_-]?token)["\s:=]+[a-zA-Z0-9_-]{20,}/gi, replacement: 'secret=[REDACTED]' },
  { pattern: /authorization["\s:=]+bearer\s+[a-zA-Z0-9._-]+/gi, replacement: 'authorization=Bearer [REDACTED]' },
  { pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g, replacement: '[JWT_REDACTED]' },
  { pattern: /:\/\/[^:]+:[^@]+@/g, replacement: '://[USER]:[PASS]@' },
  // L2 FIXED: Avoid [\s\S]*? which causes catastrophic backtracking on long input.
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----(?:[^-]|-(?!-{4}))*-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
]

function redactSensitiveData(text: string): string {
  let sanitized = text
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement)
  }
  return sanitized
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel]
}

function formatMessage(level: LogLevel, module: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString()
  const safeMessage = redactSensitiveData(message)
  const base = `${timestamp} [${level.toUpperCase()}] [${module}] ${safeMessage}`
  if (data !== undefined) {
    const dataStr = typeof data === 'string' ? redactSensitiveData(data) : redactSensitiveData(JSON.stringify(data))
    return `${base} ${dataStr}`
  }
  return base
}

export const logger = {
  debug: (module: string, message: string, data?: unknown) => {
    if (shouldLog('debug')) console.debug(formatMessage('debug', module, message, data))
  },
  info: (module: string, message: string, data?: unknown) => {
    if (shouldLog('info')) console.info(formatMessage('info', module, message, data))
  },
  warn: (module: string, message: string, data?: unknown) => {
    if (shouldLog('warn')) console.warn(formatMessage('warn', module, message, data))
  },
  error: (module: string, message: string, data?: unknown) => {
    if (shouldLog('error')) console.error(formatMessage('error', module, message, data))
  },
}
