import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { safeJsonParse, serializeBotListResponse, serializeBotResponse, getCurrentUserId } from '@/lib/api-helpers'
import { validateBotCreate, sanitizeBotName, sanitizeBotDescription, sanitizeEmoji, sanitizeCustomIcon } from '@/lib/validation'
import { decryptEnvVarsMaskedAsync, decryptEnvVarsAsync, encryptEnvVarsOnSaveAsync } from '@/lib/crypto'
import { PAGINATION } from '@/lib/bot-constants'

/**
 * P0-1 OPT: Fields to select in list query.
 * Excludes heavy fields that are only needed in detail view:
 *   - projectFiles (up to 5MB per bot)
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

    const where = { ownerId: userId }

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
    console.error('GET /api/bots error:', error)
    return NextResponse.json({ error: 'Failed to fetch bots' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Parse request body with size limit protection
    let bot: Record<string, unknown>
    try {
      const text = await request.text()
      if (!text.trim()) {
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 })
      }
      // Reject payloads larger than 5MB (projectFiles from Git/ZIP can be large)
      // BUG FIX: Use Buffer.byteLength() instead of text.length.
      // text.length counts UTF-16 code units, not actual bytes.
      // For multi-byte content (Chinese descriptions, base64 customIcon),
      // the actual size could be 2-3× the character count.
      if (Buffer.byteLength(text, 'utf-8') > 5_000_000) {
        return NextResponse.json({ error: 'Request body too large (max 5MB)' }, { status: 413 })
      }
      bot = JSON.parse(text)
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      )
    }

    // Ensure body is a plain object (not array, null, etc.)
    if (typeof bot !== 'object' || bot === null || Array.isArray(bot)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

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
    const createData = {
      // SECURITY FIX (SEC-77): Also reject path traversal patterns in client-provided bot ID
      ...(clientId && typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 100 && /^[a-zA-Z0-9._-]+$/.test(clientId) && !clientId.includes('..') && !clientId.startsWith('.')
        ? { id: clientId }
        : {}),
      name: sanitizeBotName(bot.name),
      description: sanitizeBotDescription(bot.description),
      emoji: sanitizeEmoji(bot.emoji),
      customIcon: sanitizeCustomIcon(bot.customIcon),
      status: (bot.status as string) || 'inactive',
      health: (bot.health as string) || 'unknown',
      language: (bot.language as string) || 'typescript',
      template: (bot.template as string) || 'custom',
      version: (bot.version as string) || '1.0.0',
      code: (bot.code as string) || '',
      codeBlocks: JSON.stringify(bot.codeBlocks || []),
      dependencies: JSON.stringify(bot.dependencies || []),
      envVars: JSON.stringify(processedEnvVars),
      config: JSON.stringify(bot.config || {}),
      stats: JSON.stringify(bot.stats || {}),
      projectFiles: JSON.stringify(bot.projectFiles || []),
      entryPoint: (bot.entryPoint as string) || '',
      webhookSecret: ((bot.config as Record<string, unknown>)?.webhookSecret as string) || '',
      ownerId: userId,
    }

    const created = await db.bot.create({ data: createData })

    // SECURITY FIX (SEC-86): Audit log for bot creation
    console.info(`[Audit] Bot created: id=${created.id}, name=${sanitizeBotName(bot.name)}, owner=${userId}`)

    // POST returns full bot data (including envVars for immediate use)
    const serialized = await serializeBotResponse(created, decryptEnvVarsMaskedAsync, decryptEnvVarsAsync)
    return NextResponse.json(serialized)
  } catch (error: unknown) {
    console.error('POST /api/bots error:', error)
    // Handle Prisma unique constraint violations with specific error messages
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'P2002') {
      const meta = 'meta' in error ? (error as { meta?: { target?: string[] } }).meta : undefined
      const target = meta?.target?.[0]
      if (target === 'name') {
        return NextResponse.json({ error: 'A bot with this name already exists' }, { status: 409 })
      }
      if (target === 'id') {
        return NextResponse.json({ error: 'A bot with this ID already exists' }, { status: 409 })
      }
      return NextResponse.json({ error: 'A bot with this unique field already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Failed to create bot' }, { status: 500 })
  }
}
