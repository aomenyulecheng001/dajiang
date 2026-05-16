import { NextRequest, NextResponse } from 'next/server'
import { deleteSession } from '@/lib/session'
import { extractToken, isSecureRequest } from '@/lib/api-helpers'

const COOKIE_NAME = 'session_token'

export async function POST(request: NextRequest) {
  const secure = isSecureRequest(request)
  try {
    const token = extractToken(request)
    if (token) {
      await deleteSession(token)
    }

    const response = NextResponse.json({ success: true })
    response.cookies.set(COOKIE_NAME, '', {
      httpOnly: true,
      secure: secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })

    return response
  } catch (error) {
    console.error('[Auth] Logout error:', error)
    const response = NextResponse.json({ success: true })
    response.cookies.set(COOKIE_NAME, '', {
      httpOnly: true,
      secure: secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
    return response
  }
}
