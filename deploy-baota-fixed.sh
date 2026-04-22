#!/bin/bash
# ============================================================
# Bot Factory — 宝塔服务器一键部署脚本
# ============================================================
# 使用方法:
#   1. SSH 登录服务器
#   2. cd /www/wwwroot/bot-factory
#   3. chmod +x deploy-baota-fixed.sh && sudo ./deploy-baota-fixed.sh
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo_success() { echo -e "${GREEN}[✓]${NC} $1"; }
echo_info()    { echo -e "${CYAN}[i]${NC} $1"; }
echo_warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
echo_error()   { echo -e "${RED}[✗]${NC} $1"; }

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo_info "项目目录: ${PROJECT_DIR}"
cd "$PROJECT_DIR"

# ── 0. 检查 Git 并拉取最新代码 ──────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 0/7: 更新代码到最新版本"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -d .git ]; then
  echo_info "检测到 Git 仓库，正在拉取最新代码..."
  git fetch origin 2>/dev/null || echo_warn "git fetch 失败，继续执行"
  git pull origin master 2>/dev/null || echo_warn "git pull 失败，可能已是最新"
  echo_success "代码已更新"
else
  echo_warn "未检测到 Git 仓库，跳过代码更新"
fi

# ── 1. 检查环境依赖 ──────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 1/7: 检查环境依赖"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Node.js
if command -v node &> /dev/null; then
  NODE_VER=$(node --version)
  NODE_MAJOR=$(echo $NODE_VER | sed 's/v\([0-9]*\).*/\1/')
  if [ "$NODE_MAJOR" -ge 18 ]; then
    echo_success "Node.js: $NODE_VER"
  else
    echo_error "Node.js 版本过低: $NODE_VER (需要 >= 18)"
    exit 1
  fi
else
  echo_error "Node.js 未安装"
  exit 1
fi

# PM2
if ! command -v pm2 &> /dev/null; then
  echo_warn "PM2 未安装，正在安装..."
  npm install -g pm2
  echo_success "PM2 安装完成"
else
  echo_success "PM2: $(pm2 --version)"
fi

# pnpm
if ! command -v pnpm &> /dev/null; then
  echo_warn "pnpm 未安装，正在安装..."
  npm install -g pnpm 2>/dev/null || corepack enable pnpm 2>/dev/null || true
  if command -v pnpm &> /dev/null; then
    echo_success "pnpm 安装完成"
  else
    echo_warn "pnpm 安装失败，将使用 npm"
  fi
else
  echo_success "pnpm: $(pnpm --version)"
fi

# tsx (bot-runner 必须)
echo_info "检查 tsx..."
if ! command -v tsx &> /dev/null; then
  echo_warn "tsx 未安装，正在安装..."
  if command -v pnpm &> /dev/null; then
    pnpm add -g tsx 2>/dev/null || true
  fi
  if ! command -v tsx &> /dev/null; then
    npm install -g tsx 2>/dev/null || true
  fi
  if command -v tsx &> /dev/null; then
    echo_success "tsx 安装完成: $(tsx --version)"
  else
    echo_error "tsx 安装失败，请手动安装: npm install -g tsx"
    exit 1
  fi
else
  echo_success "tsx: $(tsx --version)"
fi

# 获取 tsx 绝对路径
TSX_PATH=$(which tsx)
echo_success "tsx 路径: $TSX_PATH"

# 编译工具
if ! command -v g++ &> /dev/null || ! command -v make &> /dev/null; then
  echo_warn "编译工具不完整，正在安装..."
  apt install -y build-essential python3 2>/dev/null || sudo apt install -y build-essential python3 2>/dev/null || true
  echo_success "编译工具已安装"
else
  echo_success "编译工具已就绪"
fi

# ── 2. 配置环境变量 ──────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 2/7: 配置环境变量"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -f .env ]; then
  cp .env.production .env
  echo_success "已从 .env.production 创建 .env"

  # 生成密钥
  HMAC_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 32)
  AUTO_USERNAME="admin_$(date +%s | tail -c 6)"
  AUTO_PASSWORD=$(openssl rand -base64 16 | tr -d '=/+' | head -c 20)$(openssl rand -hex 4)

  # 写入 .env
  cat > .env << EOF
HMAC_SECRET="${HMAC_SECRET}"
ENCRYPTION_KEY="${ENCRYPTION_KEY}"
DATABASE_URL="file:${PROJECT_DIR}/db/custom.db?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000"
ADMIN_INITIAL_USERNAME="${AUTO_USERNAME}"
ADMIN_INITIAL_PASSWORD="${AUTO_PASSWORD}"
SERVER_ORIGIN="http://$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'):3000"
BOT_RUNNER_URL=http://localhost:3001
PROJECT_ROOT="${PROJECT_DIR}"
EOF

  echo_success "环境变量已自动生成"
  echo_warn "  用户名: ${AUTO_USERNAME}"
  echo_warn "  密码: ${AUTO_PASSWORD}"
  echo_warn "  ⚠️  请妥善保存以上信息！"
else
  echo_success ".env 文件已存在"
  
  # 确保 PROJECT_ROOT 正确
  set -a
  source .env 2>/dev/null || true
  set +a
  
  if [ -z "$PROJECT_ROOT" ] || [ "$PROJECT_ROOT" = '""' ]; then
    sed -i "s|^PROJECT_ROOT=.*$|PROJECT_ROOT=\"${PROJECT_DIR}\"|" .env
    echo_success "已添加 PROJECT_ROOT"
  fi
fi

# 加载环境变量
set -a
source .env 2>/dev/null || true
set +a

# ── 3. 安装依赖 ──────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 3/7: 安装依赖"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 主项目依赖
echo_info "安装主项目依赖..."
if command -v pnpm &> /dev/null; then
  pnpm install
else
  npm install
fi
echo_success "主项目依赖安装完成"

# bot-runner 依赖
echo_info "安装 bot-runner 依赖..."
cd mini-services/bot-runner
if command -v pnpm &> /dev/null; then
  pnpm install
else
  npm install
fi
cd "$PROJECT_DIR"
echo_success "bot-runner 依赖安装完成"

# ── 4. 初始化数据库 ─────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 4/7: 初始化数据库"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

mkdir -p db

./node_modules/.bin/prisma generate
echo_success "Prisma Client 生成完成"

if [ ! -f db/custom.db ]; then
  echo_info "创建数据库..."
  ./node_modules/.bin/prisma db push
  ./node_modules/.bin/prisma migrate dev --name init 2>/dev/null || true
  echo_success "数据库创建完成"
else
  echo_info "数据库已存在，执行迁移..."
  ./node_modules/.bin/prisma db push
  echo_success "数据库迁移完成"
fi

# ── 5. 构建项目 ─────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 5/7: 构建项目"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -f .next/standalone/server.js ]; then
  echo_success "检测到预构建产物，跳过构建"
else
  echo_info "开始构建..."
  if command -v pnpm &> /dev/null; then
    pnpm run build
  else
    npm run build
  fi
  echo_success "构建完成"
fi

# 验证构建产物
if [ ! -f .next/standalone/server.js ]; then
  echo_error "构建产物不完整！"
  exit 1
fi

# 复制必要文件
cp -r .next/static .next/standalone/.next/ 2>/dev/null || true
cp -r public .next/standalone/ 2>/dev/null || true
cp .env .next/standalone/.env 2>/dev/null || true
mkdir -p .next/standalone/prisma
cp prisma/schema.prisma .next/standalone/prisma/ 2>/dev/null || true
ln -sf "${PROJECT_DIR}/db" .next/standalone/db 2>/dev/null || cp -r db .next/standalone/db

echo_success "构建产物验证通过"

# ── 6. 启动服务 ─────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 6/7: 启动服务"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 重新加载环境变量
set -a
source .env 2>/dev/null || true
set +a

# 创建日志目录
mkdir -p logs

# 停止旧进程
pm2 delete bot-factory-web 2>/dev/null || true
pm2 delete bot-factory-runner 2>/dev/null || true
echo_info "已停止旧进程"

# 启动主应用
echo_info "启动 Next.js 主应用 (端口: 3000)..."

NODE_ENV=production \
PORT=3000 \
HOSTNAME=0.0.0.0 \
PROJECT_ROOT="${PROJECT_ROOT}" \
DATABASE_URL="${DATABASE_URL}" \
HMAC_SECRET="${HMAC_SECRET}" \
ENCRYPTION_KEY="${ENCRYPTION_KEY}" \
ADMIN_INITIAL_USERNAME="${ADMIN_INITIAL_USERNAME}" \
ADMIN_INITIAL_PASSWORD="${ADMIN_INITIAL_PASSWORD}" \
SERVER_ORIGIN="${SERVER_ORIGIN}" \
BOT_RUNNER_URL="${BOT_RUNNER_URL}" \
pm2 start "${PROJECT_DIR}/.next/standalone/server.js" \
  --name bot-factory-web \
  --max-memory-restart 1024M \
  --log-date-format="YYYY-MM-DD HH:mm:ss" \
  --output "${PROJECT_DIR}/logs/web-out.log" \
  --error "${PROJECT_DIR}/logs/web-error.log"

echo_success "主应用已启动"

# 启动 bot-runner（使用 tsx 绝对路径）
echo_info "启动 Bot Runner (端口: 3001)..."

NODE_ENV=production \
PORT=3001 \
PROJECT_ROOT="${PROJECT_ROOT}" \
HMAC_SECRET="${HMAC_SECRET}" \
ENCRYPTION_KEY="${ENCRYPTION_KEY}" \
SERVER_ORIGIN="${SERVER_ORIGIN}" \
BOT_RUNNER_URL="${BOT_RUNNER_URL}" \
pm2 start "${PROJECT_DIR}/mini-services/bot-runner/index.ts" \
  --name bot-factory-runner \
  --interpreter "$TSX_PATH" \
  --max-memory-restart 512M \
  --log-date-format="YYYY-MM-DD HH:mm:ss" \
  --output "${PROJECT_DIR}/logs/runner-out.log" \
  --error "${PROJECT_DIR}/logs/runner-error.log"

echo_success "Bot Runner 已启动"

# 保存 PM2 配置
pm2 save
echo_success "PM2 配置已保存"

# ── 7. 健康检查 ─────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  步骤 7/7: 健康检查"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo_info "等待服务启动..."
sleep 5

echo ""
echo "━━━ PM2 进程状态 ━━━"
pm2 status

echo ""
echo "━━━ 主应用检查 ━━━"
if curl -s --max-time 5 "http://127.0.0.1:3000/api/health" > /dev/null 2>&1; then
  echo_success "主应用运行正常"
else
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:3000/api/auth/session" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ]; then
    echo_success "主应用运行正常 (HTTP $HTTP_CODE)"
  else
    echo_warn "主应用健康检查未通过 (HTTP $HTTP_CODE)"
  fi
fi

echo ""
echo "━━━ Bot Runner 检查 ━━━"
HEALTH_RESP=$(curl -s --max-time 5 "http://127.0.0.1:3001/health" 2>/dev/null || echo "")
if [ -n "$HEALTH_RESP" ]; then
  echo_success "Bot Runner 运行正常: $HEALTH_RESP"
else
  echo_warn "Bot Runner 健康检查未通过"
  echo ""
  echo_error "请检查错误日志:"
  pm2 logs bot-factory-runner --lines 30 --nostream 2>/dev/null || true
fi

# ── 完成 ─────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}🎉 Bot Factory 部署完成！${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  📡 访问地址: ${SERVER_ORIGIN}"
echo "  🔑 用户名: ${ADMIN_INITIAL_USERNAME}"
echo "  🔑 密码: ${ADMIN_INITIAL_PASSWORD}"
echo ""
echo "  📋 管理命令:"
echo "    查看状态:  pm2 status"
echo "    查看日志:  pm2 logs"
echo "    重启服务:  pm2 restart all"
echo ""
echo "  ⚠️  首次登录后请立即修改密码！"
echo ""
