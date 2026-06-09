# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Main app (Next.js 16 with Bun)
bun run dev          # Start dev server on port 3000
bun run build        # Production build (standalone output)
bun run start        # Start production server
bun run lint         # ESLint

# Database (SQLite via Prisma)
bun run db:push      # Push schema to DB without migration
bun run db:generate  # Regenerate Prisma client
bun run db:migrate   # Create and apply migration
bun run db:reset     # Reset DB (drop all tables, re-apply migrations)

# Bot Runner (separate microservice)
cd mini-services/bot-runner
# tsx must be available (npx tsx, bunx tsx, or globally installed)
tsx --watch index.ts     # Dev mode (port 3001 by default, configurable via PORT)
tsx index.ts             # Production mode
```

## Architecture Overview

This is a **Telegram bot factory** — a web app that lets a single admin create, configure, deploy, and monitor multiple Telegram bots without writing infrastructure code. Bots are defined via UI (code blocks, dependencies, env vars, config) and executed as child processes by the bot-runner microservice.

### Two-Process Architecture

- **Next.js 16 app** (`src/`, port 3000) — React frontend + API routes. Handles auth, CRUD for bots, webhook reception, env var encryption, and DB access.
- **Bot Runner** (`mini-services/bot-runner/`, default port 3001) — Standalone Node.js service with Socket.IO. Manages child processes that actually run bot code. Uses `tsx` for execution. Generates bot project files, installs deps (`npm install`/`pip install`), starts/stops/restarts processes, monitors health, streams logs.

The Next.js app communicates with the bot-runner via HTTP (for deploy/control commands) and Socket.IO (for real-time log streaming and status updates). The bot-runner is authenticated via a shared `runner-secret` file (auto-generated in `mini-services/bot-runner/config/runner-secret`).

### Request Flow

```
Browser → Next.js (port 3000)
              │
              ├── middleware.ts (rate limit + auth, Edge Runtime)
              ├── API routes (src/app/api/)
              │     ├── /api/auth/*       — login, session, account mgmt
              │     ├── /api/bots/[id]/*  — bot CRUD, logs, env vars, stats
              │     ├── /api/webhook/[botId] — Telegram webhook receiver
              │     ├── /api/git-import   — import bot from git repos
              │     └── /api/health       — health check
              │
              └── Bot Runner (port 3001)
                    ├── HTTP: deploy, start, stop, restart, health, cleanup bots
                    ├── HTTP: /webhook/[botId] — receives proxied Telegram updates
                    └── Socket.IO: real-time logs, process status, resource data,
                                  deploy progress, bot messages
```

### Data Flow: Deploying a Bot

1. User clicks "Deploy" → frontend calls `POST /api/bots/[id]` to save current state, then sends deploy config to bot-runner via `POST /deploy`
2. Bot-runner generates project files from `codeBlocks` or `projectFiles` (zip upload), writes to `bots/[botId]/`, installs dependencies, starts the process
3. Bot-runner emits Socket.IO events (`log`, `status`, `resourceData`, `deploy:progress`) back to the Next.js frontend
4. Webhook endpoint (`POST /api/webhook/[botId]`) proxies incoming Telegram updates to the bot-runner's `/webhook/[botId]` endpoint

### Deploy Pipeline Stages

```
idle → codeGen → installDeps → build → start → running → error
```

- **codeGen**: Generates project files (code, package.json, .env, tsconfig.json for TS bots). Path-traversal protection enforced.
- **installDeps**: Incremental install by default — hashes dependencies, only installs changed packages. Falls back to full install on failure. 120s timeout.
- **build** (TypeScript only): Runs `tsc --noEmit` with 30s timeout. Type errors are **warnings, not fatal** — the bot will still start.
- **start**: Spawns the bot process. TS bots use `tsx` with `--max-old-space-size=256`. JS bots use the newest Node.js ≥16 found on the system.
- **running**: Bot stays alive for >2s after spawn.

### Key Runtime Constraints

- **Middleware runs in Edge Runtime** — no Node.js APIs (`fs`, `process.cwd()`, `crypto.createHmac`). Use Web Crypto API (`crypto.subtle`) for auth. Two session modules exist: `session.ts` (Node.js) and `session-edge.ts` (Edge) — both must verify tokens identically.
- **Edge Runtime token version check**: The Edge Runtime cannot query Prisma/SQLite directly. Instead, `session-edge.ts` makes an HTTP POST to `/api/auth/token-version` (on localhost) using `INTERNAL_API_SECRET` for authentication. This endpoint returns the current `tokenVersion` from the Account table. Fail-closed: if the API is unreachable, tokens are rejected.
- **SQLite** — single-file database. Dev uses `prisma/data/bot-factory.db`, production uses `db/custom.db` (configured via `DATABASE_URL` in `.env`). Deploy scripts set DATABASE_URL to an absolute path to avoid resolution issues in standalone mode. JSON fields (`codeBlocks`, `dependencies`, `envVars`, `config`, `stats`, `projectFiles`) are stored as JSON-encoded strings (no native JSON type in SQLite). Parse/serialize in API helpers.
- **Production DB URL** includes pragmas: `?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000`. All SQLite PRAGMA statements that return results must use `db.$queryRawUnsafe()` (not `$executeRawUnsafe()`).
- **Standalone output** — Next.js configured with `output: "standalone"`. The build script copies static files and public assets into `.next/standalone/` manually.

### Auth & Security

- **Stateless HMAC-signed session tokens** — `base64url(JSON({userId, username, createdAt, tokenVersion})) + "." + hex(hmac)`. Works in both Edge and Node.js because both use the Web Crypto API.
- **Middleware-enforced auth** — all `/api/*` routes except public ones (login, session, health, webhooks) require a valid session token. Individual route handlers don't need to check auth separately.
- **HMAC_SECRET** env var is required — both runtimes must use the same key. A fallback file-based secret (`.hmac-secret`) exists for dev only. In production, missing HMAC_SECRET causes the Node.js runtime to `process.exit(1)`.
- **AES-256-GCM encryption** for env var values — keys are derived from `ENCRYPTION_KEY` env var. Encrypted values are stored as hex strings. Env vars can be masked (●●●) or fully revealed via dedicated endpoint.
- **CSRF protection** via custom header requirement on state-changing endpoints.
- **Single-admin model** — no public registration. Default account created on first startup; password set via `ADMIN_INITIAL_PASSWORD` or randomly generated.
- **Token revocation**: `deleteSession()` persists revoked token signatures to `.revoked-tokens` file. `incrementTokenVersion()` bumps the tokenVersion in DB, invalidating all existing tokens for that user (survives restarts). Token version is cached in memory with 10s TTL (Node.js) / 30s TTL (Edge).
- **Content-Security-Policy**: Defined in `next.config.ts` with per-request nonce support (currently using `'unsafe-inline'` for scripts/styles as a stepping stone). Strict CSP headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`.
- **Rate limiting**: IP-based in middleware with per-route configs. Supports `TRUSTED_PROXIES` for accurate client IP extraction behind reverse proxies (e.g., Nginx).

### Bot-Runner Auth Model

- **runner-secret**: Auto-generated 32-byte hex secret stored in `mini-services/bot-runner/config/runner-secret`. Created on first startup. Both Next.js API and Socket.IO clients must present this token.
- **Socket.IO**: Token required in handshake auth (`socket.handshake.auth.token`). Verified with timing-safe SHA-256 hash comparison.
- **HTTP endpoints**: Authenticated via `X-Runner-Secret` header (timing-safe hash comparison). Unauthenticated if runner-secret is empty (dev only; production refuses to start).
- **Webhook verification**: Supports both HMAC signature (`X-Webhook-Signature: sha256=...`) and forwarded secret (`X-Webhook-Secret`) headers.
- **CORS**: Socket.IO allows origins from `SERVER_ORIGIN` env var (plus localhost:* in dev). Production with no SERVER_ORIGIN rejects all cross-origin connections.

### State Management (Zustand)

- **`botStore`** — all bot CRUD, optimistic UI updates. The single source of truth for the bot list. Uses `authFetch` wrapper for API calls. Has pagination, sorting, filtering.
- **`authStore`** — login state, session token, session verification.
- **`useI18nStore`** — locale persistence (zh/en), persisted to localStorage.

### Frontend Component Structure

- `src/app/page.tsx` — main dashboard: bot grid/list, create/edit dialogs, keyboard shortcuts, command palette.
- `src/components/bot-factory/` — bot-centric components (cards, detail view, create/edit dialogs, header).
- `src/components/bot-factory/tabs/` — tab content for bot detail: code editor, config, dependencies, env vars, logs, monitoring, overview.
- `src/components/ui/` — shadcn/ui primitives (buttons, dialogs, selects, etc.).

### Bot Runner Internals

- **Process lifecycle**: `deploy.ts` handles the full deploy pipeline (code gen → npm/pip install → tsc check → start process). `process-manager.ts` manages child processes with auto-restart logic (exponential backoff, max 5 restarts/hour), fast-fail detection (bots exiting <10s get only 1 restart), heartbeat monitoring, and graceful shutdown.
- **Memory management**: Each bot process limited to `--max-old-space-size=256` (Node.js/TS) or 256MB `maxMemoryMb` watchdog. Monitor collects per-process and system-wide CPU/memory. Memory-killed bots are auto-restarted (not treated as intentional stop).
- **Socket.IO**: `socket.ts` sets up the HTTP+WS server with auth middleware. `handlers.ts` registers event handlers for client connections (log streaming, process control, deploy commands).
- **Log management**: `log-manager.ts` writes logs to disk with 6-hour cleanup of old files.
- **Monitoring**: `monitor.ts` collects CPU/memory per process and system-wide, emits `resourceData` events.
- **Templates**: `templates/` directory contains starter bot code for different bot types.
- **Startup recovery**: On boot, bot-runner scans `config/*.json` for saved bot configs, auto-restarts bots that have a `.running` marker file (with configurable batching via `AUTO_START_BATCH_SIZE` and `AUTO_START_BATCH_DELAY_MS` env vars).
- **PID file mechanism**: Each bot process writes a `.pid` file in its working directory. Before starting any bot, `findAndKillOrphan()` checks for orphan processes (child processes that survived a bot-runner crash) and kills them to prevent TCP port conflicts. PID files are cleaned up on normal exit, stop, and deletion.
- Bot working directories live in `mini-services/bot-runner/bots/[botId]/`.
- Bot configs persist in `mini-services/bot-runner/config/[botId].json`.
- **TypeScript bots**: Deploy generates an optimized `tsconfig.json` (ES2022 target, commonjs module, skipLibCheck, strict:false) to prevent `tsc --noEmit` from hanging on low-memory VPS.

### Database Schema (Prisma)

Four models: **Account** (single admin user with `tokenVersion` for session invalidation), **Bot** (all bot metadata, code, config as JSON strings; composite index on `[ownerId, updatedAt DESC]`), **BotLog** (structured log entries with `[botId, timestamp, level]` index), and **BotMessage** (recorded messages per bot/user with compound indexes).

## Environment Variables

Key env vars (see `.env` and `.env.production` for full reference):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite file path (supports pragma query params) |
| `HMAC_SECRET` | 32+ char secret for session token signing (required) |
| `ENCRYPTION_KEY` | 32+ char secret for AES-256-GCM env var encryption |
| `INTERNAL_API_SECRET` | Shared secret for Edge Runtime → Node.js API calls (production only) |
| `BOT_RUNNER_URL` | URL to bot-runner HTTP API (e.g., `http://127.0.0.1:3001`) |
| `ADMIN_INITIAL_USERNAME` / `ADMIN_INITIAL_PASSWORD` | Default admin credentials on first boot |
| `SERVER_ORIGIN` | Public-facing origin for CORS and Socket.IO (e.g., `https://example.com`) |
| `TRUSTED_PROXIES` | Comma-separated proxy IPs for accurate rate-limit client IP extraction |
| `PROTOCOL` | Set to `https` to enable HSTS header in production |
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `ALLOW_BOT_AUTO_CLAIM` | Feature flag: enable/disable bot auto-claim (default `false`) |
| `PORT` | Next.js server port (default 3000). Bot-runner uses its own PORT env var (default 3001). |
| `NEXT_PUBLIC_APP_URL` | Used by Edge Runtime for loopback API calls (dev falls back to `localhost:3000`) |
| `PROJECT_ROOT` | Absolute path to project root, used for resolving `.hmac-secret` and `.revoked-tokens` files in standalone mode |
