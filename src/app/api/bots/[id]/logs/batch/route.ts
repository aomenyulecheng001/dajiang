import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { validateBotId } from '@/lib/validation'

const MAX_MESSAGE_LENGTH = 10000
const MAX_SOURCE_LENGTH = 200
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'critical']
const MAX_BATCH_SIZE = 500

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

    const bot = await db.bot.findUnique({ where: { id }, select: { id: true } })
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    let body: { logs?: unknown }
    try {
      const text = await request.text()
      if (!text.trim()) {
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 })
      }
      if (text.length > 5_000_000) {
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

    // PERF FIX: Single bulk insert instead of N individual creates.
    // Uses createMany which maps to a single INSERT statement in SQLite.
    // Note: skipDuplicates is not supported in SQLite (PG/MySQL only).
    // Duplicate IDs are unlikely in practice (batch-generated with timestamps).
    const result = await db.botLog.createMany({
      data: entries,
    })

    return NextResponse.json({
      created: result.count,
      logs: entries.map((e, idx) => ({
        id: `batch-${Date.now()}-${idx}`,
        ...e,
        timestamp: new Date().toISOString(),
      })),
    }, { status: 201 })
  } catch (error) {
    console.error(`POST /api/bots/${id}/logs/batch error:`, error)
    return NextResponse.json({ error: 'Failed to create log entries' }, { status: 500 })
  }
}
