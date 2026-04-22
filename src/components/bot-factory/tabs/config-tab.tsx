'use client'

import { useState } from 'react'
import { Gauge, FileText, Wifi, AlertTriangle, Check, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { useBotStore } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import type { BotConfig } from '@/types/bot'

export function ConfigTab() {
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => s.bots.find((b) => b.id === selectedBotId))
  const updateBotConfig = useBotStore((s) => s.updateBotConfig)
  const t = useT()

  // BUG FIX: Editable number fields for timeout, rateLimit, maxConcurrent.
  // Previously these were read-only Badge components — users couldn't change them.
  // Must be declared before early return (rules-of-hooks).
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  if (!bot) return null

  const config = bot.config
  // BUG FIX: Use the same isRunning definition as code-tab and bot-detail.
  // Previously this only checked bot.status === 'active', which was true even
  // when lastRunnerStatus === 'stopped' (bot was previously running but stopped).
  const isRunning = bot.status === 'active' && bot.lastRunnerStatus !== 'stopped'

  // FIX: Show restart hint when config changes are made on a running bot.
  // Config changes (logLevel, pollingMode, autoRestart) are saved to DB
  // but only take effect on next deploy/restart. Without this hint,
  // users think the changes don't work.
  const showRestartHint = (description?: string) => {
    if (isRunning) {
      toast.success(description || t('configTab.saved'), {
        description: t('configTab.restartRequired') || 'Changes will take effect after restart',
      })
    } else {
      toast.success(description || t('configTab.saved'))
    }
  }

  const startEdit = (field: string, currentValue: number) => {
    setEditingField(field)
    setEditValue(String(currentValue))
  }

  const cancelEdit = () => {
    setEditingField(null)
    setEditValue('')
  }

  const saveEdit = (field: string) => {
    const num = parseInt(editValue, 10)
    if (isNaN(num) || num <= 0) {
      toast.error(t('configTab.invalidNumber'))
      return
    }
    if (field === 'timeout' && num > 300) {
      toast.error(t('configTab.timeoutMax'))
      return
    }
    if (field === 'rateLimitPerMinute' && num > 1000) {
      toast.error(t('configTab.rateLimitMax'))
      return
    }
    if (field === 'maxConcurrentRequests' && num > 100) {
      toast.error(t('configTab.maxConcurrentMax'))
      return
    }
    updateBotConfig(bot.id, { [field]: num })
    showRestartHint(t('configTab.saved'))
    setEditingField(null)
    setEditValue('')
  }

  const handleAutoRestartChange = (checked: boolean) => {
    updateBotConfig(bot.id, { autoRestart: checked })
    showRestartHint(checked ? t('configTab.autoRestartEnabled') : t('configTab.autoRestartDisabled'))
  }

  const handleLogLevelChange = (value: string) => {
    updateBotConfig(bot.id, { logLevel: value as BotConfig['logLevel'] })
    showRestartHint(t('configTab.logLevelSet', { level: value }))
  }

  const handlePollingModeChange = (value: string) => {
    updateBotConfig(bot.id, { pollingMode: value as BotConfig['pollingMode'] })
    showRestartHint(t('configTab.pollingModeSet', { mode: value }))
  }

  return (
    <div className="space-y-4">
      <div className="pb-1">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{t('configTab.title')}</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('configTab.desc')}
        </p>
      </div>

      {/* Restart Required Banner */}
      {isRunning && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5 p-3">
          <AlertTriangle className="size-4 text-amber-500 shrink-0" />
          <span className="text-[13px] text-amber-700 dark:text-amber-400">
            {t('configTab.restartRequired') || 'Changes will take effect after restart'}
          </span>
        </div>
      )}

      {/* Network Settings */}
      <Card className="shadow-none border-border/20 overflow-hidden">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-[15px] font-semibold text-foreground flex items-center gap-2">
            <Wifi className="size-4 text-muted-foreground" />
            {t('configTab.networkSettings')}
          </CardTitle>
          <CardDescription>{t('configTab.networkDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[15px] font-medium text-foreground">{t('configTab.pollingMode')}</p>
              <p className="text-[13px] text-muted-foreground">
                {t('configTab.pollingModeDesc')}
              </p>
            </div>
            <Select value={config.pollingMode} onValueChange={handlePollingModeChange}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="polling">{t('configTab.polling')}</SelectItem>
                <SelectItem value="webhook">{t('configTab.webhook')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[15px] font-medium text-foreground">{t('configTab.timeout')}</p>
              <p className="text-[13px] text-muted-foreground">
                {t('configTab.timeoutDesc')}
              </p>
            </div>
            {editingField === 'timeout' ? (
              <div className="flex items-center gap-1">
                <Input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveEdit('timeout') }
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  className="h-7 w-20 text-[13px] font-mono text-right"
                  autoFocus
                />
                <span className="text-[13px] text-muted-foreground">s</span>
                <Button variant="ghost" size="icon" className="size-6 text-emerald-600" onClick={() => saveEdit('timeout')}>
                  <Check className="size-3" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={cancelEdit}>
                  <X className="size-3" />
                </Button>
              </div>
            ) : (
              <button
                onClick={() => startEdit('timeout', config.timeout)}
                className="cursor-pointer hover:bg-muted/50 rounded-md px-2 py-0.5 transition-colors"
                title={t('configTab.clickToEdit')}
              >
                <Badge variant="secondary" className="font-mono">
                  {config.timeout}s
                </Badge>
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Performance Settings */}
      <Card className="shadow-none border-border/20 overflow-hidden">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-[15px] font-semibold text-foreground flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" />
            {t('configTab.perfSettings')}
          </CardTitle>
          <CardDescription>{t('configTab.perfDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[15px] font-medium text-foreground">{t('configTab.rateLimit')}</p>
              <p className="text-[13px] text-muted-foreground">
                {t('configTab.rateLimitDesc')}
              </p>
            </div>
            {editingField === 'rateLimitPerMinute' ? (
              <div className="flex items-center gap-1">
                <Input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveEdit('rateLimitPerMinute') }
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  className="h-7 w-20 text-[13px] font-mono text-right"
                  autoFocus
                />
                <span className="text-[13px] text-muted-foreground">/min</span>
                <Button variant="ghost" size="icon" className="size-6 text-emerald-600" onClick={() => saveEdit('rateLimitPerMinute')}>
                  <Check className="size-3" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={cancelEdit}>
                  <X className="size-3" />
                </Button>
              </div>
            ) : (
              <button
                onClick={() => startEdit('rateLimitPerMinute', config.rateLimitPerMinute)}
                className="cursor-pointer hover:bg-muted/50 rounded-md px-2 py-0.5 transition-colors"
                title={t('configTab.clickToEdit')}
              >
                <Badge variant="secondary" className="font-mono">
                  {config.rateLimitPerMinute}/min
                </Badge>
              </button>
            )}
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[15px] font-medium text-foreground">{t('configTab.maxConcurrent')}</p>
              <p className="text-[13px] text-muted-foreground">
                {t('configTab.maxConcurrentDesc')}
              </p>
            </div>
            {editingField === 'maxConcurrentRequests' ? (
              <div className="flex items-center gap-1">
                <Input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveEdit('maxConcurrentRequests') }
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  className="h-7 w-20 text-[13px] font-mono text-right"
                  autoFocus
                />
                <Button variant="ghost" size="icon" className="size-6 text-emerald-600" onClick={() => saveEdit('maxConcurrentRequests')}>
                  <Check className="size-3" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={cancelEdit}>
                  <X className="size-3" />
                </Button>
              </div>
            ) : (
              <button
                onClick={() => startEdit('maxConcurrentRequests', config.maxConcurrentRequests)}
                className="cursor-pointer hover:bg-muted/50 rounded-md px-2 py-0.5 transition-colors"
                title={t('configTab.clickToEdit')}
              >
                <Badge variant="secondary" className="font-mono">
                  {config.maxConcurrentRequests}
                </Badge>
              </button>
            )}
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[15px] font-medium text-foreground">{t('configTab.autoRestart')}</p>
              <p className="text-[13px] text-muted-foreground">
                {t('configTab.autoRestartDesc')}
              </p>
            </div>
            <Switch
              checked={config.autoRestart}
              onCheckedChange={handleAutoRestartChange}
              aria-label={t('configTab.autoRestart')}
            />
          </div>
        </CardContent>
      </Card>

      {/* Logging Settings */}
      <Card className="shadow-none border-border/20 overflow-hidden">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-[15px] font-semibold text-foreground flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            {t('configTab.logSettings')}
          </CardTitle>
          <CardDescription>{t('configTab.logDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[15px] font-medium text-foreground">{t('configTab.logLevel')}</p>
              <p className="text-[13px] text-muted-foreground">
                {t('configTab.logLevelDesc')}
              </p>
            </div>
            <Select value={config.logLevel} onValueChange={handleLogLevelChange}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="debug">{t('configTab.debug')}</SelectItem>
                <SelectItem value="info">{t('configTab.info')}</SelectItem>
                <SelectItem value="warn">{t('configTab.warn')}</SelectItem>
                <SelectItem value="error">{t('configTab.error')}</SelectItem>
                <SelectItem value="critical">{t('configTab.critical')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
