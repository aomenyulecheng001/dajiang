import { NextRequest, NextResponse } from 'next/server'
import { validateSessionAsync } from '@/lib/session'
import { db } from '@/lib/db'

const COOKIE_NAME = 'session_token'

export async function GET(request: NextRequest) {
  try {
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

    const account = await db.account.findUnique({ where: { id: session.userId } })
    if (!account) {
      return NextResponse.json(
        { valid: false, error: 'Account no longer exists' },
        { status: 401 }
      )
    }

    return NextResponse.json({
      valid: true,
      username: account.username,
      userId: account.id,
    })
  } catch {
    return NextResponse.json(
      { valid: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}

function extractToken(request: NextRequest): string | null {
  const cookieToken = request.cookies.get(COOKIE_NAME)?.value
  if (cookieToken) return cookieToken
  const authHeader = request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  return null
}
