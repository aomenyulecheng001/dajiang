'use client'

import { useEffect } from 'react'
import {
  MessageSquare,
  Users,
  AlertTriangle,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatNumber, formatUptime } from '@/lib/utils'
import { useBotStore } from '@/store/bot-store'
import { useT, useLocale, type TranslationKey } from '@/lib/i18n'
import { HourlyChart as SharedHourlyChart } from '@/components/bot-factory/charts/hourly-chart'

function StatCard({
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
    <Card className="gap-0 py-0 shadow-none">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${color}`}
          >
            <Icon className="size-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] text-muted-foreground font-medium">{label}</p>
            <p className="text-xl font-bold text-foreground">{value}</p>
            {subValue && (
              <p className="text-[13px] text-muted-foreground mt-0.5">{subValue}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function HourlyChart({ data, t }: { data: number[]; t: (_key: TranslationKey, _params?: Record<string, string | number>) => string }) {
  const hasData = data.some(v => v > 0)

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-0">
        <CardTitle className="text-[15px] font-semibold text-foreground">
          {t('statsTab.hourlyActivity')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2">
        {hasData ? (
          <SharedHourlyChart data={data} colorClass="bg-primary/80" height={128} />
        ) : (
          <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
            {t('statsTab.noData')}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function TopCommands({ commands, t }: { commands: { command: string; count: number; percentage: number }[]; t: (_key: TranslationKey, _params?: Record<string, string | number>) => string }) {
  if (commands.length === 0) return null
  const maxPct = Math.max(...commands.map((c) => c.percentage), 1)

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-0">
        <CardTitle className="text-[15px] font-semibold text-foreground">
          {t('statsTab.topCommands')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2 space-y-3">
        {commands.map((cmd) => (
          <div key={cmd.command} className="space-y-1">
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-mono font-medium text-foreground">{cmd.command}</span>
              <span className="text-muted-foreground">
                {formatNumber(cmd.count)} ({cmd.percentage}%)
              </span>
            </div>
            <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary/70 rounded-full transition-all"
                style={{ width: `${(cmd.percentage / maxPct) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function DailyTrend({ data, locale, t }: { data: { date: string; count: number }[]; locale: string; t: (_key: TranslationKey, _params?: Record<string, string | number>) => string }) {
  // Fill missing days with 0 count to always show 7 consecutive days
  const last7 = (() => {
    const days: { date: string; count: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const pad = (n: number) => String(n).padStart(2, '0')
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` // Local date
      const existing = data.find((item) => item.date === dateStr)
      days.push({ date: dateStr, count: existing?.count || 0 })
    }
    return days
  })()
  const hasData = last7.some((d) => d.count > 0)
  const maxVal = Math.max(...last7.map((d) => d.count), 1)

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-0">
        <CardTitle className="text-[15px] font-semibold text-foreground">
          {t('statsTab.dailyMessages')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="flex items-end gap-2 sm:gap-3 h-28">
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
                title={t('statsTab.tooltipDaily', { date: day.date, count: formatNumber(day.count) })}
              >
                <div className="w-full flex-1 flex items-end">
                  <div
                    className="w-full rounded-t-md bg-primary/70 hover:bg-primary transition-colors min-h-[4px]"
                    style={{ height: `${heightPct}%` }}
                  />
                </div>
                <span className="text-[11px] text-muted-foreground leading-none truncate w-full text-center">
                  {dateLabel}
                </span>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

export function StatsTab() {
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => s.bots.find((b) => b.id === selectedBotId))
  const fetchBotStats = useBotStore((s) => s.fetchBotStats)
  const t = useT()
  const locale = useLocale()

  useEffect(() => {
    if (bot?.id) {
      fetchBotStats(bot.id)
    }
  }, [bot?.id, fetchBotStats])

  if (!bot) return null

  const errorsSub =
    bot.stats.errors === 0 ? t('statsTab.allClear') : t('statsTab.needsAttention')

  const uptimeSub =
    bot.stats.uptime > 0
      ? t('statsTab.uptimeLabel', { uptime: formatUptime(bot.stats.uptime, locale) })
      : t('statsTab.currentlyOffline')

  return (
    <div className="space-y-6">
      <div className="pb-1">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{t('statsTab.title')}</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('statsTab.desc')}
        </p>
      </div>

      {/* Overview Cards (3 stats: messages, users, errors) */}
      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        <StatCard
          icon={MessageSquare}
          label={t('statsTab.totalMessages')}
          value={formatNumber(bot.stats.messages)}
          subValue={t('statsTab.allTime')}
          color="bg-teal-500"
        />
        <StatCard
          icon={Users}
          label={t('statsTab.activeUsers')}
          value={formatNumber(bot.stats.users)}
          subValue={uptimeSub}
          color="bg-emerald-500"
        />
        <StatCard
          icon={AlertTriangle}
          label={t('statsTab.errors')}
          value={formatNumber(bot.stats.errors)}
          subValue={errorsSub}
          color="bg-rose-500"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <HourlyChart data={bot.stats.hourlyActivity} t={t} />
        <TopCommands commands={bot.stats.topCommands} t={t} />
      </div>

      <DailyTrend data={bot.stats.dailyMessages} locale={locale} t={t} />
    </div>
  )
}
