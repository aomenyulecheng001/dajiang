'use client'

import { Clock, Globe, Activity, Code, Layers, Calendar, Heart } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useBotStore } from '@/store/bot-store'
import { formatDate, statusConfig, healthConfig } from '@/lib/utils'
import { useT, useLocale } from '@/lib/i18n'
import { getStatusLabel, getHealthLabel } from '@/lib/utils'

import { LANGUAGE_LABELS } from '@/lib/bot-constants'

export function InfoTab() {
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => s.bots.find((b) => b.id === selectedBotId))
  const t = useT()
  const locale = useLocale()

  if (!bot) return null

  const status = statusConfig[bot.status] || statusConfig.inactive
  const health = healthConfig[bot.health] || healthConfig.unknown
  const statusLabel = getStatusLabel(bot.status, locale)
  const healthLabel = getHealthLabel(bot.health, locale)

  const infoCards = [
    { icon: Code, label: t('common.version'), value: `v${bot.version}` },
    { icon: Globe, label: t('common.language'), value: LANGUAGE_LABELS[bot.language] || bot.language },
    { icon: Layers, label: t('infoTab.template'), value: bot.template || t('common.custom') },
    { icon: Calendar, label: t('common.created'), value: formatDate(bot.createdAt, locale) },
    { icon: Clock, label: t('common.lastUpdated'), value: formatDate(bot.updatedAt, locale) },
    { icon: Activity, label: t('common.status'), value: statusLabel, badge: status.className },
    { icon: Heart, label: t('common.health'), value: healthLabel, badge: health.className },
  ]

  return (
    <div className="space-y-6">
      <div className="pb-1">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{t('infoTab.title')}</h3>
        <p className="text-sm text-muted-foreground mt-0.5">{t('infoTab.desc')}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {infoCards.map((card) => (
          <Card key={card.label} className="gap-0 py-0 shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <card.icon className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-muted-foreground uppercase tracking-wider">
                    {card.label}
                  </p>
                  {card.badge ? (
                    <Badge variant="outline" className={`mt-1 text-[13px] font-medium ${card.badge}`}>
                      {card.value}
                    </Badge>
                  ) : (
                    <p className="mt-0.5 text-[15px] font-semibold text-foreground truncate">
                      {card.value}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

    </div>
  )
}
