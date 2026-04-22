import { NextRequest, NextResponse } from 'next/server'
import { resetPassword } from '@/lib/auth'
import { validateSessionAsync } from '@/lib/session'

/**
 * POST /api/auth/reset-password
 *
 * Change password for the currently authenticated user.
 * Requires a valid session token and the current password.
 */
export async function POST(request: NextRequest) {
  try {
    // Validate session
    const cookieToken = request.cookies.get('session_token')?.value
    const authHeader = request.headers.get('authorization')
    const token = cookieToken || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null)
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
    if (text.length > 10_000) {
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
