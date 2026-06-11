import { NextRequest, NextResponse } from 'next/server'
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
 * SECURITY FIX (M6): Distinguish between internal (authenticated) and
 * external (unauthenticated) health checks. External checks receive only
 * a minimal status indicator without responseTimeMs (which could reveal
 * DB load patterns for timing attacks) or degraded details.
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now()

  // Check if this is an internal request (has auth header)
  const authHeader = request.headers.get('authorization')
  const isInternal = authHeader?.startsWith('Bearer ') || request.headers.get('x-internal-check') === 'true'

  try {
    // Quick DB connectivity check (SELECT 1 equivalent)
    await db.$queryRaw`SELECT 1`

    if (isInternal) {
      // Internal: return detailed status for monitoring systems
      return NextResponse.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        responseTimeMs: Date.now() - startTime,
      }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      })
    }

    // External: minimal response — no timing info, no details
    return NextResponse.json({
      status: 'ok',
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    })
  } catch (error) {
    if (isInternal) {
      return NextResponse.json({
        status: 'degraded',
        timestamp: new Date().toISOString(),
        responseTimeMs: Date.now() - startTime,
        error: 'Service unavailable',
      }, { status: 503 })
    }

    // External: don't reveal why it's unhealthy
    return NextResponse.json({
      status: 'error',
    }, { status: 503 })
  }
}
