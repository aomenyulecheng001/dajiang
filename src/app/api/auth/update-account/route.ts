import { NextRequest, NextResponse } from 'next/server'
import { updateUsername } from '@/lib/auth'
import { validateSessionAsync } from '@/lib/session'
import { db } from '@/lib/db'
import { extractToken, isSecureRequest } from '@/lib/api-helpers'

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
    // For multi-byte content (Chinese usernames, etc.), the actual size
    // could be 2-3x the character count. Consistent with login/route.ts.
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

    const { newUsername: rawUsername } = body as { newUsername?: string }

    // Type validation: ensure newUsername is actually a string
    if (!rawUsername || typeof rawUsername !== 'string') {
      return NextResponse.json(
        { error: 'New username is required and must be a string' },
        { status: 400 }
      )
    }

    // Sanitize: trim whitespace before validation
    const newUsername = rawUsername.trim()

    // BUG FIX: Verify the account exists in the DB before attempting update.
    // The session token contains a userId, but after a server restart with
    // a fresh HMAC_SECRET, stale tokens from previous sessions might pass
    // the revocation check (revocation list is in-memory and cleared on restart)
    // while the HMAC still validates. Cross-checking the DB ensures we catch
    // any inconsistency and return a clear error instead of "User not found".
    const account = await db.account.findUnique({ where: { id: session.userId } })
    if (!account) {
      console.warn(`[Auth] Update account: session userId ${session.userId} not found in DB. Token username: ${session.username}`)
      return NextResponse.json(
        { error: 'Session is invalid — please log in again' },
        { status: 401 }
      )
    }

    // Pass the current token so the function can revoke it and issue a new one
    const result = await updateUsername(session.userId, newUsername, token)

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 400 }
      )
    }

    const response = NextResponse.json({
      success: true,
      message: result.message,
      username: result.username,
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
    console.error('[Auth] Update account error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
