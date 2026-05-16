'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { Cpu, MemoryStick, RotateCcw, Clock, AlertTriangle, Activity } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useBotRunnerConnection, useBotStatuses, useResourceData } from '@/lib/bot-runner-context'
import { useT } from '@/lib/i18n'
import { cn, formatUptimeShort } from '@/lib/utils'

// ─── Resource Monitor ──────────────────────────────────────────────────────

export const ResourceMonitor = React.memo(function ResourceMonitor({ botId }: { botId: string }) {
  const t = useT()
  const { connected } = useBotRunnerConnection()
  const botStatuses = useBotStatuses()
  const resourceData = useResourceData()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
  }, [])

  if (!mounted || !connected) return null

  const status = botStatuses.get(botId)
  const resource = resourceData.get(botId)

  const derived = useMemo(() => {
    const isRunning = status?.status === 'running'
    const memoryMb = resource?.memoryUsageMb ?? 0
    const maxMemoryMb = 256
    const memoryPercent = maxMemoryMb > 0 ? Math.min((memoryMb / maxMemoryMb) * 100, 100) : 0
    const cpuPercent = resource?.cpuUsage ?? 0
    const hasCpuData = cpuPercent > 0 || memoryMb > 0
    const cpuAvailable = isRunning && hasCpuData
    const restartCount = resource?.restartCount ?? 0
    const uptimeSeconds = resource?.uptime || 0
    return { isRunning, memoryMb, maxMemoryMb, memoryPercent, cpuPercent, hasCpuData, cpuAvailable, restartCount, uptimeSeconds }
  }, [status, resource])

  if (!mounted || !connected) return null

  if (!derived.isRunning && !resource) return null

  return (
    <Card className="border-border/20 shadow-sm overflow-hidden">
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          {t('resourceMonitor.title')}
          {derived.isRunning && (
            <Badge variant="outline" className="text-[10px] h-5 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20">
              <span className="relative flex size-1.5 mr-1">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
              </span>
              {t('resourceMonitor.running')}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 space-y-2.5">
        <ResourceBar
          icon={<Cpu className="size-3.5" />}
          label={t('resourceMonitor.cpu')}
          value={derived.cpuAvailable ? derived.cpuPercent : 0}
          unit="%"
          displayValue={derived.cpuAvailable ? undefined : 'N/A'}
          colorClass={derived.cpuAvailable ? getResourceColor(derived.cpuPercent, 50, 80) : 'bg-muted-foreground/30'}
          showWarning={derived.cpuAvailable && derived.cpuPercent > 80}
          warningText={t('resourceMonitor.cpuWarning')}
        />

        <ResourceBar
          icon={<MemoryStick className="size-3.5" />}
          label={t('resourceMonitor.memory')}
          value={derived.memoryPercent}
          displayValue={`${derived.memoryMb.toFixed(1)} ${t('resourceMonitor.mb')}`}
          unit=""
          colorClass={getMemoryColor(derived.memoryPercent, 60, 85)}
          showWarning={derived.memoryPercent > 85}
          warningText={t('resourceMonitor.memoryWarning')}
          subLabel={`${t('resourceMonitor.maxMemory')}: ${derived.maxMemoryMb} ${t('resourceMonitor.mb')}`}
        />

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md p-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RotateCcw className="size-3" />
              {t('resourceMonitor.restarts')}
            </div>
            <div className={cn('text-sm font-semibold mt-0.5', derived.restartCount > 0 && 'text-amber-600 dark:text-amber-400')}>
              {derived.restartCount}
              {derived.restartCount > 0 && (
                <span className="text-[10px] text-muted-foreground font-normal ml-1">
                  /5 {t('resourceMonitor.autoRestart')}
                </span>
              )}
            </div>
          </div>
          <div className="rounded-md p-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3" />
              {t('resourceMonitor.uptime')}
            </div>
            <div className="text-sm font-semibold mt-0.5">
              {formatUptimeShort(derived.uptimeSeconds)}
            </div>
          </div>
        </div>

        {!derived.isRunning && derived.memoryMb === 0 && !derived.cpuAvailable && (
          <div className="text-center text-xs text-muted-foreground py-2">
            <Activity className="size-4 mx-auto mb-1.5 text-muted-foreground/40" />
            {t('resourceMonitor.noData')}
          </div>
        )}
      </CardContent>
    </Card>
  )
})

// ─── Resource Bar Component ────────────────────────────────────────────────

function ResourceBar({
  icon,
  label,
  value,
  unit,
  displayValue,
  colorClass,
  showWarning,
  warningText,
  subLabel,
}: {
  icon: React.ReactNode
  label: string
  value: number
  unit: string
  displayValue?: string
  colorClass: string
  showWarning: boolean
  warningText: string
  subLabel?: string
}) {
  const display = displayValue !== undefined ? displayValue : `${Math.round(value)}${unit}`

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="flex items-center gap-1.5">
          {showWarning && (
            <span className="flex items-center gap-1 text-[10px] text-red-500">
              <AlertTriangle className="size-3" />
              {warningText}
            </span>
          )}
          <span className="text-xs font-mono font-medium">{display}</span>
        </div>
      </div>
      <div className="h-2.5 rounded-full bg-muted/60 overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-700 ease-out', colorClass)}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      {subLabel && (
        <div className="text-[10px] text-muted-foreground/60">{subLabel}</div>
      )}
    </div>
  )
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getResourceColor(value: number, warnThreshold: number, dangerThreshold: number): string {
  if (value >= dangerThreshold) return 'bg-gradient-to-r from-red-500 to-red-600'
  if (value >= warnThreshold) return 'bg-gradient-to-r from-amber-400 to-amber-500'
  return 'bg-gradient-to-r from-cyan-400 to-blue-500'
}

function getMemoryColor(percent: number, warnThreshold: number, dangerThreshold: number): string {
  if (percent >= dangerThreshold) return 'bg-gradient-to-r from-red-500 to-red-600'
  if (percent >= warnThreshold) return 'bg-gradient-to-r from-amber-400 to-amber-500'
  return 'bg-gradient-to-r from-blue-400 to-blue-500'
}


