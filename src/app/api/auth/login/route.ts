import { NextRequest, NextResponse } from 'next/server'
import { authenticateUser } from '@/lib/auth'

const COOKIE_NAME = 'session_token'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function POST(request: NextRequest) {
  try {
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf-8') > 10_000) {
      return NextResponse.json(
        { error: 'Payload too large' },
        { status: 413 }
      )
    }

    let body: { username?: string; password?: string }
    try {
      body = JSON.parse(text)
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON' },
        { status: 400 }
      )
    }

    const { username, password } = body

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Username and password are required' },
        { status: 400 }
      )
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      return NextResponse.json(
        { error: 'Invalid input types' },
        { status: 400 }
      )
    }

    const result = await authenticateUser(username.trim(), password)
    if (!result) {
      console.warn(`[Auth] Failed login attempt for IP: ${request.headers.get('x-forwarded-for') || 'unknown'}`)
      return NextResponse.json(
        { error: 'Invalid username or password' },
        { status: 401 }
      )
    }

    const response = NextResponse.json(
      { success: true, username: result.username },
      { status: 200 }
    )

    const isHttps = process.env.PROTOCOL === 'https'
    response.cookies.set(COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? 'none' : 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    })

    return response
  } catch (error) {
    console.error('[Auth] Login error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
