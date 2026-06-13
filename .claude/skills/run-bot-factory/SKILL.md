---
name: run-bot-factory
description: >
  Build, launch, and drive the Bot Factory app — a Next.js Telegram bot management
  platform with a separate bot-runner microservice. Use for: `run the app`,
  `start dev server`, `smoke test`, `screenshot the UI`, `deploy`, `build`.
---

# Run: Bot Factory

Two-process web app: **Next.js 16** (port 3000) + **bot-runner** microservice (port 3001).
The primary agent path uses the `smoke.sh` driver — it launches the dev server,
runs curl-based API checks, and optionally captures a Playwright screenshot.

All paths below are relative to the project root (`bot-factory/`).

## Prerequisites

```bash
# Node.js >= 18, npm, git
node --version   # v20+
```

## Quick start (agent path)

```bash
# Launch dev server + run API tests
bash .claude/skills/run-bot-factory/smoke.sh

# With screenshot
bash .claude/skills/run-bot-factory/smoke.sh --screenshot

# Custom port
bash .claude/skills/run-bot-factory/smoke.sh --port 3099 --screenshot
```

The driver starts the dev server, waits for readiness, tests 5 API endpoints, and
stops cleanly. Screenshots land at `.claude/skills/run-bot-factory/screenshot-login.png`.

## Direct invocation (library path)

For PRs that touch internals without needing the full app:

```bash
# Type-check everything
npx tsc --noEmit

# Lint
npx eslint .

# Test a module directly
node -e "
  const { encryptAsync, decryptAsync, initializeCrypto } = require('./src/lib/crypto');
  (async () => {
    await initializeCrypto();
    const enc = await encryptAsync('test-secret');
    console.log('Encrypted:', enc);
    const dec = await decryptAsync(enc);
    console.log('Round-trip:', dec === 'test-secret' ? 'OK' : 'FAIL');
  })();
"
```

## Build (production)

```bash
npm run build
# Output: .next/standalone/server.js
```

The build checks TypeScript, compiles with Turbopack, and generates a standalone
output. Verify with:

```bash
node .next/standalone/server.js &
sleep 3
curl -s http://127.0.0.1:3000/api/health
# {"status":"ok"}
kill %1
```

## Run: bot-runner (microservice)

```bash
cd mini-services/bot-runner
npm install
tsx index.ts
# Bot Runner on http://localhost:3001
```

## Human path

```bash
# Start both services
# Terminal 1: Next.js
npm run dev

# Terminal 2: Bot Runner
cd mini-services/bot-runner && tsx --watch index.ts

# → http://localhost:3000
```

## Gotchas

- **Socket.IO keeps page loading**: `page.goto(…, { waitUntil: 'networkidle' })`
  hangs forever because Socket.IO maintains a persistent WebSocket. Use
  `waitUntil: 'load'` instead.
- **Second `next dev` blocks**: Turbopack locks the dev port. Kill the existing
  process or use a different `--port`.
- **DATABASE_URL must be absolute** for standalone mode. The dev server uses the
  relative path from `.env`; the deploy script fixes this for production.
- **`ENCRYPTION_KEY` and `HMAC_SECRET`** are required. Generate with
  `openssl rand -hex 32`. Missing in dev → auto-generated with warnings.
- **CSRF header required** for state-changing API calls. Include
  `x-requested-with: XMLHttpRequest` in all POST/PUT/DELETE requests from the
  browser (the frontend's `authFetch` wrapper handles this automatically).
- **Login page redirect**: The frontend shows a login form for unauthenticated
  users. Screenshots of `/` without a session token will show the login page.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `EADDRINUSE :::3000` | `taskkill //F //PID <pid>` or `lsof -ti:3000 \| xargs kill` |
| `Error code 14: Unable to open the database file` | Standalone mode needs absolute `DATABASE_URL` |
| `Key source not available` | Crypto auto-initializes on first call; check `ENCRYPTION_KEY` in `.env` |
| `Rejected unauthorized connection` in bot-runner logs | `runner-secret` mismatch — check `pm2 restart bot-factory-runner` |
| Playwright `MODULE_NOT_FOUND` | `npm install -D playwright && npx playwright install chromium` |
| Turbopack compile timeout on slow machines | First page load compiles everything; wait 30-60s after `✓ Ready` |
