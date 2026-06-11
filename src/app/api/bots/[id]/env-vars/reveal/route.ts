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
import { rateLimit, RATE_LIMIT_REVEAL, getRateLimitHeaders } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let id: string = 'unknown'
  try {
    // SEC FIX: Strict rate limiting on the reveal endpoint.
    // This endpoint returns plaintext secrets — must be more restrictive than normal APIs.
    // SECURITY FIX (L3): Use shared rateLimit instance with sliding window algorithm
    // instead of custom fixed-window implementation for consistency.
    const userId = await getCurrentUserId(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const revealRateResult = rateLimit.check(`reveal:${userId}`, RATE_LIMIT_REVEAL)
    if (!revealRateResult.success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { ...getRateLimitHeaders(revealRateResult), 'Retry-After': '60' } },
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
    logger.info('env-reveal', `Env vars revealed for bot: ${id}, sensitive count: ${decrypted.filter((v: { key: string }) => /token|secret|password|auth|apikey|api_key|private/i.test(v.key)).length}`)

    return NextResponse.json({
      botId: bot.id,
      envVars: decrypted,
    }, {
      headers: { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' },
    })
  } catch (error) {
    logger.error('env-reveal', `GET /api/bots/${id}/env-vars/reveal error`, error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'Failed to reveal env vars' }, { status: 500 })
  }
}
