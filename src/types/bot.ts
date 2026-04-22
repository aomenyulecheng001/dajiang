export type BotStatus = 'active' | 'inactive' | 'error' | 'deploying'

export type BotHealth = 'healthy' | 'warning' | 'critical' | 'unknown'
export type BotLanguage = 'javascript' | 'typescript' | 'python'

/** P2 OPT: Strongly-typed log level — prevents typos and invalid level strings */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical'

export interface BotStats {
  messages: number
  users: number
  uptime: number // minutes (from runner resourceData)
  errors: number
  dailyMessages: { date: string; count: number }[]
  topCommands: { command: string; count: number; percentage: number }[]
  hourlyActivity: number[]
}

export interface Dependency {
  id: string
  name: string
  version: string
  isRequired: boolean
  description?: string
}

export interface EnvVar {
  id: string
  key: string
  value: string
  isEncrypted: boolean
  description?: string
}

export interface CodeBlock {
  id: string
  name: string
  type: 'handler' | 'middleware' | 'command' | 'callback' | 'action' | 'cron'
  code: string
  language: BotLanguage | 'json'
  isActive: boolean
  lastModified: string
  description?: string
}

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  message: string
  source?: string
  details?: string
}

export interface BotConfig {
  webhookUrl?: string
  /** Secret token for Telegram webhook verification (X-Telegram-Bot-Api-Secret-Token header) */
  webhookSecret?: string
  pollingMode: 'webhook' | 'polling'
  rateLimitPerMinute: number
  maxConcurrentRequests: number
  autoRestart: boolean
  logLevel: LogLevel
  timeout: number
}

export interface ProjectFile {
  path: string       // relative path within the project
  content: string    // file content
  size: number       // file size in bytes
}

export interface Bot {
  id: string
  name: string
  description: string
  emoji: string
  customIcon?: string  // base64 data URL for custom uploaded icon (e.g. "data:image/png;base64,...")
  status: BotStatus
  health: BotHealth
  language: BotLanguage
  template: string
  version: string
  createdAt: string
  updatedAt: string
  code?: string
  codeBlocks: CodeBlock[]
  dependencies: Dependency[]
  envVars: EnvVar[]
  config: BotConfig
  stats: BotStats
  logs: LogEntry[]          // client-side in-memory log buffer (NOT persisted to DB)
  projectFiles?: ProjectFile[]   // all project files (from ZIP upload)
  entryPoint?: string            // entry file path (e.g., "index.js", "bot.py")
  lastRunnerStatus?: string      // last known runner status before runner went down (e.g., "running", "stopped")
  lastDeployedAt?: string        // timestamp of last successful deploy (used to detect pending code changes)
  codeDirty?: boolean            // client-side only: true if code/dependencies/projectFiles changed since last deploy (NOT persisted to DB)
  tokenStatus?: 'valid' | 'invalid' | 'not_set'  // server-side validated token status (decrypted & checked)
  tokenPreview?: string          // masked token preview (e.g., "123456...wxyz") — only from API, never persisted
}

/**
 * BotLogEntry — mirrors the Prisma BotLog model.
 * Used for structured log storage in the independent BotLog table.
 */
export interface BotLogEntry {
  id: string
  botId: string
  timestamp: string
  level: LogLevel
  message: string
  source: string
}
