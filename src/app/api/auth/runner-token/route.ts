import { NextRequest, NextResponse } from 'next/server'
import { access, readFile } from 'fs/promises'
import { resolveFromProjectRoot } from '@/lib/project-root'
import { validateSessionAsync } from '@/lib/session'
import { extractToken, getSecureClientIp } from '@/lib/api-helpers'
import { rateLimit, RATE_LIMIT_RUNNER_TOKEN, getRateLimitHeaders } from '@/lib/rate-limit'

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

    if (process.env.RUNNER_TOKEN_ACCESS === 'admin') {
      const { db } = await import('@/lib/db')
      const firstAccount = await db.account.findFirst({ orderBy: { createdAt: 'asc' } })
      if (firstAccount && firstAccount.id !== session.userId) {
        return NextResponse.json(
          { error: 'Forbidden' },
          { status: 403 }
        )
      }
    }

    const secretFilePath = getSecretFilePath()

    try {
      await access(secretFilePath)
    } catch {
      return NextResponse.json({ token: '' })
    }

    const secret = (await readFile(secretFilePath, 'utf-8')).trim()
    console.info(`[Audit] Runner token accessed by user: ${session.userId}, IP: ${clientIp}`)
    return NextResponse.json(
      { token: secret },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          ...getRateLimitHeaders(rateResult),
        },
      }
    )
  } catch (error) {
    console.error('Failed to read runner secret:', error)
    return NextResponse.json({ token: '' })
  }
}
