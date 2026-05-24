import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { validateBotId } from '@/lib/validation'
import { getCurrentUserId, isBotOwner } from '@/lib/api-helpers'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'

/**
 * GET /api/bots/[id]/logs/stream
 *
 * Server-Sent Events (SSE) endpoint for real-time log streaming.
 * The frontend's LogsTab component connects via EventSource to receive
 * live log updates. This endpoint:
 *
 * 1. Validates the bot exists (with retry to handle race condition after creation)
 * 2. Sends 2KB padding to flush reverse-proxy buffers (otherwise proxies
 *    like nginx/CloudFlare buffer until the buffer is full, causing "pending")
 * 3. Sends initial catch-up logs from the DB
 * 4. Subscribes to EventBus for instant log push (replaces DB polling)
 * 5. Keeps the connection alive with periodic heartbeat events
 * 6. Uses a fallback DB poll every 30s as a safety net for missed events
 *
 * P1 OPT: Replaced 3-second DB polling with EventBus subscription.
 * Previously, every SSE connection polled BotLog every 3 seconds, causing:
 *   - O(n) DB queries per bot per 3s (n = active SSE connections)
 *   - Up to 3-second latency for new log entries
 *   - Significant DB load under multiple concurrent viewers
 * Now, POST /api/bots/[id]/logs emits to EventBus, and this endpoint
 * receives events instantly with zero DB queries in the hot path.
 * A 30-second fallback poll catches any missed events.
 */

// How many initial log entries to send on connection
const INITIAL_LOG_FETCH_COUNT = 200

// Fallback poll interval for missed EventBus events (ms)
// P1 OPT: Increased from 3000ms to 30000ms since EventBus handles real-time delivery.
// This is purely a safety net — in normal operation, EventBus delivers all events.
const FALLBACK_POLL_INTERVAL = 30000

// Heartbeat interval to keep the connection alive (ms)
const HEARTBEAT_INTERVAL = 15000

// Maximum connection duration (30 minutes) to prevent resource leaks
const MAX_CONNECTION_DURATION = 30 * 60 * 1000

// How long to wait for bot to appear in DB after creation (race condition fix)
// P1-BUG-1 FIX: Reduced from 5000ms to 2000ms to avoid blocking the SSE response too long.
// In high-concurrency scenarios, many simultaneous hung connections could exhaust resources.
const BOT_APPEAR_WAIT_MS = 2000
const BOT_APPEAR_POLL_MS = 200

// Proxy buffer padding: 2KB of SSE comments to force reverse proxies to flush.
// Many proxies (nginx, CloudFlare, ALB) buffer the first 1-4KB of a response
// before forwarding it to the client. SSE comments (lines starting with ':')
// are silently ignored by EventSource per the SSE spec, so this padding is
// invisible to the frontend but forces the proxy to start streaming immediately.
const PROXY_PADDING = ': ' + '0'.repeat(2048) + '\n\n'

// SECURITY FIX: Global active SSE connection counter to prevent resource exhaustion.
// Without this limit, a single client (or distributed attack) could open multiple
// long-lived connections, each consuming server resources (memory, CPU).
const MAX_GLOBAL_SSE_CONNECTIONS = 50
const MAX_SSE_CONNECTIONS_PER_USER = 5
let activeSSEConnections = 0
const activeSSEConnectionsByUser = new Map<string, number>()

function incrementSSECounters(userId: string): void {
  activeSSEConnections++
  const uc = activeSSEConnectionsByUser.get(userId) || 0
  activeSSEConnectionsByUser.set(userId, uc + 1)
}

function decrementSSECounters(userId: string): void {
  activeSSEConnections = Math.max(0, activeSSEConnections - 1)
  const uc = activeSSEConnectionsByUser.get(userId) || 1
  activeSSEConnectionsByUser.set(userId, Math.max(0, uc - 1))
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // BUG FIX (BUG-1): Wrap params resolution in try/catch for consistency
  // with other routes (webhook, bots/[id]). If params rejects, return a
  // structured 400 response instead of an unhandled 500.
  let id: string
  try {
    const resolved = await params
    id = resolved.id
  } catch (error) {
    logger.error('log-stream', 'Error resolving params', error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const idErrors = validateBotId(id)
  if (idErrors.length > 0) {
    return new Response(JSON.stringify({ error: idErrors[0].message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // SECURITY FIX: Enforce global SSE connection limit to prevent resource exhaustion.
  if (activeSSEConnections >= MAX_GLOBAL_SSE_CONNECTIONS) {
    return new Response(JSON.stringify({
      error: `Too many active SSE connections (${activeSSEConnections}/${MAX_GLOBAL_SSE_CONNECTIONS}). Please try again later.`,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    })
  }

  // P2-11 FIX: Authenticate BEFORE any DB query to avoid wasting DB resources on unauthenticated requests.
  const userId = await getCurrentUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Per-user connection limit check (before incrementing global counter)
  const userConns = activeSSEConnectionsByUser.get(userId) || 0
  if (userConns >= MAX_SSE_CONNECTIONS_PER_USER) {
    return new Response(JSON.stringify({
      error: 'Too many SSE connections for this user',
    }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } })
  }

  // Now safe to increment both counters
  activeSSEConnections++
  activeSSEConnectionsByUser.set(userId, userConns + 1)

  // BUG FIX (BUG-103): Wrap DB queries in try/catch to ensure activeSSEConnections
  // is decremented if the DB is unreachable. Previously, if db.bot.findUnique
  // threw, the counter was incremented but never decremented, eventually
  // exhausting the connection limit and blocking all SSE connections.
  let ownershipBot
  try {
    ownershipBot = await db.bot.findUnique({ where: { id }, select: { ownerId: true } })
    if (!ownershipBot) {
      const startTime = Date.now()
      while (Date.now() - startTime < BOT_APPEAR_WAIT_MS) {
        await new Promise(r => setTimeout(r, BOT_APPEAR_POLL_MS))
        ownershipBot = await db.bot.findUnique({ where: { id }, select: { ownerId: true } })
        if (ownershipBot) break
      }
    }
  } catch (error) {
    logger.error('log-stream', `DB error checking ownership for bot ${id}`, error instanceof Error ? error.message : String(error))
    activeSSEConnections--
    const uc = activeSSEConnectionsByUser.get(userId) || 1
    activeSSEConnectionsByUser.set(userId, Math.max(0, uc - 1))
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
  }

  if (!ownershipBot || !isBotOwner(ownershipBot.ownerId, userId)) {
    activeSSEConnections--
    const uc = activeSSEConnectionsByUser.get(userId) || 1
    activeSSEConnectionsByUser.set(userId, Math.max(0, uc - 1))
    return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
  }

  // Set up SSE response stream
  const encoder = new TextEncoder()

  // BUG FIX (BUG-102): Register abort listener BEFORE any async operations.
  let streamClosed = false
  let pendingTimers: {
    poll?: ReturnType<typeof setInterval>
    heartbeat?: ReturnType<typeof setInterval>
    maxDuration?: ReturnType<typeof setTimeout>
  } = {}
  let pendingSubscription: { unsubscribe: () => void } | null = null

  const cleanup = () => {
    if (pendingTimers.poll) clearInterval(pendingTimers.poll)
    if (pendingTimers.heartbeat) clearInterval(pendingTimers.heartbeat)
    if (pendingTimers.maxDuration) clearTimeout(pendingTimers.maxDuration)
    if (pendingSubscription) pendingSubscription.unsubscribe()
  }

  const decrementCounters = () => {
    decrementSSECounters(userId)
  }

  try {
    request.signal.addEventListener('abort', () => {
      if (streamClosed) return
      streamClosed = true
      decrementCounters()
      cleanup()
    })
  } catch (e) {
    logger.error('log-stream', `Failed to register abort listener for ${id}`, e instanceof Error ? e.message : e)
  }

  const stream = new ReadableStream({
    start(controller) {
      // Helper to safely close and decrement the global connection counter
      const closeConnection = () => {
        if (!closed && !streamClosed) {
          closed = true
          streamClosed = true
          decrementCounters()
        }
      }

      // Helper to send SSE events
      const sendEvent = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          )
        } catch {
          // Controller may be closed
        }
      }

      // Track the last log timestamp we've sent to avoid duplicates
      const sentLogIds = new Set<string>()
      const MAX_SENT_LOG_IDS = 500
      let lastSentTimestamp = new Date(0)
      let closed = false

      // If already aborted (client disconnected while we were setting up), bail out
      if (streamClosed) {
        try { controller.close() } catch { /* already closed */ }
        return
      }

      // CRITICAL: Send 2KB padding FIRST to flush reverse-proxy buffers.
      try {
        controller.enqueue(encoder.encode(PROXY_PADDING))
      } catch {
        closeConnection()
        return
      }

      // Send initial "connected" event so the frontend knows SSE is alive
      sendEvent('connected', { botId: id, message: 'SSE connection established' })

      // Fetch and send initial catch-up logs from DB
      // P2-BUG-4 FIX: Chain subscription setup AFTER initial fetch completes.
      ;(async () => {
        try {
          const initialLogs = await db.botLog.findMany({
            where: { botId: id },
            orderBy: { timestamp: 'desc' },
            take: INITIAL_LOG_FETCH_COUNT,
          })

          // Send in chronological order (oldest first)
          const sorted = [...initialLogs].reverse()
          for (const log of sorted) {
            if (closed || streamClosed) break
            sentLogIds.add(log.id)
            if (sentLogIds.size > MAX_SENT_LOG_IDS) {
              const oldest = sentLogIds.values().next().value
              if (oldest) sentLogIds.delete(oldest)
            }
            lastSentTimestamp = log.timestamp
            sendEvent('log', {
              id: log.id,
              botId: log.botId,
              level: log.level,
              message: log.message,
              source: log.source,
              timestamp: log.timestamp.toISOString(),
            })
          }
        } catch (error) {
          logger.error('log-stream', `Error fetching initial logs for ${id}`, error instanceof Error ? error.message : String(error))
        }

        // P2-BUG-4 FIX: Start subscription AFTER initial fetch completes.
        if (closed || streamClosed) return

        // P1 OPT: Subscribe to EventBus for instant log push.
        // POST /api/bots/[id]/logs now emits 'log' events to the bus,
        // so we receive new logs instantly without polling the DB.
        const channel = `bot:${id}`
        const subscription = eventBus.subscribe(channel, (event, data) => {
          if (closed || streamClosed) return

          if (event === 'log') {
            const logData = data as { id: string; botId: string; level: string; message: string; source: string; timestamp: string }
            if (sentLogIds.has(logData.id)) return
            sentLogIds.add(logData.id)

            sendEvent('log', logData)
          } else if (event === 'status') {
            sendEvent('status', data)
          } else if (event === 'deleted') {
            sendEvent('deleted', data)
            closeConnection()
            cleanup()
            try { controller.close() } catch { /* already closed */ }
          }
        })
        pendingSubscription = subscription

        // Fallback: Poll DB every 30s to catch any missed EventBus events.
        // This is a safety net — in normal operation, EventBus delivers all events.
        // Events can be missed if log creation happens in a different process
        // (e.g., serverless) or if the EventBus channel limit is reached.
        if (streamClosed) return
        const fallbackTimer = setInterval(async () => {
          if (closed || streamClosed) return
          try {
            const newLogs = await db.botLog.findMany({
              where: {
                botId: id,
                timestamp: { gt: lastSentTimestamp },
              },
              orderBy: { timestamp: 'asc' },
              take: 500,
            })

            for (const log of newLogs) {
              if (closed || streamClosed) break
              if (sentLogIds.has(log.id)) continue
              sentLogIds.add(log.id)
              if (sentLogIds.size > MAX_SENT_LOG_IDS) {
                const oldest = sentLogIds.values().next().value
                if (oldest) sentLogIds.delete(oldest)
              }
              lastSentTimestamp = log.timestamp
              sendEvent('log', {
                id: log.id,
                botId: log.botId,
                level: log.level,
                message: log.message,
                source: log.source,
                timestamp: log.timestamp.toISOString(),
              })
            }
          } catch (error) {
            logger.error('log-stream', `Fallback poll error for ${id}`, error instanceof Error ? error.message : String(error))
          }
        }, FALLBACK_POLL_INTERVAL)
        pendingTimers.poll = fallbackTimer

        // Send heartbeat to keep connection alive (prevents proxy/load-balancer timeout)
        if (streamClosed) return
        const heartbeatTimer = setInterval(() => {
          if (closed || streamClosed) return
          try {
            controller.enqueue(encoder.encode(`:heartbeat\n\n`))
          } catch {
            closeConnection()
            cleanup()
            try { controller.close() } catch { /* already closed */ }
          }
        }, HEARTBEAT_INTERVAL)
        pendingTimers.heartbeat = heartbeatTimer

        // Maximum connection duration safety net
        if (streamClosed) return
        const maxDurationTimer = setTimeout(() => {
          if (closed || streamClosed) return
          sendEvent('error', { message: 'Connection timeout, please reconnect' })
          closeConnection()
          cleanup()
          try { controller.close() } catch { /* already closed */ }
        }, MAX_CONNECTION_DURATION)
        pendingTimers.maxDuration = maxDurationTimer
      })()
    },
    cancel() {
      if (!streamClosed) {
        streamClosed = true
        decrementCounters()
      }
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  })
}
