import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { safeJsonParse, serializeBotListResponse, serializeBotResponse } from '@/lib/api-helpers'
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
    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
    const pageSize = Math.min(PAGINATION.MAX_PAGE_SIZE, Math.max(1, parseInt(searchParams.get('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)))
    const skip = (page - 1) * pageSize

    const [bots, total] = await Promise.all([
      db.bot.findMany({
        select: BOT_LIST_SELECT,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.bot.count(),
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

    const createData = {
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
    }

    const created = await db.bot.create({ data: createData })

    // POST returns full bot data (including envVars for immediate use)
    const serialized = await serializeBotResponse(created, decryptEnvVarsMaskedAsync, decryptEnvVarsAsync)
    return NextResponse.json(serialized)
  } catch (error) {
    console.error('POST /api/bots error:', error)
    return NextResponse.json({ error: 'Failed to create bot' }, { status: 500 })
  }
}
