import { createServer, type Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server as SocketIOServer } from 'socket.io'
import { randomBytes, timingSafeEqual, createHash } from 'crypto'
import { logger } from './logger'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ─── Runner Secret Management ─────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CONFIG_DIR = join(__dirname, 'config')
const SECRET_FILE = join(CONFIG_DIR, 'runner-secret')

/**
 * Get or generate the runner secret used for Socket.IO authentication.
 * This secret is shared between the Next.js backend and the bot-runner service.
 */
function getRunnerSecret(): string {
  if (existsSync(SECRET_FILE)) {
    return readFileSync(SECRET_FILE, 'utf-8').trim()
  }
  // Generate a new secret and persist it
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dirname(SECRET_FILE), { recursive: true })
  writeFileSync(SECRET_FILE, secret, 'utf-8')
  // SECURITY FIX: Restrict file permissions to owner-only (0o600).
  // Without this, the default 0644 permission allows any system user to read
  // the Socket.IO authentication secret, enabling unauthorized connections.
  try { chmodSync(SECRET_FILE, 0o600) } catch { /* ignore on Windows */ }
  return secret
}

const RUNNER_SECRET = getRunnerSecret()

/** Export the secret so the Next.js API can read it when starting the service */
export { getRunnerSecret }

// ─── HTTP Server & Socket.IO ──────────────────────────────────────────────

/** Create and export the HTTP server and Socket.IO instance */
export const httpServer: HTTPServer = createServer()

const ALLOWED_ORIGINS = (() => {
  // Allow SERVER_ORIGIN env var for custom deployments
  // Supports both HTTP and HTTPS deployments (e.g., http://1.2.3.4:3000 or https://yourdomain.com)
  const serverOrigin = process.env.SERVER_ORIGIN
  const isDev = process.env.NODE_ENV !== 'production'
  const origins: string[] = []
  // P2-HTTP-2 FIX: Only include localhost origins in development mode.
  // In production, these should not be exposed to prevent CORS policy leakage.
  if (isDev) {
    origins.push('http://localhost:3000', 'http://127.0.0.1:3000')
  }
  if (serverOrigin) {
    const trimmed = serverOrigin.endsWith('/') ? serverOrigin.slice(0, -1) : serverOrigin
    origins.push(trimmed)
    if (isDev) {
      if (trimmed.startsWith('https://')) {
        origins.push(trimmed.replace('https://', 'http://'))
      } else if (trimmed.startsWith('http://')) {
        origins.push(trimmed.replace('http://', 'https://'))
      }
    }
  }
  // Fallback: if no origins are configured, allow localhost (safe default for dev)
  if (origins.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('socket', 'No CORS origins configured in production. Set SERVER_ORIGIN env var. Rejecting all origins.')
    } else {
      origins.push('http://localhost:3000', 'http://127.0.0.1:3000')
    }
  }
  return origins
})()

export const io = new SocketIOServer(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
  // Use the default Socket.IO path '/socket.io/' so that:
  // 1. The client (which uses the default path) can connect
  // 2. Custom HTTP routes (/health, /webhook/, /cleanup/) don't conflict with Socket.IO
  // Connection stability: increase ping intervals to handle slow networks/proxies
  pingInterval: 30000,  // 30s between pings (default: 25s) — reduces unnecessary traffic
  pingTimeout: 30000,   // 30s before considering connection dead (default: 20s) — more tolerant of slow networks
  connectTimeout: 15000, // 15s connection timeout (default: 20s)
  // Allow upgrading from polling to websocket for better reliability through proxies
  allowUpgrades: true,
  // Increase max payload for deploy operations with large project files
  maxHttpBufferSize: 5e6, // 5MB (default: 1MB)
})

// ─── P0-3 FIX: Socket.IO Authentication Middleware ───────────────────────
// Reject all connections that don't provide the correct RUNNER_SECRET token.
// The token is passed via `auth.token` in the Socket.IO handshake.

// P2-BR-3/P2-API-3 FIX: Use timing-safe comparison for Socket.IO auth token
// CRITICAL FIX: Hash both values with SHA-256 before comparing so that
// timingSafeEqual always receives equal-length buffers (32 bytes). The previous
// raw-buffer comparison required the token and RUNNER_SECRET to have the same
// byte length — if they differed (e.g. due to env-var override, file encoding,
// or the API returning an empty string when the secret file is missing),
// timingSafeEqual would reject the connection AND leak the expected length
// through the early `a.length !== b.length` check. Hashing eliminates both
// the length-mismatch crash risk and the timing side-channel.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined
  if (!token) {
    logger.warn('socket', `Rejected unauthorized connection from ${socket.handshake.address}`)
    return next(new Error('Authentication required'))
  }
  // Hash both values so timingSafeEqual always compares equal-length buffers
  const tokenHash = createHash('sha256').update(token, 'utf-8').digest()
  const secretHash = createHash('sha256').update(RUNNER_SECRET, 'utf-8').digest()
  if (!timingSafeEqual(tokenHash, secretHash)) {
    logger.warn('socket', `Rejected unauthorized connection from ${socket.handshake.address}`)
    return next(new Error('Authentication required'))
  }
  next()
})
