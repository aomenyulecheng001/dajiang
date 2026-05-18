import { db } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { NextResponse } from 'next/server'
import { readFile, rm } from 'fs/promises'
import { safeJsonParse, serializeBotResponse, getCurrentUserId, isBotOwner } from '@/lib/api-helpers'
import { resolveFromProjectRoot } from '@/lib/project-root'
import { validateBotId, validateBotUpdate, validateBotPatch, sanitizeBotName, sanitizeBotDescription, sanitizeEmoji, sanitizeCustomIcon, VALID_BOT_STATUSES, VALID_BOT_HEALTHS } from '@/lib/validation'
import type { BotStatus, BotHealth } from '@/types/bot'
import { decryptEnvVarsMaskedAsync, decryptEnvVarsAsync, encryptEnvVarsOnSaveAsync, ENCRYPTED_PLACEHOLDER } from '@/lib/crypto'
import { BOT_RUNNER_URL } from '@/lib/bot-runner-url'

async function checkOwnership(request: Request, botId: string): Promise<{ authorized: boolean; userId: string | null }> {
  const userId = await getCurrentUserId(request)
  if (!userId) return { authorized: false, userId: null }
  const bot = await db.bot.findUnique({ where: { id: botId }, select: { ownerId: true } })
  if (!bot) return { authorized: false, userId }
  // SECURITY FIX: Handle migration scenario where ownerId is null (bots created
  // before the ownerId feature was added). Auto-claim is only allowed when
  // ALLOW_BOT_AUTO_CLAIM is explicitly set to 'true' (single-user dev mode).
  // For multi-tenant deployments, orphaned bots require admin assignment.
  if (!bot.ownerId || bot.ownerId === 'migrate-pending') {
    if (process.env.ALLOW_BOT_AUTO_CLAIM === 'true') {
      // SECURITY: Only admin (first account) can claim unowned bots.
      // This prevents any logged-in user from taking over bots that
      // were created before the ownership system was in place.
      const firstAccount = await db.account.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      if (firstAccount && firstAccount.id !== userId) {
        return { authorized: false, userId }
      }
      const whereClause = bot.ownerId === 'migrate-pending'
        ? { id: botId, ownerId: 'migrate-pending' }
        : { id: botId, ownerId: '' }
      const result = await db.bot.updateMany({
        where: whereClause,
        data: { ownerId: userId },
      })
      if (result.count === 0) {
        // P1-3 FIX: Concurrent claim may have already assigned this user as owner.
        // Re-check to avoid rejecting the legitimate owner.
        const currentBot = await db.bot.findUnique({ where: { id: botId }, select: { ownerId: true } })
        if (currentBot && currentBot.ownerId === userId) {
          return { authorized: true, userId }
        }
        return { authorized: false, userId }
      }
      return { authorized: true, userId }
    }
    console.warn(`[Security] Bot ${botId} has no ownerId — access denied. Set ALLOW_BOT_AUTO_CLAIM=true or assign ownerId manually.`)
    return { authorized: false, userId }
  }
  return { authorized: isBotOwner(bot.ownerId, userId), userId }
}

/** P1 FIX: Read the runner secret for authenticating with bot-runner cleanup endpoint */
async function getRunnerSecret(): Promise<string> {
  try {
    const secretPath = resolveFromProjectRoot('mini-services', 'bot-runner', 'config', 'runner-secret')
    const secret = await readFile(secretPath, 'utf-8')
    return secret.trim()
  } catch {
    return ''
  }
}

/** P0-3 OPT: Check if a Prisma error is a "record not found" error (P2025) */
function isPrismaNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code: string }).code === 'P2025'
  }
  return false
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let id: string = 'unknown'
  try {
    const resolved = await params
    id = resolved.id

    const idErrors = validateBotId(id)
    if (idErrors.length > 0) {
      return NextResponse.json({ error: idErrors[0].message }, { status: 400 })
    }

    const userId = await getCurrentUserId(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const bot = await db.bot.findUnique({
      where: { id },
      select: {
        id: true, name: true, description: true, emoji: true, customIcon: true,
        status: true, health: true, language: true, template: true, version: true,
        code: true, codeBlocks: true, dependencies: true, envVars: true, config: true,
        stats: true, projectFiles: true, entryPoint: true, lastRunnerStatus: true,
        lastDeployedAt: true, webhookSecret: true, createdAt: true, updatedAt: true,
        ownerId: true,
      },
    })
    if (!bot || !isBotOwner(bot.ownerId, userId)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    // Reuse shared serializer with full token validation
    const serialized = await serializeBotResponse(bot, decryptEnvVarsMaskedAsync, decryptEnvVarsAsync)
    return NextResponse.json(serialized, {
      headers: { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' },
    })
  } catch (error) {
    console.error(`GET /api/bots/${id} error:`, error)
    return NextResponse.json({ error: 'Failed to fetch bot' }, { status: 500 })
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let id: string = 'unknown'
  try {
    const resolved = await params
    id = resolved.id

    const idErrors = validateBotId(id)
    if (idErrors.length > 0) {
      return NextResponse.json({ error: idErrors[0].message }, { status: 400 })
    }

    const { authorized } = await checkOwnership(request, id)
    if (authorized !== true) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    // Parse request body with size limit protection
    let bot: Record<string, unknown>
    try {
      const text = await request.text()
      if (!text.trim()) {
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 })
      }
      if (Buffer.byteLength(text, 'utf-8') > 5_000_000) {
        return NextResponse.json({ error: 'Request body too large (max 5MB)' }, { status: 413 })
      }
      bot = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
    }

    // Ensure body is a plain object
    if (typeof bot !== 'object' || bot === null || Array.isArray(bot)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    // Full input validation
    const validation = validateBotUpdate(bot)
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.errors[0].message, details: validation.errors },
        { status: 400 }
      )
    }

    // BUG FIX: Merge masked env vars with existing DB values (same as PATCH handler).
    // When the client sends masked placeholders (••••••••••••) for encrypted vars,
    // preserve the existing encrypted value from the database instead of encrypting
    // the placeholder and destroying the real secret.
    const incomingEnvVars = (bot.envVars as { key: string; value: string; isEncrypted?: boolean }[]) || []
    
    const updated = await db.$transaction(async (tx) => {
      const existingBot = await tx.bot.findUnique({
        where: { id },
        select: { envVars: true, config: true, webhookSecret: true },
      })
      if (!existingBot) {
        throw new Error('BOT_NOT_FOUND')
      }
      const existingEnvVarsForMerge = safeJsonParse(existingBot.envVars, []) as { key: string; value: string; isEncrypted?: boolean }[]
      const mergedEnvVars = incomingEnvVars.map((incoming) => {
        if (incoming.value === ENCRYPTED_PLACEHOLDER && incoming.isEncrypted) {
          const existing = existingEnvVarsForMerge.find((e) => e.key === incoming.key)
          if (existing && existing.isEncrypted) {
            return { ...incoming, value: existing.value }
          }
        }
        return incoming
      })
      const needsReEncrypt = mergedEnvVars.filter(
        (v) => !existingEnvVarsForMerge.some(
          (e) => e.key === v.key && e.value === v.value && v.isEncrypted,
        ),
      )
      const processedEnvVars = needsReEncrypt.length > 0
        ? await encryptEnvVarsOnSaveAsync(mergedEnvVars)
        : mergedEnvVars
      const existingConfig = safeJsonParse(existingBot.config, {}) as Record<string, unknown>
      const configObj = { ...existingConfig, ...((bot.config as Record<string, unknown>) || {}) }
      if (!(('webhookSecret' in ((bot.config as Record<string, unknown>) || {}))) && existingBot.webhookSecret) {
        configObj.webhookSecret = existingBot.webhookSecret
      }
      const updateData = {
        name: sanitizeBotName(bot.name),
        description: sanitizeBotDescription(bot.description),
        emoji: sanitizeEmoji(bot.emoji),
        customIcon: sanitizeCustomIcon(bot.customIcon),
        status: VALID_BOT_STATUSES.includes(bot.status as BotStatus) ? (bot.status as BotStatus) : 'inactive',
        health: VALID_BOT_HEALTHS.includes(bot.health as BotHealth) ? (bot.health as BotHealth) : 'unknown',
        language: (bot.language as string) || 'typescript',
        template: (bot.template as string) || 'custom',
        version: (bot.version as string) || '1.0.0',
        code: (bot.code as string) || '',
        codeBlocks: JSON.stringify(bot.codeBlocks || []),
        dependencies: JSON.stringify(bot.dependencies || []),
        envVars: JSON.stringify(processedEnvVars),
        config: JSON.stringify(configObj),
        stats: JSON.stringify(bot.stats || {}),
        projectFiles: JSON.stringify(bot.projectFiles || []),
        entryPoint: (bot.entryPoint as string) || '',
        lastRunnerStatus: (bot.lastRunnerStatus as string) || '',
        lastDeployedAt: (bot.lastDeployedAt as string) ? new Date(bot.lastDeployedAt as string) : null,
        webhookSecret: (configObj.webhookSecret as string) || '',
      }

      return tx.bot.update({
        where: { id },
        data: updateData,
      })
    })

    // P1 OPT: Emit status event to event bus for instant SSE push
    eventBus.emit(`bot:${id}`, 'status', { botId: id, status: updated.status, health: updated.health })

    const serialized = await serializeBotResponse(updated, decryptEnvVarsMaskedAsync, decryptEnvVarsAsync)
    return NextResponse.json(serialized)
  } catch (error) {
    // P0-3 OPT: Catch Prisma "record not found" and return 404 instead of 500
    if (isPrismaNotFoundError(error)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }
    // H2 FIX: Catch our custom BOT_NOT_FOUND error from the transaction
    if (error instanceof Error && error.message === 'BOT_NOT_FOUND') {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }
    console.error(`PUT /api/bots/${id} error:`, error)
    return NextResponse.json({ error: 'Failed to update bot' }, { status: 500 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let id: string = 'unknown'
  try {
    const resolved = await params
    id = resolved.id

    const idErrors = validateBotId(id)
    if (idErrors.length > 0) {
      return NextResponse.json({ error: idErrors[0].message }, { status: 400 })
    }

    const { authorized } = await checkOwnership(request, id)
    if (authorized !== true) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    // Parse request body with size limit protection (outside transaction to avoid holding it open)
    let body: Record<string, unknown>
    try {
      const text = await request.text()
      if (!text.trim()) {
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 })
      }
      if (Buffer.byteLength(text, 'utf-8') > 5_000_000) {
        return NextResponse.json({ error: 'Request body too large (max 5MB)' }, { status: 413 })
      }
      body = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    // Partial input validation (all fields optional for PATCH)
    const validation = validateBotPatch(body)
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.errors[0].message, details: validation.errors },
        { status: 400 }
      )
    }

    const updated = await db.$transaction(async (tx) => {
      const existing = await tx.bot.findUnique({
        where: { id },
        select: {
          status: true,
          health: true,
          language: true,
          template: true,
          version: true,
          envVars: true,
          config: true,
          webhookSecret: true,
        },
      })
      if (!existing) {
        throw new Error('BOT_NOT_FOUND')
      }

      const updateData: Record<string, unknown> = {}

      if ('name' in body) updateData.name = sanitizeBotName(body.name)
      if ('description' in body) updateData.description = sanitizeBotDescription(body.description)
      if ('emoji' in body) updateData.emoji = sanitizeEmoji(body.emoji)
      if ('customIcon' in body) updateData.customIcon = sanitizeCustomIcon(body.customIcon)
      if ('status' in body) {
        updateData.status = VALID_BOT_STATUSES.includes(body.status as BotStatus) ? (body.status as BotStatus) : existing.status
      }
      if ('health' in body) {
        updateData.health = VALID_BOT_HEALTHS.includes(body.health as BotHealth) ? (body.health as BotHealth) : existing.health
      }
      if ('language' in body) updateData.language = (body.language as string) || existing.language
      if ('template' in body) updateData.template = (body.template as string) || existing.template
      if ('version' in body) updateData.version = (body.version as string) || existing.version
      if ('code' in body) updateData.code = (body.code as string) || ''
      if ('codeBlocks' in body) updateData.codeBlocks = JSON.stringify(body.codeBlocks || [])
      if ('dependencies' in body) updateData.dependencies = JSON.stringify(body.dependencies || [])
      if ('envVars' in body) {
        const incomingEnvVars = (body.envVars as { key: string; value: string; isEncrypted?: boolean }[]) || []
        const existingEnvVars = safeJsonParse(existing.envVars, []) as { key: string; value: string; isEncrypted?: boolean }[]
        const mergedEnvVars = incomingEnvVars.map((incoming) => {
          if (incoming.value === ENCRYPTED_PLACEHOLDER && incoming.isEncrypted) {
            const existingVar = existingEnvVars.find((e) => e.key === incoming.key)
            if (existingVar && existingVar.isEncrypted) {
              return { ...incoming, value: existingVar.value }
            }
          }
          return incoming
        })
        const needsReEncrypt = mergedEnvVars.filter(
          (v) => !existingEnvVars.some(
            (e) => e.key === v.key && e.value === v.value && v.isEncrypted,
          ),
        )
        const processedEnvVars = needsReEncrypt.length > 0
          ? await encryptEnvVarsOnSaveAsync(mergedEnvVars)
          : mergedEnvVars
        updateData.envVars = JSON.stringify(processedEnvVars)
      }
      if ('config' in body) {
        const existingConfig = safeJsonParse(existing.config, {}) as Record<string, unknown>
        const incomingConfig = (body.config as Record<string, unknown>) || {}
        const mergedConfig = { ...existingConfig, ...incomingConfig }
        if (!('webhookSecret' in incomingConfig) && existing.webhookSecret) {
          mergedConfig.webhookSecret = existing.webhookSecret
        }
        updateData.config = JSON.stringify(mergedConfig)
        if ('webhookSecret' in incomingConfig) {
          updateData.webhookSecret = (incomingConfig.webhookSecret as string) || ''
        }
      }
      if ('stats' in body) updateData.stats = JSON.stringify(body.stats || {})
      if ('projectFiles' in body) updateData.projectFiles = JSON.stringify(body.projectFiles || [])
      if ('entryPoint' in body) updateData.entryPoint = (body.entryPoint as string) || ''
      if ('lastRunnerStatus' in body) updateData.lastRunnerStatus = (body.lastRunnerStatus as string) || ''
      if ('lastDeployedAt' in body) updateData.lastDeployedAt = (body.lastDeployedAt as string) ? new Date(body.lastDeployedAt as string) : null

      return tx.bot.update({
        where: { id },
        data: updateData,
      })
    })

    // P1 OPT: Emit status event to event bus for instant SSE push
    eventBus.emit(`bot:${id}`, 'status', { botId: id, status: updated.status, health: updated.health })

    const serialized = await serializeBotResponse(updated, decryptEnvVarsMaskedAsync, decryptEnvVarsAsync)
    return NextResponse.json(serialized)
  } catch (error) {
    if (isPrismaNotFoundError(error)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }
    // Catch our custom BOT_NOT_FOUND error from the transaction
    if (error instanceof Error && error.message === 'BOT_NOT_FOUND') {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }
    console.error(`PATCH /api/bots/${id} error:`, error)
    return NextResponse.json({ error: 'Failed to update bot' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let id: string = 'unknown'
  try {
    const resolved = await params
    id = resolved.id

    const idErrors = validateBotId(id)
    if (idErrors.length > 0) {
      return NextResponse.json({ error: idErrors[0].message }, { status: 400 })
    }

    const { authorized, userId: deleteUserId } = await checkOwnership(request, id)
    if (authorized !== true) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    let deletedBot: { id: string; ownerId: string | null } | null = null
    try {
      deletedBot = await db.$transaction(async (tx) => {
        const bot = await tx.bot.findUnique({ where: { id }, select: { ownerId: true } })
        if (!bot || !isBotOwner(bot.ownerId, deleteUserId)) {
          throw new Error('BOT_NOT_FOUND')
        }
        return tx.bot.delete({ where: { id } })
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'BOT_NOT_FOUND') {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
      }
      throw err
    }

    if (!deletedBot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    // SECURITY FIX (SEC-86): Audit log for bot deletion
    console.info(`[Audit] Bot deleted: id=${id}, owner=${deleteUserId || 'unknown'}`)

    // P1 OPT: Emit deleted event so SSE clients disconnect gracefully
    eventBus.emit(`bot:${id}`, 'deleted', { botId: id })

    // Clean up bot files on disk after successful DB delete.
    // This handles the case where the bot-runner is unreachable — without this,
    // orphaned bot directories and logs remain on disk indefinitely.
    try {
      const botDir = resolveFromProjectRoot('mini-services', 'bot-runner', 'bots', id)
      const logFile = resolveFromProjectRoot('mini-services', 'bot-runner', 'logs', `${id}.log`)
      const configFile = resolveFromProjectRoot('mini-services', 'bot-runner', 'config', `${id}.json`)
      // SECURITY FIX (SEC-77): Verify resolved paths stay within expected directories.
      // Prevents path traversal via botId containing '..' from deleting unintended directories.
      const expectedBotsDir = resolveFromProjectRoot('mini-services', 'bot-runner', 'bots')
      const expectedLogsDir = resolveFromProjectRoot('mini-services', 'bot-runner', 'logs')
      const expectedConfigDir = resolveFromProjectRoot('mini-services', 'bot-runner', 'config')
      if (!botDir.startsWith(expectedBotsDir) || !logFile.startsWith(expectedLogsDir) || !configFile.startsWith(expectedConfigDir)) {
        console.error(`[SECURITY] Path traversal detected in bot delete: id=${id}, botDir=${botDir}`)
      } else {
        await Promise.all([
          rm(botDir, { recursive: true, force: true }),
          rm(logFile, { force: true }),
          rm(configFile, { force: true }),
        ])
      }
    } catch (err) {
      console.warn(`[DELETE] File cleanup warning for bot ${id}:`, err instanceof Error ? err.message : err)
    }

    // P1-FIX: Notify bot-runner to stop process and clean up disk AFTER successful DB delete.
    // Fire-and-forget: if runner is unreachable, the process will eventually be cleaned up on restart.
    const runnerSecret = await getRunnerSecret()
    const runnerUrl = `${BOT_RUNNER_URL}/cleanup/${encodeURIComponent(id)}`
    const headers: Record<string, string> = {}
    if (runnerSecret) {
      headers['X-Runner-Secret'] = runnerSecret
    }
    // P1-2 FIX: Return success immediately, run cleanup async to avoid blocking response
    fetch(runnerUrl, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10000),
    }).catch(err => console.warn('[Delete] Runner cleanup failed:', err instanceof Error ? err.message : err))

    return NextResponse.json({ success: true })
  } catch (error) {
    if (isPrismaNotFoundError(error)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }
    console.error(`DELETE /api/bots/${id} error:`, error)
    return NextResponse.json({ error: 'Failed to delete bot' }, { status: 500 })
  }
}
