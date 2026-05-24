#!/bin/bash
# ============================================================
# Bot Factory — 一键部署脚本 (宝塔面板 / PM2)
# ============================================================
# 使用方法:
#   1. 解压压缩包到目标目录 (如 /www/wwwroot/bot-factory)
#   2. cd 到项目目录
#   3. chmod +x deploy.sh && sudo ./deploy.sh
# ============================================================

set -e

# ── 颜色定义 ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo_success() { echo -e "${GREEN}[✓]${NC} $1"; }
echo_info()    { echo -e "${CYAN}[i]${NC} $1"; }
echo_warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
echo_error()   { echo -e "${RED}[✗]${NC} $1"; }

# ── 获取项目绝对路径 ──────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo_info "项目目录: ${PROJECT_DIR}"

cd "$PROJECT_DIR"

# ── 1. 检查环境依赖 ──────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 1/6: 检查环境依赖"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_command() {
  if command -v "$1" &> /dev/null; then
    local version=$("$1" --version 2>&1 | head -1)
    echo_success "$1 已安装: ${version}"
    return 0
  else
    echo_error "$1 未安装"
    return 1
  fi
}

MISSING_DEPS=0

# Node.js is required
if ! check_command node; then
  MISSING_DEPS=1
  echo_warn "  请安装 Node.js >= 18: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt install -y nodejs"
fi

# Build tools are required for native modules (better-sqlite3, etc.)
echo_info "检查编译工具 (better-sqlite3 等原生模块需要)..."
if ! command -v make &> /dev/null || ! command -v g++ &> /dev/null || ! command -v python3 &> /dev/null; then
  echo_warn "  编译工具不完整，正在安装 build-essential 和 python3..."
  apt install -y build-essential python3 2>/dev/null || sudo apt install -y build-essential python3 2>/dev/null || true
  if command -v make &> /dev/null && command -v g++ &> /dev/null && command -v python3 &> /dev/null; then
    echo_success "编译工具安装完成"
  else
    echo_warn "  编译工具安装失败，原生模块 (better-sqlite3) 可能无法编译"
    echo_warn "  请手动安装: sudo apt install -y build-essential python3"
  fi
else
  echo_success "编译工具已就绪"
fi

# pnpm is recommended for bot dependency installation (native modules like better-sqlite3)
if ! check_command pnpm; then
  echo_warn "  pnpm 未安装，正在安装..."
  # Bun intercepts npm, so use corepack or standalone installer
  if command -v corepack &> /dev/null; then
    corepack enable pnpm 2>/dev/null && echo_success "pnpm 安装成功 (via corepack)"
  else
    curl -fsSL https://get.pnpm.io/install.sh | sh - 2>/dev/null && echo_success "pnpm 安装成功 (via installer)"
  fi
  if ! command -v pnpm &> /dev/null; then
    echo_warn "  pnpm 安装失败，将使用 bun/npm 安装依赖（better-sqlite3 等原生模块可能无法编译）"
  fi
fi

# PM2 is required for process management
if ! check_command pm2; then
  echo_warn "  PM2 未安装，正在安装..."
  npm install -g pm2 2>/dev/null || sudo npm install -g pm2
  if command -v pm2 &> /dev/null; then
    echo_success "PM2 安装成功"
  else
    MISSING_DEPS=1
    echo_warn "  PM2 安装失败，请手动安装: sudo npm install -g pm2"
  fi
fi

if [ $MISSING_DEPS -ne 0 ]; then
  echo_error "缺少必要依赖，请先安装后再运行部署脚本"
  echo ""
  echo "快速安装命令 (Ubuntu/Debian):"
  echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
  echo "  sudo apt install -y nodejs"
  echo "  sudo npm install -g pm2"
  exit 1
fi

# ── 2. 配置环境变量 ──────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 2/6: 配置环境变量"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -f .env ]; then
  if [ -f .env.production ]; then
    cp .env.production .env
    echo_success "已从 .env.production 模板创建 .env"
  else
    touch .env
    echo_warn "已创建空白 .env 文件"
  fi

  # 生成 HMAC_SECRET 和 ENCRYPTION_KEY
  HMAC_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 32)

  # 写入生成的密钥
  if command -v sed &> /dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/^HMAC_SECRET=.*$/HMAC_SECRET=\"${HMAC_SECRET}\"/" .env
      sed -i '' "s/^ENCRYPTION_KEY=.*$/ENCRYPTION_KEY=\"${ENCRYPTION_KEY}\"/" .env
    else
      sed -i "s/^HMAC_SECRET=.*$/HMAC_SECRET=\"${HMAC_SECRET}\"/" .env
      sed -i "s/^ENCRYPTION_KEY=.*$/ENCRYPTION_KEY=\"${ENCRYPTION_KEY}\"/" .env
    fi
    echo_success "已自动生成 HMAC_SECRET 和 ENCRYPTION_KEY"
  fi

  # DEPLOY FIX: Auto-generate secure admin credentials if not set.
  # Prevents deployment with hardcoded/empty default passwords.
  if ! grep -q "^ADMIN_INITIAL_USERNAME=" .env || grep -q "^ADMIN_INITIAL_USERNAME=$" .env; then
    AUTO_USERNAME="admin_$(date +%s | tail -c 6)"
    AUTO_PASSWORD=$(openssl rand -base64 16 | tr -d '=/+' | head -c 20)$(openssl rand -hex 4)
    if command -v sed &> /dev/null; then
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^ADMIN_INITIAL_USERNAME=.*$|ADMIN_INITIAL_USERNAME=\"${AUTO_USERNAME}\"|" .env
        sed -i '' "s|^ADMIN_INITIAL_PASSWORD=.*$|ADMIN_INITIAL_PASSWORD=\"${AUTO_PASSWORD}\"|" .env
      else
        sed -i "s|^ADMIN_INITIAL_USERNAME=.*$|ADMIN_INITIAL_USERNAME=\"${AUTO_USERNAME}\"|" .env
        sed -i "s|^ADMIN_INITIAL_PASSWORD=.*$|ADMIN_INITIAL_PASSWORD=\"${AUTO_PASSWORD}\"|" .env
      fi
    fi
    echo_success "已自动生成管理员账号"
    echo_warn "  用户名: ${AUTO_USERNAME}"
    echo_warn "  密码已写入 .env 文件，请查看: cat .env | grep ADMIN_INITIAL"
    echo_warn "  ⚠️  请立即登录并修改密码！"
  else
    # If username is set but password is empty, generate password only
    if grep -q "^ADMIN_INITIAL_PASSWORD=$" .env; then
      AUTO_PASSWORD=$(openssl rand -base64 16 | tr -d '=/+' | head -c 20)$(openssl rand -hex 4)
      if command -v sed &> /dev/null; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
          sed -i '' "s|^ADMIN_INITIAL_PASSWORD=.*$|ADMIN_INITIAL_PASSWORD=\"${AUTO_PASSWORD}\"|" .env
        else
          sed -i "s|^ADMIN_INITIAL_PASSWORD=.*$|ADMIN_INITIAL_PASSWORD=\"${AUTO_PASSWORD}\"|" .env
        fi
      fi
      echo_success "已自动生成管理员密码 (用户名保持不变)"
      echo_warn "  ⚠️  密码已写入 .env 文件，请查看: cat .env | grep ADMIN_INITIAL_PASSWORD"
    fi
  fi

  # 设置 DATABASE_URL 为绝对路径
  DB_PATH="${PROJECT_DIR}/db/custom.db"
  if command -v sed &> /dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^DATABASE_URL=.*$|DATABASE_URL=\"file:${DB_PATH}?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000\"|" .env
    else
      sed -i "s|^DATABASE_URL=.*$|DATABASE_URL=\"file:${DB_PATH}?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000\"|" .env
    fi
  fi
  echo_success "DATABASE_URL 已设置为绝对路径 (WAL模式): file:${DB_PATH}"

  # 设置 PROJECT_ROOT
  if command -v sed &> /dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^PROJECT_ROOT=.*$|PROJECT_ROOT=\"${PROJECT_DIR}\"|" .env
    else
      sed -i "s|^PROJECT_ROOT=.*$|PROJECT_ROOT=\"${PROJECT_DIR}\"|" .env
    fi
  fi
  echo_success "PROJECT_ROOT 已设置为: ${PROJECT_DIR}"

  # 自动检测 SERVER_ORIGIN (公网IP)
  SERVER_ORIGIN=""
  # 优先从命令行参数获取
  if [ -n "$1" ]; then
    SERVER_ORIGIN="$1"
    echo_success "SERVER_ORIGIN 从参数获取: ${SERVER_ORIGIN}"
  else
    # 尝试自动检测公网IP
    PUBLIC_IP=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || curl -s --connect-timeout 3 icanhazip.com 2>/dev/null || curl -s --connect-timeout 3 ipinfo.io/ip 2>/dev/null)
    if [ -n "$PUBLIC_IP" ]; then
      SERVER_ORIGIN="http://${PUBLIC_IP}:3000"
      echo_success "SERVER_ORIGIN 自动检测: ${SERVER_ORIGIN}"
    else
      # 回退到内网IP
      LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
      if [ -n "$LOCAL_IP" ]; then
        SERVER_ORIGIN="http://${LOCAL_IP}:3000"
        echo_warn "无法检测公网IP，使用内网IP: ${SERVER_ORIGIN}"
      fi
    fi
  fi

  # 写入 SERVER_ORIGIN
  if [ -n "$SERVER_ORIGIN" ] && command -v sed &> /dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^SERVER_ORIGIN=.*$|SERVER_ORIGIN=\"${SERVER_ORIGIN}\"|" .env
    else
      sed -i "s|^SERVER_ORIGIN=.*$|SERVER_ORIGIN=\"${SERVER_ORIGIN}\"|" .env
    fi
    echo_success "SERVER_ORIGIN 已设置: ${SERVER_ORIGIN}"
  else
    echo_warn "SERVER_ORIGIN 未能自动设置，请手动编辑 .env"
  fi

  echo ""
  echo_info "环境变量已全自动配置完成！"
  echo_info "如需修改，稍后可编辑 .env 文件"
else
  echo_success ".env 文件已存在，验证并修复关键配置..."

  # BUG FIX: Always ensure DATABASE_URL is an absolute path.
  # Previously this was skipped entirely on re-deploy, so a relative
  # DATABASE_URL (e.g., file:./data/bot-factory.db) would survive
  # redeploys and break in standalone mode where the working directory is
  # .next/standalone/ instead of the project root.
  DB_PATH="${PROJECT_DIR}/db/custom.db"
  if grep -q "^DATABASE_URL=" .env; then
    CURRENT_DB=$(grep "^DATABASE_URL=" .env | head -1)
    if echo "$CURRENT_DB" | grep -q "file:\.\/"; then
      echo_warn "DATABASE_URL 使用相对路径，修复为绝对路径..."
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^DATABASE_URL=.*$|DATABASE_URL=\"file:${DB_PATH}?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000\"|" .env
      else
        sed -i "s|^DATABASE_URL=.*$|DATABASE_URL=\"file:${DB_PATH}?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000\"|" .env
      fi
      echo_success "DATABASE_URL 已修复为绝对路径"
    else
      echo_info "DATABASE_URL 已经是绝对路径，跳过"
    fi
  else
    echo "DATABASE_URL=\"file:${DB_PATH}?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000\"" >> .env
    echo_success "已添加 DATABASE_URL"
  fi

  # 确保 PROJECT_ROOT 在 .env 中设置
  if ! grep -q "^PROJECT_ROOT=" .env || grep -q "^PROJECT_ROOT=$" .env || grep -q "^PROJECT_ROOT=\"\"" .env; then
    sed -i "s|^PROJECT_ROOT=.*$|PROJECT_ROOT=\"${PROJECT_DIR}\"|" .env 2>/dev/null || echo "PROJECT_ROOT=\"${PROJECT_DIR}\"" >> .env
    echo_success "已更新 PROJECT_ROOT=${PROJECT_DIR}"
  fi
fi

# ── 3. 安装主项目依赖 ──────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 3/6: 安装依赖"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# NATIVE FIX: Ensure pnpm is available — preferred over npm for native modules.
# pnpm installs native C++ addons (like better-sqlite3) compiled for real Node.js,
# not intercepted by Bun. On Ubuntu, this is critical for bot deployments that
# use native SQLite, bcrypt, or other C++ addons.
if ! command -v pnpm &> /dev/null; then
  echo_info "pnpm 未检测到，正在安装..."
  npm install -g pnpm 2>/dev/null || corepack enable pnpm 2>/dev/null || {
    # Fallback: try with npx (Node.js built-in package runner)
    if command -v npx &> /dev/null; then
      npx -y pnpm@latest --version > /dev/null 2>&1 && {
        # Create a symlink instead of alias — aliases don't propagate to child processes
        mkdir -p /usr/local/bin 2>/dev/null
        ln -sf "$(command -v npx 2>/dev/null || echo /usr/bin/npx)" /usr/local/bin/pnpm 2>/dev/null || true
        # If symlink failed, create a wrapper script
        if ! command -v pnpm &> /dev/null; then
          echo '#!/bin/bash' > /usr/local/bin/pnpm
          echo 'exec npx pnpm@latest "$@"' >> /usr/local/bin/pnpm
          chmod +x /usr/local/bin/pnpm
        fi
      }
    fi
  }
fi
if command -v pnpm &> /dev/null; then
  PNPM_VER=$(pnpm --version 2>/dev/null | head -1)
  echo_success "pnpm 可用: v${PNPM_VER}"
else
  echo_warn "pnpm 安装失败，将回退到 npm (native 模块可能需要手动编译)"
fi

# 先安装主项目依赖（包含正确版本的 prisma）
echo_info "安装主项目依赖..."
if command -v pnpm &> /dev/null; then
  pnpm install
else
  npm install
fi
echo_success "主项目依赖安装完成"

# 安装 bot-runner 依赖
echo_info "安装 bot-runner 微服务依赖..."
cd mini-services/bot-runner
if command -v pnpm &> /dev/null; then
  pnpm install
else
  npm install
fi
cd "$PROJECT_DIR"
echo_success "bot-runner 依赖安装完成"

# DEP FIX: Check native module compilation environment.
# On Ubuntu, bots that use better-sqlite3, bcrypt, sharp, or other C++ addons
# need gcc/g++/make/python3-dev. This pre-check warns the user BEFORE they
# encounter a cryptic "gyp ERR!" error during bot deployment.
echo_info "检查原生模块编译环境..."
MISSING_TOOLS=()
if ! command -v gcc &> /dev/null; then MISSING_TOOLS+=("gcc (C compiler)"); fi
if ! command -v make &> /dev/null; then MISSING_TOOLS+=("make"); fi
if ! command -v python3 &> /dev/null; then MISSING_TOOLS+=("python3"); fi

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
  echo_warn "缺少编译工具: ${MISSING_TOOLS[*]}"
  echo_warn "如果部署的机器人使用了 better-sqlite3/bcrypt/sharp 等原生模块，需要安装编译工具链"
  # Auto-detect OS and suggest correct install command
  if [ -f /etc/os-release ]; then
    OS_ID=$(grep '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"')
    case "$OS_ID" in
      ubuntu|debian)
        echo_warn "Ubuntu/Debian 安装命令: sudo apt update && sudo apt install -y build-essential python3"
        ;;
      centos|rhel|rocky|alinux)
        echo_warn "CentOS/RHEL/Alibaba Linux 安装命令: sudo yum groupinstall 'Development Tools' -y && sudo yum install python3-devel -y"
        ;;
      *)
        echo_warn "请根据您的 Linux 发行版安装 gcc, make, python3-dev"
        ;;
    esac
  fi
  echo_info "注意: 部分预编译二进制可能仍然可用，此警告仅供参考"
else
  echo_success "编译环境完整 ✓ (gcc + make + python3)"
fi

# ── 4. 生成 Prisma Client ───────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 4/6: 初始化数据库"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 加载 .env
set -a
source .env 2>/dev/null || true
set +a

# 使用项目本地 prisma（避免 bunx/npx 拉到不兼容的最新版）
PRISMA_CMD="./node_modules/.bin/prisma"
if [ ! -f "$PRISMA_CMD" ]; then
  PRISMA_CMD="npx prisma"
fi

# 生成 Prisma Client
$PRISMA_CMD generate
echo_success "Prisma Client 生成完成"

# 确保 db 目录存在
mkdir -p db

# 如果数据库文件不存在，推送 schema
if [ ! -f db/custom.db ]; then
  echo_info "数据库文件不存在，创建数据库..."
  $PRISMA_CMD db push
  echo_success "数据库创建完成"
else
  echo_info "数据库已存在，应用迁移..."
  $PRISMA_CMD db push
  echo_success "数据库迁移完成"
fi

# ── 5. 构建项目 ──────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 5/6: 构建项目"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -f .next/standalone/server.js ]; then
  echo_success "检测到预构建的 standalone 产物，跳过构建步骤"
else
  echo_info "开始构建 Next.js 项目..."
  if command -v pnpm &> /dev/null; then
    pnpm run build
  else
    npm run build
  fi
  echo_success "Next.js 构建完成"
fi

# 验证 standalone 目录完整性
if [ ! -f .next/standalone/server.js ]; then
  echo_error "构建产物不完整！请检查构建日志"
  exit 1
fi

# 确保 standalone 目录中有 static 和 public
if [ ! -d .next/standalone/.next/static ]; then
  echo_info "复制 static 资源到 standalone 目录..."
  mkdir -p .next/standalone/.next/static
  cp -r .next/static/* .next/standalone/.next/static/ 2>/dev/null || true
fi
if [ ! -d .next/standalone/public ]; then
  echo_info "复制 public 资源到 standalone 目录..."
  cp -r public .next/standalone/public
fi

# 将 .env 链接/复制到 standalone 目录（standalone 模式需要）
cp .env .next/standalone/.env 2>/dev/null || true
# 将 prisma schema 复制到 standalone 目录
mkdir -p .next/standalone/prisma
cp prisma/schema.prisma .next/standalone/prisma/ 2>/dev/null || true
# 将 db 目录链接到 standalone 目录
# BUG FIX: With absolute DATABASE_URL, Prisma resolves the DB file directly.
# The symlink is a convenience — if it fails, we warn instead of falling back
# to cp -r, which silently creates a diverging copy that causes data loss on
# the next redeploy (standalone dir is replaced entirely).
if [ ! -d .next/standalone/db ] && [ ! -L .next/standalone/db ]; then
  if ln -sf "${PROJECT_DIR}/db" .next/standalone/db 2>/dev/null; then
    echo_info "已创建 db/ 到 standalone 的软链接"
  else
    echo_warn "⚠️  无法创建软链接。由于 DATABASE_URL 是绝对路径，应用仍可正常工作。"
    echo_warn "    如需排查: ln -sf ${PROJECT_DIR}/db .next/standalone/db"
  fi
fi

echo_success "构建产物验证通过"

# ── 6. 启动服务 ──────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 6/6: 启动服务"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# DEP FIX: Validate critical environment variables before starting.
# Empty HMAC_SECRET or ENCRYPTION_KEY would cause silent session/encryption failures.
echo_info "验证关键环境变量..."
MISSING_VARS=()
if [ -z "$HMAC_SECRET" ]; then MISSING_VARS+=("HMAC_SECRET"); fi
if [ -z "$ENCRYPTION_KEY" ]; then MISSING_VARS+=("ENCRYPTION_KEY"); fi
if [ -z "$DATABASE_URL" ]; then MISSING_VARS+=("DATABASE_URL"); fi
if [ -z "$PROJECT_ROOT" ]; then MISSING_VARS+=("PROJECT_ROOT"); fi

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
  echo_error "关键环境变量为空: ${MISSING_VARS[*]}"
  echo_error "请检查 .env 文件，确保所有必填变量都有值"
  exit 1
fi
echo_success "关键环境变量验证通过"

# BUG FIX: Verify the database file actually exists at the configured path.
# A misconfigured DATABASE_URL pointing to a non-existent file causes Prisma
# to silently create an empty database, making all bots/environments vanish.
DB_FILE=$(echo "$DATABASE_URL" | sed 's|^file:||' | sed 's|?.*$||')
if [ ! -f "$DB_FILE" ]; then
  echo_error "数据库文件不存在: ${DB_FILE}"
  echo_error "DATABASE_URL 指向的文件不存在。可能的原因："
  echo_error "  1. 数据库文件尚未创建（运行 prisma db push）"
  echo_error "  2. DATABASE_URL 路径拼写错误"
  echo_error "  3. 旧数据在其他位置，需要迁移"
  echo_error ""
  echo_error "请检查: ls -lh ${PROJECT_DIR}/db/"
  exit 1
fi
echo_success "数据库文件存在: ${DB_FILE}"

# 创建日志目录
mkdir -p logs

# 加载 .env（standalone 模式不自动读 .env，必须通过 PM2 环境变量传入）
set -a
source .env 2>/dev/null || true
set +a

# 停止旧的实例（如果存在）
pm2 delete bot-factory-web 2>/dev/null || true
pm2 delete bot-factory-runner 2>/dev/null || true

# ── 启动 Next.js 主应用 ──
# 关键：standalone 模式下不会自动加载 .env，必须通过 PM2 传环境变量
echo_info "启动 Next.js 主应用..."
NODE_ENV=production \
PORT=3000 \
HOSTNAME=0.0.0.0 \
PROJECT_ROOT="${PROJECT_DIR}" \
DATABASE_URL="${DATABASE_URL}" \
HMAC_SECRET="${HMAC_SECRET}" \
ENCRYPTION_KEY="${ENCRYPTION_KEY}" \
ADMIN_INITIAL_USERNAME="${ADMIN_INITIAL_USERNAME}" \
ADMIN_INITIAL_PASSWORD="${ADMIN_INITIAL_PASSWORD}" \
SERVER_ORIGIN="${SERVER_ORIGIN}" \
BOT_RUNNER_URL="${BOT_RUNNER_URL:-http://localhost:3001}" \
pm2 start "${PROJECT_DIR}/.next/standalone/server.js" \
  --name bot-factory-web \
  --max-memory-restart 1024M \
  --log-date-format="YYYY-MM-DD HH:mm:ss"

echo_success "Next.js 主应用已启动 (端口: 3000)"

# ── 启动 Bot Runner 微服务 ──
# IMPORTANT: Use Node.js (NOT Bun) to run bot-runner.
# Bun intercepts ALL spawn('node') calls, redirecting them to Bun runtime,
# which cannot load native C++ modules like better-sqlite3.
# Node.js has no such interception — child processes run as real Node.js.
echo_info "启动 Bot Runner 微服务..."

# Install tsx for TypeScript support under Node.js
if ! command -v tsx &> /dev/null; then
  pnpm add -g tsx 2>/dev/null || /usr/local/bin/node -e "require('child_process').execSync('pnpm add -g tsx', {stdio:'inherit'})"
fi

NODE_ENV=production \
PORT=3001 \
PROJECT_ROOT="${PROJECT_DIR}" \
HMAC_SECRET="${HMAC_SECRET}" \
ENCRYPTION_KEY="${ENCRYPTION_KEY}" \
SERVER_ORIGIN="${SERVER_ORIGIN}" \
BOT_RUNNER_URL="${BOT_RUNNER_URL:-http://localhost:3001}" \
pm2 start "${PROJECT_DIR}/mini-services/bot-runner/index.ts" \
  --name bot-factory-runner \
  --interpreter tsx \
  --max-memory-restart 512M \
  --log-date-format="YYYY-MM-DD HH:mm:ss"

echo_success "Bot Runner 已启动 (端口: 3001)"

# 保存 PM2 进程列表
pm2 save

# 设置 PM2 开机自启
pm2 startup 2>/dev/null || echo_warn "PM2 开机自启设置失败，请手动执行: pm2 startup"

# ── 7. 健康检查 ──────────────────────────────────────────
echo ""
echo_info "等待服务启动并执行健康检查..."
sleep 3

HEALTH_CHECK_PASSED=false
for attempt in 1 2 3 4 5; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:3000/api/auth/session" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ]; then
    HEALTH_CHECK_PASSED=true
    break
  fi
  echo_info "  第 ${attempt} 次检查: 状态 ${HTTP_CODE}, 等待重试..."
  sleep 3
done

if [ "$HEALTH_CHECK_PASSED" = true ]; then
  echo_success "健康检查通过: Next.js 主应用运行正常"
else
  echo_warn "健康检查未通过，请查看日志: pm2 logs bot-factory-web"
  pm2 logs bot-factory-web --lines 50 --nostream 2>/dev/null || true
fi

# ── 完成 ──────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}🎉 Bot Factory 部署完成！${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
if [ -n "$SERVER_ORIGIN" ]; then
  echo -e "  📡 访问地址: ${CYAN}${SERVER_ORIGIN}${NC}"
else
  echo "  📡 访问地址: http://<服务器IP>:3000"
fi
echo ""
echo "  📋 管理命令:"
echo "    查看状态:  pm2 status"
echo "    查看日志:  pm2 logs"
echo "    重启服务:  pm2 restart all"
echo "    停止服务:  pm2 stop all"
echo ""
echo "  🔑 初始账号: 请查看 .env 中的 ADMIN_INITIAL_USERNAME / ADMIN_INITIAL_PASSWORD"
echo "  ⚠️  首次登录后请立即修改密码！"
echo ""
echo "  🌐 宝塔面板反向代理配置 (增强版):"
echo "    1. 添加网站，设置域名/IP"
echo "    2. 设置反向代理 → 目标URL: http://127.0.0.1:3000"
echo "    3. 完整 Nginx 配置:"
echo ""
echo '       # === 基础配置 ==='
echo '       client_max_body_size 20m;'
echo '       proxy_read_timeout 120s;'
echo '       proxy_send_timeout 120s;'
echo ''
echo '       # === WebSocket 支持 (Socket.IO) ==='
echo '       proxy_http_version 1.1;'
echo '       proxy_set_header Upgrade $http_upgrade;'
echo '       proxy_set_header Connection "upgrade";'
echo '       proxy_set_header Host $host;'
echo '       proxy_set_header X-Real-IP $remote_addr;'
echo '       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
echo '       proxy_set_header X-Forwarded-Proto $scheme;'
echo ''
echo '       # === 安全响应头 ==='
echo '       add_header X-Frame-Options DENY always;'
echo '       add_header X-Content-Type-Options nosniff always;'
echo '       add_header X-XSS-Protection "1; mode=block" always;'
echo '       add_header Referrer-Policy "strict-origin-when-cross-origin" always;'

# ── 7. 配置定时备份 ──────────────────────────────────
echo ""
echo_info "配置数据库定时备份..."
BACKUP_CRON="0 3 * * * cp ${PROJECT_DIR}/db/custom.db ${PROJECT_DIR}/db/custom.db.bak.\$(date +\%Y\%m\%d) 2>/dev/null && find ${PROJECT_DIR}/db/ -name 'custom.db.bak.*' -mtime +7 -delete"
(crontab -l 2>/dev/null | grep -v "$BACKUP_CRON"; echo "$BACKUP_CRON") | crontab -
echo_success "数据库每日备份已配置 (凌晨3点, 保留7天)"

# ── 8. PM2 日志轮转 ───────────────────────────────────
echo_info "配置 PM2 日志轮转..."
if command -v pm2 &> /dev/null; then
  pm2 install pm2-logrotate 2>/dev/null || true
  pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true
  pm2 set pm2-logrotate:retain 7 2>/dev/null || true
  echo_success "PM2 日志轮转已配置 (单文件最大10MB, 保留7天)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
