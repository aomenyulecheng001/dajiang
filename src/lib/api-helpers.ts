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
    lastDeployedAt: (bot.lastDeployedAt as string) || undefined,
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
export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch {
    console.warn(`Failed to parse JSON field, using fallback. Length: ${str?.length}`)
    return fallback
  }
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
    lastDeployedAt: (bot.lastDeployedAt as string) || undefined,
    lastRunnerStatus: (bot.lastRunnerStatus as string) || undefined,
    tokenStatus,
    tokenPreview,
  }
}
