/**
 * P1-DEPLOY-1 FIX: Startup validation for required environment variables.
 * Logs warnings for missing critical env vars that are needed for production.
 * This runs once at server startup to catch configuration issues early.
 */

import { logger } from '@/lib/logger'

let validated = false

function wrapText(text: string, maxLen: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxLen) {
      if (currentLine) lines.push(currentLine)
      currentLine = word
    } else {
      currentLine = currentLine ? currentLine + ' ' + word : word
    }
  }
  if (currentLine) lines.push(currentLine)
  return lines
}

export function validateRequiredEnvVars(): void {
  if (validated) return
  validated = true

  const warnings: string[] = []

  if (!process.env.HMAC_SECRET) {
    warnings.push('HMAC_SECRET is not set. Session tokens will not survive server restarts. Set this to a stable hex string in production.')
  } else if (process.env.HMAC_SECRET.length < 32) {
    warnings.push(`HMAC_SECRET is too short (${process.env.HMAC_SECRET.length} chars). Minimum 32 characters recommended for security.`)
  }

  if (!process.env.ENCRYPTION_KEY) {
    warnings.push('ENCRYPTION_KEY is not set. Encrypted data (BOT_TOKENs, API keys) will be lost on server restart. Set this to a stable hex string in production.')
  } else if (process.env.ENCRYPTION_KEY.length < 32) {
    warnings.push(`ENCRYPTION_KEY is too short (${process.env.ENCRYPTION_KEY.length} chars). Minimum 32 characters recommended for security.`)
  }

  if (!process.env.DATABASE_URL) {
    warnings.push('DATABASE_URL is not set. Prisma may connect to a wrong or empty database. In standalone mode, set this to an absolute path.')
  } else if (process.env.DATABASE_URL.startsWith('file:./')) {
    warnings.push('DATABASE_URL uses a relative path. In standalone mode this will resolve from the wrong directory. Use an absolute path (e.g., file:/www/wwwroot/bot-factory/db/custom.db).')
  }

  if (process.env.NODE_ENV === 'production' && !process.env.SERVER_ORIGIN) {
    warnings.push('SERVER_ORIGIN is not set in production. Socket.IO CORS will be restrictive. Set this to your public URL (e.g., https://yourdomain.com or http://1.2.3.4:3000).')
  }

  if (warnings.length > 0) {
    const lines: string[] = [
      'Environment Configuration Issues',
      '',
    ]
    for (const w of warnings) {
      const wrapped = wrapText(w, 56)
      for (const line of wrapped) {
        lines.push(`  ${line}`)
      }
      lines.push('')
    }
    lines.push('  The application will still start, but some features may')
    lines.push('  not work correctly after a restart.')
    logger.warn('startup', lines.join('\n'))
  } else {
    logger.info('startup', 'All required environment variables are set')
  }

  if (process.env.NODE_ENV === 'production') {
    const fatalIssues: string[] = []
    if (!process.env.HMAC_SECRET) {
      fatalIssues.push('HMAC_SECRET is not set. Session tokens will not survive restarts.')
    }
    if (!process.env.ENCRYPTION_KEY) {
      fatalIssues.push('ENCRYPTION_KEY is not set. Encrypted bot credentials will be LOST on restart.')
    }
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('file:./')) {
      fatalIssues.push('DATABASE_URL is missing or uses a relative path. In standalone mode, Prisma resolves relative paths from the wrong directory, causing the app to use an empty database. Set DATABASE_URL to an absolute path (e.g., file:/www/wwwroot/bot-factory/db/custom.db).')
    }

    if (fatalIssues.length > 0) {
      const lines: string[] = [
        'FATAL: Production deployment cannot continue',
        '',
      ]
      for (const issue of fatalIssues) {
        const wrapped = wrapText(issue, 54)
        for (const line of wrapped) {
          lines.push(`  ${line}`)
        }
        lines.push('')
      }
      lines.push('')
      lines.push('  Fix: Set these in .env before starting:')
      lines.push('    HMAC_SECRET=$(openssl rand -hex 32)')
      lines.push('    ENCRYPTION_KEY=$(openssl rand -hex 32)')
      lines.push('')
      lines.push('  Or run deploy.sh which auto-generates them.')
      logger.error('startup', lines.join('\n'))
      process.exit(1)
    }
  }
}
