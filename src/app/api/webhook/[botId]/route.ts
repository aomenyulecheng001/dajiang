import { NextResponse } from 'next/server'
import { timingSafeEqual, createHash } from 'crypto'
import { db } from '@/lib/db'
import { BOT_RUNNER_URL } from '@/lib/bot-runner-url'
import { safeJsonParse } from '@/lib/api-helpers'

// SEC FIX: Track consecutive webhook failures per bot for alerting.
// Logs at ERROR level only when threshold is exceeded to avoid log flooding.
const WEBHOOK_FAILURE_ALERT_THRESHOLD = 10
const webhookFailureCounts = new Map<string, number>()

// Cleanup stale failure counts every 10 minutes to prevent unbounded memory growth
const _failureCleanupTimer = setInterval(() => {
  webhookFailureCounts.clear()
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
async function getBotWebhookSecret(botId: string): Promise<string | null> {
  try {
    const bot = await db.bot.findUnique({
      where: { id: botId },
      select: { webhookSecret: true, config: true },
    })
    if (!bot) return null

    // P1 OPT: Use dedicated column first (no JSON.parse needed)
    if (bot.webhookSecret) return bot.webhookSecret

    // Fallback: check config JSON for legacy data
    const config = safeJsonParse(bot.config, {}) as Record<string, unknown>
    return (config.webhookSecret as string) || null
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
  const { botId } = await params

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
        const count = (webhookFailureCounts.get(botId) || 0) + 1
        webhookFailureCounts.set(botId, count)
        if (count >= WEBHOOK_FAILURE_ALERT_THRESHOLD && count % WEBHOOK_FAILURE_ALERT_THRESHOLD === 0) {
          console.error(`[Webhook] 🔴 ALERT: Bot ${botId} has ${count} consecutive webhook failures (runner returned ${response.status}). Check bot-runner status!`)
        } else {
          console.warn(`[Webhook] Bot-runner returned ${response.status} for bot ${botId} (${count} consecutive): ${errText}`)
        }
        return NextResponse.json({ ok: true, description: 'Webhook forwarded (bot may not be running)' })
      }

      // Reset failure count on success
      webhookFailureCounts.delete(botId)
      return NextResponse.json({ ok: true, description: 'Webhook forwarded successfully' })
    } catch (fetchError) {
      const count = (webhookFailureCounts.get(botId) || 0) + 1
      webhookFailureCounts.set(botId, count)
      if (count >= WEBHOOK_FAILURE_ALERT_THRESHOLD && count % WEBHOOK_FAILURE_ALERT_THRESHOLD === 0) {
        console.error(`[Webhook] 🔴 ALERT: Bot ${botId} has ${count} consecutive webhook failures (runner unreachable). Check bot-runner process!`)
      } else {
        console.warn(`[Webhook] Failed to reach bot-runner for bot ${botId} (${count} consecutive):`, fetchError instanceof Error ? fetchError.message : fetchError)
      }
      return NextResponse.json({ ok: true, description: 'Webhook forwarded (bot-runner unreachable)' })
    }
  } catch (error) {
    const count = (webhookFailureCounts.get(botId) || 0) + 1
    webhookFailureCounts.set(botId, count)
    if (count >= WEBHOOK_FAILURE_ALERT_THRESHOLD && count % WEBHOOK_FAILURE_ALERT_THRESHOLD === 0) {
      console.error(`[Webhook] 🔴 ALERT: Bot ${botId} has ${count} consecutive processing errors.`)
    } else {
      console.error(`[Webhook] Error processing update for bot ${botId}:`, error)
    }
    return NextResponse.json({ ok: true, description: 'Webhook received' })
  }
}

// GET /api/webhook/[botId] - Telegram webhook verification
export async function GET(
  request: Request,
  { params }: { params: Promise<{ botId: string }> }
) {
  const { botId } = await params

  if (!botId || botId.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(botId)) {
    return NextResponse.json({ ok: false, description: 'Invalid bot ID' }, { status: 400 })
  }

  // SECURITY FIX: Require webhook secret for GET endpoint too.
  // This prevents unauthenticated probing of bot existence and runner state.
  const storedSecret = await getBotWebhookSecret(botId)
  const secretFromHeader = request.headers.get('x-telegram-bot-api-secret-token')
  if (storedSecret) {
    if (!secretFromHeader || !safeCompare(secretFromHeader, storedSecret)) {
      return NextResponse.json({ ok: false, description: 'Unauthorized' }, { status: 401 })
    }
  }

  // Forward verification to bot-runner
  try {
    const url = new URL(request.url)
    const fullUrl = `${BOT_RUNNER_URL}/webhook/${encodeURIComponent(botId)}?${url.searchParams.toString()}`
    const response = await fetch(fullUrl, { signal: AbortSignal.timeout(5000) })
    const data = await response.json().catch(() => ({}))
    return NextResponse.json({ ok: true, botId, ...data })
  } catch {
    // Bot-runner not running — just confirm the endpoint exists
    return NextResponse.json({ ok: true, botId, description: 'Webhook endpoint is active' })
  }
}
