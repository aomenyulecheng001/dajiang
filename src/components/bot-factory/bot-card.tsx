'use client'

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import { Play, Square, Pencil, Trash2, Loader2, Clock, Package, Code2 } from 'lucide-react'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn, statusConfig, healthConfig, getAvatarColor, getStatusLabel, isValidBotToken, formatDate } from '@/lib/utils'
import { useLocale, useT, type Locale } from '@/lib/i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Bot } from '@/types/bot'
import { useBotStore } from '@/store/bot-store'
import { ConfirmDialog } from './confirm-dialog'
import { useBotRunnerConnection, useBotRunnerActions } from '@/lib/bot-runner-context'
import { fetchRevealEnvVars, hasMaskedEnvVars, buildEnvVarsFallback, buildDeployConfig } from '@/lib/deploy-utils'
import { BotAvatar } from './bot-avatar'

/* ============================================
   OPT-7: SEARCH KEYWORD HIGHLIGHTING
   ============================================ */
const HighlightText = React.memo(function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>

  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return <>{text}</>

  // Find all match ranges
  const ranges: [number, number][] = []
  const lowerText = text.toLowerCase()
  for (const term of terms) {
    let idx = lowerText.indexOf(term)
    while (idx !== -1) {
      ranges.push([idx, idx + term.length])
      idx = lowerText.indexOf(term, idx + 1)
    }
  }

  if (ranges.length === 0) return <>{text}</>

  // Sort and merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = [ranges[0]]
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1]
    if (ranges[i][0] <= last[1]) {
      last[1] = Math.max(last[1], ranges[i][1])
    } else {
      merged.push(ranges[i])
    }
  }

  // Build highlighted segments
  const parts: React.ReactNode[] = []
  let lastEnd = 0
  for (const [start, end] of merged) {
    if (start > lastEnd) {
      parts.push(text.slice(lastEnd, start))
    }
    parts.push(
      <mark key={start} className="bg-amber-200/60 dark:bg-amber-500/30 text-inherit rounded-sm px-0.5">
        {text.slice(start, end)}
      </mark>
    )
    lastEnd = end
  }
  if (lastEnd < text.length) {
    parts.push(text.slice(lastEnd))
  }

  return <>{parts}</>
})

interface BotCardProps {
  bot: Bot
  viewMode: 'grid' | 'list'
}

export const BotCard = React.memo(function BotCard({ bot, viewMode }: BotCardProps) {
  const setSelectedBotId = useBotStore(s => s.setSelectedBotId)
  const deleteBot = useBotStore(s => s.deleteBot)
  const setEditBotId = useBotStore(s => s.setEditBotId)
  const searchQuery = useBotStore(s => s.searchQuery)
  const t = useT()
  const locale = useLocale()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [localPending, setLocalPending] = useState<'starting' | 'stopping' | null>(null)
  const { connected } = useBotRunnerConnection()
  const { getBotStatus, deployBot, stopBot } = useBotRunnerActions()
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Safety timeout: clear localPending after 30s if runner never responded
  useEffect(() => {
    if (localPending) {
      pendingTimerRef.current = setTimeout(() => setLocalPending(null), 30_000)
      return () => {
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
      }
    }
  }, [localPending])

  const status = statusConfig[bot.status] || statusConfig.inactive
  const health = healthConfig[bot.health] || healthConfig.unknown
  // FIX: Name dot should reflect actual runtime status, not stale health.
  // When a bot stops, health may still be 'healthy' (green) from the previous state.
  // Use status.dotClass instead, and show amber for the 'needs restart' case.
  const nameDotClass = bot.status === 'inactive' && bot.lastRunnerStatus === 'stopped'
    ? 'bg-amber-500'
    : status.dotClass
  // FIX: Override status label when runner reports a transitional state that
  // maps to 'deploying' in the store but has a different semantic meaning.
  // 'stopping' maps to BotStatus 'deploying', but the user should see "停止中"
  // not "部署中". 'starting' also maps to 'deploying', show "启动中" instead.
  // Bot runner status (used for label override and action buttons)
  const runnerStatus = getBotStatus(bot.id)
  const statusLabel = runnerStatus?.status === 'stopping'
    ? t('runtime.stopping')
    : runnerStatus?.status === 'starting'
      ? t('runtime.startingCompact')
      : getStatusLabel(bot.status, locale)
  const statusWithLabel = useMemo(() => ({ ...status, label: statusLabel }), [status, statusLabel])
  const isBotRunning = runnerStatus?.status === 'running'
  const isBotDeploying = runnerStatus?.status === 'starting'
  const isBotStopping = runnerStatus?.status === 'stopping'

  // Derived: clear localPending when runner confirms the state transition.
  // Instead of calling setState in an effect (which React 16 lint forbids),
  // we compute the effective pending state here. The 30s safety timeout
  // in the useEffect above will eventually clear the raw localPending.
  const effectiveLocalPending = (() => {
    // Only clear 'starting' when runner confirms it's actually starting/running,
    // not when a stale status from a previous run exists.
    // Also clear on error — deploy failed, no longer starting.
    if (localPending === 'starting' && runnerStatus && (runnerStatus.status === 'starting' || runnerStatus.status === 'running' || runnerStatus.status === 'error')) return null
    // Clear 'stopping' when runner confirms the bot is no longer running
    // BUG FIX: Also clear when runnerStatus is null (bot fully stopped, no runner status)
    if (localPending === 'stopping' && (!runnerStatus || runnerStatus.status !== 'running')) return null
    return localPending
  })()

  // Get token from envVars — support both BOT_TOKEN and TELEGRAM_BOT_TOKEN
  const tokenEntry = bot.envVars.filter((v) => (v.key === 'BOT_TOKEN' || v.key === 'TELEGRAM_BOT_TOKEN') && v.value.trim()).slice(-1)[0]
    || bot.envVars.find((v) => v.key === 'BOT_TOKEN' || v.key === 'TELEGRAM_BOT_TOKEN')
  const botToken = tokenEntry?.value || ''
  // Use server-side validated token status (accurate even when token is encrypted/masked)
  // Fall back to client-side validation for newly created bots not yet persisted
  // BUG FIX: 'not_set' means the token hasn't been validated yet (e.g., list view doesn't
  // validate tokens for performance), but the token may still be valid in the database.
  // Only block when explicitly 'invalid'. Allow 'not_set' to proceed — the runner will
  // validate the actual token when starting.
  const hasValidToken = bot.tokenStatus === 'valid'
    || bot.tokenStatus === 'not_set'
    || (!bot.tokenStatus && isValidBotToken(botToken))

  // Handlers
  const handleStart = async () => {
    if (!connected) {
      toast.error(t('runtime.serviceNotConnected'))
      return
    }
    if (!hasValidToken) {
      toast.error(t('runtime.tokenRequired'))
      return
    }

    setLocalPending('starting')

    let realEnvVarsMap: Record<string, string> = {}
    let realBotToken = botToken

    try {
      await useBotStore.getState().fetchBotDetail(bot.id)
    } catch {
      toast.error(t('runtime.serviceNotConnected'))
      setLocalPending(null)
      return
    }

    const fullBot = useBotStore.getState().bots.find(b => b.id === bot.id) || bot

    const revealed = await fetchRevealEnvVars(bot.id)
    if (revealed) {
      realEnvVarsMap = revealed.envVarsMap
      realBotToken = revealed.botToken
    } else {
      if (hasMaskedEnvVars(fullBot.envVars)) {
        toast.error(t('runtime.envRevealFailed'))
        setLocalPending(null)
        return
      }
      realEnvVarsMap = buildEnvVarsFallback(fullBot.envVars)
    }

    const deploySuccess = deployBot(buildDeployConfig(bot.id, fullBot, realEnvVarsMap, realBotToken))
    if (!deploySuccess) {
      setLocalPending(null)
      return
    }
    toast.success(t('botCard.starting', { name: bot.name }))
  }

  const handleStop = () => {
    setLocalPending('stopping')
    stopBot(bot.id)
    toast.success(t('botCard.stopping', { name: bot.name }))
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditBotId(bot.id)
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteBot(bot.id)
      // Only close dialog after delete completes — if it fails, the dialog stays
      // so the user sees the error toast and can retry.
      setDeleteDialogOpen(false)
    } catch {
      toast.error(t('botCard.deleteFailed'))
    } finally {
      setIsDeleting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setSelectedBotId(bot.id)
    }
  }

  const sharedProps = {
    bot,
    status: statusWithLabel,
    health,
    locale,
    searchQuery,
    nameDotClass,
    onSelect: () => setSelectedBotId(bot.id),
    onKeyDown: handleKeyDown,
    onDelete: () => setDeleteDialogOpen(true),
    onEdit: handleEdit,
    onStart: handleStart,
    onStop: handleStop,
    isBotRunning,
    isBotDeploying,
    isBotStopping,
    isLocalStarting: effectiveLocalPending === 'starting',
    isLocalStopping: effectiveLocalPending === 'stopping',
    hasValidToken,
  }

  if (viewMode === 'list') {
    return (
      <>
        <ListModeCard {...sharedProps} />
        <ConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title={t('botCard.deleteBot')}
          description={t('botCard.deleteConfirm')}
          confirmText={t('common.delete')}
          variant="destructive"
          onConfirm={handleDelete}
          loading={isDeleting}
        />
      </>
    )
  }

  return (
    <>
      <GridModeCard {...sharedProps} />
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('botCard.deleteBot')}
        description={t('botCard.deleteConfirm')}
        confirmText={t('common.delete')}
        variant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </>
  )
})

/* ============================================
   ACTION BUTTONS (shared between Grid & List)
   ============================================ */
interface CardActionsProps {
  bot: Bot
  onEdit: (_e: React.MouseEvent) => void
  onStart: () => void
  onStop: () => void
  onDelete: () => void
  isBotRunning: boolean
  isBotDeploying: boolean
  isBotStopping?: boolean
  isLocalStarting?: boolean
  isLocalStopping?: boolean
  hasValidToken: boolean
  compact?: boolean
}

const CardActions = React.memo(function CardActions({
  bot: _bot,
  onEdit,
  onStart,
  onStop,
  onDelete,
  isBotRunning,
  isBotDeploying,
  isBotStopping = false,
  isLocalStarting = false,
  isLocalStopping = false,
  hasValidToken,
  compact = false,
}: CardActionsProps) {
  const t = useT()
  const size = compact ? 'size-8' : 'size-9'
  const iconSize = compact ? 'size-3.5' : 'size-4'

  // Show loading if either local pending or remote deploying
  const showStarting = isLocalStarting || isBotDeploying
  const showStopping = isLocalStopping || isBotStopping

  return (
    <div className="flex items-center gap-0.5">
      {/* Start / Stop / Loading Button */}
      {showStopping ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(size, 'text-amber-500 animate-pulse')}
                disabled
              >
                <Loader2 className={cn(iconSize, 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('botCard.stoppingShort')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : isBotRunning ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(size, 'text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10')}
                onClick={(e) => { e.stopPropagation(); onStop() }}
              >
                <Square className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('botCard.stop')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : showStarting ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(size, 'text-blue-500 animate-pulse')}
                disabled
              >
                <Loader2 className={cn(iconSize, 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('botCard.startingShort')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(size, 'text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/10', !hasValidToken && 'text-muted-foreground hover:text-muted-foreground')}
                onClick={(e) => { e.stopPropagation(); onStart() }}
              >
                <Play className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {!hasValidToken ? t('botCard.noToken') : t('botCard.start')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Edit Button */}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(size, 'text-muted-foreground hover:text-foreground hover:bg-muted/80')}
              onClick={onEdit}
            >
              <Pencil className={iconSize} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">{t('botCard.edit')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Delete Button */}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(size, 'text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-500/10')}
              onClick={(e) => { e.stopPropagation(); onDelete() }}
            >
              <Trash2 className={iconSize} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">{t('common.delete')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
})

/* ============================================
   GRID MODE CARD
   ============================================ */

const GridModeCard = React.memo(function GridModeCard({
  bot,
  status,
  health,
  locale,
  searchQuery,
  nameDotClass,
  onSelect,
  onKeyDown,
  onDelete,
  onEdit,
  onStart,
  onStop,
  isBotRunning,
  isBotDeploying,
  isBotStopping,
  isLocalStarting,
  isLocalStopping,
  hasValidToken,
}: {
  bot: Bot
  status: { label: string; className: string; dotClass: string }
  health: { className: string; dotClass: string }
  locale: Locale
  searchQuery: string
  nameDotClass: string
  onSelect: () => void
  onKeyDown: (_e: React.KeyboardEvent) => void
  onDelete: () => void
  onEdit: (_e: React.MouseEvent) => void
  onStart: () => void
  onStop: () => void
  isBotRunning: boolean
  isBotDeploying: boolean
  isBotStopping: boolean
  isLocalStarting: boolean
  isLocalStopping: boolean
  hasValidToken: boolean
}) {
  const t = useT()

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={t('botCard.viewDetails', { name: bot.name })}
      className={cn(
        'group relative cursor-pointer overflow-hidden rounded-xl border border-border/50 bg-card transition-all duration-300',
        'hover:shadow-lg hover:shadow-black/[0.04] dark:hover:shadow-black/20',
        'hover:border-border/80',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
        'gap-0 py-4'
      )}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <CardHeader className="gap-2 pb-0">
        <div className="flex items-center justify-between">
          {/* Avatar & Info */}
          <div className="flex items-center gap-2.5 min-w-0">
            <BotAvatar botId={bot.id} emoji={bot.emoji} customIcon={bot.customIcon} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="truncate text-[15px] font-semibold text-foreground">
                  <HighlightText text={bot.name} query={searchQuery} />
                </h3>
                <span
                  className={cn(
                    'shrink-0 size-1.5 rounded-full',
                    nameDotClass,
                    bot.status === 'active' && 'animate-pulse'
                  )}
                />
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <Badge
                  variant="outline"
                  className={cn('text-[10px] px-1.5 py-0 font-medium h-[18px]', status.className)}
                >
                  <span className={cn('size-1 rounded-full', status.dotClass)} />
                  {status.label}
                </Badge>
                {bot.status === 'inactive' && bot.lastRunnerStatus === 'stopped' && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-[18px] bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20 font-medium">
                    {t('botCard.needsRestart')}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 shrink-0">
            <CardActions
              bot={bot}
              onEdit={onEdit}
              onStart={onStart}
              onStop={onStop}
              onDelete={onDelete}
              isBotRunning={isBotRunning}
              isBotDeploying={isBotDeploying}
              isBotStopping={isBotStopping}
              isLocalStarting={isLocalStarting}
              isLocalStopping={isLocalStopping}
              hasValidToken={hasValidToken}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="gap-1.5 pt-3">
        {/* Description */}
        <p className="line-clamp-2 text-[13px] text-muted-foreground leading-relaxed">
          <HighlightText text={bot.description || t('common.noDescription')} query={searchQuery} />
        </p>

        {/* Meta row — language, deps, updated */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60 mt-0.5">
          <span className="inline-flex items-center gap-1">
            <Code2 className="size-3" />
            <span className="capitalize">{bot.language}</span>
          </span>
          {bot.dependencies.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Package className="size-3" />
              {bot.dependencies.length}{bot.dependencies.length === 1 ? ` ${t('common.dep')}` : ` ${t('common.deps')}`}
            </span>
          )}
          <span className="inline-flex items-center gap-1 ml-auto">
            <Clock className="size-3" />
            {formatDate(bot.updatedAt, locale)}
          </span>
        </div>
      </CardContent>
    </Card>
  )
})

/* ============================================
   LIST MODE — Table Row
   ============================================ */

const ListModeCard = React.memo(function ListModeCard({
  bot,
  status,
  health: _health,
  locale,
  searchQuery,
  nameDotClass,
  onSelect,
  onKeyDown,
  onDelete,
  onEdit,
  onStart,
  onStop,
  isBotRunning,
  isBotDeploying,
  isBotStopping,
  isLocalStarting,
  isLocalStopping,
  hasValidToken,
}: {
  bot: Bot
  status: { label: string; className: string; dotClass: string }
  health: { className: string; dotClass: string }
  locale: Locale
  searchQuery: string
  nameDotClass: string
  onSelect: () => void
  onKeyDown: (_e: React.KeyboardEvent) => void
  onDelete: () => void
  onEdit: (_e: React.MouseEvent) => void
  onStart: () => void
  onStop: () => void
  isBotRunning: boolean
  isBotDeploying: boolean
  isBotStopping: boolean
  isLocalStarting: boolean
  isLocalStopping: boolean
  hasValidToken: boolean
}) {
  const t = useT()
  const needsRestart = bot.status === 'inactive' && bot.lastRunnerStatus === 'stopped'

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={t('botCard.viewDetails', { name: bot.name })}
      className={cn(
        'group cursor-pointer border-b border-border transition-colors duration-150',
        'hover:bg-muted/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500'
      )}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {/* Bot: avatar + name */}
      <td className="py-3 pl-4 pr-3">
        <div className="flex items-center gap-3">
          <BotAvatar botId={bot.id} emoji={bot.emoji} customIcon={bot.customIcon} size="md" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-medium text-foreground">
                <HighlightText text={bot.name} query={searchQuery} />
              </h3>
              <span
                className={cn(
                  'shrink-0 size-1.5 rounded-full',
                  nameDotClass,
                  bot.status === 'active' && 'animate-pulse'
                )}
              />
            </div>
            <p className="truncate text-[11px] text-muted-foreground/60 mt-0.5 max-w-[280px]">
              <HighlightText text={bot.description || t('common.noDescription')} query={searchQuery} />
            </p>
          </div>
        </div>
      </td>

      {/* Status */}
      <td className="py-3 px-4 hidden sm:table-cell">
        <div className="flex items-center gap-1.5">
          <span className={cn('shrink-0 size-2 rounded-full', status.dotClass, bot.status === 'active' && 'animate-pulse')} />
          <span className="text-xs text-muted-foreground whitespace-nowrap">{status.label}</span>
          {needsRestart && (
            <Badge variant="outline" className="text-[9px] px-1 py-px h-4 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20 font-medium whitespace-nowrap ml-0.5">
              !
            </Badge>
          )}
        </div>
      </td>

      {/* Language */}
      <td className="py-3 px-4 hidden md:table-cell">
        <div className="flex items-center gap-1.5">
          <Code2 className="size-3 text-muted-foreground/50" />
          <span className="text-xs text-muted-foreground capitalize">{bot.language}</span>
        </div>
      </td>

      {/* Updated */}
      <td className="py-3 px-4 hidden md:table-cell">
        <span className="text-xs text-muted-foreground/70 whitespace-nowrap">{formatDate(bot.updatedAt, locale)}</span>
      </td>

      {/* Actions */}
      <td className="py-3 pr-4 pl-3">
        <div className="flex items-center justify-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <CardActions
            bot={bot}
            onEdit={onEdit}
            onStart={onStart}
            onStop={onStop}
            onDelete={onDelete}
            isBotRunning={isBotRunning}
            isBotDeploying={isBotDeploying}
            isBotStopping={isBotStopping}
            isLocalStarting={isLocalStarting}
            isLocalStopping={isLocalStopping}
            hasValidToken={hasValidToken}
            compact
          />
        </div>
      </td>
    </tr>
  )
})
