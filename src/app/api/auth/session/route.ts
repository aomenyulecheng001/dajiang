import { NextRequest, NextResponse } from 'next/server'
import { validateSessionAsync } from '@/lib/session'
import { db } from '@/lib/db'
import { extractToken, getSecureClientIp } from '@/lib/api-helpers'
import { rateLimit, RATE_LIMIT_AUTH_MUTATION, getRateLimitHeaders } from '@/lib/rate-limit'

export async function GET(request: NextRequest) {
  try {
    const ip = getSecureClientIp(request)
    const rateResult = rateLimit.check(ip, RATE_LIMIT_AUTH_MUTATION)
    if (!rateResult.success) {
      return NextResponse.json(
        { valid: false, error: 'Too many requests' },
        { status: 429, headers: getRateLimitHeaders(rateResult) }
      )
    }

    const token = extractToken(request)
    if (!token) {
      return NextResponse.json(
        { valid: false, error: 'No session token provided' },
        { status: 401 }
      )
    }

    const session = await validateSessionAsync(token)

    if (!session) {
      return NextResponse.json(
        { valid: false, error: 'Invalid or expired session' },
        { status: 401 }
      )
    }

    const account = await db.account.findUnique({ where: { id: session.userId }, select: { username: true } })
    if (!account) {
      return NextResponse.json(
        { valid: false, error: 'Account no longer exists' },
        { status: 401 }
      )
    }

    return NextResponse.json({
      valid: true,
      username: account.username,
    })
  } catch {
    return NextResponse.json(
      { valid: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
