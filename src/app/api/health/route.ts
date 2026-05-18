import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

/**
 * GET /api/health
 *
 * Lightweight health check endpoint for:
 * - Load balancers (AWS ALB, Nginx upstream checks)
 * - Monitoring systems (UptimeRobot, etc.)
 * - Docker/Kubernetes liveness probes
 * - PM2 auto-restart health monitoring
 *
 * Returns minimal status info — no sensitive data.
 */
export async function GET() {
  const startTime = Date.now()

  try {
    // Quick DB connectivity check (SELECT 1 equivalent)
    await db.$queryRaw`SELECT 1`

    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      // SECURITY FIX (SEC-104): Removed uptime field to prevent information
      // leakage. Server uptime could help attackers determine when in-memory
      // security state (rate limit counters, lockout state, HMAC fallback)
      // was last reset, enabling timed attacks after server restarts.
      responseTimeMs: Date.now() - startTime,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    })
  } catch (error) {
    return NextResponse.json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startTime,
      error: 'Service unavailable',
    }, { status: 503 })
  }
}
