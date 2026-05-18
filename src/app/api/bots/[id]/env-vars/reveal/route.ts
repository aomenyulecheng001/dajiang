/**
 * P1-10 FIX: Reveal endpoint for encrypted env vars.
 *
 * Returns fully decrypted env vars for a bot. This is the ONLY endpoint
 * that sends plaintext secrets to the client. The frontend should call
 * this endpoint only when the user explicitly clicks "reveal" or "edit"
 * on a sensitive env var.
 *
 * SECURITY FIX: Added strict rate limiting (10 requests/minute) because
 * this endpoint returns decrypted secrets (BOT_TOKEN, API keys, etc.)
 * and is a high-value target for brute-force or credential harvesting attacks.
 */
import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { safeJsonParse, getCurrentUserId, isBotOwner } from '@/lib/api-helpers'
import { validateBotId } from '@/lib/validation'
import { decryptEnvVarsAsync } from '@/lib/crypto'

const REVEAL_RATE_LIMIT = { max: 10, windowMs: 60_000 }
const MAX_REVEAL_RATE_ENTRIES = 5000
const revealRateMap = new Map<string, { count: number; resetAt: number }>()

// Cleanup expired entries every 5 minutes to prevent unbounded memory growth
const _revealCleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const [userId, entry] of revealRateMap) {
    if (now > entry.resetAt) revealRateMap.delete(userId)
  }
}, 5 * 60 * 1000)
if (_revealCleanupTimer.unref) _revealCleanupTimer.unref()

function checkRevealLimit(key: string): boolean {
  if (revealRateMap.size >= MAX_REVEAL_RATE_ENTRIES) {
    const now = Date.now()
    for (const [k, entry] of revealRateMap) {
      if (now > entry.resetAt) revealRateMap.delete(k)
    }
  }
  const now = Date.now()
  const entry = revealRateMap.get(key)
  if (!entry || now > entry.resetAt) {
    revealRateMap.set(key, { count: 1, resetAt: now + REVEAL_RATE_LIMIT.windowMs })
    return true
  }
  if (entry.count >= REVEAL_RATE_LIMIT.max) return false
  entry.count++
  return true
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let id: string = 'unknown'
  try {
    // SEC FIX: Strict rate limiting on the reveal endpoint.
    // This endpoint returns plaintext secrets — must be more restrictive than normal APIs.
    const userId = await getCurrentUserId(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!checkRevealLimit(userId)) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': '60' } },
      )
    }

    const resolved = await params
    id = resolved.id

    const idErrors = validateBotId(id)
    if (idErrors.length > 0) {
      return NextResponse.json({ error: idErrors[0].message }, { status: 400 })
    }

    const bot = await db.bot.findUnique({
      where: { id },
      select: { id: true, ownerId: true, envVars: true },
    })
    if (!bot || !isBotOwner(bot.ownerId, userId)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    const envVars = safeJsonParse(bot.envVars, [])
    const decrypted = await decryptEnvVarsAsync(envVars)

    // P2-API-4 FIX: Log env-var reveal access for security audit
    console.info(`[Reveal] Env vars revealed for bot: ${id}, sensitive count: ${decrypted.filter((v: { key: string }) => /token|secret|password|auth|apikey|api_key|private/i.test(v.key)).length}`)

    return NextResponse.json({
      botId: bot.id,
      envVars: decrypted,
    }, {
      headers: { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' },
    })
  } catch (error) {
    console.error(`GET /api/bots/${id}/env-vars/reveal error:`, error)
    return NextResponse.json({ error: 'Failed to reveal env vars' }, { status: 500 })
  }
}
