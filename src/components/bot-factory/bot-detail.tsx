'use client'

import { useState, useRef, useMemo } from 'react'
import { Info, Code, Settings, ScrollText, BarChart3, MessageSquare, Users, AlertTriangle } from 'lucide-react'
import { OverviewTab } from './tabs/overview-tab'
import { CodeTab } from './tabs/code-tab'
import { ConfigCombinedTab } from './tabs/config-combined-tab'
import { LogsTab } from './tabs/logs-tab'
import { MonitoringTab } from './tabs/monitoring-tab'
import { Badge } from '@/components/ui/badge'
import { cn, statusConfig, getStatusLabel, formatNumber } from '@/lib/utils'
import { BotAvatar } from './bot-avatar'
import { useBotStore } from '@/store/bot-store'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RuntimeControl } from './runtime-control'
import { useT, useLocale } from '@/lib/i18n'
import { TabErrorBoundary } from './tab-error-boundary'

export function BotDetail() {
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => s.bots.find((b) => b.id === selectedBotId))
  const [activeTab, setActiveTab] = useState('overview')
  const t = useT()
  const locale = useLocale()

  if (!bot) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-base text-muted-foreground">{t('botDetail.notFound')}</p>
      </div>
    )
  }

  const status = statusConfig[bot.status] || statusConfig.inactive
  const statusLabel = getStatusLabel(bot.status, locale)

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4 sm:p-6 lg:p-8 animate-fade-in">
      {/* Bot Header */}
      <div className="rounded-xl border border-border/50 bg-card p-4 sm:p-5 shadow-sm">
        <div className="flex items-start gap-3 sm:gap-4 min-w-0">
          <BotAvatar
            botId={bot.id}
            emoji={bot.emoji}
            customIcon={bot.customIcon}
            size="xl"
            className={cn(
              bot.status === 'active' && bot.lastRunnerStatus !== 'stopped' && 'ring-2 ring-primary/20 ring-offset-2 ring-offset-background'
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h2 className="text-xl sm:text-2xl font-semibold text-foreground">{bot.name}</h2>
              {bot.status === 'active' && bot.lastRunnerStatus !== 'stopped' && (
                <span className="relative flex size-2.5 shrink-0">
                  <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
                  <span className="relative rounded-full size-2.5 bg-emerald-500" />
                </span>
              )}
              {bot.status === 'inactive' && bot.lastRunnerStatus === 'stopped' && (
                <span className="shrink-0 size-2.5 rounded-full bg-amber-500" />
              )}
              <Badge
                variant="outline"
                className={cn('text-xs font-medium', status.className)}
              >
                {statusLabel}
              </Badge>
              <span className="text-xs text-muted-foreground">
                v{bot.version} · {bot.language === 'javascript' ? 'JavaScript' : bot.language === 'typescript' ? 'TypeScript' : bot.language === 'python' ? 'Python' : bot.language}
              </span>
            </div>
            <p className="text-sm text-muted-foreground/80 leading-relaxed max-w-lg mt-0.5">
              {bot.description || t('common.noDescription')}
            </p>

            {/* Quick Stats Row */}
            <div className="flex items-center gap-3 sm:gap-4 mt-2.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MessageSquare className="size-3.5 text-primary" />
                <span className="font-medium text-foreground">{formatNumber(bot.stats.messages)}</span>
                <span>{t('botDetail.quickMessages')}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="size-3.5 text-primary/70" />
                <span className="font-medium text-foreground">{formatNumber(bot.stats.users)}</span>
                <span>{t('botDetail.quickUsers')}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="size-3.5 text-rose-400" />
                <span className={cn('font-medium', bot.stats.errors > 0 ? 'text-rose-500 dark:text-rose-400' : 'text-muted-foreground/60')}>
                  {formatNumber(bot.stats.errors)}
                </span>
                <span>{t('botDetail.quickErrors')}</span>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* Runtime Control (Compact) */}
      <RuntimeControl botId={bot.id} botName={bot.name} botLanguage={bot.language} botTemplate={bot.template} />

      {/* Tabs (5 tabs: Overview, Code, Config, Logs, Monitoring) */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="w-full flex overflow-x-auto h-auto p-1 bg-muted/40 rounded-xl scrollbar-hide scroll-smooth snap-x snap-mandatory">
          <TabsTrigger value="overview" className="gap-1.5 shrink-0 snap-start rounded-lg text-sm">
            <Info className="size-3.5 hidden sm:block" />{t('botDetail.tabOverview')}
          </TabsTrigger>
          <TabsTrigger value="code" className="gap-1.5 shrink-0 snap-start rounded-lg text-sm">
            <Code className="size-3.5 hidden sm:block" />{t('botDetail.tabCode')}
          </TabsTrigger>
          <TabsTrigger value="config" className="gap-1.5 shrink-0 snap-start rounded-lg text-sm">
            <Settings className="size-3.5 hidden sm:block" />{t('botDetail.tabConfig')}
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-1.5 shrink-0 snap-start rounded-lg text-sm">
            <ScrollText className="size-3.5 hidden sm:block" />{t('botDetail.tabLogs')}
          </TabsTrigger>
          <TabsTrigger value="monitoring" className="gap-1.5 shrink-0 snap-start rounded-lg text-sm">
            <BarChart3 className="size-3.5 hidden sm:block" />{t('botDetail.tabMonitor')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-3 rounded-xl border border-border/50 bg-card shadow-sm"><div className="p-5"><TabErrorBoundary fallback={t('common.tabError')}>{activeTab === 'overview' && <OverviewTab key={bot.id} />}</TabErrorBoundary></div></TabsContent>
        <TabsContent value="code" className="mt-3 rounded-xl border border-border/50 bg-card shadow-sm"><div className="p-5"><TabErrorBoundary fallback={t('common.tabError')}>{activeTab === 'code' && <CodeTab key={bot.id} />}</TabErrorBoundary></div></TabsContent>
        <TabsContent value="config" className="mt-3 rounded-xl border border-border/50 bg-card shadow-sm"><div className="p-5"><TabErrorBoundary fallback={t('common.tabError')}>{activeTab === 'config' && <ConfigCombinedTab key={bot.id} />}</TabErrorBoundary></div></TabsContent>
        <TabsContent value="logs" className="mt-3 rounded-xl border border-border/50 bg-card shadow-sm"><div className="p-5"><TabErrorBoundary fallback={t('common.tabError')}>{activeTab === 'logs' && <LogsTab key={bot.id} isVisible={activeTab === 'logs'} />}</TabErrorBoundary></div></TabsContent>
        <TabsContent value="monitoring" className="mt-3 rounded-xl border border-border/50 bg-card shadow-sm"><div className="p-5"><TabErrorBoundary fallback={t('common.tabError')}>{activeTab === 'monitoring' && <MonitoringTab key={bot.id} isVisible={activeTab === 'monitoring'} />}</TabErrorBoundary></div></TabsContent>
      </Tabs>
    </div>
  )
}
