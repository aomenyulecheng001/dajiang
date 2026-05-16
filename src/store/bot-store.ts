import { create } from 'zustand'
import { toast } from 'sonner'
import type { Bot, BotLanguage, CodeBlock, Dependency, EnvVar, BotConfig, LogEntry, ProjectFile } from '@/types/bot'
import { getTranslation } from '@/lib/i18n'
import type { Locale } from '@/lib/i18n'
import { useI18nStore } from '@/lib/i18n'
import { generateUUID, generateSecret } from '@/lib/utils'
import { PAGINATION } from '@/lib/bot-constants'

// ─── Store Interface ───────────────────────────────────────────────────────

interface BotStore {
  // State
  bots: Bot[]
  selectedBotId: string | null
  viewMode: 'grid' | 'list'
  searchQuery: string
  statusFilter: string
  sortBy: 'name' | 'createdAt' | 'updatedAt' | 'status'
  sortOrder: 'asc' | 'desc'
  createBotDialogOpen: boolean
  createBotDialogMode: 'create' | 'import' | 'git'
  editBotId: string | null
  _hasHydrated: boolean
  _isHydrating: boolean
  // Pagination state
  currentPage: number
  pageSize: number
  // Computed
  filteredBots: () => Bot[]

  // Actions
  setSelectedBotId: (_id: string | null) => void
  setViewMode: (_mode: 'grid' | 'list') => void
  setSearchQuery: (_q: string) => void
  setStatusFilter: (_f: string) => void
  setSortBy: (_s: 'name' | 'createdAt' | 'updatedAt' | 'status') => void
  setSortOrder: (_o: 'asc' | 'desc') => void
  setCreateBotDialogOpen: (_open: boolean) => void
  setCreateBotDialogMode: (_mode: 'create' | 'import' | 'git') => void
  setEditBotId: (_id: string | null) => void
  setCurrentPage: (_page: number) => void
  setPageSize: (_size: number) => void
  resetPagination: () => void
  addBot: (_params: { name: string; description: string; language: BotLanguage; template: string; emoji: string; customIcon?: string; code?: string; codeBlocks?: Bot['codeBlocks']; dependencies?: Bot['dependencies']; envVars?: Bot['envVars']; projectFiles?: ProjectFile[]; entryPoint?: string }) => void
  updateBot: (_id: string, _data: { name?: string; description?: string }) => void
  deleteBot: (_id: string) => Promise<void>
  toggleCodeBlock: (_botId: string, _blockId: string) => void
  updateBotConfig: (_botId: string, _config: Partial<BotConfig>) => void
  addDependency: (_botId: string, _dep: { name: string; version: string; isRequired: boolean; description?: string }) => void
  updateDependency: (_botId: string, _depId: string, _updates: Partial<{ name: string; version: string; isRequired: boolean; description: string }>) => void
  removeDependency: (_botId: string, _depId: string) => void
  addEnvVar: (_botId: string, _envVar: { key: string; value: string; isEncrypted: boolean; description?: string }) => void
  updateEnvVar: (_botId: string, _envVarId: string, _updates: Partial<{ key: string; value: string; isEncrypted: boolean; description: string }>) => void
  removeEnvVar: (_botId: string, _envVarId: string) => void
  addLogEntry: (_botId: string, _entry: Omit<LogEntry, 'id'>) => void
  addLogEntryLocal: (_botId: string, _entry: Omit<LogEntry, 'id'>) => void
  fetchBotLogs: (_botId: string) => Promise<void>
  updateCodeBlock: (_botId: string, _blockId: string, _code: string) => void
  addCodeBlock: (_botId: string, _block: { name: string; type: CodeBlock['type']; language: CodeBlock['language']; code?: string; description?: string }) => void
  removeCodeBlock: (_botId: string, _blockId: string) => void
  updateBotEmoji: (_botId: string, _emoji: string, _customIcon?: string) => void
  syncRunnerStatus: (_botId: string, _runnerStatus: 'stopped' | 'starting' | 'running' | 'error' | 'stopping') => void
  fetchBotDetail: (_botId: string) => Promise<void>
  fetchBotStats: (_botId: string) => Promise<void>
  updateProjectFile: (_botId: string, _filePath: string, _newContent: string) => void

  // Persistence
  hydrateFromDB: () => Promise<void>
  isBotPersisted: (_botId: string) => boolean
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function genId(): string {
  // P3 FIX: Use generateUUID() which works in both HTTP and HTTPS contexts
  // (crypto.randomUUID() throws in non-secure contexts like plain HTTP)
  return generateUUID()
}

/**
 * Generate a cryptographically secure webhook secret (64 hex chars = 256 bits).
 * Uses generateSecret() which works in both HTTP and HTTPS contexts.
 * P0-1 FIX: Replaced Node.js `randomBytes` which crashes in browser context.
 * P0-2 FIX: Replaced crypto.randomUUID() which throws in non-secure (HTTP) contexts.
 */
function genWebhookSecret(): string {
  return generateSecret()
}

// ─── DB Persistence Helpers ───────────────────────────────────────────────

export function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(url, { ...init, headers, credentials: 'include' }).then((res) => {
   // 401 INTERCEPTOR: If the token is expired or invalid, clear auth state
   // so the user is redirected to the login page instead of seeing stale data.
   // Skip for login/session endpoints to avoid infinite loops.
   if (res.status === 401 && !url.includes('/api/auth/login') && !url.includes('/api/auth/session')) {
     // Import dynamically to avoid circular dependency at module load time
     import('@/store/auth-store').then(({ useAuthStore }) => {
       const store = useAuthStore.getState()
       // Only clear if currently authenticated (prevent double-clear)
       if (store.isAuthenticated) {
         store.setAuth(false, null, null)
         // Show a toast so the user knows why they were logged out
         import('sonner').then(({ toast }) => {
           toast.error('Session expired', { description: 'Please log in again.' })
         }).catch(() => {})
       }
     }).catch(() => {})
   }
   return res
 })
}

let dbBotIds = new Set<string>()
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const MAX_LOGS_PER_BOT = 200
const logDedupKeys = new Map<string, Set<string>>()

/** PERF FIX: Track last log fetch timestamp per bot for incremental updates */
const lastLogFetchTime = new Map<string, string>()

/** Fields to exclude from PATCH body (handled separately, read-only, or auto-managed by DB) */
const PATCH_EXCLUDE_FIELDS = new Set(['id', 'createdAt', 'logs', 'stats', 'updatedAt', 'envVars', 'codeDirty'])

const REF_EQUAL_FIELDS = new Set(['projectFiles', 'code', 'codeBlocks', 'logs', 'stats'])

const SNAPSHOT_EXCLUDE_FIELDS = new Set(['logs'])

function createFilteredSnapshot(bot: Record<string, unknown> | Bot): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(bot).filter(([k]) => !SNAPSHOT_EXCLUDE_FIELDS.has(k))
  )
}

/** Ensure a bot loaded from DB has all nested fields with safe defaults */
function normalizeBot(raw: Partial<Bot> & { id: string; name: string }): Bot {
  return {
    id: raw.id,
    ownerId: raw.ownerId || undefined,
    name: raw.name,
    description: raw.description ?? '',
    emoji: raw.emoji ?? '🤖',
    customIcon: raw.customIcon || undefined,
    status: raw.status || 'inactive',
    health: raw.health ?? 'unknown',
    language: raw.language ?? 'typescript',
    template: raw.template ?? 'custom',
    version: raw.version ?? '1.0.0',
    createdAt: raw.createdAt ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    code: raw.code ?? '',
    codeBlocks: Array.isArray(raw.codeBlocks) ? raw.codeBlocks : [],
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    envVars: Array.isArray(raw.envVars) ? raw.envVars : [],
    config: {
      pollingMode: 'polling',
      rateLimitPerMinute: 30,
      maxConcurrentRequests: 10,
      autoRestart: true,
      logLevel: 'info' as const,
      timeout: 30,
      ...raw.config,
      // BUG FIX: Only generate webhookSecret if it's truly missing (not just empty string).
      // Previously, genWebhookSecret() was called for empty strings, creating a client-side
      // phantom secret that doesn't match the DB. When a config PATCH is triggered by another
      // change, the phantom secret would overwrite the DB's actual (empty) value.
      // Empty string in DB means "no secret configured" — that's valid and should be preserved.
      ...(raw.config?.webhookSecret ? { webhookSecret: raw.config.webhookSecret } : {}),
    },
    stats: {
      messages: 0,
      users: 0,
      uptime: 0,
      errors: 0,
      dailyMessages: [],
      topCommands: [],
      hourlyActivity: Array.from({ length: 24 }, () => 0),
      ...raw.stats,
    },
    logs: [],
    projectFiles: Array.isArray(raw.projectFiles) ? raw.projectFiles : undefined,
    entryPoint: raw.entryPoint || undefined,
    lastRunnerStatus: raw.lastRunnerStatus || '',
    lastDeployedAt: raw.lastDeployedAt || undefined,
    codeDirty: raw.codeDirty ?? false,  // client-side only: false by default (not dirty when loaded from DB)
    tokenStatus: raw.tokenStatus,
    tokenPreview: raw.tokenPreview,
  }
}

/**
 * P2-4 FIX: Schedule a targeted PATCH for a single bot.
 * Only sends fields that were actually changed (tracks dirty state per bot).
 * Excludes large/stable fields (projectFiles) unless explicitly modified.
 * Debounced per botId — rapid changes to the same bot are batched.
 */
const botSnapshots = new Map<string, Record<string, unknown>>()

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], (b as unknown[])[i])) return false
    }
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const keysA = Object.keys(aObj)
  const keysB = Object.keys(bObj)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false
    if (!isDeepEqual(aObj[key], bObj[key])) return false
  }
  return true
}

function computePatchDiff(bot: Bot, prev: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const patchData: Record<string, unknown> = {}
  const currentEntries = Object.entries(bot)
  for (const [key, value] of currentEntries) {
    if (PATCH_EXCLUDE_FIELDS.has(key)) continue
    if (SNAPSHOT_EXCLUDE_FIELDS.has(key)) { patchData[key] = value; continue }
    const prevVal = prev ? prev[key] : undefined
    if (REF_EQUAL_FIELDS.has(key)) { if (value === prevVal) continue }
    else if (isDeepEqual(prevVal, value)) continue
    patchData[key] = value
  }
  for (const key of Object.keys(patchData)) {
    if (patchData[key] === undefined) patchData[key] = ''
  }
  return Object.keys(patchData).length > 0 ? patchData : null
}

const PATCH_DEBOUNCE_MS = 500

async function executePatch(botId: string, _retryCount = 0): Promise<boolean> {
  const bot = useBotStore.getState().bots.find(b => b.id === botId)
  if (!bot) { persistTimers.delete(botId); return false }
  const patchData = computePatchDiff(bot, botSnapshots.get(botId))
  if (!patchData) { persistTimers.delete(botId); return false }
  try {
    const res = await authFetch(`/api/bots/${botId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchData),
    })
    if (!res.ok) {
      if (res.status === 401) return false
      if (res.status >= 500 && _retryCount < 2) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, _retryCount)))
        return executePatch(botId, _retryCount + 1)
      }
      const errorBody = await res.text().catch(() => '')
      console.error(`[BotStore] PATCH /api/bots/${botId} failed: ${res.status}`, errorBody)
      if (res.status === 404) {
        const currentBot = useBotStore.getState().bots.find(b => b.id === botId)
        if (currentBot) {
          botSnapshots.set(botId, createFilteredSnapshot(currentBot))
        }
        persistTimers.delete(botId)
      }
      return false
    }
    const updated = await res.json()
    const currentBot = useBotStore.getState().bots.find(b => b.id === botId)
    if (currentBot) {
      botSnapshots.set(botId, createFilteredSnapshot(currentBot))
    }
    persistTimers.delete(botId)
    return true
  } catch (error) {
    if (_retryCount < 2) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, _retryCount)))
      return executePatch(botId, _retryCount + 1)
    }
    console.error(`[BotStore] PATCH /api/bots/${botId} error:`, error)
    persistTimers.delete(botId)
    return false
  }
}

function schedulePatch(botId: string, _getBot?: () => Bot | undefined) {
  if (persistTimers.has(botId)) return
  persistTimers.set(botId, setTimeout(() => {
    executePatch(botId)
  }, PATCH_DEBOUNCE_MS))
}

async function flushPendingPatch(botId: string, _getBot?: () => Bot | undefined): Promise<boolean> {
  const timer = persistTimers.get(botId)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(botId)
  }
  const result = await executePatch(botId)
  if (!result) {
    showErrorToastWithCooldown(botId)
  }
  return result
}

/**
 * SECURITY: Dedicated envVars persistence function.
 * Sends ONLY envVars to the server via PATCH, ensuring the merge logic
 * in the PATCH handler preserves existing encrypted values.
 * This avoids the risk of schedulePatch sending masked placeholders (••••••••••••)
 * that would destroy real encrypted secrets.
 */
const pendingEnvVarRequests = new Map<string, Promise<void>>()
const envVarRetryCount = new Map<string, number>()
const ENV_VAR_MAX_RETRIES = 2
const errorToastCooldown = new Map<string, number>()
const ERROR_TOAST_COOLDOWN_MS = 30_000

function showErrorToastWithCooldown(botId: string) {
  const now = Date.now()
  const lastShown = errorToastCooldown.get(botId) || 0
  if (now - lastShown < ERROR_TOAST_COOLDOWN_MS) return
  errorToastCooldown.set(botId, now)
  const locale = useI18nStore.getState().locale
  const t = (key: string, params?: Record<string, string | number>) => getTranslation(locale, key as any, params)
  toast.error(t('common.saveFailed'), { description: t('common.saveFailedDesc') })
}

function persistEnvVarsToServer(botId: string) {
  if (pendingEnvVarRequests.has(botId)) return
  const retries = envVarRetryCount.get(botId) || 0
  if (retries >= ENV_VAR_MAX_RETRIES) {
    console.warn(`[BotStore] Max retries reached for env var persist of bot ${botId}, giving up`)
    envVarRetryCount.delete(botId)
    return
  }
  const state = useBotStore.getState()
  const bot = state.bots.find(b => b.id === botId)
  if (!bot) return
  const envVarsForServer = bot.envVars.map(({ id: _id, ...rest }) => rest)
  const promise = authFetch(`/api/bots/${botId}`, {
    method: 'PATCH',
    body: JSON.stringify({ envVars: envVarsForServer }),
  }).then(async (res) => {
    if (res.ok) {
      envVarRetryCount.delete(botId)
      const updated = await res.json()
      useBotStore.setState((state) => ({
        bots: state.bots.map((b) => {
          if (b.id !== botId) return b
          const serverEnvVars = (updated.envVars || b.envVars) as EnvVar[]
          const mergedEnvVars = serverEnvVars.map((sv: EnvVar) => {
            const existing = b.envVars.find((ev: EnvVar) => ev.key === sv.key)
            return { ...sv, id: existing?.id || sv.id || genId() }
          })
          return { ...b, envVars: mergedEnvVars }
        }),
      }))
      const currentBot = useBotStore.getState().bots.find(b => b.id === botId)
      if (currentBot) {
        botSnapshots.set(botId, createFilteredSnapshot(currentBot))
      }
    } else {
      envVarRetryCount.set(botId, retries + 1)
      showErrorToastWithCooldown(botId)
    }
  }).catch((e) => {
    envVarRetryCount.set(botId, retries + 1)
    console.warn(`Failed to persist env vars for bot ${botId}:`, e)
  }).finally(() => {
    pendingEnvVarRequests.delete(botId)
    const latestRetries = envVarRetryCount.get(botId) || 0
    if (latestRetries < ENV_VAR_MAX_RETRIES) {
      const latestBot = useBotStore.getState().bots.find(b => b.id === botId)
      if (latestBot && !pendingEnvVarRequests.has(botId)) {
        const prev = botSnapshots.get(botId)
        const currentEnvVars = latestBot.envVars.map(({ id: _id, ...rest }) => rest)
        const prevEnvVars = (prev?.envVars || []) as EnvVar[]
        const prevForCompare = prevEnvVars.map(({ id: _id, ...rest }) => rest)
        if (JSON.stringify(currentEnvVars) !== JSON.stringify(prevForCompare)) {
          persistEnvVarsToServer(botId)
        }
      }
    }
  })
  pendingEnvVarRequests.set(botId, promise)
}

/**
 * Persist a new bot via POST (creation).
 * P0 FIX: Changed from PUT to POST because PUT returns 404 for non-existent bots
 * after the upsert→update migration. POST creates with server-assigned ID.
 */
async function persistNewBot(bot: Bot): Promise<string | null> {
  try {
    const res = await authFetch('/api/bots', {
      method: 'POST',
      body: JSON.stringify(bot),
    })
    if (res.ok) {
      const data = await res.json()
      const serverId = data.id
      if (!serverId || typeof serverId !== 'string') {
        console.warn('Server did not return a valid bot ID:', data)
        return null
      }
      dbBotIds.add(serverId)
      return serverId
    } else {
      const errText = await res.text().catch(() => 'Unknown error')
      console.warn(`Failed to persist new bot: HTTP ${res.status}:`, errText)
      return null
    }
  } catch (e) {
    console.warn(`Failed to persist new bot ${bot.id}:`, e)
    return null
  }
}

/**
 * P2-2 FIX: Delete a bot from the database with proper error handling.
 * Awaits the result so UI/DB state stays in sync.
 */
async function deleteBotFromDB(botId: string): Promise<boolean> {
  try {
    const res = await authFetch(`/api/bots/${botId}`, { method: 'DELETE' })
    if (res.ok) {
      dbBotIds.delete(botId)
      return true
    }
    console.warn(`Failed to delete bot ${botId}: HTTP ${res.status}`)
    return false
  } catch (e) {
    console.warn(`Failed to delete bot ${botId}:`, e)
    return false
  }
}

/**
 * Write a log entry to the BotLog table (separate from bot JSON).
 */
function persistLogEntry(botId: string, entry: Omit<LogEntry, 'id'>) {
  authFetch(`/api/bots/${botId}/logs`, {
    method: 'POST',
    body: JSON.stringify(entry),
  }).catch((e) => {
    console.warn(`Failed to persist log for bot ${botId}:`, e)
  })
}

/** Simple fuzzy match: checks if all characters in the query appear in order in the target */
function isFuzzyMatch(target: string, query: string): boolean {
  if (!query || !target) return false
  let ti = 0
  for (let qi = 0; qi < query.length; qi++) {
    const char = query[qi]
    // Find the next occurrence of this character in target
    while (ti < target.length && target[ti] !== char) {
      ti++
    }
    if (ti >= target.length) return false
    ti++ // Move past the matched character
  }
  return true
}

/** Generate template code for a new code block based on its type and language */
function getCodeTemplate(type: CodeBlock['type'], language: CodeBlock['language']): string {
  if (language === 'python') {
    switch (type) {
      case 'handler':
        return `# Message handler\nasync def handle_message(update, context):\n    message = update.effective_message\n    # TODO: Handle incoming message\n    pass`
      case 'middleware':
        return `# Middleware\nasync def middleware(update, context):\n    # TODO: Process before handler\n    pass`
      case 'command':
        return `# Command handler\nasync def start_command(update, context):\n    await update.message.reply_text('Hello! I am your bot.')`
      case 'callback':
        return `# Callback query handler\nasync def callback_handler(update, context):\n    query = update.callback_query\n    # TODO: Handle callback\n    await query.answer()`
      case 'action':
        return `# Action handler\nasync def action_handler(update, context):\n    # TODO: Execute action\n    pass`
      case 'cron':
        return `# Cron job\nimport asyncio\n\nasync def cron_job():\n    # TODO: Scheduled task\n    pass`
      default:
        return '# New code block\npass'
    }
  }
  // TypeScript / JavaScript
  switch (type) {
    case 'handler':
      return `// Message handler\nbot.on('message', async (ctx) => {\n  // TODO: Handle incoming message\n});`
    case 'middleware':
      return `// Middleware\nbot.use(async (ctx, next) => {\n  // TODO: Process before handler\n  await next();\n});`
    case 'command':
      return `// /start command\nbot.command('start', async (ctx) => {\n  await ctx.reply('Hello! I am your bot.');\n});`
    case 'callback':
      return `// Callback query handler\nbot.action('callback_data', async (ctx) => {\n  // TODO: Handle callback\n  await ctx.answerCbQuery();\n});`
    case 'action':
      return `// Action handler\nbot.action('action', async (ctx) => {\n  // TODO: Execute action\n});`
    case 'cron':
      return `// Cron job — runs on schedule\nimport cron from 'node-cron';\n\ncron.schedule('*/5 * * * *', () => {\n  // TODO: Scheduled task (every 5 minutes)\n});`
    default:
      return '// New code block\n'
  }
}

// ─── Store ─────────────────────────────────────────────────────────────────

let hasHydrated = false

/** Check if the initial bot hydration from DB has completed */
export function getHasHydrated(): boolean {
  return hasHydrated
}

/** P0 FIX: Reset hydration flags so hydrateFromDB can be called again after auth */
export function resetHydration() {
  hasHydrated = false
  useBotStore.setState({ _hasHydrated: false, _isHydrating: false, bots: [], selectedBotId: null })
  for (const [, timer] of persistTimers.entries()) {
    clearTimeout(timer)
  }
  persistTimers.clear()
  botSnapshots.clear()
  dbBotIds.clear()
  pendingEnvVarRequests.clear()
  lastLogFetchTime.clear()
  logDedupKeys.clear()
}

export const useBotStore = create<BotStore>((set, get) => ({
  bots: [],
  selectedBotId: null,
  viewMode: 'grid',
  searchQuery: '',
  statusFilter: 'all',
  sortBy: 'updatedAt',
  sortOrder: 'desc',
  createBotDialogOpen: false,
  createBotDialogMode: 'create' as const,
  editBotId: null,
  _hasHydrated: false,
  _isHydrating: false,
  currentPage: 1,
  pageSize: PAGINATION.DEFAULT_PAGE_SIZE,
  // ─── Persistence ──────────────────────────────────────────────────────────

  hydrateFromDB: async () => {
    // Only hydrate on client-side
    if (typeof window === 'undefined') return
    if (hasHydrated) return
    if (get()._isHydrating) return

    set({ _isHydrating: true })
    const MAX_RETRIES = 3
    let attempt = 0

    while (attempt < MAX_RETRIES) {
      try {
        let allBots: Bot[] = []
        let page = 1
        let hasMore = true

        while (hasMore) {
          const res = await authFetch(`/api/bots?page=${page}&pageSize=${PAGINATION.HYDRATION_PAGE_SIZE}`)
          if (!res.ok) break
          const data = await res.json()
          const raw: Bot[] = Array.isArray(data.data)
            ? data.data
            : Array.isArray(data.bots)
              ? data.bots
              : []
          allBots = allBots.concat(raw.map(normalizeBot))
          hasMore = data.pagination?.hasNextPage ?? false
          page++
          if (page > 10) break
        }

        if (allBots.length > 0 || page > 1) {
          if (hasMore && allBots.length > 0) {
            console.warn(`[BotStore] Partial hydration: got ${allBots.length} bots, more pages available`)
          }
          const currentBots = get().bots
          const mergedBots = allBots.map((dbBot) => {
            const liveBot = currentBots.find(b => b.id === dbBot.id)
            if (liveBot && liveBot.lastRunnerStatus && liveBot.lastRunnerStatus !== 'stopped') {
              return {
                ...dbBot,
                status: liveBot.status,
                health: liveBot.health,
                lastRunnerStatus: liveBot.lastRunnerStatus,
                lastDeployedAt: liveBot.lastDeployedAt || dbBot.lastDeployedAt,
              }
            }
            return dbBot
          })
          set({ bots: mergedBots })
          dbBotIds.clear()
          allBots.forEach((b: { id: string }) => dbBotIds.add(b.id))
          for (const [timerBotId, timer] of persistTimers.entries()) {
            clearTimeout(timer)
            persistTimers.delete(timerBotId)
          }
          botSnapshots.clear()
          for (const bot of allBots) {
            botSnapshots.set(bot.id, createFilteredSnapshot(bot))
          }
          hasHydrated = true
          set({ _hasHydrated: true })
          break
        }
      } catch (e) {
        console.warn(`Failed to hydrate from DB (attempt ${attempt + 1}/${MAX_RETRIES}):`, e)
      }
      attempt++
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 1s, 2s
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)))
      }
    }

    set({ _isHydrating: false })
  },

  // ─── Computed ────────────────────────────────────────────────────────────

  filteredBots: () => {
    const { bots, searchQuery, statusFilter, sortBy, sortOrder } = get()
    const noFilter = statusFilter === 'all' && !searchQuery.trim()
    let filtered = bots

    if (statusFilter !== 'all') {
      filtered = filtered.filter((b) => b.status === statusFilter)
    }

    if (searchQuery.trim()) {
      const terms = searchQuery.toLowerCase().trim().split(/\s+/)
      filtered = filtered.filter((b) => {
        const searchableFields = [
          b.name,
          b.description,
          b.language,
          b.template,
        ].map(f => f.toLowerCase())
        return terms.every(term =>
          searchableFields.some(field => field.includes(term) || isFuzzyMatch(field, term))
        )
      })
    }

    if (filtered.length <= 1) return filtered

    if (noFilter && sortBy === 'updatedAt' && sortOrder === 'desc') return filtered

    return [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortBy) {
        case 'name':
          cmp = a.name.localeCompare(b.name)
          break
        case 'createdAt':
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          break
        case 'updatedAt':
          cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
          break
        case 'status': {
          const order = { active: 0, deploying: 1, error: 2, inactive: 3 }
          cmp = (order[a.status] ?? 4) - (order[b.status] ?? 4)
          break
        }
      }
      return sortOrder === 'desc' ? -cmp : cmp
    })
  },

  // ─── UI Actions ──────────────────────────────────────────────────────────

  setSelectedBotId: (id) => {
    set({ selectedBotId: id })
    // P0-1 OPT: Fetch full bot data for detail view (list API excludes heavy fields)
    // Also fetch real stats from BotMessage/BotLog tables
    if (id) {
      get().fetchBotDetail(id)
      get().fetchBotStats(id)
    }
  },
  setViewMode: (mode) => set({ viewMode: mode }),
  setSearchQuery: (q) => set({ searchQuery: q, currentPage: 1 }),
  setStatusFilter: (f) => set({ statusFilter: f, currentPage: 1 }),
  setSortBy: (s) => set({ sortBy: s, currentPage: 1 }),
  setSortOrder: (o) => set({ sortOrder: o, currentPage: 1 }),
  setCurrentPage: (page) => set({ currentPage: page }),
  setPageSize: (size) => set({ pageSize: size, currentPage: 1 }),
  resetPagination: () => set({ currentPage: 1 }),
  setCreateBotDialogOpen: (open) => set({ createBotDialogOpen: open }),
  setCreateBotDialogMode: (mode) => set({ createBotDialogMode: mode }),
  setEditBotId: (id) => set({ editBotId: id }),

  // ─── Mutation Actions ────────────────────────────────────────────────────

  addBot: (params) => {
    const newBot = normalizeBot({
      id: genId(),
      name: params.name,
      description: params.description,
      emoji: params.emoji,
      customIcon: params.customIcon,
      status: 'inactive',
      health: 'unknown',
      language: params.language,
      template: params.template,
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      code: params.code || '',
      codeBlocks: params.codeBlocks?.length ? params.codeBlocks : [],
      dependencies: params.dependencies?.length ? params.dependencies : [{ id: genId(), name: 'telegraf', version: '4.15.0', isRequired: true, description: '' }],
      envVars: params.envVars?.length ? params.envVars : [{ id: genId(), key: 'BOT_TOKEN', value: '', isEncrypted: true, description: 'Telegram Bot Token from @BotFather' }],
      config: {
        pollingMode: 'polling',
        webhookSecret: genWebhookSecret(),
        rateLimitPerMinute: 30,
        maxConcurrentRequests: 10,
        autoRestart: true,
        logLevel: 'info',
        timeout: 30,
      },
      stats: {
        messages: 0,
        users: 0,
        uptime: 0,
        errors: 0,
        dailyMessages: [],
        topCommands: [],
        hourlyActivity: Array.from({ length: 24 }, () => 0),
      },
      logs: [],
      projectFiles: params.projectFiles,
      entryPoint: params.entryPoint,
    })
    set((state) => ({ bots: [newBot, ...state.bots] }))

    const clientUUID = newBot.id
    const creationTimeout = setTimeout(() => {
      const store = get()
      const bot = store.bots.find(b => b.id === clientUUID)
      if (bot && !dbBotIds.has(clientUUID)) {
        console.warn(`[BotStore] Bot ${newBot.name} (${clientUUID}) persist timed out after 15s — keeping in store, persistNewBot may still resolve`)
      }
    }, 15000)

    persistNewBot(newBot).then((serverId) => {
      clearTimeout(creationTimeout)
      if (!serverId) return
      dbBotIds.add(serverId)

      if (serverId !== newBot.id) {
        set((state) => ({
          bots: state.bots.map(b => b.id === newBot.id ? { ...b, id: serverId } : b),
          ...(state.selectedBotId === newBot.id ? { selectedBotId: serverId } : {}),
        }))
        const snapshot = botSnapshots.get(newBot.id)
        if (snapshot) {
          botSnapshots.delete(newBot.id)
          botSnapshots.set(serverId, { ...snapshot, id: serverId })
        }
        const pendingTimer = persistTimers.get(newBot.id)
        if (pendingTimer) {
          clearTimeout(pendingTimer)
          persistTimers.delete(newBot.id)
          schedulePatch(serverId, () => get().bots.find(b => b.id === serverId))
        }
      }
      const currentBot = get().bots.find(b => b.id === serverId)
      if (currentBot) {
        botSnapshots.set(serverId, createFilteredSnapshot(currentBot))
      }
    }).catch(() => { clearTimeout(creationTimeout) })
  },

  updateBot: (id, data) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== id) return b
        return {
          ...b,
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(id, () => get().bots.find(b => b.id === id))
  },

  deleteBot: async (id) => {
    const current = get()
    const botName = current.bots.find((b) => b.id === id)?.name ?? 'Bot'
    set({
      bots: current.bots.filter((b) => b.id !== id),
      ...(current.selectedBotId === id && { selectedBotId: null }),
    })
    botSnapshots.delete(id)
    logDedupKeys.delete(id)
    lastLogFetchTime.delete(id)
    const pendingTimer = persistTimers.get(id)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      persistTimers.delete(id)
    }

    // P2-2 FIX: Handle delete result — show error if DB delete fails
    const success = await deleteBotFromDB(id)
    // BUG FIX: Use i18n for delete toast messages (was hardcoded English)
    const locale = useI18nStore.getState().locale
    const t = (key: string, params?: Record<string, string | number>) => getTranslation(locale, key as any, params)
    if (success) {
      toast.success(t('botCard.deleteSuccess', { name: botName }), { description: t('botCard.deleteSuccessDesc') })
    } else {
      // Re-add the bot to the store if DB delete failed
      // BUG FIX: Insert at the same position (after bots that were before it, before bots after)
      // rather than prepending — prepending causes the bot to jump to the top of the list
      const bot = current.bots.find((b) => b.id === id)
      if (bot) {
        set((state) => {
          const originalIndex = current.bots.findIndex(b => b.id === id)
          const insertIndex = originalIndex >= 0 ? Math.min(originalIndex, state.bots.length) : state.bots.length
          const newBots = [...state.bots]
          newBots.splice(insertIndex, 0, bot)
          // BUG FIX: Also restore selectedBotId if it was set to this bot before deletion.
          // Without this, the user is kicked out of the detail page even though
          // the bot still exists after the rollback.
          return {
            bots: newBots,
            ...(current.selectedBotId === id ? { selectedBotId: id } : {}),
          }
        })
      }
      // FIX: Show error toast so user knows deletion failed
      toast.error(t('botCard.deleteFailed', { name: botName }), { description: t('botCard.deleteFailedDesc') })
    }
  },

  toggleCodeBlock: (botId, blockId) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          codeBlocks: b.codeBlocks.map((cb) =>
            cb.id === blockId ? { ...cb, isActive: !cb.isActive } : cb
          ),
          // BUG FIX: Set codeDirty=true because toggling a code block's active state
          // changes which code is included in the deployed output.
          // Without this, the user wouldn't see the "pending redeploy" indicator
          // after toggling blocks, and might not know they need to redeploy.
          codeDirty: true,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  updateBotConfig: (botId, config) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          config: { ...b.config, ...config },
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  addDependency: (botId, dep) => {
    const newDep: Dependency = { id: genId(), ...dep }
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          dependencies: [...b.dependencies, newDep],
          codeDirty: true,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  removeDependency: (botId, depId) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          dependencies: b.dependencies.filter((d) => d.id !== depId),
          codeDirty: true,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  updateDependency: (botId, depId, updates) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          dependencies: b.dependencies.map((d) =>
            d.id === depId ? { ...d, ...updates } : d
          ),
          codeDirty: true,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  addEnvVar: (botId, envVar) => {
    const newEnv: EnvVar = { id: genId(), ...envVar }
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          envVars: [...b.envVars, newEnv],
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    // SECURITY: Use dedicated envVars persist instead of schedulePatch
    // to avoid sending masked placeholders that destroy encrypted secrets
    persistEnvVarsToServer(botId)
  },

  updateEnvVar: (botId, envVarId, updates) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          envVars: b.envVars.map((v) =>
            v.id === envVarId ? { ...v, ...updates } : v
          ),
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    persistEnvVarsToServer(botId)
  },

  removeEnvVar: (botId, envVarId) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          envVars: b.envVars.filter((v) => v.id !== envVarId),
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    persistEnvVarsToServer(botId)
  },

  addLogEntry: (botId, entry) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          logs: [{ id: genId(), ...entry }, ...b.logs].slice(0, MAX_LOGS_PER_BOT),
        }
      }),
    }))
    // Persist log to BotLog table (canonical log store)
    persistLogEntry(botId, entry)
  },

  /**
   * Add a log entry to the store ONLY (no DB persist).
   * Used for SSE-delivered logs that are already in the DB,
   * avoiding double-persist and duplicate entries.
   * Deduplicates by timestamp + message + level to handle SSE reconnects.
   */
  addLogEntryLocal: (botId, entry) => {
    const dedupKey = `${entry.timestamp}:${entry.message}:${entry.level}`
    let dedupSet = logDedupKeys.get(botId)
    if (!dedupSet) {
      dedupSet = new Set()
      logDedupKeys.set(botId, dedupSet)
    }
    if (dedupSet.has(dedupKey)) return
    dedupSet.add(dedupKey)
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        const newLogs = [{ id: genId(), ...entry }, ...b.logs]
        if (newLogs.length > MAX_LOGS_PER_BOT) {
          const removed = newLogs.slice(MAX_LOGS_PER_BOT)
          const currentDedupSet = logDedupKeys.get(botId)
          if (currentDedupSet) {
            for (const r of removed) {
              currentDedupSet.delete(`${r.timestamp}:${r.message}:${r.level}`)
            }
          }
        }
        return {
          ...b,
          logs: newLogs.slice(0, MAX_LOGS_PER_BOT),
        }
      }),
    }))
  },

  /**
   * P1-8 FIX: Fetch historical logs from BotLog table.
   * Called when a bot is selected to populate the logs view with DB data.
   *
   * PERF FIX: Incremental updates — on subsequent calls, only fetch logs newer
   * than lastLogFetchTime[botId]. This avoids O(n) merge + O(n log n) sort on
   * every poll cycle when there are few or no new logs.
   */
  fetchBotLogs: async (botId) => {
    try {
      // P2-18 FIX: Use authFetch instead of plain fetch to avoid 401 errors
      const since = lastLogFetchTime.get(botId)
      const url = since
        ? `/api/bots/${botId}/logs?limit=${MAX_LOGS_PER_BOT}&since=${encodeURIComponent(since)}`
        : `/api/bots/${botId}/logs?limit=${MAX_LOGS_PER_BOT}`

      const res = await authFetch(url)
      if (res.ok) {
        const data = await res.json()
        const logEntries: LogEntry[] = (data.logs || []).map((entry: Record<string, unknown>) => ({
          id: entry.id as string,
          timestamp: entry.timestamp as string,
          level: entry.level as LogEntry['level'],
          message: entry.message as string,
          source: entry.source as string,
        }))

        set((state) => ({
          bots: state.bots.map((b) => {
            if (b.id !== botId) return b

            if (!since || b.logs.length === 0) {
              // First load or empty state — full replace (no merge needed)
              const sorted = [...logEntries].sort(
                (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
              )
              // Track the newest timestamp for next incremental fetch
              if (sorted.length > 0) {
                lastLogFetchTime.set(botId, sorted[0].timestamp)
              }
              return { ...b, logs: sorted.slice(0, MAX_LOGS_PER_BOT) }
            }

            // Incremental: prepend new entries, deduplicate by id, trim
            const existingIds = new Set(b.logs.map(l => l.id))
            const trulyNew = logEntries.filter(l => !existingIds.has(l.id))
            if (trulyNew.length === 0) return b // No new logs — skip render

            const merged = [...trulyNew, ...b.logs].slice(0, MAX_LOGS_PER_BOT)
            // Update last fetch time to the newest entry we've seen
            if (logEntries.length > 0) {
              const newest = logEntries.reduce((latest, e) =>
                new Date(e.timestamp).getTime() > new Date(latest.timestamp).getTime() ? e : latest,
              )
              lastLogFetchTime.set(botId, newest.timestamp)
            }
            return { ...b, logs: merged }
          }),
        }))
      }
    } catch {
      // Silently fail — logs will be empty until SSE delivers new ones
    }
  },

  updateCodeBlock: (botId, blockId, code) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          codeBlocks: b.codeBlocks.map((cb) =>
            cb.id === blockId ? { ...cb, code, lastModified: new Date().toISOString() } : cb
          ),
          codeDirty: true,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  addCodeBlock: (botId, block) => {
    const newBlock: CodeBlock = {
      id: genId(),
      name: block.name,
      type: block.type,
      language: block.language,
      code: block.code || getCodeTemplate(block.type, block.language),
      isActive: true,
      lastModified: new Date().toISOString(),
      description: block.description,
    }
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          codeBlocks: [...b.codeBlocks, newBlock],
          codeDirty: true,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  removeCodeBlock: (botId, blockId) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          codeBlocks: b.codeBlocks.filter((cb) => cb.id !== blockId),
          codeDirty: true,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  updateBotEmoji: (botId, emoji, customIcon) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        return {
          ...b,
          emoji,
          // BUG FIX: Always include customIcon — undefined means "clear custom icon".
          // Previously, undefined was not spread (conditional spread), so switching
          // from a custom icon to a standard emoji would keep the old customIcon,
          // causing the avatar to keep showing the custom icon instead of the emoji.
          customIcon,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },

  // ─── Detail Fetch ───────────────────────────────────────────────────────

  /**
   * P0-1 OPT: Fetch full bot data from GET /api/bots/[id].
   * The list API excludes heavy fields (projectFiles, code, envVars) for performance.
   * This fetches the complete bot data when the user opens the detail view.
   */
  fetchBotDetail: async (botId) => {
    try {
      // BUG FIX: Flush any pending debounced PATCH before fetching from DB.
      // Without this, in-flight changes (within the 500ms debounce window)
      // would be silently lost when fetchBotDetail overwrites the store.
      await flushPendingPatch(botId, () => get().bots.find(b => b.id === botId))

      const res = await authFetch(`/api/bots/${botId}`)
      if (res.ok) {
        const data = await res.json()
        const fullBot = normalizeBot(data)
        set((state) => ({
          bots: state.bots.map((b) => {
            if (b.id !== botId) return b
            // FIX: Preserve live runner-synced status fields AND real-time stats over stale DB data.
            // When the runner has just stopped a bot and syncRunnerStatus updated
            // the store to 'inactive', but the debounced PATCH (500ms) hasn't
            // persisted yet, the API returns the old status='active'.
            // Without this, fetchBotDetail would overwrite the correct runner-synced
            // status, causing the header badge and bot card to show "运行中" while
            // the runtime control shows "已停止".
            //
            // Stats race condition: fetchBotStats (real-time from BotMessage/BotLog)
            // may resolve before fetchBotDetail (full DB data). If we don't preserve
            // b.stats, the stale DB stats overwrite the fresh real-time stats,
            // causing "messages: 0, users: 0, errors: 0" to flash briefly.
            return {
              ...fullBot,
              logs: b.logs,
              status: b.status,
              health: b.health,
              lastRunnerStatus: b.lastRunnerStatus,
              lastDeployedAt: b.lastDeployedAt || fullBot.lastDeployedAt,
              stats: {
                ...fullBot.stats,
                // Preserve live stats from store (may come from fetchBotStats or runner resources)
                messages: b.stats.messages,
                users: b.stats.users,
                errors: b.stats.errors,
                uptime: b.stats.uptime,
                // BUG FIX: Also preserve real-time chart data from fetchBotStats.
                // Without this, fetchBotDetail (full DB data) overwrites
                // dailyMessages/topCommands/hourlyActivity from fetchBotStats
                // (real-time from BotMessage/BotLog tables) with stale data
                // from the stats JSON column in the Bot table.
                dailyMessages: b.stats.dailyMessages,
                topCommands: b.stats.topCommands,
                hourlyActivity: b.stats.hourlyActivity,
              },
            }
          }),
        }))
        // Update snapshot for dirty tracking so we don't re-persist fetched data
        // Use the current store bot (with preserved status) for the snapshot
        const currentBot = get().bots.find(b => b.id === botId)
        if (currentBot) {
          botSnapshots.set(botId, createFilteredSnapshot(currentBot))
        }
      } else if (res.status === 404) {
        const localBot = get().bots.find(b => b.id === botId)
        if (localBot) {
          const MAX_404_RETRIES = 3
          for (let retry = 0; retry < MAX_404_RETRIES; retry++) {
            await new Promise(r => setTimeout(r, 500 * (retry + 1)))
            const retryRes = await authFetch(`/api/bots/${botId}`)
            if (retryRes.ok) {
              const data = await retryRes.json()
              const fullBot = normalizeBot(data)
              set((state) => ({
                bots: state.bots.map((b) => {
                  if (b.id !== botId) return b
                  // BUG FIX: Preserve live runner-synced status fields in 404 retry path,
                  // same as the main success path (see lines 1192-1215).
                  // Without this, stale DB data overwrites the correct runner-synced status.
                  return {
                    ...fullBot,
                    logs: b.logs,
                    status: b.status,
                    health: b.health,
                    lastRunnerStatus: b.lastRunnerStatus,
                    lastDeployedAt: b.lastDeployedAt || fullBot.lastDeployedAt,
                    stats: {
                      ...fullBot.stats,
                      messages: b.stats.messages,
                      users: b.stats.users,
                      errors: b.stats.errors,
                      uptime: b.stats.uptime,
                      dailyMessages: b.stats.dailyMessages,
                      topCommands: b.stats.topCommands,
                      hourlyActivity: b.stats.hourlyActivity,
                    },
                  }
                }),
              }))
              const currentBot = get().bots.find(b => b.id === botId)
              if (currentBot) {
                botSnapshots.set(botId, createFilteredSnapshot(currentBot))
              }
              break
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch bot detail for ${botId}:`, e)
    }
  },

  // ─── Runner Status Sync ─────────────────────────────────────────────────
  // Bridges WebSocket runner status → Zustand store status
  // so bot-card, bot-detail, filters all reflect the real runtime state.

  syncRunnerStatus: (botId, runnerStatus) => {
    const statusMap: Record<string, Bot['status'] | null> = {
      running: 'active',
      starting: 'deploying',
      deploying: 'deploying',
      error: 'error',
      stopping: 'deploying',
      stopped: 'inactive',
    }
    const mapped = statusMap[runnerStatus]
    if (!mapped) return

    const healthMap: Record<string, Bot['health']> = {
      running: 'healthy',
      starting: 'warning',
      deploying: 'warning',
      error: 'critical',
      stopping: 'unknown',
      stopped: 'unknown',
    }

    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b

        const newHealth = healthMap[runnerStatus] || b.health

        if (b.status === mapped && b.health === newHealth && b.lastRunnerStatus === runnerStatus) return b

        return {
          ...b,
          status: mapped,
          health: newHealth,
          lastRunnerStatus: runnerStatus,
          lastDeployedAt: runnerStatus === 'running' && b.lastRunnerStatus !== 'running'
            && (b.lastRunnerStatus || !b.lastDeployedAt)
            ? new Date().toISOString()
            : b.lastDeployedAt,
          codeDirty: b.codeDirty,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    const updatedBot = get().bots.find(b => b.id === botId)
    if (updatedBot) {
      const existingSnapshot = botSnapshots.get(botId)
      if (existingSnapshot) {
        botSnapshots.set(botId, {
          ...existingSnapshot,
          status: updatedBot.status,
          health: updatedBot.health,
          lastRunnerStatus: updatedBot.lastRunnerStatus,
          lastDeployedAt: updatedBot.lastDeployedAt,
          codeDirty: updatedBot.codeDirty,
          updatedAt: updatedBot.updatedAt,
        })
      }
    }
    const patchBot = get().bots.find(b => b.id === botId)
    const patchSnapshot = botSnapshots.get(botId)
    if (patchBot && patchSnapshot) {
      const diff = computePatchDiff(patchBot, patchSnapshot)
      if (diff) {
        schedulePatch(botId, () => get().bots.find(b => b.id === botId))
      }
    }
  },

  // ─── Stats Fetch ───────────────────────────────────────────────────────

  /**
   * Fetch real-time stats computed from BotMessage + BotLog tables.
   * Updates bot.stats in the store with real data (messages, users, errors,
   * dailyMessages, hourlyActivity, topCommands).
   * Does NOT overwrite uptime/CPU/memory — those come from the runner context.
   */
  fetchBotStats: async (botId) => {
    try {
      const res = await authFetch(`/api/bots/${botId}/stats`)
      if (res.ok) {
        const statsData = await res.json()
        set((state) => ({
          bots: state.bots.map((b) => {
            if (b.id !== botId) return b
            return {
              ...b,
              stats: {
                ...b.stats,
                messages: statsData.messages ?? 0,
                users: statsData.users ?? 0,
                errors: statsData.errors ?? 0,
                dailyMessages: statsData.dailyMessages ?? [],
                hourlyActivity: statsData.hourlyActivity ?? Array.from({ length: 24 }, () => 0),
                topCommands: statsData.topCommands ?? [],
              },
            }
          }),
        }))
      } else if (res.status === 404) {
        // RACE CONDITION FIX: If we get 404, the bot may not be in the DB yet.
        // Retry after a short delay. Only retry if the bot exists in the local store.
        const localBot = get().bots.find(b => b.id === botId)
        if (localBot) {
          await new Promise(r => setTimeout(r, 500))
          const retryRes = await authFetch(`/api/bots/${botId}/stats`)
          if (retryRes.ok) {
            const statsData = await retryRes.json()
            set((state) => ({
              bots: state.bots.map((b) => {
                if (b.id !== botId) return b
                return {
                  ...b,
                  stats: {
                    ...b.stats,
                    messages: statsData.messages ?? 0,
                    users: statsData.users ?? 0,
                    errors: statsData.errors ?? 0,
                    dailyMessages: statsData.dailyMessages ?? [],
                    hourlyActivity: statsData.hourlyActivity ?? Array.from({ length: 24 }, () => 0),
                    topCommands: statsData.topCommands ?? [],
                  },
                }
              }),
            }))
          }
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch stats for bot ${botId}:`, e)
    }
  },

  // ─── Project File Update ────────────────────────────────────────────────

  /**
   * Update the content of a single project file by path.
   * Used by CodeDisplay in ProjectFilesSection to allow inline editing of project files.
   */
  updateProjectFile: (botId, filePath, newContent) => {
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        if (!b.projectFiles) return b
        return {
          ...b,
          projectFiles: b.projectFiles.map((f) =>
            f.path === filePath
              ? { ...f, content: newContent, size: new TextEncoder().encode(newContent).length }
              : f
          ),
          codeDirty: true,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
  },
  // Check if a bot's ID has been confirmed persisted to the server
  isBotPersisted: (botId) => dbBotIds.has(botId),
}))

// ─── Auto-hydrate on client side ──────────────────────────────────────────
if (typeof window !== 'undefined') {
  import('@/store/auth-store').then(({ useAuthStore }) => {
    if (useAuthStore.getState().isAuthenticated) {
      useBotStore.getState().hydrateFromDB()
    }
  }).catch(() => {})
}
