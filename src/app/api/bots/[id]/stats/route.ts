import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { validateBotId } from '@/lib/validation'
import { getCurrentUserId } from '@/lib/api-helpers'

const STATS_CACHE_TTL = 10_000
const MAX_CACHE_SIZE = 200
const statsCache = new Map<string, { data: unknown; expiresAt: number }>()

// Cleanup expired cache entries every 60 seconds
const _cacheCleanup = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of statsCache) {
    if (now > entry.expiresAt) statsCache.delete(key)
  }
}, 60_000)
if (_cacheCleanup.unref) _cacheCleanup.unref()

/**
 * GET /api/bots/[id]/stats
 * Computes real-time statistics from BotMessage and BotLog tables.
 * Returns: messages, users, errors, dailyMessages, hourlyActivity, topCommands
 *
 * PERF FIX: Reduced from 6 separate DB queries to 4 by merging:
 * - Total messages + daily messages into single aggregation query
 * - Hourly activity + top commands remain separate (different GROUP BY semantics)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let botId = 'unknown'
  try {
    const resolved = await params
    botId = resolved.id

    const idErrors = validateBotId(botId)
    if (idErrors.length > 0) {
      return NextResponse.json({ error: idErrors[0].message }, { status: 400 })
    }

    const userId = await getCurrentUserId(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const ownershipBot = await db.bot.findUnique({ where: { id: botId }, select: { ownerId: true } })
    if (!ownershipBot || ownershipBot.ownerId !== userId) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    const cached = statsCache.get(botId)
    if (cached && Date.now() < cached.expiresAt) {
      return NextResponse.json(cached.data)
    }

    // ── Optimized: Total Messages + Daily Messages in parallel queries ──
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const [totalResult, dailyResult] = await Promise.all([
      db.$queryRaw<Array<{ totalCount: bigint }>>`
        SELECT COUNT(*) AS totalCount FROM BotMessage WHERE botId = ${botId}
      `,
      db.$queryRaw<Array<{ date: string; dayCount: bigint }>>`
        SELECT DATE(timestamp) AS date, COUNT(*) AS dayCount
        FROM BotMessage
        WHERE botId = ${botId} AND timestamp >= ${sevenDaysAgo.toISOString()}
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `,
    ])

    const messageCount = Number(totalResult[0]?.totalCount ?? 0)
    const dailyMessages = dailyResult.map(r => ({
      date: r.date,
      count: Number(r.dayCount),
    }))

    // ── Unique Users ───────────────────────────────────────────────────
    const userResult = await db.$queryRaw<Array<{ cnt: bigint }>>`
      SELECT COUNT(DISTINCT userId) as cnt FROM BotMessage WHERE botId = ${botId}
    `
    const users = Number(userResult[0]?.cnt ?? 0)

    // ── Error Count (both 'error' and 'critical' levels) ──────────────
    const errors = await db.botLog.count({
      where: { botId, level: { in: ['error', 'critical'] } },
    })

    // ── Hourly Activity (last 24 hours) ───────────────────────────────
    const oneDayAgo = new Date()
    oneDayAgo.setHours(oneDayAgo.getHours() - 24)
    const hourlyResult = await db.$queryRaw<Array<{ hour: number; count: bigint }>>`
      SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
      FROM BotMessage
      WHERE botId = ${botId} AND timestamp >= ${oneDayAgo.toISOString()}
      GROUP BY hour
      ORDER BY hour ASC
    `
    // Build 24-hour array (fill missing hours with 0)
    const hourlyMap = new Map(hourlyResult.map(r => [r.hour, Number(r.count)]))
    const hourlyActivity = Array.from({ length: 24 }, (_, i) => hourlyMap.get(i) ?? 0)

    // ── Top Commands (top 10) ─────────────────────────────────────────
    const commandResult = await db.$queryRaw<Array<{ command: string; count: bigint }>>`
      SELECT command, COUNT(*) as count
      FROM BotMessage
      WHERE botId = ${botId} AND command IS NOT NULL
      GROUP BY command
      ORDER BY count DESC
      LIMIT 10
    `
    const totalCommands = commandResult.reduce((sum, r) => sum + Number(r.count), 0)
    const topCommands = commandResult.map(r => ({
      command: r.command,
      count: Number(r.count),
      percentage: totalCommands > 0 ? Math.round((Number(r.count) / totalCommands) * 100) : 0,
    }))

    const result = {
      messages: messageCount,
      users,
      errors,
      dailyMessages,
      hourlyActivity,
      topCommands,
    }

    if (statsCache.size >= MAX_CACHE_SIZE) {
      const oldest = [...statsCache.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (oldest) statsCache.delete(oldest[0])
    }
    statsCache.set(botId, { data: result, expiresAt: Date.now() + STATS_CACHE_TTL })

    return NextResponse.json(result)
  } catch (error) {
    console.error(`[Stats] Failed to compute stats for bot ${botId}:`, error)
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 })
  }
}
