import { NextRequest, NextResponse } from 'next/server'
import { resetPassword } from '@/lib/auth'
import { validateSessionAsync } from '@/lib/session'
import { extractToken, isSecureRequest } from '@/lib/api-helpers'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const token = extractToken(request)
    if (!token) {
      return NextResponse.json(
        { error: 'Authorization required' },
        { status: 401 }
      )
    }

    const session = await validateSessionAsync(token)
    if (!session) {
      return NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401 }
      )
    }

    // Parse request body
    const text = await request.text()
    // BUG FIX (QUALITY-1): Use Buffer.byteLength() instead of text.length.
    // text.length counts UTF-16 code units, not actual bytes.
    // Consistent with login/route.ts.
    if (Buffer.byteLength(text, 'utf-8') > 10_000) {
      return NextResponse.json(
        { error: 'Request body too large' },
        { status: 413 }
      )
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(text)
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      )
    }

    const { currentPassword, newPassword } = body as { currentPassword?: string; newPassword?: string }

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Current password and new password are required' },
        { status: 400 }
      )
    }

    // SECURITY FIX (SEC-109): Runtime type validation for password fields.
    // The `as` type assertion doesn't provide runtime safety. Non-string values
    // could cause unexpected behavior in bcrypt.compare or bypass validation.
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return NextResponse.json(
        { error: 'Invalid input types' },
        { status: 400 }
      )
    }

    // N1 FIX: Server-side password strength validation (must match client-side rules)
    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: 'New password must be at least 8 characters' },
        { status: 400 }
      )
    }
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return NextResponse.json(
        { error: 'New password must contain both letters and numbers' },
        { status: 400 }
      )
    }

    const result = await resetPassword(session.userId, currentPassword, newPassword, token)

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 400 }
      )
    }

    // BUG FIX (BUG-8): Set new session cookie if a new token was issued.
    // This maintains session continuity after password change, same as updateUsername.
    const response = NextResponse.json({
      success: true,
      message: result.message,
    })

    if (result.newToken) {
      const isHttps = isSecureRequest(request)
      response.cookies.set('session_token', result.newToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
      })
    }

    return response
  } catch (error) {
    logger.error('reset-password', 'Password reset error', error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
