import { createCipheriv, createDecipheriv, createHash, randomBytes, pbkdf2 } from 'crypto'
import { access, readFile, writeFile, mkdir, chmod, open } from 'fs/promises'
import { join, dirname } from 'path'
import { resolveFromProjectRoot } from '@/lib/project-root'
import { SENSITIVE_KEY_PATTERNS } from '@/lib/bot-constants'
import { logger } from '@/lib/logger'

const ALGORITHM = 'aes-256-gcm'

let _cachedKey: Buffer | null = null
let _cachedKeySource: string | null = null
let _keyPromise: Promise<Buffer> | null = null
let _keyInitLock = false
let _keyInitWaiters: Array<() => void> = []
let _keyVersion: 1 | 2 = 1

const PBKDF2_ITERATIONS = 600000
const PBKDF2_SALT_BYTES = 16

/**
 * SECURITY FIX (S2): Derive key with a random salt stored alongside the ciphertext.
 * Previously, the salt was deterministically derived from the key source
 * (SHA256('bot-factory-salt:' + keySource)), which means the same ENCRYPTION_KEY
 * always produces the same derived key — weakening PBKDF2's resistance to
 * precomputation attacks. Now each encryption uses a fresh random salt.
 *
 * The legacy deterministic salt is still used for ENC1 format decryption.
 */
function getLegacyPBKDF2Salt(keySource: string): string {
  const hash = createHash('sha256').update('bot-factory-salt:' + keySource).digest('hex')
  return hash.slice(0, 32)
}

async function deriveKeyWithSalt(keySource: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    pbkdf2(keySource, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

const LEGACY_KEY_SUFFIX = '0'.repeat(22)

async function acquireKeyLock(timeoutMs = 5000): Promise<boolean> {
  if (!_keyInitLock) {
    _keyInitLock = true
    return true
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    _keyInitWaiters.push(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

function releaseKeyLock(): void {
  const next = _keyInitWaiters.shift()
  if (next) {
    _keyInitLock = true
    next()
  } else {
    _keyInitLock = false
  }
}

async function getKeyAsync(): Promise<Buffer> {
  if (_cachedKey) return _cachedKey
  if (_keyPromise) return _keyPromise

  const lockAcquired = await acquireKeyLock()
  if (!lockAcquired) {
    throw new Error('[crypto] Timeout waiting for key initialization lock')
  }

  try {
    if (_cachedKey) return _cachedKey
    if (_keyPromise) return _keyPromise

    _keyPromise = (async () => {
      let keySource = process.env.ENCRYPTION_KEY
      let isGenerated = false

      if (!keySource || keySource.length === 0) {
        const keyFile = resolveFromProjectRoot('.encryption-key')
        try {
          await access(keyFile)
          keySource = (await readFile(keyFile, 'utf-8')).trim()
        } catch {
          // File doesn't exist
        }
        if (!keySource || keySource.length === 0) {
          const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export'
          if (process.env.NODE_ENV === 'production' && !isBuildPhase) {
            logger.error('crypto', 'ENCRYPTION_KEY is not set in production. Encrypted data will be lost on restart!')
            process.exit(1)
          }
          keySource = randomBytes(32).toString('hex').slice(0, 32)
          try {
            await mkdir(dirname(keyFile), { recursive: true })
            try {
              const fd = await open(keyFile, 'wx', 0o600)
              await fd.writeFile(keySource, 'utf-8')
              await fd.close()
            } catch (e: unknown) {
              const errCode = e instanceof Error && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined
              if (errCode === 'EEXIST') {
                keySource = (await readFile(keyFile, 'utf-8')).trim()
              } else {
                throw e
              }
            }
            try { await chmod(keyFile, 0o600) } catch { /* Windows may not support chmod */ }
          } catch {
            // Ignore write errors — key is still usable in memory
          }
          isGenerated = true
        }
      }

      if (isGenerated) {
        const warning = [
          'ENCRYPTION_KEY environment variable is not set.',
          'A random key was generated and saved to .encryption-key.',
          '',
          'In production, set ENCRYPTION_KEY to prevent data loss on redeployment!',
          'All encrypted BOT_TOKENs will become unreadable if the key changes.',
        ]
        logger.warn('crypto', warning.join('\n'))
        if (process.env.KUBERNETES_SERVICE_HOST || process.env.DOCKER_CONTAINER) {
          logger.warn('crypto', 'CONTAINER DETECTED: The .encryption-key file will be LOST on container restart! You MUST set ENCRYPTION_KEY as a container environment variable or persistent volume.')
        }
      }

      const salt = getLegacyPBKDF2Salt(keySource)
      const derivedKey = await new Promise<Buffer>((resolve, reject) => {
        pbkdf2(keySource, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, key) => {
          if (err) reject(err)
          else resolve(key)
        })
      })
      // SECURITY FIX (S2): Cache the keySource so that encryptAsync can derive
      // per-salt keys for new ENC2 format encryptions. The cached derivedKey
      // is still used for backward-compatible ENC1 decryption.
      _keyVersion = 2
      _cachedKey = derivedKey
      _cachedKeySource = keySource
      return _cachedKey
    })()
    _keyPromise!.catch(() => { _keyPromise = null })

    return _keyPromise
  } finally {
    releaseKeyLock()
  }
}

function getKey(): Buffer {
  if (_cachedKey) return _cachedKey

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[crypto] CRITICAL: Attempted synchronous key derivation in production. ' +
      'This would block the event loop. Ensure getKeyAsync() is called at startup ' +
      'before any sync operations, or use the async versions of encrypt/decrypt functions.'
    )
  }

  logger.warn('crypto', 'Synchronous key derivation in development. Use async functions for production.')

  let keySource = process.env.ENCRYPTION_KEY

  if (!keySource || keySource.length === 0) {
    throw new Error(
      '[crypto] ENCRYPTION_KEY is not set and no cached key is available. ' +
      'Call getKeyAsync() first at startup, or set the ENCRYPTION_KEY env var. ' +
      'Sync getKey() no longer generates temporary keys to prevent data loss.'
    )
  }

  const salt = getLegacyPBKDF2Salt(keySource)
  const { pbkdf2Sync } = require('crypto')
  // SECURITY FIX (L2): Use fewer iterations in development to reduce event loop
  // blocking. 600000 iterations of PBKDF2 can block for 600-1200ms. In production,
  // getKey() throws an error — only getKeyAsync() should be used.
  const devIterations = 60000
  const derivedKey: Buffer = pbkdf2Sync(keySource, salt, devIterations, 32, 'sha256')
  _cachedKey = derivedKey
  _cachedKeySource = keySource
  _keyVersion = 2
  return derivedKey
}

export function encrypt(_text: string): never {
  throw new Error(
    '[crypto] Synchronous encrypt() has been removed to prevent event loop blocking. ' +
    'Use encryptAsync() instead.'
  )
}

export async function encryptAsync(text: string): Promise<string> {
  const iv = randomBytes(16)
  // SECURITY FIX (S2): Use a random salt for each encryption instead of
  // the deterministic salt derived from keySource. This prevents precomputation
  // attacks and ensures each ciphertext uses a unique derived key.
  const salt = randomBytes(PBKDF2_SALT_BYTES)
  // Auto-initialize on first call — avoids "Key source not available" error
  // when encryptAsync is called before an explicit initializeCrypto().
  let keySource = _cachedKeySource
  if (!keySource) {
    await getKeyAsync()
    keySource = _cachedKeySource
    if (!keySource) {
      throw new Error('[crypto] Key source not available after initialization. Check ENCRYPTION_KEY env var.')
    }
  }
  const key = await deriveKeyWithSalt(keySource, salt)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  // ENC2 format: ENC2:<iv>:<salt>:<authTag>:<encrypted>
  return `${ENC2_PREFIX}${iv.toString('hex')}:${salt.toString('hex')}:${authTag}:${encrypted}`
}

function parseEncryptedText(encryptedText: string): [string, string, string] {
  const raw = encryptedText.startsWith(ENC_PREFIX) ? encryptedText.slice(ENC_PREFIX.length) : encryptedText
  const parts = raw.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format: expected 3 colon-separated parts')
  }
  return [parts[0], parts[1], parts[2]]
}

export function decrypt(_encryptedText: string): never {
  throw new Error(
    '[crypto] Synchronous decrypt() has been removed to prevent event loop blocking. ' +
    'Use decryptAsync() instead.'
  )
}

export async function decryptAsync(encryptedText: string): Promise<string> {
  // SECURITY FIX (S2): Support both ENC1 (legacy, deterministic salt) and
  // ENC2 (random salt) formats for backward compatibility.
  if (encryptedText.startsWith(ENC2_PREFIX)) {
    // ENC2 format: ENC2:<iv>:<salt>:<authTag>:<encrypted>
    const raw = encryptedText.slice(ENC2_PREFIX.length)
    const parts = raw.split(':')
    if (parts.length !== 4) {
      throw new Error('Invalid ENC2 encrypted text format: expected 4 colon-separated parts')
    }
    const [ivHex, saltHex, authTagHex, encrypted] = parts
    const iv = Buffer.from(ivHex, 'hex')
    const salt = Buffer.from(saltHex, 'hex')
    const authTag = Buffer.from(authTagHex, 'hex')

    const keySource = _cachedKeySource
    if (!keySource) {
      // Fallback: ensure key is initialized
      await getKeyAsync()
      const ks = _cachedKeySource
      if (!ks) throw new Error('[crypto] Key source not available for ENC2 decryption')
      const key = await deriveKeyWithSalt(ks, salt)
      const decipher = createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(authTag)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    }
    const key = await deriveKeyWithSalt(keySource, salt)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  // ENC1 format (legacy): ENC1:<iv>:<authTag>:<encrypted>
  const [ivHex, authTagHex, encrypted] = parseEncryptedText(encryptedText)
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  const key = await getKeyAsync()
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    const legacyResult = await tryLegacyKeyAsync(iv, authTag, encrypted, key)
    if (legacyResult !== null) return legacyResult
    throw new Error('Decryption failed: unable to decrypt with current or legacy key')
  }
}

async function tryLegacyKeyAsync(iv: Buffer, authTag: Buffer, encrypted: string, currentKey: Buffer): Promise<string | null> {
  let keySource = process.env.ENCRYPTION_KEY
  if (!keySource) {
    const keyFile = resolveFromProjectRoot('.encryption-key')
    try {
      await access(keyFile)
      keySource = (await readFile(keyFile, 'utf-8')).trim()
    } catch {
      return null
    }
  }
  if (!keySource) return null
  const legacyKey = Buffer.from(keySource.padEnd(32, '0').slice(0, 32), 'utf8')
  if (legacyKey.equals(currentKey)) return null
  try {
    const decipher = createDecipheriv(ALGORITHM, legacyKey, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    return null
  }
}

const ENC_PREFIX = 'ENC1:'
const ENC2_PREFIX = 'ENC2:'

// L4 FIXED: Removed heuristic detection of hex-only values that look like encrypted
// ciphertext. Previously, any string with 3-4 colon-separated hex parts where the
// first part was 32 chars would be treated as encrypted, causing false positives
// for legitimate hex values (e.g., HMAC secrets, API keys).
// Now only the explicit ENC1:/ENC2: prefixes trigger encrypted detection.
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX) || value.startsWith(ENC2_PREFIX)
}

// M1 FIXED: Use word-boundary matching to avoid overly broad matches.
// Previously, 'AUTH' would match 'OAUTH_CALLBACK_URL' via simple includes().
// Now the pattern must appear at a word boundary (underscore-delimited).
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEY_PATTERNS.some(pattern => {
    const idx = lower.indexOf(pattern)
    if (idx === -1) return false
    // Character before match must be start-of-string or underscore
    if (idx > 0 && lower[idx - 1] !== '_') return false
    // Character after match must be end-of-string or underscore
    const afterIdx = idx + pattern.length
    if (afterIdx < lower.length && lower[afterIdx] !== '_') return false
    return true
  })
}

export function encryptEnvVars<T extends { key: string; value: string; isEncrypted?: boolean }>(
  _envVars: T[]
): never {
  throw new Error(
    '[crypto] Synchronous encryptEnvVars() has been removed. ' +
    'Use encryptEnvVarsOnSaveAsync() instead.'
  )
}

export function encryptEnvVarsOnSave<T extends { key: string; value: string; isEncrypted?: boolean }>(
  _envVars: T[]
): never {
  throw new Error(
    '[crypto] Synchronous encryptEnvVarsOnSave() has been removed. ' +
    'Use encryptEnvVarsOnSaveAsync() instead.'
  )
}

export async function encryptEnvVarsOnSaveAsync<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): Promise<T[]> {
  const promises = envVars.map(async (envVar) => {
    if (isEncrypted(envVar.value)) {
      return { ...envVar, isEncrypted: true }
    } else if (isSensitiveKey(envVar.key)) {
      return { ...envVar, value: await encryptAsync(envVar.value), isEncrypted: true }
    } else {
      return envVar
    }
  })
  return Promise.all(promises)
}

export const ENCRYPTED_PLACEHOLDER = '••••••••••••'

export function decryptEnvVarsMasked<T extends { key: string; value: string; isEncrypted?: boolean }>(
  _envVars: T[]
): never {
  throw new Error(
    '[crypto] Synchronous decryptEnvVarsMasked() has been removed. ' +
    'Use decryptEnvVarsMaskedAsync() instead.'
  )
}

export async function decryptEnvVarsMaskedAsync<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): Promise<T[]> {
  const results: T[] = []
  for (const envVar of envVars) {
    if ((envVar.isEncrypted || isEncrypted(envVar.value)) && isSensitiveKey(envVar.key)) {
      results.push({ ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true })
      continue
    }
    if (envVar.isEncrypted && isEncrypted(envVar.value)) {
      try {
        results.push({ ...envVar, value: await decryptAsync(envVar.value) })
      } catch {
        logger.warn('crypto', `Failed to decrypt ${envVar.key}, returning masked`)
        results.push({ ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true })
      }
      continue
    }
    if (!envVar.isEncrypted && isEncrypted(envVar.value)) {
      if (isSensitiveKey(envVar.key)) {
        results.push({ ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true })
      } else {
        try {
          results.push({ ...envVar, value: await decryptAsync(envVar.value), isEncrypted: true })
        } catch {
          results.push({ ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true })
        }
      }
      continue
    }
    results.push(envVar)
  }
  return results
}

export function decryptEnvVars<T extends { key: string; value: string; isEncrypted?: boolean }>(
  _envVars: T[]
): never {
  throw new Error(
    '[crypto] Synchronous decryptEnvVars() has been removed. ' +
    'Use decryptEnvVarsAsync() instead.'
  )
}

export async function decryptEnvVarsAsync<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): Promise<T[]> {
  const results: T[] = []
  for (const envVar of envVars) {
    if (envVar.isEncrypted && isEncrypted(envVar.value)) {
      try {
        results.push({ ...envVar, value: await decryptAsync(envVar.value) })
      } catch {
        logger.warn('crypto', `Failed to decrypt ${envVar.key}`)
        results.push({ ...envVar, value: '[DECRYPTION_FAILED]', decryptionError: true })
      }
      continue
    }
    if (!envVar.isEncrypted && isEncrypted(envVar.value)) {
      try {
        results.push({ ...envVar, value: await decryptAsync(envVar.value), isEncrypted: true })
      } catch {
        results.push({ ...envVar, value: '[DECRYPTION_FAILED]', isEncrypted: true, decryptionError: true })
      }
      continue
    }
    results.push(envVar)
  }
  return results
}

export async function initializeCrypto(): Promise<void> {
  await getKeyAsync()
  logger.info('crypto', 'Encryption key initialized successfully')
}
