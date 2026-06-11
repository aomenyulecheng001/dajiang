import { ChildProcess } from 'child_process'

export interface BotProcess {
  id: string
  name: string
  language: 'javascript' | 'typescript' | 'python'
  status: 'stopped' | 'starting' | 'running' | 'error' | 'stopping'
  pid?: number
  process?: ChildProcess
  startedAt?: string
  stoppedAt?: string
  exitCode?: number | null
  error?: string
  envVars: Record<string, string>
  logBuffer: string[]
  maxLogLines: number
  port?: number
  webhookUrl?: string
  entryPoint?: string
  // Resource monitoring (PM2-style)
  cpuUsage: number       // percentage 0-100
  memoryUsage: number    // bytes
  restartCount: number
  lastRestartAt?: string
  maxRestarts: number    // max auto-restart attempts per hour
  maxMemoryMb: number    // max memory before auto-restart (default 256MB)
  _stdinErrorHandler?: boolean  // P2-BR-12 FIX: Track if stdin error handler is attached
  _wasRunning?: boolean  // P1-19 FIX: Track if bot was running before shutdown for auto-restart
  _spawnError?: boolean  // FIX: Track permanent spawn errors (ENOENT, EACCES) to prevent auto-restart loop
  _memoryRestartTimestamps?: number[]  // FIX (M1): Sliding window timestamps for memory watchdog restarts
}

export interface BotTemplate {
  id: string
  name: string
  language: 'javascript' | 'typescript' | 'python'
  description: string
  emoji: string
  generateCode: (config: BotConfig) => { files: { path: string; content: string }[]; dependencies: string[] }
}

export interface BotConfig {
  name: string
  emoji?: string
  botToken: string
  language: 'javascript' | 'typescript' | 'python'
  templateId: string
  envVars?: Record<string, string>
  customCode?: string
  dependencies?: string[]
  projectFiles?: { path: string; content: string }[]
  entryPoint?: string
}

export type DeployStage = 'idle' | 'codeGen' | 'installDeps' | 'build' | 'start' | 'running' | 'error'

export interface DepsDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

export interface SavedBotConfig {
  envVars: Record<string, string>
  name: string
  language: string
  projectFiles?: { path: string; content: string }[]
  customCode?: string
  dependencies?: string[]
  entryPoint?: string
  webhookSecret?: string
}

export type InstallResult =
  | { status: 'skipped' }
  | { status: 'incremental'; addedCount: number; removedCount: number }
  | { status: 'full' }
