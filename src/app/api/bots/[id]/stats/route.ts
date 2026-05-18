import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { validateBotId } from '@/lib/validation'
import { getCurrentUserId, isBotOwner } from '@/lib/api-helpers'

const STATS_CACHE_TTL = 10_000
const MAX_CACHE_SIZE = 200
const statsCache = new Map<string, { data: unknown; expiresAt: number }>()

// Cleanup expired cache entries every 60 seconds
const _cacheCleanup = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of statsCache) {
    if (now > entry.expiresAt) statsCache.delete(key)
  }
}, 10_000)
if (_cacheCleanup.unref) _cacheCleanup.unref()

/**
 * GET /api/bots/[id]/stats
 * Computes real-time statistics from BotMessage and BotLog tables.
 * Returns: messages, users, errors, dailyMessages, hourlyActivity, topCommands
 *
 * PERF FIX: Reduced from 5 separate DB queries (3 unbounded findMany + 2 count)
 * to 6 lightweight queries (1 count + 4 SQL aggregations + 1 count) — zero
 * rows loaded into application memory for aggregation.
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
    if (!ownershipBot || !isBotOwner(ownershipBot.ownerId, userId)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    const cached = statsCache.get(botId)
    if (cached && Date.now() < cached.expiresAt) {
      return NextResponse.json(cached.data)
    }

    // ── Optimized: Use SQL aggregation instead of loading all rows into memory ──
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const oneDayAgo = new Date()
    oneDayAgo.setHours(oneDayAgo.getHours() - 24)

    const [messageCount, dailyMessages, uniqueUserCount, errors, topCommands, hourlyRaw] = await Promise.all([
      db.botMessage.count({ where: { botId } }),
      db.$queryRaw<Array<{ date: string; count: number }>>`
        SELECT DATE(timestamp) as date, COUNT(*) as count
        FROM BotMessage
        WHERE botId = ${botId} AND timestamp >= ${sevenDaysAgo}
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `,
      db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT userId) as count
        FROM BotMessage
        WHERE botId = ${botId}
      `,
      db.botLog.count({
        where: { botId, level: { in: ['error', 'critical'] } },
      }),
      db.$queryRaw<Array<{ command: string; count: bigint }>>`
        SELECT command, COUNT(*) as count
        FROM BotMessage
        WHERE botId = ${botId} AND command IS NOT NULL
        GROUP BY command
        ORDER BY count DESC
        LIMIT 10
      `,
      db.$queryRaw<Array<{ hour: number; count: number }>>`
        SELECT CAST(STRFTIME('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
        FROM BotMessage
        WHERE botId = ${botId} AND timestamp >= ${oneDayAgo}
        GROUP BY hour
      `,
    ])

    const users = Number(uniqueUserCount[0]?.count ?? 0)

    const dailyMessagesResult = dailyMessages.map(r => ({ date: r.date, count: Number(r.count) }))

    const commandMap = new Map<string, number>()
    for (const row of topCommands) {
      commandMap.set(row.command, Number(row.count))
    }
    const totalCommands = [...commandMap.values()].reduce((s, c) => s + c, 0)
    const topCommandsResult = [...commandMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([command, count]) => ({
        command,
        count,
        percentage: totalCommands > 0 ? Math.round((count / totalCommands) * 100) : 0,
      }))

    const hourlyMap = new Map<number, number>()
    for (const row of hourlyRaw) {
      hourlyMap.set(Number(row.hour), Number(row.count))
    }
    const hourlyActivity = Array.from({ length: 24 }, (_, i) => hourlyMap.get(i) ?? 0)

    const result = {
      messages: messageCount,
      users,
      errors,
      dailyMessages: dailyMessagesResult,
      hourlyActivity,
      topCommands: topCommandsResult,
    }

    if (statsCache.size >= MAX_CACHE_SIZE) {
      const firstKey = statsCache.keys().next().value
      if (firstKey) statsCache.delete(firstKey)
    }
    statsCache.set(botId, { data: result, expiresAt: Date.now() + STATS_CACHE_TTL })

    return NextResponse.json(result)
  } catch (error) {
    console.error(`[Stats] Failed to compute stats for bot ${botId}:`, error)
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 })
  }
}
