import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error', 'warn'],
  })

if (!globalForPrisma.prisma) globalForPrisma.prisma = db

// SQLite performance and reliability PRAGMAs.
// These must run AFTER the client is created but BEFORE any queries.
// - WAL mode: enables concurrent reads during writes (vs default DELETE journal)
// - busy_timeout: wait up to 5s instead of immediately throwing "database is locked"
// - journal_size_limit: cap WAL file at 64MB to prevent unbounded growth
// - synchronous=NORMAL: safe enough with WAL + checkpoint, much faster than FULL
// - cache_size: 64MB page cache for better read performance
// - foreign_keys=ON: enable CASCADE deletes (SQLite defaults to OFF)
let _pragmaPromise: Promise<void> | null = null

export async function applySqlitePragmas(): Promise<void> {
  if (_pragmaPromise) return _pragmaPromise
  _pragmaPromise = (async () => {
    try {
      await db.$queryRawUnsafe('PRAGMA journal_mode=WAL')
      await db.$executeRawUnsafe('PRAGMA busy_timeout=5000')
      await db.$executeRawUnsafe('PRAGMA journal_size_limit=67108864')
      await db.$executeRawUnsafe('PRAGMA synchronous=NORMAL')
      await db.$executeRawUnsafe('PRAGMA cache_size=-64000')
      await db.$executeRawUnsafe('PRAGMA foreign_keys=ON')
    } catch (err) {
      _pragmaPromise = null
      console.error('[DB] PRAGMA application failed — SQLite will use defaults. foreign_keys may be OFF, meaning CASCADE deletes will not work:', err instanceof Error ? err.message : err)
    }
  })()
  return _pragmaPromise
}

// Auto-apply on first import (safe for both dev and production)
applySqlitePragmas().catch(() => {})

// Periodic cleanup of old BotLog and BotMessage records.
// Runs every 6 hours, deletes records older than 30 days.
// This prevents unbounded table growth that would slow queries and fill disk.
const LOG_RETENTION_DAYS = 30
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

async function cleanupOldRecords(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const BATCH_SIZE = 1000
    let totalLogs = 0
    let totalMsgs = 0

    // Batch delete BotLog records to avoid long write locks on large tables
    let deleted: number
    do {
      const result = await db.$executeRaw`DELETE FROM BotLog WHERE rowid IN (SELECT rowid FROM BotLog WHERE timestamp < ${cutoff} LIMIT ${BATCH_SIZE})`
      deleted = result
      totalLogs += deleted
      if (deleted > 0) await new Promise(r => setTimeout(r, 50))
    } while (deleted >= BATCH_SIZE)

    // Batch delete BotMessage records
    do {
      const result = await db.$executeRaw`DELETE FROM BotMessage WHERE rowid IN (SELECT rowid FROM BotMessage WHERE timestamp < ${cutoff} LIMIT ${BATCH_SIZE})`
      deleted = result
      totalMsgs += deleted
      if (deleted > 0) await new Promise(r => setTimeout(r, 50))
    } while (deleted >= BATCH_SIZE)

    if (totalLogs > 0 || totalMsgs > 0) {
      console.log(`[DB-Cleanup] Deleted ${totalLogs} logs, ${totalMsgs} messages older than ${LOG_RETENTION_DAYS} days`)
      try {
        await db.$queryRawUnsafe('PRAGMA wal_checkpoint(PASSIVE)')
      } catch { /* Non-fatal: checkpoint may fail with active readers */ }
    }
  } catch {
    // Non-fatal: cleanup will retry on next interval
  }
}

const _cleanupTimer = setInterval(cleanupOldRecords, CLEANUP_INTERVAL_MS)
if (_cleanupTimer.unref) _cleanupTimer.unref()
// Run first cleanup after 5 minutes (give server time to start)
const _initialCleanupTimer = setTimeout(cleanupOldRecords, 5 * 60 * 1000)
if (_initialCleanupTimer.unref) _initialCleanupTimer.unref()
