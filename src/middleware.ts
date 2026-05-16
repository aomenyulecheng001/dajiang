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
  // SECURITY FIX: Default to false when TRUSTED_PROXIES is not configured.
  // Previously returned true, which meant all proxies were trusted and
  // X-Forwarded-For headers from any source were accepted, allowing
  // IP spoofing to bypass rate limiting.
  if (TRUSTED_PROXIES.size === 0) return false
  return TRUSTED_PROXIES.has(ip) || ip === '127.0.0.1' || ip === '::1'
}

function extractClientIp(request: NextRequest): string {
  if (TRUSTED_PROXIES.size === 0) {
    // SECURITY FIX: When no trusted proxies are configured, we cannot trust
    // ANY IP-related headers (x-real-ip, x-client-ip, x-forwarded-for) since
    // they can all be set by the client. Use a fixed key so rate limiting
    // still works (all users share one bucket). Deployers MUST configure
    // TRUSTED_PROXIES for per-IP rate limiting.
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

/** Generate a cryptographically random nonce for CSP.
 *  Uses Web Crypto API for Edge Runtime compatibility.
 */
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

export const config = {
  // SECURITY FIX: Expanded matcher to include all routes (not just API).
  // This allows per-request CSP nonce generation for page routes.
  // API-specific logic is guarded by the pathname check inside the middleware.
  matcher: ['/(.*)'],
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ─── Per-request CSP nonce for page routes ───────────────────────────
  // SECURITY FIX: Generate a unique nonce per request to make CSP effective.
  // Previously, the nonce was generated once at server startup in next.config.ts,
  // making it static and useless. Now we generate it here (per-request) and
  // replace the {NONCE} placeholder in the CSP header.
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/_next/')) {
    const nonce = generateNonce()
    const response = NextResponse.next()
    // Replace the {NONCE} placeholder in the CSP header set by next.config.ts
    const csp = response.headers.get('Content-Security-Policy')
    if (csp) {
      response.headers.set('Content-Security-Policy', csp.replace(/{NONCE}/g, nonce))
    }
    // Expose nonce to server components via a custom header
    response.headers.set('X-CSP-Nonce', nonce)
    return response
  }

  // ─── API route handling ──────────────────────────────────────────────
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  const ip = extractClientIp(request)

  const method = request.method
  // SECURITY FIX (SEC-101): Replace the previous two-regex normalization that only
  // matched IDs with digits+hyphens or pure digits. Many valid bot IDs (e.g., "abc",
  // "mybot", "bot1") were not normalized, causing rate limit config patterns like
  // /\/:id\/env-vars\/reveal$/ to not match, effectively bypassing strict rate limits.
  // Now we normalize ANY segment after /api/bots/ to :id, which covers all ID formats.
  const normalizedPathname = pathname
    .replace(/\/api\/bots\/([a-zA-Z0-9._-]+)(?=\/|$)/g, '/api/bots/:id')
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

    // SECURITY NOTE: EventSource API cannot set custom headers, so we fall back
    // to a query parameter token for SSE log streaming. This is a known trade-off:
    // the token may appear in browser history, server logs, and Referer headers.
    // Mitigations: (1) Only allowed on /logs/stream endpoints, (2) token is
    // httpOnly session token with limited TTL, (3) consider implementing one-time
    // short-lived tokens for SSE in the future.
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

  if (pathname.includes('/logs/stream')) {
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    response.headers.set('Pragma', 'no-cache')
  }

  return response
}
