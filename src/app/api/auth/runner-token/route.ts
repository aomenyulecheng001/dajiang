import { NextRequest, NextResponse } from 'next/server'
import { access, readFile } from 'fs/promises'
import { resolveFromProjectRoot } from '@/lib/project-root'
import { validateSessionAsync } from '@/lib/session'

/**
 * Lazy-evaluated path to the runner secret file.
 * Must NOT be a module-level constant because in standalone mode,
 * process.cwd() may not be set correctly at import time.
 */
function getSecretFilePath(): string {
  return resolveFromProjectRoot('mini-services', 'bot-runner', 'config', 'runner-secret')
}

/**
 * GET /api/auth/runner-token
 *
 * Returns the runner secret token needed for Socket.IO authentication.
 * P0-2 FIX: Only accessible to authenticated users.
 * P2-6 FIX: Uses async fs operations instead of sync to avoid blocking the event loop.
 */
export async function GET(request: NextRequest) {
  try {
    // Get session token from Authorization header OR cookie
    const authHeader = request.headers.get('authorization')
    const cookieToken = request.cookies.get('session_token')?.value
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : cookieToken || null

    if (!token || !(await validateSessionAsync(token))) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const secretFilePath = getSecretFilePath()

    // P2-6 FIX: Use async access() instead of existsSync()
    try {
      await access(secretFilePath)
    } catch {
      return NextResponse.json({ token: '' })
    }

    // P2-6 FIX: Use async readFile() instead of readFileSync()
    // P2-SEC-5 FIX: Add no-store header to prevent browser caching of the secret.
    // Without this, the runner secret could be cached in the browser's HTTP cache
    // and potentially accessed by other scripts or via cache inspection.
    const secret = (await readFile(secretFilePath, 'utf-8')).trim()
    return NextResponse.json(
      { token: secret },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
    )
  } catch (error) {
    console.error('Failed to read runner secret:', error)
    return NextResponse.json({ token: '' })
  }
}
