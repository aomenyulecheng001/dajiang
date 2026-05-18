import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { validateBotId } from '@/lib/validation'
import { getBotIfAuthorized } from '@/lib/api-helpers'

const MAX_TEXT_LENGTH = 5000
const MAX_USER_ID_LENGTH = 200
const MAX_USER_NAME_LENGTH = 200
const MAX_COMMAND_LENGTH = 100
const MAX_MESSAGES_PER_HOUR = 10000

/**
 * POST /api/bots/[id]/messages
 *
 * Records a message processed by the bot.
 * Called by the frontend when it receives `bot:message` events from the runner.
 * This populates the BotMessage table so stats (messages, users, commands) work.
 */
export async function POST(
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

    if (!await getBotIfAuthorized(request, id)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    let body: { userId?: unknown; userName?: unknown; text?: unknown; command?: unknown; messages?: unknown }
    try {
      const text = await request.text()
      if (!text.trim()) {
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 })
      }
      if (Buffer.byteLength(text, 'utf-8') > 1_000_000) {
        return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
      }
      body = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    if (Array.isArray(body.messages)) {
      const msgs = body.messages as Array<Record<string, unknown>>
      if (msgs.length === 0) {
        return NextResponse.json({ created: 0 }, { status: 201 })
      }
      if (msgs.length > 100) {
        return NextResponse.json({ error: 'Batch size exceeds 100 messages' }, { status: 400 })
      }

      const data = msgs
        .filter(m => typeof m.userId === 'string' && m.userId.trim())
        .map(m => ({
          botId: id,
          userId: (m.userId as string).slice(0, MAX_USER_ID_LENGTH),
          userName: typeof m.userName === 'string' ? m.userName.slice(0, MAX_USER_NAME_LENGTH) : '',
          text: typeof m.text === 'string' ? m.text.slice(0, MAX_TEXT_LENGTH) : '',
          command: typeof m.command === 'string' && m.command.trim() ? m.command.slice(0, MAX_COMMAND_LENGTH) : null,
        }))

      // P1-5 FIX: Apply same rate limit to batch path
      const recentBatchCount = await db.botMessage.count({
        where: { botId: id, timestamp: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
      })
      if (recentBatchCount + data.length > MAX_MESSAGES_PER_HOUR) {
        return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
      }

      const result = await db.botMessage.createMany({ data })
      return NextResponse.json({ created: result.count }, { status: 201 })
    }

    if (!body.userId || typeof body.userId !== 'string') {
      return NextResponse.json({ error: 'userId is required and must be a string' }, { status: 400 })
    }

    const msgUserId = (body.userId as string).slice(0, MAX_USER_ID_LENGTH)
    const userName = typeof body.userName === 'string' ? (body.userName as string).slice(0, MAX_USER_NAME_LENGTH) : ''
    const command = typeof body.command === 'string' && body.command.trim() ? (body.command as string).slice(0, MAX_COMMAND_LENGTH) : null

    if (typeof body.text === 'string' && body.text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Message text too long (max ${MAX_TEXT_LENGTH} characters)` },
        { status: 400 }
      )
    }
    const messageText = typeof body.text === 'string' ? body.text : ''
    const recentCount = await db.botMessage.count({
      where: { botId: id, timestamp: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    })
    if (recentCount >= MAX_MESSAGES_PER_HOUR) {
      return NextResponse.json(
        { error: 'Rate limit: too many messages in the last hour' },
        { status: 429 }
      )
    }

    const message = await db.botMessage.create({
      data: {
        botId: id,
        userId: msgUserId,
        userName,
        text: messageText,
        command,
      },
    })

    return NextResponse.json({
      id: message.id,
      botId: message.botId,
      userId: message.userId,
      userName: message.userName,
      text: message.text,
      command: message.command,
      timestamp: message.timestamp.toISOString(),
    }, { status: 201 })
  } catch (error) {
    console.error(`POST /api/bots/${id}/messages error:`, error)
    return NextResponse.json({ error: 'Failed to record message' }, { status: 500 })
  }
}

/**
 * GET /api/bots/[id]/messages
 *
 * Query messages for a bot (paginated).
 */
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

    if (!await getBotIfAuthorized(request, id)) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50))

    const [total, messages] = await Promise.all([
      db.botMessage.count({ where: { botId: id } }),
      db.botMessage.findMany({
        where: { botId: id },
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ])

    return NextResponse.json({
      messages: messages.map(m => ({
        id: m.id,
        botId: m.botId,
        userId: m.userId,
        userName: m.userName,
        text: m.text,
        command: m.command,
        timestamp: m.timestamp.toISOString(),
      })),
      total,
      page,
      limit,
    })
  } catch (error) {
    console.error(`GET /api/bots/${id}/messages error:`, error)
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
  }
}
