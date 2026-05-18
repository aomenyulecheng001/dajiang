import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { rateLimit, getRateLimitConfig, getRateLimitHeaders } from '@/lib/rate-limit'
import { validateSessionEdge } from '@/lib/session-edge'

if (process.env.NODE_ENV === 'production' && !process.env.TRUSTED_PROXIES) {
  console.error('WARNING: TRUSTED_PROXIES is not configured. All users share a single rate limit bucket.')
  console.error('Set TRUSTED_PROXIES to your reverse proxy IPs (e.g., "10.0.0.1,10.0.0.2")')
}

const PUBLIC_ROUTES = [
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/token-version',
  '/api/health',
  '/api',
]

const TRUSTED_PROXIES = new Set(
  (process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean)
)

function isTrustedProxy(ip: string): boolean {
  if (TRUSTED_PROXIES.size === 0) return false
  return TRUSTED_PROXIES.has(ip) || ip === '127.0.0.1' || ip === '::1'
}

function extractClientIp(request: NextRequest): string {
  if (TRUSTED_PROXIES.size === 0) {
    return 'shared-untrusted'
  }

  const directIp = request.headers.get('x-real-ip') || request.headers.get('x-client-ip') || '127.0.0.1'

  if (isTrustedProxy(directIp)) {
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) {
      const ips = forwarded.split(',').map(s => s.trim())
      for (let i = ips.length - 1; i >= 0; i--) {
        if (!isTrustedProxy(ips[i])) return ips[i]
      }
    }
  }

  return directIp
}

function isWebhookRoute(pathname: string): boolean {
  return pathname.match(/^\/api\/webhook\//) !== null
}

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(r => pathname === r) || isWebhookRoute(pathname)
}

export const config = {
  matcher: ['/(.*)'],
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (!pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  const ip = extractClientIp(request)

  const method = request.method
  const normalizedPathname = pathname
    .replace(/\/api\/bots\/([a-zA-Z0-9._-]+)(?=\/|$)/g, '/api/bots/:id')
  const config = getRateLimitConfig(method, normalizedPathname)

  const normalizedPath = pathname
    .replace(/\/api\/bots\/([a-zA-Z0-9._-]+)(?=\/|$)/g, '/api/bots/:id')
    .replace(/\/[a-f0-9-]{36}/g, '/:id')
    .replace(/\/\d+/g, '/:num')
  const rateLimitKey = `${ip}:${method}:${normalizedPath}`

  const result = rateLimit.check(rateLimitKey, config)

  const headers = getRateLimitHeaders(result)

  if (!result.success) {
    const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000))

    return NextResponse.json(
      {
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
        retryAfter,
        limit: result.limit,
        resetAt: result.resetAt,
      },
      {
        status: 429,
        headers: {
          ...headers,
          'Retry-After': String(retryAfter),
        },
      }
    )
  }

  // C1 FIX: Session verification in middleware using Edge-compatible validation.
  // Previously, each API route handled auth independently, meaning any route
  // that forgot to call getCurrentUserId() was fully exposed. Now middleware
  // enforces auth at the edge for all non-public routes.
  if (!isPublicRoute(pathname)) {
    let token: string | null = null

    const cookieToken = request.cookies.get('session_token')?.value
    if (cookieToken) {
      token = cookieToken
    }

    if (!token) {
      const authHeader = request.headers.get('authorization')
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7)
      }
    }

    if (!token && pathname.match(/^\/api\/bots\/[^/]+\/logs\/stream$/)) {
      try {
        token = request.nextUrl.searchParams.get('token')
      } catch { /* ignore */ }
    }

    if (!token) {
      return NextResponse.json(
        { error: 'Authentication required', code: 'AUTH_REQUIRED' },
        { status: 401 },
      )
    }

    const session = await validateSessionEdge(token)
    if (!session) {
      return NextResponse.json(
        { error: 'Invalid or expired session', code: 'AUTH_EXPIRED' },
        { status: 401 },
      )
    }
  }

  const response = NextResponse.next()
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value)
  }

  if (pathname.includes('/logs/stream')) {
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    response.headers.set('Pragma', 'no-cache')
  }

  return response
}
