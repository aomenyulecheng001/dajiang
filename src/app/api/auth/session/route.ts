import { NextRequest, NextResponse } from 'next/server'
import { validateSessionAsync } from '@/lib/session'
import { db } from '@/lib/db'
import { extractToken, getSecureClientIp } from '@/lib/api-helpers'

// Rate limiting: max 10 session verification requests per minute per IP
const RATE_LIMIT = { max: 10, windowMs: 60_000 }
const rateMap = new Map<string, { count: number; resetAt: number }>()
const MAX_RATE_ENTRIES = 5000

const _rateCleanup = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateMap) {
    if (now > entry.resetAt) rateMap.delete(key)
  }
}, 60_000)
if (_rateCleanup.unref) _rateCleanup.unref()

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs })
    return true
  }
  if (entry.count >= RATE_LIMIT.max) return false
  entry.count++
  // Prune if map grows too large
  if (rateMap.size > MAX_RATE_ENTRIES) {
    let oldest: string | null = null
    let oldestTime = Infinity
    for (const [k, v] of rateMap) { if (v.resetAt < oldestTime) { oldestTime = v.resetAt; oldest = k } }
    if (oldest) rateMap.delete(oldest)
  }
  return true
}

export async function GET(request: NextRequest) {
  try {
    const ip = getSecureClientIp(request)
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { valid: false, error: 'Too many requests' },
        { status: 429 }
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
