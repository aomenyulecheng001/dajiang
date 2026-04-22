import { NextRequest, NextResponse } from 'next/server'
import { deleteSession } from '@/lib/session'

const COOKIE_NAME = 'session_token'

export async function POST(request: NextRequest) {
  try {
    const token = extractToken(request)
    if (token) {
      await deleteSession(token)
    }

    const response = NextResponse.json({ success: true })
    response.cookies.set(COOKIE_NAME, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
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
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
    return response
  }
}

function extractToken(request: NextRequest): string | null {
  const cookieToken = request.cookies.get(COOKIE_NAME)?.value
  if (cookieToken) return cookieToken
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  return null
}
