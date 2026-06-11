// Import from lightweight module to keep Edge Runtime compatibility
import { redactSensitiveData } from './sensitive-patterns'

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

export function safeUnref(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  try {
    if (typeof (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref === 'function') {
      ;(timer as ReturnType<typeof setInterval> & { unref: () => void }).unref()
    }
  } catch { /* not available in this runtime */ }
}
