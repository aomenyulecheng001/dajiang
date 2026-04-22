import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { rateLimit, getRateLimitConfig, getRateLimitHeaders } from '@/lib/rate-limit'
import { validateSessionEdge } from '@/lib/session-edge'

/** Routes that do NOT require authentication */
const PUBLIC_ROUTES = [
  '/api/auth/login',
  '/api/auth/session',
]

function isWebhookRoute(pathname: string): boolean {
  return pathname.match(/^\/api\/webhook\//) !== null
}

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(r => pathname === r) || isWebhookRoute(pathname)
}

export const config = {
  matcher: '/api/:path*',
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  const forwarded = request.headers.get('x-forwarded-for')
  const realIp = request.headers.get('x-real-ip')
  const ip = forwarded
    ? forwarded.split(',')[0].trim()
    : realIp || request.headers.get('x-client-ip') || '127.0.0.1'

  const method = request.method
  const normalizedPathname = pathname
    .replace(/\/(?=[a-zA-Z0-9-]*\d)[a-zA-Z0-9]+-[a-zA-Z0-9-]*(?=\/|$)/g, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
  const config = getRateLimitConfig(method, normalizedPathname)

  const result = rateLimit.check(`${ip}:${method}:${normalizedPathname}`, config)

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

  if (!isPublicRoute(pathname)) {
    const cookieToken = request.cookies.get('session_token')?.value
    const authHeader = request.headers.get('authorization')
    let token = cookieToken
      || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null)

    // Fallback: check query param ?token= only for SSE log streaming
    // (EventSource cannot set custom headers)
    if (!token && pathname.includes('/logs/stream')) {
      token = request.nextUrl.searchParams.get('token')
    }

    if (!token || !(await validateSessionEdge(token))) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Valid session token required' },
        {
          status: 401,
          headers: {
            ...headers,
            'WWW-Authenticate': 'Bearer realm="Bot Factory"',
          },
        }
      )
    }
  }

  const response = NextResponse.next()
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value)
  }

  return response
}
