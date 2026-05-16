/**
 * API Rate Limiting - Sliding Window Counter
 *
 * In-memory rate limiter using a sliding window algorithm.
 * No external dependencies required. Automatically cleans up expired entries.
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

// ─── Rate Limiter Class ──────────────────────────────────────────────────

/**
 * Sliding window counter rate limiter.
 *
 * Algorithm:
 * - Each key (IP address) gets a window counter
 * - When the window expires, the counter is proportionally decayed
 * - If the key exceeds max requests, it's rate-limited
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
      this.store.set(key, { count: 1, windowStart: now })
      return {
        success: true,
        remaining: config.max - 1,
        resetAt: now + config.window,
        limit: config.max,
      }
    }

    const elapsed = now - record.windowStart

    // Window has expired → reset counter
    if (elapsed >= config.window) {
      record.count = 1
      record.windowStart = now
      return {
        success: true,
        remaining: config.max - 1,
        resetAt: now + config.window,
        limit: config.max,
      }
    }

    // Window is still active → increment counter
    record.count++

    if (record.count > config.max) {
      return {
        success: false,
        remaining: 0,
        resetAt: record.windowStart + config.window,
        limit: config.max,
      }
    }

    return {
      success: true,
      remaining: config.max - record.count,
      resetAt: record.windowStart + config.window,
      limit: config.max,
    }
  }

  /**
   * Get current rate limit status without incrementing counter
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

    const remaining = Math.max(0, config.max - record.count)
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
    for (const [key, record] of this.store.entries()) {
      // Remove entries older than 10 minutes
      if (now - record.windowStart > 600) {
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
