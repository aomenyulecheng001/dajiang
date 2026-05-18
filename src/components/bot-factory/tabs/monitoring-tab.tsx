'use client'

import React, { useEffect } from 'react'
import { BarChart3 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatNumber } from '@/lib/utils'
import { useBotStore } from '@/store/bot-store'
import { useT, useLocale, type TranslationKey } from '@/lib/i18n'
import { ResourceMonitor } from '@/components/bot-factory/resource-monitor'
import { ProcessManager } from '@/components/bot-factory/process-manager'
import { HourlyChart as SharedHourlyChart } from '@/components/bot-factory/charts/hourly-chart'

// ─── Hourly Activity Chart (wraps shared component) ──────────────────────────

const HourlyChart = React.memo(function HourlyChart({
  data,
  t,
}: {
  data: number[]
  t: (_key: TranslationKey, _params?: Record<string, string | number>) => string
}) {
  const hasData = data.some(v => v > 0)

  return (
    <Card className="shadow-none border-border/20 overflow-hidden">
      <CardHeader className="pb-1 pt-2.5 px-3">
        <CardTitle className="text-[13px] font-semibold text-foreground flex items-center gap-1.5">
          <BarChart3 className="size-3.5 text-muted-foreground" />
          {t('statsTab.hourlyActivity')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-1.5 px-3 pb-3">
        {hasData ? (
          <SharedHourlyChart data={data} colorClass="bg-teal-500/80" height={96} />
        ) : (
          <div className="h-24 flex items-center justify-center text-xs text-muted-foreground rounded-md">
            {t('statsTab.noData')}
          </div>
        )}
      </CardContent>
    </Card>
  )
})

// ─── Daily Messages Trend ───────────────────────────────────────────────────

// BUG FIX: Fill missing dates in daily messages data so the chart always shows 7 consecutive days.
// The stats API only returns dates with messages, causing gaps in the bar chart.
// BUG FIX: Always generate last 7 days even when API returns no data.
// Previously returned [] when data was empty, causing the chart to disappear entirely.
function fillMissingDays(data: { date: string; count: number }[]): { date: string; count: number }[] {
  const result: { date: string; count: number }[] = []
  const dataMap = data.length > 0 ? new Map(data.map(d => [d.date, d.count])) : new Map()

  // Generate last 7 days including today
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - i)
    const pad = (n: number) => String(n).padStart(2, '0')
    const dateStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    result.push({ date: dateStr, count: dataMap.get(dateStr) ?? 0 })
  }

  return result
}

const DailyTrend = React.memo(function DailyTrend({
  data,
  locale,
  t,
}: {
  data: { date: string; count: number }[]
  locale: string
  t: (_key: TranslationKey, _params?: Record<string, string | number>) => string
}) {
  // BUG FIX: Always show 7 consecutive days, filling missing dates with 0
  const last7 = fillMissingDays(data)
  const hasData = last7.some(d => d.count > 0)
  const maxVal = Math.max(...last7.map((d) => d.count), 1)

  return (
    <Card className="shadow-none border-border/20 overflow-hidden">
      <CardHeader className="pb-1 pt-2.5 px-3">
        <CardTitle className="text-[13px] font-semibold text-foreground">
          {t('statsTab.dailyMessages')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-1.5 px-3 pb-3">
        {hasData ? (
        <div className="flex items-end gap-1.5 h-24">
          {last7.map((day) => {
            const heightPct = (day.count / maxVal) * 100
            const dateLabel = new Date(day.date + 'T12:00:00').toLocaleDateString(
              locale === 'zh' ? 'zh-CN' : 'en-US',
              { weekday: 'short' }
            )
            return (
              <div
                key={day.date}
                className="flex-1 flex flex-col items-center gap-1"
                title={t('statsTab.tooltipDaily', {
                  date: day.date,
                  count: formatNumber(day.count),
                })}
              >
                <div className="w-full flex-1 flex items-end">
                  <div
                    className="w-full rounded-t-md bg-teal-500/80 hover:bg-teal-500 transition-colors min-h-[4px]"
                    style={{ height: `${heightPct}%` }}
                    role="img"
                    aria-label={`${day.date}: ${formatNumber(day.count)} messages`}
                  />
                </div>
                <span className="text-[11px] text-muted-foreground leading-none truncate w-full text-center">
                  {dateLabel}
                </span>
              </div>
            )
          })}
        </div>
        ) : (
          <div className="h-28 flex items-center justify-center text-sm text-muted-foreground rounded-md">
            {t('statsTab.noData')}
          </div>
        )}
      </CardContent>
    </Card>
  )
})

// ─── Top Commands ───────────────────────────────────────────────────────────

const TopCommands = React.memo(function TopCommands({
  commands,
  t,
}: {
  commands: { command: string; count: number; percentage: number }[]
  t: (_key: TranslationKey, _params?: Record<string, string | number>) => string
}) {
  if (commands.length === 0) return null
  const maxPct = Math.max(...commands.map((c) => c.percentage), 1)

  return (
    <Card className="shadow-none border-border/20 overflow-hidden">
      <CardHeader className="pb-1 pt-2.5 px-3">
        <CardTitle className="text-[13px] font-semibold text-foreground">
          {t('statsTab.topCommands')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-1.5 px-3 pb-3 space-y-2">
        {commands.map((cmd) => (
          <div key={cmd.command} className="space-y-0.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-mono font-medium text-foreground">
                {cmd.command}
              </span>
              <span className="text-muted-foreground">
                {formatNumber(cmd.count)} ({cmd.percentage}%)
              </span>
            </div>
            <div className="h-2 w-full bg-muted/60 rounded-full overflow-hidden">
              <div
                className="h-full bg-teal-500/70 rounded-full transition-all"
                style={{ width: `${(cmd.percentage / maxPct) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
})

// ─── Monitoring Tab (Main Export) ───────────────────────────────────────────

export function MonitoringTab({ isVisible = true }: { isVisible?: boolean }) {
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => s.bots.find((b) => b.id === selectedBotId))
  const fetchBotStats = useBotStore((s) => s.fetchBotStats)
  const t = useT()
  const locale = useLocale()

  // Refresh stats when this tab is mounted, with periodic refresh while visible
  useEffect(() => {
    if (!isVisible) return
    if (bot?.id) {
      fetchBotStats(bot.id)
      const interval = setInterval(() => {
        const currentBotId = useBotStore.getState().selectedBotId
        if (currentBotId) fetchBotStats(currentBotId)
      }, 30000)
      return () => clearInterval(interval)
    }
  }, [bot?.id, fetchBotStats, isVisible])

  if (!bot) return null

  const botId = bot.id

  return (
    <div className="space-y-3">
      {/* Section Header — compact */}
      <div className="pb-2">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {t('statsTab.title')}
        </h3>
      </div>

      {/* Charts: Hourly Activity + Daily Messages — compact grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <HourlyChart data={bot.stats.hourlyActivity} t={t} />
        <DailyTrend data={bot.stats.dailyMessages} locale={locale} t={t} />
      </div>

      {/* Top Commands — inline card */}
      <TopCommands commands={bot.stats.topCommands} t={t} />

      {/* Resource Monitor — compact */}
      <ResourceMonitor botId={botId} />

      {/* Process Info — compact, only shown when running */}
      <ProcessManager />
    </div>
  )
}
