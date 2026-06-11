import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { safeJsonParse, serializeBotListResponse, serializeBotResponse, getCurrentUserId, parseJsonBody } from '@/lib/api-helpers'
import { validateBotCreate, sanitizeBotName, sanitizeBotDescription, sanitizeEmoji, sanitizeCustomIcon } from '@/lib/validation'
import { decryptEnvVarsMaskedAsync, decryptEnvVarsAsync, encryptEnvVarsOnSaveAsync } from '@/lib/crypto'
import { PAGINATION } from '@/lib/bot-constants'
import { generateSecret } from '@/lib/utils'
import { logger } from '@/lib/logger'

function generateWebhookSecret(): string {
  return generateSecret()
}

/**
 * P0-1 OPT: Fields to select in list query.
 * Excludes heavy fields that are only needed in detail view:
 *   - projectFiles (up to 25MB per bot)
 *   - code (redundant with codeBlocks)
 *   - envVars (expensive decryption, only needed in detail view)
 */
const BOT_LIST_SELECT: Record<string, true> = {
  id: true,
  name: true,
  description: true,
  emoji: true,
  customIcon: true,
  status: true,
  health: true,
  language: true,
  template: true,
  version: true,
  codeBlocks: true,
  dependencies: true,
  config: true,
  stats: true,
  entryPoint: true,
  lastRunnerStatus: true,
  lastDeployedAt: true,
  // SECURITY FIX: Don't fetch webhookSecret in list query — not needed and prevents accidental leak
  // webhookSecret is still included in config JSON column for backward compat
  createdAt: true,
  updatedAt: true,
}

export async function GET(request: Request) {
  try {
    const userId = await getCurrentUserId(request)
    // SECURITY FIX: Return 401 if no authenticated user. Previously, when userId
    // was null, the where clause was {} which returned ALL bots from the database.
    // While middleware should block unauthenticated requests, this is a defense-in-depth
    // measure to prevent data leakage if middleware is ever misconfigured.
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    // BUG FIX (BUG-101): Use || fallback after parseInt to handle NaN.
    // Math.max(1, NaN) returns NaN (not 1), which propagates through
    // arithmetic and causes Prisma to throw or return unexpected results.
    // Other routes (messages/route.ts) already use this pattern.
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const pageSize = Math.min(PAGINATION.MAX_PAGE_SIZE, Math.max(1, parseInt(searchParams.get('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10) || PAGINATION.DEFAULT_PAGE_SIZE))
    const skip = (page - 1) * pageSize

    // P1-10 FIX: Show migrate-pending bots to admin when ALLOW_BOT_AUTO_CLAIM is set
    const where = process.env.ALLOW_BOT_AUTO_CLAIM === 'true'
      ? { OR: [{ ownerId: userId }, { ownerId: 'migrate-pending' }] }
      : { ownerId: userId }

    const [bots, total] = await Promise.all([
      db.bot.findMany({
        where,
        select: BOT_LIST_SELECT,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.bot.count({ where }),
    ])

    const parsed = bots.map((bot) => serializeBotListResponse(bot))
    
    return NextResponse.json({
      data: parsed,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        hasNextPage: page * pageSize < total,
        hasPrevPage: page > 1,
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    }, {
      headers: { 
        'Cache-Control': 'private, no-store, no-cache, must-revalidate',
        'X-Total-Count': String(total),
        'X-Page': String(page),
        'X-Page-Size': String(pageSize),
        'X-Total-Pages': String(Math.ceil(total / pageSize)),
      },
    })
  } catch (error) {
    logger.error('bots', 'GET /api/bots error', error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'Failed to fetch bots' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Parse request body with size limit protection (shared utility)
    // SECURITY FIX (S5): Explicit 5MB limit for bot creation (projectFiles can be large)
    const parsed = await parseJsonBody(request, 5_000_000)
    if (parsed instanceof NextResponse) return parsed
    const bot = parsed

    // Full input validation
    const validation = validateBotCreate(bot)
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.errors[0].message, details: validation.errors },
        { status: 400 }
      )
    }

    const processedEnvVars = await encryptEnvVarsOnSaveAsync((bot.envVars as { key: string; value: string; isEncrypted?: boolean }[]) || [])

    const clientId = bot.id
    const existingWebhookSecret = (bot.config as Record<string, unknown>)?.webhookSecret as string | undefined
    const webhookSecret = existingWebhookSecret || generateWebhookSecret()
    const createData = {
      // SECURITY FIX (SEC-77): Also reject path traversal patterns in client-provided bot ID
      ...(clientId && typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 100 && /^[a-zA-Z0-9._-]+$/.test(clientId) && !clientId.includes('..') && !clientId.startsWith('.')
        ? { id: clientId }
        : {}),
      name: sanitizeBotName(bot.name),
      description: sanitizeBotDescription(bot.description),
      emoji: sanitizeEmoji(bot.emoji),
      customIcon: sanitizeCustomIcon(bot.customIcon),
      // FIX: Force status/health to initial values on creation.
      // Previously, clients could submit status: 'active' to create a bot
      // that appears to be running, which is misleading and a security risk.
      status: 'inactive',
      health: 'unknown',
      language: (bot.language as string) || 'typescript',
      template: (bot.template as string) || 'custom',
      version: (bot.version as string) || '1.0.0',
      code: (bot.code as string) || '',
      codeBlocks: JSON.stringify(bot.codeBlocks || []),
      dependencies: JSON.stringify(bot.dependencies || []),
      envVars: JSON.stringify(processedEnvVars),
      // DEPRECATED: webhookSecret in config JSON is kept for backward compatibility only.
      // The canonical storage is the dedicated Bot.webhookSecret column.
      // New code should read/write only the column, not the config JSON.
      config: JSON.stringify({
        ...(bot.config as Record<string, unknown> || {}),
        ...(existingWebhookSecret ? {} : { webhookSecret }),
      }),
      stats: JSON.stringify(bot.stats || {}),
      projectFiles: JSON.stringify(bot.projectFiles || []),
      entryPoint: (bot.entryPoint as string) || '',
      webhookSecret,
      ownerId: userId,
    }

    const created = await db.bot.create({ data: createData })

    // SECURITY FIX (SEC-86): Audit log for bot creation
    logger.info('bots', `Bot created: id=${created.id}, name=${sanitizeBotName(bot.name)}, owner=${userId}`)

    // POST returns full bot data (including envVars for immediate use)
    const serialized = await serializeBotResponse(created, decryptEnvVarsMaskedAsync, decryptEnvVarsAsync)
    return NextResponse.json(serialized, { status: 201 })
  } catch (error: unknown) {
    logger.error('bots', 'POST /api/bots error', error instanceof Error ? error.message : String(error))
    // Handle Prisma unique constraint violations with specific error messages
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'P2002') {
      // SECURITY FIX (L-11): Unified error message — don't distinguish between
      // 'name' and 'id' fields to avoid leaking which field caused the conflict.
      return NextResponse.json({ error: 'A bot with this name or ID already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Failed to create bot' }, { status: 500 })
  }
}
