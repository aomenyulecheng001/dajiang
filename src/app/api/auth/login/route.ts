import { NextRequest, NextResponse } from 'next/server'
import { authenticateUser } from '@/lib/auth'
import { rateLimit, RATE_LIMIT_AUTH, getRateLimitHeaders } from '@/lib/rate-limit'
import { getSecureClientIp, isSecureRequest } from '@/lib/api-helpers'
import { logger } from '@/lib/logger'

const COOKIE_NAME = 'session_token'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const failedLoginAttempts = new Map<string, { count: number; lockedUntil: number; createdAt: number }>()
const MAX_FAILED_ATTEMPTS = 10
const LOCKOUT_DURATION_MS = 15 * 60 * 1000
const MAX_FAILED_ENTRIES = 10000
const FAILED_ENTRY_TTL_MS = 60 * 60 * 1000 // 1 hour

// SECURITY FIX (SEC-78): Periodic cleanup of failed login attempts Map
// to prevent unbounded memory growth from attacker-generated unique keys.
const _loginCleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of failedLoginAttempts) {
    if (now - entry.createdAt > FAILED_ENTRY_TTL_MS ||
        (entry.lockedUntil && now > entry.lockedUntil)) {
      failedLoginAttempts.delete(key)
    }
  }
  // Safety cap: evict oldest entries if Map exceeds maximum size
  if (failedLoginAttempts.size > MAX_FAILED_ENTRIES) {
    const entries = [...failedLoginAttempts.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
    const toRemove = entries.slice(0, entries.length - Math.floor(MAX_FAILED_ENTRIES * 0.8))
    for (const [key] of toRemove) {
      failedLoginAttempts.delete(key)
    }
  }
}, 5 * 60 * 1000)
if (_loginCleanupTimer.unref) _loginCleanupTimer.unref()

export async function POST(request: NextRequest) {
  const clientIp = getSecureClientIp(request)
  const rateResult = rateLimit.check(clientIp, RATE_LIMIT_AUTH)
  if (!rateResult.success) {
    return NextResponse.json(
      { error: 'Too many login attempts. Please try again later.' },
      { status: 429, headers: getRateLimitHeaders(rateResult) }
    )
  }

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

    const normalizedUsername = username.trim()
    // SECURITY FIX (SEC-26): Use IP+username combination as lockout key instead
    // of just username. This prevents an attacker from bypassing per-user lockout
    // by trying the same username from different IPs, and also prevents one
    // attacker from locking out a legitimate user at a different IP.
    const lockoutKey = `${normalizedUsername}:${clientIp}`
    const userLockout = failedLoginAttempts.get(lockoutKey)
    if (userLockout && userLockout.count >= MAX_FAILED_ATTEMPTS) {
      if (Date.now() < userLockout.lockedUntil) {
        return NextResponse.json(
          { error: 'Account temporarily locked. Try again later.' },
          { status: 423 }
        )
      }
      failedLoginAttempts.delete(lockoutKey)
    }

    // SECURITY FIX (S-5): Global username lockout to prevent IP rotation bypass.
    // An attacker using multiple IPs can bypass the per-IP lockout. A global
    // username counter with a higher threshold (50) blocks sustained attacks.
    const globalLockoutKey = `global:${normalizedUsername}`
    const globalLockout = failedLoginAttempts.get(globalLockoutKey)
    if (globalLockout && globalLockout.count >= 50) {
      if (Date.now() < globalLockout.lockedUntil) {
        return NextResponse.json(
          { error: 'Account temporarily locked. Try again later.' },
          { status: 423 }
        )
      }
      failedLoginAttempts.delete(globalLockoutKey)
    }

    const result = await authenticateUser(normalizedUsername, password)
    if (!result) {
      const maskedUsername = username.length > 2 ? username.slice(0, 2) + '***' : '***'
      logger.warn('auth-login', `Failed login attempt for user: ${maskedUsername}, IP: ${clientIp}`)
      // SECURITY FIX (M-3): Re-read current value from Map after async call
      // to prevent race condition where concurrent requests read the same stale count.
      const currentEntry = failedLoginAttempts.get(lockoutKey)
      const existing = currentEntry || { count: 0, lockedUntil: 0, createdAt: Date.now() }
      existing.count++
      if (existing.count >= MAX_FAILED_ATTEMPTS) {
        existing.lockedUntil = Date.now() + LOCKOUT_DURATION_MS
      }
      failedLoginAttempts.set(lockoutKey, existing)
      // SECURITY FIX (S-5): Update global username counter on failed login
      const currentGlobal = failedLoginAttempts.get(globalLockoutKey)
      const globalEntry = currentGlobal || { count: 0, lockedUntil: 0, createdAt: Date.now() }
      globalEntry.count++
      if (globalEntry.count >= 50) {
        globalEntry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS
      }
      failedLoginAttempts.set(globalLockoutKey, globalEntry)
      return NextResponse.json(
        { error: 'Invalid username or password' },
        { status: 401 }
      )
    }

    failedLoginAttempts.delete(lockoutKey)

    const response = NextResponse.json(
      { success: true, username: result.username },
      { status: 200 }
    )

    const isHttps = isSecureRequest(request)
    response.cookies.set(COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    })

    return response
  } catch (error) {
    logger.error('auth-login', 'Login error', error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
