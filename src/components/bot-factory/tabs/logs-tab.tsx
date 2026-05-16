'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight, Activity, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useBotStore } from '@/store/bot-store'
import { useT, useLocale, type TranslationKey } from '@/lib/i18n'
import type { LogEntry } from '@/types/bot'

// ─── Log Level Constants ──────────────────────────────────────────────────

const levelBadgeColors: Record<string, string> = {
  debug: 'bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20',
  info: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
  error: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20',
  critical: 'bg-red-600/20 text-red-800 dark:text-red-300 border-red-600/30 font-bold',
}

const levelBorderColors: Record<string, string> = {
  debug: 'border-l-muted-foreground/20',
  info: 'border-l-muted-foreground/15',
  warn: 'border-l-muted-foreground/25',
  error: 'border-l-muted-foreground/30',
  critical: 'border-l-muted-foreground/35',
}

// ─── Simulation Data ──────────────────────────────────────────────────────

type SimLevel = 'debug' | 'info' | 'warn' | 'error'

const sourceFiles = ['handler.ts', 'middleware.ts', 'api.ts', 'cache.ts', 'scheduler.ts', 'bot.ts']

function pickRandomLevel(): SimLevel {
  const r = Math.random()
  if (r < 0.50) return 'info'
  if (r < 0.75) return 'debug'
  if (r < 0.90) return 'warn'
  return 'error'
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomInterval(): number {
  return 3000 + Math.random() * 2000 // 3–5 seconds
}

// ─── Types ────────────────────────────────────────────────────────────────

type FilterType = 'All' | 'Debug' | 'Info' | 'Warn' | 'Error' | 'Critical'

interface LogsTabProps {
  isVisible?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatTimestamp(ts: string, locale: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

// ─── Log Item Component ───────────────────────────────────────────────────

const LogItem = React.memo(function LogItem({ entry, locale }: { entry: LogEntry; locale: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className={cn(
        'border-l-2 pl-3 py-1.5 px-3 rounded-r-md transition-colors hover:bg-muted/30',
        levelBorderColors[entry.level] || 'border-l-zinc-300'
      )}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground mt-0.5 shrink-0 cursor-pointer"
          aria-label={expanded ? 'Collapse log' : 'Expand log'}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-mono text-muted-foreground shrink-0">
              {formatTimestamp(entry.timestamp, locale)}
            </span>
            <Badge
              variant="outline"
              className={cn(
                'text-[11px] font-semibold uppercase px-1.5 py-0',
                levelBadgeColors[entry.level] || ''
              )}
            >
              {entry.level}
            </Badge>
            <span className="text-[15px] text-foreground break-all">{entry.message}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            {entry.source && (
              <span className="text-[13px] text-muted-foreground font-mono">
                src/{entry.source}
              </span>
            )}
          </div>
          {expanded && entry.details && (
            <div className="mt-2 rounded-md bg-muted px-3 py-2">
              <p className="text-[13px] font-mono text-muted-foreground break-all">
                {entry.details}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

// ─── Filter Config ────────────────────────────────────────────────────────

const filterKeys: { key: FilterType; tKey: string }[] = [
  { key: 'All', tKey: 'logsTab.filterAll' },
  { key: 'Debug', tKey: 'logsTab.filterDebug' },
  { key: 'Info', tKey: 'logsTab.filterInfo' },
  { key: 'Warn', tKey: 'logsTab.filterWarn' },
  { key: 'Error', tKey: 'logsTab.filterError' },
  { key: 'Critical', tKey: 'logsTab.filterCritical' },
]

// ─── Poll interval for REST-based log fetching (ms) ──────────────────────
const LOG_POLL_INTERVAL = 5000

// ─── Logs Tab Component ───────────────────────────────────────────────────

export function LogsTab({ isVisible = true }: LogsTabProps) {
  // PERF FIX: Use a stable selector that only triggers re-render when
  // the target bot's logs array reference changes (not on ANY bot mutation).
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => {
    if (!selectedBotId) return undefined
    return s.bots.find((b) => b.id === selectedBotId)
  })
  const logs = bot?.logs ?? []
  const addLogEntry = useBotStore((s) => s.addLogEntry)
  const fetchBotLogs = useBotStore((s) => s.fetchBotLogs)
  const [activeFilter, setActiveFilter] = useState<FilterType>('All')
  const [searchQuery, setSearchQuery] = useState('')
  const [simEnabled, setSimEnabled] = useState(false)
  const [simCount, setSimCount] = useState(0)
  const t = useT()
  const locale = useLocale()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stable ref for addLogEntry to avoid effect re-triggering
  const addLogEntryRef = useRef(addLogEntry)
  useEffect(() => { addLogEntryRef.current = addLogEntry }, [addLogEntry])

  // ─── Polling-based log fetching ────────────────────────────────────────
  // Fetch logs via REST polling — works reliably through any proxy.
  // SSE is NOT used because reverse proxies (nginx, CloudFlare, z.ai gateway)
  // buffer SSE responses, causing the EventSource to stay "pending" forever.
  // BUG FIX: Stop polling when bot is not running to avoid unnecessary API
  // calls and prevent showing stale error logs from a stopped bot process.
  // BUG FIX: Re-start polling when bot starts running (previously, polling
  // only started on mount, so if the bot wasn't running yet, new logs from
  // a subsequently started bot would never appear via polling).

  const isBotRunning = bot?.status === 'active' && bot?.lastRunnerStatus !== 'stopped'
  const isBotRunningRef = useRef(isBotRunning)
  useEffect(() => { isBotRunningRef.current = isBotRunning }, [isBotRunning])

  useEffect(() => {
    if (!bot?.id || !isVisible) return

    if (!isBotRunning) return

    const timer = setInterval(() => {
      if (!isBotRunningRef.current) {
        clearInterval(timer)
        return
      }
      fetchBotLogs(bot.id)
    }, LOG_POLL_INTERVAL)

    return () => {
      clearInterval(timer)
    }
  }, [bot?.id, isVisible, fetchBotLogs, isBotRunning])

  const generateLog = useCallback(() => {
    if (!bot) return

    const level = pickRandomLevel()
    const messages = Array.from({ length: 9 }, (_, i) => t(`logsTab.simMsg.${i}` as any))
    const message = pickRandom(messages)
    const source = pickRandom(sourceFiles)

    addLogEntryRef.current(bot.id, {
      timestamp: new Date().toISOString(),
      level,
      message,
      source,
    })
    setSimCount((c) => c + 1)
  }, [bot, t])

  useEffect(() => {
    if (!simEnabled || !bot || !isBotRunning || !isVisible) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }

    const scheduleNext = () => {
      timerRef.current = setTimeout(() => {
        generateLog()
        scheduleNext()
      }, randomInterval())
    }

    scheduleNext()

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [simEnabled, bot?.id, isBotRunning, isVisible, generateLog])  

  const handleToggleSim = (checked: boolean) => {
    setSimEnabled(checked)
    if (checked) {
      setSimCount(0)
      toast.success(t('logsTab.simLogsEnabled'))
    } else {
      toast.info(t('logsTab.simLogsDisabled'))
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────

  if (!bot) return null

  const isSimulationActive = simEnabled && isBotRunning && isVisible

  // PERF FIX: Memoize all derived log computations to avoid redundant work
  // on every render (e.g., when parent state changes but logs didn't).
  // Previously, these ran on EVERY render — up to ~1200 array operations/cycle.

  const filteredLogs = useMemo(() =>
    activeFilter === 'All'
      ? logs
      : logs.filter((log) => log.level === activeFilter.toLowerCase()),
    [logs, activeFilter],
  )

  const searchedLogs = useMemo(() => {
    if (!searchQuery.trim()) return filteredLogs
    const q = searchQuery.toLowerCase()
    return filteredLogs.filter((log) =>
      log.message.toLowerCase().includes(q)
        || (log.source && log.source.toLowerCase().includes(q))
        || (log.details && log.details.toLowerCase().includes(q)),
    )
  }, [filteredLogs, searchQuery])

  const sortedLogs = useMemo(() => {
    if (searchedLogs.length <= 1) return searchedLogs
    return [...searchedLogs].sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
  }, [searchedLogs])

  // PERF FIX: Memoize filter counts so badge numbers don't recalculate each render.
  // Previously 5 filter buttons × 200 logs = 1000 .filter() calls per render cycle.
  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const log of logs) {
      counts[log.level] = (counts[log.level] || 0) + 1
    }
    return counts
  }, [logs])

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">{t('logsTab.title')}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('logsTab.desc')}
          </p>
        </div>

        {/* Simulation Controls */}
        <div className="flex items-center gap-3 shrink-0 rounded-lg bg-muted/30 px-3 py-1.5">
          {isSimulationActive && (
            <div className="flex items-center gap-2 text-[13px] text-emerald-600 dark:text-emerald-400">
              <span className="relative flex size-2">
                <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
                <span className="relative rounded-full size-2 bg-emerald-500" />
              </span>
              <span className="font-medium">{t('logsTab.liveMonitoring')}</span>
            </div>
          )}
          {simCount > 0 && (
            <span className="text-[13px] text-muted-foreground">
              {t('logsTab.generatedLogs', { n: simCount })}
            </span>
          )}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Activity className="size-3.5 text-muted-foreground" />
            <span className="text-[13px] text-muted-foreground whitespace-nowrap">
              {t('logsTab.simLogs')}
            </span>
            <Switch
              checked={simEnabled}
              onCheckedChange={handleToggleSim}
              aria-label={t('logsTab.simLogs')}
            />
          </label>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap rounded-lg bg-muted/30 px-3 py-2">
        {filterKeys.map(({ key, tKey }) => (
          <Button
            key={key}
            variant={activeFilter === key ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveFilter(key)}
            className="text-[13px] h-8"
          >
            {t(tKey as TranslationKey)}
            {key !== 'All' && (
              <span className="ml-1.5 text-[11px] opacity-60">
                ({levelCounts[key.toLowerCase()] ?? 0})
              </span>
            )}
          </Button>
        ))}
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 flex-wrap rounded-lg bg-muted/30 px-3 py-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder={t('logsTab.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8 text-[13px]"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-1 top-1/2 -translate-y-1/2 size-6 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => setSearchQuery('')}
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
        {searchQuery.trim() && (
          <span className="text-[11px] text-muted-foreground">
            {t('logsTab.searchResults', { n: sortedLogs.length })}
          </span>
        )}
      </div>

      {/* Log Entries */}
      <div className="rounded-lg border overflow-hidden border-border/20">
        {!isBotRunning && logs.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border border-border/50 rounded-md text-sm text-muted-foreground m-3">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {t('logsTab.pollingPaused')}
          </div>
        )}
        <ScrollArea className="h-[480px]">
          <div className="p-4 space-y-1.5">
            {sortedLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-[15px] text-muted-foreground">{t('logsTab.noLogs')}</p>
                <p className="text-[13px] text-muted-foreground/60 mt-1">
                  {activeFilter !== 'All'
                    ? t('logsTab.noLevelLogs', { level: activeFilter.toLowerCase() })
                    : t('logsTab.logsWillAppear')}
                </p>
              </div>
            ) : (
              sortedLogs.map((log) => <LogItem key={log.id} entry={log} locale={locale} />)
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex items-center gap-4 text-[13px] text-muted-foreground rounded-lg bg-muted/20 px-3 py-2">
        <span>{t('logsTab.entriesShown', { count: sortedLogs.length })}</span>
        <span>{t('logsTab.totalEntries', { count: logs.length })}</span>
      </div>
    </div>
  )
}
