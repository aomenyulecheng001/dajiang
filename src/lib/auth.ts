import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { createSession, validateSessionAsync, deleteSession, incrementTokenVersion, invalidateTokenVersionCache } from '@/lib/session'
import { writeFile } from 'fs/promises'
import { resolveFromProjectRoot } from '@/lib/project-root'
import { logger } from '@/lib/logger'

// Re-export session functions for other modules
export { validateSessionAsync, deleteSession }

// P2-API-11 FIX: Cache ensureDefaultAccount result to avoid unnecessary DB query on every login
let _accountCheckTime = 0
const ACCOUNT_CHECK_INTERVAL_MS = 60 * 1000
// BUG FIX (BUG-3): Promise cache to prevent concurrent account creation.
// Two simultaneous login requests could both pass the _accountCheckTime check
// and both attempt to create the default account, wasting bcrypt.hash CPU time.
// This promise ensures concurrent callers share the same initialization.
let _accountInitPromise: Promise<void> | null = null

/**
 * Ensure at least one admin account exists.
 * P3-2 FIX: Only creates account if NO accounts exist at all.
 * First-time setup generates a random password and logs it.
 * Previously hardcoded password 'dajiang888' is only used if
 * the ADMIN_INITIAL_PASSWORD env var is explicitly set.
 */
// DESIGN DECISION: This application uses a single-admin model. There is no
// public registration endpoint. Multi-user support would require adding
// /api/auth/register with invite-code or admin-approval flow.
export async function ensureDefaultAccount(): Promise<void> {
  // P2-API-11 FIX: Skip DB query after first successful call
  if (Date.now() - _accountCheckTime < ACCOUNT_CHECK_INTERVAL_MS) return

  // BUG FIX (BUG-3): Use promise cache to prevent concurrent initialization.
  // If another call is already running, await the same promise instead of
  // starting a second DB query + bcrypt.hash operation.
  if (_accountInitPromise) return _accountInitPromise

  _accountInitPromise = (async () => {
    try {
      const count = await db.account.count()
      if (count === 0) {
        // Check if an initial password was provided via env var
        const envPassword = process.env.ADMIN_INITIAL_PASSWORD
        let password: string

        // H7 FIX: Make default username configurable via ADMIN_INITIAL_USERNAME env var.
        // Previously hardcoded 'dajiang888' was predictable and made brute-force attacks easier.
        const envUsername = process.env.ADMIN_INITIAL_USERNAME
        const defaultUsername = (envUsername && envUsername.length >= 3) ? envUsername : 'dajiang888'
        
        if (envPassword && envPassword.length >= 6) {
          password = envPassword
          logger.warn('auth', 'Using ADMIN_INITIAL_PASSWORD from environment variable. Change this password after first login!')
        } else {
          // Generate a random 16-character password using Web Crypto API
          password = Array.from(crypto.getRandomValues(new Uint8Array(12)))
            .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
          const credFile = resolveFromProjectRoot('.admin-credentials')
          try {
            await writeFile(credFile,
              `Username: ${defaultUsername}\nPassword: ${password}\n\n⚠️ CHANGE THIS PASSWORD AFTER FIRST LOGIN!\n`,
              'utf-8')
            logger.warn('auth', 'Initial admin credentials written to .admin-credentials file. Delete after first login.')
          } catch {
            logger.warn('auth', 'Could not write .admin-credentials file. Check server logs for credentials.')
          }
        }

        const hashedPassword = await bcrypt.hash(password, 12)
        try {
          await db.account.create({
            data: {
              username: defaultUsername,
              password: hashedPassword,
            },
          })
        } catch (error: any) {
          // Handle race: another request may have created the account concurrently (P2002 = unique constraint)
          if (error?.code !== 'P2002') throw error
        }
      }
      // H1 FIX: Only set _accountCheckTime AFTER the successful DB check/create,
      // not before the DB write. Previously set early which meant a
      // failed DB write would permanently prevent account creation retries.
      _accountCheckTime = Date.now()
    } finally {
      _accountInitPromise = null
    }
  })()

  return _accountInitPromise
}

/**
 * Verify credentials and create a session token.
 */
export async function authenticateUser(
  username: string,
  password: string
): Promise<{ token: string; username: string } | null> {
  // Ensure at least one account exists
  await ensureDefaultAccount()

  const account = await db.account.findUnique({
    where: { username },
    select: { id: true, password: true, username: true, tokenVersion: true },
  })

  // SECURITY FIX: Always call bcrypt.compare even for non-existent users
  // to prevent timing-based user enumeration attacks. Without this, a
  // missing user returns in <1ms while a wrong password takes ~100ms.
  const DUMMY_HASH = '$2a$10$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const hashToCompare = account?.password || DUMMY_HASH

  const isValid = await bcrypt.compare(password, hashToCompare)
  if (!account || !isValid) return null

  try {
    const { unlink } = await import('fs/promises')
    const credPath = resolveFromProjectRoot('.admin-credentials')
    await unlink(credPath)
  } catch { /* File may not exist or already deleted */ }

  const token = createSession(account.id, account.username, account.tokenVersion)

  return { token, username: account.username }
}

/**
 * Reset a user's password. Requires the caller to be authenticated.
 * Returns the new password (plaintext) on success.
 *
 * BUG FIX: Uses userId instead of username for account lookup.
 * After a server restart, the in-memory revocation list is cleared,
 * so old tokens with stale usernames can pass validation again.
 * Using the immutable userId makes lookups robust against username changes.
 */
export async function resetPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentToken?: string
): Promise<{ success: boolean; message: string; newToken?: string }> {
  // Verify current password — lookup by userId (immutable) not username
  const account = await db.account.findUnique({ where: { id: userId } })
  if (!account) {
    return { success: false, message: 'User not found' }
  }

  const isValid = await bcrypt.compare(currentPassword, account.password)
  if (!isValid) {
    return { success: false, message: 'Current password is incorrect' }
  }

  // Password strength validation
  if (!newPassword || newPassword.length < 8) {
    return { success: false, message: 'New password must be at least 8 characters' }
  }

  // SECURITY FIX (SEC-83): Maximum password length to prevent memory exhaustion.
  // bcrypt truncates at 72 bytes anyway, but the full string is allocated before hashing.
  if (newPassword.length > 128) {
    return { success: false, message: 'New password must be 128 characters or less' }
  }

  if (!/[a-zA-Z]/.test(newPassword)) {
    return { success: false, message: 'New password must contain at least one letter' }
  }

  if (!/[0-9]/.test(newPassword)) {
    return { success: false, message: 'New password must contain at least one number' }
  }

  const hashedPassword = await bcrypt.hash(newPassword, 12)

  // SECURITY FIX (SEC-22): Use a single atomic DB update to ensure password
  // change and tokenVersion increment succeed together. Previously, these were
  // separate operations and incrementTokenVersion could fail silently, leaving
  // old session tokens from other devices valid after a password change.
  const updatedAccount = await db.account.update({
    where: { id: userId },
    data: {
      password: hashedPassword,
      tokenVersion: { increment: 1 },
    },
    select: { tokenVersion: true, username: true },
  })

  // Invalidate the in-memory cache so the next token validation picks up
  // the new tokenVersion from the DB, rejecting all old session tokens.
  invalidateTokenVersionCache(userId)

  // BUG FIX (BUG-8): Revoke old token and issue a new one with the updated tokenVersion,
  // same pattern as updateUsername(). Previously, the old token was deleted but no new
  // token was issued, causing the user's session to immediately expire and forcing
  // re-login. This was inconsistent with the username change flow and poor UX.
  let newToken: string | undefined
  if (currentToken) {
    await deleteSession(currentToken)
    // Get the updated tokenVersion from the atomic update result
    if (updatedAccount) {
      newToken = createSession(userId, updatedAccount.username, updatedAccount.tokenVersion)
    }
  }

  return { success: true, message: 'Password changed successfully', newToken }
}

/**
 * Update a user's username. Requires the caller to be authenticated.
 * Returns the new username and a new session token on success.
 * H2 FIX: Re-issues the session token with the new username so subsequent
 * API calls don't fail due to the stale username in the old token.
 *
 * BUG FIX: Uses userId instead of username for account lookup.
 * After a server restart, the in-memory revocation list is cleared,
 * so old tokens with stale usernames can pass validation again.
 * Using the immutable userId makes lookups robust against username changes.
 */
export async function updateUsername(
  userId: string,
  newUsername: string,
  currentToken?: string
): Promise<{ success: boolean; message: string; username?: string; newToken?: string }> {
  // Validate new username
  if (!newUsername || newUsername.length < 3) {
    return { success: false, message: 'Username must be at least 3 characters' }
  }

  if (newUsername.length > 30) {
    return { success: false, message: 'Username must be at most 30 characters' }
  }

  if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) {
    return { success: false, message: 'Username can only contain letters, numbers, and underscores' }
  }

  // Find current account — lookup by userId (immutable) not username
  const account = await db.account.findUnique({ where: { id: userId } })
  if (!account) {
    return { success: false, message: 'User not found' }
  }

  // Check if new username is the same as current
  if (account.username === newUsername) {
    return { success: false, message: 'New username is the same as current username' }
  }

  // Check if new username is already taken
  const existing = await db.account.findUnique({ where: { username: newUsername } })
  if (existing) {
    return { success: false, message: 'Username is already taken' }
  }

  // M3 FIX: Handle TOCTOU race — two concurrent requests could pass the
  // uniqueness check and one will hit P2002. Catch it gracefully.
  // SECURITY FIX (SEC-27): Atomic update — change username + increment
  // tokenVersion in a single DB operation so they always succeed or fail together.
  let updatedTokenVersion: number
  try {
    const updatedAccount = await db.account.update({
      where: { id: account.id },
      data: {
        username: newUsername,
        tokenVersion: { increment: 1 },
      },
      select: { tokenVersion: true },
    })
    updatedTokenVersion = updatedAccount.tokenVersion
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return { success: false, message: 'Username is already taken' }
    }
    throw error
  }

  invalidateTokenVersionCache(account.id)

  // H2 FIX: Revoke old token and issue a new one with the updated username.
  let newToken: string | undefined
  if (currentToken) {
    await deleteSession(currentToken)
    newToken = createSession(account.id, newUsername, updatedTokenVersion)
  }

  return { success: true, message: 'Username updated successfully', username: newUsername, newToken }
}
