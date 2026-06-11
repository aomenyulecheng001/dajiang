import { PrismaClient } from '@prisma/client'
import { logger } from '@/lib/logger'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  dbExtended: unknown
}

// P5 FIX: SQLite is a single-writer database. Multiple connections waste
// file descriptors and increase "database is locked" contention without
// any throughput benefit. connection_limit=1 serializes all writes through
// one connection while WAL mode allows concurrent reads.
const DATABASE_URL_WITH_LIMIT =
  process.env.DATABASE_URL + (process.env.DATABASE_URL?.includes('?') ? '&' : '?') + 'connection_limit=1'

// Raw PrismaClient — used ONLY for PRAGMA execution and internal cleanup.
// Application code must use the exported `db` (the extended client below).
const _rawDb =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error', 'warn'],
    datasources: {
      db: {
        url: DATABASE_URL_WITH_LIMIT,
      },
    },
  })

if (!globalForPrisma.prisma) globalForPrisma.prisma = _rawDb

// SQLite performance and reliability PRAGMAs.
// These must run AFTER the client is created but BEFORE any queries.
// - WAL mode: enables concurrent reads during writes (vs default DELETE journal)
// - busy_timeout: wait up to 5s instead of immediately throwing "database is locked"
// - journal_size_limit: cap WAL file at 64MB to prevent unbounded growth
// - synchronous=NORMAL: safe enough with WAL + checkpoint, much faster than FULL
// - cache_size: 64MB page cache for better read performance
// - foreign_keys=ON: enable CASCADE deletes (SQLite defaults to OFF)
let _pragmaPromise: Promise<void> | null = null

async function applySqlitePragmas(): Promise<void> {
  if (_pragmaPromise) return _pragmaPromise
  _pragmaPromise = (async () => {
    try {
      await _rawDb.$queryRawUnsafe('PRAGMA journal_mode=WAL')
      await _rawDb.$queryRawUnsafe('PRAGMA busy_timeout=5000')
      await _rawDb.$queryRawUnsafe('PRAGMA journal_size_limit=67108864')
      await _rawDb.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
      await _rawDb.$queryRawUnsafe('PRAGMA cache_size=-64000')
    } catch (err) {
      logger.error('db', 'Performance PRAGMAs failed — SQLite will use defaults.', err instanceof Error ? err.message : err)
    }
    // CRITICAL FIX: foreign_keys=ON is applied separately and fatally.
    // Previously all PRAGMAs shared one try/catch — if journal_mode failed,
    // foreign_keys was also skipped, silently disabling CASCADE deletes.
    // Without foreign_keys, deleting a Bot leaves orphaned BotLog/BotMessage rows.
    try {
      await _rawDb.$queryRawUnsafe('PRAGMA foreign_keys=ON')
    } catch (err) {
      _pragmaPromise = null
      logger.error('db', 'FATAL: Could not enable foreign_keys. CASCADE deletes will not work.', err instanceof Error ? err.message : err)
      throw new Error('[DB] FATAL: foreign_keys=ON failed — refusing to run without CASCADE support')
    }
  })()
  return _pragmaPromise
}

// P1 FIX: Use Prisma $extends middleware to guarantee that every query waits
// for PRAGMAs to complete before executing. Previously, applySqlitePragmas()
// was called with .catch(() => {}) on module import — but nothing prevented
// the first HTTP request from querying the DB before PRAGMAs finished.
// Without this, foreign_keys=ON might not be active, silently disabling
// CASCADE deletes and leaving orphaned rows.
//
// The extended client uses _rawDb internally (not itself), so the middleware
// does not cause infinite recursion: middleware → applySqlitePragmas() →
// _rawDb.$queryRawUnsafe (raw client, no middleware).
const _extendedDb = _rawDb.$extends({
  query: {
    async $allOperations({ args, query }) {
      await applySqlitePragmas()
      return query(args)
    },
  },
})

// Export the extended client as `db` — all application code gets the pragma guard.
export const db = _extendedDb as typeof _rawDb

// Auto-apply PRAGMAs on first import (safe for both dev and production)
applySqlitePragmas().catch(() => {})

// Periodic cleanup of old BotLog and BotMessage records.
// Runs every 6 hours, deletes records older than 30 days.
// This prevents unbounded table growth that would slow queries and fill disk.
const LOG_RETENTION_DAYS = 30
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

// P2 FIX: Mutex flag to prevent concurrent cleanup executions.
// Without this, if a cleanup takes longer than CLEANUP_INTERVAL_MS (e.g.,
// very large tables), the next interval tick would start a second concurrent
// cleanup, causing SQLite write-lock contention.
let _cleanupRunning = false

async function cleanupOldRecords(): Promise<void> {
  if (_cleanupRunning) return
  _cleanupRunning = true
  try {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const BATCH_SIZE = 1000
    let totalLogs = 0
    let totalMsgs = 0

    // Batch delete BotLog records to avoid long write locks on large tables
    let deleted: number
    do {
      const result = await _rawDb.$executeRaw`DELETE FROM BotLog WHERE rowid IN (SELECT rowid FROM BotLog WHERE timestamp < ${cutoff} LIMIT ${BATCH_SIZE})`
      deleted = result
      totalLogs += deleted
      if (deleted > 0) await new Promise(r => setTimeout(r, 10))
    } while (deleted >= BATCH_SIZE)

    // Batch delete BotMessage records
    do {
      const result = await _rawDb.$executeRaw`DELETE FROM BotMessage WHERE rowid IN (SELECT rowid FROM BotMessage WHERE timestamp < ${cutoff} LIMIT ${BATCH_SIZE})`
      deleted = result
      totalMsgs += deleted
      if (deleted > 0) await new Promise(r => setTimeout(r, 10))
    } while (deleted >= BATCH_SIZE)

    if (totalLogs > 0 || totalMsgs > 0) {
      logger.info('db', `Deleted ${totalLogs} logs, ${totalMsgs} messages older than ${LOG_RETENTION_DAYS} days`)
      try {
        await _rawDb.$queryRawUnsafe('PRAGMA wal_checkpoint(PASSIVE)')
      } catch { /* Non-fatal: checkpoint may fail with active readers */ }
    }
  } catch (err) {
    logger.warn('db', 'Log cleanup failed — will retry on next interval.',
      err instanceof Error ? err.message : String(err))
  } finally {
    _cleanupRunning = false
  }
}

const _cleanupTimer = setInterval(cleanupOldRecords, CLEANUP_INTERVAL_MS)
if (_cleanupTimer.unref) _cleanupTimer.unref()
// Run first cleanup after 5 minutes (give server time to start)
const _initialCleanupTimer = setTimeout(cleanupOldRecords, 5 * 60 * 1000)
if (_initialCleanupTimer.unref) _initialCleanupTimer.unref()

// P7 FIX: Graceful shutdown — call _rawDb.$disconnect() on SIGTERM/SIGINT.
// Without this, killing the process during a write can leave the WAL file
// in an inconsistent state. $disconnect() flushes pending writes and
// releases the database connection cleanly.
function gracefulShutdown(signal: string) {
  _rawDb.$disconnect()
    .then(() => {
      logger.info('db', `Graceful shutdown on ${signal}`)
      process.exit(0)
    })
    .catch((err) => {
      logger.error('db', 'Error during graceful shutdown', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
