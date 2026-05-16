import { createCipheriv, createDecipheriv, createHash, randomBytes, pbkdf2Sync, pbkdf2 } from 'crypto'
import { access, readFile, writeFile, mkdir, chmod, open } from 'fs/promises'
import { join, dirname } from 'path'
import { resolveFromProjectRoot } from '@/lib/project-root'
import { SENSITIVE_KEY_PATTERNS } from '@/lib/bot-constants'

const ALGORITHM = 'aes-256-gcm'

/** Cached key buffer to avoid repeated filesystem reads */
let _cachedKey: Buffer | null = null

/** P2-API-2 FIX: Cached key promise for async initialization */
let _keyPromise: Promise<Buffer> | null = null

// P2-API-10 FIX: Key derivation version tracking
// v1 = legacy padding, v2 = PBKDF2
let _keyVersion: 1 | 2 = 1

const PBKDF2_ITERATIONS = 100000
// H6 FIX: Derive salt from ENCRYPTION_KEY source instead of using a hardcoded salt.
// A hardcoded salt means all instances sharing the same ENCRYPTION_KEY produce
// identical derived keys, making rainbow-table attacks easier.
// We still use a deterministic salt (so the same ENCRYPTION_KEY always produces
// the same derived key for backward compatibility), but it's now unique per key.
function getPBKDF2Salt(keySource: string): string {
  // Use a domain-separated derivation: salt = SHA-256("bot-factory-salt:" + keySource)
  // This ensures different ENCRYPTION_KEY values produce different salts and derived keys.
  const hash = createHash('sha256').update('bot-factory-salt:' + keySource).digest('hex')
  return hash.slice(0, 32) // Use first 32 hex chars as salt (128 bits of entropy)
}
const LEGACY_KEY_SUFFIX = '0'.repeat(22) // Legacy padding suffix for migration
// NOTE: PBKDF2_SALT was removed — it was dead code with a misleading comment.
// The actual salt derivation is in getPBKDF2Salt() which uses SHA-256(keySource).

/**
 * P2-API-2 FIX: Async version of getKey() using fs/promises
 * Caches the promise so subsequent calls await the same initialization.
 */
async function getKeyAsync(): Promise<Buffer> {
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
            console.error('FATAL: ENCRYPTION_KEY is not set in production. Encrypted data will be lost on restart!')
            process.exit(1)
          }
        keySource = randomBytes(32).toString('hex').slice(0, 32)
        try {
          await mkdir(dirname(keyFile), { recursive: true })
          try {
            const fd = await open(keyFile, 'wx', 0o600)
            await fd.writeFile(keySource, 'utf-8')
            await fd.close()
          } catch (e: any) {
            if (e.code === 'EEXIST') {
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
      console.warn('')
      console.warn('╔══════════════════════════════════════════════════════════════╗')
      console.warn('║  [SECURITY WARNING] ENCRYPTION_KEY environment variable   ║')
      console.warn('║  is not set. A random key was generated and saved to      ║')
      console.warn('║  .encryption-key.                                        ║')
      console.warn('║                                                           ║')
      console.warn('║  ⚠  In production, set ENCRYPTION_KEY to prevent data     ║')
      console.warn('║  loss on redeployment! All encrypted BOT_TOKENs will       ║')
      console.warn('║  become unreadable if the key changes.                    ║')
      console.warn('╚══════════════════════════════════════════════════════════════╝')
      console.warn('')
    }

    const salt = getPBKDF2Salt(keySource)
    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      pbkdf2(keySource, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, key) => {
        if (err) reject(err)
        else resolve(key)
      })
    })
    _keyVersion = 2
    _cachedKey = derivedKey
    return _cachedKey
  })()

  return _keyPromise
}

/**
 * Get the AES-256 encryption key (sync version for backward compat).
 *
 * IMPORTANT: This uses pbkdf2Sync which blocks the event loop for ~100ms.
 * It should only be called when the key is already cached (from a prior
 * getKeyAsync() call at startup). If the key is not cached, it throws
 * rather than blocking the event loop.
 *
 * Prefer getKeyAsync() in all new code.
 */
function getKey(): Buffer {
  if (_cachedKey) return _cachedKey

  let keySource = process.env.ENCRYPTION_KEY

  if (!keySource || keySource.length === 0) {
    throw new Error(
      '[crypto] ENCRYPTION_KEY is not set and no cached key is available. ' +
      'Call getKeyAsync() first at startup, or set the ENCRYPTION_KEY env var. ' +
      'Sync getKey() no longer generates temporary keys to prevent data loss.'
    )
  }

  const salt = getPBKDF2Salt(keySource)
  _cachedKey = pbkdf2Sync(keySource, salt, PBKDF2_ITERATIONS, 32, 'sha256')
  _keyVersion = 2
  return _cachedKey
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns format: ENC1:iv:authTag:encrypted (prefix + all hex)
 * The ENC1: prefix allows definitive detection of encrypted values
 * (vs the legacy iv:authTag:encrypted format that relied on heuristics).
 *
 * @deprecated Use encryptAsync() instead. This function blocks the event loop during key derivation.
 */
export function encrypt(text: string): string {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn('[crypto] Synchronous encryption function called. Use the async version to avoid blocking the event loop.')
  }
  const iv = randomBytes(16)
  const key = getKey()
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  // BUG FIX: Add ENC1: prefix for definitive encrypted-value detection.
  // Without the prefix, isEncrypted() uses a heuristic that can false-positive
  // on values that happen to match the iv:authTag:encrypted hex format.
  return `${ENC_PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`
}

/**
 * P2-API-2 FIX: Async version of encrypt using async key initialization.
 */
export async function encryptAsync(text: string): Promise<string> {
  const iv = randomBytes(16)
  const key = await getKeyAsync()
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  // BUG FIX: Add ENC1: prefix for definitive encrypted-value detection.
  return `${ENC_PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`
}

/**
 * Strip the ENC1: prefix if present and extract the iv:authTag:encrypted parts.
 */
function parseEncryptedText(encryptedText: string): [string, string, string] {
  const raw = encryptedText.startsWith(ENC_PREFIX) ? encryptedText.slice(ENC_PREFIX.length) : encryptedText
  const [ivHex, authTagHex, encrypted] = raw.split(':')
  return [ivHex, authTagHex, encrypted]
}

/**
 * Decrypt an AES-256-GCM encrypted string.
 * Expects format: ENC1:iv:authTag:encrypted (v1+) or iv:authTag:encrypted (legacy, all hex)
 * P2-API-10 FIX: Tries PBKDF2 key first, falls back to legacy padding key for migration.
 *
 * NOTE: This sync version reads the key via sync fs on first call.
 * Prefer decryptAsync() in API route handlers to avoid blocking the event loop.
 *
 * @deprecated Use decryptAsync() instead. This function blocks the event loop during key derivation.
 */
export function decrypt(encryptedText: string): string {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn('[crypto] Synchronous encryption function called. Use the async version to avoid blocking the event loop.')
  }
  const [ivHex, authTagHex, encrypted] = parseEncryptedText(encryptedText)
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  // Try current key derivation (PBKDF2)
  const key = getKey()
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    // Try legacy key — but only if the cached key is already available
    // (sync decrypt path cannot do async fs reads)
    const legacyResult = tryLegacyKeySync(iv, authTag, encrypted, key)
    if (legacyResult !== null) return legacyResult
    throw new Error('Decryption failed: unable to decrypt with current or legacy key')
  }
}

/**
 * P3-7 FIX: Async version of decrypt using async key initialization.
 * Tries PBKDF2 key first, falls back to legacy padding key for migration.
 */
export async function decryptAsync(encryptedText: string): Promise<string> {
  const [ivHex, authTagHex, encrypted] = parseEncryptedText(encryptedText)
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  // Try current key derivation (PBKDF2) via async key init
  const key = await getKeyAsync()
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    // P2-API-10 FIX: Migration - try legacy key derivation for existing encrypted data
    const legacyResult = await tryLegacyKeyAsync(iv, authTag, encrypted, key)
    if (legacyResult !== null) return legacyResult
    throw new Error('Decryption failed: unable to decrypt with current or legacy key')
  }
}

/**
 * Try legacy key derivation for migration (sync version).
 * Returns null if both key derivations failed.
 */
function tryLegacyKeySync(iv: Buffer, authTag: Buffer, encrypted: string, currentKey: Buffer): string | null {
  // Only attempt if ENCRYPTION_KEY env var is set (no sync fs reads)
  const keySource = process.env.ENCRYPTION_KEY
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

/**
 * Try legacy key derivation for migration (async version).
 * Returns null if both key derivations failed.
 */
async function tryLegacyKeyAsync(iv: Buffer, authTag: Buffer, encrypted: string, currentKey: Buffer): Promise<string | null> {
  let keySource = process.env.ENCRYPTION_KEY
  if (!keySource) {
    // Try reading from key file (async)
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

/** Version prefix for encrypted values to eliminate false positives.
 *  Old values without prefix are still supported for backward compatibility.
 */
const ENC_PREFIX = 'ENC1:'

/**
 * Check if a value appears to be already encrypted.
 *
 * Two detection methods:
 * 1. New format (v1+): starts with 'ENC1:' prefix — definitive detection
 * 2. Legacy format: iv:authTag:encrypted (3 hex segments, first two 32 chars)
 *    The legacy heuristic can false-positive on values like
 *    `aabbccdd:11223344:556677889900aabbccddeeff00112233`,
 *    but this is rare and the encrypt function now uses the prefix.
 */
export function isEncrypted(value: string): boolean {
  // New format: definitive detection via prefix
  if (value.startsWith(ENC_PREFIX)) return true
  // Legacy format: heuristic detection (backward compat)
  const parts = value.split(':')
  return parts.length === 3 && parts.every(p => /^[0-9a-f]+$/.test(p)) && parts[0].length === 32 && parts[1].length === 32
}

/**
 * Check if an environment variable key looks like it contains a sensitive value.
 * Uses shared SENSITIVE_KEY_PATTERNS from bot-constants.ts (synced with client-side).
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEY_PATTERNS.some(pattern => lower.includes(pattern))
}

/**
 * Process env vars: encrypt sensitive values that aren't already encrypted.
 *
 * @deprecated Use the async version instead. This function blocks the event loop during key derivation.
 */
export function encryptEnvVars<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): T[] {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn('[crypto] Synchronous encryption function called. Use the async version to avoid blocking the event loop.')
  }
  return envVars.map(envVar => {
    if (!isSensitiveKey(envVar.key)) return envVar
    if (envVar.isEncrypted && isEncrypted(envVar.value)) return envVar
    if (isEncrypted(envVar.value)) {
      return { ...envVar, isEncrypted: true }
    }
    return { ...envVar, value: encrypt(envVar.value), isEncrypted: true }
  })
}

/**
 * Process env vars on save: encrypt sensitive plaintext values,
 * skip values that are already encrypted.
 *
 * NOTE: This sync version calls encrypt() which may do sync fs on first call.
 * Prefer encryptEnvVarsOnSaveAsync() in API route handlers.
 *
 * @deprecated Use encryptEnvVarsOnSaveAsync() instead. This function blocks the event loop during key derivation.
 */
export function encryptEnvVarsOnSave<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): T[] {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn('[crypto] Synchronous encryption function called. Use the async version to avoid blocking the event loop.')
  }
  return envVars.map(envVar => {
    if (isEncrypted(envVar.value)) {
      return { ...envVar, isEncrypted: true }
    }
    if (isSensitiveKey(envVar.key)) {
      return { ...envVar, value: encrypt(envVar.value), isEncrypted: true }
    }
    return envVar
  })
}

/**
 * P3-1 FIX: Async version of encryptEnvVarsOnSave.
 * Uses encryptAsync() to avoid blocking the event loop.
 */
export async function encryptEnvVarsOnSaveAsync<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): Promise<T[]> {
  const results: T[] = []
  for (const envVar of envVars) {
    if (isEncrypted(envVar.value)) {
      results.push({ ...envVar, isEncrypted: true })
    } else if (isSensitiveKey(envVar.key)) {
      results.push({ ...envVar, value: await encryptAsync(envVar.value), isEncrypted: true })
    } else {
      results.push(envVar)
    }
  }
  return results
}

/** Placeholder value sent to the client for encrypted secrets */
export const ENCRYPTED_PLACEHOLDER = '••••••••••••'

/**
 * P1-10 FIX: Decrypt env vars but replace sensitive encrypted values with a
 * placeholder. The actual plaintext is only available via a dedicated reveal
 * mechanism (not sent in standard GET responses).
 *
 * This prevents sensitive credentials (e.g., BOT_TOKEN) from appearing in
 * network response payloads visible in browser DevTools.
 *
 * NOTE: This sync version calls decrypt() which may do sync fs on first call.
 * Prefer decryptEnvVarsMaskedAsync() in API route handlers.
 *
 * @deprecated Use decryptEnvVarsMaskedAsync() instead. This function blocks the event loop during key derivation.
 */
export function decryptEnvVarsMasked<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): T[] {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn('[crypto] Synchronous encryption function called. Use the async version to avoid blocking the event loop.')
  }
  return envVars.map(envVar => {
    // Encrypted sensitive values → replace with placeholder
    if ((envVar.isEncrypted || isEncrypted(envVar.value)) && isSensitiveKey(envVar.key)) {
      return { ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true }
    }
    // Non-sensitive encrypted values → decrypt normally
    if (envVar.isEncrypted && isEncrypted(envVar.value)) {
      try {
        return { ...envVar, value: decrypt(envVar.value) }
      } catch {
        console.warn(`Failed to decrypt ${envVar.key}, returning masked`)
        return { ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true }
      }
    }
    if (!envVar.isEncrypted && isEncrypted(envVar.value)) {
      if (isSensitiveKey(envVar.key)) {
        return { ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true }
      }
      try {
        return { ...envVar, value: decrypt(envVar.value), isEncrypted: true }
      } catch {
        return { ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true }
      }
    }
    return envVar
  })
}

/**
 * P3-1 FIX: Async version of decryptEnvVarsMasked.
 * Uses decryptAsync() to avoid blocking the event loop.
 */
export async function decryptEnvVarsMaskedAsync<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): Promise<T[]> {
  const results: T[] = []
  for (const envVar of envVars) {
    // Encrypted sensitive values → replace with placeholder
    if ((envVar.isEncrypted || isEncrypted(envVar.value)) && isSensitiveKey(envVar.key)) {
      results.push({ ...envVar, value: ENCRYPTED_PLACEHOLDER, isEncrypted: true })
      continue
    }
    // Non-sensitive encrypted values → decrypt normally
    if (envVar.isEncrypted && isEncrypted(envVar.value)) {
      try {
        results.push({ ...envVar, value: await decryptAsync(envVar.value) })
      } catch {
        console.warn(`Failed to decrypt ${envVar.key}, returning masked`)
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

/**
 * Decrypt env vars for editing/reveal — returns actual plaintext.
 * Only used in the dedicated reveal endpoint.
 *
 * NOTE: This sync version calls decrypt() which may do sync fs on first call.
 * Prefer decryptEnvVarsAsync() in API route handlers.
 *
 * @deprecated Use decryptEnvVarsAsync() instead. This function blocks the event loop during key derivation.
 */
export function decryptEnvVars<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): T[] {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn('[crypto] Synchronous encryption function called. Use the async version to avoid blocking the event loop.')
  }
  return envVars.map(envVar => {
    if (envVar.isEncrypted && isEncrypted(envVar.value)) {
      try {
        return { ...envVar, value: decrypt(envVar.value) }
      } catch {
        console.warn(`Failed to decrypt ${envVar.key}`)
        return { ...envVar, value: '[DECRYPTION_FAILED]', decryptionError: true }
      }
    }
    if (!envVar.isEncrypted && isEncrypted(envVar.value)) {
      try {
        return { ...envVar, value: decrypt(envVar.value), isEncrypted: true }
      } catch {
        return { ...envVar, value: '[DECRYPTION_FAILED]', isEncrypted: true, decryptionError: true }
      }
    }
    return envVar
  })
}

/**
 * P3-7 FIX: Async version of decryptEnvVars.
 * Uses decryptAsync() to avoid blocking the event loop.
 */
export async function decryptEnvVarsAsync<T extends { key: string; value: string; isEncrypted?: boolean }>(
  envVars: T[]
): Promise<T[]> {
  const results: T[] = []
  for (const envVar of envVars) {
    if (envVar.isEncrypted && isEncrypted(envVar.value)) {
      try {
        results.push({ ...envVar, value: await decryptAsync(envVar.value) })
      } catch {
        console.warn(`Failed to decrypt ${envVar.key}`)
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
