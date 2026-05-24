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

# Bot Runner (separate microservice)
cd mini-services/bot-runner
bun run dev          # Start bot-runner in watch mode (port 3001)
bun run start        # Start bot-runner
```

## Architecture Overview

This is a **Telegram bot factory** — a web app that lets a single admin create, configure, deploy, and monitor multiple Telegram bots without writing infrastructure code. Bots are defined via UI (code blocks, dependencies, env vars, config) and executed as child processes by the bot-runner microservice.

### Two-Process Architecture

- **Next.js 16 app** (`src/`, port 3000) — React frontend + API routes. Handles auth, CRUD for bots, webhook reception, env var encryption, and DB access.
- **Bot Runner** (`mini-services/bot-runner/`, port 3001) — Standalone Node.js service with Socket.IO. Manages child processes that actually run bot code. Generates bot project files, installs deps (`npm install`/`pip install`), starts/stops/restarts processes, monitors health, streams logs.

The Next.js app communicates with the bot-runner via HTTP (for deploy/control commands) and Socket.IO (for real-time log streaming and status updates). The bot-runner is authenticated via a shared `runner-secret` token.

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
                    ├── HTTP: deploy, start, stop, restart bots
                    └── Socket.IO: real-time logs, process status, resource data
```

### Data Flow: Deploying a Bot

1. User clicks "Deploy" → frontend calls `POST /api/bots/[id]` to save current state, then sends deploy config to bot-runner via `POST /deploy`
2. Bot-runner generates project files from `codeBlocks` or `projectFiles` (zip upload), writes to `bots/[botId]/`, installs dependencies, starts the process
3. Bot-runner emits Socket.IO events (`log`, `status`, `resourceData`) back to the Next.js frontend
4. Webhook endpoint (`POST /api/webhook/[botId]`) proxies incoming Telegram updates to the bot-runner's `/webhook/[botId]` endpoint

### Key Runtime Constraints

- **Middleware runs in Edge Runtime** — no Node.js APIs (`fs`, `process.cwd()`, `crypto.createHmac`). Use Web Crypto API (`crypto.subtle`) for auth. Two session modules exist: `session.ts` (Node.js) and `session-edge.ts` (Edge) — both must verify tokens identically.
- **SQLite** — single-file database. Dev uses `prisma/data/bot-factory.db`, production uses `db/custom.db` (configured via `DATABASE_URL` in `.env`). Deploy scripts set DATABASE_URL to an absolute path to avoid resolution issues in standalone mode. JSON fields (`codeBlocks`, `dependencies`, `envVars`, `config`, `stats`, `projectFiles`) are stored as JSON-encoded strings (no native JSON type in SQLite). Parse/serialize in API helpers.
- **Standalone output** — Next.js configured with `output: "standalone"`. The build script copies static files and public assets into `.next/standalone/` manually.

### Auth & Security

- **Stateless HMAC-signed session tokens** — `base64url(JSON({userId, username, createdAt})) + "." + hex(hmac)`. Works in both Edge and Node.js because both use the Web Crypto API.
- **Middleware-enforced auth** — all `/api/*` routes except public ones (login, session, health, webhooks) require a valid session token. Individual route handlers don't need to check auth separately.
- **HMAC_SECRET** env var is required — both runtimes must use the same key. A fallback file-based secret (`.hmac-secret`) exists for dev only.
- **AES-256-GCM encryption** for env var values — keys are derived from `ENCRYPTION_KEY` env var. Encrypted values are stored as hex strings. Env vars can be masked (●●●) or fully revealed via dedicated endpoint.
- **CSRF protection** via custom header requirement on state-changing endpoints.
- **Single-admin model** — no public registration. Default account created on first startup; password set via `ADMIN_INITIAL_PASSWORD` or randomly generated.

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

- **Process lifecycle**: `deploy.ts` handles the full deploy pipeline (code gen → npm/pip install → start process), `process-manager.ts` manages child processes with auto-restart logic, heartbeat monitoring, and graceful shutdown.
- **Socket.IO**: `socket.ts` sets up the HTTP+WS server, `handlers.ts` registers event handlers for client connections.
- **Log management**: `log-manager.ts` writes logs to disk with 6-hour cleanup of old files.
- **Monitoring**: `monitor.ts` collects CPU/memory per process and system-wide.
- **Templates**: `templates/` directory contains starter bot code for different bot types.
- Bot working directories live in `mini-services/bot-runner/bots/[botId]/`.

### Database Schema (Prisma)

Three main models: **Bot** (all bot metadata, code, config as JSON strings), **BotLog** (structured log entries with level + source), **BotMessage** (recorded messages per bot/user), and **Account** (single admin user).
