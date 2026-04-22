'use client'

import { useEffect } from 'react'
import {
  MessageSquare,
  Users,
  AlertTriangle,
  Clock,
  Globe,
  Activity,
  Code,
  Layers,
  Calendar,
  Heart,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useBotStore } from '@/store/bot-store'
import {
  formatDate,
  statusConfig,
  healthConfig,
  getStatusLabel,
  getHealthLabel,
  formatNumber,
  formatUptime,
} from '@/lib/utils'
import { useT, useLocale } from '@/lib/i18n'

import { LANGUAGE_LABELS } from '@/lib/bot-constants'

// ─── Quick Stat Card ──────────────────────────────────────────────────────

function QuickStatCard({
  icon: Icon,
  label,
  value,
  subValue,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  subValue?: string
  color: string
}) {
  return (
    <Card className="gap-0 py-0 shadow-none border-border/20 overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${color}`}
          >
            <Icon className="size-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] text-muted-foreground font-medium">
              {label}
            </p>
            <p className="text-xl font-bold text-foreground">{value}</p>
            {subValue && (
              <p className="text-[13px] text-muted-foreground mt-0.5">
                {subValue}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Overview Tab ─────────────────────────────────────────────────────────

export function OverviewTab() {
  // PERF FIX: Split selector to avoid re-renders when other bots change.
  // Matches the optimization pattern used in LogsTab for consistency.
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => {
    if (!selectedBotId) return undefined
    return s.bots.find((b) => b.id === selectedBotId)
  })
  const fetchBotStats = useBotStore((s) => s.fetchBotStats)
  const t = useT()
  const locale = useLocale()

  // BUG FIX: Removed 30-second polling interval from OverviewTab to avoid
  // duplicate API calls alongside MonitoringTab's polling. MonitoringTab
  // already fetches stats every 30 seconds, and bot:message events trigger
  // throttled stats refresh (every 10 seconds) from BotRunnerContext.
  // We keep only the initial fetch when the tab mounts or bot changes.
  useEffect(() => {
    if (bot?.id) {
      fetchBotStats(bot.id)
    }
  }, [bot?.id, fetchBotStats])

  if (!bot) return null

  const status = statusConfig[bot.status] || statusConfig.inactive
  const health = healthConfig[bot.health] || healthConfig.unknown
  const statusLabel = getStatusLabel(bot.status, locale)
  const healthLabel = getHealthLabel(bot.health, locale)

  const errorsSub =
    bot.stats.errors === 0
      ? t('statsTab.allClear')
      : t('statsTab.needsAttention')

  const uptimeSub =
    bot.stats.uptime > 0
      ? t('statsTab.uptimeLabel', { uptime: formatUptime(bot.stats.uptime, locale) })
      : t('statsTab.currentlyOffline')

  return (
    <div className="space-y-6">
      {/* ── Section Header ──────────────────────────────────────────────── */}
      <div className="pb-2">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{t('overviewTab.title')}</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('infoTab.desc')}
        </p>
      </div>

      {/* ── Compact Info Layout ─────────────────────────────────────────── */}
      <Card className="gap-0 py-0 shadow-none border-border/20 overflow-hidden">
        <CardContent className="p-4 space-y-3">
          {/* Row 1: Version, Language, Template as inline badges */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Code className="size-3.5" />
              <span>{t('common.version')}</span>
            </div>
            <Badge variant="secondary" className="text-[13px] rounded-md font-normal">
              v{bot.version}
            </Badge>

            <span className="text-muted-foreground/40">·</span>

            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Globe className="size-3.5" />
              <span>{t('common.language')}</span>
            </div>
            <Badge variant="secondary" className="text-[13px] rounded-md font-normal">
              {LANGUAGE_LABELS[bot.language] || bot.language}
            </Badge>

            <span className="text-muted-foreground/40">·</span>

            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Layers className="size-3.5" />
              <span>{t('infoTab.template')}</span>
            </div>
            <Badge variant="secondary" className="text-[13px] rounded-md font-normal">
              {bot.template || t('common.custom')}
            </Badge>
          </div>

          {/* Row 2: Created & Last Updated */}
          <div className="flex flex-wrap items-center gap-4 text-[13px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Calendar className="size-3.5" />
              <span>
                {t('common.created')}: {formatDate(bot.createdAt, locale)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="size-3.5" />
              <span>
                {t('common.lastUpdated')}: {formatDate(bot.updatedAt, locale)}
              </span>
            </div>
          </div>

          {/* Row 3: Status & Health badges */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Activity className="size-3.5" />
              <span>{t('common.status')}</span>
            </div>
            <Badge variant="outline" className={`text-[13px] font-medium ${status.className}`}>
              {statusLabel}
            </Badge>

            <span className="text-muted-foreground/40">·</span>

            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Heart className="size-3.5" />
              <span>{t('common.health')}</span>
            </div>
            <Badge variant="outline" className={`text-[13px] font-medium ${health.className}`}>
              {healthLabel}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* ── Quick Stat Cards (3 cards: messages, users, errors) ────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <QuickStatCard
          icon={MessageSquare}
          label={t('botDetail.quickMessages')}
          value={formatNumber(bot.stats.messages)}
          subValue={t('statsTab.allTime')}
          color="bg-teal-500"
        />
        <QuickStatCard
          icon={Users}
          label={t('botDetail.quickUsers')}
          value={formatNumber(bot.stats.users)}
          subValue={uptimeSub}
          color="bg-emerald-500"
        />
        <QuickStatCard
          icon={AlertTriangle}
          label={t('botDetail.quickErrors')}
          value={formatNumber(bot.stats.errors)}
          subValue={errorsSub}
          color="bg-rose-500"
        />
      </div>

    </div>
  )
}
