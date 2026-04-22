'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useAuthStore, verifySession } from '@/store/auth-store'
import { useBotStore, resetHydration } from '@/store/bot-store'
import { Header } from '@/components/bot-factory/header'
import { BotCard } from '@/components/bot-factory/bot-card'
import { BotDetail } from '@/components/bot-factory/bot-detail'
import { CreateBotDialog } from '@/components/bot-factory/create-bot-dialog'
import { EditBotDialog } from '@/components/bot-factory/edit-bot-dialog'

import { KeyboardShortcuts, KeyboardShortcutsDialog } from '@/components/bot-factory/keyboard-shortcuts'
import { CommandPalette } from '@/components/bot-factory/command-palette'
import { EmptyState } from '@/components/bot-factory/empty-state'
import { BotListSkeleton } from '@/components/bot-factory/bot-list-skeleton'
import { LoginForm } from '@/components/auth/login-form'
import { useBotRunner } from '@/lib/bot-runner-context'

import { motion, AnimatePresence } from 'framer-motion'
import { Bot, Plus, ArrowUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { PAGINATION } from '@/lib/bot-constants'

export default function Home() {
  const { isAuthenticated, isLoading: isAuthLoading, setAuth, setLoading } = useAuthStore()
  const { viewMode, selectedBotId, bots, sortBy, sortOrder, setSortBy, setSortOrder, searchQuery, statusFilter, currentPage, pageSize, setCurrentPage, resetPagination } = useBotStore()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const t = useT()
  const { connected: runnerConnected, reconnecting: runnerReconnecting } = useBotRunner()
  // PERF FIX: Memoize filtered bots list to avoid recomputation when unrelated
  // state changes (e.g., viewMode, selectedBotId) trigger a re-render.
  // Uses useBotStore.getState() instead of the destructured filteredBots getter
  // to avoid capturing a closure reference that changes every render, which
  // would defeat the purpose of useMemo (and violate the React Compiler's
  // exhaustive-deps rule). The state values the getter reads are already
  // listed as dependencies, so recomputation is triggered correctly.
  const filteredBotsList = useMemo(() => useBotStore.getState().filteredBots(), [bots, searchQuery, statusFilter, sortBy, sortOrder])
  const hasBots = bots.length > 0

  // FIX: Show skeleton only while hydration is still in progress.
  // Previously checked `bots.length === 0` which meant the skeleton showed
  // forever when the user had no bots (fresh account). Now we check the
  // actual hydration state from the store instead.
  const _hasHydrated = useBotStore((s) => s._hasHydrated)
  const isLoadingBots = isAuthenticated && !_hasHydrated && !isAuthLoading

  // Check stored session on mount — token is now in HttpOnly cookie,
  // so we just verify the session via the API (cookie is sent automatically)
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    verifySession(undefined, controller.signal).then(({ valid, username }) => {
      clearTimeout(timer)
      if (valid && username) {
        setAuth(true, username, null)
      } else {
        setAuth(false, null, null)
      }
    }).catch((err) => {
      clearTimeout(timer)
      const isNetworkError = err instanceof Error && (
        err.message?.includes('Failed to fetch') ||
        err.message?.includes('NetworkError') ||
        err.message?.includes('AbortError')
      )
      if (!isNetworkError) {
        setAuth(false, null, null)
      }
      setLoading(false)
    })
  }, [setAuth])

  // P0 FIX: Re-hydrate bots from DB when user authenticates
  // The auto-hydrate at module load time runs before auth, so it fails (401).
  // We need to hydrate again once the user is authenticated.
  useEffect(() => {
    if (!isAuthenticated) return
    const store = useBotStore.getState()
    // BUG FIX: Check _hasHydrated instead of bots.length === 0.
    // Previously, if the user had zero bots, bots.length === 0 was always true,
    // causing resetHydration() + hydrateFromDB() to run on every render,
    // creating an infinite hydration loop for accounts with no bots.
    if (!store._hasHydrated) {
      resetHydration()
      store.hydrateFromDB()
    }
  }, [isAuthenticated])

  // Show auth loading screen
  if (isAuthLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4"
        >
          <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 text-3xl shadow-lg shadow-cyan-500/25">
            🤖
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2 rounded-full bg-cyan-500 animate-pulse" />
            <span className="text-sm">{t('common.loading')}</span>
          </div>
        </motion.div>
      </div>
    )
  }

  // Show login form if not authenticated
  if (!isAuthenticated) {
    return <LoginForm />
  }

  // Show dashboard
  return (
    <div className="min-h-screen flex flex-col">
      <Header searchInputRef={searchInputRef} onShortcutsOpen={() => setShortcutsOpen(true)} />
      <KeyboardShortcuts searchInputRef={searchInputRef} />
      <CommandPalette />

      <main className="flex-1">
        <AnimatePresence mode="popLayout">
          {selectedBotId ? (
            <motion.div
              key={`detail-${selectedBotId}`}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2 }}
            >
              <BotDetail />
            </motion.div>
          ) : (
            <motion.div
              key="list"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              {/* Sort & Filter Controls */}
              {hasBots && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.15 }}
                  className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-6 pb-4"
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <ArrowUpDown className="size-3.5" />
                      <span>{t('page.sortBy')}</span>
                    </div>
                    <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                      <SelectTrigger className="h-9 w-[140px] text-sm bg-muted/50 border-transparent">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="updatedAt">{t('page.sortNewest')}</SelectItem>
                        <SelectItem value="name">{t('page.sortName')}</SelectItem>
                        <SelectItem value="createdAt">{t('page.sortCreated')}</SelectItem>
                        <SelectItem value="status">{t('page.sortStatus')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 gap-1.5 text-sm px-3"
                      onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                    >
                      {sortOrder === 'desc' ? t('page.sortNewestOrder') : t('page.sortOldestOrder')}
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* Bot Grid / List */}
              <div className={cn(
                'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pb-8',
                !hasBots && 'pt-6'
              )}>
                {isLoadingBots ? (
                  <BotListSkeleton viewMode={viewMode} />
                ) : filteredBotsList.length === 0 ? (
                  <EmptyState
                    icon={<Bot />}
                    title={hasBots ? t('page.noMatchingBots') : t('page.noBotsYet')}
                    description={
                      hasBots
                        ? t('page.noMatchingDesc')
                        : t('page.noBotsDesc')
                    }
                    action={
                      !hasBots ? (
                        <Button
                          onClick={() => useBotStore.getState().setCreateBotDialogOpen(true)}
                          className="gap-1.5 bg-gradient-to-r from-cyan-600 to-blue-600"
                        >
                          <Plus className="size-4" />
                          {t('page.createFirst')}
                        </Button>
                      ) : undefined
                    }
                    className="min-h-[50vh]"
                  />
                ) : (
                  viewMode === 'grid' ? (
                    <motion.div
                      key="grid"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.2 }}
                      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5"
                    >
                      {filteredBotsList.map((bot, index) => (
                        <motion.div
                          key={bot.id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: Math.min(index * 0.05, 0.5) }}
                        >
                          <BotCard bot={bot} viewMode={viewMode} />
                        </motion.div>
                      ))}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="table"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.2 }}
                      className="rounded-xl border warm-gradient-card overflow-hidden"
                    >
                      <table className="w-full table-fixed">
                        <thead>
                          <tr className="border-b bg-muted/30">
                            <th className="py-2.5 pl-4 pr-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider" style={{ width: '45%' }}>{t('botCard.tableBot')}</th>
                            <th className="py-2.5 px-4 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hidden sm:table-cell" style={{ width: '12%' }}>{t('botCard.tableStatus')}</th>
                            <th className="py-2.5 px-4 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hidden md:table-cell" style={{ width: '10%' }}>{t('botCard.tableLanguage')}</th>
                            <th className="py-2.5 px-4 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hidden md:table-cell" style={{ width: '14%' }}>{t('botCard.tableUpdated')}</th>
                            <th className="py-2.5 pr-4 pl-3" style={{ width: '96px' }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredBotsList.map((bot, index) => (
                            <BotCard key={bot.id} bot={bot} viewMode={viewMode} />
                          ))}
                        </tbody>
                      </table>
                    </motion.div>
                  )
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t bg-background/60 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4">
          {/* Branding + status */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <div className="flex size-5 items-center justify-center rounded-md bg-gradient-to-br from-teal-500 to-emerald-600 text-xs">
                🤖
              </div>
              <span>{t('page.footerCopy', { year: new Date().getFullYear() })}</span>
              <span className="text-muted-foreground/40">|</span>
              <span className="text-muted-foreground/60">{t('footer.version')}</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="hidden sm:inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-teal-500" />
                {t('footer.botsCount', { n: bots.length })}
              </span>
              <span className="hidden sm:inline">{t('page.footerPowered')}</span>
              <span className="inline-flex items-center gap-1.5">
                {runnerConnected ? (
                  <>
                    <span className="relative flex size-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                    </span>
                    {t('page.footerOnline')}
                  </>
                ) : runnerReconnecting ? (
                  <>
                    <span className="relative flex size-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
                    </span>
                    {t('runtime.autoReconnect')}
                  </>
                ) : (
                  <>
                    <span className="size-2 rounded-full bg-red-500" />
                    {t('page.footerOffline')}
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      </footer>

      {/* Dialogs - rendered once at root level */}
      <CreateBotDialog />
      <EditBotDialog />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  )
}
