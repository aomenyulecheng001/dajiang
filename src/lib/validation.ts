/**
 * Input Validation Utilities for Bot Factory API
 *
 * Provides comprehensive validation for all API input data.
 * Zero external dependencies - uses only built-in TypeScript.
 *
 * Usage:
 *   import { validateBotCreate, validateBotUpdate, validateBotId } from '@/lib/validation'
 *   const errors = validateBotCreate(body)
 *   if (errors.length > 0) return NextResponse.json({ error: errors[0], details: errors }, { status: 400 })
 */

import type {
  BotStatus,
  BotHealth,
  BotLanguage,
  LogLevel,
} from '@/types/bot'

// ─── Types ────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

// ─── Constants ────────────────────────────────────────────────────────────

// P2-12 FIX: Export with BOT_ prefix to avoid naming conflicts when imported
export const VALID_BOT_STATUSES: BotStatus[] = ['active', 'inactive', 'error', 'deploying']
export const VALID_BOT_HEALTHS: BotHealth[] = ['healthy', 'warning', 'critical', 'unknown']
// Keep local aliases for use within this file
const VALID_STATUSES = VALID_BOT_STATUSES
const VALID_HEALTHS = VALID_BOT_HEALTHS
const VALID_LANGUAGES: BotLanguage[] = ['javascript', 'typescript', 'python']
const VALID_CODE_BLOCK_TYPES = ['handler', 'middleware', 'command', 'callback', 'action', 'cron'] as const
const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error', 'critical']
/** P2 OPT: Export strongly-typed valid log levels for use across the codebase */
export const VALID_BOT_LOG_LEVELS = VALID_LOG_LEVELS
const VALID_POLLING_MODES = ['webhook', 'polling'] as const

const MAX_BOT_NAME_LENGTH = 100
const MAX_BOT_DESCRIPTION_LENGTH = 500
const MAX_BOT_VERSION_LENGTH = 20
const MAX_CODE_LENGTH = 500_000 // 500KB
const MAX_EMOJI_LENGTH = 4
const MAX_CUSTOM_ICON_LENGTH = 700_000 // ~512KB base64 data URL
const MAX_TEMPLATE_LENGTH = 50
const MAX_CODE_BLOCKS_COUNT = 50
const MAX_DEPENDENCIES_COUNT = 100
const MAX_ENV_VARS_COUNT = 100
const MAX_CODE_BLOCK_CODE_LENGTH = 100_000 // 100KB per block
const MAX_ENV_VAR_KEY_LENGTH = 100
const MAX_ENV_VAR_VALUE_LENGTH = 10_000
const MAX_URL_LENGTH = 2048

// ─── Helpers ──────────────────────────────────────────────────────────────

function err(field: string, message: string): ValidationError {
  return { field, message }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

// ─── Core Validators ─────────────────────────────────────────────────────

/**
 * Validate a bot ID parameter
 * Accepts: timestamp-random format, UUID format, or alphanumeric
 */
export function validateBotId(id: unknown): ValidationError[] {
  const errors: ValidationError[] = []
  if (!isString(id) || !id.trim()) {
    errors.push(err('id', 'Bot ID is required'))
    return errors
  }
  if (id.length > 100) {
    errors.push(err('id', 'Bot ID must be 100 characters or less'))
  }
  // SECURITY FIX (SEC-77): Reject path traversal patterns.
  // botId is used in file paths (e.g., rm() in DELETE handler), so '..' would
  // cause path.join() to traverse up and delete unintended directories.
  // Also reject IDs starting with '.' to prevent hidden file interactions.
  if (id === '..' || id.includes('..') || id.startsWith('.')) {
    errors.push(err('id', 'Bot ID contains invalid path characters'))
  }
  // Only allow safe characters: alphanumeric, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    errors.push(err('id', 'Bot ID contains invalid characters'))
  }
  return errors
}

/**
 * Validate bot creation payload
 */
export function validateBotCreate(body: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = []

  // Optional: id (client-provided ID for race-condition-free creation)
  if (body.id !== undefined && body.id !== null) {
    if (!isString(body.id)) {
      errors.push(err('id', 'Bot ID must be a string'))
    } else if (body.id.length > 100) {
      errors.push(err('id', 'Bot ID must be 100 characters or less'))
    } else if (body.id.length > 0 && !/^[a-zA-Z0-9._-]+$/.test(body.id)) {
      errors.push(err('id', 'Bot ID contains invalid characters'))
    }
    if (isString(body.id) && body.id.length > 0) {
      if (body.id.includes('..') || body.id.startsWith('.')) {
        errors.push(err('id', 'Bot ID contains invalid path characters'))
      }
    }
  }

  // Required: name
  if (!body.name || !isString(body.name)) {
    errors.push(err('name', 'Bot name is required'))
  } else if (!body.name.trim()) {
    errors.push(err('name', 'Bot name cannot be empty'))
  } else if (body.name.trim().length > MAX_BOT_NAME_LENGTH) {
    errors.push(err('name', `Bot name must be ${MAX_BOT_NAME_LENGTH} characters or less`))
  }

  // Optional: description
  if (body.description !== undefined && body.description !== null) {
    if (!isString(body.description)) {
      errors.push(err('description', 'Description must be a string'))
    } else if (body.description.length > MAX_BOT_DESCRIPTION_LENGTH) {
      errors.push(err('description', `Description must be ${MAX_BOT_DESCRIPTION_LENGTH} characters or less`))
    }
  }

  // Optional: emoji
  if (body.emoji !== undefined && body.emoji !== null) {
    if (!isString(body.emoji)) {
      errors.push(err('emoji', 'Emoji must be a string'))
    } else if (body.emoji.length > MAX_EMOJI_LENGTH) {
      errors.push(err('emoji', `Emoji must be ${MAX_EMOJI_LENGTH} characters or less`))
    }
  }

  // Optional: customIcon
  if (body.customIcon !== undefined && body.customIcon !== null) {
    if (!isString(body.customIcon)) {
      errors.push(err('customIcon', 'Custom icon must be a string'))
    } else if (body.customIcon.length > MAX_CUSTOM_ICON_LENGTH) {
      errors.push(err('customIcon', `Custom icon must be ${MAX_CUSTOM_ICON_LENGTH} characters or less`))
    }
  }

  // Optional: status
  if (body.status !== undefined && body.status !== null) {
    if (!isString(body.status) || !VALID_STATUSES.includes(body.status as BotStatus)) {
      errors.push(err('status', `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`))
    }
  }

  // Optional: health
  if (body.health !== undefined && body.health !== null) {
    if (!isString(body.health) || !VALID_HEALTHS.includes(body.health as BotHealth)) {
      errors.push(err('health', `Invalid health. Must be one of: ${VALID_HEALTHS.join(', ')}`))
    }
  }

  // Optional: language
  if (body.language !== undefined && body.language !== null) {
    if (!isString(body.language) || !VALID_LANGUAGES.includes(body.language as BotLanguage)) {
      errors.push(err('language', `Invalid language. Must be one of: ${VALID_LANGUAGES.join(', ')}`))
    }
  }

  // Optional: template
  if (body.template !== undefined && body.template !== null) {
    if (!isString(body.template)) {
      errors.push(err('template', 'Template must be a string'))
    } else if (body.template.length > MAX_TEMPLATE_LENGTH) {
      errors.push(err('template', `Template must be ${MAX_TEMPLATE_LENGTH} characters or less`))
    }
  }

  // Optional: version
  if (body.version !== undefined && body.version !== null) {
    if (!isString(body.version)) {
      errors.push(err('version', 'Version must be a string'))
    } else if (body.version.length > MAX_BOT_VERSION_LENGTH) {
      errors.push(err('version', `Version must be ${MAX_BOT_VERSION_LENGTH} characters or less`))
    }
    // Validate semver-ish format
    if (isString(body.version) && !/^\d+(\.\d+)*(-[\w.]+)?$/.test(body.version)) {
      errors.push(err('version', 'Version must follow semantic versioning (e.g. 1.0.0)'))
    }
  }

  // Optional: code
  if (body.code !== undefined && body.code !== null) {
    if (!isString(body.code)) {
      errors.push(err('code', 'Code must be a string'))
    } else if (body.code.length > MAX_CODE_LENGTH) {
      errors.push(err('code', `Code must be ${MAX_CODE_LENGTH} characters or less`))
    }
  }

  // Optional: codeBlocks
  if (body.codeBlocks !== undefined && body.codeBlocks !== null) {
    errors.push(...validateCodeBlocks(body.codeBlocks))
  }

  // Optional: dependencies
  if (body.dependencies !== undefined && body.dependencies !== null) {
    errors.push(...validateDependencies(body.dependencies))
  }

  // Optional: envVars
  if (body.envVars !== undefined && body.envVars !== null) {
    errors.push(...validateEnvVars(body.envVars))
  }

  // Optional: config
  if (body.config !== undefined && body.config !== null) {
    errors.push(...validateConfig(body.config))
  }

  // Optional: stats
  if (body.stats !== undefined && body.stats !== null) {
    errors.push(...validateStats(body.stats))
  }

  // Optional: projectFiles
  if (body.projectFiles !== undefined && body.projectFiles !== null) {
    if (!isArray(body.projectFiles)) {
      errors.push(err('projectFiles', 'Project files must be an array'))
    }
  }

  // Optional: entryPoint
  if (body.entryPoint !== undefined && body.entryPoint !== null) {
    if (!isString(body.entryPoint)) {
      errors.push(err('entryPoint', 'Entry point must be a string'))
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate bot full-update payload (PUT — name is still required).
 * Delegates to validateBotCreate since PUT requires all fields to be valid.
 * Kept as a separate function for future divergence (e.g., PUT may allow
 * omitting certain fields that POST requires).
 */
export function validateBotUpdate(body: Record<string, unknown>): ValidationResult {
  return validateBotCreate(body)
}

/**
 * Validate bot partial-update payload (PATCH — all fields optional).
 * Only validates fields that are actually present in the body.
 */
export function validateBotPatch(body: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = []

  // Only validate if name is provided
  if ('name' in body) {
    if (!body.name || !isString(body.name)) {
      errors.push(err('name', 'Bot name must be a non-empty string'))
    } else if (!body.name.trim()) {
      errors.push(err('name', 'Bot name cannot be empty'))
    } else if (body.name.trim().length > MAX_BOT_NAME_LENGTH) {
      errors.push(err('name', `Bot name must be ${MAX_BOT_NAME_LENGTH} characters or less`))
    }
  }

  // Validate other fields only if present
  if ('description' in body && body.description !== undefined && body.description !== null) {
    if (!isString(body.description)) {
      errors.push(err('description', 'Description must be a string'))
    } else if (body.description.length > MAX_BOT_DESCRIPTION_LENGTH) {
      errors.push(err('description', `Description must be ${MAX_BOT_DESCRIPTION_LENGTH} characters or less`))
    }
  }

  if ('emoji' in body && body.emoji !== undefined && body.emoji !== null) {
    if (!isString(body.emoji)) {
      errors.push(err('emoji', 'Emoji must be a string'))
    } else if (body.emoji.length > MAX_EMOJI_LENGTH) {
      errors.push(err('emoji', `Emoji must be ${MAX_EMOJI_LENGTH} characters or less`))
    }
  }

  if ('customIcon' in body && body.customIcon !== undefined && body.customIcon !== null) {
    if (!isString(body.customIcon)) {
      errors.push(err('customIcon', 'Custom icon must be a string'))
    } else if (body.customIcon.length > MAX_CUSTOM_ICON_LENGTH) {
      errors.push(err('customIcon', `Custom icon must be ${MAX_CUSTOM_ICON_LENGTH} characters or less`))
    }
  }

  if ('status' in body && body.status !== undefined && body.status !== null) {
    if (!isString(body.status) || !VALID_STATUSES.includes(body.status as BotStatus)) {
      errors.push(err('status', `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`))
    }
  }

  if ('health' in body && body.health !== undefined && body.health !== null) {
    if (!isString(body.health) || !VALID_HEALTHS.includes(body.health as BotHealth)) {
      errors.push(err('health', `Invalid health. Must be one of: ${VALID_HEALTHS.join(', ')}`))
    }
  }

  if ('language' in body && body.language !== undefined && body.language !== null) {
    if (!isString(body.language) || !VALID_LANGUAGES.includes(body.language as BotLanguage)) {
      errors.push(err('language', `Invalid language. Must be one of: ${VALID_LANGUAGES.join(', ')}`))
    }
  }

  if ('template' in body && body.template !== undefined && body.template !== null) {
    if (!isString(body.template)) {
      errors.push(err('template', 'Template must be a string'))
    } else if (body.template.length > MAX_TEMPLATE_LENGTH) {
      errors.push(err('template', `Template must be ${MAX_TEMPLATE_LENGTH} characters or less`))
    }
  }

  if ('version' in body && body.version !== undefined && body.version !== null) {
    if (!isString(body.version)) {
      errors.push(err('version', 'Version must be a string'))
    } else if (body.version.length > MAX_BOT_VERSION_LENGTH) {
      errors.push(err('version', `Version must be ${MAX_BOT_VERSION_LENGTH} characters or less`))
    }
    if (isString(body.version) && !/^\d+(\.\d+)*(-[\w.]+)?$/.test(body.version)) {
      errors.push(err('version', 'Version must follow semantic versioning (e.g. 1.0.0)'))
    }
  }

  if ('code' in body && body.code !== undefined && body.code !== null) {
    if (!isString(body.code)) {
      errors.push(err('code', 'Code must be a string'))
    } else if (body.code.length > MAX_CODE_LENGTH) {
      errors.push(err('code', `Code must be ${MAX_CODE_LENGTH} characters or less`))
    }
  }

  if ('codeBlocks' in body && body.codeBlocks !== undefined && body.codeBlocks !== null) {
    errors.push(...validateCodeBlocks(body.codeBlocks))
  }

  if ('dependencies' in body && body.dependencies !== undefined && body.dependencies !== null) {
    errors.push(...validateDependencies(body.dependencies))
  }

  if ('envVars' in body && body.envVars !== undefined && body.envVars !== null) {
    errors.push(...validateEnvVars(body.envVars))
  }

  if ('config' in body && body.config !== undefined && body.config !== null) {
    errors.push(...validateConfig(body.config))
  }

  if ('stats' in body && body.stats !== undefined && body.stats !== null) {
    errors.push(...validateStats(body.stats))
  }

  if ('projectFiles' in body && body.projectFiles !== undefined && body.projectFiles !== null) {
    if (!isArray(body.projectFiles)) {
      errors.push(err('projectFiles', 'Project files must be an array'))
    }
  }

  if ('entryPoint' in body && body.entryPoint !== undefined && body.entryPoint !== null) {
    if (!isString(body.entryPoint)) {
      errors.push(err('entryPoint', 'Entry point must be a string'))
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate runner action payload
 */
export function validateRunnerAction(body: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = []

  if (!body.action || !isString(body.action)) {
    errors.push(err('action', 'Action is required'))
  } else if (!['start', 'stop', 'restart'].includes(body.action)) {
    errors.push(err('action', 'Invalid action. Must be "start", "stop", or "restart"'))
  }

  // Optional: code (for start/restart)
  if (body.code !== undefined && body.code !== null) {
    if (!isString(body.code)) {
      errors.push(err('code', 'Code must be a string'))
    } else if (body.code.length > MAX_CODE_LENGTH) {
      errors.push(err('code', `Code must be ${MAX_CODE_LENGTH} characters or less`))
    }
  }

  // Optional: envVars (for start/restart)
  if (body.envVars !== undefined && body.envVars !== null) {
    errors.push(...validateEnvVars(body.envVars))
  }

  // Optional: dependencies (for start/restart)
  if (body.dependencies !== undefined && body.dependencies !== null) {
    errors.push(...validateDependencies(body.dependencies))
  }

  // Optional: language (for start/restart)
  if (body.language !== undefined && body.language !== null) {
    if (!isString(body.language) || !VALID_LANGUAGES.includes(body.language as BotLanguage)) {
      errors.push(err('language', `Invalid language. Must be one of: ${VALID_LANGUAGES.join(', ')}`))
    }
  }

  return { valid: errors.length === 0, errors }
}

// ─── Sub-Validators ──────────────────────────────────────────────────────

function validateCodeBlocks(value: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  if (!isArray(value)) {
    return [err('codeBlocks', 'Code blocks must be an array')]
  }

  if (value.length > MAX_CODE_BLOCKS_COUNT) {
    errors.push(err('codeBlocks', `Maximum ${MAX_CODE_BLOCKS_COUNT} code blocks allowed`))
  }

  for (let i = 0; i < Math.min(value.length, MAX_CODE_BLOCKS_COUNT); i++) {
    const block = value[i]
    if (!isObject(block)) {
      errors.push(err(`codeBlocks[${i}]`, `Code block at index ${i} must be an object`))
      continue
    }

    // id
    if (block.id !== undefined && (!isString(block.id) || block.id.length > 100)) {
      errors.push(err(`codeBlocks[${i}].id`, 'Code block ID must be a string (max 100 chars)'))
    }

    // name
    if (!block.name || !isString(block.name)) {
      errors.push(err(`codeBlocks[${i}].name`, 'Code block name is required'))
    } else if (block.name.length > 100) {
      errors.push(err(`codeBlocks[${i}].name`, 'Code block name must be 100 characters or less'))
    }

    // type
    if (!block.type || !isString(block.type) || !VALID_CODE_BLOCK_TYPES.includes(block.type as typeof VALID_CODE_BLOCK_TYPES[number])) {
      errors.push(err(`codeBlocks[${i}].type`, `Invalid code block type. Must be one of: ${VALID_CODE_BLOCK_TYPES.join(', ')}`))
    }

    // code
    if (!isString(block.code)) {
      errors.push(err(`codeBlocks[${i}].code`, 'Code block code must be a string'))
    } else if (block.code.length > MAX_CODE_BLOCK_CODE_LENGTH) {
      errors.push(err(`codeBlocks[${i}].code`, `Code block code must be ${MAX_CODE_BLOCK_CODE_LENGTH} characters or less`))
    }

    // isActive
    if (block.isActive !== undefined && typeof block.isActive !== 'boolean') {
      errors.push(err(`codeBlocks[${i}].isActive`, 'isActive must be a boolean'))
    }

    // language
    if (block.language !== undefined && block.language !== null) {
      const validLangs = [...VALID_LANGUAGES, 'json']
      if (!isString(block.language) || !validLangs.includes(block.language as BotLanguage | 'json')) {
        errors.push(err(`codeBlocks[${i}].language`, `Invalid language. Must be one of: ${validLangs.join(', ')}`))
      }
    }
  }

  return errors
}

function validateDependencies(value: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  if (!isArray(value)) {
    return [err('dependencies', 'Dependencies must be an array')]
  }

  if (value.length > MAX_DEPENDENCIES_COUNT) {
    errors.push(err('dependencies', `Maximum ${MAX_DEPENDENCIES_COUNT} dependencies allowed`))
  }

  for (let i = 0; i < Math.min(value.length, MAX_DEPENDENCIES_COUNT); i++) {
    const dep = value[i]
    if (!isObject(dep)) {
      errors.push(err(`dependencies[${i}]`, `Dependency at index ${i} must be an object`))
      continue
    }

    // id
    if (dep.id !== undefined && (!isString(dep.id) || dep.id.length > 100)) {
      errors.push(err(`dependencies[${i}].id`, 'Dependency ID must be a string (max 100 chars)'))
    }

    // name
    if (!dep.name || !isString(dep.name)) {
      errors.push(err(`dependencies[${i}].name`, 'Dependency name is required'))
    } else if (dep.name.length > 200) {
      errors.push(err(`dependencies[${i}].name`, 'Dependency name must be 200 characters or less'))
    }
    // Validate package name format (no leading dots, no path traversal)
    if (isString(dep.name) && /^[.\/\\]/.test(dep.name)) {
      errors.push(err(`dependencies[${i}].name`, 'Dependency name cannot start with . / or \\'))
    }

    // version
    if (dep.version !== undefined && dep.version !== null) {
      if (!isString(dep.version) || dep.version.length > 50) {
        errors.push(err(`dependencies[${i}].version`, 'Version must be a string (max 50 chars)'))
      }
    }

    // isRequired
    if (dep.isRequired !== undefined && typeof dep.isRequired !== 'boolean') {
      errors.push(err(`dependencies[${i}].isRequired`, 'isRequired must be a boolean'))
    }
  }

  return errors
}

function validateEnvVars(value: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  if (!isArray(value)) {
    return [err('envVars', 'Environment variables must be an array')]
  }

  if (value.length > MAX_ENV_VARS_COUNT) {
    errors.push(err('envVars', `Maximum ${MAX_ENV_VARS_COUNT} environment variables allowed`))
  }

  for (let i = 0; i < Math.min(value.length, MAX_ENV_VARS_COUNT); i++) {
    const envVar = value[i]
    if (!isObject(envVar)) {
      errors.push(err(`envVars[${i}]`, `Environment variable at index ${i} must be an object`))
      continue
    }

    // id
    if (envVar.id !== undefined && (!isString(envVar.id) || envVar.id.length > 100)) {
      errors.push(err(`envVars[${i}].id`, 'Variable ID must be a string (max 100 chars)'))
    }

    // key
    if (!envVar.key || !isString(envVar.key)) {
      errors.push(err(`envVars[${i}].key`, 'Variable key is required'))
    } else if (envVar.key.length > MAX_ENV_VAR_KEY_LENGTH) {
      errors.push(err(`envVars[${i}].key`, `Variable key must be ${MAX_ENV_VAR_KEY_LENGTH} characters or less`))
    } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar.key)) {
      errors.push(err(`envVars[${i}].key`, 'Variable key must start with a letter or underscore and contain only alphanumeric characters and underscores'))
    }

    // value
    if (envVar.value !== undefined && envVar.value !== null) {
      if (!isString(envVar.value)) {
        errors.push(err(`envVars[${i}].value`, 'Variable value must be a string'))
      } else if (envVar.value.length > MAX_ENV_VAR_VALUE_LENGTH) {
        errors.push(err(`envVars[${i}].value`, `Variable value must be ${MAX_ENV_VAR_VALUE_LENGTH} characters or less`))
      }
    }

    // isEncrypted
    if (envVar.isEncrypted !== undefined && typeof envVar.isEncrypted !== 'boolean') {
      errors.push(err(`envVars[${i}].isEncrypted`, 'isEncrypted must be a boolean'))
    }
  }

  return errors
}

function validateConfig(value: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  if (!isObject(value)) {
    return [err('config', 'Config must be an object')]
  }

  // webhookUrl
  if (value.webhookUrl !== undefined && value.webhookUrl !== null) {
    if (!isString(value.webhookUrl)) {
      errors.push(err('config.webhookUrl', 'webhookUrl must be a string'))
    } else if (value.webhookUrl.length > 0 && !isValidUrl(value.webhookUrl)) {
      errors.push(err('config.webhookUrl', 'webhookUrl must be a valid URL'))
    }
  }

  // webhookSecret (optional, auto-generated)
  if (value.webhookSecret !== undefined && value.webhookSecret !== null) {
    if (!isString(value.webhookSecret)) {
      errors.push(err('config.webhookSecret', 'webhookSecret must be a string'))
    } else if (value.webhookSecret.length > 256) {
      errors.push(err('config.webhookSecret', 'webhookSecret must be 256 characters or less'))
    }
  }

  // pollingMode
  if (value.pollingMode !== undefined && value.pollingMode !== null) {
    if (!isString(value.pollingMode) || !VALID_POLLING_MODES.includes(value.pollingMode as typeof VALID_POLLING_MODES[number])) {
      errors.push(err('config.pollingMode', `Invalid polling mode. Must be one of: ${VALID_POLLING_MODES.join(', ')}`))
    }
  }

  // rateLimitPerMinute
  if (value.rateLimitPerMinute !== undefined) {
    if (typeof value.rateLimitPerMinute !== 'number' || value.rateLimitPerMinute < 1 || value.rateLimitPerMinute > 10000) {
      errors.push(err('config.rateLimitPerMinute', 'rateLimitPerMinute must be a number between 1 and 10000'))
    }
  }

  // maxConcurrentRequests
  if (value.maxConcurrentRequests !== undefined) {
    if (typeof value.maxConcurrentRequests !== 'number' || value.maxConcurrentRequests < 1 || value.maxConcurrentRequests > 1000) {
      errors.push(err('config.maxConcurrentRequests', 'maxConcurrentRequests must be a number between 1 and 1000'))
    }
  }

  // autoRestart
  if (value.autoRestart !== undefined && typeof value.autoRestart !== 'boolean') {
    errors.push(err('config.autoRestart', 'autoRestart must be a boolean'))
  }

  // logLevel
  if (value.logLevel !== undefined && value.logLevel !== null) {
    if (!isString(value.logLevel) || !VALID_LOG_LEVELS.includes(value.logLevel as typeof VALID_LOG_LEVELS[number])) {
      errors.push(err('config.logLevel', `Invalid log level. Must be one of: ${VALID_LOG_LEVELS.join(', ')}`))
    }
  }

  // timeout
  if (value.timeout !== undefined) {
    if (typeof value.timeout !== 'number' || value.timeout < 1 || value.timeout > 3600) {
      errors.push(err('config.timeout', 'timeout must be a number between 1 and 3600 seconds'))
    }
  }

  return errors
}

function validateStats(value: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  if (!isObject(value)) {
    return [err('stats', 'Stats must be an object')]
  }

  // Numeric fields validation
  const numericFields: { key: string; min: number; max: number }[] = [
    { key: 'messages', min: 0, max: Number.MAX_SAFE_INTEGER },
    { key: 'users', min: 0, max: Number.MAX_SAFE_INTEGER },
    { key: 'uptime', min: 0, max: Number.MAX_SAFE_INTEGER },
    { key: 'errors', min: 0, max: Number.MAX_SAFE_INTEGER },
  ]

  for (const { key, min, max } of numericFields) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'number' || isNaN(value[key]) || !isFinite(value[key])) {
        errors.push(err(`stats.${key}`, `stats.${key} must be a valid number`))
      } else if (value[key] < min || value[key] > max) {
        errors.push(err(`stats.${key}`, `stats.${key} must be between ${min} and ${max}`))
      }
    }
  }

  // dailyMessages (array)
  if (value.dailyMessages !== undefined) {
    if (!isArray(value.dailyMessages)) {
      errors.push(err('stats.dailyMessages', 'dailyMessages must be an array'))
    } else if (value.dailyMessages.length > 365) {
      errors.push(err('stats.dailyMessages', 'dailyMessages must have 365 entries or less'))
    }
  }

  // topCommands (array)
  if (value.topCommands !== undefined) {
    if (!isArray(value.topCommands)) {
      errors.push(err('stats.topCommands', 'topCommands must be an array'))
    } else if (value.topCommands.length > 100) {
      errors.push(err('stats.topCommands', 'topCommands must have 100 entries or less'))
    }
  }

  // hourlyActivity (array of 24 numbers)
  if (value.hourlyActivity !== undefined) {
    if (!isArray(value.hourlyActivity)) {
      errors.push(err('stats.hourlyActivity', 'hourlyActivity must be an array'))
    } else if (value.hourlyActivity.length !== 24 && value.hourlyActivity.length !== 0) {
      errors.push(err('stats.hourlyActivity', 'hourlyActivity must have exactly 24 entries'))
    }
  }

  return errors
}

// ─── URL Validation ───────────────────────────────────────────────────────

function isValidUrl(str: string): boolean {
  if (str.length > MAX_URL_LENGTH) return false
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// ─── Sanitization Helpers ─────────────────────────────────────────────────

/**
 * Sanitize and trim a string value, returning empty string if invalid
 */
export function sanitizeString(value: unknown, maxLength: number): string {
  if (!isString(value)) return ''
  return value.trim().slice(0, maxLength)
}

/**
 * Sanitize bot name (required, trimmed, length-capped)
 */
export function sanitizeBotName(value: unknown): string {
  return sanitizeString(value, MAX_BOT_NAME_LENGTH)
}

/**
 * Sanitize bot description (optional, trimmed, length-capped)
 */
export function sanitizeBotDescription(value: unknown): string {
  return sanitizeString(value, MAX_BOT_DESCRIPTION_LENGTH)
}

/**
 * Sanitize emoji (single emoji or default)
 */
export function sanitizeEmoji(value: unknown): string {
  if (!isString(value) || value.length === 0 || value.length > MAX_EMOJI_LENGTH) return '🤖'
  return value
}

/**
 * Sanitize custom icon (base64 data URL or empty string)
 *
 * SECURITY FIX: Enhanced validation to prevent XSS via crafted data URLs.
 * Previously only checked `data:image/` prefix, allowing:
 * - data:image/svg+xml;base64,<script>alert(1)</script>
 * - data:image/svg+xml;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==
 * - Other malicious payloads in SVG or other vector formats
 */
export function sanitizeCustomIcon(value: unknown): string {
  if (!isString(value) || value.length === 0) return ''
  if (value.length > MAX_CUSTOM_ICON_LENGTH) return ''

  // Must be a valid data URL prefix for images
  if (!value.startsWith('data:image/')) return ''

  // Parse data URL format: data:image/<type>;base64,<data>
  const match = value.match(/^data:image\/([a-z+]+);base64,(.+)$/i)
  if (!match) return ''

  const [, mimeType, base64Data] = match

  // Whitelist allowed image MIME types (block svg+xml which can contain scripts)
  const ALLOWED_MIME_TYPES = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'ico'])
  if (!ALLOWED_MIME_TYPES.has(mimeType.toLowerCase())) return ''

  // Validate base64 content is valid (only A-Za-z0-9+/= characters)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) return ''

  // SECURITY FIX (SEC-102): Removed the HTML character check on decoded binary data.
  // The previous check decoded base64 as UTF-8 and rejected content containing <>"'.
  // This broke ALL valid binary image uploads (PNG, JPEG, etc.) because binary data
  // almost always contains bytes that map to these ASCII characters (e.g., 0x3C = '<').
  // SVG (the only image format that could carry XSS payloads) is already blocked by
  // the MIME type whitelist above, making the HTML character check redundant.
  return value
}
