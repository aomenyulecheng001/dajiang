import { NextRequest, NextResponse } from 'next/server'
import { resetPassword } from '@/lib/auth'
import { validateSessionAsync } from '@/lib/session'
import { extractToken } from '@/lib/api-helpers'

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

    const result = await resetPassword(session.userId, currentPassword, newPassword, token)

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      message: result.message,
    })
  } catch (error) {
    console.error('[Auth] Password reset error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
