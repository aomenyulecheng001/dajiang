import { NextRequest } from 'next/server'
import { validateSessionAsync } from '@/lib/session'
import { db } from '@/lib/db'

const SESSION_COOKIE_NAME = 'session_token'

export function getSecureClientIp(request: NextRequest): string {
  const trustedProxies = (process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean)
  if (trustedProxies.length === 0) {
    return 'shared-untrusted'
  }
  const isTrusted = (ip: string) => trustedProxies.includes(ip) || ip === '127.0.0.1' || ip === '::1'
  const directIp = request.headers.get('x-real-ip') || request.headers.get('x-client-ip') || '127.0.0.1'
  if (isTrusted(directIp)) {
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) {
      const ips = forwarded.split(',').map(s => s.trim())
      for (let i = ips.length - 1; i >= 0; i--) {
        if (!isTrusted(ips[i])) return ips[i]
      }
    }
  }
  return directIp
}

export function isSecureRequest(request: NextRequest): boolean {
  if (process.env.PROTOCOL === 'https') return true
  if (process.env.TRUST_FORWARDED_HEADERS === 'true') {
    const forwarded = request.headers.get('x-forwarded-proto')
    if (forwarded === 'https') return true
    if (forwarded === 'http') return false
  }
  if (request.nextUrl.protocol === 'https:') return true
  if (request.nextUrl.protocol === 'http:') return false
  return false
}

export function extractToken(request: NextRequest): string | null {
  const cookieToken = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (cookieToken) return cookieToken
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  return null
}

export async function getCurrentUserId(request: Request): Promise<string | null> {
  try {
    const cookieToken = (request as NextRequest).cookies?.get?.(SESSION_COOKIE_NAME)?.value
    const authHeader = request.headers.get('authorization')
    let token = cookieToken
      || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null)

    // SECURITY FIX (SEC-80): Support query parameter token for SSE endpoints,
    // consistent with middleware.ts authentication logic. EventSource API cannot
    // set custom headers, so SSE endpoints fall back to ?token= query parameter.
    if (!token) {
      try {
        const url = new URL(request.url)
        if (url.pathname.match(/^\/api\/bots\/[^/]+\/logs\/stream$/)) {
          token = url.searchParams.get('token')
        }
      } catch {
        // URL parsing may fail for some request types
      }
    }

    if (!token) return null
    const session = await validateSessionAsync(token)
    return session?.userId ?? null
  } catch {
    return null
  }
}

/**
 * P0-1 OPT: Lightweight bot serializer for list views.
 * Skips expensive operations:
 *   - EnvVar decryption (async crypto)
 *   - Token validation (requires full decryption)
 *   - projectFiles parsing (excluded from list query)
 * Use serializeBotResponse for detail views where full data is needed.
 */
export function serializeBotListResponse(bot: Record<string, unknown>): Record<string, unknown> {
  // SECURITY FIX: Parse config but strip webhookSecret — it should never appear in API responses
  const configObj = safeJsonParse(bot.config as string, {}) as Record<string, unknown>
  delete configObj.webhookSecret

  // SECURITY FIX: Exclude webhookSecret and envVars from top-level response
  const { webhookSecret: _ws, envVars: _ev, ...safeBot } = bot

  return {
    ...safeBot,
    codeBlocks: safeJsonParse(bot.codeBlocks as string, []),
    dependencies: safeJsonParse(bot.dependencies as string, []),
    // envVars excluded from list query — fetched in detail view
    config: configObj,
    stats: safeJsonParse(bot.stats as string, {}),
    // projectFiles excluded from list query — fetched in detail view
    entryPoint: (bot.entryPoint as string) || undefined,
    // BUG FIX: Include lastDeployedAt so bot cards can show "needs restart" badge
    lastDeployedAt: bot.lastDeployedAt instanceof Date ? bot.lastDeployedAt.toISOString() : (bot.lastDeployedAt as string || undefined),
    lastRunnerStatus: (bot.lastRunnerStatus as string) || undefined,
    // Token status not computed for list view
    tokenStatus: 'not_set' as const,
    tokenPreview: undefined,
    // BUG FIX: Return empty envVars array in list response so frontend Bot type
    // contract is satisfied. The list serializer strips envVars for security, but
    // the frontend Bot interface declares envVars as required (not optional).
    envVars: [],
  }
}

/** Safely parse a JSON string with a fallback value */
export function safeJsonParse<T>(str: string | null | undefined, fallback: T, fieldName?: string): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch (e) {
    const name = fieldName || 'unknown'
    const preview = str.length > 100 ? str.slice(0, 100) + '...' : str
    console.warn(`[safeJsonParse] Failed to parse JSON field "${name}" (length: ${str.length}, preview: "${preview}"): ${e instanceof Error ? e.message : e}`)
    return fallback
  }
}

export function isBotOwner(ownerId: string | null | undefined, userId: string): boolean {
  if (!ownerId || ownerId === 'migrate-pending') {
    return false
  }
  return ownerId === userId
}

/**
 * PERF OPT: Lightweight authorization check — only selects { id, ownerId }
 * instead of all Bot fields. Previously fetched the entire row including
 * large columns (projectFiles, code, envVars, codeBlocks) that were never
 * used by callers. For a Bot with many project files, this avoids
 * transferring 50-200KB of unnecessary data per authorization check.
 *
 * All current callers (logs/route.ts, messages/route.ts) only use the
 * return value as a boolean: `if (!await getBotIfAuthorized(...))`.
 */
export async function getBotIfAuthorized(
  request: Request,
  botId: string,
): Promise<{ id: string; ownerId: string | null } | null> {
  const userId = await getCurrentUserId(request)
  if (!userId) return null
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: { id: true, ownerId: true },
  })
  if (!bot) return null
  if (!isBotOwner(bot.ownerId as string | null, userId)) return null
  return bot
}

/** Server-side bot token format validation.
 * Same logic as the client-side isValidBotToken, but runs on the server
 * after decryption so it validates the actual plaintext token.
 */
function isValidBotTokenServer(token: string | undefined): boolean {
  if (!token) return false
  const trimmed = token.trim()
  if (trimmed.length < 10) return false
  if (!trimmed.includes(':')) return false
  if (trimmed === 'your-token-here' || trimmed === 'your-token-here:placeholder') return false
  if (/^[0-9a-f]{32}:[0-9a-f]{32}:/.test(trimmed)) return false
  return true
}

/** Generate a masked preview of a bot token (first 6 + ... + last 4 chars) */
function getTokenPreview(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length <= 10) return '••••••'
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`
}

/**
 * P3-API-1 FIX: Shared bot response serialization helper.
 * Extracts the repeated transformation logic from GET/POST/PUT/PATCH bot handlers
 * into a single function. Previously duplicated 6+ times across route handlers.
 *
 * Includes server-side token validation: decrypts BOT_TOKEN to validate format
 * and generate a masked preview, then masks it for the response payload.
 */
export async function serializeBotResponse(
  bot: Record<string, unknown>,
  decryptEnvVarsMaskedAsync: (envVars: { key: string; value: string; isEncrypted?: boolean }[]) => Promise<unknown[]>,
  decryptEnvVarsAsync?: (envVars: { key: string; value: string; isEncrypted?: boolean }[]) => Promise<unknown[]>,
): Promise<Record<string, unknown>> {
  const envVars = safeJsonParse(bot.envVars as string, [])

  // Server-side token validation: decrypt the real token, validate, generate preview
  let tokenStatus: 'valid' | 'invalid' | 'not_set' = 'not_set'
  let tokenPreview: string | undefined

  if (decryptEnvVarsAsync) {
    try {
      const decryptedEnvVars = await decryptEnvVarsAsync(envVars)
      const tokenEntry = (decryptedEnvVars as { key: string; value: string }[]).find(
        (v) => (v.key === 'BOT_TOKEN' || v.key === 'TELEGRAM_BOT_TOKEN') && v.value?.trim()
      )
      if (tokenEntry) {
        const isValid = isValidBotTokenServer(tokenEntry.value)
        tokenStatus = isValid ? 'valid' : 'invalid'
        tokenPreview = getTokenPreview(tokenEntry.value)
      }
    } catch {
      // Decryption failed — treat as not_set (don't leak error details)
      tokenStatus = 'not_set'
    }
  }

  // SECURITY FIX: Parse config but strip webhookSecret — it should never appear in API responses
  const configObj = safeJsonParse(bot.config as string, {}) as Record<string, unknown>
  delete configObj.webhookSecret

  // SECURITY FIX: Exclude webhookSecret from top-level response
  const { webhookSecret: _ws, ...safeBot } = bot

  return {
    ...safeBot,
    codeBlocks: safeJsonParse(bot.codeBlocks as string, []),
    dependencies: safeJsonParse(bot.dependencies as string, []),
    envVars: await decryptEnvVarsMaskedAsync(envVars),
    config: configObj,
    stats: safeJsonParse(bot.stats as string, {}),
    projectFiles: safeJsonParse(bot.projectFiles as string, []),
    entryPoint: (bot.entryPoint as string) || undefined,
    // BUG FIX: Convert empty strings to undefined to match frontend type contract
    lastDeployedAt: bot.lastDeployedAt instanceof Date ? bot.lastDeployedAt.toISOString() : (bot.lastDeployedAt as string || undefined),
    lastRunnerStatus: (bot.lastRunnerStatus as string) || undefined,
    tokenStatus,
    tokenPreview,
  }
}
