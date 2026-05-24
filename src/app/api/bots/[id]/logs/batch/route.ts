import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { validateBotId } from '@/lib/validation'
import { getCurrentUserId, isBotOwner } from '@/lib/api-helpers'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'

const MAX_MESSAGE_LENGTH = 10000
const MAX_SOURCE_LENGTH = 200
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'critical']
// SECURITY FIX (SEC-110): Reduced from 500 to 100 to mitigate DoS vector.
// With 30 req/min rate limit, 500 entries/request = 15,000 entries/min per IP.
// 100 entries/request = 3,000 entries/min, which is more reasonable.
const MAX_BATCH_SIZE = 100

/**
 * POST /api/bots/[id]/logs/batch
 *
 * Bulk-create log entries in a single request.
 * Replaces N individual POST /api/bots/[id]/logs calls with 1 batch call,
 * reducing HTTP overhead, DB connection churn, and Prisma query overhead.
 *
 * Body: { logs: Array<{ level: string; message: string; source?: string }> }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let id: string = 'unknown'
  try {
    const resolved = await params
    id = resolved.id

    const idErrors = validateBotId(id)
    if (idErrors.length > 0) {
      return NextResponse.json({ error: idErrors[0].message }, { status: 400 })
    }

    const userId = await getCurrentUserId(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const ownershipBot = await db.bot.findUnique({ where: { id }, select: { ownerId: true } })
    if (!ownershipBot || !isBotOwner(ownershipBot.ownerId, userId)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    let body: { logs?: unknown }
    try {
      const text = await request.text()
      if (!text.trim()) {
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 })
      }
      // BUG FIX (QUALITY-1): Use Buffer.byteLength() instead of text.length.
      // text.length counts UTF-16 code units, not actual bytes.
      // Consistent with login/route.ts and bots/route.ts.
      if (Buffer.byteLength(text, 'utf-8') > 5_000_000) {
        return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
      }
      body = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    if (!Array.isArray(body.logs)) {
      return NextResponse.json({ error: 'logs must be an array' }, { status: 400 })
    }

    if (body.logs.length === 0) {
      return NextResponse.json({ created: 0, logs: [] }, { status: 200 })
    }

    if (body.logs.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Batch too large: max ${MAX_BATCH_SIZE} entries per request` },
        { status: 413 },
      )
    }

    // Validate and sanitize each entry
    const entries: Array<{ botId: string; level: string; message: string; source: string }> = []
    for (let i = 0; i < body.logs.length; i++) {
      const entry = body.logs[i]
      if (!entry || typeof entry !== 'object') continue

      const level = typeof entry.level === 'string' && VALID_LOG_LEVELS.includes(entry.level)
        ? entry.level
        : 'info'
      const message = typeof entry.message === 'string'
        ? entry.message.slice(0, MAX_MESSAGE_LENGTH)
        : '(empty)'
      const source = typeof entry.source === 'string'
        ? entry.source.slice(0, MAX_SOURCE_LENGTH)
        : ''

      entries.push({ botId: id, level, message, source })
    }

    const createdLogs = await db.$transaction(async (tx) => {
      const before = new Date()
      const result = await tx.botLog.createMany({ data: entries })
      return tx.botLog.findMany({
        where: { botId: id, timestamp: { gte: before } },
        orderBy: { id: 'asc' },
      })
    })

    for (const log of createdLogs) {
      eventBus.emit(`bot:${id}`, 'log', {
        id: log.id,
        botId: id,
        level: log.level,
        message: log.message,
        source: log.source,
        timestamp: log.timestamp.toISOString(),
      })
    }

    return NextResponse.json({
      created: createdLogs.length,
      logs: createdLogs.map(log => ({
        id: log.id,
        botId: log.botId,
        level: log.level,
        message: log.message,
        source: log.source,
        timestamp: log.timestamp.toISOString(),
      })),
    }, { status: 201 })
  } catch (error) {
    logger.error('log-batch', `POST /api/bots/${id}/logs/batch error`, error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'Failed to create log entries' }, { status: 500 })
  }
}
