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

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
else if (!globalForPrisma.prisma) globalForPrisma.prisma = db

// SQLite performance and reliability PRAGMAs.
// These must run AFTER the client is created but BEFORE any queries.
// - WAL mode: enables concurrent reads during writes (vs default DELETE journal)
// - busy_timeout: wait up to 5s instead of immediately throwing "database is locked"
// - journal_size_limit: cap WAL file at 64MB to prevent unbounded growth
// - synchronous=NORMAL: safe enough with WAL + checkpoint, much faster than FULL
// - cache_size: 64MB page cache for better read performance
// - foreign_keys=ON: enable CASCADE deletes (SQLite defaults to OFF)
let _pragmasPromise: Promise<void> | null = null
export async function applySqlitePragmas(): Promise<void> {
  if (_pragmasPromise) return _pragmasPromise
  _pragmasPromise = (async () => {
    try {
      // All PRAGMAs that might return results use $queryRawUnsafe
      await db.$queryRawUnsafe('PRAGMA journal_mode=WAL')
      await db.$queryRawUnsafe('PRAGMA busy_timeout=5000')
      await db.$queryRawUnsafe('PRAGMA journal_size_limit=67108864')
      await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
      await db.$queryRawUnsafe('PRAGMA cache_size=-64000')
      await db.$queryRawUnsafe('PRAGMA foreign_keys=ON')
    } catch {
      // Non-fatal: PRAGMA errors mean SQLite is working with defaults
    }
  })()
  return _pragmasPromise
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
    const logResult = await db.botLog.deleteMany({
      where: { timestamp: { lt: cutoff } },
    })
    const msgResult = await db.botMessage.deleteMany({
      where: { timestamp: { lt: cutoff } },
    })
    if (logResult.count > 0 || msgResult.count > 0) {
      console.log(`[DB-Cleanup] Deleted ${logResult.count} logs, ${msgResult.count} messages older than ${LOG_RETENTION_DAYS} days`)
    }
    // VACUUM to reclaim disk space after mass deletes
    await db.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
    await db.$executeRawUnsafe('VACUUM')
  } catch {
    // Non-fatal: cleanup will retry on next interval
  }
}

const _cleanupTimer = setInterval(cleanupOldRecords, CLEANUP_INTERVAL_MS)
if (_cleanupTimer.unref) _cleanupTimer.unref()
// Run first cleanup after 5 minutes (give server time to start)
setTimeout(cleanupOldRecords, 5 * 60 * 1000)
