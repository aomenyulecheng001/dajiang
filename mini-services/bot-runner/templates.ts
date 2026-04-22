import type { BotTemplate } from './types'

// ─── P2-36 FIX: Sanitize config.name for safe code interpolation ──────────
/**
 * Escapes characters that could break generated JavaScript code strings.
 * Prevents template injection when config.name is interpolated into code.
 * Escapes: single quotes, double quotes, backticks, backslashes, and ${.
 */
function sanitizeForCode(name: string): string {
  return name
    .replace(/\\/g, '\\\\')   // backslash → escaped backslash
    .replace(/'/g, "\\'")     // single quote → escaped
    .replace(/"/g, '\\"')     // double quote → escaped
    .replace(/`/g, '\\`')     // backtick → escaped
    .replace(/\$\{/g, '\\${') // template literal expression → escaped
    .replace(/\n/g, '\\n')   // newline → escaped
    .replace(/\r/g, '\\r')   // carriage return → escaped
}

// ─── Common Bot Bootstrap (error-resilient launch) ─────────────────────────

function botBootstrapCode(emoji: string): string {
  return `
// ── Error handling & graceful shutdown ─────────────────────────────
// BUG FIX: Log fatal errors and EXIT instead of keeping the process alive
// in an undefined state. The bot-runner's auto-restart mechanism will
// recover the bot. A "zombie" process that swallowed its errors masks
// bugs, leaks memory, and prevents auto-restart from triggering.
process.on('uncaughtException', (err) => {
  console.error('[FATAL]', err.message || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[REJECTION]', reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});

// ── Stdin webhook support (WEBHOOK_MODE) ───────────────────────────
if (process.env.WEBHOOK_MODE === 'true') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    try {
      const msg = JSON.parse(chunk.toString().trim());
      if (msg.type === 'webhook' && msg.data && bot.handleUpdate) {
        bot.handleUpdate(msg.data).catch((e) => console.error('[Webhook Error]', e.message));
      }
    } catch (e) {
      console.error('[Stdin Error]', e.message);
    }
  });
}
`;
}

function botLaunchCode(botName: string, emoji: string): string {
  // P2-36 FIX: Sanitize bot name to prevent code injection in generated code
  const safeName = sanitizeForCode(botName);
  return `
// ── Safe launch ───────────────────────────────────────────────────
// Global error handler for Telegraf — catches 429, network errors, etc.
bot.catch((err, ctx) => {
  const code = err.code || '';
  const msg = err.description || err.message || 'Unknown error';
  console.error('[Error]', code, msg);
  if (ctx) {
    // Try to notify the user if possible
    try {
      if (code === 429) {
        const retryAfter = err.parameters?.retry_after || 5;
        safeReply(ctx, \`⚠️ 请求过于频繁，请等待 \${retryAfter} 秒后重试\`).catch(() => {});
      }
    } catch (_) { /* ignore send errors */ }
  }
});

// Rate-limit-aware reply helper
async function safeReply(ctx, text, extra) {
  try {
    return await ctx.reply(text, extra);
  } catch (err) {
    if (err.code === 429) {
      const wait = (err.parameters?.retry_after || 5) * 1000;
      console.warn(\`[Rate limit] Waiting \${wait}ms before retry...\`);
      await new Promise(r => setTimeout(r, wait));
      try { return await ctx.reply(text, extra); } catch (_) {}
    }
    console.error('[Reply error]', err.description || err.message);
    return null;
  }
}

bot.launch({
  dropPendingUpdates: true,  // Don't process old messages on restart
  allowedUpdates: undefined,   // Accept all update types
}).then(() => {
  console.log('${emoji}', '${safeName}', 'is running...');
}).catch((err) => {
  const msg = err.description || err.message;
  console.error('[Launch failed]', msg);
  // Only exit on auth errors — retry on temporary issues
  if (err.code === 401 || msg?.includes('Unauthorized') || msg?.includes('token')) {
    console.error('[FATAL] Invalid bot token. Please check BOT_TOKEN.');
    process.exit(1);
  }
  console.log('[Retry] Launching again in 10s...');
  setTimeout(() => {
    bot.launch({ dropPendingUpdates: true }).catch(() => {});
  }, 10000);
});

process.once('SIGINT', () => { console.log('[Shutdown] SIGINT'); bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { console.log('[Shutdown] SIGTERM'); bot.stop('SIGTERM'); process.exit(0); });
`;
}

// ─── Templates ───────────────────────────────────────────────────────────

export const templates: Map<string, BotTemplate> = new Map([
  ['customer-service', {
    id: 'customer-service',
    name: 'Customer Service Bot',
    language: 'javascript',
    description: '智能客服机器人，支持 FAQ 问答和人工转接',
    emoji: '🎧',
    generateCode: (config) => ({
      files: [{
        path: 'index.js',
        content: `const { Telegraf } = require('telegraf');

const BOT_NAME = process.env.BOT_NAME || 'Bot';

const bot = new Telegraf(process.env.BOT_TOKEN);

${botBootstrapCode(config.emoji || '🤖')}

// 客服机器人 - ${sanitizeForCode(config.name)}
bot.start((ctx) => {
  safeReply(ctx, '👋 欢迎使用 ${sanitizeForCode(config.name)}！\\n\\n我是您的智能客服助手，请问有什么可以帮助您的？\\n\\n📝 常用命令：\\n/help - 查看帮助\\n/faq - 常见问题\\n/contact - 联系人工客服\\n/status - 查看服务状态');
});

bot.help((ctx) => {
  safeReply(ctx, '📖 帮助信息\\n\\n🤖 我是 ${sanitizeForCode(config.name)}，为您提供以下服务：\\n\\n/start - 开始对话\\n/help - 帮助信息\\n/faq - 常见问题\\n/contact - 联系人工客服\\n/status - 服务状态\\n/feedback <内容> - 提交反馈\\n\\n您也可以直接输入问题，我会尽力为您解答！');
});

bot.command('faq', (ctx) => {
  safeReply(ctx, '❓ 常见问题\\n\\n1️⃣ 如何重置密码？\\n→ 请访问设置页面，点击"忘记密码"\\n\\n2️⃣ 如何修改个人信息？\\n→ 进入个人中心 > 编辑资料\\n\\n3️⃣ 退款流程是什么？\\n→ 订单详情页 > 申请退款 > 等待审核\\n\\n4️⃣ 如何联系人工客服？\\n→ 发送 /contact 命令\\n\\n输入问题编号获取更多详情，或直接描述您的问题！');
});

bot.command('contact', (ctx) => {
  safeReply(ctx, '👨‍💼 人工客服\\n\\n正在为您转接人工客服...\\n⏰ 预计等待时间：1-3 分钟\\n\\n请描述您的问题，人工客服将尽快为您处理。');
});

bot.command('status', (ctx) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  safeReply(ctx, \`📊 服务状态\\n\\n✅ 状态：运行中\\n⏱ 运行时间：\${hours}h \${minutes}m\\n🤖 机器人：\${BOT_NAME}\\n📡 Bot ID：\${bot.botInfo?.id || 'N/A'}\`);
});

bot.command('feedback', (ctx) => {
  const feedback = ctx.message.text.replace('/feedback', '').trim();
  if (!feedback) {
    safeReply(ctx, '📝 请提供您的反馈：\\n/feedback <您的反馈内容>');
    return;
  }
  safeReply(ctx, '✅ 感谢您的反馈！\\n\\n已记录："' + feedback.substring(0, 100) + '"\\n我们的团队会尽快处理。');
});

// 消息处理
bot.on('text', async (ctx) => {
  const text = ctx.message.text.toLowerCase();
  const user = ctx.from;
  
  console.log(\`[消息] \${user.first_name} (\${user.id}): \${ctx.message.text}\`);
  
  // 关键词回复
  if (text.includes('你好') || text.includes('hi') || text.includes('hello')) {
    await safeReply(ctx, \`您好 \${user.first_name}！😊 请问有什么可以帮助您的？\`);
  } else if (text.includes('价格') || text.includes('price')) {
    await safeReply(ctx, '💰 价格信息\\n\\n- 基础版：免费\\n- 专业版：¥99/月\\n- 企业版：¥299/月\\n\\n输入 /contact 了解更多详情');
  } else if (text.includes('谢谢') || text.includes('thank')) {
    await safeReply(ctx, '不客气！😊 如果还有其他问题，随时问我！');
  } else {
    await safeReply(ctx, \`收到您的消息："\${ctx.message.text.substring(0, 50)}\\"\\n\\n我正在学习中，您可以尝试：\\n/faq - 查看常见问题\\n/contact - 联系人工客服\`);
  }
});

${botLaunchCode(config.name, config.emoji || '🤖')}
`,
      }],
      dependencies: ['telegraf@^4.15.0'],
    }),
  }],
  ['notification', {
    id: 'notification',
    name: 'Notification Bot',
    language: 'javascript',
    description: '实时通知推送机器人',
    emoji: '🔔',
    generateCode: (config) => ({
      files: [{
        path: 'index.js',
        content: `const { Telegraf } = require('telegraf');

const BOT_NAME = process.env.BOT_NAME || 'Bot';

const bot = new Telegraf(process.env.BOT_TOKEN);

${botBootstrapCode(config.emoji || '🤖')}

// 通知机器人 - ${sanitizeForCode(config.name)}
const subscribers = new Set();

bot.start((ctx) => {
  safeReply(ctx, '🔔 欢迎使用 ${sanitizeForCode(config.name)}！\\n\\n我可以帮您：\\n/subscribe - 订阅通知\\n/unsubscribe - 取消订阅\\n/send <消息> - 发送通知（管理员）\\n/status - 查看状态');
});

bot.command('subscribe', (ctx) => {
  subscribers.add(ctx.from.id);
  safeReply(ctx, '✅ 订阅成功！您将收到重要通知。');
  console.log(\`[订阅] \${ctx.from.id} \${ctx.from.first_name}\`);
});

bot.command('unsubscribe', (ctx) => {
  subscribers.delete(ctx.from.id);
  safeReply(ctx, '❌ 已取消订阅。');
});

bot.command('send', async (ctx) => {
  const ADMIN_ID = process.env.ADMIN_ID
  if (ADMIN_ID && ctx.from.id.toString() !== ADMIN_ID) {
    return safeReply(ctx, '⛔ Only the admin can broadcast messages.')
  }
  if (!ADMIN_ID) {
    // Warning: no admin ID configured, anyone can broadcast
    console.warn('[Notification Bot] ⚠️ No ADMIN_ID configured! Anyone can use /send. Set ADMIN_ID env var.')
  }
  if (subscribers.size === 0) {
    safeReply(ctx, '⚠️ 当前没有订阅者');
    return;
  }
  const message = ctx.message.text.replace('/send', '').trim();
  if (!message) {
    safeReply(ctx, '📝 请输入要发送的通知内容：\\n/send <消息内容>');
    return;
  }
  let sent = 0;
  for (const chatId of subscribers) {
    try {
      await bot.telegram.sendMessage(chatId, \`📢 **通知**\\n\\n\${message}\`, { parse_mode: 'Markdown' });
      sent++;
    } catch (e) {
      console.error(\`发送失败: \${chatId}\`, e.message);
    }
  }
  safeReply(ctx, \`✅ 通知已发送给 \${sent} 位订阅者\`);
});

bot.command('status', (ctx) => {
  safeReply(ctx, \`📊 \${BOT_NAME} 状态\\n\\n👥 订阅者：\${subscribers.size} 人\\n✅ 状态：运行中\`);
});

${botLaunchCode(config.name, config.emoji || '🤖')}
`,
      }],
      dependencies: ['telegraf@^4.15.0'],
    }),
  }],
  ['game', {
    id: 'game',
    name: 'Game Bot',
    language: 'javascript',
    description: '互动游戏机器人',
    emoji: '🎮',
    generateCode: (config) => ({
      files: [{
        path: 'index.js',
        content: `const { Telegraf } = require('telegraf');

const BOT_NAME = process.env.BOT_NAME || 'Bot';

const bot = new Telegraf(process.env.BOT_TOKEN);

${botBootstrapCode(config.emoji || '🤖')}

// 游戏机器人 - ${sanitizeForCode(config.name)}
const scores = new Map();

bot.start((ctx) => {
  safeReply(ctx, '🎮 欢迎来到 ${sanitizeForCode(config.name)}！\\n\\n/play - 开始猜数字游戏\\n/score - 查看我的分数\\n/leaderboard - 排行榜\\n/help - 游戏规则');
});

bot.help((ctx) => {
  safeReply(ctx, '🎮 游戏规则\\n\\n🔢 猜数字：\\n输入 /play 开始一局新游戏\\n我会想一个 1-100 的数字\\n你来猜！我会告诉你是大了还是小了\\n\\n💡 越少次数猜中，得分越高！');
});

const games = new Map();

bot.command('play', (ctx) => {
  const userId = ctx.from.id;
  const target = Math.floor(Math.random() * 100) + 1;
  games.set(userId, { target, attempts: 0, started: Date.now() });
  safeReply(ctx, '🎮 新游戏开始！\\n\\n🔢 我想了一个 1-100 之间的数字，猜猜看！\\n直接输入数字即可~');
});

bot.on('text', (ctx) => {
  const userId = ctx.from.id;
  const game = games.get(userId);
  
  if (!game) return;
  
  const guess = parseInt(ctx.message.text);
  if (isNaN(guess)) return;
  
  game.attempts++;
  
  if (guess === game.target) {
    const score = Math.max(100 - game.attempts * 10, 10);
    const current = scores.get(userId) || 0;
    scores.set(userId, current + score);
    games.delete(userId);
    safeReply(ctx, \`🎉 恭喜你猜对了！\\n\\n🔢 答案是：\${game.target}\\n📊 用了 \${game.attempts} 次\\n⭐ 本次得分：+\${score}\\n🏆 总分：\${scores.get(userId)}\\n\\n/play 再来一局！\`);
  } else if (guess < game.target) {
    safeReply(ctx, \`⬆️ \${guess} 太小了！再猜猜~ (第\${game.attempts}次)\`);
  } else {
    safeReply(ctx, \`⬇️ \${guess} 太大了！再猜猜~ (第\${game.attempts}次)\`);
  }
});

bot.command('score', (ctx) => {
  const score = scores.get(ctx.from.id) || 0;
  safeReply(ctx, \`🏆 你的总分：\${score}\`);
});

bot.command('leaderboard', (ctx) => {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (sorted.length === 0) {
    safeReply(ctx, '🏆 排行榜暂无数据');
    return;
  }
  const text = sorted.map(([id, score], i) => \`\${i + 1}. 用户 \${id}: \${score} 分\`).join('\\n');
  safeReply(ctx, \`🏆 排行榜\\n\\n\${text}\`);
});

${botLaunchCode(config.name, config.emoji || '🤖')}
`,
      }],
      dependencies: ['telegraf@^4.15.0'],
    }),
  }],
  ['trading', {
    id: 'trading',
    name: 'Trading Bot',
    language: 'javascript',
    description: '交易信号推送机器人',
    emoji: '📈',
    generateCode: (config) => ({
      files: [{
        path: 'index.js',
        content: `const { Telegraf } = require('telegraf');

const BOT_NAME = process.env.BOT_NAME || 'Bot';

const bot = new Telegraf(process.env.BOT_TOKEN);

${botBootstrapCode(config.emoji || '🤖')}

// 交易机器人 - ${sanitizeForCode(config.name)}
const userSettings = new Map();

bot.start((ctx) => {
  safeReply(ctx, '📈 欢迎使用 ${sanitizeForCode(config.name)}！\\n\\n功能列表：\\n/price <币对> - 查询价格\\n/signal - 获取信号\\n/alerts - 管理价格提醒\\n/portfolio - 模拟投资组合\\n/help - 帮助');
});

bot.help((ctx) => {
  safeReply(ctx, '📈 使用指南\\n\\n/price BTC - 查询 BTC 价格\\n/signal - 获取交易信号\\n/alerts - 管理价格提醒\\n/portfolio - 查看投资组合\\n/market - 市场概况');
});

bot.command('price', (ctx) => {
  const coin = ctx.message.text.replace('/price', '').trim().toUpperCase() || 'BTC';
  // 模拟价格
  const price = (Math.random() * 50000 + 20000).toFixed(2);
  const change = (Math.random() * 10 - 5).toFixed(2);
  const icon = parseFloat(change) >= 0 ? '🟢' : '🔴';
  safeReply(ctx, \`💰 \${coin}/USDT\\n\\n📊 价格: $\${price}\\n\${icon} 24h: \${change}%\\n📊 24h高: $\${(parseFloat(price) * 1.05).toFixed(2)}\\n📊 24h低: $\${(parseFloat(price) * 0.95).toFixed(2)}\`);
});

bot.command('signal', (ctx) => {
  const signals = [
    { coin: 'BTC', action: '🟢 买入', reason: 'RSI 超卖，MACD 金叉', price: '42,350' },
    { coin: 'ETH', action: '🔴 卖出', reason: '触及阻力位，成交量萎缩', price: '2,280' },
    { coin: 'SOL', action: '🟡 观望', reason: '区间震荡，等待突破', price: '98.5' },
  ];
  const signal = signals[Math.floor(Math.random() * signals.length)];
  safeReply(ctx, \`📊 交易信号\\n\\n🪙 \${signal.coin}/USDT\\n\${signal.action}\\n💵 当前价格: $\${signal.price}\\n📝 原因: \${signal.reason}\\n\\n⚠️ 仅供参考，不构成投资建议\`);
});

bot.command('market', (ctx) => {
  safeReply(ctx, \`📊 市场概况\\n\\n🟢 BTC/USDT  $42,350  (+2.3%)\\n🟢 ETH/USDT  $2,280   (+1.8%)\\n🔴 SOL/USDT  $98.5    (-0.5%)\\n🟢 BNB/USDT  $312     (+0.9%)\\n🟡 XRP/USDT  $0.62    (+0.1%)\\n\\n⏰ 更新时间: \${new Date().toLocaleString('zh-CN')}\`);
});

bot.command('portfolio', (ctx) => {
  safeReply(ctx, \`💼 模拟投资组合\\n\\n🪙 BTC  0.5枚  $21,175  (+5.2%)\\n🪙 ETH  5枚    $11,400  (+3.1%)\\n🪙 SOL  50枚   $4,925   (-1.2%)\\n\\n💰 总价值: $37,500\\n📈 总收益: +$2,340 (+6.6%)\`);
});

bot.on('text', (ctx) => {
  const text = ctx.message.text.toLowerCase();
  if (text.startsWith('/')) return;
  
  if (text.includes('买') || text.includes('buy')) {
    safeReply(ctx, '📈 买入建议：当前市场整体偏多，建议关注 BTC 支撑位。\\n⚠️ 仅供参考！');
  } else if (text.includes('卖') || text.includes('sell')) {
    safeReply(ctx, '📉 卖出建议：注意风险管理，建议设置止损位。\\n⚠️ 仅供参考！');
  }
});

${botLaunchCode(config.name, config.emoji || '🤖')}
`,
      }],
      dependencies: ['telegraf@^4.15.0'],
    }),
  }],
  ['custom', {
    id: 'custom',
    name: 'Custom Bot',
    language: 'javascript',
    description: '自定义模板 - 最简单的 Telegram Bot',
    emoji: '🛠️',
    generateCode: (config) => ({
      files: [{
        path: 'index.js',
        content: `const { Telegraf } = require('telegraf');

const BOT_NAME = process.env.BOT_NAME || 'Bot';

const bot = new Telegraf(process.env.BOT_TOKEN);

${botBootstrapCode(config.emoji || '🤖')}

// 自定义机器人 - ${sanitizeForCode(config.name)}
bot.start((ctx) => {
  safeReply(ctx, '🤖 你好！我是 ${sanitizeForCode(config.name)}\\n\\n输入 /help 查看可用命令');
});

bot.help((ctx) => {
  safeReply(ctx, '📖 帮助\\n\\n/start - 开始\\n/help - 帮助\\n/info - 关于');
});

bot.command('info', (ctx) => {
  safeReply(ctx, \`ℹ️ 关于 \${BOT_NAME}\\n\\n版本: 1.0.0\\n状态: 运行中\\n时间: \${new Date().toISOString()}\`);
});

bot.on('text', (ctx) => {
  safeReply(ctx, \`收到: "\${ctx.message.text}"\`);
});

${botLaunchCode(config.name, config.emoji || '🤖')}
`,
      }],
      dependencies: ['telegraf@^4.15.0'],
    }),
  }],
  ['python', {
    id: 'python',
    name: 'Python Bot',
    language: 'python',
    description: 'Python Telegram Bot 模板',
    emoji: '🐍',
    generateCode: (config) => ({
      files: [{
        path: 'bot.py',
        content: `import os
import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BOT_TOKEN = os.environ.get('BOT_TOKEN', '')
BOT_NAME = os.environ.get('BOT_NAME', 'Bot')

# ── Safe reply helper ──────────────────────────────────────────
async def safe_reply(update, text):
    try:
        await update.message.reply_text(text)
    except Exception as e:
        logger.error(f"[Reply error] {e}")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await safe_reply(update, f"🐍 你好！我是 {BOT_NAME}")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await safe_reply(update, "📖 帮助\\n\\n/start - 开始\\n/help - 帮助")

async def echo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await safe_reply(update, f"收到: {update.message.text}")

def main():
    try:
        app = Application.builder().token(BOT_TOKEN).build()
        app.add_handler(CommandHandler("start", start))
        app.add_handler(CommandHandler("help", help_command))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, echo))

        # Global error handler
        async def error_handler(update, context):
            logger.error(f"[Error] {context.error}")

        app.add_error_handler(error_handler)
        logger.info(f"🐍 {BOT_NAME} is running...")
        app.run_polling(allowed_updates=Update.ALL_TYPES)
    except Exception as e:
        logger.error(f"[Fatal] {e}")

if __name__ == '__main__':
    main()
`,
      }],
      dependencies: ['python-telegram-bot>=20.0'],
    }),
  }],
])
