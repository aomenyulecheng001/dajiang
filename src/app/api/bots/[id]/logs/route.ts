import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { validateBotId } from '@/lib/validation'
import { getCurrentUserId } from '@/lib/api-helpers'

const MAX_MESSAGE_LENGTH = 10000
const MAX_SOURCE_LENGTH = 200
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'critical']

/**
 * POST /api/bots/[id]/logs
 *
 * Create a new log entry for a bot.
 * Called by the frontend persistLogEntry function.
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
    if (!ownershipBot || ownershipBot.ownerId !== userId) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    let body: { level?: unknown; message?: unknown; source?: unknown }
    try {
      const text = await request.text()
      if (!text.trim()) {
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 })
      }
      // BUG FIX (QUALITY-1): Use Buffer.byteLength() instead of text.length.
      // text.length counts UTF-16 code units, not actual bytes.
      // Consistent with login/route.ts and bots/route.ts.
      if (Buffer.byteLength(text, 'utf-8') > 1_000_000) {
        return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
      }
      body = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    // Validate required fields
    if (!body.level || typeof body.level !== 'string') {
      return NextResponse.json({ error: 'level is required and must be a string' }, { status: 400 })
    }

    if (!VALID_LOG_LEVELS.includes(body.level as string)) {
      return NextResponse.json({ error: `level must be one of: ${VALID_LOG_LEVELS.join(', ')}` }, { status: 400 })
    }

    if (!body.message || typeof body.message !== 'string') {
      return NextResponse.json({ error: 'message is required and must be a string' }, { status: 400 })
    }

    const level = body.level as string
    const message = (body.message as string).slice(0, MAX_MESSAGE_LENGTH)
    const source = typeof body.source === 'string' ? (body.source as string).slice(0, MAX_SOURCE_LENGTH) : ''

    // NOTE: Old log cleanup is handled by a scheduled task, not on every write.
    // This avoids unnecessary DB load on high-frequency log endpoints.

    const logEntry = await db.botLog.create({
      data: {
        botId: id,
        level,
        message,
        source,
      },
    })

    return NextResponse.json({
      id: logEntry.id,
      botId: logEntry.botId,
      level: logEntry.level,
      message: logEntry.message,
      source: logEntry.source,
      timestamp: logEntry.timestamp.toISOString(),
    }, { status: 201 })
  } catch (error) {
    console.error(`POST /api/bots/${id}/logs error:`, error)
    return NextResponse.json({ error: 'Failed to create log entry' }, { status: 500 })
  }
}

/**
 * GET /api/bots/[id]/logs
 *
 * Query log entries for a bot.
 * Called by the frontend fetchBotLogs function.
 */
export async function GET(
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
    if (!ownershipBot || ownershipBot.ownerId !== userId) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '200', 10) || 200))
    const levelFilter = searchParams.get('level')
    const includeTotal = searchParams.get('includeTotal') === 'true'
    // PERF FIX: Support `since` parameter for incremental log fetching.
    // When provided, only returns logs with timestamp > since (ISO 8601 string).
    // This enables the frontend to poll for new logs without re-fetching the entire set.
    // DEFENSIVE: Validate format and length to prevent abuse with malformed inputs.
    const sinceParam = searchParams.get('since')
    const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2}))?$/

    const where: { botId: string; level?: string; timestamp?: { gt?: Date } } = { botId: id }
    if (levelFilter && VALID_LOG_LEVELS.includes(levelFilter)) {
      where.level = levelFilter
    }
    if (sinceParam) {
      // Reject overly long or non-ISO-format values before attempting Date parsing
      if (sinceParam.length > 40 || !ISO_8601_PATTERN.test(sinceParam)) {
        return NextResponse.json({ error: 'Invalid "since" parameter. Expected ISO 8601 date.' }, { status: 400 })
      }
      const sinceDate = new Date(sinceParam)
      if (!isNaN(sinceDate.getTime())) {
        where.timestamp = { gt: sinceDate }
      }
    }

    const logs = await db.botLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
    })

    const formattedLogs = logs.map(l => ({
      id: l.id,
      botId: l.botId,
      level: l.level,
      message: l.message,
      source: l.source,
      timestamp: l.timestamp.toISOString(),
    }))

    if (includeTotal) {
      const total = await db.botLog.count({ where })
      return NextResponse.json({
        logs: formattedLogs,
        total,
      })
    }

    return NextResponse.json({
      logs: formattedLogs,
    })
  } catch (error) {
    console.error(`GET /api/bots/${id}/logs error:`, error)
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 })
  }
}
