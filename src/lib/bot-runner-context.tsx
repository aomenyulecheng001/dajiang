'use client'

import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react'
import type { Socket } from 'socket.io-client'
import { useBotStore } from '@/store/bot-store'
import { authFetch } from '@/store/bot-store'
import { useAuthStore } from '@/store/auth-store'
import { useI18nStore, getTranslation } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n'
import { logger } from '@/lib/logger'

// ─── Types ───────────────────────────────────────────────────────────────

export interface BotRunnerStatus {
  id: string
  name: string
  language: string
  status: 'stopped' | 'starting' | 'running' | 'error' | 'stopping'
  pid?: number
  port?: number
  startedAt?: string
  stoppedAt?: string
  exitCode?: number | null
  error?: string
  lastError?: string
  envVarKeys?: string[]
}

export interface ResourceData {
  cpuUsage: number
  memoryUsage: number
  memoryUsageMb: number
  status: string
  pid?: number
  restartCount: number
  uptime?: number
  port?: number
}

export interface DeployProgress {
  botId: string
  stage: 'idle' | 'codeGen' | 'installDeps' | 'build' | 'start' | 'running' | 'error'
  progress: number
  error?: string
  logs: string[]
}

export interface BotMessageEvent {
  botId: string
  userId: string
  userName: string
  text: string
  command?: string
}

// Socket event log entry (lighter than DB BotLogEntry in @/types/bot)
// DB version has: id, botId, timestamp, level, message, source
export interface SocketBotLogEntry {
  botId: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'critical'
  message: string
}

export interface DeployConfig {
  botId: string
  config: {
    name: string
    botToken: string
    language: 'javascript' | 'typescript' | 'python'
    templateId: string
    envVars?: Record<string, string>
    customCode?: string
    dependencies?: string[]
    projectFiles?: { path: string; content: string }[]
    entryPoint?: string
  }
}

// ─── Context ─────────────────────────────────────────────────────────────

interface BotRunnerConnectionContextType {
  connected: boolean
  reconnecting: boolean
  reconnectAttempt: number
  connectionError: string | null
  reconnect: () => void
}

interface BotRunnerDataContextType {
  botStatuses: Map<string, BotRunnerStatus>
  deployProgresses: Map<string, DeployProgress>
  botLogs: Map<string, SocketBotLogEntry[]>
  resourceData: Map<string, ResourceData>
  deployBot: (_config: DeployConfig) => boolean
  stopBot: (_botId: string) => void
  startBot: (_botId: string) => void
  restartBot: (_botId: string) => void
  deleteBot: (_botId: string) => void
  requestLogs: (_botId: string) => void
  getBotStatus: (_botId: string) => BotRunnerStatus | undefined
  getDeployProgress: (_botId: string) => DeployProgress | undefined
  getBotLogs: (_botId: string) => SocketBotLogEntry[]
  getResourceData: (_botId: string) => ResourceData | undefined
  subscribe: (_event: string, _callback: (..._args: unknown[]) => void) => () => void
}

interface BotRunnerActionsContextType {
  deployBot: (_config: DeployConfig) => boolean
  stopBot: (_botId: string) => void
  startBot: (_botId: string) => void
  restartBot: (_botId: string) => void
  deleteBot: (_botId: string) => void
  requestLogs: (_botId: string) => void
  getBotStatus: (_botId: string) => BotRunnerStatus | undefined
  getDeployProgress: (_botId: string) => DeployProgress | undefined
  getBotLogs: (_botId: string) => SocketBotLogEntry[]
  getResourceData: (_botId: string) => ResourceData | undefined
  subscribe: (_event: string, _callback: (..._args: unknown[]) => void) => () => void
}

interface BotRunnerContextType extends BotRunnerConnectionContextType, BotRunnerDataContextType {}

// PERF NOTE: 7 Contexts are created here, but the combinedValue useMemo depends on
// dataValue which depends on all Map states. This means any Map change invalidates
// combinedValue, making the split less effective than intended. To fully benefit,
// each Map Context should have its own Provider with independent state updates,
// and consumers should use the specific Context they need (e.g., useBotStatuses)
// rather than the combined useBotRunner() hook.
const BotRunnerConnectionContext = createContext<BotRunnerConnectionContextType | null>(null)
const BotRunnerActionsContext = createContext<BotRunnerActionsContextType | null>(null)
const BotRunnerDataContext = createContext<BotRunnerDataContextType | null>(null)
const BotRunnerContext = createContext<BotRunnerContextType | null>(null)
const BotStatusesContext = createContext<Map<string, BotRunnerStatus>>(new Map())
const ResourceDataContext = createContext<Map<string, ResourceData>>(new Map())
const DeployProgressContext = createContext<Map<string, DeployProgress>>(new Map())
const BotLogsContext = createContext<Map<string, SocketBotLogEntry[]>>(new Map())

// ─── Provider ────────────────────────────────────────────────────────────

const BOT_RUNNER_URL = (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__RUNNER_URL__)
  ? String((window as unknown as Record<string, unknown>).__RUNNER_URL__)
  : (typeof window !== 'undefined' 
    ? window.location.origin
    : `http://localhost:3100`)

if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__DEBUG_BOT_RUNNER__) {
  logger.debug('bot-runner', `BOT_RUNNER_URL = ${BOT_RUNNER_URL} | window.location.origin = ${window.location.origin} | __RUNNER_URL__ = ${(window as unknown as Record<string, unknown>).__RUNNER_URL__}`)
}

// Maximum time (ms) to wait for a 'stopped' event after receiving 'stopping'.
// If exceeded, we assume the bot has stopped (the server's 10s stop timeout
// should have fired). This prevents the UI from showing a spinning "stopping"
// state forever if the socket disconnects during the stop sequence.
const STOPPING_STATE_TIMEOUT_MS = 15_000

// TODO: Refactor this 1000+ line provider into smaller hooks:
// - useSocketConnection: Socket.IO connect/reconnect/disconnect logic
// - useLogBatching: Log dedup, batching, and persistence
// - useMessageBatching: Message batching and persistence
// - useDeployProgress: Deploy progress tracking and stale cleanup
// - useResourceMonitoring: Resource data updates
// This will improve testability and reduce cognitive load.
export function BotRunnerProvider({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [botStatuses, setBotStatuses] = useState<Map<string, BotRunnerStatus>>(new Map())
  const [deployProgresses, setDeployProgresses] = useState<Map<string, DeployProgress>>(new Map())
  const [botLogs, setBotLogs] = useState<Map<string, SocketBotLogEntry[]>>(new Map())
  const [resourceData, setResourceData] = useState<Map<string, ResourceData>>(new Map())
  const listenersRef = useRef<Map<string, Set<(..._args: unknown[]) => void>>>(new Map())
  const cancelledRef = useRef(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectFnRef = useRef<() => void>(() => {})
  const deployClearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // BUG FIX: Move timer refs to component level so they can be cleaned up
  // on reconnection and unmount. Previously these were local to initSocket closure,
  // causing memory leaks and duplicate API calls on reconnection.
  const logPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const LOG_BATCH_MAX_SIZE = 100
  const MAX_BOTS_WITH_LOGS = 50
  const logPersistBatchRef = useRef<{ botId: string; level: string; message: string }[]>([])
  const statsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingStatsBotIdsRef = useRef<Set<string>>(new Set())
  // BUG FIX: Track timers for auto-clearing stale 'stopping' states.
  // If the server emits 'stopping' but we never receive 'stopped' (e.g., socket
  // disconnects), the UI would show a spinning "stopping" indicator forever.
  // This timer auto-resolves 'stopping' to 'stopped' after STOPPING_STATE_TIMEOUT_MS.
  const stoppingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const logSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recentLogKeysRef = useRef<Set<string>>(new Set())
  // FIX: Track deleted bot IDs to ignore late-arriving bot:log events
  const deletedBotIdsRef = useRef<Set<string>>(new Set())
  const messageBatchRef = useRef<Array<{ botId: string; userId: string; userName: string; text: string; command?: string }>>([])
  const messageBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const MESSAGE_BATCH_MAX = 50
  const flushLogBatchRef = useRef<() => void>(() => {})
  const flushMessageBatchRef = useRef<() => void>(() => {})

  // Subscribe to custom events
  const subscribe = useCallback((event: string, callback: (..._args: unknown[]) => void) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set())
    }
    listenersRef.current.get(event)!.add(callback as (..._args: unknown[]) => void)
    return () => {
      listenersRef.current.get(event)?.delete(callback)
    }
  }, [])

  // Cache the runner token to avoid re-fetching on every Socket.IO reconnection.
  // The runner secret doesn't change unless the bot-runner service restarts,
  // so we can safely reuse the cached token.
  const cachedTokenRef = useRef<string | null>(null)

  // Helper: clear a stopping timer for a bot
  const clearStoppingTimer = useCallback((botId: string) => {
    const timer = stoppingTimersRef.current.get(botId)
    if (timer) {
      clearTimeout(timer)
      stoppingTimersRef.current.delete(botId)
    }
  }, [])

  // Task 7+8: Extracted initSocket into a reusable reconnect function.
  // This ref-based approach lets us call reconnect() from outside the effect
  // (e.g. when auth state changes after login) and also avoids stale closures.
  useEffect(() => {
    let retryCount = 0
    const MAX_RETRIES = 20

    const initSocket = async () => {
      try {
        let token = cachedTokenRef.current

        if (!token) {
          const res = await authFetch('/api/auth/runner-token')
          if (!res.ok) {
            // Don't retry on auth failures (401) — wait for auth state change
            if (res.status === 401) return
            if (res.status === 429) {
              const data = await res.json().catch(() => ({ retryAfter: 15 }))
              const waitMs = (data.retryAfter || 15) * 1000
              logger.warn('bot-runner', `Rate limited, waiting ${waitMs / 1000}s before retry`)
              retryCount++
              if (retryCount >= MAX_RETRIES) {
                setConnectionError('Unable to connect to bot runner service. Please check if the service is running.')
                return
              }
              retryTimerRef.current = setTimeout(initSocket, waitMs)
              return
            }
            retryCount++
            if (retryCount >= MAX_RETRIES) {
              setConnectionError('Unable to connect to bot runner service. Please check if the service is running.')
              return
            }
            const delay = Math.min(3000 * Math.pow(1.5, Math.floor(retryCount / 3)), 30000)
            retryTimerRef.current = setTimeout(initSocket, delay)
            return
          }
          const data = await res.json()
          token = data.token

          // Cache the token for future reconnections
          if (token) {
            cachedTokenRef.current = token
          }
        }

        if (cancelledRef.current) return

        // Disconnect existing socket before creating a new one
        if (socketRef.current) {
          socketRef.current.disconnect()
          socketRef.current = null
        }

        const { io } = await import('socket.io-client')

        const socket = io(BOT_RUNNER_URL, {
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 2000,
          reconnectionDelayMax: 30000,
          timeout: 15000, // Connection timeout — match server's connectTimeout
          auth: { token },
        })

        socket.on('connect', () => {
          setConnected(true)
          setReconnecting(false)
          setReconnectAttempt(0)
          setConnectionError(null)
          retryCount = 0
        })

        // Task 9 FIX: On disconnect, only set connected=false — do NOT reset bot statuses.
        // The DB-persisted status (from syncRunnerStatus) is more accurate than
        // resetting everything to "stopped". When the runner reconnects, the `init`
        // event will provide the real current status from the runner.
        socket.on('disconnect', (reason) => {
          setConnected(false)
          // If server explicitly disconnected us (e.g. auth error), invalidate cached token
          if (reason === 'io server disconnect') {
            cachedTokenRef.current = null
          }
        })

        // Task 7: Track reconnection attempts for UI display
        socket.on('reconnect_attempt', (attemptNumber: number) => {
          setReconnecting(true)
          setReconnectAttempt(attemptNumber)
        })

        // Task 7: Safety net — if Socket.IO ever gives up reconnection
        // (shouldn't happen with Infinity, but handle just in case),
        // re-initialize the entire socket after 30 seconds.
        // Also invalidate cached token so we re-fetch on next attempt.
        socket.on('reconnect_failed', () => {
          logger.warn('bot-runner', 'Socket.IO reconnection failed — re-initializing in 30s')
          cachedTokenRef.current = null
          setReconnecting(false)
          socket.disconnect()
          if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current)
          }
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null
            if (!cancelledRef.current) {
              initSocket()
            }
          }, 30000)
        })

        socket.on('connect_error', (err) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('token') || msg.includes('auth') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('401') || msg.includes('403')) {
            logger.warn('bot-runner', 'Auth error on connect, refreshing token')
            cachedTokenRef.current = null
            socket.disconnect()
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null
              if (!cancelledRef.current) initSocket()
            }, 2000)
          }
        })

        socket.on('init', (data: { bots: BotRunnerStatus[] }) => {
          // FIX: Clear deleted bot IDs on reconnection since the server state is fresh
          deletedBotIdsRef.current.clear()
          const map = new Map<string, BotRunnerStatus>()
          data.bots.forEach(b => map.set(b.id, b))
          setBotStatuses(map)

          // FIX: Clear deploy progress for bots that are already in a terminal or active state.
          // The init event includes current bot statuses, not deploy progress.
          // Any remaining entries in deployProgresses are stale from before reconnection.
          setDeployProgresses(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            // Remove entries for bots that are confirmed running/stopping/stopped/error in init
            // (stopping is included because a stopping bot is past the deploy phase)
            for (const b of data.bots) {
              if (b.status === 'running' || b.status === 'stopping' || b.status === 'stopped' || b.status === 'error') {
                next.delete(b.id)
              }
            }
            return next.size === prev.size ? prev : next
          })

          // Clear any stale stopping timers for bots that are no longer in 'stopping' state
          for (const b of data.bots) {
            if (b.status !== 'stopping') {
              clearStoppingTimer(b.id)
            }
          }

          const { syncRunnerStatus, bots } = useBotStore.getState()
          data.bots.forEach(b => syncRunnerStatus(b.id, b.status))
          const runnerBotIds = new Set(data.bots.map(b => b.id))
          bots.forEach(b => {
            if (b.status === 'active' && !runnerBotIds.has(b.id)) {
              syncRunnerStatus(b.id, 'stopped')
            }
          })

          const currentBotIds = new Set(bots.map(b => b.id))
          if (logSyncTimerRef.current) {
            clearTimeout(logSyncTimerRef.current)
            logSyncTimerRef.current = null
          }
          let logsPruned = false
          for (const id of [...botLogsRef.current.keys()]) {
            if (!currentBotIds.has(id)) {
              botLogsRef.current.delete(id)
              logsPruned = true
            }
          }
          if (logsPruned) {
            setBotLogs(new Map(botLogsRef.current))
          }
        })

        socket.on('bot:status', (data: { botId: string; status: string; pid?: number; error?: string; exitCode?: number }) => {
          setBotStatuses(prev => {
            const next = new Map(prev)
            const existing = next.get(data.botId)
            // BUG FIX: Ignore stale 'stopping' events that arrive AFTER 'stopped'.
            // This can happen if the process exits very quickly and the 'stopped' event
            // from handleBotExit arrives before the 'stopping' event from stopBotProcess
            // (due to network ordering). Without this, the UI would briefly show
            // 'stopping' after already showing 'stopped', causing a visual glitch.
            if (data.status === 'stopping' && existing?.status === 'stopped') {
              return prev // Ignore stale 'stopping' — bot is already stopped
            }
            next.set(data.botId, {
              id: data.botId,
              name: existing?.name ?? '',
              language: existing?.language ?? '',
              status: data.status as BotRunnerStatus['status'],
              pid: data.status === 'stopping' ? existing?.pid : (data.pid ?? existing?.pid),
              startedAt: existing?.startedAt,
              stoppedAt: data.status === 'stopped' ? new Date().toISOString() : existing?.stoppedAt,
              exitCode: data.exitCode ?? existing?.exitCode,
              error: data.error ?? existing?.error,
              envVarKeys: existing?.envVarKeys,
            })
            return next
          })
          useBotStore.getState().syncRunnerStatus(data.botId, data.status as 'stopped' | 'starting' | 'running' | 'error' | 'stopping')

          // ── BUG FIX: Auto-clear stale 'stopping' state ──────────────────
          // When we receive a 'stopping' status, start a safety timer. If we
          // don't receive 'stopped' within STOPPING_STATE_TIMEOUT_MS, assume
          // the bot has stopped (the server's 10s stop timeout should have fired).
          // This prevents the UI from showing a spinning "stopping" indicator
          // forever if the socket disconnects during the stop sequence.
          if (data.status === 'stopping') {
            // Clear any existing timer for this bot
            clearStoppingTimer(data.botId)
            // Set a new timer
            const timer = setTimeout(() => {
              stoppingTimersRef.current.delete(data.botId)
              setBotStatuses(prev => {
                const current = prev.get(data.botId)
                if (current?.status === 'stopping') {
                  const next = new Map(prev)
                  next.set(data.botId, { ...current, status: 'stopped', stoppedAt: new Date().toISOString() })
                  return next
                }
                return prev
              })
              // Also sync to bot store
              useBotStore.getState().syncRunnerStatus(data.botId, 'stopped')
            }, STOPPING_STATE_TIMEOUT_MS)
            stoppingTimersRef.current.set(data.botId, timer)
          }

          // Clear the stopping timer when we receive a definitive status
          if (data.status === 'stopped' || data.status === 'running' || data.status === 'error' || data.status === 'starting') {
            clearStoppingTimer(data.botId)
          }

          // FIX: Clear stale deploy progress when bot reaches a terminal state.
          // If the client missed the final deploy:progress event (e.g., socket disconnect),
          // the deployProgresses Map retains stale data causing the UI to show "deploying"
          // even when the bot is running/stopped/error.
          // For 'running' status, delay clearing so the progress bar can animate to 100%
          // before being removed. The deploy function sends 'running: 100%' progress after
          // confirming the bot is running, but bot:status may arrive before that event.
          if (data.status === 'running') {
            // Delay clearing so the progress bar can animate to 100%
            // before being removed. Track the timer so it can be cancelled.
            const timer = setTimeout(() => {
              deployClearTimersRef.current.delete(data.botId)
              setDeployProgresses(prev => {
                if (!prev.has(data.botId)) return prev
                const next = new Map(prev)
                next.delete(data.botId)
                return next
              })
            }, 2000)
            // Clear any existing timer for this bot before setting a new one
            const existingTimer = deployClearTimersRef.current.get(data.botId)
            if (existingTimer) clearTimeout(existingTimer)
            deployClearTimersRef.current.set(data.botId, timer)
          } else if (data.status === 'stopped' || data.status === 'error' || data.status === 'stopping') {
            // Also clear deploy progress on 'stopping' — the bot is past the deploy phase
            setDeployProgresses(prev => {
              if (!prev.has(data.botId)) return prev // no-op if not present
              const next = new Map(prev)
              next.delete(data.botId)
              return next
            })
          }

          listenersRef.current.get('bot:status')?.forEach(cb => cb(data as unknown))
        })

        // Throttle runner log persistence to avoid flooding the API.
        // Batch logs and persist every 2 seconds.
        // BUG FIX: Clear old timers from previous connection before setting up new ones
        if (logPersistTimerRef.current) {
          clearTimeout(logPersistTimerRef.current)
          logPersistTimerRef.current = null
        }
        // FIX: Flush any accumulated log batch before clearing it.
        // Previously, logs accumulated during the old connection were silently discarded.
        if (logPersistBatchRef.current.length > 0 && flushLogBatchRef.current) {
          flushLogBatchRef.current()
        }
        logPersistBatchRef.current = []

        function flushLogBatch() {
          if (logPersistBatchRef.current.length === 0) return
          const batch = [...logPersistBatchRef.current]
          logPersistBatchRef.current = []
          logPersistTimerRef.current = null

          try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' }

            // PERF FIX: Group logs by botId and use batch endpoint.
            // Previously: N entries → N individual POST /api/bots/{id}/logs (N HTTP requests)
            // Now: N entries → group by botId → 1 POST per botId /api/bots/{id}/logs/batch
            // Typical reduction: 40-100 HTTP requests → 1-3 batch requests
            const byBotId = new Map<string, Array<{ level: string; message: string }>>()
            for (const log of batch) {
              const list = byBotId.get(log.botId) || []
              list.push({ level: log.level, message: log.message })
              byBotId.set(log.botId, list)
            }

            for (const [botId, logs] of byBotId) {
              authFetch(`/api/bots/${botId}/logs/batch`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ logs }),
              }).catch(() => {})
            }
          } catch {
            // Ignore
          }
        }
        flushLogBatchRef.current = flushLogBatch

        socket.on('bot:log', (data: SocketBotLogEntry) => {
          // FIX: Skip logs for deleted bots to prevent recreating state and 404 errors
          if (deletedBotIdsRef.current.has(data.botId)) return
          const dedupKey = `${data.botId}:${data.timestamp}:${data.message}`
          if (recentLogKeysRef.current.has(dedupKey)) return
          recentLogKeysRef.current.add(dedupKey)
          if (recentLogKeysRef.current.size > 2000) {
            const entries = [...recentLogKeysRef.current]
            recentLogKeysRef.current = new Set(entries.slice(-1000))
          }

          const arr = botLogsRef.current.get(data.botId) || []
          if (arr.length >= 200) arr.shift()
          arr.push(data)
          botLogsRef.current.set(data.botId, arr)

          if (botLogsRef.current.size > MAX_BOTS_WITH_LOGS) {
            const entries = [...botLogsRef.current.entries()]
              .sort((a, b) => {
                const aLast = a[1][a[1].length - 1]?.timestamp || ''
                const bLast = b[1][b[1].length - 1]?.timestamp || ''
                return aLast.localeCompare(bLast)
              })
            for (let i = 0; i < entries.length - MAX_BOTS_WITH_LOGS; i++) {
              botLogsRef.current.delete(entries[i][0])
            }
          }

          if (!logSyncTimerRef.current) {
            logSyncTimerRef.current = setTimeout(() => {
              logSyncTimerRef.current = null
              setBotLogs(new Map(botLogsRef.current))
            }, 500)
          }

          logPersistBatchRef.current.push({ botId: data.botId, level: data.level, message: data.message })
          if (logPersistBatchRef.current.length >= LOG_BATCH_MAX_SIZE) {
            flushLogBatch()
          } else if (!logPersistTimerRef.current) {
            logPersistTimerRef.current = setTimeout(flushLogBatch, 2000)
          }

          listenersRef.current.get('bot:log')?.forEach(cb => cb(data as unknown))
        })

        if (statsRefreshTimerRef.current) {
          clearTimeout(statsRefreshTimerRef.current)
          statsRefreshTimerRef.current = null
        }
        pendingStatsBotIdsRef.current.clear()
        if (messageBatchTimerRef.current) {
          clearTimeout(messageBatchTimerRef.current)
          messageBatchTimerRef.current = null
        }
        messageBatchRef.current = []

        function flushMessageBatch() {
          if (messageBatchTimerRef.current) {
            clearTimeout(messageBatchTimerRef.current)
            messageBatchTimerRef.current = null
          }
          const batch = messageBatchRef.current.splice(0)
          if (batch.length === 0) return

          const byBot = new Map<string, typeof batch>()
          for (const msg of batch) {
            const arr = byBot.get(msg.botId) || []
            arr.push(msg)
            byBot.set(msg.botId, arr)
          }

          for (const [botId, msgs] of byBot) {
            authFetch(`/api/bots/${botId}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: msgs }),
            }).catch(err => {
              logger.warn('bot-runner', `Failed to persist ${msgs.length} messages for bot ${botId}`, err instanceof Error ? err.message : String(err))
            })
          }
        }
        flushMessageBatchRef.current = flushMessageBatch

        socket.on('bot:message', (data: BotMessageEvent) => {
          messageBatchRef.current.push({
            botId: data.botId,
            userId: data.userId,
            userName: data.userName,
            text: data.text,
            command: data.command,
          })

          if (messageBatchRef.current.length >= MESSAGE_BATCH_MAX) {
            flushMessageBatch()
          } else if (!messageBatchTimerRef.current) {
            messageBatchTimerRef.current = setTimeout(flushMessageBatch, 2000)
          }

          pendingStatsBotIdsRef.current.add(data.botId)
          if (!statsRefreshTimerRef.current) {
            statsRefreshTimerRef.current = setTimeout(() => {
              for (const botId of pendingStatsBotIdsRef.current) {
                useBotStore.getState().fetchBotStats(botId)
              }
              pendingStatsBotIdsRef.current.clear()
              statsRefreshTimerRef.current = null
            }, 10000)
          }

          listenersRef.current.get('bot:message')?.forEach(cb => cb(data as unknown))
        })

        socket.on('deploy:progress', (data: DeployProgress) => {
          if (data.stage === 'idle') {
            setDeployProgresses(prev => {
              if (!prev.has(data.botId)) return prev
              const next = new Map(prev)
              next.delete(data.botId)
              return next
            })
          } else {
            setDeployProgresses(prev => {
              const next = new Map(prev)
              const existing = prev.get(data.botId)
              next.set(data.botId, {
                ...data,
                logs: data.logs?.length ? data.logs : existing?.logs || [],
              })
              return next
            })
          }
          listenersRef.current.get('deploy:progress')?.forEach(cb => cb(data as unknown))
        })

        socket.on('deploy:log', (data: { botId: string; log: string }) => {
          setDeployProgresses(prev => {
            const existing = prev.get(data.botId)
            if (!existing) return prev
            const next = new Map(prev)
            next.set(data.botId, {
              ...existing,
              logs: [...existing.logs, data.log],
            })
            return next
          })
        })

        socket.on('bot:logs', (data: { botId: string; logs: string[] }) => {
          if (logSyncTimerRef.current) {
            clearTimeout(logSyncTimerRef.current)
            logSyncTimerRef.current = null
          }
          const parsed = data.logs.map(l => {
            try {
              const parsed = JSON.parse(l)
              return {
                botId: data.botId,
                timestamp: parsed.timestamp || new Date().toISOString(),
                level: parsed.level || 'info',
                message: parsed.message || l,
              }
            } catch {
              return { botId: data.botId, timestamp: new Date().toISOString(), level: 'info' as const, message: l }
            }
          })
          botLogsRef.current.set(data.botId, parsed)
          setBotLogs(new Map(botLogsRef.current))
        })

        socket.on('bot:deleted', (data: { botId: string }) => {
          // FIX: Mark bot as deleted so late-arriving bot:log events are ignored
          deletedBotIdsRef.current.add(data.botId)
          setBotStatuses(prev => { const n = new Map(prev); n.delete(data.botId); return n })
          if (logSyncTimerRef.current) {
            clearTimeout(logSyncTimerRef.current)
            logSyncTimerRef.current = null
          }
          botLogsRef.current.delete(data.botId)
          setBotLogs(new Map(botLogsRef.current))
          setDeployProgresses(prev => { const n = new Map(prev); n.delete(data.botId); return n })
          setResourceData(prev => { const n = new Map(prev); n.delete(data.botId); return n })
          clearStoppingTimer(data.botId)
        })

        socket.on('resources:update', (data: Record<string, ResourceData>) => {
          setResourceData(prev => {
            let changed = false
            const next = new Map(prev)
            for (const [botId, rd] of Object.entries(data)) {
              const existing = prev.get(botId)
              // CRITICAL: Include port in comparison so port detection updates are not
              // silently dropped. Also include pid and restartCount for completeness.
              if (!existing
                || existing.cpuUsage !== rd.cpuUsage
                || existing.memoryUsageMb !== rd.memoryUsageMb
                || existing.status !== rd.status
                || existing.uptime !== rd.uptime
                || existing.port !== rd.port
                || existing.pid !== rd.pid
                || existing.restartCount !== rd.restartCount
              ) {
                next.set(botId, rd)
                changed = true
              }
            }
            return changed ? next : prev
          })
          listenersRef.current.get('resources:update')?.forEach(cb => cb(data as unknown))
        })

        socketRef.current = socket
      } catch {
        if (retryCount === 0) {
          authFetch('/api/bots/runner/start-service', {
            method: 'POST',
          }).catch(() => {})
        }
        retryCount++
        if (!cancelledRef.current && retryCount < MAX_RETRIES) {
          const delay = Math.min(3000 * Math.pow(1.5, Math.floor(retryCount / 3)), 30000)
          retryTimerRef.current = setTimeout(initSocket, delay)
        } else if (retryCount >= MAX_RETRIES) {
          setConnectionError('Unable to connect to bot runner service. Please check if the service is running.')
        }
      }
    }

    // Store the reconnect function in a ref so it can be called externally
    reconnectFnRef.current = () => {
      if (socketRef.current) {
        socketRef.current.disconnect()
        socketRef.current = null
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      retryCount = 0
      setConnectionError(null)
      initSocket()
    }

    // P0-3 FIX: Only attempt socket connection if user is authenticated.
    // Previously, initSocket() was called on mount regardless of auth state,
    // causing unnecessary /api/auth/runner-token requests that fail with 401.
    if (isAuthenticated) {
      initSocket()
    }

    return () => {
      cancelledRef.current = true
      socketRef.current?.disconnect()
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      // BUG FIX: Clean up all timers on unmount
      if (logPersistTimerRef.current) {
        clearTimeout(logPersistTimerRef.current)
        logPersistTimerRef.current = null
      }
      if (logPersistBatchRef.current.length > 0) {
        flushLogBatchRef.current()
      }
      if (logSyncTimerRef.current) {
        clearTimeout(logSyncTimerRef.current)
        logSyncTimerRef.current = null
      }
      recentLogKeysRef.current = new Set()
      if (statsRefreshTimerRef.current) {
        clearTimeout(statsRefreshTimerRef.current)
        statsRefreshTimerRef.current = null
      }
      if (messageBatchTimerRef.current) {
        clearTimeout(messageBatchTimerRef.current)
        messageBatchTimerRef.current = null
      }
      if (messageBatchRef.current.length > 0) {
        flushMessageBatchRef.current()
      }
      deployClearTimersRef.current.forEach((timer) => clearTimeout(timer))
      deployClearTimersRef.current.clear()
      stoppingTimersRef.current.forEach((timer) => clearTimeout(timer))
      stoppingTimersRef.current.clear()
    }
  }, [clearStoppingTimer])

  // Task 8: Watch for auth state changes and trigger reconnection/disconnection.
  // With HttpOnly cookies, we can't read the token directly — instead we react
  // to isAuthenticated state changes from the auth store.
  const prevAuthRef = useRef(isAuthenticated)
  useEffect(() => {
    if (prevAuthRef.current === isAuthenticated) return
    prevAuthRef.current = isAuthenticated

    if (isAuthenticated) {
      reconnectFnRef.current()
    } else {
      cachedTokenRef.current = null
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      socketRef.current?.disconnect()
      socketRef.current = null
      setConnected(false)
      setBotStatuses(new Map())
      setDeployProgresses(new Map())
      if (logSyncTimerRef.current) {
        clearTimeout(logSyncTimerRef.current)
        logSyncTimerRef.current = null
      }
      recentLogKeysRef.current = new Set()
      botLogsRef.current = new Map()
      setBotLogs(new Map())
      if (messageBatchTimerRef.current) {
        clearTimeout(messageBatchTimerRef.current)
        messageBatchTimerRef.current = null
      }
      if (messageBatchRef.current.length > 0) {
        flushMessageBatchRef.current()
      }
      setResourceData(new Map())
      stoppingTimersRef.current.forEach((timer) => clearTimeout(timer))
      stoppingTimersRef.current.clear()
      if (statsRefreshTimerRef.current) {
        clearTimeout(statsRefreshTimerRef.current)
        statsRefreshTimerRef.current = null
      }
      pendingStatsBotIdsRef.current.clear()
      if (logPersistTimerRef.current) {
        clearTimeout(logPersistTimerRef.current)
        logPersistTimerRef.current = null
      }
      if (logPersistBatchRef.current.length > 0) {
        flushLogBatchRef.current()
      }
      deployClearTimersRef.current.forEach((timer) => clearTimeout(timer))
      deployClearTimersRef.current.clear()
    }
  }, [isAuthenticated])

  // FIX: Re-sync runner statuses after hydrateFromDB completes.
  // Race condition: Socket.IO 'init' event may fire before hydrateFromDB
  // finishes loading bots into the store. When that happens, syncRunnerStatus
  // is a no-op because the bot doesn't exist in the store yet. After
  // hydrateFromDB completes, the store has bots with stale DB status, and
  // no further correction happens. This effect re-applies the runner statuses
  // from the init event to fix the discrepancy.
  const hasHydrated = useBotStore((s) => s._hasHydrated)

  useEffect(() => {
    if (!hasHydrated) return

    const { syncRunnerStatus, bots } = useBotStore.getState()
    if (bots.length === 0) return

    const currentStatuses = botStatusesRef.current
    if (currentStatuses.size === 0) return

    currentStatuses.forEach((status, botId) => {
      const storeBot = bots.find(b => b.id === botId)
      if (storeBot) {
        syncRunnerStatus(botId, status.status)
      }
    })

    const runnerBotIds = new Set([...currentStatuses.keys()])
    bots.forEach(b => {
      if (b.status === 'active' && !runnerBotIds.has(b.id)) {
        syncRunnerStatus(b.id, 'stopped')
      }
    })
  }, [hasHydrated])

  // Public reconnect function
  const reconnect = useCallback(() => {
    reconnectFnRef.current()
  }, [])

  const deployBot = useCallback((config: DeployConfig): boolean => {
    if (!socketRef.current || !socketRef.current.connected) {
      logger.warn('bot-runner', 'Cannot deploy: socket not connected')
      import('sonner').then(({ toast }) => {
        const { locale } = useI18nStore.getState()
        const t = (key: TranslationKey) => getTranslation(locale, key)
        toast.error(t('botRunner.notConnected'))
      }).catch(() => {})
      return false
    }
    socketRef.current.emit('bot:deploy', config)
    return true
  }, [])

  const stopBot = useCallback((botId: string) => {
    if (!socketRef.current) {
      logger.warn('bot-runner', 'Cannot stop: socket not connected')
      return
    }
    socketRef.current.emit('bot:stop', { botId })
  }, [])

  const startBot = useCallback((botId: string) => {
    socketRef.current?.emit('bot:start', { botId })
  }, [])

  const restartBot = useCallback((botId: string) => {
    socketRef.current?.emit('bot:restart', { botId })
  }, [])

  const deleteBot = useCallback((botId: string) => {
    socketRef.current?.emit('bot:delete', { botId })
  }, [])

  const requestLogs = useCallback((botId: string) => {
    socketRef.current?.emit('bot:logs', { botId })
  }, [])

  const botStatusesRef = useRef(botStatuses)
  botStatusesRef.current = botStatuses
  const deployProgressesRef = useRef(deployProgresses)
  deployProgressesRef.current = deployProgresses
  const botLogsRef = useRef<Map<string, SocketBotLogEntry[]>>(new Map())
  // REACT-102: botLogsRef mirrors the botLogs state for direct mutation without
  // triggering re-renders. To maintain consistency, ALWAYS update botLogsRef.current
  // BEFORE calling setBotLogs(). This ensures that any synchronous read from the ref
  // (e.g. getBotLogs) sees the latest data before React batches the state update.
  const resourceDataRef = useRef(resourceData)
  resourceDataRef.current = resourceData

  const getBotStatus = useCallback((botId: string) => botStatusesRef.current.get(botId), [])
  const getDeployProgress = useCallback((botId: string) => deployProgressesRef.current.get(botId), [])
  const getBotLogs = useCallback((botId: string) => botLogsRef.current.get(botId) || [], [])
  const getResourceData = useCallback((botId: string) => resourceDataRef.current.get(botId), [])

  const actionsValue = useMemo<BotRunnerActionsContextType>(() => ({
    deployBot,
    stopBot,
    startBot,
    restartBot,
    deleteBot,
    requestLogs,
    getBotStatus,
    getDeployProgress,
    getBotLogs,
    getResourceData,
    subscribe,
  }), [deployBot, stopBot, startBot, restartBot, deleteBot, requestLogs,
    getBotStatus, getDeployProgress, getBotLogs, getResourceData, subscribe])

  const connectionValue = useMemo<BotRunnerConnectionContextType>(() => ({
    connected,
    reconnecting,
    reconnectAttempt,
    connectionError,
    reconnect,
  }), [connected, reconnecting, reconnectAttempt, connectionError, reconnect])

  const dataValue = useMemo<BotRunnerDataContextType>(() => ({
    botStatuses,
    deployProgresses,
    botLogs,
    resourceData,
    deployBot,
    stopBot,
    startBot,
    restartBot,
    deleteBot,
    requestLogs,
    getBotStatus,
    getDeployProgress,
    getBotLogs,
    getResourceData,
    subscribe,
  }), [botStatuses, deployProgresses, botLogs, resourceData,
    deployBot, stopBot, startBot, restartBot, deleteBot, requestLogs,
    getBotStatus, getDeployProgress, getBotLogs, getResourceData, subscribe])

  const combinedValue = useMemo<BotRunnerContextType>(() => ({
    ...connectionValue,
    ...dataValue,
  }), [connectionValue, dataValue])

  return (
    <BotRunnerActionsContext.Provider value={actionsValue}>
      <BotRunnerConnectionContext.Provider value={connectionValue}>
        <BotStatusesContext.Provider value={botStatuses}>
          <ResourceDataContext.Provider value={resourceData}>
            <DeployProgressContext.Provider value={deployProgresses}>
              <BotLogsContext.Provider value={botLogs}>
                <BotRunnerDataContext.Provider value={dataValue}>
                  <BotRunnerContext.Provider value={combinedValue}>
                    {children}
                  </BotRunnerContext.Provider>
                </BotRunnerDataContext.Provider>
              </BotLogsContext.Provider>
            </DeployProgressContext.Provider>
          </ResourceDataContext.Provider>
        </BotStatusesContext.Provider>
      </BotRunnerConnectionContext.Provider>
    </BotRunnerActionsContext.Provider>
  )
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function useBotRunner() {
  const ctx = useContext(BotRunnerContext)
  if (!ctx) throw new Error('useBotRunner must be used within BotRunnerProvider')
  return ctx
}

export function useBotRunnerConnection() {
  const ctx = useContext(BotRunnerConnectionContext)
  if (!ctx) throw new Error('useBotRunnerConnection must be used within BotRunnerProvider')
  return ctx
}

export function useBotRunnerActions() {
  const ctx = useContext(BotRunnerActionsContext)
  if (!ctx) throw new Error('useBotRunnerActions must be used within BotRunnerProvider')
  return ctx
}

export function useBotRunnerData() {
  const ctx = useContext(BotRunnerDataContext)
  if (!ctx) throw new Error('useBotRunnerData must be used within BotRunnerProvider')
  return ctx
}

export function useBotStatuses() {
  return useContext(BotStatusesContext)
}

export function useResourceData() {
  return useContext(ResourceDataContext)
}

export function useDeployProgress() {
  return useContext(DeployProgressContext)
}

export function useBotLogs() {
  return useContext(BotLogsContext)
}

/**
 * PERF OPT: Per-bot status hook that reduces unnecessary re-render cascades.
 *
 * Problem: useBotStatuses() returns the entire Map. When ANY bot's status
 * changes, the Map reference changes, causing ALL consumers to re-render.
 * For a dashboard with N bots, a status update for bot A triggers re-renders
 * in components that only care about bot B.
 *
 * Solution: This hook subscribes to the full Map context (unavoidable with
 * React Context), but returns a stable reference when the specific bot's
 * status object hasn't changed. This means:
 *   - The component still re-renders when the Map changes (React Context limitation)
 *   - But useMemo/useEffect dependencies on the returned value won't trigger
 *     if the specific bot's status reference is the same
 *   - Combined with React.memo on the component, this prevents child re-renders
 *
 * For full optimization, pair this with a container/wrapper pattern that
 * extracts per-bot data and passes it as props to a React.memo'd inner component.
 */
export function useBotStatus(botId: string): BotRunnerStatus | undefined {
  const statuses = useContext(BotStatusesContext)
  return statuses.get(botId)
}

/**
 * PERF OPT: Per-bot resource data hook. Same pattern as useBotStatus.
 * Returns the specific bot's resource data from the context Map.
 */
export function useBotResourceData(botId: string): ResourceData | undefined {
  const resources = useContext(ResourceDataContext)
  return resources.get(botId)
}
