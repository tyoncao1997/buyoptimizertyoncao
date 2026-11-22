const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID  = process.env.TELEGRAM_ADMIN_ID;
const ADMIN_PIN = process.env.ADMIN_PIN;
const API_BASE  = process.env.API_BASE;

if (!BOT_TOKEN || !ADMIN_ID) {
  console.warn('⚠️ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_ADMIN_ID — bot tắt');
}

const bot = new Telegraf(BOT_TOKEN || 'dummy');

const fmtMoney = n => new Intl.NumberFormat('vi-VN').format(n || 0) + 'đ';
const isAdmin  = id => String(id) === String(ADMIN_ID);

async function callApi(endpoint, body = {}) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}
async function notifyAdminNewPaidOrder(order) {
  if (!BOT_TOKEN || !ADMIN_ID) return;

  const text = [
    '🔔 <b>ĐƠN MỚI ĐÃ THANH TOÁN</b>',
    '',
    `📦 Mã đơn: <code>${order.orderCode}</code>`,
    `👤 Khách: ${order.customerName || order.customerUsername || 'N/A'}`,
    `📱 SĐT: ${order.customerPhone || 'N/A'}`,
    `💰 Số tiền: <b>${fmtMoney(order.amount)}</b>`,
    `🎯 Gói: ${order.planName || order.plan || 'N/A'}`,
    order.remoteTool ? `🖥️ ${order.remoteTool}: <code>${order.remoteId}</code> / <code>${order.remotePass}</code>` : '',
    `⏰ ${new Date(order.paidAt || Date.now()).toLocaleString('vi-VN')}`
  ].filter(Boolean).join('\n');

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Hoàn thành', `complete:${order.orderCode}`),
      Markup.button.callback('❌ Từ chối', `reject:${order.orderCode}`)
    ]
  ]);

  try {
    await bot.telegram.sendMessage(ADMIN_ID, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup
    });
    console.log(`[TG] Đã báo admin đơn ${order.orderCode}`);
  } catch (err) {
    console.error('[TG] Lỗi gửi:', err.message);
  }
}
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Bot này chỉ dành cho admin.');
  }
  await ctx.reply(
    '👑 <b>TYON Admin Bot</b>\n\n' +
    'Bot sẽ tự động thông báo khi có đơn đã thanh toán chờ xử lý.\n\n' +
    'Lệnh:\n' +
    '/pending — Xem đơn đang chờ\n' +
    '/help — Trợ giúp',
    { parse_mode: 'HTML' }
  );
});

bot.help(async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply(
    '📖 <b>Hướng dẫn:</b>\n\n' +
    '• Khi có đơn mới → bot tự gửi tin nhắn\n' +
    '• Bấm ✅ Hoàn thành hoặc ❌ Từ chối\n' +
    '• Nhập mã PIN admin để xác nhận\n\n' +
    '/pending — Xem đơn chờ xử lý',
    { parse_mode: 'HTML' }
  );
});
bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  try {
    const data = await callApi('/api/admin/orders');
    const pending = (data.orders || []).filter(o =>
      o.status === 'paid' || o.status === 'pending'
    );

    if (pending.length === 0) {
      return ctx.reply('✨ Không có đơn nào đang chờ xử lý.');
    }

    const list = pending.slice(0, 15).map(o =>
      `• <code>${o.orderCode}</code> — ${fmtMoney(o.amount)} — ${o.customerName || 'N/A'}`
    ).join('\n');

    await ctx.reply(
      `📋 <b>Đơn chờ xử lý (${pending.length}):</b>\n\n${list}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.reply('❌ Lỗi kết nối server: ' + err.message);
  }
});
bot.action(/^(complete|reject):(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('⛔ Bạn không có quyền.');
  }

  const [, action, orderCode] = ctx.match;
  const actionName = action === 'complete' ? 'HOÀN THÀNH' : 'TỪ CHỐI';

  await ctx.answerCbQuery();

  // Lưu context tạm vào session (dùng Map in-memory)
  pendingActions.set(ctx.from.id, { action, orderCode });

  await ctx.reply(
    `🔐 Nhập mã PIN admin để <b>${actionName}</b> đơn <code>${orderCode}</code>:`,
    { parse_mode: 'HTML' }
  );
});
const pendingActions = new Map();
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return;

  const pending = pendingActions.get(userId);
  if (!pending) {
    return ctx.reply('ℹ️ Không có thao tác nào đang chờ. Dùng /pending để xem đơn.');
  }

  const pin = ctx.message.text.trim();
  pendingActions.delete(userId);

  if (pin !== String(ADMIN_PIN)) {
    return ctx.reply('❌ PIN không đúng. Đã hủy thao tác.');
  }

  const endpoint = pending.action === 'complete'
    ? '/api/admin/complete-order'
    : '/api/admin/reject-order';

  try {
    const data = await callApi(endpoint, { orderCode: pending.orderCode, pin });

    if (data.success) {
      await ctx.reply(
        `✅ ${data.message || 'Thành công!'}\nĐơn: <code>${pending.orderCode}</code>`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(`❌ ${data.error || 'Lỗi xử lý'}`);
    }
  } catch (err) {
    await ctx.reply('❌ Lỗi kết nối server: ' + err.message);
  }
});
function setupTelegramWebhook(app) {
  if (!BOT_TOKEN || !ADMIN_ID) {
    console.warn('⚠️ Bỏ qua setup webhook (thiếu token/admin)');
    return;
  }
  app.post('/api/telegram/webhook', async (req, res) => {
    try {
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error('[TG Webhook]', err);
    }
    res.sendStatus(200);
  });
  const url = `${API_BASE}/api/telegram/webhook`;
  bot.telegram.setWebhook(url, {
    allowed_updates: ['message', 'callback_query']
  })
    .then(() => console.log(`✅ Telegram webhook set: ${url}`))
    .catch(err => console.error('❌ Set webhook lỗi:', err.message));
}

module.exports = {
  bot,
  notifyAdminNewPaidOrder,
  setupTelegramWebhook
};