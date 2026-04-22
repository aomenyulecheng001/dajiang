'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Square, RotateCcw, WifiOff, AlertTriangle, Rocket, Info, Loader2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn, isValidBotToken } from '@/lib/utils'
import { useBotRunner } from '@/lib/bot-runner-context'
import { useBotStore } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import { toast } from 'sonner'

// ─── Runtime Control Panel (Compact Design) ────────────────────────────────────

export function RuntimeControl({ botId, botName, botLanguage, botTemplate }: { botId: string; botName?: string; botLanguage?: string; botTemplate?: string }) {

  const t = useT()
  const {
    connected,
    reconnecting,
    reconnectAttempt,
    getBotStatus,
    getDeployProgress,
    deployBot,
    stopBot,
    restartBot,
  } = useBotRunner()

  const bot = useBotStore((s) => s.bots.find((b) => b.id === botId))
  const [mounted, setMounted] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isStartingService, setIsStartingService] = useState(false)
  const [localPending, setLocalPending] = useState<'starting' | 'stopping' | null>(null)
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

  const botRunnerStatus = getBotStatus(botId)?.status

  // Read bot token from envVars — support both BOT_TOKEN and TELEGRAM_BOT_TOKEN
  const tokenEntry = bot?.envVars.filter((v) => (v.key === 'BOT_TOKEN' || v.key === 'TELEGRAM_BOT_TOKEN') && v.value.trim()).slice(-1)[0]
    || bot?.envVars.find((v) => v.key === 'BOT_TOKEN' || v.key === 'TELEGRAM_BOT_TOKEN')
  const botToken = tokenEntry?.value || ''

  const serverTokenStatus = bot?.tokenStatus
  const hasValidToken = serverTokenStatus === 'valid'
    || serverTokenStatus === 'not_set'
    || (!serverTokenStatus && isValidBotToken(botToken))

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
  }, [])

  // Derived: compute effective pending state based on runner status.
  // The 30s safety timeout in the useEffect above will eventually clear localPending.
  const status = getBotStatus(botId)
  const effectiveLocalPending = (() => {
    // Clear 'starting' when runner confirms it's actually starting/running,
    // OR when deploy fails with error status
    if (localPending === 'starting' && status && (status.status === 'starting' || status.status === 'running' || status.status === 'error')) return null
    // Clear 'stopping' when runner confirms the bot is no longer running.
    // The backend now emits 'stopping' status, so we clear localPending when
    // the runner confirms any non-running state (stopping, stopped, error).
    if (localPending === 'stopping' && (!status || status.status !== 'running')) return null
    return localPending
  })()

  const handleStartService = async () => {
    setIsStartingService(true)
    try {
      const res = await fetch('/api/bots/runner/start-service', {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok) {
        toast.success(t('runtime.serviceStarted'))
      } else {
        toast.error(t('runtime.serviceStartFailed'))
      }
    } catch {
      toast.error(t('runtime.serviceStartFailed'))
    } finally {
      setIsStartingService(false)
    }
  }

  const handleDeployAndStart = async () => {
    if (!hasValidToken) {
      toast.error(t('runtime.tokenRequired'))
      return
    }
    setLocalPending('starting')

    // BUG FIX: Fetch full bot detail before deploying to ensure we have
    // projectFiles, codeBlocks, and other heavy fields not included in the
    // list API. Without this, multi-file bots deploy with empty projectFiles.
    try {
      await useBotStore.getState().fetchBotDetail(botId)
    } catch {
      toast.error(t('runtime.serviceNotConnected'))
      setLocalPending(null)
      return
    }
    const freshBot = useBotStore.getState().bots.find((b) => b.id === botId)

    // FIX: Fetch decrypted env vars from the reveal API before deploying.
    // The store only has masked values (••••••••••••) for encrypted secrets.
    // Without this, the runner receives the placeholder instead of the real token.
    let realEnvVarsMap: Record<string, string> = {}
    let realBotToken = botToken
    try {
      const res = await fetch(`/api/bots/${botId}/env-vars/reveal`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        for (const v of data.envVars || []) {
          realEnvVarsMap[v.key] = v.value
        }
        const realTokenEntry = [realEnvVarsMap.BOT_TOKEN, realEnvVarsMap.TELEGRAM_BOT_TOKEN].filter(Boolean).slice(-1)[0]
        if (realTokenEntry) realBotToken = realTokenEntry
      } else {
        // Reveal API failed — check if we have encrypted vars with masked values
        // Use freshBot (full data from fetchBotDetail) instead of potentially-stale bot
        const envSource = freshBot || bot
        const hasMaskedVars = envSource?.envVars.some(v => v.isEncrypted && v.value.includes('•'))
        if (hasMaskedVars) {
          toast.error(t('runtime.envRevealFailed'))
          setLocalPending(null)
          return
        }
        // Fallback: use store values (safe for non-encrypted vars)
        envSource?.envVars.forEach((v) => { realEnvVarsMap[v.key] = v.value })
      }
    } catch {
      // Network error — check if we have encrypted vars with masked values
      const envSource = freshBot || bot
      const hasMaskedVars = envSource?.envVars.some(v => v.isEncrypted && v.value.includes('•'))
      if (hasMaskedVars) {
        toast.error(t('runtime.envRevealFailed'))
        setLocalPending(null)
        return
      }
      // Fallback: use store values (safe for non-encrypted vars)
      ;(freshBot || bot)?.envVars.forEach((v) => { realEnvVarsMap[v.key] = v.value })
    }

    // Use freshBot (fetched with full data) over bot (may be partial from list API)
    const deployBot_ = freshBot || bot
    const depsList = (deployBot_?.dependencies || []).map(d => d.version ? `${d.name}@${d.version}` : d.name)

    deployBot({
      botId,
      config: {
        name: botName || '',
        botToken: realBotToken,
        language: (botLanguage || 'javascript') as 'javascript' | 'typescript' | 'python',
        templateId: botTemplate || 'custom',
        envVars: realEnvVarsMap,
        customCode: deployBot_?.projectFiles?.length ? undefined : (deployBot_?.codeBlocks?.filter(b => b.isActive !== false).map(b => b.code).join('\n\n') || deployBot_?.code || undefined),
        dependencies: depsList.length > 0 ? depsList : undefined,
        projectFiles: deployBot_?.projectFiles?.length
          ? deployBot_.projectFiles.map((f) => ({ path: f.path, content: f.content }))
          : undefined,
        entryPoint: deployBot_?.entryPoint || undefined,
      },
    })
  }

  const handleStop = () => {
    setLocalPending('stopping')
    stopBot(botId)
    toast.success(t('runtime.stopping'))
  }

  if (!mounted) return null

  const progress = getDeployProgress(botId)

  const isDeploying = progress && ['codeGen', 'installDeps', 'build', 'start'].includes(progress.stage)
  // Include 'running' stage so progress bar can animate to 100% before hiding
  const isDeployCompleting = progress && progress.stage === 'running'
  const isDeployError = progress && progress.stage === 'error'
  const showProgressBar = isDeploying || isDeployCompleting || isDeployError
  const isRunning = status?.status === 'running'
  const isStopping = status?.status === 'stopping'
  const isStopped = status?.status === 'stopped' || !status
  const isError = status?.status === 'error'

  // Check if code was modified after the last deploy
  // BUG FIX: Use codeDirty flag instead of updatedAt > lastDeployedAt comparison.
  // Previously, updatedAt was Prisma's @updatedAt which auto-updates on ANY PATCH
  // (name, description, envVars, config, etc.), not just code changes. This caused
  // false "pending redeploy" warnings whenever a non-code field was modified.
  // codeDirty is set to true only when code/dependencies/projectFiles change,
  // and cleared to false when a deploy completes successfully.
  const hasPendingRedeploy = isRunning && bot?.codeDirty === true

  const showStarting = effectiveLocalPending === 'starting' || isDeploying
  const showStopping = effectiveLocalPending === 'stopping' || isStopping

  const uptimeDisplay = status?.startedAt && isRunning
    ? <UptimeDisplay startedAt={status.startedAt} />
    : null

  return (
    <Card
      id="runtime-control"
      className={cn(
        'border-border/50 overflow-hidden shadow-sm',
      )}
    >
      {/* ── Compact Status Bar (always visible) ────────────────────── */}
      <div className="px-3.5 py-2 flex items-center justify-between gap-2 bg-muted/20">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Connection dot */}
          <span className={cn(
            'relative flex size-2 shrink-0',
            connected ? 'text-emerald-500' : reconnecting ? 'text-amber-500' : 'text-red-500'
          )}>
            {connected && isRunning && <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-50" />}
            <span className={cn(
              'relative rounded-full size-2',
              connected && (isRunning || isStopping) ? (isStopping ? 'bg-amber-500' : 'bg-emerald-500') :
              connected && isStopped ? 'bg-amber-500' :
              connected ? 'bg-emerald-500' :
              reconnecting ? 'bg-amber-500' : 'bg-red-500'
            )} />
          </span>
          {/* Status text — mutually exclusive conditions */}
          <span className="text-xs font-medium text-foreground">
            {!connected && reconnecting && t('runtime.autoReconnect')}
            {!connected && !reconnecting && t('runtime.disconnectedCompact')}
            {connected && isDeploying && t('runtime.deploying')}
            {connected && !isDeploying && isDeployCompleting && t('runtime.stageRunning')}
            {connected && !isDeploying && !isDeployCompleting && isStopping && t('runtime.stopping')}
            {connected && !isDeploying && !isDeployCompleting && !isStopping && isRunning && t('runtime.connectedCompact')}
            {connected && !isDeploying && !isDeployCompleting && !isStopping && !isRunning && isStopped && t('runtime.stopped')}
            {connected && !isDeploying && !isDeployCompleting && !isStopping && !isRunning && isError && t('runtime.error')}
          </span>
          {/* PID / Uptime when running */}
          {isRunning && (
            <span className="text-[11px] text-muted-foreground font-mono hidden sm:inline">
              {status?.pid && `${t('runtime.pidLabel')}: ${status.pid}`}
              {status?.pid && uptimeDisplay && ' · '}
              {uptimeDisplay && <>{t('runtime.uptimeLabel')}: {uptimeDisplay}</>}
            </span>
          )}
          {/* Deploy progress mini indicator */}
          {(isDeploying || isDeployCompleting) && progress && (
            <span className={cn(
              'text-[11px] font-mono',
              isDeployCompleting ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-muted-foreground',
            )}>
              {isDeployCompleting ? '✓ ' : ''}{progress.progress}%
            </span>
          )}
          {/* Needs restart warning */}
          {connected && bot?.status === 'inactive' && bot?.lastRunnerStatus === 'stopped' && (
            <Badge variant="outline" className="text-[10px] h-5 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20">
              <AlertTriangle className="size-2.5 mr-1" />
              {t('runtime.wasRunning')}
            </Badge>
          )}
          {/* Pending redeploy indicator — code changed since last deploy */}
          {isRunning && hasPendingRedeploy && (
            <Badge variant="outline" className="text-[10px] h-5 bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-400 border-teal-200 dark:border-teal-500/20">
              <AlertTriangle className="size-2.5 mr-1" />
              {t('runtime.pendingRedeploy')}
            </Badge>
          )}
          {/* Error message compact */}
          {isError && status?.error && (
            <span className="text-[11px] text-red-600 dark:text-red-400 font-mono truncate max-w-[200px]" title={status.error}>
              {status.error}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Action buttons */}
          {!connected && (
            <Button
              size="sm"
              onClick={handleStartService}
              disabled={isStartingService}
              className="text-[11px] h-7 gap-1 px-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 text-white"
            >
              {isStartingService ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              <span className="hidden sm:inline">{t('runtime.startServiceNow')}</span>
            </Button>
          )}
          {connected && (isStopped || isError) && (
            <Button
              size="sm"
              className={cn("text-[11px] h-7 gap-1 px-2.5 text-white", showStarting ? 'bg-blue-500' : 'bg-emerald-600 hover:bg-emerald-700')}
              onClick={handleDeployAndStart}
              disabled={!hasValidToken || showStarting}
            >
              {showStarting ? <Loader2 className="size-3 animate-spin" /> : <Rocket className="size-3" />}
              {showStarting ? t('runtime.starting') : t('runtime.deployAndStartShort')}
            </Button>
          )}
          {connected && (isRunning || isStopping) && (
            <Button
              size="sm"
              variant="outline"
              className={cn("text-[11px] h-7 gap-1 px-2.5", showStopping ? 'text-amber-600 border-amber-200' : 'text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-500/20 dark:hover:bg-red-500/5')}
              onClick={handleStop}
              disabled={showStopping}
            >
              {showStopping ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-2.5" />}
              {showStopping ? t('runtime.stopping') : t('runtime.stopShort')}
            </Button>
          )}
          {connected && isRunning && (
            <Button
              size="sm"
              variant="outline"
              className="text-[11px] h-7 gap-1 px-2.5"
              onClick={() => { restartBot(botId); toast.success(t('runtime.restarting')) }}
            >
              <RotateCcw className="size-3" />
              {t('runtime.restartShort')}
            </Button>
          )}
          {/* Expand/Collapse toggle */}
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-label={isExpanded ? t('runtime.collapse') : t('runtime.expand')}
          >
            {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </Button>
        </div>
      </div>

      {/* ── Deploy Progress Bar (visible during deploy even when collapsed) ── */}
      <AnimatePresence>
        {showProgressBar && progress && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 6 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="bg-muted/60 overflow-hidden"
          >
            <div className="relative h-full w-full">
              <motion.div
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full',
                  isDeployError
                    ? 'bg-gradient-to-r from-red-500 to-rose-500'
                    : isDeployCompleting
                      ? 'bg-gradient-to-r from-cyan-500 to-blue-400'
                      : 'bg-gradient-to-r from-blue-500 to-cyan-500',
                )}
                initial={{ width: 0 }}
                animate={{ width: `${progress.progress}%` }}
                transition={{ duration: 0.6, ease: [0.04, 0.62, 0.23, 0.98] }}
              />
              {/* Shimmer effect during active deploy */}
              {!isDeployCompleting && !isDeployError && (
                <motion.div
                  className="absolute inset-y-0 right-0 w-1/3 bg-gradient-to-r from-transparent to-white/20 rounded-full"
                  animate={{ x: ['-100%', '300%'] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Expanded Content ──────────────────────────────────────── */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.04, 0.62, 0.23, 0.98] }}
            className="overflow-hidden"
          >
            <CardContent className="px-4 pb-4 pt-3 space-y-3">
              {/* Reconnecting Panel */}
              {!connected && reconnecting && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
                    <RefreshCw className="size-3.5 shrink-0 animate-spin" />
                    <span className="font-medium">{t('runtime.autoReconnect')}</span>
                    <span className="text-amber-600/80 dark:text-amber-400/80">
                      {t('runtime.reconnectAttempt', { n: reconnectAttempt })}
                    </span>
                  </div>
                </div>
              )}

              {/* Disconnected Panel */}
              {!connected && !reconnecting && (
                <div className="rounded-lg border border-red-200 bg-red-50/60 dark:border-red-500/20 dark:bg-red-500/5 p-3">
                  <div className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400">
                    <WifiOff className="size-3.5 shrink-0" />
                    <span className="font-medium">{t('runtime.serviceNotConnected')}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1.5 pl-5.5">
                    {t('runtime.reconnectHint')}
                  </div>
                </div>
              )}

              {/* Needs restart detail */}
              {connected && bot?.status === 'inactive' && bot?.lastRunnerStatus === 'stopped' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5 p-3">
                  <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                    <div>
                      <span className="font-medium">{t('runtime.wasRunning')}</span>
                      <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70 mt-0.5">
                        {t('runtime.wasRunningDesc')}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Pending redeploy detail — code changed since last deploy */}
              {isRunning && hasPendingRedeploy && (
                <div className="rounded-lg border border-teal-200 bg-teal-50/60 dark:border-teal-500/20 dark:bg-teal-500/5 p-3">
                  <div className="flex items-start gap-2 text-xs text-teal-700 dark:text-teal-400">
                    <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                    <div>
                      <span className="font-medium">{t('runtime.pendingRedeploy')}</span>
                      <p className="text-[11px] text-teal-600/80 dark:text-teal-400/70 mt-0.5">
                        {t('runtime.pendingRedeployDesc')}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Token Status */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">{t('runtime.botTokenLabel')}:</span>
                {renderTokenBadge(serverTokenStatus, botToken, t)}
                <span className="text-[10px] text-muted-foreground/60 font-mono">
                  {bot?.tokenPreview || (botToken ? `${botToken.slice(0, 6)}...${botToken.slice(-4)}` : '') || '—'}
                </span>
              </div>

              {/* Error Display */}
              {isError && status?.error && (
                <div className="rounded-lg border border-red-200 bg-red-50/50 dark:border-red-500/20 dark:bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400 font-mono break-all">
                  {status.error}
                </div>
              )}

              {/* Deploy Progress Detail */}
              {showProgressBar && progress && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className={cn(
                      'flex items-center gap-1.5',
                      isDeployCompleting && 'text-emerald-600 dark:text-emerald-400',
                      isDeployError && 'text-red-600 dark:text-red-400',
                      !isDeployCompleting && !isDeployError && 'text-muted-foreground',
                    )}>
                      {isDeployCompleting && <span className="text-emerald-500">✅</span>}
                      {isDeployError && <span className="text-red-500">❌</span>}
                      {progress.stage === 'codeGen' && t('runtime.stageCodeGen')}
                      {progress.stage === 'installDeps' && t('runtime.stageInstallDeps')}
                      {progress.stage === 'build' && t('runtime.stageBuild')}
                      {progress.stage === 'start' && t('runtime.stageStart')}
                      {progress.stage === 'running' && t('runtime.stageRunning')}
                      {progress.stage === 'error' && t('runtime.stageError')}
                    </span>
                    <span className={cn(
                      'font-mono',
                      isDeployCompleting && 'text-emerald-600 dark:text-emerald-400 font-medium',
                      isDeployError && 'text-red-600 dark:text-red-400',
                      !isDeployCompleting && !isDeployError && 'text-muted-foreground',
                    )}>{progress.progress}%</span>
                  </div>
                  {progress.logs && progress.logs.length > 0 && (
                    <div
                      ref={(el) => { if (el) el.scrollTop = el.scrollHeight }}
                      className="rounded-lg bg-zinc-950 dark:bg-zinc-900 p-2.5 max-h-40 overflow-y-auto scrollbar-thin"
                    >
                      <div className="space-y-0.5 font-mono text-[11px] leading-relaxed">
                        {progress.logs.slice(-30).map((log, i) => (
                          <div key={i} className={cn(
                            'break-all',
                            log.includes('❌') || log.includes('ERR') || log.includes('error') ? 'text-red-400' :
                            log.includes('✅') || log.includes('added') ? 'text-emerald-400' :
                            log.includes('⚠️') || log.includes('WARN') ? 'text-amber-400' :
                            'text-zinc-400',
                          )}>{log}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Runtime Info Grid */}
              {status && (isRunning || isStopped) && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="rounded-md bg-muted/30 p-2">
                    <div className="text-muted-foreground">{t('runtime.status')}</div>
                    <div className="font-medium mt-0.5">
                      {status.status === 'running' ? t('runtime.runningIndicator') : status.status === 'error' ? t('runtime.errorIndicator') : t('runtime.stoppedIndicator')}
                    </div>
                  </div>
                  <div className="rounded-md bg-muted/30 p-2">
                    <div className="text-muted-foreground">{t('runtime.language')}</div>
                    <div className="font-medium mt-0.5">{status.language || 'N/A'}</div>
                  </div>
                  {status.startedAt && (
                    <div className="rounded-md bg-muted/30 p-2">
                      <div className="text-muted-foreground">{t('runtime.startedAt')}</div>
                      <div className="font-medium mt-0.5">{new Date(status.startedAt).toLocaleTimeString()}</div>
                    </div>
                  )}
                  {status.pid && (
                    <div className="rounded-md bg-muted/30 p-2">
                      <div className="text-muted-foreground">PID</div>
                      <div className="font-mono font-medium mt-0.5">{status.pid}</div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderTokenBadge(serverTokenStatus: string | undefined, botToken: string, t: (key: any) => string) {
  if (serverTokenStatus === 'valid') {
    return <Badge variant="outline" className="text-[10px] h-5 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20">{t('runtime.tokenValid')}</Badge>
  }
  if (serverTokenStatus === 'invalid') {
    return <Badge variant="outline" className="text-[10px] h-5 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20">{t('runtime.tokenInvalid')}</Badge>
  }
  if (serverTokenStatus === 'not_set') {
    return <Badge variant="outline" className="text-[10px] h-5 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20">{t('runtime.tokenNotVerified')}</Badge>
  }
  if (isValidBotToken(botToken)) {
    return <Badge variant="outline" className="text-[10px] h-5 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20">{t('runtime.tokenValid')}</Badge>
  }
  if (botToken) {
    return <Badge variant="outline" className="text-[10px] h-5 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20">{t('runtime.tokenInvalid')}</Badge>
  }
  return <Badge variant="outline" className="text-[10px] h-5 bg-zinc-50 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700">{t('runtime.tokenNotSet')}</Badge>
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function UptimeDisplay({ startedAt }: { startedAt: string }) {
  const [display, setDisplay] = useState(() => formatUptime(Date.now() - new Date(startedAt).getTime()))
  const rafRef = useRef<number>(0)
  const lastUpdateRef = useRef(0)

  useEffect(() => {
    const startMs = new Date(startedAt).getTime()
    const tick = (now: number) => {
      if (now - lastUpdateRef.current >= 1000) {
        lastUpdateRef.current = now
        setDisplay(formatUptime(Date.now() - startMs))
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [startedAt])

  return <>{display}</>
}
