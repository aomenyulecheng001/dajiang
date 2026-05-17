import { NextResponse } from 'next/server'
import { timingSafeEqual, createHash } from 'crypto'
import { db } from '@/lib/db'
import { BOT_RUNNER_URL } from '@/lib/bot-runner-url'
import { safeJsonParse } from '@/lib/api-helpers'

// SEC FIX: Track consecutive webhook failures per bot for alerting.
// Logs at ERROR level only when threshold is exceeded to avoid log flooding.
const WEBHOOK_FAILURE_ALERT_THRESHOLD = 10
const webhookFailureCounts = new Map<string, { count: number; lastFailureAt: number }>()

const _failureCleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const [botId, entry] of webhookFailureCounts) {
    if (now - entry.lastFailureAt > 30 * 60 * 1000) {
      webhookFailureCounts.delete(botId)
    }
  }
}, 10 * 60 * 1000)
if (_failureCleanupTimer.unref) _failureCleanupTimer.unref()

/**
 * Extract message data from a Telegram update and record it in BotMessage table.
 * Fire-and-forget: does not block the webhook response.
 * Tracks: messages count, unique users, command usage, timestamps for time-series.
 */
async function recordTelegramMessage(botId: string, update: Record<string, unknown>) {
  try {
    // Support message, edited_message, and callback_query
    const u = update as Record<string, unknown>
    const msg = (u.message || u.edited_message || (u as Record<string, unknown>).callback_query && ((u as Record<string, unknown>).callback_query as Record<string, unknown>).message) as Record<string, unknown> | undefined
    const fromRaw = (u.message || u.edited_message || (u as Record<string, unknown>).callback_query) as Record<string, unknown> | undefined
    const from = fromRaw ? (fromRaw as Record<string, unknown>).from as Record<string, unknown> | undefined : undefined

    if (!from || !msg) return

    const userId = String(from.id || '')
    const userName = [from.first_name, from.last_name].filter(Boolean).join(' ') as string || ''
    const text = String(msg.text || msg.caption || '')

    // Extract /command pattern (e.g., "/start", "/help@botname")
    let command: string | null = null
    if (text.startsWith('/')) {
      const match = text.match(/^\/(\w+)/)
      if (match) {
        command = '/' + match[1]
      }
    }

    await db.botMessage.create({
      data: {
        botId,
        userId,
        userName,
        text: text.slice(0, 1000), // Truncate long messages
        command,
      },
    })
  } catch (e) {
    // Non-critical: don't fail the webhook if stats recording fails
    console.warn(`[Webhook] Failed to record message for bot ${botId}:`, e instanceof Error ? e.message : e)
  }
}

/**
 * P1-1 FIX: Timing-safe string comparison to prevent timing attacks.
 * Regular `!==` comparison leaks information about string contents
 * through response time variations.
 */
function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8')
  const bBuf = Buffer.from(b, 'utf-8')
  // SECURITY FIX: Hash both values first, then compare hashes.
  // This eliminates timing differences from length mismatch.
  const aHash = createHash('sha256').update(aBuf).digest()
  const bHash = createHash('sha256').update(bBuf).digest()
  return timingSafeEqual(aHash, bHash)
}

/**
 * Get the webhookSecret for a bot from the database.
 * P1 OPT: Reads from dedicated webhookSecret column instead of parsing config JSON.
 * Falls back to config.webhookSecret for backward compatibility.
 * Returns null if the bot doesn't exist or has no secret.
 */
const WEBHOOK_SECRET_CACHE_TTL = 5 * 60 * 1000
const webhookSecretCache = new Map<string, { secret: string | null; expiresAt: number }>()

const _secretCacheCleanup = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of webhookSecretCache) {
    if (now > entry.expiresAt) webhookSecretCache.delete(key)
  }
}, 60_000)
if (_secretCacheCleanup.unref) _secretCacheCleanup.unref()

async function getBotWebhookSecret(botId: string): Promise<string | null> {
  const cached = webhookSecretCache.get(botId)
  if (cached && Date.now() < cached.expiresAt) return cached.secret

  try {
    const bot = await db.bot.findUnique({
      where: { id: botId },
      select: { webhookSecret: true, config: true },
    })
    if (!bot) {
      webhookSecretCache.set(botId, { secret: null, expiresAt: Date.now() + WEBHOOK_SECRET_CACHE_TTL })
      return null
    }

    let secret: string | null
    if (bot.webhookSecret) {
      secret = bot.webhookSecret
    } else {
      const config = safeJsonParse(bot.config, {}) as Record<string, unknown>
      secret = (config.webhookSecret as string) || null
    }
    webhookSecretCache.set(botId, { secret, expiresAt: Date.now() + WEBHOOK_SECRET_CACHE_TTL })
    return secret
  } catch {
    return null
  }
}

// POST /api/webhook/[botId]
// Telegram sends updates here when webhook mode is configured.
// Forwards the update to the bot-runner service via HTTP.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ botId: string }> }
) {
  // BUG FIX (QUALITY-2): Move params resolution inside try/catch.
  // Previously, if params rejected (edge case), the error was unhandled
  // and would result in an unstructured 500 response. Other routes like
  // bots/[id]/route.ts wrap this in try/catch for consistency.
  let botId: string
  try {
    const resolved = await params
    botId = resolved.botId
  } catch (error) {
    console.error('[Webhook] Error resolving params:', error)
    return NextResponse.json({ ok: false, description: 'Invalid request' }, { status: 400 })
  }

  // Validate botId format (prevent path traversal)
  if (!botId || botId.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(botId)) {
    return NextResponse.json({ ok: false, description: 'Invalid bot ID' }, { status: 400 })
  }

  try {
    // ── P0-4 FIX: Verify Telegram secret_token header ──
    // Telegram sends the secret_token in the X-Telegram-Bot-Api-Secret-Token header.
    // If the bot has a webhookSecret configured, we MUST verify it.
    const secretFromHeader = request.headers.get('x-telegram-bot-api-secret-token')
    const storedSecret = await getBotWebhookSecret(botId)

    if (storedSecret) {
      // Bot has a webhookSecret configured — require matching header
      if (!secretFromHeader) {
         
        console.warn(`[Webhook] Rejected request for bot ${botId}: missing secret_token header`)
        return NextResponse.json(
          { ok: false, description: 'Missing secret_token header' },
          { status: 401 }
        )
      }
      if (!safeCompare(secretFromHeader, storedSecret)) {
         
        console.warn(`[Webhook] Rejected request for bot ${botId}: invalid secret_token`)
        return NextResponse.json(
          { ok: false, description: 'Invalid secret_token' },
          { status: 403 }
        )
      }
    }
    if (!storedSecret) {
      console.error(`[Webhook] REJECTED: Bot ${botId} has no webhookSecret configured. All webhook requests must be authenticated. Set a webhook secret for this bot.`)
      return NextResponse.json(
        { ok: false, description: 'Webhook not configured: missing secret_token. Set a webhook secret for this bot.' },
        { status: 401 }
      )
    }

    // Read the raw request body (Telegram sends JSON)
    // SECURITY: Limit body size to 100KB to prevent DoS via oversized payloads
    const MAX_WEBHOOK_BODY = 100 * 1024 // 100KB — generous for Telegram updates
    const body = await request.text()
    if (Buffer.byteLength(body, 'utf-8') > MAX_WEBHOOK_BODY) {
      return NextResponse.json({ ok: false, description: 'Request body too large' }, { status: 413 })
    }
    if (!body.trim()) {
      return NextResponse.json({ ok: false, description: 'Empty request body' }, { status: 400 })
    }

    // Validate it's valid JSON
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return NextResponse.json({ ok: false, description: 'Invalid JSON' }, { status: 400 })
    }

    // Record message data for stats (fire-and-forget, non-blocking)
    recordTelegramMessage(botId, parsed as Record<string, unknown>).catch(() => {})

    console.log(`[Webhook] Forwarding update for bot ${botId}`)

    // Forward to bot-runner service via HTTP
    try {
      const runnerUrl = `${BOT_RUNNER_URL}/webhook/${encodeURIComponent(botId)}`
      const response = await fetch(runnerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': storedSecret || '',
        },
        body: JSON.stringify(parsed),
        signal: AbortSignal.timeout(10000), // 10s timeout
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        const entry = webhookFailureCounts.get(botId) || { count: 0, lastFailureAt: 0 }
        entry.count++
        entry.lastFailureAt = Date.now()
        webhookFailureCounts.set(botId, entry)
        if (entry.count >= WEBHOOK_FAILURE_ALERT_THRESHOLD && entry.count % WEBHOOK_FAILURE_ALERT_THRESHOLD === 0) {
          console.error(`[Webhook] ALERT: Bot ${botId} has ${entry.count} consecutive webhook failures (runner returned ${response.status}). Check bot-runner status!`)
        } else {
          console.warn(`[Webhook] Bot-runner returned ${response.status} for bot ${botId} (${entry.count} consecutive): ${errText}`)
        }
        return NextResponse.json(
          { ok: false, description: 'Bot-runner error, please retry' },
          { status: 502 }
        )
      }

      // Reset failure count on success
      webhookFailureCounts.delete(botId)
      return NextResponse.json({ ok: true, description: 'Webhook forwarded successfully' })
    } catch (fetchError) {
      const entry = webhookFailureCounts.get(botId) || { count: 0, lastFailureAt: 0 }
      entry.count++
      entry.lastFailureAt = Date.now()
      webhookFailureCounts.set(botId, entry)
      if (entry.count >= WEBHOOK_FAILURE_ALERT_THRESHOLD && entry.count % WEBHOOK_FAILURE_ALERT_THRESHOLD === 0) {
        console.error(`[Webhook] ALERT: Bot ${botId} has ${entry.count} consecutive webhook failures (runner unreachable). Check bot-runner process!`)
      } else {
        console.warn(`[Webhook] Failed to reach bot-runner for bot ${botId} (${entry.count} consecutive):`, fetchError instanceof Error ? fetchError.message : fetchError)
      }
      return NextResponse.json(
        { ok: false, description: 'Bot-runner unreachable, please retry' },
        { status: 503 }
      )
    }
  } catch (error) {
    const entry = webhookFailureCounts.get(botId) || { count: 0, lastFailureAt: 0 }
    entry.count++
    entry.lastFailureAt = Date.now()
    webhookFailureCounts.set(botId, entry)
    if (entry.count >= WEBHOOK_FAILURE_ALERT_THRESHOLD && entry.count % WEBHOOK_FAILURE_ALERT_THRESHOLD === 0) {
      console.error(`[Webhook] ALERT: Bot ${botId} has ${entry.count} consecutive processing errors.`)
    } else {
      console.error(`[Webhook] Error processing update for bot ${botId}:`, error)
    }
    return NextResponse.json(
      { ok: false, description: 'Internal error, please retry' },
      { status: 500 }
    )
  }
}

// GET /api/webhook/[botId] - Telegram webhook verification
export async function GET(
  request: Request,
  { params }: { params: Promise<{ botId: string }> }
) {
  // BUG FIX (QUALITY-2): Same as POST handler — wrap params in try/catch
  let botId: string
  try {
    const resolved = await params
    botId = resolved.botId
  } catch (error) {
    console.error('[Webhook GET] Error resolving params:', error)
    return NextResponse.json({ ok: false, description: 'Invalid request' }, { status: 400 })
  }

  if (!botId || botId.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(botId)) {
    return NextResponse.json({ ok: false, description: 'Invalid bot ID' }, { status: 400 })
  }

  // SECURITY FIX: Require webhook secret for GET endpoint too.
  // This prevents unauthenticated probing of bot existence and runner state.
  const storedSecret = await getBotWebhookSecret(botId)
  const secretFromHeader = request.headers.get('x-telegram-bot-api-secret-token')
  if (!storedSecret) {
    return NextResponse.json({ ok: false, description: 'Webhook not configured: missing secret_token' }, { status: 401 })
  }
  if (!secretFromHeader || !safeCompare(secretFromHeader, storedSecret)) {
    return NextResponse.json({ ok: false, description: 'Unauthorized' }, { status: 401 })
  }

  // Forward verification to bot-runner
  try {
    const url = new URL(request.url)
    const allowedParams = ['hub.mode', 'hub.challenge', 'hub.verify_token']
    const filteredParams = new URLSearchParams()
    for (const key of allowedParams) {
      const value = url.searchParams.get(key)
      if (value) filteredParams.set(key, value)
    }
    const qs = filteredParams.toString()
    const fullUrl = `${BOT_RUNNER_URL}/webhook/${encodeURIComponent(botId)}${qs ? '?' + qs : ''}`
    const response = await fetch(fullUrl, { signal: AbortSignal.timeout(5000) })
    const data = await response.json().catch(() => ({}))
    return NextResponse.json({ ok: true, botId, ...data })
  } catch {
    // Bot-runner not running — just confirm the endpoint exists
    return NextResponse.json({ ok: true, botId, description: 'Webhook endpoint is active' })
  }
}
