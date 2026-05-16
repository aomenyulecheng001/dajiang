import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { validateBotId } from '@/lib/validation'
import { getCurrentUserId } from '@/lib/api-helpers'

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
 * 4. Keeps the connection alive with periodic heartbeat events
 * 5. Polls the DB for new log entries and streams them
 *
 * The real-time logs come from two sources:
 * - Runner logs: persisted to DB by bot-runner-context.tsx via POST /api/bots/{id}/logs
 * - SSE stream: this endpoint polls the DB and pushes new entries
 */

// How many initial log entries to send on connection
const INITIAL_LOG_FETCH_COUNT = 200

// Poll interval for new logs (ms)
const POLL_INTERVAL = 3000

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
// long-lived connections, each polling the DB every 3 seconds for up to 30 minutes,
// consuming significant server resources (memory, CPU, DB connections).
const MAX_GLOBAL_SSE_CONNECTIONS = 50
const MAX_SSE_CONNECTIONS_PER_USER = 5
let activeSSEConnections = 0
const activeSSEConnectionsByUser = new Map<string, number>()

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolved = await params
  const id = resolved.id

  const idErrors = validateBotId(id)
  if (idErrors.length > 0) {
    return new Response(JSON.stringify({ error: idErrors[0].message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // SECURITY FIX: Enforce global SSE connection limit to prevent resource exhaustion.
  // Each SSE connection holds a ReadableStream, 2 setInterval timers, and 1 setTimeout,
  // plus polls the DB every 3 seconds. Without this limit, an attacker could open
  // many connections and exhaust server resources.
  if (activeSSEConnections >= MAX_GLOBAL_SSE_CONNECTIONS) {
    return new Response(JSON.stringify({
      error: `Too many active SSE connections (${activeSSEConnections}/${MAX_GLOBAL_SSE_CONNECTIONS}). Please try again later.`,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    })
  }
  activeSSEConnections++

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
    console.error(`[SSE] DB error checking ownership for bot ${id}:`, error)
    activeSSEConnections--
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
  }

  const userId = await getCurrentUserId(request)
  if (!userId) {
    activeSSEConnections--
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userConns = activeSSEConnectionsByUser.get(userId) || 0
  if (userConns >= MAX_SSE_CONNECTIONS_PER_USER) {
    activeSSEConnections--
    return new Response(JSON.stringify({
      error: 'Too many SSE connections for this user',
    }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } })
  }
  activeSSEConnectionsByUser.set(userId, userConns + 1)
  if (!ownershipBot || ownershipBot.ownerId !== userId) {
    activeSSEConnections--
    const uc = activeSSEConnectionsByUser.get(userId) || 1
    activeSSEConnectionsByUser.set(userId, Math.max(0, uc - 1))
    return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
  }

  // Set up SSE response stream
  const encoder = new TextEncoder()

  // BUG FIX (BUG-102): Register abort listener BEFORE any async operations.
  // Previously, the abort listener was set up inside the async IIFE, AFTER
  // the initial fetch and timer setup. If the client disconnected during the
  // initial fetch, the abort event had already fired but the listener wasn't
  // registered yet, causing timers to leak until MAX_CONNECTION_DURATION.
  let streamClosed = false
  let pendingTimers: { poll?: ReturnType<typeof setInterval>; heartbeat?: ReturnType<typeof setInterval>; maxDuration?: ReturnType<typeof setTimeout> } = {}

  try {
    request.signal.addEventListener('abort', () => {
      if (streamClosed) return
      streamClosed = true
      activeSSEConnections--
      const uc = activeSSEConnectionsByUser.get(userId) || 1
      activeSSEConnectionsByUser.set(userId, Math.max(0, uc - 1))
      if (pendingTimers.poll) clearInterval(pendingTimers.poll)
      if (pendingTimers.heartbeat) clearInterval(pendingTimers.heartbeat)
      if (pendingTimers.maxDuration) clearTimeout(pendingTimers.maxDuration)
    })
  } catch {
    // signal.addEventListener may not be available in all runtimes
  }

  const stream = new ReadableStream({
    // BUG FIX (BUG-103): Wrap start callback in try/catch to ensure
    // activeSSEConnections is decremented if an error occurs after
    // the counter was incremented but before closeConnection is set up.
    start(controller) {
      // Helper to safely close and decrement the global connection counter
      const closeConnection = () => {
        if (!closed && !streamClosed) {
          closed = true
          streamClosed = true
          activeSSEConnections--
          const uc = activeSSEConnectionsByUser.get(userId) || 1
          activeSSEConnectionsByUser.set(userId, Math.max(0, uc - 1))
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
      let lastSentTimestamp = new Date()
      let closed = false

      // If already aborted (client disconnected while we were setting up), bail out
      if (streamClosed) {
        try { controller.close() } catch { /* already closed */ }
        return
      }

      // CRITICAL: Send 2KB padding FIRST to flush reverse-proxy buffers.
      // Without this, the proxy holds the entire response until its internal
      // buffer (typically 4-8KB) fills up, causing the browser EventSource
      // to show "pending" for minutes before receiving any data.
      try {
        controller.enqueue(encoder.encode(PROXY_PADDING))
      } catch {
        // Controller closed before we could send anything
        closeConnection()
        return
      }

      // Send initial "connected" event so the frontend knows SSE is alive
      sendEvent('connected', { botId: id, message: 'SSE connection established' })

      // Fetch and send initial catch-up logs from DB
      // P2-BUG-4 FIX: Chain poll timer setup AFTER initial fetch completes.
      // Previously, the poll timer started immediately, so the first poll could
      // fire before initial logs were fetched, causing duplicate entries.
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
            sendEvent('log', {
              id: log.id,
              botId: log.botId,
              level: log.level,
              message: log.message,
              source: log.source,
              timestamp: log.timestamp.toISOString(),
            })
          }

          // Update lastSentTimestamp to the most recent log
          if (sorted.length > 0) {
            lastSentTimestamp = sorted[sorted.length - 1].timestamp
          }
        } catch (error) {
          console.error(`[SSE] Error fetching initial logs for ${id}:`, error)
        }

        // P2-BUG-4 FIX: Start poll timer AFTER initial fetch completes.
        // This prevents the first poll from sending duplicate entries that
        // were already sent in the initial catch-up batch.
        if (closed || streamClosed) return

        // Poll for new logs periodically
        const pollTimer = setInterval(async () => {
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
              sendEvent('log', {
                id: log.id,
                botId: log.botId,
                level: log.level,
                message: log.message,
                source: log.source,
                timestamp: log.timestamp.toISOString(),
              })
              lastSentTimestamp = log.timestamp
            }
          } catch (error) {
            console.error(`[SSE] Error polling logs for ${id}:`, error)
          }
        }, POLL_INTERVAL)
        pendingTimers.poll = pollTimer

        // Send heartbeat to keep connection alive (prevents proxy/load-balancer timeout)
        const heartbeatTimer = setInterval(() => {
          if (closed || streamClosed) return
          try {
            controller.enqueue(encoder.encode(`:heartbeat\n\n`))
          } catch {
            closeConnection()
            clearInterval(pollTimer)
            clearInterval(heartbeatTimer)
            clearTimeout(maxDurationTimer)
            try { controller.close() } catch { /* already closed */ }
          }
        }, HEARTBEAT_INTERVAL)
        pendingTimers.heartbeat = heartbeatTimer

        // Maximum connection duration safety net
        const maxDurationTimer = setTimeout(() => {
          if (closed || streamClosed) return
          sendEvent('error', { message: 'Connection timeout, please reconnect' })
          closeConnection()
          clearInterval(pollTimer)
          clearInterval(heartbeatTimer)
          try { controller.close() } catch { /* already closed */ }
        }, MAX_CONNECTION_DURATION)
        pendingTimers.maxDuration = maxDurationTimer
      })()
    },
    cancel() {
      if (!streamClosed) {
        streamClosed = true
        activeSSEConnections--
      }
      if (pendingTimers.poll) clearInterval(pendingTimers.poll)
      if (pendingTimers.heartbeat) clearInterval(pendingTimers.heartbeat)
      if (pendingTimers.maxDuration) clearTimeout(pendingTimers.maxDuration)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  })
}
