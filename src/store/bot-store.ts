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

function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
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

/** PERF FIX: Track last log fetch timestamp per bot for incremental updates */
const lastLogFetchTime = new Map<string, string>()

/** Fields to exclude from PATCH body (handled separately, read-only, or auto-managed by DB) */
const PATCH_EXCLUDE_FIELDS = new Set(['id', 'createdAt', 'logs', 'stats', 'updatedAt', 'envVars', 'codeDirty'])

/** Ensure a bot loaded from DB has all nested fields with safe defaults */
function normalizeBot(raw: Partial<Bot> & { id: string; name: string }): Bot {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? '',
    emoji: raw.emoji ?? '🤖',
    customIcon: raw.customIcon || undefined,
    status: raw.status ?? 'inactive',
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

/** P2-17 FIX: Deep equality check for dirty field tracking.
 * Uses JSON.stringify for objects/arrays and === for primitives.
 * Prevents unnecessary PATCH requests when complex fields haven't changed.
 */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Handle NaN: NaN !== NaN in JS, but they should be considered equal
  if (Number.isNaN(a) && Number.isNaN(b)) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a === 'object') {
    try {
      // Sort keys before comparing to handle key-order differences from spread operations
      const sortKeys = (_key: string, value: unknown) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return Object.keys(value as Record<string, unknown>).sort().reduce((obj: Record<string, unknown>, key) => {
            obj[key] = (value as Record<string, unknown>)[key]
            return obj
          }, {})
        }
        return value
      }
      return JSON.stringify(a, sortKeys) === JSON.stringify(b, sortKeys)
    } catch {
      return false
    }
  }
  return false
}

function schedulePatch(botId: string, getBot: () => Bot | undefined) {
  const existing = persistTimers.get(botId)
  if (existing) clearTimeout(existing)

  persistTimers.set(botId, setTimeout(async () => {
    persistTimers.delete(botId)
    const bot = getBot()
    if (!bot) return
    try {
      // P2-4: Track which fields changed and only send those
      const prev = botSnapshots.get(botId)
      const patchData: Record<string, unknown> = {}
      const currentEntries = Object.entries(bot)

      for (const [key, value] of currentEntries) {
        if (PATCH_EXCLUDE_FIELDS.has(key)) continue
        // P2-17 FIX: Use deep equality instead of shallow comparison for objects/arrays
        if (!prev || !Object.prototype.hasOwnProperty.call(prev, key) || !isDeepEqual(prev[key], value)) {
          patchData[key] = value
        }
      }
      // BUG FIX: Convert undefined values to '' for DB compatibility.
      // JSON.stringify omits keys with undefined values, so PATCH requests would
      // not include cleared fields (e.g., customIcon: undefined when switching
      // from a custom icon to a standard emoji). The DB uses empty string defaults
      // for all String fields, so '' is the correct "cleared" value.
      for (const key of Object.keys(patchData)) {
        if (patchData[key] === undefined) {
          patchData[key] = ''
        }
      }
      // P2 FIX: Remove client-side updatedAt — let Prisma @updatedAt handle it
      // patchData.updatedAt = new Date().toISOString()

      const res = await authFetch(`/api/bots/${botId}`, {
        method: 'PATCH',
        body: JSON.stringify(patchData),
      })

      if (!res.ok) {
        // BUG FIX: Don't update snapshot on failed PATCH.
        // Without this check, the snapshot is updated even on 404/500 responses,
        // causing subsequent changes to be silently dropped because the diff
        // against the snapshot shows no change. The data is lost permanently.
        console.warn(`PATCH failed for bot ${botId}: HTTP ${res.status}`)
        return
      }

      dbBotIds.add(botId)

      // P2 FIX: Only update snapshot AFTER successful persist
      // (prevents silently dropping failed updates)
      botSnapshots.set(botId, Object.fromEntries(currentEntries))
    } catch (e) {
      console.warn(`Failed to persist bot ${botId}:`, e)
    }
  }, 500))
}

/**
 * BUG FIX: Flush any pending debounced PATCH for a bot before fetchBotDetail
 * overwrites the store with stale DB data. Without this, changes made within
 * the 500ms debounce window are silently lost because:
 * 1. User edits code → schedulePatch (500ms debounce)
 * 2. fetchBotDetail resolves → overwrites store with stale DB data
 * 3. schedulePatch timer fires → no diff detected → PATCH never sent
 */
async function flushPendingPatch(botId: string, getBot: () => Bot | undefined): Promise<boolean> {
  const timer = persistTimers.get(botId)
  if (!timer) return true // No pending patch — nothing to flush
  clearTimeout(timer)
  persistTimers.delete(botId)
  // Execute the same persistence logic immediately
  const bot = getBot()
  if (!bot) return true
  try {
    const prev = botSnapshots.get(botId)
    const patchData: Record<string, unknown> = {}
    const currentEntries = Object.entries(bot)
    for (const [key, value] of currentEntries) {
      if (PATCH_EXCLUDE_FIELDS.has(key)) continue
      if (!prev || !Object.prototype.hasOwnProperty.call(prev, key) || !isDeepEqual(prev[key], value)) {
        patchData[key] = value
      }
    }
    // BUG FIX: Same undefined→'' conversion as schedulePatch (see comment there)
    for (const key of Object.keys(patchData)) {
      if (patchData[key] === undefined) {
        patchData[key] = ''
      }
    }
    if (Object.keys(patchData).length > 0) {
      const res = await authFetch(`/api/bots/${botId}`, {
        method: 'PATCH',
        body: JSON.stringify(patchData),
      })
      if (!res.ok) {
        // BUG FIX: Show error toast when flush fails instead of silently swallowing.
        // Without this, the user's edits are lost when fetchBotDetail overwrites
        // the store with stale DB data.
        const locale = useI18nStore.getState().locale
        const t = (key: string, params?: Record<string, string | number>) => getTranslation(locale, key as any, params)
        toast.error(t('common.saveFailed'), { description: t('common.saveFailedDesc') })
        return false
      }
      dbBotIds.add(botId)
      botSnapshots.set(botId, Object.fromEntries(currentEntries))
    }
  } catch (e) {
    console.warn(`Failed to flush persist bot ${botId}:`, e)
    // BUG FIX: Show error toast on network failure
    const locale = useI18nStore.getState().locale
    const t = (key: string, params?: Record<string, string | number>) => getTranslation(locale, key as any, params)
    toast.error(t('common.saveFailed'), { description: t('common.saveFailedDesc') })
    return false
  }
  return true
}

/**
 * SECURITY: Dedicated envVars persistence function.
 * Sends ONLY envVars to the server via PATCH, ensuring the merge logic
 * in the PATCH handler preserves existing encrypted values.
 * This avoids the risk of schedulePatch sending masked placeholders (••••••••••••)
 * that would destroy real encrypted secrets.
 */
function persistEnvVarsToServer(botId: string) {
  const state = useBotStore.getState()
  const bot = state.bots.find(b => b.id === botId)
  if (!bot) return
  // Strip the client-side `id` field from each env var before sending to server
  const envVarsForServer = bot.envVars.map(({ id: _id, ...rest }) => rest)
  authFetch(`/api/bots/${botId}`, {
    method: 'PATCH',
    body: JSON.stringify({ envVars: envVarsForServer }),
  }).then(async (res) => {
    if (res.ok) {
      const updated = await res.json()
      // Update snapshot so next schedulePatch doesn't see envVars as dirty
      const currentEntries = Object.entries(bot)
      botSnapshots.set(botId, Object.fromEntries(currentEntries))
      // Update the store with server response (e.g., re-masked encrypted values)
      useBotStore.setState((state) => ({
        bots: state.bots.map((b) => {
          if (b.id !== botId) return b
          return { ...b, envVars: updated.envVars || b.envVars }
        }),
      }))
    } else {
      const locale = useI18nStore.getState().locale
      const t = (key: string, params?: Record<string, string | number>) => getTranslation(locale, key as any, params)
      toast.error(t('common.saveFailed'), { description: t('common.saveFailedDesc') })
    }
  }).catch((e) => {
    console.warn(`Failed to persist env vars for bot ${botId}:`, e)
  })
}

/**
 * Persist a new bot via POST (creation).
 * P0 FIX: Changed from PUT to POST because PUT returns 404 for non-existent bots
 * after the upsert→update migration. POST creates with server-assigned ID.
 */
async function persistNewBot(bot: Bot): Promise<string> {
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
        return bot.id
      }
      dbBotIds.add(serverId)
      return serverId
    } else {
      const errText = await res.text().catch(() => 'Unknown error')
      console.warn(`Failed to persist new bot: HTTP ${res.status}:`, errText)
      return bot.id
    }
  } catch (e) {
    console.warn(`Failed to persist new bot ${bot.id}:`, e)
    return bot.id
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

let isHydrating = false
let hasHydrated = false

/** Check if the initial bot hydration from DB has completed */
export function getHasHydrated(): boolean {
  return hasHydrated
}

/** P0 FIX: Reset hydration flags so hydrateFromDB can be called again after auth */
export function resetHydration() {
  hasHydrated = false
  isHydrating = false
  // Also reset the reactive store state
  useBotStore.setState({ _hasHydrated: false })
  // BUG FIX: Clear pending persistence state on logout/reset.
  // Without this, stale persistTimers fire after logout, sending PATCH
  // requests with invalid auth tokens that generate 401 errors.
  for (const [, timer] of persistTimers.entries()) {
    clearTimeout(timer)
  }
  persistTimers.clear()
  botSnapshots.clear()
  dbBotIds.clear()
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
  currentPage: 1,
  pageSize: PAGINATION.DEFAULT_PAGE_SIZE,
  // ─── Persistence ──────────────────────────────────────────────────────────

  hydrateFromDB: async () => {
    // Only hydrate on client-side
    if (typeof window === 'undefined') return
    if (hasHydrated) return
    if (isHydrating) return

    isHydrating = true
    const MAX_RETRIES = 3
    let attempt = 0

    while (attempt < MAX_RETRIES) {
      try {
        // OPTIMIZED: Use HYDRATION_PAGE_SIZE for better performance
        // Loads first page of bots efficiently instead of requesting all at once
        const res = await authFetch(`/api/bots?page=1&pageSize=${PAGINATION.HYDRATION_PAGE_SIZE}`)
        if (res.ok) {
          const data = await res.json()
          // Handle new API response format: { data, pagination, meta }
          // Also support legacy format: { bots } for backward compatibility
          const raw: Bot[] = Array.isArray(data.data) 
            ? data.data 
            : Array.isArray(data.bots) 
              ? data.bots 
              : []
          
          // Normalize bots to ensure all nested fields have safe defaults
          const bots: Bot[] = raw.map(normalizeBot)
          set({ bots })
          dbBotIds.clear()
          bots.forEach((b: { id: string }) => dbBotIds.add(b.id))
          // BUG FIX: Clear stale persistTimers and botSnapshots from previous sessions.
          // Without this, deleted bots could have stale timers that PATCH to 404,
          // and stale snapshots could cause incorrect dirty-field detection,
          // silently overwriting server-side changes made by another session.
          for (const [timerBotId, timer] of persistTimers.entries()) {
            clearTimeout(timer)
            persistTimers.delete(timerBotId)
          }
          botSnapshots.clear()
          // Initialize dirty tracking snapshots
          for (const bot of bots) {
            botSnapshots.set(bot.id, Object.fromEntries(Object.entries(bot)))
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

    isHydrating = false
  },

  // ─── Computed ────────────────────────────────────────────────────────────

  filteredBots: () => {
    const { bots, searchQuery, statusFilter, sortBy, sortOrder } = get()
    let filtered = bots

    if (statusFilter !== 'all') {
      filtered = filtered.filter((b) => b.status === statusFilter)
    }

    // Task 12 FIX: Enhanced search — also searches language and template fields,
    // and supports multiple space-separated terms with AND logic (each term must
    // match at least one field). OPT-7: Added fuzzy matching as fallback so
    // abbreviations like "tg" match "telegram", "ts" match "typescript", etc.
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

    // Sort
    const sorted = [...filtered].sort((a, b) => {
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

    return sorted
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
  setSearchQuery: (q) => set({ searchQuery: q }),
  setStatusFilter: (f) => set({ statusFilter: f }),
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
    const newBot: Bot = {
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
    }
    set((state) => ({ bots: [newBot, ...state.bots] }))
    // P0 FIX: Use POST to create bot with client-provided ID.
    // The server now accepts the client ID (if valid), eliminating the
    // race condition where navigation polling finds the bot with a client
    // UUID that doesn't exist in the database yet.
    persistNewBot(newBot).then((serverId) => {
      // Add to known DB IDs immediately so the orphan detector doesn't remove it
      dbBotIds.add(serverId)

      if (serverId !== newBot.id) {
        // Server assigned a different ID (ID collision, extremely rare) — update store
        set((state) => ({
          bots: state.bots.map(b => b.id === newBot.id ? { ...b, id: serverId } : b),
          ...(state.selectedBotId === newBot.id ? { selectedBotId: serverId } : {}),
        }))
        // Update dirty tracking references
        const snapshot = botSnapshots.get(newBot.id)
        if (snapshot) {
          botSnapshots.delete(newBot.id)
          botSnapshots.set(serverId, { ...snapshot, id: serverId })
        }
      }
      // Take snapshot after creation for dirty tracking
      botSnapshots.set(serverId, Object.fromEntries(Object.entries(get().bots.find(b => b.id === serverId) || [])))
    }).catch(() => {
      // Should not happen — persistNewBot catches internally and returns client ID on failure
      // But handle just in case
    })

    // BUG FIX: Detect when persistNewBot fails (server ID never replaced client ID).
    // When the POST fails, persistNewBot returns the client UUID, and the bot remains
    // in the store with an ID the server doesn't recognize. Every subsequent PATCH to
    // this bot will 404. On page refresh, the bot disappears.
    // We detect this by checking if the bot's ID is still not in dbBotIds after a
    // reasonable timeout, and remove it from the store with an error toast.
    const clientUUID = newBot.id
    setTimeout(() => {
      const store = get()
      const bot = store.bots.find(b => b.id === clientUUID)
      // If the bot still has the client UUID after 5 seconds and it's not in
      // dbBotIds (meaning persistNewBot never resolved successfully), remove it.
      if (bot && !dbBotIds.has(clientUUID)) {
        // Remove the orphaned bot from the store
        set((state) => ({
          bots: state.bots.filter(b => b.id !== clientUUID),
          ...(state.selectedBotId === clientUUID ? { selectedBotId: null } : {}),
        }))
        botSnapshots.delete(clientUUID)
        const locale = useI18nStore.getState().locale
        const t = (key: string, params?: Record<string, string | number>) => getTranslation(locale, key as any, params)
        toast.error(t('createBot.createFailed'), { description: t('createBot.createFailedDesc', { name: newBot.name }) })
      }
    }, 5000)
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
    // Clean up dirty tracking and pending persist timers
    const pendingTimer = persistTimers.get(id)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      persistTimers.delete(id)
    }
    botSnapshots.delete(id)

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
          // Find the index where the bot should be re-inserted
          // It was originally at the position before all bots that are still in state
          const existingIds = new Set(state.bots.map(b => b.id))
          const originalIndex = current.bots.findIndex(b => b.id === id)
          // If we can't determine position, append at the end
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
    set((state) => ({
      bots: state.bots.map((b) => {
        if (b.id !== botId) return b
        // Deduplicate: skip if a log with same timestamp+message+level already exists
        const isDuplicate = b.logs.some(
          l => l.timestamp === entry.timestamp && l.message === entry.message && l.level === entry.level
        )
        if (isDuplicate) return b
        return {
          ...b,
          logs: [{ id: genId(), ...entry }, ...b.logs].slice(0, MAX_LOGS_PER_BOT),
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
          botSnapshots.set(botId, Object.fromEntries(Object.entries(currentBot)))
        }
      } else if (res.status === 404) {
        // RACE CONDITION FIX: If we get 404, the bot may not be in the DB yet
        // (e.g., persistNewBot just fired). Retry after a short delay.
        // Only retry if the bot exists in the local store (optimistic creation).
        const localBot = get().bots.find(b => b.id === botId)
        if (localBot) {
          await new Promise(r => setTimeout(r, 500))
          const retryRes = await authFetch(`/api/bots/${botId}`)
          if (retryRes.ok) {
            const data = await retryRes.json()
            const fullBot = normalizeBot(data)
            set((state) => ({
              bots: state.bots.map((b) => {
                if (b.id !== botId) return b
                return {
                  ...fullBot,
                  logs: b.logs,
                  stats: { ...fullBot.stats, ...b.stats },
                }
              }),
            }))
            const currentBot = get().bots.find(b => b.id === botId)
            if (currentBot) {
              botSnapshots.set(botId, Object.fromEntries(Object.entries(currentBot)))
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
      stopping: 'active',   // Keep 'active' during graceful shutdown — the bot is still alive
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

        // BUG FIX: When the runner says "stopped", we now set status to "inactive"
        // and use lastRunnerStatus='stopped' to indicate the bot was previously running.
        // The old design kept status='active' with health='warning', which caused the
        // UI to incorrectly show the bot as "Running" when it was actually stopped.
        // Now the header badge, bot card, and runtime control all show the correct "Stopped" state,
        // and the "Needs Restart" badge appears when lastRunnerStatus='stopped'.
        if (b.status === mapped && b.health === newHealth && b.lastRunnerStatus === runnerStatus) return b

        return {
          ...b,
          status: mapped,
          health: newHealth,
          lastRunnerStatus: runnerStatus,
          // BUG FIX: Only set lastDeployedAt when transitioning TO running
          // from a KNOWN non-running state (not from empty/unknown after page refresh).
          // Without the `b.lastRunnerStatus` truthiness check, page refresh causes
          // lastRunnerStatus='' from DB hydration, which satisfies `!== 'running'`,
          // incorrectly resetting lastDeployedAt to "now" and clearing the
          // "pending redeploy" indicator.
          // Logic: set if (1) runner says 'running', (2) lastRunnerStatus is a known
          // non-running state like 'stopped'/'starting'/'error', OR (3) it's the very
          // first deploy (no lastDeployedAt yet and unknown previous state).
          lastDeployedAt: runnerStatus === 'running' && b.lastRunnerStatus !== 'running'
            && (b.lastRunnerStatus || !b.lastDeployedAt)
            ? new Date().toISOString()
            : b.lastDeployedAt,
          // Clear codeDirty when bot successfully transitions to running (deploy completed)
          codeDirty: runnerStatus === 'running' && b.lastRunnerStatus !== 'running'
            && (b.lastRunnerStatus || !b.lastDeployedAt)
            ? false
            : b.codeDirty,
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
    // BUG FIX: Update snapshot after syncRunnerStatus changes the bot.
    // Without this, the next schedulePatch would include status/lastRunnerStatus/etc.
    // in the diff even though they've already been persisted, causing unnecessary
    // fields in the PATCH body and potential stale-value overwrites.
    const updatedBot = get().bots.find(b => b.id === botId)
    if (updatedBot) {
      botSnapshots.set(botId, Object.fromEntries(Object.entries(updatedBot)))
    }
    // Debounced persist
    schedulePatch(botId, () => get().bots.find(b => b.id === botId))
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
