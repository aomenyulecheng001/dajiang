'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { useTheme } from 'next-themes'
import { Search, Sun, Moon, Grid2X2, List, Plus, Globe, HelpCircle, LogOut, ArrowLeft, KeyRound, UserCircle, Settings } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn, statusConfig, getAvatarColor, getStatusLabel } from '@/lib/utils'
import { useBotStore } from '@/store/bot-store'
import { useBotRunnerConnection } from '@/lib/bot-runner-context'
import { useAuthStore } from '@/store/auth-store'
import { useT, useLocale, setLocale } from '@/lib/i18n'
import type { Locale } from '@/lib/i18n'
import { BotAvatar } from './bot-avatar'
import { AccountSettingsDialog } from '@/components/auth/account-settings-dialog'

const localeOptions: { value: Locale; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

interface HeaderProps {
  searchInputRef?: React.RefObject<HTMLInputElement | null>
  onShortcutsOpen?: () => void
}

export function Header({ searchInputRef, onShortcutsOpen }: HeaderProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const searchQuery = useBotStore(s => s.searchQuery)
  const setSearchQuery = useBotStore(s => s.setSearchQuery)
  const [localSearch, setLocalSearch] = useState(searchQuery)
  useEffect(() => { setLocalSearch(searchQuery) }, [searchQuery])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchChange = (value: string) => {
    setLocalSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setSearchQuery(value)
    }, 200)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])
  const viewMode = useBotStore(s => s.viewMode)
  const setViewMode = useBotStore(s => s.setViewMode)
  const statusFilter = useBotStore(s => s.statusFilter)
  const setStatusFilter = useBotStore(s => s.setStatusFilter)
  const setCreateBotDialogOpen = useBotStore(s => s.setCreateBotDialogOpen)
  const bots = useBotStore(s => s.bots)
  const selectedBotId = useBotStore(s => s.selectedBotId)
  const setSelectedBotId = useBotStore(s => s.setSelectedBotId)
  const { connected, reconnecting, reconnectAttempt, connectionError } = useBotRunnerConnection()
  const { username, logout } = useAuthStore()

  // PERF FIX: Use targeted selector for the selected bot instead of s.bots.find().
  // Previously: const selectedBot = useBotStore((s) => s.bots.find((b) => b.id === s.selectedBotId))
  // This returned a new reference on every bots array change. Now the selector returns
  // the specific bot object, and Zustand's Object.is comparison skips re-renders when
  // the selected bot hasn't changed.
  const selectedBot = useBotStore((s) => {
    if (!s.selectedBotId) return undefined
    return s.bots.find((b) => b.id === s.selectedBotId)
  })
  const isDetailView = !!selectedBotId

  // PERF FIX: Memoize the filtered bot count so we don't call filteredBots()
  // (a Zustand getter that runs the full filter/sort pipeline) on every render.
  // Uses useBotStore.getState() to avoid capturing a closure reference that
  // changes every render, which would defeat useMemo and violate the React
  // Compiler's exhaustive-deps rule.
  const filteredBotCount = useMemo(() => useBotStore.getState().filteredBots().length, [bots, searchQuery, statusFilter])

  // Calculate status counts for filter pills
  // PERF FIX: Memoize to avoid 5x .filter() on every render
  const statusCounts = useMemo(() => bots.reduce((acc, b) => {
    if (b.status === 'active') acc.active++
    else if (b.status === 'inactive') acc.inactive++
    else if (b.status === 'error') acc.error++
    else if (b.status === 'deploying') acc.deploying++
    acc.all++
    return acc
  }, { all: 0, active: 0, inactive: 0, error: 0, deploying: 0 }), [bots])

  const t = useT()
  const locale = useLocale()
  const [isSearchFocused, setIsSearchFocused] = useState(false)
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)

  // Runner status dot (shared between both views)
  const runnerStatusDot = (
    <span className="absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center">
      {connected ? (
        <span className="size-3 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-gray-900" />
      ) : reconnecting ? (
        <span className="relative flex size-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex size-3 rounded-full bg-amber-500 ring-2 ring-white dark:ring-gray-900" />
        </span>
      ) : (
        <span className="relative flex size-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex size-3 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-900" />
        </span>
      )}
    </span>
  )

  const runnerTooltipText = connected
    ? t('runtime.botRunnerConnected')
    : reconnecting
      ? `${t('runtime.autoReconnect')} (${t('runtime.reconnectAttempt', { n: reconnectAttempt })})`
      : connectionError || t('runtime.botRunnerDisconnected')

  // ─── Detail View Header ────────────────────────────────────────────────────
  if (isDetailView && selectedBot) {
    const botStatus = statusConfig[selectedBot.status] || statusConfig.inactive
    const botStatusLabel = getStatusLabel(selectedBot.status, locale)

    return (
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-xl dark:bg-background/80">
        <div className="mx-auto flex h-[60px] max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          {/* Back Button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedBotId(null)}
            className="gap-1.5 text-muted-foreground hover:text-foreground shrink-0 -ml-1"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">{t('botDetail.backToBots')}</span>
          </Button>

          {/* Separator */}
          <div className="w-px h-6 bg-border shrink-0" />

          {/* Bot Identity */}
          <div className="flex items-center gap-2.5 min-w-0">
            <BotAvatar botId={selectedBot.id} emoji={selectedBot.emoji} customIcon={selectedBot.customIcon} size="sm" className="rounded-lg shadow-sm" />
            <div className="min-w-0 flex items-center gap-2">
              <h1 className="text-base font-semibold text-foreground truncate max-w-[200px] sm:max-w-[300px]">
                {selectedBot.name}
              </h1>
              {/* Running status dot — FIX: only pulse green when truly running, not when stopped */}
              {selectedBot.status === 'active' && selectedBot.lastRunnerStatus !== 'stopped' && (
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
                  <span className="relative rounded-full size-2 bg-emerald-500" />
                </span>
              )}
              {/* Amber dot for 'needs restart' state */}
              {selectedBot.status === 'inactive' && selectedBot.lastRunnerStatus === 'stopped' && (
                <span className="shrink-0 size-2 rounded-full bg-amber-500" />
              )}
              <Badge
                variant="outline"
                className={cn('text-[10px] h-5 shrink-0 font-medium', botStatus.className)}
              >
                {botStatusLabel}
              </Badge>
            </div>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Right side controls — only global actions */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            {/* Runner Status — compact version in detail view */}
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="relative flex size-8 items-center justify-center">
                    🤖
                    {runnerStatusDot}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {runnerTooltipText}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Keyboard Shortcuts */}
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-muted-foreground hidden sm:flex"
              onClick={onShortcutsOpen}
              aria-label={t('shortcuts.title')}
            >
              <HelpCircle className="size-4" />
            </Button>

            {/* Language Toggle */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-muted-foreground"
                  aria-label={t('header.switchLanguage')}
                >
                  <Globe className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                {localeOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() => setLocale(option.value)}
                    className={cn(
                      'cursor-pointer',
                      locale === option.value && 'bg-accent'
                    )}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Theme Toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-muted-foreground"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            >
              <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
              <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
              <span className="sr-only">{t('common.toggleTheme')}</span>
            </Button>

            {/* User Menu / Logout */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-muted-foreground"
                  aria-label={t('common.userMenu')}
                >
                  <div className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-xs font-bold text-white">
                    {username?.charAt(0)?.toUpperCase() || 'U'}
                  </div>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">{username}</p>
                  <p className="text-xs text-muted-foreground">{t('common.admin')}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setAccountSettingsOpen(true)}
                  className="cursor-pointer"
                >
                  <Settings className="size-4 mr-2" />
                  {t('auth.accountSettings')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
                >
                  <LogOut className="size-4 mr-2" />
                  {t('common.signOut')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <AccountSettingsDialog open={accountSettingsOpen} onOpenChange={setAccountSettingsOpen} />
      </header>
    )
  }

  // ─── List View Header (default) ────────────────────────────────────────────
  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-xl dark:bg-background/80">
      <div className="mx-auto flex h-[60px] max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        {/* Logo & Title */}
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="relative flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 text-lg shadow-md shadow-cyan-500/25">
            🤖
            {/* Bot Runner Status Indicator */}
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {runnerStatusDot}
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {runnerTooltipText}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-foreground hidden sm:block">
            {t('header.title')}
          </h1>
        </div>

        {/* Search */}
        <div className="relative max-w-xs flex-1 sm:max-w-sm md:max-w-md lg:max-w-lg">
          <Search className="absolute left-3 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder={t('common.search')}
            value={localSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => setIsSearchFocused(false)}
            className="h-10 pl-10 pr-20 sm:pr-[6rem] bg-muted/50 border-transparent focus-visible:border-ring focus-visible:bg-background transition-colors"
          />
          {!isSearchFocused && !searchQuery && (
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center gap-0.5 rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground pointer-events-none">
              ⌘K
              <span className="text-muted-foreground/60">/</span>
              Ctrl+K
            </kbd>
          )}
          {searchQuery.trim() && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums">
              {t('header.searchResults', { n: filteredBotCount })}
            </span>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right side controls */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* View Toggle */}
          <div className="hidden sm:flex items-center rounded-lg border bg-muted/50 p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-8 rounded-md',
                viewMode === 'grid' && 'bg-background shadow-sm text-foreground'
              )}
              onClick={() => setViewMode('grid')}
            >
              <Grid2X2 className="size-4" />
              <span className="sr-only">{t('common.gridView')}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-8 rounded-md',
                viewMode === 'list' && 'bg-background shadow-sm text-foreground'
              )}
              onClick={() => setViewMode('list')}
            >
              <List className="size-4" />
              <span className="sr-only">{t('common.listView')}</span>
            </Button>
          </div>

          {/* Status Filter */}
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-10 w-[150px] bg-muted/50 border-transparent focus-visible:border-ring focus-visible:bg-background transition-colors">
              <SelectValue placeholder={t('common.allStatus')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                <span className="flex items-center gap-2">
                  {t('common.allStatus')}
                  <span className="ml-auto inline-flex items-center justify-center size-5 rounded-full bg-muted text-xs font-medium tabular-nums">
                    {statusCounts.all}
                  </span>
                </span>
              </SelectItem>
              <SelectItem value="active">
                <span className="flex items-center gap-2">
                  {t('common.active')}
                  <span className="ml-auto inline-flex items-center justify-center size-5 rounded-full bg-muted text-xs font-medium tabular-nums">
                    {statusCounts.active}
                  </span>
                </span>
              </SelectItem>
              <SelectItem value="inactive">
                <span className="flex items-center gap-2">
                  {t('common.inactive')}
                  <span className="ml-auto inline-flex items-center justify-center size-5 rounded-full bg-muted text-xs font-medium tabular-nums">
                    {statusCounts.inactive}
                  </span>
                </span>
              </SelectItem>
              <SelectItem value="error">
                <span className="flex items-center gap-2">
                  {t('common.error')}
                  <span className="ml-auto inline-flex items-center justify-center size-5 rounded-full bg-muted text-xs font-medium tabular-nums">
                    {statusCounts.error}
                  </span>
                </span>
              </SelectItem>
              <SelectItem value="deploying">
                <span className="flex items-center gap-2">
                  {t('common.deploying')}
                  <span className="ml-auto inline-flex items-center justify-center size-5 rounded-full bg-muted text-xs font-medium tabular-nums">
                    {statusCounts.deploying}
                  </span>
                </span>
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Create Bot */}
          <Button
            onClick={() => setCreateBotDialogOpen(true)}
            className="h-10 gap-1.5 bg-gradient-to-r from-cyan-600 to-blue-600 shadow-md shadow-cyan-500/25 hover:from-cyan-700 hover:to-blue-700 hover:shadow-lg hover:shadow-cyan-500/30 transition-all"
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">{t('common.newBot')}</span>
          </Button>

          {/* Keyboard Shortcuts */}
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground hidden sm:flex"
            onClick={onShortcutsOpen}
            aria-label={t('shortcuts.title')}
          >
            <HelpCircle className="size-4" />
          </Button>

          {/* Language Toggle */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 text-muted-foreground hover:text-foreground"
                aria-label={t('header.switchLanguage')}
              >
                <Globe className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[120px] p-1">
              <div className="flex flex-col gap-1">
              {localeOptions.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => setLocale(option.value)}
                  className={cn(
                    'cursor-pointer rounded-md text-[13px] px-2.5 py-1.5 transition-colors',
                    locale === option.value && 'bg-accent text-accent-foreground font-medium'
                  )}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Theme Toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          >
            <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
            <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            <span className="sr-only">{t('common.toggleTheme')}</span>
          </Button>

          {/* User Menu / Logout */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 text-muted-foreground"
                aria-label={t('common.userMenu')}
              >
                <div className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-xs font-bold text-white">
                  {username?.charAt(0)?.toUpperCase() || 'U'}
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium">{username}</p>
                <p className="text-xs text-muted-foreground">{t('common.admin')}</p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setAccountSettingsOpen(true)}
                className="cursor-pointer"
              >
                <Settings className="size-4 mr-2" />
                {t('auth.accountSettings')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={logout}
                className="cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
              >
                <LogOut className="size-4 mr-2" />
                {t('common.signOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AccountSettingsDialog open={accountSettingsOpen} onOpenChange={setAccountSettingsOpen} />
    </header>
  )
}
