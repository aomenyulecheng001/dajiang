/**
 * API Rate Limiting - Sliding Window Counter
 *
 * In-memory rate limiter using a sliding window algorithm.
 * No external dependencies required. Automatically cleans up expired entries.
 *
 * Algorithm:
 * - Maintains current and previous window counters
 * - When checking, the effective count is: prevCount * (1 - elapsed/window) + currentCount
 * - This prevents the 2x burst allowed by fixed-window at window boundaries
 *
 * Usage:
 *   import { rateLimit } from '@/lib/rate-limit'
 *   const result = rateLimit.check(ip, { max: 60, window: 60 })
 *   if (!result.success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum number of requests allowed within the window */
  max: number
  /** Time window in seconds */
  window: number
}

export interface RateLimitResult {
  success: boolean
  remaining: number
  resetAt: number
  limit: number
}

interface WindowRecord {
  count: number
  windowStart: number
  prevCount: number
}

// ─── Default Rate Limit Configs ──────────────────────────────────────────

/** GET / read operations: 60 requests per minute */
export const RATE_LIMIT_GET: RateLimitConfig = { max: 60, window: 60 }

/** POST / write operations: 30 requests per minute */
export const RATE_LIMIT_POST: RateLimitConfig = { max: 30, window: 60 }

/** PUT / update operations: 30 requests per minute */
export const RATE_LIMIT_PUT: RateLimitConfig = { max: 30, window: 60 }

/** DELETE / destructive operations: 10 requests per minute */
export const RATE_LIMIT_DELETE: RateLimitConfig = { max: 10, window: 60 }

/** Runner actions (start/stop/restart): 5 requests per minute */
export const RATE_LIMIT_RUNNER: RateLimitConfig = { max: 5, window: 60 }

/** SSE streaming: 6 connections per minute (allows EventSource reconnection + multiple tabs) */
export const RATE_LIMIT_SSE: RateLimitConfig = { max: 6, window: 60 }

/** Service management: 3 requests per minute */
export const RATE_LIMIT_SERVICE: RateLimitConfig = { max: 3, window: 60 }

/** Auth login attempts: 5 requests per minute (brute-force protection) */
export const RATE_LIMIT_AUTH: RateLimitConfig = { max: 5, window: 60 }

/** Auth mutation endpoints (password reset, account update): 10 requests per minute */
export const RATE_LIMIT_AUTH_MUTATION: RateLimitConfig = { max: 10, window: 60 }

/** Runner token endpoint — needs generous limit because frontend re-fetches on every Socket.IO reconnection.
 *  The endpoint requires auth, so brute-force risk is low. 30/min allows frequent reconnections. */
export const RATE_LIMIT_RUNNER_TOKEN: RateLimitConfig = { max: 30, window: 60 }

/** P2-API-12 FIX: Env-var reveal endpoint — strict limit (returns decrypted secrets) */
export const RATE_LIMIT_REVEAL: RateLimitConfig = { max: 10, window: 60 }

/** SECURITY FIX (SEC-106): Git import endpoint — strict limit (triggers resource-intensive git clone) */
export const RATE_LIMIT_GIT_IMPORT: RateLimitConfig = { max: 3, window: 60 }

/** Webhook incoming updates: 200 per minute (Telegram can send rapidly) */
export const RATE_LIMIT_WEBHOOK: RateLimitConfig = { max: 200, window: 60 }

/** SECURITY FIX (S3): Internal API endpoints (revoke-check, token-version) —
 *  strict limit to prevent brute-force attacks on INTERNAL_API_SECRET.
 *  These endpoints are on PUBLIC_ROUTES (no session auth) and only protected
 *  by INTERNAL_API_SECRET, so a strict rate limit is critical. */
export const RATE_LIMIT_INTERNAL_API: RateLimitConfig = { max: 10, window: 60 }

// ─── Rate Limiter Class ──────────────────────────────────────────────────

/**
 * Sliding window counter rate limiter.
 *
 * Algorithm:
 * - Each key maintains current window count and previous window count
 * - Effective count = prevCount * (1 - elapsed/window) + currentCount
 * - When the current window expires, currentCount becomes prevCount and resets to 1
 * - This smoothly transitions between windows, preventing 2x burst at boundaries
 *
 * SECURITY NOTE (SEC-10): This in-memory rate limiter does not work in
 * multi-instance deployments. Each instance maintains its own counter,
 * so an attacker can multiply their allowed request rate by the number
 * of instances. For multi-instance deployments, use Redis-backed rate limiting.
 */
class RateLimiter {
  private store = new Map<string, WindowRecord>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // Cleanup stale entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000)
    // Ensure the timer doesn't prevent Node.js from exiting
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * Check if a request is allowed under the rate limit
   * @param key - Unique identifier (usually IP address)
   * @param config - Rate limit configuration
   */
  check(key: string, config: RateLimitConfig): RateLimitResult {
    if (this.store.size > 10000) {
      this.cleanup()
    }

    const now = Math.floor(Date.now() / 1000) // seconds
    const record = this.store.get(key)

    // No existing record → allow first request
    if (!record) {
      this.store.set(key, { count: 1, windowStart: now, prevCount: 0 })
      return {
        success: true,
        remaining: config.max - 1,
        resetAt: now + config.window,
        limit: config.max,
      }
    }

    const elapsed = now - record.windowStart

    // Window has expired → shift current to previous, start new window
    // FIX: When the window has fully expired, prevCount should be 0, not record.count.
    // The old window is completely in the past, so its requests should not affect
    // the new window's sliding count. Setting prevCount = record.count caused
    // users to be immediately rate-limited at the start of a new window.
    if (elapsed >= config.window) {
      record.prevCount = 0
      record.count = 1
      record.windowStart = now
      return {
        success: true,
        remaining: config.max - 1,
        resetAt: now + config.window,
        limit: config.max,
      }
    }

    // Calculate sliding window count: weighted previous + current
    // SECURITY FIX (M5): Use Math.round instead of Math.ceil to avoid
    // over-counting. Math.ceil could cause users to be rate-limited slightly
    // earlier than expected (e.g., prevCount=60, weight=0.01 → ceil(0.6)=1
    // instead of the more accurate round(0.6)=1, but for larger weights the
    // difference matters: ceil(0.3)=1 vs round(0.3)=0).
    const weight = 1 - (elapsed / config.window)
    const effectiveCount = Math.round(record.prevCount * weight) + record.count

    // BUG FIX (BUG-4): Check if request would exceed limit BEFORE incrementing.
    // Previously, record.count++ was called before the limit check, meaning
    // rejected requests still incremented the counter. This caused:
    // 1. Inflated count values making the next window's sliding calculation too aggressive
    // 2. Rejected requests "consuming" quota, making it harder for legitimate requests
    if (effectiveCount > config.max) {
      return {
        success: false,
        remaining: 0,
        resetAt: record.windowStart + config.window,
        limit: config.max,
      }
    }

    // Only increment counter for allowed requests
    record.count++

    return {
      success: true,
      remaining: Math.max(0, config.max - effectiveCount - 1),
      resetAt: record.windowStart + config.window,
      limit: config.max,
    }
  }

  /**
   * Get current rate limit status without incrementing counter.
   * BUG FIX: Now uses the same sliding window algorithm as check()
   * for consistent results. Previously used fixed-window count only.
   */
  peek(key: string, config: RateLimitConfig): RateLimitResult {
    const now = Math.floor(Date.now() / 1000)
    const record = this.store.get(key)

    if (!record) {
      return {
        success: true,
        remaining: config.max,
        resetAt: now + config.window,
        limit: config.max,
      }
    }

    const elapsed = now - record.windowStart
    if (elapsed >= config.window) {
      return {
        success: true,
        remaining: config.max,
        resetAt: now + config.window,
        limit: config.max,
      }
    }

    // BUG FIX: Use sliding window calculation consistent with check()
    const weight = 1 - (elapsed / config.window)
    const effectiveCount = Math.round(record.prevCount * weight) + record.count
    const remaining = Math.max(0, config.max - effectiveCount)
    return {
      success: remaining > 0,
      remaining,
      resetAt: record.windowStart + config.window,
      limit: config.max,
    }
  }

  /**
   * Reset rate limit for a specific key
   */
  reset(key: string): void {
    this.store.delete(key)
  }

  /**
   * Remove all expired entries to free memory
   */
  private cleanup(): void {
    const now = Math.floor(Date.now() / 1000)
    // SECURITY FIX (L5): Use dynamic threshold based on max window size (60s * 2 = 120s)
    // instead of hardcoded 600s. The maximum configured window is 60 seconds,
    // so entries older than 120 seconds are guaranteed to be expired.
    const maxAge = 120
    for (const [key, record] of this.store.entries()) {
      if (now - record.windowStart > maxAge) {
        this.store.delete(key)
      }
    }
  }

  /**
   * Destroy the rate limiter (cleanup timer)
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.store.clear()
  }
}

// ─── Singleton Export ────────────────────────────────────────────────────

export const rateLimit = new RateLimiter()

// ─── Route-based Config Resolver ─────────────────────────────────────────

/**
 * Get the rate limit config for a given route and method
 */
export function getRateLimitConfig(method: string, pathname: string): RateLimitConfig {
  // P2-API-12 FIX: Runner token endpoint — strict limit (returns decrypted secrets)
  // SECURITY FIX (SEC-101): Use [^/]+ instead of :id literal to match any bot ID format.
  // The middleware normalizes /api/bots/<id>/... to /api/bots/:id/..., but we also
  // match the un-normalized form as defense-in-depth.
  if (pathname.match(/\/api\/bots\/[^/]+\/env-vars\/reveal$/)) {
    return RATE_LIMIT_REVEAL
  }

  // P2-API-12 FIX: Runner token endpoint — strict limit
  if (pathname.match(/\/runner-token$/) || pathname === '/api/auth/runner-token') {
    return RATE_LIMIT_RUNNER_TOKEN
  }

  // SECURITY FIX (SEC-106): Git import — strict limit (triggers resource-intensive git clone)
  if (pathname === '/api/git-import') {
    return RATE_LIMIT_GIT_IMPORT
  }

  // Webhook incoming updates — generous limit (Telegram sends many updates)
  if (pathname.match(/\/api\/webhook\//)) {
    return RATE_LIMIT_WEBHOOK
  }

  // Auth login attempts — strict rate limit (brute-force protection)
  if (pathname.match(/\/api\/auth\/login$/)) {
    return RATE_LIMIT_AUTH
  }

  // SECURITY FIX (S3): Internal API endpoints — strict limit to prevent
  // brute-force attacks on INTERNAL_API_SECRET. These are public routes
  // protected only by the internal secret header.
  if (pathname === '/api/auth/token-version' || pathname === '/api/auth/revoke-check') {
    return RATE_LIMIT_INTERNAL_API
  }

  // Auth mutation endpoints (password reset, account update) — stricter than general POST
  if (pathname === '/api/auth/reset-password' || pathname === '/api/auth/update-account') {
    return RATE_LIMIT_AUTH_MUTATION
  }

  // Runner actions (start/stop/restart) - most restrictive
  if (pathname.match(/\/api\/bots\/[^/]+\/runner$/)) {
    if (method === 'POST') return RATE_LIMIT_RUNNER
    return RATE_LIMIT_GET
  }

  // SSE log streaming
  if (pathname.match(/\/api\/bots\/[^/]+\/logs\/stream$/)) {
    return RATE_LIMIT_SSE
  }

  // Service management
  if (pathname.includes('/api/bots/runner/start-service')) {
    return RATE_LIMIT_SERVICE
  }

  // Single bot operations
  if (pathname.match(/^\/api\/bots\/[^/]+$/)) {
    switch (method) {
      case 'GET': return RATE_LIMIT_GET
      case 'PUT': return RATE_LIMIT_PUT
      case 'DELETE': return RATE_LIMIT_DELETE
      default: return RATE_LIMIT_POST
    }
  }

  // Bot list operations
  if (pathname === '/api/bots') {
    switch (method) {
      case 'GET': return RATE_LIMIT_GET
      case 'POST': return RATE_LIMIT_POST
      default: return RATE_LIMIT_POST
    }
  }

  // Default: standard read limit
  return RATE_LIMIT_GET
}

/**
 * Generate rate limit HTTP headers
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  }
}
