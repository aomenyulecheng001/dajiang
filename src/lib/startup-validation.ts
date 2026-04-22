/**
 * P1-DEPLOY-1 FIX: Startup validation for required environment variables.
 * Logs warnings for missing critical env vars that are needed for production.
 * This runs once at server startup to catch configuration issues early.
 */

let validated = false

export function validateRequiredEnvVars(): void {
  if (validated) return
  validated = true

  const warnings: string[] = []

  // HMAC_SECRET — required for session token generation
  // If not set, a random one is generated on each restart, invalidating all sessions
  if (!process.env.HMAC_SECRET) {
    warnings.push('HMAC_SECRET is not set. Session tokens will not survive server restarts. Set this to a stable hex string in production.')
  }

  // ENCRYPTION_KEY — required for encrypting sensitive data (BOT_TOKENs, API keys)
  // If not set, a random one is generated, making previously encrypted data unreadable
  if (!process.env.ENCRYPTION_KEY) {
    warnings.push('ENCRYPTION_KEY is not set. Encrypted data (BOT_TOKENs, API keys) will be lost on server restart. Set this to a stable hex string in production.')
  }

  // DATABASE_URL — required for Prisma
  if (!process.env.DATABASE_URL) {
    warnings.push('DATABASE_URL is not set. Using default SQLite path. In standalone mode, set this to an absolute path.')
  }

  // SERVER_ORIGIN — recommended for production CORS
  // Supports both HTTP and HTTPS deployments (e.g., http://1.2.3.4:3000 or https://yourdomain.com)
  if (process.env.NODE_ENV === 'production' && !process.env.SERVER_ORIGIN) {
    warnings.push('SERVER_ORIGIN is not set in production. Socket.IO CORS will be restrictive. Set this to your public URL (e.g., https://yourdomain.com or http://1.2.3.4:3000).')
  }

  if (warnings.length > 0) {
    console.warn('')
    console.warn('╔══════════════════════════════════════════════════════════════╗')
    console.warn('║  [DEPLOYMENT WARNINGS] Environment Configuration Issues   ║')
    console.warn('╠══════════════════════════════════════════════════════════════╣')
    for (const w of warnings) {
      // Wrap long warnings to fit in the box (60 chars per line)
      const lines = wrapText(w, 56)
      for (const line of lines) {
        console.warn(`║  ${line.padEnd(58)}║`)
      }
      console.warn('║' + ' '.repeat(60) + '║')
    }
    console.warn('║  The application will still start, but some features may  ║')
    console.warn('║  not work correctly after a restart.                      ║')
    console.warn('╚══════════════════════════════════════════════════════════════╝')
    console.warn('')
  } else {
    console.log('[Config] All required environment variables are set ✓')
  }

  // DEPLOY FIX: In production mode, FATAL exit if critical security keys are missing.
  // Without these, session tokens are invalidated on every restart and encrypted
  // data (BOT_TOKENs, API keys) becomes permanently unreadable.
  if (process.env.NODE_ENV === 'production') {
    const fatalIssues: string[] = []
    if (!process.env.HMAC_SECRET) {
      fatalIssues.push('HMAC_SECRET is not set. Session tokens will not survive restarts.')
    }
    if (!process.env.ENCRYPTION_KEY) {
      fatalIssues.push('ENCRYPTION_KEY is not set. Encrypted bot credentials will be LOST on restart.')
    }

    if (fatalIssues.length > 0) {
      console.error('')
      console.error('╔══════════════════════════════════════════════════════════════╗')
      console.error('║  🔴 FATAL: Production deployment cannot continue         ║')
      console.error('╠══════════════════════════════════════════════════════════════╣')
      for (const issue of fatalIssues) {
        const lines = wrapText(issue, 54)
        for (const line of lines) {
          console.error(`║  🚫 ${line.padEnd(55)}║`)
        }
        console.error('║' + ' '.repeat(60) + '║')
      }
      console.error('║                                                          ║')
      console.error('║  Fix: Set these in .env before starting:                  ║')
      console.error('║    HMAC_SECRET=$(openssl rand -hex 32)                   ║')
      console.error('║    ENCRYPTION_KEY=$(openssl rand -hex 32)                ║')
      console.error('║                                                          ║')
      console.error('║  Or run deploy.sh which auto-generates them.           ║')
      console.error('╚══════════════════════════════════════════════════════════════╝')
      console.error('')
      process.exit(1)
    }
  }
}

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
