import { NextRequest, NextResponse } from 'next/server'
import { access, readFile } from 'fs/promises'
import { resolveFromProjectRoot } from '@/lib/project-root'
import { validateSessionAsync } from '@/lib/session'
import { extractToken, getSecureClientIp } from '@/lib/api-helpers'
import { rateLimit, RATE_LIMIT_RUNNER_TOKEN, getRateLimitHeaders } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

function getSecretFilePath(): string {
  return resolveFromProjectRoot('mini-services', 'bot-runner', 'config', 'runner-secret')
}

export async function GET(request: NextRequest) {
  try {
    const clientIp = getSecureClientIp(request)
    const rateResult = rateLimit.check(clientIp, RATE_LIMIT_RUNNER_TOKEN)
    if (!rateResult.success) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: getRateLimitHeaders(rateResult) }
      )
    }

    const token = extractToken(request)
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const session = await validateSessionAsync(token)
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { db } = await import('@/lib/db')
    const firstAccount = await db.account.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
    if (firstAccount && firstAccount.id !== session.userId) {
      return NextResponse.json(
        { error: 'Forbidden: only admin can access runner token' },
        { status: 403 }
      )
    }

    const secretFilePath = getSecretFilePath()

    try {
      await access(secretFilePath)
    } catch {
      // SECURITY FIX (S2): Return explicit response indicating the runner secret
      // is not configured, instead of returning { token: '' } which misleads the
      // frontend into treating an empty string as a valid token.
      return NextResponse.json({ token: null, configured: false })
    }

    const secret = (await readFile(secretFilePath, 'utf-8')).trim()
    logger.info('runner-token', `Runner token accessed by user: ${session.userId}, IP: ${clientIp}`)

    // Always return the full secret to authenticated admin users.
    // The frontend needs the actual secret for Socket.IO handshake auth —
    // a masked preview would be rejected by the bot-runner's SHA-256 comparison.
    // Security: this endpoint already requires session auth + admin-only check.
    return NextResponse.json(
      { token: secret, configured: true },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          ...getRateLimitHeaders(rateResult),
        },
      }
    )
  } catch (error) {
    logger.error('runner-token', 'Failed to read runner secret', error instanceof Error ? error.message : String(error))
    // SECURITY FIX (S2): Return error response instead of empty token.
    // Returning { token: '' } masks the failure and misleads the frontend.
    return NextResponse.json({ error: 'Failed to read runner configuration' }, { status: 500 })
  }
}
