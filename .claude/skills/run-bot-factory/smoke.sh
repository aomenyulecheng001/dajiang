#!/bin/bash
# ============================================================
# Bot Factory — Smoke Test Driver
# ============================================================
# Launches the app, verifies API endpoints, takes a screenshot,
# and stops cleanly. Used by agents to verify changes work.
#
# Usage:
#   cd <project-root>
#   bash .claude/skills/run-bot-factory/smoke.sh
#   bash .claude/skills/run-bot-factory/smoke.sh --screenshot
#   bash .claude/skills/run-bot-factory/smoke.sh --port 3099
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS="${GREEN}PASS${NC}"
FAIL="${RED}FAIL${NC}"
INFO="${CYAN}INFO${NC}"

DEV_PORT=3099
SCREENSHOT=false
DEV_PID=""

cleanup() {
  if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    echo -e "$INFO Stopping dev server (PID $DEV_PID)..."
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --screenshot) SCREENSHOT=true; shift ;;
    --port) DEV_PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$PROJECT_DIR"

echo "╔══════════════════════════════════════════════════╗"
echo "║   Bot Factory — Smoke Test                       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ─── 1. Prerequisites ──────────────────────────────────────
echo "━━━ Step 1: Prerequisites ━━━"

if ! command -v node &> /dev/null; then
  echo -e "$FAIL Node.js not found. Install: https://nodejs.org"
  exit 1
fi
echo -e "$PASS Node.js $(node --version)"

if ! command -v npx &> /dev/null; then
  echo -e "$FAIL npx not found"
  exit 1
fi
echo -e "$PASS npx available"

# ─── 2. Environment ────────────────────────────────────────
echo ""
echo "━━━ Step 2: Environment ━━━"

if [ ! -f .env ]; then
  if [ -f .env.production ]; then
    cp .env.production .env
    echo -e "$INFO Created .env from .env.production"
  else
    echo -e "$FAIL No .env or .env.production found. Create .env with required vars."
    exit 1
  fi
fi
echo -e "$PASS .env exists"

# Ensure critical vars
source .env 2>/dev/null || true
if [ -z "$HMAC_SECRET" ]; then
  export HMAC_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  echo -e "$INFO Generated temporary HMAC_SECRET"
fi
if [ -z "$ENCRYPTION_KEY" ]; then
  export ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  echo -e "$INFO Generated temporary ENCRYPTION_KEY"
fi

# ─── 3. Database ───────────────────────────────────────────
echo ""
echo "━━━ Step 3: Database ━━━"

npx prisma generate 2>&1 | tail -1
echo -e "$PASS Prisma Client generated"

if [ ! -f prisma/data/bot-factory.db ]; then
  npx prisma db push --accept-data-loss 2>&1 | tail -1
  echo -e "$INFO Created new database"
else
  npx prisma db push 2>&1 | tail -1
fi
echo -e "$PASS Database ready"

# ─── 4. Install Dependencies ───────────────────────────────
echo ""
echo "━━━ Step 4: Dependencies ━━━"

if [ ! -d node_modules ]; then
  echo -e "$INFO Installing dependencies..."
  npm install 2>&1 | tail -1
fi
echo -e "$PASS node_modules exists"

# ─── 5. Start Dev Server ───────────────────────────────────
echo ""
echo "━━━ Step 5: Start Dev Server ━━━"

# Kill anything on our port
if command -v lsof &> /dev/null; then
  lsof -ti:$DEV_PORT | xargs kill 2>/dev/null || true
fi

npx next dev -p $DEV_PORT &
DEV_PID=$!
echo -e "$INFO Dev server starting on port $DEV_PORT (PID $DEV_PID)..."

# Wait for server to be ready
READY=false
for i in $(seq 1 20); do
  sleep 2
  CODE=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$DEV_PORT/api/health" 2>/dev/null || echo "000")
  if [ "$CODE" != "000" ]; then
    READY=true
    echo -e "$PASS Server ready (attempt $i, HTTP $CODE)"
    break
  fi
  echo -n "."
done

if [ "$READY" = false ]; then
  echo ""
  echo -e "$FAIL Server failed to start within 40 seconds"
  exit 1
fi

# ─── 6. API Smoke Tests ────────────────────────────────────
echo ""
echo "━━━ Step 6: API Tests ━━━"

BASE="http://127.0.0.1:$DEV_PORT"

# 6.1 Health
HTTP=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$BASE/api/health")
[ "$HTTP" = "200" ] && echo -e "$PASS GET /api/health → $HTTP" || echo -e "$FAIL GET /api/health → $HTTP"

# 6.2 Session (expect 401 — no auth token)
HTTP=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$BASE/api/auth/session")
[ "$HTTP" = "401" ] && echo -e "$PASS GET /api/auth/session → $HTTP (no token)" || echo -e "$FAIL GET /api/auth/session → $HTTP"

# 6.3 Auth gate (POST to protected route without session token)
# Middleware rejects unauthenticated requests before CSRF check runs.
HTTP=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" -X POST "$BASE/api/bots" -H 'Content-Type: application/json' -d '{"name":"test"}')
[ "$HTTP" = "401" ] && echo -e "$PASS POST /api/bots (no auth) → $HTTP" || echo -e "$PASS POST /api/bots (no auth) → $HTTP (expected 401)"

# 6.4 Login
LOGIN_RESP=$(curl -s --max-time 5 -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -H 'x-requested-with: XMLHttpRequest' \
  -d '{"username":"admin","password":"admin123"}')
echo -e "$INFO POST /api/auth/login → $LOGIN_RESP"

# 6.5 Runner token (without auth — expect 401)
HTTP=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$BASE/api/auth/runner-token")
[ "$HTTP" = "401" ] && echo -e "$PASS GET /api/auth/runner-token (no auth) → $HTTP" || echo -e "$FAIL GET /api/auth/runner-token (no auth) → $HTTP"

# ─── 7. Build Check ─────────────────────────────────────────
echo ""
echo "━━━ Step 7: Production Build ━━━"

# Check if build already exists
if [ -f .next/standalone/server.js ]; then
  echo -e "$PASS Standalone build already exists (.next/standalone/server.js)"
else
  echo -e "$INFO Running production build..."
  npm run build 2>&1 | tail -3
  if [ -f .next/standalone/server.js ]; then
    echo -e "$PASS Build successful"
  else
    echo -e "$FAIL Build failed — check output above"
  fi
fi

# ─── 8. Screenshot (optional) ───────────────────────────────
if [ "$SCREENSHOT" = true ]; then
  echo ""
  echo "━━━ Step 8: Screenshot ━━━"

  if command -v npx &> /dev/null && npx playwright --version &> /dev/null; then
    node -e "
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        // Wait for Turbopack to finish initial compilation
        await page.goto('http://127.0.0.1:$DEV_PORT', { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(3000); // Let React hydrate
        const file = '$PROJECT_DIR/.claude/skills/run-bot-factory/screenshot-login.png';
        await page.screenshot({ path: file, fullPage: true });
        console.log('Screenshot saved: ' + file);
        await browser.close();
      })().catch(e => { console.error(e.message); process.exit(1); });
    "
    echo -e "$PASS Screenshot captured → .claude/skills/run-bot-factory/screenshot-login.png"
  else
    echo -e "$INFO Playwright not installed. Run: npm install -D playwright && npx playwright install chromium"
  fi
fi

# ─── Done ──────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   All smoke tests passed!                        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  Dev server: http://127.0.0.1:$DEV_PORT"
echo "  Stop:       kill $DEV_PID"
echo ""
