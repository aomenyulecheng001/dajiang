'use client'

import { useState, useEffect, useMemo } from 'react'
import { Server, MemoryStick, Cpu, Clock, Activity } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useBotRunnerConnection, useBotStatuses, useResourceData } from '@/lib/bot-runner-context'
import { useBotStore } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import { cn, formatUptimeShort } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// ─── Process Manager ───────────────────────────────────────────────────────

export function ProcessManager() {
  const t = useT()
  // PERF FIX: Use split contexts instead of combined useBotRunner().
  // Previously subscribed to the combined BotRunnerContext which includes all Maps,
  // causing re-renders on any bot's status/resource change even though we only
  // need data for the selected bot. Split contexts allow more granular subscriptions.
  const { connected } = useBotRunnerConnection()
  const botStatuses = useBotStatuses()
  const resourceData = useResourceData()
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const botStatus = useMemo(() => botStatuses.get(selectedBotId || ''), [botStatuses, selectedBotId])
  const botResource = useMemo(() => resourceData.get(selectedBotId || ''), [resourceData, selectedBotId])
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
  }, [])

  if (!mounted || !connected) return null

  const processes = (() => {
    if (!selectedBotId || !botStatus) return []
    const status = botStatus
    if (status.status !== 'running' && status.status !== 'starting' && status.status !== 'stopping' && status.status !== 'error') return []
    return [{
      id: selectedBotId,
      name: status.name || selectedBotId,
      status: status.status,
      pid: status.pid,
      resource: botResource,
      startedAt: status.startedAt,
      lastError: status.lastError,
    }]
  })()

  if (processes.length === 0) {
    return null // Don't show empty card when no process
  }

  return (
    <Card className="border-border/20 shadow-sm overflow-hidden">
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          {t('resourceMonitor.processInfo')}
          <Badge variant="outline" className="text-[10px] h-5 ml-auto">
            {processes.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {/* Desktop Table */}
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">{t('resourceMonitor.status')}</TableHead>
                <TableHead className="text-xs">{t('resourceMonitor.pid')}</TableHead>
                <TableHead className="text-xs w-20">{t('resourceMonitor.memory')}</TableHead>
                <TableHead className="text-xs w-20">{t('resourceMonitor.cpu')}</TableHead>
                <TableHead className="text-xs">{t('resourceMonitor.restarts')}</TableHead>
                <TableHead className="text-xs">{t('resourceMonitor.uptime')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {processes.map((proc) => (
                <TableRow key={proc.id}>
                  <TableCell className="py-2">
                    <StatusBadge status={proc.status} t={t} />
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground py-2">
                    {proc.pid || '—'}
                  </TableCell>
                  <TableCell className="text-xs font-mono py-2">
                    <div className="flex items-center gap-1.5">
                      <MemoryStick className="size-3 text-muted-foreground/60" />
                      <span>{proc.resource?.memoryUsageMb?.toFixed(1) || '0.0'} {t('resourceMonitor.mb')}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs font-mono py-2">
                    <div className="flex items-center gap-1.5">
                      <Cpu className="size-3 text-muted-foreground/60" />
                      <span>{proc.resource?.cpuUsage ? `${proc.resource.cpuUsage}%` : 'N/A'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs font-mono py-2">
                    {proc.resource?.restartCount || 0}
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground py-2">
                    <div className="flex items-center gap-1">
                      <Clock className="size-3 text-muted-foreground/60" />
                      {proc.resource?.uptime ? formatUptimeShort(proc.resource.uptime) : '—'}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden px-4 pb-3">
          {processes.map((proc) => (
            <div key={proc.id} className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <div className="flex items-center gap-1.5">
                <StatusBadge status={proc.status} t={t} />
              </div>
              <div className="text-muted-foreground">PID: <span className="text-foreground font-mono">{proc.pid || '—'}</span></div>
              <div className="text-muted-foreground">
                <MemoryStick className="size-2.5 inline mr-0.5" />
                {proc.resource?.memoryUsageMb?.toFixed(1) || '0.0'} {t('resourceMonitor.mb')}
              </div>
              <div className="text-muted-foreground">
                <Cpu className="size-2.5 inline mr-0.5" />
                {proc.resource?.cpuUsage ? `${proc.resource.cpuUsage}%` : 'N/A'}
              </div>
              <div className="text-muted-foreground">
                <Clock className="size-2.5 inline mr-0.5" />
                {proc.resource?.uptime ? formatUptimeShort(proc.resource.uptime) : '—'}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Status Badge ──────────────────────────────────────────────────────────

function StatusBadge({ status, t }: { status: string; t: (key: any, params?: Record<string, string | number>) => string }) {
  const config: Record<string, { label: string; className: string }> = {
    running: {
      label: t('resourceMonitor.running'),
      className: 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-400 border-teal-200 dark:border-teal-500/20',
    },
    starting: {
      label: t('runtime.deploying'),
      className: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400 border-blue-200 dark:border-blue-500/20',
    },
    stopping: {
      label: t('runtime.stopping'),
      className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20',
    },
    error: {
      label: t('runtime.error'),
      className: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 border-red-200 dark:border-red-500/20',
    },
    stopped: {
      label: t('runtime.stopped'),
      className: 'bg-zinc-50 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
    },
  }

  const c = config[status] || config.stopped

  return (
    <Badge variant="outline" className={cn('text-[10px] h-5', c.className)}>
      {c.label}
    </Badge>
  )
}


