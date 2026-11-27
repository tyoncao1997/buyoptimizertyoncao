require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const archiver = require('archiver');
const { Pool } = require('pg');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');


const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const TELEGRAM_BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').trim();
const TELEGRAM_ENABLED = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_WEBHOOK_SECRET && TELEGRAM_BOT_USERNAME);
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID  = process.env.TELEGRAM_ADMIN_ID;
const ADMIN_PIN = process.env.ADMIN_PIN;
const API_BASE  = process.env.API_BASE || `http://localhost:${process.env.PORT || 3000}`;

if (!BOT_TOKEN || !ADMIN_ID) {
  console.warn('⚠️ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_ADMIN_ID — bot tắt');
}

let bot;
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    bot.use(async (ctx, next) => {
    if (ctx.from && !isAdmin(ctx.from.id)) {
        console.log(`🚫 Chặn người lạ: ${ctx.from.id}`);
        if (ctx.callbackQuery) {
            return ctx.answerCbQuery('⛔ Bạn không có quyền dùng bot này.').catch(() => {});
        }
        return;
    }
    return next();
});

} else {
    console.warn('⚠️ Không có TELEGRAM_BOT_TOKEN — bot Telegram không hoạt động');
    bot = new Telegraf('dummy:token');
}
if (BOT_TOKEN) {
    bot.telegram.getMe()
        .then(info => { bot.botInfo = info; })
        .catch(err => console.error('❌ getMe lỗi:', err.message));
}

const fmtMoney = n => new Intl.NumberFormat('vi-VN').format(n || 0) + 'đ';
const isAdmin  = id => String(id) === String(ADMIN_ID);

async function callApi(endpoint, body = {}) {
  const token = jwt.sign(
    { username: 'telegram-bot', role: 'admin' },
    JWT_SECRET,
    { expiresIn: '2m' }
  );
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
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
bot.start(async (ctx) => {
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

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  if (pendingActions.has(ctx.from.id)) {
    pendingActions.delete(ctx.from.id);
    await ctx.reply('✅ Đã hủy thao tác đang chờ.');
  } else {
    await ctx.reply('ℹ️ Không có thao tác nào đang chờ.');
  }
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

const pendingActions = new Map();

bot.action(/^(complete|reject):(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('⛔ Bạn không có quyền.');
  }

  const [, action, orderCode] = ctx.match;
  pendingActions.set(ctx.from.id, { action, orderCode });
  const actionName = action === 'complete' ? 'HOÀN THÀNH' : 'TỪ CHỐI';

  await ctx.answerCbQuery();
    await ctx.reply(
    `🔐 Nhập mã PIN admin để <b>${actionName}</b> đơn <code>${orderCode}</code>:`,
    { parse_mode: 'HTML' }
  );
});
// Admin bot text handler for order confirmation PINs.
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return next();

    const pending = pendingActions.get(userId);
    if (!pending) return next();
    pendingActions.delete(userId);

    if ((ctx.message.text || '').trim() !== String(ADMIN_PIN)) {
        return ctx.reply('PIN không đúng. Đã hủy thao tác.');
    }

    const endpoint = pending.action === 'complete'
        ? '/api/admin/complete-order'
        : '/api/admin/reject-order';
    try {
        const data = await callApi(endpoint, { orderCode: pending.orderCode, pin: String(ADMIN_PIN) });
        if (data.success) {
            await ctx.reply(`${data.message || 'Thành công!'}\nĐơn: <code>${pending.orderCode}</code>`, { parse_mode: 'HTML' });
        } else {
            await ctx.reply(data.error || 'Lỗi xử lý');
        }
    } catch (err) {
        await ctx.reply('Lỗi kết nối server: ' + err.message);
    }
});
function setupTelegramWebhook(app) {
  if (!BOT_TOKEN || !ADMIN_ID) {
    console.warn('⚠️ Bỏ qua setup webhook (thiếu token/admin)');
    return;
  }
  const url = `${API_BASE}/api/telegram/webhook`;
  bot.telegram.setWebhook(url, {
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query']
  })
  .then(() => console.log(`✅ [Telegram] Webhook đã được thiết lập: ${url}`))
  .catch(err => console.error('❌ [Telegram] Lỗi set webhook:', err.message));
  app.use(bot.webhookCallback('/api/telegram/webhook'));
}

module.exports = {
  bot,
  notifyAdminNewPaidOrder,
  setupTelegramWebhook
};

if (!TELEGRAM_ENABLED) {
    console.warn('⚠️ Telegram Bot chưa cấu hình đầy đủ');
}

const BAND_SCHEDULES_TABLE = 'band_schedules';
const BAND_APPEALS_TABLE = 'band_appeals';
const BAND_DURATION_DAYS = 7;
const BAND_DURATION_MS = BAND_DURATION_DAYS * 24 * 60 * 60 * 1000;

const BCRYPT_ROUNDS = 10;
const PORT = process.env.PORT || 3000;
const KHOAHOC_URL = process.env.KHOAHOC_URL || 'https://caoquangtuan.net';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://buyoptimizertc.infinityfreeapp.com';
const FRONTEND_URL_1 = (process.env.FRONTEND_URL_1 || '').trim().replace(/\/+$/, '');

const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const SHOP_GOOGLE_CHALLENGE_TTL_MS = 5 * 60 * 1000;

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const RESET_OTP_TTL_MS = 15 * 60 * 1000;

const TG_OTP_TTL_MS = 5 * 60 * 1000;
const TG_OTP_MAX_ATTEMPTS = 5;
const TIER_CONFIG = {
    Member: {
        name: 'Member',
        displayName: 'MEMBER',
        tierLevel: 1,
        color: '#3b82f6',
        colorSecondary: '#1d4ed8',
        colorLight: '#dbeafe',
        metallicGradient: 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 35%, #1d4ed8 70%, #1e3a8a 100%)',
        iconSvg: `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L4 6V12C4 17 7.5 21.5 12 22C16.5 21.5 20 17 20 12V6L12 2Z" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" fill="rgba(255,255,255,0.15)"/><path d="M9 12L11 14L15 10" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        tagline: 'Khởi đầu hành trình tối ưu hóa',
        minDeposit: 0,
        benefits: [
            'Mở toàn bộ module cơ bản',
            'Hỗ trợ qua WhatsApp/Zalo 24/7',
            'Truy cập shop file cơ bản'
        ]
    },
    Silver: {
        name: 'Silver',
        displayName: 'BẠC',
        tierLevel: 2,
        color: '#94a3b8',
        colorSecondary: '#64748b',
        colorLight: '#f1f5f9',
        metallicGradient: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 25%, #94a3b8 55%, #64748b 80%, #475569 100%)',
        iconSvg: `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L3 7V12C3 17 7.5 21.5 12 22C16.5 21.5 21 17 21 12V7L12 2Z" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" fill="rgba(255,255,255,0.2)"/><path d="M12 7L9 10L12 13L15 10L12 7Z" fill="#ffffff"/></svg>`,
        tagline: 'Đẳng cấp Bạc - Ưu tiên trải nghiệm',
        minDeposit: 500000,
        benefits: [
            'Tất cả quyền lợi Member',
            'Ưu tiên hỗ trợ',
            'Badge "Silver" trên hồ sơ'
        ]
    },
    Gold: {
        name: 'Gold',
        displayName: 'VÀNG',
        tierLevel: 3,
        color: '#f59e0b',
        colorSecondary: '#d97706',
        colorLight: '#fef3c7',
        metallicGradient: 'linear-gradient(135deg, #fef3c7 0%, #fcd34d 25%, #f59e0b 50%, #d97706 75%, #92400e 100%)',
        iconSvg: `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 7L6 11L9 6L12 11L15 6L18 11L21 7L19 19H5L3 7Z" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" fill="rgba(255,255,255,0.25)"/><circle cx="7" cy="15" r="1.2" fill="#ffffff"/><circle cx="12" cy="15" r="1.2" fill="#ffffff"/><circle cx="17" cy="15" r="1.2" fill="#ffffff"/></svg>`,
        tagline: 'Đẳng cấp Vàng - Ưu tiên tuyệt đối',
        minDeposit: 2000000,
        benefits: [
            'Tất cả quyền lợi Silver',
            'Ưu tiên duyệt bài/forum',
            'Badge "Gold" hiển thị nổi bật với viền vàng',
            'Tỉ tệ thưởng Voucher',
            'Hỗ trợ qua kênh riêng Telegram/Zalo/WhatsApp'
        ]
    },
    Diamond: {
        name: 'Diamond',
        displayName: 'KIM CƯƠNG',
        tierLevel: 4,
        color: '#8b5cf6',
        colorSecondary: '#7c3aed',
        colorLight: '#ede9fe',
        metallicGradient: 'linear-gradient(135deg, #f5f3ff 0%, #ddd6fe 20%, #c4b5fd 40%, #a78bfa 60%, #8b5cf6 80%, #4c1d95 100%)',
        iconSvg: `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 3H18L22 9L12 22L2 9L6 3Z" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" fill="rgba(255,255,255,0.25)"/><path d="M2 9H22M12 22L6 3M12 22L18 3" stroke="#ffffff" stroke-width="1.2" opacity="0.7"/></svg>`,
        tagline: 'Đẳng cấp Kim Cương - Đặc quyền tối thượng',
        minDeposit: 10000000,
        benefits: [
            'Tất cả quyền lợi Gold',
            'Ưu tiên xử lý đơn lớn (VIP 24/7)',
            'Badge "Diamond" phát sáng độc quyền',
            'Support riêng',
            'Tham gia nhóm VIP Discord/Telegram',
            'Ưu tiên nhận khuyến mãi sớm nhất'
        ]
    }
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});
pool.on('error', (err) => console.error('❌ Pool error:', err.message));

const emailLogPool = new Pool({
    connectionString: process.env.EMAIL_LOG_DATABASE_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});
emailLogPool.on('error', (err) => console.error('❌ Email Log Pool error:', err.message));

const GOOGLE_CLIENT_ID_1 = (process.env.GOOGLE_CLIENT_ID_1 || '').trim();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET_1 = (process.env.GOOGLE_CLIENT_SECRET_1 || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠️ Thiếu GOOGLE_CLIENT_ID - Google login admin/legacy sẽ không hoạt động');
}

const SHOP_GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID_1 || GOOGLE_CLIENT_ID;
const SHOP_GOOGLE_CLIENT_SECRET = GOOGLE_CLIENT_ID_1
    ? (GOOGLE_CLIENT_SECRET_1 || (GOOGLE_CLIENT_ID_1 === GOOGLE_CLIENT_ID ? GOOGLE_CLIENT_SECRET : ''))
    : GOOGLE_CLIENT_SECRET;
if (!SHOP_GOOGLE_CLIENT_ID) {
    console.warn('⚠️ Thiếu GOOGLE_CLIENT_ID hoặc GOOGLE_CLIENT_ID_1 - Google login shop sẽ không hoạt động');
}
const shopGoogleClient = SHOP_GOOGLE_CLIENT_ID
    ? new OAuth2Client(SHOP_GOOGLE_CLIENT_ID)
    : null;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const gmailOAuth2Client = new OAuth2Client(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);

if (process.env.GMAIL_REFRESH_TOKEN) {
    gmailOAuth2Client.setCredentials({
        refresh_token: process.env.GMAIL_REFRESH_TOKEN
    });
}

const ALLOWED_ADMIN_EMAILS = (process.env.ALLOWED_ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 5: CLOUDFLARE R2
   ═══════════════════════════════════════════════════════════════════════════ */

const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 6: ADMIN CREDENTIALS
   ═══════════════════════════════════════════════════════════════════════════ */

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_PIN || !JWT_SECRET) {
    console.error('❌ LỖI BẢO MẬT: Thiếu biến môi trường ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_PIN / JWT_SECRET');
    process.exit(1);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 7: PAYMENT GATEWAYS
   ═══════════════════════════════════════════════════════════════════════════ */

const SEPAY_WEBHOOK_SECRET = process.env.SEPAY_WEBHOOK_SECRET;
const SEPAY_BANK_ACCOUNT = process.env.SEPAY_BANK_ACCOUNT;
const SEPAY_BANK_CODE = process.env.SEPAY_BANK_CODE;
const SEPAY_ACCOUNT_HOLDER = process.env.SEPAY_ACCOUNT_HOLDER;
const SEPAY_CONFIGURED = Boolean(
    SEPAY_WEBHOOK_SECRET &&
    /^[A-Z0-9]{2,20}$/i.test(SEPAY_BANK_CODE || '') &&
    /^\d{6,20}$/.test(SEPAY_BANK_ACCOUNT || '') &&
    SEPAY_ACCOUNT_HOLDER
);

if (!SEPAY_WEBHOOK_SECRET) {
    console.warn('SePay webhook disabled until SEPAY_WEBHOOK_SECRET is configured.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 8: GIST STORAGE (Keys / Feedbacks)
   ═══════════════════════════════════════════════════════════════════════════ */

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GIST_ID = (process.env.GIST_ID || '').trim();
const GIST_FILENAME = 'database.json';
const USE_GIST = !!(GITHUB_TOKEN && GIST_ID);

const LOCAL_DB_FILE = path.join(__dirname, 'database.json');
const LOCAL_BACKUP_DIR = path.join(__dirname, 'backups');

console.log(USE_GIST ? `☁️  Storage: GitHub Gist (${GIST_ID})` : `⚠️  Storage: FILE LOCAL`);

try {
    if (!fs.existsSync(LOCAL_BACKUP_DIR)) fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
} catch (err) {
    console.error('❌ Không tạo được thư mục backup:', err.message);
}

const EMPTY_DB = () => ({ keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [] });

let gistLock = Promise.resolve();
function withGistLock(fn) {
    const next = gistLock.then(fn, fn);
    gistLock = next.catch(() => {});
    return next;
}

function gistRequest(method, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: `/gists/${GIST_ID}`,
            method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'TyonOptimizer',
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); } catch { resolve(data); }
                } else {
                    reject(new Error(`Gist API ${res.statusCode}: ${data.substring(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Gist request timeout')));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function fetchRaw(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'TyonOptimizer' } }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function loadFromGist() {
    if (!USE_GIST) return null;
    try {
        const gist = await gistRequest('GET');
        const file = gist.files && gist.files[GIST_FILENAME];
        if (!file) return EMPTY_DB();
        let content;
        if (file.truncated && file.raw_url) content = await fetchRaw(file.raw_url);
        else content = file.content;
        const parsed = JSON.parse(content || '{}');
        const result = EMPTY_DB();
        for (const k of ['keys', 'confirmedKeys', 'feedbackKeys', 'feedbacks']) {
            if (Array.isArray(parsed[k])) result[k] = parsed[k];
        }
        return result;
    } catch (err) {
        console.error('❌ Lỗi load Gist:', err.message);
        return null;
    }
}

function buildGistData(db) {
    return {
        keys: db.keys || [],
        confirmedKeys: db.confirmedKeys || [],
        feedbackKeys: db.feedbackKeys || [],
        feedbacks: db.feedbacks || [],
    };
}

async function saveToGist(data) {
    if (!USE_GIST) return false;
    try {
        const gistData = buildGistData(data);
        await gistRequest('PATCH', {
            files: { [GIST_FILENAME]: { content: JSON.stringify(gistData, null, 2) } }
        });
        return true;
    } catch (err) {
        console.error('❌ Lỗi save Gist:', err.message);
        return false;
    }
}

function saveLocal(data) {
    try {
        const tmp = LOCAL_DB_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, LOCAL_DB_FILE);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(LOCAL_DB_FILE, path.join(LOCAL_BACKUP_DIR, `db-${ts}.json`));
        const backups = fs.readdirSync(LOCAL_BACKUP_DIR)
            .filter(f => f.startsWith('db-')).sort().reverse();
        backups.slice(5).forEach(f => { try { fs.unlinkSync(path.join(LOCAL_BACKUP_DIR, f)); } catch (_) {} });
    } catch (err) {
        console.error('❌ Lỗi save local:', err.message);
    }
}

function loadLocal() {
    try {
        if (!fs.existsSync(LOCAL_DB_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_FILE, 'utf8'));
        const result = EMPTY_DB();
        for (const k of ['keys', 'confirmedKeys', 'feedbackKeys', 'feedbacks']) {
            if (Array.isArray(data[k])) result[k] = data[k];
        }
        return result;
    } catch { return null; }
}

async function readStorage() {
    if (USE_GIST) {
        const data = await loadFromGist();
        if (data) return data;
        return loadLocal() || EMPTY_DB();
    }
    return loadLocal() || EMPTY_DB();
}

async function writeStorage(data, { strictGist = false } = {}) {
    if (USE_GIST) {
        return withGistLock(async () => {
            const ok = await saveToGist(data);
            if (!ok && strictGist) throw new Error('Không thể ghi lên Gist');
            saveLocal(data);
            return ok;
        });
    }
    saveLocal(data);
    return true;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 9: IN-MEMORY STORES
   ═══════════════════════════════════════════════════════════════════════════ */

const telegramOtpStore = new Map();
const registerOtpStore = new Map();
const otpStore = new Map();
const emailQueue = [];
let isProcessingQueue = false;
let isSendingNotification = false;

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of telegramOtpStore.entries()) {
        if (now > v.expiresAt) telegramOtpStore.delete(k);
    }
    for (const [k, v] of registerOtpStore.entries()) {
        if (now > v.expiresAt) registerOtpStore.delete(k);
    }
    for (const [k, v] of otpStore.entries()) {
        if (now > v.expiresAt) otpStore.delete(k);
    }
}, 5 * 60 * 1000).unref();

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 10: UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════════════════════════════ */

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function isValidEmail(email) {
    return typeof email === 'string' && /^\S+@\S+\.\S+$/.test(email);
}

function isValidUsername(username) {
    return typeof username === 'string' && username.length >= 4 && /^[a-zA-Z0-9_]+$/.test(username);
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeHtmlTg(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function safeParseJSON(value, fallback = []) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value) || fallback; } catch { return fallback; }
    }
    return fallback;
}

function hashShopGoogleValue(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function timingSafeHashEquals(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' ||
        !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function calculateTier(totalDeposit) {
    if (totalDeposit >= 10000000) return 'Diamond';
    if (totalDeposit >= 2000000) return 'Gold';
    if (totalDeposit >= 500000) return 'Silver';
    return 'Member';
}

function getTierLevel(tierName) {
    return TIER_CONFIG[tierName]?.tierLevel || 1;
}

function calcRemainingTime(createdAt, status) {
    if (status !== 'pending') return null;
    const diffMs = (new Date(createdAt).getTime() + KEY_EXPIRE_MS) - Date.now();
    if (diffMs <= 0) return { hours: 0, minutes: 0, totalHours: 0, isExpired: true };
    return {
        hours: Math.floor(diffMs / 3600000),
        minutes: Math.floor((diffMs % 3600000) / 60000),
        totalHours: diffMs / 3600000,
        isExpired: false
    };
}

function generateOrderCode() {
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase().slice(-6);
    return `TYON${random}${timestamp}`;
}

function safeCompareToken(input, expected) {
    if (!input || !expected) return false;
    try {
        const a = Buffer.from(input);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

function verifyAdmin(username, password) {
    if (username !== ADMIN_USERNAME) return false;
    try {
        const a = Buffer.from(password || '');
        const b = Buffer.from(ADMIN_PASSWORD || '');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

function verifyPin(pin) {
    if (!pin || !ADMIN_PIN || pin.length !== ADMIN_PIN.length) return false;
    try {
        const a = Buffer.from(pin);
        const b = Buffer.from(ADMIN_PIN);
        return crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 11: TELEGRAM API
   ═══════════════════════════════════════════════════════════════════════════ */

async function telegramApiCall(method, payload) {
    if (!TELEGRAM_ENABLED) throw new Error('Telegram chưa cấu hình');
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram API ${method}: ${data.description || 'unknown'}`);
    return data.result;
}

async function registerTelegramWebhook(baseUrl) {
    if (!TELEGRAM_ENABLED) return;
    try {
        await telegramApiCall('setWebhook', {
            url: `${baseUrl}/api/telegram/webhook`,
            secret_token: TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ['message'],
            drop_pending_updates: false
        });
        console.log(`✅ Đã đăng ký Telegram Webhook`);
    } catch (err) {
        console.error('❌ Lỗi đăng ký Telegram Webhook:', err.message);
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 12: DB HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

async function getUserByUsername(username) {
    if (!username) return null;
    const { rows } = await pool.query(
        'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
        [username.trim()]
    );
    return rows[0] || null;
}

async function getOrdersFromSupabase() {
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        return rows.map(o => ({
            orderCode: o.order_code, key: o.key, plan: o.plan, planName: o.plan_name,
            customerName: o.customer_name, amount: Number(o.amount), status: o.status,
            createdAt: o.created_at, paidAt: o.paid_at, paidAmount: Number(o.paid_amount || 0),
            transactionId: o.transaction_id, sepayTransactionId: o.sepay_transaction_id,
            confirmedBy: o.confirmed_by, note: o.note || '',
            customerUsername: o.customer_username,
            customerPhone: o.customer_phone,
            remoteTool: o.remote_tool,
            remoteId: o.remote_id,
            remotePass: o.remote_pass
        }));
    } catch (err) {
        console.error('❌ Lỗi đọc orders:', err.message);
        return [];
    }
}

async function upsertOrderToSupabase(order) {
    try {
        await pool.query(`
            INSERT INTO orders (order_code, key, plan, plan_name, customer_name, amount,
                                status, created_at, paid_at, paid_amount, transaction_id,
                                sepay_transaction_id, confirmed_by, note,
                                customer_username, customer_phone, remote_tool, remote_id, remote_pass)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            ON CONFLICT (order_code) DO UPDATE SET
                status = EXCLUDED.status,
                paid_at = EXCLUDED.paid_at,
                paid_amount = EXCLUDED.paid_amount,
                transaction_id = EXCLUDED.transaction_id,
                sepay_transaction_id = EXCLUDED.sepay_transaction_id,
                confirmed_by = EXCLUDED.confirmed_by,
                note = EXCLUDED.note,
                customer_username = EXCLUDED.customer_username,
                customer_phone = EXCLUDED.customer_phone,
                remote_tool = EXCLUDED.remote_tool,
                remote_id = EXCLUDED.remote_id,
                remote_pass = EXCLUDED.remote_pass;
        `, [
            order.orderCode, order.key, order.plan, order.planName || null,
            order.customerName || null, order.amount, order.status || 'pending',
            order.createdAt || new Date().toISOString(), order.paidAt || null,
            order.paidAmount || 0, order.transactionId || null,
            order.sepayTransactionId || null, order.confirmedBy || null, order.note || '',
            order.customerUsername || null, order.customerPhone || null,
            order.remoteTool || null, order.remoteId || null, order.remotePass || null
        ]);
        return true;
    } catch (err) {
        console.error('❌ Lỗi upsert order:', err.message);
        return false;
    }
}

async function checkAndSendTierUpgrade(username, oldDepositHistory) {
    try {
        const dbUser = await getUserByUsername(username);
        if (!dbUser || !dbUser.email) return;
        const newDeposits = safeParseJSON(dbUser.deposit_history);
        const newTotalDeposit = newDeposits.reduce((sum, item) => {
            if (item.method === 'refund_rejected_order' || item.method === 'admin_refund') return sum;
            return sum + (Number(item.amount) || 0);
        }, 0);
        const oldDeposits = oldDepositHistory || [];
        const oldTotalDeposit = oldDeposits.reduce((sum, item) => {
            if (item.method === 'refund_rejected_order' || item.method === 'admin_refund') return sum;
            return sum + (Number(item.amount) || 0);
        }, 0);

        const oldTier = calculateTier(oldTotalDeposit);
        const newTier = calculateTier(newTotalDeposit);
        if (getTierLevel(newTier) <= getTierLevel(oldTier)) {
            console.log(`ℹ️ [Tier] ${username}: ${oldTier} → ${newTier} (skip)`);
            return;
        }

        console.log(`🎉 [Tier] ${username} THĂNG HẠNG: ${oldTier} → ${newTier}`);
        const tier = TIER_CONFIG[newTier];
        if (!tier) return;
        const subjectMap = {
            Silver:  `🥈 [TyonCao] Bạn đã thăng hạng BẠC`,
            Gold:    `🥇 [TyonCao] Bạn đã thăng hạng VÀNG`,
            Diamond: `💎 [TyonCao] Bạn đã thăng hạng KIM CƯƠNG`,
        };
        const emailSubject = subjectMap[newTier] || `✨ [TyonCao] Bạn đã thăng hạng ${tier.displayName}`;
        queueEmail(
            dbUser.email,
            emailSubject,
            emailTemplates.tierUpgrade(
                dbUser.full_name || username,
                tier.name,
                tier.displayName,
                tier.color,
                tier.colorSecondary,
                tier.colorLight,
                tier.metallicGradient,
                tier.iconSvg,
                tier.tagline,
                newTotalDeposit,
                tier.benefits
            )
        ).catch(err => console.error('❌ Lỗi gửi mail tier upgrade:', err.message));
    } catch (err) {
        console.error('❌ checkAndSendTierUpgrade error:', err.message);
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 13: INIT & MIGRATE DB
   ═══════════════════════════════════════════════════════════════════════════ */

async function initDB() {
    if (!pool) return;
    try {
        const { rows } = await pool.query('SELECT COUNT(*) FROM users');
        console.log(`✅ Đã kết nối Supabase. Tổng số Users: ${rows[0].count}`);
    } catch (err) {
        console.error('❌ Lỗi kết nối Supabase:', err.message);
    }
}

async function initTuTienCheckinHistory() {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_cultivation_checkins (
                username VARCHAR(100) NOT NULL,
                checkin_date DATE NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (username, checkin_date)
            )
        `);
    } catch (error) {
        console.error('❌ Không thể khởi tạo lịch sử điểm danh tu vi:', error.message);
        throw error;
    }
}

async function migratePlaintextPasswords() {
    try {
        const { rows } = await pool.query('SELECT username, password FROM users');
        let count = 0;
        for (const row of rows) {
            if (row.password && !row.password.startsWith('$2')) {
                try {
                    const hashed = await bcrypt.hash(row.password, BCRYPT_ROUNDS);
                    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashed, row.username]);
                    count++;
                } catch (e) {
                    console.error(`  ❌ Lỗi hash user ${row.username}:`, e.message);
                }
            }
        }
        if (count > 0) console.log(`🔐 [MIGRATE] Đã hash ${count} mật khẩu plaintext cũ`);
    } catch (err) {
        console.error('❌ Lỗi migrate password:', err.message);
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 14: CLEANUP EXPIRED KEYS
   ═══════════════════════════════════════════════════════════════════════════ */

async function cleanupExpiredKeys() {
    let deletedCount = 0;
    try {
        const db = await readStorage();
        if (db && Array.isArray(db.keys)) {
            const before = db.keys.length;
            db.keys = db.keys.filter(k => {
                if (k.status !== 'pending') return true;
                const age = Date.now() - new Date(k.createdAt).getTime();
                return age <= KEY_EXPIRE_MS;
            });
            
            const keysDeleted = before - db.keys.length;
            if (keysDeleted > 0) {
                await writeStorage(db);
                console.log(`🧹 Đã xóa ${keysDeleted} key pending hết hạn.`);
                deletedCount += keysDeleted;
            }
        }
    } catch (err) {
        console.error('❌ Lỗi dọn dẹp keys:', err.message);
    }
    if (pool) {
        try {
            const now = Date.now();
            const expireBefore24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
            const expireBefore18Months = new Date(now - 18 * 30 * 24 * 60 * 60 * 1000).toISOString();
            const { rowCount: pendingCount } = await pool.query(
                `DELETE FROM orders WHERE status = 'pending' AND created_at < $1`,
                [expireBefore24h]
            );
            if (pendingCount > 0) {
                console.log(`🧹 Đã XÓA ${pendingCount} đơn pending quá 24h.`);
                deletedCount += pendingCount;
            }
            const { rowCount: cancelCount } = await pool.query(
                `DELETE FROM orders WHERE status IN ('cancelled', 'rejected') AND created_at < $1`,
                [expireBefore24h]
            );
            if (cancelCount > 0) {
                console.log(`🧹 Đã XÓA ${cancelCount} đơn bị từ chối quá 24h.`);
                deletedCount += cancelCount;
            }
            const { rowCount: archiveCount } = await pool.query(
                `DELETE FROM orders WHERE status IN ('paid', 'completed', 'refunded') AND created_at < $1`,
                [expireBefore18Months]
            );
            if (archiveCount > 0) {
                console.log(`🧹 Đã XÓA ${archiveCount} đơn cũ quá 18 tháng.`);
                deletedCount += archiveCount;
            }
        } catch (err) {
            console.error('❌ Lỗi dọn dẹp orders:', err.message);
        }
    }

    return { deletedCount };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 15: EMAIL SYSTEM (Gmail API)
   ═══════════════════════════════════════════════════════════════════════════ */

async function writeEmailLogToDB(to, subject, status, errorMessage = null) {
    try {
        await emailLogPool.query(
            `INSERT INTO email_logs (recipient, subject, status, error_message, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [to, subject, status, errorMessage]
        );
    } catch (err) {
        console.error('❌ Không thể ghi log email vào DB:', err.message);
    }
}

async function sendEmailCore(to, subject, htmlContent, retries = 3) {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
        console.warn('⚠️ Chưa cấu hình GMAIL_API, không thể gửi mail.');
        await writeEmailLogToDB(to, subject, 'FAILED', 'Missing GMAIL Config');
        return false;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { token } = await gmailOAuth2Client.getAccessToken();
            
            const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
            const messageParts = [
                `To: ${to}`,
                'Content-Type: text/html; charset=utf-8',
                'MIME-Version: 1.0',
                `Subject: ${utf8Subject}`,
                '',
                htmlContent
            ];
            const message = messageParts.join('\n');
            const encodedMessage = Buffer.from(message)
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ raw: encodedMessage })
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error?.message || 'Gmail API error');
            }

            console.log(` [Email] Đã gửi đến ${to}: ${subject} (Lần thử: ${attempt})`);
            await writeEmailLogToDB(to, subject, 'SUCCESS');
            return true;
        } catch (error) {
            console.error(`❌ [Email] Lỗi gửi (Lần ${attempt}/${retries}):`, error.message);
            if (attempt === retries) {
                await writeEmailLogToDB(to, subject, 'FAILED', error.message);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return false;
}

async function processEmailQueue() {
    if (isProcessingQueue || emailQueue.length === 0) return;
    isProcessingQueue = true;

    while (emailQueue.length > 0) {
        const { to, subject, htmlContent } = emailQueue.shift();
        await sendEmailCore(to, subject, htmlContent);
        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    isProcessingQueue = false;
}

function queueEmail(to, subject, htmlContent) {
    return new Promise((resolve) => {
        emailQueue.push({ to, subject, htmlContent });
        processEmailQueue();
        resolve(true);
    });
}

async function sendEmailImmediate(to, subject, htmlContent) {
    return await sendEmailCore(to, subject, htmlContent);
}

function buildEmailHeaders({ to, subject, messageId, replyTo, unsubscribeUrl }) {
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const domain = (process.env.EMAIL_FROM_DOMAIN || 'tyoncao.com').trim();
    const fromEmail = (process.env.EMAIL_FROM_ADDRESS || `no-reply@${domain}`).trim();
    const fromName = (process.env.EMAIL_FROM_NAME || 'TyonCao Global Optimizer').trim();

    const headers = [
        `From: "${fromName}" <${fromEmail}>`,
        `To: ${to}`,
        `Subject: ${utf8Subject}`,
        `Message-ID: <${messageId}@${domain}>`,
        `Date: ${new Date().toUTCString()}`,
        `Reply-To: ${replyTo || fromEmail}`,
        `X-Mailer: TyonCao-Notification-System`,
        `Precedence: bulk`,
        `List-Unsubscribe: <${unsubscribeUrl}>, <mailto:unsubscribe@${domain}?subject=unsubscribe>`,
        `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
        `X-Auto-Response-Suppress: All`,
        `Auto-Submitted: auto-generated`,
    ];
    return { headers, fromEmail, fromName, domain };
}

async function sendNotificationEmail({ to, subject, htmlContent, textContent, messageId, unsubscribeUrl }) {
    try {
        const { token } = await gmailOAuth2Client.getAccessToken();
        const { headers } = buildEmailHeaders({
            to, subject, messageId, unsubscribeUrl
        });

        const rawMime = [
            ...headers,
            'MIME-Version: 1.0',
            `Content-Type: multipart/alternative; boundary="BOUNDARY_${messageId}"`,
            '',
            `--BOUNDARY_${messageId}`,
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from(textContent || stripHtml(htmlContent) || ' ').toString('base64'),
            `--BOUNDARY_${messageId}`,
            'Content-Type: text/html; charset="UTF-8"',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from(htmlContent).toString('base64'),
            `--BOUNDARY_${messageId}--`
        ].join('\r\n');

        const encodedMessage = Buffer.from(rawMime)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ raw: encodedMessage })
        });

        if (!response.ok) {
            const errData = await response.json();
            console.error('🔴 Gmail API Error Details:', errData);
            throw new Error(errData.error?.message || `Gmail API ${response.status}`);
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 16: EMAIL TEMPLATES
   ═══════════════════════════════════════════════════════════════════════════ */

const emailTemplates = {
    welcome: (fullName, username) => `
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#0f172a; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#0f172a; padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,0.35);">
          <tr>
            <td style="background:linear-gradient(135deg, #0f172a 0%, #1e293b 45%, #0e7490 100%); padding:48px 40px 40px; text-align:center;">
              <div style="display:inline-block; padding:10px 22px; border:1px solid rgba(212,175,55,0.5); border-radius:50px; margin-bottom:20px;">
                <span style="color:#d4af37; font-size:11px; letter-spacing:3px; font-weight:600; text-transform:uppercase;">Premium Membership</span>
              </div>
              <h1 style="margin:0; color:#ffffff; font-size:26px; font-weight:300; letter-spacing:4px; text-transform:uppercase;">TyonCao</h1>
              <p style="margin:8px 0 0; color:#d4af37; font-size:13px; letter-spacing:6px; font-weight:500; text-transform:uppercase;">Global Optimizer</p>
              <div style="width:60px; height:2px; background:linear-gradient(90deg, transparent, #d4af37, transparent); margin:24px auto 0;"></div>
            </td>
          </tr>
          <tr>
            <td style="padding:48px 44px 32px; background-color:#ffffff;">
              <p style="margin:0 0 8px; color:#0e7490; font-size:12px; letter-spacing:2px; font-weight:600; text-transform:uppercase;">Kính gửi Quý khách</p>
              <h2 style="margin:0 0 24px; color:#0f172a; font-size:24px; font-weight:600; line-height:1.3;">${fullName}</h2>
              <p style="margin:0 0 18px; color:#475569; font-size:15px; line-height:1.8;">
                Thay mặt <strong style="color:#0f172a;">TyonCao Global Optimizer</strong>, chúng tôi trân trọng gửi đến Quý khách lời chào mừng nồng nhiệt nhất.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0;">
                <tr>
                  <td style="background:linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border-left:3px solid #d4af37; border-radius:8px; padding:24px 28px;">
                    <p style="margin:0 0 6px; color:#64748b; font-size:11px; letter-spacing:1.5px; font-weight:600; text-transform:uppercase;">Tài khoản đã được kích hoạt</p>
                    <p style="margin:0; color:#0f172a; font-size:18px; font-weight:600; font-family:'Courier New', monospace;">${username}</p>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 32px;">
                <tr>
                  <td align="center" style="border-radius:50px; background:linear-gradient(135deg, #0e7490 0%, #0891b2 100%);">
                    <a href="https://api.whatsapp.com/send/?phone=84978568965" style="display:inline-block; padding:14px 40px; color:#ffffff; font-size:14px; font-weight:600; text-decoration:none; border-radius:50px;">Liên hệ Chuyên viên</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#0f172a; padding:32px 40px; text-align:center;">
              <p style="margin:0; color:#d4af37; font-size:12px; letter-spacing:3px; font-weight:600; text-transform:uppercase;">TyonCao Global Optimizer</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,

    tierUpgrade: (fullName, tierName, tierDisplayName, tierColor, tierColorSecondary, tierColorLight, metallicGradient, tierIconSvg, tagline, totalDeposit, benefits) => `
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chúc mừng bạn đã thăng hạng ${tierDisplayName}</title>
</head>
<body style="margin:0; padding:0; background:#0a0e1a; font-family:'Segoe UI',Tahoma,Geneva,Verdana,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0a0e1a 0%,#0f172a 50%,#0a0e1a 100%); padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px; width:100%; background:#ffffff; border-radius:24px; overflow:hidden; box-shadow:0 30px 80px rgba(0,0,0,0.6);">
          <tr>
            <td style="background:${metallicGradient}; padding:48px 40px 40px; text-align:center;">
              <div style="margin-bottom:20px;">
                <svg width="70" height="35" viewBox="0 0 70 35" fill="none"><path d="M5 30L12 8L24 20L35 3L46 20L58 8L65 30H5Z" stroke="#ffffff" stroke-width="1.8" fill="rgba(255,255,255,0.25)" stroke-linejoin="round"/></svg>
              </div>
              <div style="display:inline-block; padding:9px 26px; background:rgba(255,255,255,0.18); border:1px solid rgba(255,255,255,0.45); border-radius:50px; margin-bottom:20px;">
                <span style="color:#ffffff; font-size:11px; letter-spacing:4px; font-weight:700; text-transform:uppercase;">✦ CHÚC MỪNG THĂNG HẠNG ✦</span>
              </div>
              <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:300; letter-spacing:7px; text-transform:uppercase;">TYONCAO</h1>
              <p style="margin:6px 0 0; color:#ffffff; font-size:11px; letter-spacing:9px; font-weight:500; text-transform:uppercase; opacity:0.9;">Global Optimizer</p>
            </td>
          </tr>
          <tr>
            <td style="text-align:center; padding:0; background:#ffffff;">
              <div style="margin:-52px auto 0; width:104px; height:104px; background:${metallicGradient}; border-radius:50%; display:flex; align-items:center; justify-content:center; box-shadow:0 15px 45px ${tierColor}80, 0 0 0 6px #ffffff; position:relative; z-index:2;">${tierIconSvg}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 44px 8px; text-align:center; background:#ffffff;">
              <p style="margin:0 0 6px; color:#94a3b8; font-size:11px; letter-spacing:3px; font-weight:600; text-transform:uppercase;">Kính gửi Quý khách ${fullName}</p>
              <h2 style="margin:0 0 10px; color:#0f172a; font-size:13px; font-weight:600; letter-spacing:4px; text-transform:uppercase;">Bạn đã chính thức trở thành</h2>
              <h1 style="margin:0 0 16px; font-size:44px; font-weight:900; letter-spacing:3px; line-height:1.05; background:${metallicGradient}; -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; text-transform:uppercase;">${tierDisplayName}</h1>
              <p style="margin:0 0 4px; color:${tierColorSecondary}; font-size:14px; font-weight:600; font-style:italic;">"${tagline}"</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 44px; text-align:center; background:#ffffff;">
              <p style="margin:0; color:#475569; font-size:15px; line-height:1.8;">
                Với tổng nạp tích lũy <strong style="color:${tierColorSecondary};">${new Intl.NumberFormat('vi-VN').format(totalDeposit)} VNĐ</strong>, Quý khách đã chính thức bước vào hàng ngũ <strong style="color:${tierColorSecondary};">${tierDisplayName}</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 44px 24px; background:#ffffff;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${metallicGradient}; border-radius:16px 16px 0 0;">
                <tr>
                  <td style="padding:18px 24px; text-align:center;">
                    <span style="color:#ffffff; font-size:12px; font-weight:800; letter-spacing:3px; text-transform:uppercase;">ĐẶC QUYỀN CỦA BẠN</span>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(180deg, ${tierColorLight} 0%, #ffffff 100%); border:1px solid ${tierColor}40; border-top:none; border-radius:0 0 16px 16px;">
                <tr>
                  <td style="padding:20px 24px;">
                    ${benefits.map((b, i) => `
                      <div style="margin-bottom:${i === benefits.length - 1 ? '0' : '12px'}; color:#1e293b; font-size:14px; line-height:1.6; font-weight:600;">
                        ✓ ${b}
                      </div>
                    `).join('')}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%); padding:32px 40px; text-align:center;">
              <p style="margin:0; color:${tierColor}; font-size:11px; letter-spacing:4px; font-weight:700; text-transform:uppercase;">TyonCao Global Optimizer</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`,

    kycSuccess: (fullName) => `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><title>Xác thực danh tính thành công</title></head>
<body style="margin: 0; padding: 0; background-color: #0f172a; font-family: 'Segoe UI', Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%); padding: 40px 15px;">
        <tr>
            <td align="center">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);">
                    <tr>
                        <td style="background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 50%, #3b82f6 100%); padding: 40px 30px; text-align: center;">
                            <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff; letter-spacing: 1.5px; text-transform: uppercase;">TYONCAO</h1>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px;">
                            <h2 style="margin: 0 0 8px; font-size: 24px; font-weight: 700; color: #0f172a;">Xác thực danh tính thành công</h2>
                            <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.7; color: #334155;">
                                Xin chào <strong>${fullName}</strong>, yêu cầu xác minh danh tính (KYC) của bạn đã được <strong style="color: #059669;">phê duyệt thành công</strong>.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="background: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0; text-align: center;">
                            <p style="margin: 0; font-size: 12px; color: #94a3b8;">© ${new Date().getFullYear()} TyonCao Global Optimizer</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
`,

    forgotPassword: (fullName, otp) => `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><title>Đặt lại mật khẩu</title></head>
<body style="margin:0; padding:0; background-color:#eef2f7; font-family: 'Segoe UI', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef2f7; padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:16px; overflow:hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #e67e22 200%); padding:36px 40px; text-align:center;">
              <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:700;">TYONCAO <span style="color:#e67e22;">GLOBAL</span> OPTIMIZER</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:44px 40px 20px;">
              <h2 style="margin:0 0 12px; color:#0f172a; font-size:22px; font-weight:700; text-align:center;">Yêu cầu đặt lại mật khẩu</h2>
              <p style="margin:0 0 8px; color:#334155; font-size:15px;">Xin chào <strong>${fullName}</strong>,</p>
              <p style="margin:0 0 24px; color:#334155; font-size:14px;">Vui lòng sử dụng mã xác thực bên dưới. Mã có hiệu lực trong <strong style="color:#e67e22;">15 phút</strong>.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td align="center">
                    <div style="display:inline-block; background: linear-gradient(135deg, #fef5e7 0%, #fde8c4 100%); border:1px solid #f5c98a; border-radius:12px; padding:22px 40px;">
                      <div style="font-size:11px; color:#b45309; letter-spacing:2.5px; font-weight:600; text-transform:uppercase;">Mã xác thực</div>
                      <div style="font-size:38px; font-weight:800; letter-spacing:10px; color:#c2620a; font-family:'Courier New', monospace;">${otp}</div>
                    </div>
                  </td>
                </tr>
              </table>
              <p style="margin:0; color:#0f172a; font-size:14px; font-weight:700;">Đội ngũ TyonCao Global Optimizer</p>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc; border-top:1px solid #e2e8f0; padding:24px 40px; text-align:center;">
              <p style="margin:0; color:#cbd5e1; font-size:11px;">© ${new Date().getFullYear()} TyonCao Global Optimizer</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`,

    purchaseInvoice: (order) => `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><title>Xác nhận đơn hàng</title></head>
<body style="margin:0; padding:0; background:#eef2f7; font-family: 'Segoe UI', Arial, sans-serif;">
  <div style="max-width:620px; margin:0 auto; padding:32px 16px;">
    <div style="text-align:center; padding:8px 0 28px;">
      <h1 style="margin:14px 0 4px; font-size:19px; font-weight:800; letter-spacing:2px; color:#1e3a5f;">TYONCAO GLOBAL OPTIMIZER</h1>
    </div>
    <div style="background:#ffffff; border-radius:18px; overflow:hidden; box-shadow:0 10px 40px rgba(15,23,42,0.08); border:1px solid #e2e8f0;">
      <div style="background:linear-gradient(135deg,#0f2744 0%,#1e3a5f 50%,#2c5282 100%); padding:32px 24px; text-align:center;">
        <h2 style="margin:0 0 6px; color:#ffffff; font-size:21px; font-weight:700;">GIAO DỊCH THÀNH CÔNG</h2>
        <p style="margin:0; color:#cbd5e1; font-size:13px;">Cảm ơn Quý khách đã tin tưởng TyonCao Shop</p>
      </div>
      <div style="padding:28px 24px;">
        <div style="background:#f8fafc; border:1px dashed #cbd5e1; border-radius:12px; padding:14px 18px; text-align:center; margin-bottom:24px;">
          <p style="margin:0 0 4px; font-size:10px; text-transform:uppercase; color:#64748b; font-weight:600;">Mã đơn hàng</p>
          <p style="margin:0; font-size:18px; font-weight:800; color:#1e3a5f;">#${order.orderCode}</p>
        </div>
        <table style="width:100%; border-collapse:separate; border-spacing:0; font-size:14px; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden;">
          <tr>
            <td style="padding:13px 16px; background:#f8fafc; color:#64748b; font-weight:600; width:42%;">Tên khách hàng</td>
            <td style="padding:13px 16px; color:#0f172a; font-weight:600;">${order.customerName}</td>
          </tr>
          <tr>
            <td style="padding:13px 16px; background:#f8fafc; color:#64748b; font-weight:600;">Gói dịch vụ</td>
            <td style="padding:13px 16px; color:#0f172a; font-weight:600;">${order.planName}</td>
          </tr>
          <tr>
            <td style="padding:13px 16px; background:#f8fafc; color:#64748b; font-weight:600;">Số tiền</td>
            <td style="padding:13px 16px;">
              <span style="color:#dc2626; font-weight:800; font-size:16px;">${new Intl.NumberFormat('vi-VN').format(order.amount)}</span> VNĐ
            </td>
          </tr>
          <tr>
            <td style="padding:13px 16px; background:#f8fafc; color:#64748b; font-weight:600;">Key kích hoạt</td>
            <td style="padding:13px 16px;">
              <span style="display:inline-block; background:#eff6ff; color:#1d4ed8; font-family:'Courier New',monospace; font-weight:700; padding:6px 12px; border-radius:8px;">${order.key}</span>
            </td>
          </tr>
        </table>
      </div>
    </div>
  </div>
</body>
</html>
`
};

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 17: EXPRESS SETUP
   ═══════════════════════════════════════════════════════════════════════════ */

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 18: RATE LIMITERS
   ═══════════════════════════════════════════════════════════════════════════ */

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    skip: (req) => req.path.startsWith('/api/admin/'),  
    message: { error: 'Quá nhiều request. Vui lòng thử lại sau 15 phút.' }
});
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 2400,
    message: { error: 'Quá nhiều request admin. Vui lòng thử lại sau.' }
});
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 5, skipSuccessfulRequests: true,
    message: { error: 'Sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.' }
});
const registrationOtpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        code: 'REGISTRATION_IP_LIMIT',
        error: 'IP này đã tạo nhiều tài khoản trong thời gian ngắn. Vui lòng thử lại sau hoặc liên hệ admin.'
    }
});
const registrationAccountLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        code: 'REGISTRATION_IP_LIMIT',
        error: 'IP này đã tạo nhiều tài khoản trong thời gian ngắn. Vui lòng thử lại sau hoặc liên hệ admin.'
    }
});
const shopGoogleChallengeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Quá nhiều yêu cầu đăng nhập Google. Vui lòng thử lại sau.' }
});
const shopGoogleLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Quá nhiều lần xác thực Google. Vui lòng thử lại sau.' }
});
const pollingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 500,
    message: { error: 'Quá nhiều request. Vui lòng thử lại sau.' }
});
const notificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 1000,
    message: { error: 'Quá nhiều request thông báo. Vui lòng thử lại sau.' }
});

app.use('/api/order-status/', pollingLimiter);
app.use('/api/user/notifications', notificationLimiter);
app.use('/api/admin/', adminLimiter);
app.use('/api/', globalLimiter);

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 19: CORS
   ═══════════════════════════════════════════════════════════════════════════ */

const CORS_ALLOWED_ORIGINS = [
    FRONTEND_URL,
    ...(FRONTEND_URL_1 ? [FRONTEND_URL_1] : []),
    'https://buyoptimizertc.infinityfreeapp.com',
    'https://tcsmmo.infinityfreeapp.com',
    'https://buyoptimizertyoncao.onrender.com',
    'https://dashboardtc.infinityfreeapp.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
].map(origin => origin.replace(/\/+$/, ''));
const CORS_ALLOWED_ORIGIN_SET = new Set(CORS_ALLOWED_ORIGINS);

app.use(cors({
    origin: CORS_ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key']
}));

app.post('/api/sepay-webhook', express.raw({ type: 'application/json' }), handleSePayWebhook);

app.use(express.json({ limit: '50mb' }));
setupTelegramWebhook(app);

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 20: AUTH MIDDLEWARES
   ═══════════════════════════════════════════════════════════════════════════ */

async function requireUserSession(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Chưa đăng nhập', code: 'NO_TOKEN' });
        }
        const token = authHeader.substring(7);
        const { rows } = await pool.query(`
            SELECT s.*, u.status AS user_status
            FROM sessions s
            LEFT JOIN users u ON LOWER(s.username) = LOWER(u.username)
            WHERE s.token = $1
        `, [token]);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Phiên không hợp lệ', code: 'INVALID_TOKEN' });
        }
        const session = rows[0];
        const now = Date.now();
        const lastActivity = new Date(session.last_activity).getTime();
        const createdAt = new Date(session.created_at).getTime();
        const expiresAt = session.expires_at ? new Date(session.expires_at).getTime() : null;
        const isRememberedSession = expiresAt && (expiresAt - createdAt > 2 * 24 * 60 * 60 * 1000);

        if (!isRememberedSession && (now - lastActivity > SESSION_IDLE_TIMEOUT_MS)) {
            return res.status(401).json({ success: false, error: 'Phiên đã hết hạn do không hoạt động quá 60 phút.', code: 'IDLE_TIMEOUT' });
        }
        if (now > expiresAt) {
            await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
            return res.status(401).json({ success: false, error: 'Phiên đã hết hạn tuyệt đối.', code: 'ABSOLUTE_TIMEOUT' });
        }
        pool.query('UPDATE sessions SET last_activity = NOW() WHERE token = $1', [token])
            .catch(err => console.error('Heartbeat failed:', err.message));

        req.session = session;
        req.username = session.username;
        next();
    } catch (err) {
        console.error('Session middleware error:', err);
        return res.status(500).json({ success: false, error: 'Lỗi server' });
    }
}

async function requireAuthOnly(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Chưa đăng nhập', code: 'NO_TOKEN' });
        }
        const token = authHeader.substring(7);

        const { rows } = await pool.query(`
            SELECT s.*, u.status AS user_status
            FROM sessions s
            LEFT JOIN users u ON LOWER(s.username) = LOWER(u.username)
            WHERE s.token = $1
        `, [token]);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Phiên không hợp lệ', code: 'INVALID_TOKEN' });
        }
        
        const session = rows[0];
        const now = Date.now();
        const expiresAt = session.expires_at ? new Date(session.expires_at).getTime() : null;

        if (now > expiresAt) {
            await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
            return res.status(401).json({ success: false, error: 'Phiên đã hết hạn tuyệt đối.', code: 'ABSOLUTE_TIMEOUT' });
        }
        pool.query('UPDATE sessions SET last_activity = NOW() WHERE token = $1', [token])
            .catch(err => console.error('Heartbeat failed:', err.message));

        req.session = session;
        req.username = session.username;
        next();
    } catch (err) {
        console.error('Auth Only middleware error:', err);
        return res.status(500).json({ success: false, error: 'Lỗi server' });
    }
}

async function requireActiveUser(req, res, next) {
    try {
        const { rows } = await pool.query('SELECT status FROM users WHERE LOWER(username) = LOWER($1)', [req.username]);
        
        if (rows.length > 0 && rows[0].status === 'banned') {
            return res.status(403).json({ 
                success: false, 
                error: 'Tài khoản của bạn đang bị khóa. Không thể thực hiện giao dịch!', 
                code: 'ACCOUNT_RESTRICTED' 
            });
        }
        next();
    } catch (err) {
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
}

function requireAdminToken(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Từ chối truy cập: Thiếu token' });
        }
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') return res.status(403).json({ error: 'Không có quyền admin' });
        req.admin = decoded;
        next();
    } catch {
        return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 21: TELEGRAM WEBHOOK
   ═══════════════════════════════════════════════════════════════════════════ */
app.post('/api/verify-telegram-otp', async (req, res) => {
    try {
        const { otp } = req.body;
        if (!otp) return res.status(400).json({ success: false, error: 'Thiếu mã OTP' });

        const record = telegramOtpStore.get(String(otp).trim());
        if (!record) {
            return res.status(400).json({ success: false, error: 'Mã không đúng hoặc đã hết hạn' });
        }
        if (Date.now() > record.expiresAt) {
            telegramOtpStore.delete(String(otp).trim());
            return res.status(400).json({ success: false, error: 'Mã đã hết hạn.' });
        }
        if (record.attempts >= TG_OTP_MAX_ATTEMPTS) {
            telegramOtpStore.delete(String(otp).trim());
            return res.status(400).json({ success: false, error: 'Nhập sai quá nhiều lần.' });
        }

        telegramOtpStore.delete(String(otp).trim());

        return res.json({
            success: true,
            message: 'Xác minh Telegram thành công',
            telegram: {
                chatId: record.chatId,
                username: record.telegramUsername
            }
        });
    } catch (err) {
        console.error('Verify Telegram OTP error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 22: CONFIG & ADMIN LOGIN
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/config', (req, res) => {
    res.json({
        googleClientId: SHOP_GOOGLE_CLIENT_ID,
        telegramBotUsername: TELEGRAM_BOT_USERNAME || '',
        telegramAvailable: TELEGRAM_ENABLED
    });
});

app.post('/api/admin/google-login', loginLimiter, async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) return res.status(400).json({ success: false, error: 'Thiếu credential' });

        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = (payload.email || '').toLowerCase();

        if (!payload.email_verified) return res.status(401).json({ success: false, error: 'Email chưa xác thực' });
        if (!ALLOWED_ADMIN_EMAILS.includes(email)) {
            console.warn(`🚫 [Admin] Từ chối email: ${email}`);
            return res.status(403).json({ success: false, error: `Email ${email} không có quyền admin` });
        }

        const token = jwt.sign(
            { username: email, email, name: payload.name, picture: payload.picture, role: 'admin', method: 'google' },
            JWT_SECRET, { expiresIn: '8h' }
        );
        console.log(`✅ [Admin Login] ${email}`);
        res.json({ success: true, token, email });
    } catch (err) {
        console.error('❌ Google login error:', err.message);
        res.status(401).json({ success: false, error: 'Xác thực Google thất bại' });
    }
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Thiếu thông tin đăng nhập' });
        if (!verifyAdmin(username, password)) {
            console.log(`🚫 [Login Failed] IP=${req.ip}`);
            return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
        }
        const token = jwt.sign({ username: ADMIN_USERNAME, role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        console.log(`✅ [Login Success] admin="${username}"`);
        res.json({ success: true, token, expiresIn: JWT_EXPIRES_IN });
    } catch {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.post('/api/admin/verify-token', requireAdminToken, (req, res) => {
    res.json({ success: true, admin: { username: req.admin.username }, valid: true });
});

app.post('/api/admin/google-token', async (req, res) => {
    try {
        const { code, redirectUri } = req.body;
        if (!code) return res.status(400).json({ success: false, error: 'Thiếu code' });

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code: code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });
        const tokenData = await tokenRes.json();

        if (tokenData.error) {
            return res.status(400).json({ success: false, error: tokenData.error_description || tokenData.error });
        }

        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userRes.json();
        const email = (userData.email || '').toLowerCase();

        if (!userData.verified_email) {
            return res.status(401).json({ success: false, error: 'Email chưa xác thực' });
        }
        if (!ALLOWED_ADMIN_EMAILS.includes(email)) {
            console.warn(`🚫 [Admin] Từ chối email: ${email}`);
            return res.status(403).json({ success: false, error: `Email ${email} không có quyền admin` });
        }

        const token = jwt.sign(
            { username: email, email, name: userData.name, picture: userData.picture, role: 'admin', method: 'google' },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        console.log(`✅ [Admin Login Redirect] ${email}`);
        res.json({ success: true, token, email });
    } catch (err) {
        console.error('❌ Lỗi đổi token Google:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 23: ADMIN STATS & REVENUE
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/admin/stats', requireAdminToken, async (req, res) => {
    try {
        const { rows: kycRows } = await pool.query("SELECT COUNT(*) FROM users WHERE kyc_status = 'pending'");
        const kycPending = Number(kycRows[0].count);
        const { rows: allUsers } = await pool.query('SELECT * FROM users');
        const totalUsers = allUsers.length;
        const bannedUsers = allUsers.filter(u => u.status === 'banned').length;
        const faUsers = 0; 

        let cashIn = 0, actualRevenue = 0, totalIncurred = 0;
        const spenderMap = new Map();

        allUsers.forEach(u => {
            const deposits = safeParseJSON(u.deposit_history);
            deposits.forEach(d => {
                const amt = Number(d.amount || 0);
                if (d.method === 'refund_rejected_order' || d.method === 'admin_refund') {
                    totalIncurred += amt; 
                } else if (d.status === 'success' || !d.status) {
                    cashIn += amt;
                }
            });
            const purchases = safeParseJSON(u.purchase_history);
            const spent = purchases.reduce((s, p) => {
                const price = Number(p.price) || 0;
                actualRevenue += price; 
                return s + price;
            }, 0);
            spenderMap.set(u.username, { username: u.username, fullName: u.full_name, totalSpent: spent });
        });
        const { rows: orderRows } = await pool.query('SELECT * FROM orders');
        const totalOrders = orderRows.length;
        const paidOrdersList = orderRows.filter(o => o.status === 'paid' || o.status === 'completed');
        const pendingOrdersList = orderRows.filter(o => o.status === 'pending');
        const underpaidOrdersList = orderRows.filter(o => o.status === 'underpaid');
        const rejectedOrdersList = orderRows.filter(o => o.status === 'rejected' || o.status === 'cancelled');
        const pendingAmount = pendingOrdersList.reduce((sum, o) => sum + Number(o.amount), 0);
        const totalProcessedOrders = paidOrdersList.length + rejectedOrdersList.length;
        const successOrders = paidOrdersList.length;
        let actualPerformance = 100;
        
        if (totalProcessedOrders > 0) {
            actualPerformance = ((successOrders / totalProcessedOrders) * 100).toFixed(1);
        }

        let orderRevenue = 0;
        paidOrdersList.forEach(o => {
            orderRevenue += Number(o.amount || 0);
        });

        const dailyRevenue = new Map();

        allUsers.forEach(u => {
            const purchases = safeParseJSON(u.purchase_history);
            purchases.forEach(p => {
                const at = p.purchasedAt || p.createdAt;
                if (!at) return;
                const date = new Date(at);
                const diffDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
                if (diffDays <= 7) {
                    const key = date.toISOString().slice(0, 10);
                    dailyRevenue.set(key, (dailyRevenue.get(key) || 0) + Number(p.price || 0));
                }
            });
        });
        paidOrdersList.forEach(o => {
            const at = o.paid_at || o.created_at;
            if (!at) return;
            const date = new Date(at);
            const diffDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
            if (diffDays <= 7) {
                const key = date.toISOString().slice(0, 10);
                dailyRevenue.set(key, (dailyRevenue.get(key) || 0) + Number(o.amount || 0));
            }
        });
        const revenue7d = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            revenue7d.push({
                date: d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
                revenue: dailyRevenue.get(key) || 0
            });
        }
        const recentOrders = orderRows
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 5)
            .map(o => ({
                orderCode: o.order_code, customerName: o.customer_name,
                planName: o.plan_name, amount: Number(o.amount), status: o.status
            }));
        const topSpenders = [...spenderMap.values()].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 5);
        let totalFeedbacks = 0;
        try { const db = await readStorage(); totalFeedbacks = (db.feedbacks || []).length; } catch (_) {}
        const inputCost = Number(process.env.MONTHLY_FIXED_COST) || 0;
        const totalRealRevenue = actualRevenue + orderRevenue;
        const netProfit = totalRealRevenue - inputCost - totalIncurred;
        res.json({
            success: true, 
            totalUsers, 
            kycPending, 
            totalFeedbacks,
            totalRevenue: totalRealRevenue,
            cashIn, 
            incurred: totalIncurred,
            netProfit, 
            inputCost, 
            pendingAmount, 
            totalOrders,
            pendingOrders: pendingOrdersList.length,
            paidOrders: paidOrdersList.length,
            underpaidOrdersList: underpaidOrdersList.length,
            revenue7d,
            bannedUsers: bannedUsers, 
            faUsers: faUsers,
            performance: Number(actualPerformance),
            orderStatus: {
                paid: orderRows.filter(o => o.status === 'paid').length, 
                completed: orderRows.filter(o => o.status === 'completed').length,
                pending: pendingOrdersList.length,
                underpaid: underpaidOrdersList.length, 
                rejected: rejectedOrdersList.length,
                other: totalOrders - paidOrdersList.length - pendingOrdersList.length - underpaidOrdersList.length - rejectedOrdersList.length
            },
            recentOrders, topSpenders
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra khi tính toán số liệu.' });
    }
});

app.post('/api/admin/revenue', requireAdminToken, async (req, res) => {
    try {
        const { period = '7d' } = req.body;

        let daysLimit = 7;
        if (period === '30d') daysLimit = 30;
        else if (period === '90d') daysLimit = 90;
        else if (period === 'all') daysLimit = 99999;

        const cutoff = Date.now() - daysLimit * 24 * 60 * 60 * 1000;

        let purchaseTotal = 0;
        let depositTotal = 0; 
        const chartMap = new Map();
        const transactions = [];

        const { rows: allUsers } = await pool.query('SELECT * FROM users');
        
        allUsers.forEach(u => {
            const deposits = safeParseJSON(u.deposit_history);
            deposits.forEach(d => {
                const at = d.at || d.createdAt;
                if (!at || new Date(at).getTime() < cutoff) return;
                
                const amt = Number(d.amount) || 0;
                depositTotal += amt;
                
                transactions.push({ 
                    time: at, 
                    username: u.username, 
                    type: 'deposit', 
                    amount: amt, 
                    desc: d.method || 'nạp tiền' 
                });
                
                const key = new Date(at).toISOString().slice(0, 10);
                chartMap.set(key, (chartMap.get(key) || 0) + amt);
            });
            const purchases = safeParseJSON(u.purchase_history);
            purchases.forEach(p => {
                const at = p.purchasedAt || p.createdAt;
                if (!at || new Date(at).getTime() < cutoff) return;
                
                const amt = Number(p.price) || 0;
                purchaseTotal += amt;
                
                transactions.push({ 
                    time: at, 
                    username: u.username, 
                    type: 'purchase', 
                    amount: amt, 
                    desc: p.productName || 'mua file' 
                });
                
                const key = new Date(at).toISOString().slice(0, 10);
                chartMap.set(key, (chartMap.get(key) || 0) + amt);
            });
        });
        const { rows: orderRows } = await pool.query(
            `SELECT * FROM orders WHERE status IN ('paid', 'completed') AND paid_at >= $1`, 
            [new Date(cutoff).toISOString()]
        );

        orderRows.forEach(o => {
            const amt = Number(o.amount) || 0;
            const at = o.paid_at; 
            
            purchaseTotal += amt;
            
            transactions.push({ 
                time: at, 
                username: o.customer_username || o.customer_name || 'Khách', 
                type: 'order', 
                amount: amt, 
                desc: `Thanh toán đơn: ${o.plan_name}` 
            });

            const key = new Date(at).toISOString().slice(0, 10);
            chartMap.set(key, (chartMap.get(key) || 0) + amt);
        });
        const chartData = [];
        const totalDaysToRender = Math.min(daysLimit, 30);
        
        for (let i = totalDaysToRender - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            chartData.push({
                label: d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
                value: chartMap.get(key) || 0
            });
        }
        transactions.sort((a, b) => new Date(b.time) - new Date(a.time));

        res.json({
            success: true,
            totalRevenue: purchaseTotal, 
            depositTotal, 
            chartData,
            transactions: transactions.slice(0, 500)
        });
    } catch (err) {
        console.error('Admin revenue error:', err);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra khi tải dữ liệu doanh thu.' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 24: ORDERS
   ═══════════════════════════════════════════════════════════════════════════ */

const PCMB_ORDER_PLANS = Object.freeze({
    basic: Object.freeze({ name: 'TỐI ƯU CƠ BẢN', amount: 250000 }),
    advanced: Object.freeze({ name: 'TỐI ƯU NÂNG CAO', amount: 450000 }),
    pro: Object.freeze({ name: 'TỐI ƯU CHUYÊN SÂU', amount: 550000 })
});

app.post('/api/create-order', requireUserSession, requireActiveUser, async (req, res) => {
    try {
        const { 
            plan, customerName,
            customerUsername, customerPhone, remoteTool, remoteId, remotePass 
        } = req.body;

        const selectedPlan = typeof plan === 'string' && Object.prototype.hasOwnProperty.call(PCMB_ORDER_PLANS, plan)
            ? PCMB_ORDER_PLANS[plan]
            : null;
        if (!selectedPlan) {
            return res.status(400).json({ success: false, error: 'Gói dịch vụ không hợp lệ' });
        }

        if (!customerUsername || !customerPhone || !remoteTool || !remoteId || !remotePass) {
            return res.status(400).json({ success: false, error: 'Thiếu thông tin đơn hàng' });
        }
        if (String(customerUsername).trim().toLowerCase() !== req.username.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Đơn hàng phải được tạo cho tài khoản đang đăng nhập.' });
        }

        const phoneClean = String(customerPhone).replace(/[^0-9]/g, '');
        if (phoneClean.length < 10 || phoneClean.length > 11) {
            return res.status(400).json({ success: false, error: 'Số điện thoại không hợp lệ (10-11 số)' });
        }

        if (remoteTool === 'UltraView') {
            if (!/^[0-9]{9,12}$/.test(remoteId)) {
                return res.status(400).json({ success: false, error: 'UltraView ID không hợp lệ' });
            }
            if (String(remotePass).length < 4) {
                return res.status(400).json({ success: false, error: 'UltraView Password quá ngắn' });
            }
        } else if (remoteTool === 'AnyDesk') {
            const adIdClean = String(remoteId).replace(/\s/g, '');
            if (!/^[0-9]{9,10}$/.test(adIdClean)) {
                return res.status(400).json({ success: false, error: 'AnyDesk ID không hợp lệ' });
            }
            if (remotePass && remotePass !== 'Không có' && String(remotePass).length < 4) {
                return res.status(400).json({ success: false, error: 'AnyDesk Password quá ngắn' });
            }
        } else {
            return res.status(400).json({ success: false, error: 'Ứng dụng hỗ trợ không hợp lệ' });
        }

        const orderCode = generateOrderCode();
        const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
        const key = `TYON-${plan.toUpperCase()}-${randomPart}-${orderCode.slice(-6)}`;

        const newOrder = {
            orderCode, key, plan,
            planName: selectedPlan.name,
            customerName: customerName || customerUsername,
            amount: selectedPlan.amount,
            status: 'pending',
            createdAt: new Date().toISOString(),
            paidAt: null, paidAmount: 0,
            transactionId: null, sepayTransactionId: null, note: '',
            customerUsername, customerPhone,
            remoteTool, remoteId, remotePass
        };

        const saved = await upsertOrderToSupabase(newOrder);
        if (!saved) return res.status(500).json({ success: false, error: 'Không lưu được đơn hàng' });

        const qrContent = `SEVQR ${orderCode}`;
        const qrUrl = `https://img.vietqr.io/image/${SEPAY_BANK_CODE}-${SEPAY_BANK_ACCOUNT}-qr_only.png?amount=${selectedPlan.amount}&addInfo=${encodeURIComponent(qrContent)}&accountName=${encodeURIComponent(SEPAY_ACCOUNT_HOLDER)}`;

        res.json({
            success: true, orderCode, key, amount: selectedPlan.amount,
            qrContent, qrUrl,
            bankInfo: { bankCode: SEPAY_BANK_CODE, accountNumber: SEPAY_BANK_ACCOUNT, accountHolder: SEPAY_ACCOUNT_HOLDER }
        });
    } catch (err) {
        console.error('Lỗi tạo đơn hàng:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.get('/api/order-status/:orderCode', async (req, res) => {
    try {
        const { orderCode } = req.params;
        const { rows } = await pool.query('SELECT * FROM orders WHERE order_code = $1', [orderCode]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
        }
        const o = rows[0];
        
        res.json({
            success: true, 
            orderCode: o.order_code, 
            status: o.status,
            key: (o.status === 'paid' || o.status === 'completed') ? o.key : null,
            amount: Number(o.amount), 
            paidAmount: Number(o.paid_amount || 0),
            paidAt: o.paid_at, 
            planName: o.plan_name,
            note: o.note || ''
        });
    } catch (err) {
        console.error('Lỗi check order:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.get('/api/user/orders', requireUserSession, async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit, 10);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(Math.max(requestedLimit, 1), 120)
            : 120;
        const { rows } = await pool.query(
            `SELECT order_code, plan_name, amount, status, created_at
             FROM orders
             WHERE LOWER(customer_username) = LOWER($1)
             ORDER BY created_at DESC
             LIMIT $2`,
            [req.username, limit]
        );

        return res.json({
            success: true,
            data: rows.map(order => ({
                orderCode: order.order_code,
                planName: order.plan_name,
                amount: Number(order.amount) || 0,
                status: order.status,
                createdAt: order.created_at
            }))
        });
    } catch (err) {
        console.error('Lỗi lấy đơn hàng người dùng:', err.message);
        return res.status(500).json({ success: false, error: 'Không thể tải đơn hàng.' });
    }
});

app.post('/api/admin/orders', requireAdminToken, async (req, res) => {
    try {
        const orders = await getOrdersFromSupabase();
        res.json({ success: true, orders });
    } catch (err) {
        console.error('❌ Lỗi lấy danh sách đơn hàng admin:', err.message);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra.' });
    }
});

app.post('/api/admin/confirm-order', requireAdminToken, async (req, res) => {
    let client;
    try {
        const { pin, orderCode } = req.body;
        if (!orderCode || typeof orderCode !== 'string') {
            return res.status(400).json({ success: false, error: 'Thiếu mã đơn hàng' });
        }
        if (!verifyPin(pin)) {
            console.warn(`🚫 [ADMIN CONFIRM] Sai PIN từ admin="${req.admin.username}" đơn=${orderCode}`);
            return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });
        }
        client = await pool.connect();
        await client.query('BEGIN');
        const { rows } = await client.query(
            'SELECT * FROM orders WHERE order_code = $1 FOR UPDATE',
            [orderCode]
        );

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
        }

        const order = rows[0];
        if (order.status === 'paid' || order.status === 'completed') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                error: `Đơn này đã ở trạng thái "${order.status}" rồi`,
                currentStatus: order.status
            });
        }

        if (order.status === 'cancelled' || order.status === 'rejected') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                error: 'Đơn đã bị hủy/từ chối, không thể xác nhận'
            });
        }
        if (order.status !== 'pending' && order.status !== 'underpaid') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                error: `Không thể xác nhận đơn ở trạng thái "${order.status}"`
            });
        }
        const requiredAmount = Number(order.amount) || 0;
        const currentPaid    = Number(order.paid_amount || 0);
        const finalPaidAmount = Math.max(currentPaid, requiredAmount);
        const now = new Date().toISOString();
        const auditNote = [
            order.note || '',
            `Admin ${req.admin.username} xác nhận thủ công lúc ${new Date(now).toLocaleString('vi-VN')}`,
            `(trạng thái trước: ${order.status}, đã nhận: ${currentPaid}đ / cần: ${requiredAmount}đ)`
        ].filter(Boolean).join(' | ');
        await client.query(
            `UPDATE orders SET
                status       = 'paid',
                paid_at      = $1,
                paid_amount  = $2,
                confirmed_by = $3,
                note         = $4
             WHERE order_code = $5`,
            [now, finalPaidAmount, req.admin.username, auditNote, orderCode]
        );

        if (order.customer_username) {
            await recordAffiliateCommission(client, {
                buyerUsername: order.customer_username,
                sourceOrderId: `optimizer:${order.order_code}`,
                category: 'optimizer',
                grossAmount: requiredAmount
            });
        }

        await client.query('COMMIT');

        console.log(`✅ [ADMIN CONFIRM] ${req.admin.username} xác nhận đơn ${orderCode} (${currentPaid}đ → ${finalPaidAmount}đ)`);
        const isManualOrder = !!(order.remote_tool && order.remote_id);
        const wasUnderpaid  = order.status === 'underpaid';
        const wasAlreadyNotified = (order.note || '').includes('[TG_NOTIFIED]');

        if (isManualOrder && !wasAlreadyNotified && !wasUnderpaid) {
            try {
                await notifyAdminNewPaidOrder({
                    orderCode:        order.order_code,
                    customerName:     order.customer_name,
                    customerUsername: order.customer_username,
                    customerPhone:    order.customer_phone,
                    amount:           finalPaidAmount,
                    plan:             order.plan,
                    planName:         order.plan_name,
                    remoteTool:       order.remote_tool,
                    remoteId:         order.remote_id,
                    remotePass:       order.remote_pass,
                    paidAt:           now
                });
                await pool.query(
                    `UPDATE orders SET note = note || ' | [TG_NOTIFIED]' WHERE order_code = $1`,
                    [orderCode]
                );
            } catch (tgErr) {
                console.error('[TG] Lỗi thông báo admin:', tgErr.message);
            }
        }
        return res.json({
            success: true,
            message: `Đã xác nhận đơn ${orderCode}.`,
            order: {
                orderCode:    order.order_code,
                status:       'paid',
                amount:       requiredAmount,
                paidAmount:   finalPaidAmount,
                customerName: order.customer_name,
                planName:     order.plan_name,
                confirmedBy:  req.admin.username,
                paidAt:       now,
                wasUnderpaid: wasUnderpaid,
                previousPaid: currentPaid
            }
        });

    } catch (err) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (_) {}
        }
        console.error('❌ [ADMIN CONFIRM] Error:', err);
        return res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/admin/complete-order', requireAdminToken, async (req, res) => {
    try {
        const { pin, orderCode } = req.body;
        if (!verifyPin(pin)) return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });

        const { rows } = await pool.query('SELECT * FROM orders WHERE order_code = $1', [orderCode]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
        if (rows[0].status !== 'paid') {
            return res.status(400).json({ success: false, error: 'Chỉ có thể hoàn tất đơn đã thanh toán' });
        }

        const note = (rows[0].note || '') + ` | Admin ${req.admin.username} đã hoàn tất dịch vụ.`;
        await pool.query(
            `UPDATE orders SET status='completed', note=$1 WHERE order_code=$2`,
            [note, orderCode]
        );

        console.log(`✅ [ADMIN] ${req.admin.username} hoàn tất đơn ${orderCode}`);
        res.json({ success: true, message: `Đã đánh dấu hoàn tất đơn ${orderCode}.` });
    } catch (err) {
        console.error('Admin complete order error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/admin/reject-order', requireAdminToken, async (req, res) => {
    try {
        const { pin, orderCode } = req.body;
        if (!verifyPin(pin)) return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const { rows: lockRows } = await client.query(
                'SELECT * FROM orders WHERE order_code = $1 FOR UPDATE',
                [orderCode]
            );
            if (lockRows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
            }

            const order = lockRows[0];
            if (order.status !== 'pending') {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'Chỉ có thể từ chối đơn đang chờ xử lý' });
            }

            const note = (order.note || '') + ` | Admin ${req.admin.username} từ chối.`;
            await client.query(
                `UPDATE orders SET status='cancelled', confirmed_by=$1, note=$2 WHERE order_code=$3`,
                [req.admin.username, note, orderCode]
            );

            const paidAmount = Number(order.paid_amount || 0);
            if (paidAmount > 0) {
                const targetUsername = order.username || order.customer_name;
                if (targetUsername) {
                    const { rows: userRows } = await client.query(
                        'SELECT username, balance, deposit_history FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE',
                        [targetUsername]
                    );
                    if (userRows.length > 0) {
                        const user = userRows[0];
                        const depositHistory = safeParseJSON(user.deposit_history);
                        depositHistory.push({
                            amount: paidAmount,
                            method: 'refund_rejected_order',
                            content: `Hoàn tiền đơn bị từ chối: ${orderCode}`,
                            transactionId: 'REFUND_' + Date.now(),
                            at: new Date().toISOString(),
                            addedBy: req.admin.username
                        });
                        await client.query(
                            'UPDATE users SET balance = balance + $1, deposit_history = $2 WHERE username = $3',
                            [paidAmount, JSON.stringify(depositHistory), user.username]
                        );
                        console.log(`💰 [REFUND] Hoàn ${paidAmount}đ cho ${user.username}`);
                    }
                }
            }

            await client.query('COMMIT');
            return res.json({
                success: true,
                message: `Đã từ chối đơn ${orderCode}.${paidAmount > 0 ? ' Tiền đã hoàn vào ví khách.' : ''}`
            });
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Admin reject order error:', err);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra.' });
    }
});

app.post('/api/admin/refund-order', requireAdminToken, async (req, res) => {
    try {
        const { pin, orderCode } = req.body;
        if (!verifyPin(pin)) return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const { rows: lockRows } = await client.query(
                'SELECT * FROM orders WHERE order_code = $1 FOR UPDATE',
                [orderCode]
            );
            if (lockRows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
            }

            const order = lockRows[0];
            if (order.status !== 'paid' && order.status !== 'completed') {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'Chỉ có thể hoàn tiền cho đơn đã thanh toán' });
            }

            const paidAmount = Number(order.paid_amount || order.amount || 0);
            if (paidAmount <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'Đơn hàng này chưa thu tiền' });
            }

            const targetUsername = order.customer_username || order.customer_name;
            if (!targetUsername) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'Không tìm thấy thông tin khách hàng' });
            }

            const note = (order.note || '') + ` | Admin ${req.admin.username} đã hoàn tiền.`;
            await client.query(
                `UPDATE orders SET status='cancelled', confirmed_by=$1, note=$2 WHERE order_code=$3`,
                [req.admin.username, note, orderCode]
            );
            await client.query(
                `UPDATE public.affiliate_commissions
                 SET status = 'void'
                 WHERE source_order_id = $1 AND category = 'optimizer' AND status <> 'void'`,
                [`optimizer:${order.order_code}`]
            );

            const { rows: userRows } = await client.query(
                'SELECT username, balance, deposit_history FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE',
                [targetUsername]
            );
            
            if (userRows.length > 0) {
                const user = userRows[0];
                const depositHistory = safeParseJSON(user.deposit_history);
                depositHistory.push({
                    amount: paidAmount,
                    method: 'admin_refund',
                    content: `Hoàn tiền đơn hàng: ${orderCode}`,
                    transactionId: 'REFUND_' + Date.now(),
                    at: new Date().toISOString(),
                    addedBy: req.admin.username
                });
                await client.query(
                    'UPDATE users SET balance = balance + $1, deposit_history = $2 WHERE username = $3',
                    [paidAmount, JSON.stringify(depositHistory), user.username]
                );
                console.log(`💰 [REFUND] Hoàn ${paidAmount}đ cho ${user.username}`);
            }

            await client.query('COMMIT');
            return res.json({
                success: true,
                message: `Đã hoàn tiền ${paidAmount.toLocaleString('vi-VN')}đ cho đơn ${orderCode}.`
            });

        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Admin refund order error:', err);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra.' });
    }
});

app.post('/api/admin/toggle-user-status', requireAdminToken, async (req, res) => {
    try {
        const { username, status, pin } = req.body;
        if (!verifyPin(pin)) {
            return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });
        }
        if (!username || typeof username !== 'string') {
            return res.status(400).json({ success: false, error: 'Thiếu username' });
        }
        if (!['active', 'banned'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Status phải là "active" hoặc "banned"' });
        }
        const { rowCount } = await pool.query(
            'UPDATE users SET status = $1 WHERE LOWER(username) = LOWER($2)',
            [status, username]
        );

        if (rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy user' });
        }
        if (status === 'banned') {
            const delResult = await pool.query(
                'DELETE FROM sessions WHERE LOWER(username) = LOWER($1)',
                [username]
            );
            console.log(`🔒 [ADMIN] ${req.admin.username} KHÓA tài khoản ${username} (xóa ${delResult.rowCount} session)`);
        } else {
            console.log(`🔓 [ADMIN] ${req.admin.username} MỞ KHÓA tài khoản ${username}`);
        }

        res.json({
            success: true,
            message: `Đã ${status === 'banned' ? 'KHÓA' : 'MỞ KHÓA'} tài khoản ${username}`
        });
    } catch (err) {
        console.error('Toggle user status error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 25: SEPAY WEBHOOK
   ═══════════════════════════════════════════════════════════════════════════ */

async function applyWalletDeposit({ orderCode, transactionId, amount, payload }) {
    const client = await pool.connect();
    let tierCheck = null;
    try {
        await client.query('BEGIN');
        const { rows: inserted } = await client.query(
            `INSERT INTO payment_events (gateway, provider_transaction_id, order_code, amount, raw_payload, status)
             VALUES ('sepay', $1, $2, $3, $4::jsonb, 'received')
             ON CONFLICT (gateway, provider_transaction_id) DO NOTHING RETURNING id`,
            [transactionId, orderCode, amount, JSON.stringify(payload)]
        );
        if (!inserted.length) {
            await client.query('COMMIT');
            return { status: 'duplicate' };
        }
        const { rows: intents } = await client.query(
            "SELECT * FROM payment_intents WHERE gateway = 'sepay' AND order_code = $1 FOR UPDATE",
            [orderCode]
        );
        const intent = intents[0];
        if (!intent || intent.status !== 'pending') {
            await client.query("UPDATE payment_events SET status = 'unmatched' WHERE gateway = 'sepay' AND provider_transaction_id = $1", [transactionId]);
            await client.query('COMMIT');
            return { status: 'unmatched' };
        }
        if (new Date(intent.expires_at).getTime() <= Date.now()) {
            await client.query("UPDATE payment_intents SET status = 'expired' WHERE id = $1", [intent.id]);
            await client.query("UPDATE payment_events SET status = 'unmatched' WHERE gateway = 'sepay' AND provider_transaction_id = $1", [transactionId]);
            await client.query('COMMIT');
            return { status: 'unmatched' };
        }
        if (Number(intent.amount) !== amount) {
            await client.query("UPDATE payment_intents SET status = 'review' WHERE id = $1", [intent.id]);
            await client.query("UPDATE payment_events SET status = 'review' WHERE gateway = 'sepay' AND provider_transaction_id = $1", [transactionId]);
            await client.query('COMMIT');
            return { status: 'review' };
        }
        const { rows: users } = await client.query(
            'SELECT username, balance, deposit_history FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE',
            [intent.username]
        );
        const user = users[0];
        if (!user) {
            await client.query("UPDATE payment_intents SET status = 'review' WHERE id = $1", [intent.id]);
            await client.query("UPDATE payment_events SET status = 'unmatched' WHERE gateway = 'sepay' AND provider_transaction_id = $1", [transactionId]);
            await client.query('COMMIT');
            return { status: 'unmatched' };
        }
        const history = safeParseJSON(user.deposit_history);
        if (history.some(item => String(item.transactionId) === transactionId)) {
            await client.query("UPDATE payment_intents SET status = 'paid', provider_transaction_id = $1, paid_at = NOW() WHERE id = $2", [transactionId, intent.id]);
            await client.query("UPDATE payment_events SET status = 'duplicate', username = $1 WHERE gateway = 'sepay' AND provider_transaction_id = $2", [user.username, transactionId]);
            await client.query('COMMIT');
            return { status: 'duplicate' };
        }
        history.push({ amount, method: 'sepay', content: orderCode, transactionId, at: new Date().toISOString() });
        await client.query('UPDATE users SET balance = balance + $1, deposit_history = $2 WHERE username = $3', [amount, JSON.stringify(history), user.username]);
        await client.query("UPDATE payment_intents SET status = 'paid', provider_transaction_id = $1, paid_at = NOW(), raw_payload = $2::jsonb WHERE id = $3", [transactionId, JSON.stringify(payload), intent.id]);
        await client.query("UPDATE payment_events SET status = 'credited', username = $1 WHERE gateway = 'sepay' AND provider_transaction_id = $2", [user.username, transactionId]);
        await client.query('COMMIT');
        tierCheck = { username: user.username, history: history.slice(0, -1) };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Payment rollback failed:', rollbackError.message); }
        throw error;
    } finally {
        client.release();
    }
    if (tierCheck) {
        setImmediate(() => checkAndSendTierUpgrade(tierCheck.username, tierCheck.history)
            .catch(error => console.error('Tier check error:', error.message)));
        return { status: 'credited' };
    }
    return { status: 'unmatched' };
}

async function handleSePayWebhook(req, res) {
    try {
        const signature = String(req.headers['x-sepay-signature'] || '').replace(/^sha256=/i, '').toLowerCase();
        const timestamp = String(req.headers['x-sepay-timestamp'] || '');
        if (!SEPAY_WEBHOOK_SECRET || !signature || !/^\d{10,13}$/.test(timestamp) || !Buffer.isBuffer(req.body)) {
            return res.status(401).json({ success: false, error: 'Thiếu thông tin xác thực webhook.' });
        }
        const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
        if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 300000) {
            return res.status(401).json({ success: false, error: 'Webhook đã quá thời hạn xác thực.' });
        }
        const rawBody = req.body.toString('utf8');
        const expected = crypto.createHmac('sha256', SEPAY_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
        if (!safeCompareToken(signature, expected)) return res.status(401).json({ success: false, error: 'Chữ ký webhook không hợp lệ.' });

        const data = JSON.parse(rawBody);
        if (String(data.transferType || '').toLowerCase() !== 'in') return res.status(200).json({ success: true, message: 'Ignored' });
        const amount = Number(data.transferAmount);
        const transactionId = String(data.id || data.transactionId || data.referenceCode || '').trim();
        const content = `${data.code || ''} ${data.content || data.description || ''}`.toUpperCase().replace(/\s+/g, ' ').trim();
        if (!Number.isSafeInteger(amount) || amount <= 0 || !transactionId || transactionId.length > 200) {
            return res.status(400).json({ success: false, error: 'Dữ liệu giao dịch không hợp lệ.' });
        }

        const depositMatch = content.match(/\bNAP[A-Z0-9]{10,32}\b/);
        if (depositMatch) {
            const result = await applyWalletDeposit({ orderCode: depositMatch[0], transactionId, amount, payload: data });
            return res.status(200).json({ success: true, message: result.status });
        }
        const orderMatch = content.match(/TYON[A-Z0-9]{6,}/);
        if (!orderMatch) return res.status(200).json({ success: true, message: 'No matching order' });

        const client = await pool.connect();
        let notifyOrder = null;
        try {
            await client.query('BEGIN');
            const { rows: inserted } = await client.query(
                `INSERT INTO payment_events (gateway, provider_transaction_id, order_code, amount, raw_payload, status)
                 VALUES ('sepay', $1, $2, $3, $4::jsonb, 'received')
                 ON CONFLICT (gateway, provider_transaction_id) DO NOTHING RETURNING id`,
                [transactionId, orderMatch[0], amount, JSON.stringify(data)]
            );
            if (!inserted.length) {
                await client.query('COMMIT');
                return res.status(200).json({ success: true, message: 'Duplicate transaction' });
            }
            const { rows } = await client.query(
                "SELECT * FROM orders WHERE status IN ('pending', 'underpaid') AND UPPER(REPLACE(order_code, ' ', '')) = $1 FOR UPDATE",
                [orderMatch[0]]
            );
            const order = rows[0];
            if (!order) {
                await client.query("UPDATE payment_events SET status = 'unmatched' WHERE gateway = 'sepay' AND provider_transaction_id = $1", [transactionId]);
                await client.query('COMMIT');
                return res.status(200).json({ success: true, message: 'No matching order' });
            }
            const received = Number(order.paid_amount || 0) + amount;
            const status = received >= Number(order.amount) ? 'paid' : 'underpaid';
            const note = status === 'underpaid' ? `Thanh toán thiếu: cần ${Number(order.amount)}đ, đã nhận ${received}đ` : order.note || '';
            await client.query(
                "UPDATE orders SET status = $1, paid_at = CASE WHEN $1 = 'paid' THEN NOW() ELSE paid_at END, paid_amount = $2, transaction_id = $3, sepay_transaction_id = $3, note = $4 WHERE order_code = $5",
                [status, received, transactionId, note, order.order_code]
            );
            await client.query("UPDATE payment_events SET status = 'credited', username = $1 WHERE gateway = 'sepay' AND provider_transaction_id = $2", [order.customer_username || null, transactionId]);
            if (status === 'paid' && order.customer_username) {
                await recordAffiliateCommission(client, {
                    buyerUsername: order.customer_username,
                    sourceOrderId: `optimizer:${order.order_code}`,
                    category: 'optimizer',
                    grossAmount: Number(order.amount)
                });
            }
            await client.query('COMMIT');
            if (status === 'paid' && order.remote_tool && order.remote_id) {
                notifyOrder = { orderCode: order.order_code, customerName: order.customer_name, customerUsername: order.customer_username, customerPhone: order.customer_phone, amount: Number(order.amount), plan: order.plan, planName: order.plan_name, remoteTool: order.remote_tool, remoteId: order.remote_id, remotePass: order.remote_pass, paidAt: new Date().toISOString() };
            }
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('SePay rollback failed:', rollbackError.message); }
            throw error;
        } finally {
            client.release();
        }
        if (notifyOrder) notifyAdminNewPaidOrder(notifyOrder).catch(error => console.error('notifyAdmin failed:', error.message));
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('SePay webhook error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể xử lý webhook.' });
    }
}

/* SECTION 26: KYC */
app.post('/api/admin/kyc-list', requireAdminToken, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT username, full_name, kyc_status, kyc_full_name, kyc_id_number,
                   kyc_front_image, kyc_back_image, kyc_submitted_at
            FROM users WHERE kyc_status IN ('pending', 'verified', 'rejected')
            ORDER BY kyc_submitted_at DESC
        `);
        res.json({ success: true, kycs: rows });
    } catch (err) {
        console.error('Lỗi lấy KYC list:', err.message);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra.' });
    }
});

app.post('/api/admin/approve-kyc', requireAdminToken, async (req, res) => {
    try {
        const { pin, username, action } = req.body;
        if (!verifyPin(pin)) return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });
        if (!username || typeof username !== 'string') {
            return res.status(400).json({ success: false, error: 'Thiếu username' });
        }
        if (action !== 'approve' && action !== 'reject') {
            return res.status(400).json({ success: false, error: 'Action phải là "approve" hoặc "reject"' });
        }

        if (action === 'approve') {
            const { rowCount } = await pool.query(
                `UPDATE users SET kyc_status = 'verified', kyc_reviewed_at = NOW() WHERE username = $1`,
                [username]
            );
            if (rowCount === 0) return res.status(404).json({ success: false, error: `Không tìm thấy user "${username}"` });

            const user = await getUserByUsername(username);
            if (user && user.email) {
                queueEmail(user.email, 'Xác thực danh tính thành công - TyonCao Global Optimizer',
                    emailTemplates.kycSuccess(user.full_name || username))
                    .catch(err => console.error('Lỗi gửi mail KYC:', err));
            }
            return res.json({ success: true, message: `Đã duyệt KYC cho ${username}` });
        } else {
            const { rowCount } = await pool.query(`
                UPDATE users
                SET kyc_status = 'unverified',
                    kyc_full_name = NULL, kyc_id_number = NULL,
                    kyc_front_image = NULL, kyc_back_image = NULL,
                    kyc_submitted_at = NULL, kyc_reviewed_at = NOW()
                WHERE username = $1
            `, [username]);
            if (rowCount === 0) return res.status(404).json({ success: false, error: `Không tìm thấy user "${username}"` });
            return res.json({ success: true, message: `Đã từ chối và xóa dữ liệu KYC của ${username}` });
        }
    } catch (err) {
        console.error('Approve KYC error:', err);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra.' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 27: ADMIN ADD BALANCE
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/admin/add-balance', requireAdminToken, async (req, res) => {
    try {
        const { pin, targetUsername, amount, note } = req.body;
        if (!verifyPin(pin)) return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });

        const addAmount = parseInt(amount);
        if (!targetUsername || !addAmount || addAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Thiếu thông tin hoặc số tiền không hợp lệ' });
        }
        if (addAmount > 100000000) {
            return res.status(400).json({ success: false, error: 'Số tiền cộng tối đa 100.000.000đ' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: userRows } = await client.query(
                'SELECT username, full_name, balance, deposit_history FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE',
                [targetUsername]
            );
            if (userRows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Không tìm thấy user: ' + targetUsername });
            }

            const dbUser = userRows[0];
            const oldBalance = Number(dbUser.balance) || 0;
            const newBalance = oldBalance + addAmount;

            const depositHistory = safeParseJSON(dbUser.deposit_history);
            depositHistory.push({
                amount: addAmount,
                method: 'admin_manual',
                content: note || 'Admin cộng tiền thủ công',
                transactionId: 'ADMIN_' + Date.now(),
                at: new Date().toISOString(),
                addedBy: req.admin.username,
                ip: req.ip
            });

            await client.query(
                'UPDATE users SET balance = $1, deposit_history = $2 WHERE username = $3',
                [newBalance, JSON.stringify(depositHistory), dbUser.username]
            );

            await client.query('COMMIT');
            console.log(`💰 [AUDIT] ${req.admin.username} cộng ${addAmount}đ cho ${targetUsername}`);
            setImmediate(() => {
                checkAndSendTierUpgrade(targetUsername, depositHistory.slice(0, -1))
                    .catch(err => console.error('Tier check error:', err.message));
            });

            res.json({
                success: true,
                message: `Đã cộng ${addAmount.toLocaleString('vi-VN')}đ cho ${targetUsername}`,
                data: { username: dbUser.username, fullName: dbUser.full_name, oldBalance, newBalance, addedAmount: addAmount }
            });
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Admin add-balance error:', err);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra.' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 28: USER AUTH (Register / Login / Reset)
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/send-otp', registrationOtpLimiter, async (req, res) => {
    try {
        const { email } = req.body || {};
        if (!email || !isValidEmail(email)) {
            return res.status(400).json({ success: false, error: 'Email không hợp lệ' });
        }
        const emailKey = email.trim().toLowerCase();

        const { rows: dup } = await pool.query(
            'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)',
            [emailKey]
        );
        if (dup.length > 0) {
            return res.status(400).json({ success: false, error: 'Email đã được đăng ký' });
        }

        const existing = registerOtpStore.get(emailKey);
        if (existing && existing.lastSentAt && Date.now() - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
            const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
            return res.status(429).json({ success: false, error: `Vui lòng chờ ${waitSec}s để gửi lại OTP` });
        }

        const otp = generateOtp();
        const expiresAt = Date.now() + OTP_TTL_MS;
        registerOtpStore.set(emailKey, {
            otp, expiresAt, lastSentAt: Date.now(), attempts: 0
        });

        const mailSent = await sendEmailImmediate(
            emailKey,
            '[TyonCao] Mã xác minh đăng ký tài khoản của bạn',
            `<div style="font-family:sans-serif;padding:40px 20px;background:#f6f8fa;">
                <div style="max-width:600px;margin:0 auto;background:#fff;padding:32px;border-radius:8px;">
                    <h2 style="color:#24292f;margin:0 0 16px;">[TyonCao] Vui lòng xác minh đăng ký</h2>
                    <p style="color:#24292f;font-size:14px;">Mã xác minh của bạn:</p>
                    <div style="background:#f6f8fa;padding:24px;text-align:center;border-radius:6px;margin:24px 0;">
                        <div style="font-family:monospace;font-size:42px;font-weight:700;color:#0969da;letter-spacing:6px;">${otp}</div>
                    </div>
                    <p style="color:#57606a;font-size:14px;">Mã có hiệu lực trong <strong>5 phút</strong>.</p>
                </div>
            </div>`
        );

        if (!mailSent) {
            registerOtpStore.delete(emailKey);
            return res.status(503).json({
                success: false,
                error: 'Không gửi được email. Vui lòng thử lại hoặc nhận mã qua Telegram.',
                code: 'EMAIL_QUOTA_EXCEEDED',
                telegramAvailable: TELEGRAM_ENABLED,
                telegramDeepLink: TELEGRAM_ENABLED
                    ? `https://t.me/${TELEGRAM_BOT_USERNAME}?start=register`
                    : null
            });
        }
        return res.json({
            success: true,
            message: 'Đã gửi OTP tới email của bạn',
            telegramAvailable: TELEGRAM_ENABLED,
            telegramDeepLink: TELEGRAM_ENABLED
                ? `https://t.me/${TELEGRAM_BOT_USERNAME}?start=register`
                : null
        });
    } catch (err) {
        console.error('send-otp error:', err);
        return res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/send-register-otp', (req, res, next) => {
    req.url = '/api/send-otp';
    app._router.handle(req, res, next);
});

app.post('/api/register', registrationAccountLimiter, async (req, res) => {
    let client;
    let transactionOpen = false;
    try {
        const { username, password, fullName, email, otp } = req.body || {};
        const referralCode = String(req.body && req.body.referralCode || '').trim().toUpperCase();
        const referralToken = String(req.body && req.body.referralToken || '').trim().toLowerCase();

        if (typeof username !== 'string' || typeof password !== 'string' ||
            typeof fullName !== 'string' || typeof email !== 'string' ||
            typeof otp !== 'string' || !username.trim() || !password || !fullName.trim() ||
            !email.trim() || !otp.trim()) {
            return res.status(400).json({
                success: false,
                error: 'Thiếu thông tin (cần username, password, fullName, email, otp)'
            });
        }

        const usernameTrim = username.trim();
        const fullNameTrim = fullName.trim();
        const emailTrim = email.trim();
        const emailKey = emailTrim.toLowerCase();
        const otpTrim = String(otp).trim();

        if (!isValidEmail(emailTrim)) return res.status(400).json({ success: false, error: 'Email không hợp lệ' });
        if (!isValidUsername(usernameTrim)) return res.status(400).json({ success: false, error: 'Username không hợp lệ (≥4 ký tự, chỉ chữ/số/_)' });
        if (password.length < 8) {
            return res.status(400).json({ success: false, error: 'Mật khẩu phải ≥8 ký tự' });
        }
        if (fullNameTrim.length < 2) return res.status(400).json({ success: false, error: 'Họ tên quá ngắn' });
        if (!/^\d{6}$/.test(otpTrim)) return res.status(400).json({ success: false, error: 'Mã xác thực phải gồm 6 chữ số' });

        const storedOtp = registerOtpStore.get(emailKey);
        if (!storedOtp) {
            return res.status(400).json({
                success: false,
                error: 'Mã xác thực không tồn tại hoặc đã hết hạn. Vui lòng yêu cầu gửi mã mới.'
            });
        }
        if (Date.now() > storedOtp.expiresAt) {
            registerOtpStore.delete(emailKey);
            return res.status(400).json({ success: false, error: 'Mã xác thực đã hết hạn. Vui lòng gửi mã mới.' });
        }
        if (storedOtp.attempts >= OTP_MAX_ATTEMPTS) {
            registerOtpStore.delete(emailKey);
            return res.status(429).json({ success: false, error: 'Bạn đã nhập sai mã quá nhiều lần. Vui lòng gửi mã mới.' });
        }
        if (storedOtp.otp !== otpTrim) {
            storedOtp.attempts += 1;
            if (storedOtp.attempts >= OTP_MAX_ATTEMPTS) {
                registerOtpStore.delete(emailKey);
                return res.status(429).json({ success: false, error: 'Bạn đã nhập sai mã quá nhiều lần. Vui lòng gửi mã mới.' });
            }
            registerOtpStore.set(emailKey, storedOtp);
            return res.status(400).json({
                success: false,
                error: `Mã xác thực không chính xác. Bạn còn ${OTP_MAX_ATTEMPTS - storedOtp.attempts} lần thử.`
            });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;

        const { rows: dup } = await client.query(
            'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
            [usernameTrim, emailTrim]
        );
        if (dup.length > 0) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(400).json({ success: false, error: 'Username hoặc Email đã tồn tại' });
        }

        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

        await client.query(
            `INSERT INTO users
                (username, password, full_name, email, balance, purchase_history, deposit_history, created_at, last_login_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
            [usernameTrim, hashedPassword, fullNameTrim, emailTrim, 0, JSON.stringify([]), JSON.stringify([])]
        );

        let referralAttributed = false;
        if (/^[A-Z0-9_-]{4,20}$/.test(referralCode) && /^[a-f0-9]{64}$/.test(referralToken)) {
            const tokenHash = hashShopGoogleValue(referralToken);
            const { rows: clickRows } = await client.query(
                `SELECT click.code, click.affiliate_username
                 FROM public.affiliate_clicks click
                 JOIN public.affiliate_codes active_code
                   ON active_code.code = click.code
                  AND active_code.is_current = TRUE
                  AND LOWER(active_code.username) = LOWER(click.affiliate_username)
                 WHERE click.code = $1
                   AND click.attribution_token_hash = $2
                   AND click.token_consumed_at IS NULL
                   AND click.clicked_at >= NOW() - INTERVAL '30 days'
                   AND click.clicked_at + INTERVAL '30 days' > NOW()
                 FOR UPDATE OF click`,
                [referralCode, tokenHash]
            );
            if (clickRows.length &&
                clickRows[0].affiliate_username.toLowerCase() !== usernameTrim.toLowerCase()) {
                const click = clickRows[0];
                const insertedReferral = await client.query(
                    `INSERT INTO public.affiliate_referrals
                         (affiliate_username, referred_username, code_used, attributed_at, eligible_until)
                     VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 days')
                     ON CONFLICT (referred_username) DO NOTHING
                     RETURNING id`,
                    [click.affiliate_username, usernameTrim, click.code]
                );
                if (insertedReferral.rowCount) {
                    await client.query(
                        `UPDATE public.affiliate_clicks
                         SET token_consumed_at = NOW(), referred_username = $1
                         WHERE attribution_token_hash = $2`,
                        [usernameTrim, tokenHash]
                    );
                    referralAttributed = true;
                }
            }
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TIMEOUT_MS);
        await client.query(
            `INSERT INTO sessions (username, token, last_activity, created_at, expires_at)
             VALUES ($1, $2, NOW(), NOW(), $3)`,
            [usernameTrim, sessionToken, expiresAt]
        );
        await client.query('COMMIT');
        transactionOpen = false;

        registerOtpStore.delete(emailKey);

        queueEmail(
            emailTrim,
            'Chào mừng bạn đến với TyonCao Global Optimizer!',
            emailTemplates.welcome(fullNameTrim, usernameTrim)
        ).catch(err => console.error('Lỗi gửi mail welcome:', err));

        return res.json({
            success: true,
            message: 'Đăng ký thành công',
            user: { username: usernameTrim, fullName: fullNameTrim, email: emailTrim, balance: 0 },
            referralAttributed,
            sessionToken,
            expiresAt: expiresAt.toISOString()
        });
    } catch (err) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback registration failed:', rollbackError.message);
            }
        }
        if (isAffiliateSchemaError(err)) {
            return res.status(503).json({
                success: false,
                error: 'Hệ thống affiliate chưa được khởi tạo. Vui lòng liên hệ quản trị viên.'
            });
        }
        console.error('Register error:', err);
        if (err.code === '23505') return res.status(400).json({ success: false, error: 'Username hoặc Email đã tồn tại' });
        return res.status(500).json({ success: false, error: 'Lỗi server' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'Vui lòng nhập email' });

        const { rows } = await pool.query(
            'SELECT username, full_name FROM users WHERE LOWER(email) = LOWER($1)',
            [email.trim()]
        );
        if (rows.length === 0) {
            return res.json({ success: true, message: 'Nếu email tồn tại, bạn sẽ nhận được mã xác thực.' });
        }

        const user = rows[0];
        const otp = generateOtp();
        const expiresAt = Date.now() + RESET_OTP_TTL_MS;

        otpStore.set(email.trim().toLowerCase(), { otp, expiresAt, username: user.username });

        await sendEmailImmediate(
            email.trim(),
            'Mã xác thực đặt lại mật khẩu - TyonCao Global Optimizer',
            emailTemplates.forgotPassword(user.full_name, otp)
        );

        res.json({ success: true, message: 'Mã xác thực đã được gửi đến email của bạn.' });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/reset-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) return res.status(400).json({ success: false, error: 'Thiếu thông tin' });
        if (typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ success: false, error: 'Mật khẩu phải ≥8 ký tự' });
        }

        const record = otpStore.get(email.trim().toLowerCase());
        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            return res.status(400).json({ success: false, error: 'Mã xác thực không đúng hoặc đã hết hạn' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await pool.query('UPDATE users SET password = $1 WHERE LOWER(username) = LOWER($2)',
            [hashedPassword, record.username]);

        await pool.query('DELETE FROM sessions WHERE LOWER(username) = LOWER($1)', [record.username]);

        otpStore.delete(email.trim().toLowerCase());
        res.json({ success: true, message: 'Đặt lại mật khẩu thành công! Vui lòng đăng nhập lại.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password, rememberMe } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, error: 'Thiếu thông tin' });

        const { rows: matchedUsers } = await pool.query(
            `SELECT * FROM users
             WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
             LIMIT 1`,
            [String(username).trim()]
        );
        const dbUser = matchedUsers[0] || null;
        if (!dbUser) return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });

        let passwordMatch = false;
        if (dbUser.password && dbUser.password.startsWith('$2')) {
            passwordMatch = await bcrypt.compare(password, dbUser.password);
        } else {
            passwordMatch = password.trim() === (dbUser.password || '').trim();
            if (passwordMatch) {
                try {
                    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
                    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashed, dbUser.username]);
                } catch (_) {}
            }
        }
        if (!passwordMatch) return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });

        await pool.query(
            `UPDATE users
             SET previous_login_at = last_login_at, last_login_at = NOW()
             WHERE username = $1`,
            [dbUser.username]
        );
        
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = rememberMe 
            ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            : new Date(Date.now() + SESSION_ABSOLUTE_TIMEOUT_MS);

        await pool.query('DELETE FROM sessions WHERE username = $1', [dbUser.username]);
        await pool.query(
            `INSERT INTO sessions (username, token, last_activity, created_at, expires_at)
             VALUES ($1, $2, NOW(), NOW(), $3)`,
            [dbUser.username, sessionToken, expiresAt]
        );

        const depositHistory = safeParseJSON(dbUser.deposit_history);
        const purchaseHistory = safeParseJSON(dbUser.purchase_history);

        const userData = {
            username: dbUser.username,
            fullName: dbUser.full_name,
            email: dbUser.email || '',
            balance: Number(dbUser.balance),
            status: dbUser.status || 'active',
            depositHistory, purchaseHistory
        };
        
        console.log(`✅ [Login] ${dbUser.username} - Remember: ${rememberMe ? 'YES' : 'NO'}`);
        res.json({ 
            success: true, 
            user: userData, 
            sessionToken, 
            isRemembered: !!rememberMe, 
            expiresAt: expiresAt.toISOString() 
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            await pool.query('DELETE FROM sessions WHERE token = $1', [authHeader.substring(7)]);
        }
        res.json({ success: true, message: 'Đã đăng xuất' });
    } catch (err) {
        console.error('Logout error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 29: USER PROFILE
   ═══════════════════════════════════════════════════════════════════════════ */

const TUVI_REALMS = [
    { id: 'pham-nhan', name: 'Phàm Nhân', threshold: 0, frames: [0, 16, 9, 26, 42, 59] },
    { id: 'luyen-khi', name: 'Luyện Khí', threshold: 76, frames: [76, 126, 176, 226, 276, 326] },
    { id: 'truc-co', name: 'Trúc Cơ', threshold: 376, frames: [376, 476, 576, 676, 776, 876] },
    { id: 'kim-dan', name: 'Kim Đan', threshold: 976, frames: [976, 1142, 1309, 1476, 1642, 1809] },
    { id: 'nguyen-anh', name: 'Nguyên Anh', threshold: 1976, frames: [1976, 2226, 2476, 2726, 2976, 3226] },
    { id: 'hoa-than', name: 'Hóa Thần', threshold: 3476, frames: [3476, 3892, 4309, 4726, 5142, 5559] },
    { id: 'luyen-hu', name: 'Luyện Hư', threshold: 5976, frames: [5976, 6476, 6976, 7476, 7976, 8476] },
    { id: 'hop-the', name: 'Hợp Thể', threshold: 8976, frames: [8976, 9642, 10309, 10976, 11642, 12309] },
    { id: 'dai-thua', name: 'Đại Thừa', threshold: 12976, frames: [12976, 13809, 14642, 15476, 16309, 17142] },
    { id: 'do-kiep', name: 'Độ Kiếp', threshold: 17976, frames: [17976, 18976, 19976, 20976, 21976, 22976] }
];
const TUVI_DAILY_REWARD = 10;

function getTuViRealm(points) {
    return TUVI_REALMS.reduce((realm, candidate) =>
        points >= candidate.threshold ? candidate : realm, TUVI_REALMS[0]).name;
}

function getBestTuViFrame(points) {
    let bestFrame = null;
    TUVI_REALMS.forEach((realm, realmIndex) => {
        realm.frames.forEach((threshold, frameIndex) => {
            if (threshold <= points && (!bestFrame || threshold > bestFrame.threshold)) {
                bestFrame = { realmId: realm.id, frameIndex, threshold };
            }
        });
    });
    return bestFrame;
}

function getEquippedTuViFrame(points, mode, realmId, frameIndex) {
    if (mode === 'none') return null;
    if (mode === 'frame') {
        const realm = TUVI_REALMS.find(candidate => candidate.id === realmId);
        const index = frameIndex;
        if (!realm || !Number.isInteger(index) || index < 0 || index >= realm.frames.length ||
            realm.frames[index] > points) {
            return null;
        }
        return { realmId: realm.id, frameIndex: index };
    }
    return getBestTuViFrame(points);
}

app.get('/api/public/tu-tien/leaderboard', async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit, 10);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(20, Math.max(1, requestedLimit))
            : 5;
        const { rows } = await pool.query(
            `SELECT c.username, c.points, c.equipped_frame_mode,
                    c.equipped_frame_realm, c.equipped_frame_index,
                    u.avatar_url
             FROM user_cultivation c
             LEFT JOIN users u ON LOWER(u.username) = LOWER(c.username)
             ORDER BY c.points DESC, c.created_at ASC, LOWER(c.username) ASC
             LIMIT $1`,
            [limit]
        );
        return res.json({
            success: true,
            data: rows.map(row => {
                const points = Number(row.points);
                const mode = ['auto', 'none', 'frame'].includes(row.equipped_frame_mode)
                    ? row.equipped_frame_mode
                    : 'auto';
                return {
                    username: row.username,
                    avatar: row.avatar_url || '',
                    points: String(row.points),
                    realmName: getTuViRealm(points),
                    frame: getEquippedTuViFrame(
                        points,
                        mode,
                        row.equipped_frame_realm,
                        row.equipped_frame_index
                    )
                };
            })
        });
    } catch (error) {
        console.error('Tu Vi leaderboard error:', error.message);
        return res.status(500).json({ success: false, error: 'Could not load Tu Vi leaderboard.' });
    }
});

app.get('/api/user/tu-tien', requireUserSession, async (req, res) => {
    try {
        await pool.query(
            'INSERT INTO user_cultivation (username) VALUES ($1) ON CONFLICT (username) DO NOTHING',
            [req.username]
        );
        const { rows } = await pool.query(
            `SELECT points, streak_days, last_checkin_date, equipped_frame_mode,
                    equipped_frame_realm, equipped_frame_index,
                    COALESCE(
                        last_checkin_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
                        FALSE
                    ) AS checked_today
             FROM user_cultivation WHERE username = $1`,
            [req.username]
        );
        if (!rows.length) throw new Error('Tu Vi profile was not initialized.');
        const points = Number(rows[0].points);
        const streakDays = Number(rows[0].streak_days);
        const equippedFrameMode = ['auto', 'none', 'frame'].includes(rows[0].equipped_frame_mode)
            ? rows[0].equipped_frame_mode
            : 'auto';
        return res.json({
            success: true,
            data: {
                points,
                streakDays,
                checkedToday: rows[0].checked_today === true,
                todayReward: TUVI_DAILY_REWARD,
                realmName: getTuViRealm(points),
                equippedFrame: {
                    mode: equippedFrameMode,
                    realmId: rows[0].equipped_frame_realm,
                    frameIndex: rows[0].equipped_frame_index
                },
                frame: getEquippedTuViFrame(
                    points,
                    equippedFrameMode,
                    rows[0].equipped_frame_realm,
                    rows[0].equipped_frame_index
                )
            }
        });
    } catch (error) {
        console.error('Tu Vi profile error:', error.message);
        return res.status(500).json({ success: false, error: 'Could not load cultivation data.' });
    }
});

app.get('/api/user/tu-tien/check-ins', requireUserSession, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match || Number(match[1]) < 2000 || Number(match[1]) > 2100) {
        return res.status(400).json({ success: false, error: 'Tháng điểm danh không hợp lệ.' });
    }

    try {
        const monthStart = `${month}-01`;
        const { rows } = await pool.query(
            `WITH checkin_dates AS (
                 SELECT checkin_date
                 FROM user_cultivation_checkins
                 WHERE username = $1
                   AND checkin_date >= $2::date
                   AND checkin_date < ($2::date + INTERVAL '1 month')::date
                 UNION
                 SELECT last_checkin_date AS checkin_date
                 FROM user_cultivation
                 WHERE username = $1
                   AND last_checkin_date >= $2::date
                   AND last_checkin_date < ($2::date + INTERVAL '1 month')::date
             )
             SELECT TO_CHAR(checkin_date, 'YYYY-MM-DD') AS date
             FROM checkin_dates
             ORDER BY checkin_date`,
            [req.username, monthStart]
        );
        return res.json({ success: true, month, dates: rows.map(row => row.date) });
    } catch (error) {
        console.error('Tu Vi check-in history error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tải lịch sử điểm danh.' });
    }
});

app.post('/api/user/tu-tien/check-in', requireUserSession, requireActiveUser, async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(
            'INSERT INTO user_cultivation (username) VALUES ($1) ON CONFLICT (username) DO NOTHING',
            [req.username]
        );
        const { rows } = await client.query(
            `SELECT points, streak_days, last_checkin_date,
                    equipped_frame_mode, equipped_frame_realm, equipped_frame_index,
                    last_checkin_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS checked_today,
                    last_checkin_date = ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1) AS checked_yesterday
             FROM user_cultivation WHERE username = $1 FOR UPDATE`,
            [req.username]
        );
        const profile = rows[0];
        if (profile.checked_today) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, error: 'Bạn đã điểm danh hôm nay rồi.' });
        }
        const streakDays = profile.checked_yesterday
            ? Number(profile.streak_days) + 1
            : 1;
        const points = Number(profile.points) + TUVI_DAILY_REWARD;
        await client.query(
            `UPDATE user_cultivation
             SET points = $1, streak_days = $2,
                 last_checkin_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
                 updated_at = NOW()
             WHERE username = $3`,
            [points, streakDays, req.username]
        );
        await client.query(
            `INSERT INTO user_cultivation_checkins (username, checkin_date)
             VALUES ($1, (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
             ON CONFLICT (username, checkin_date) DO NOTHING`,
            [req.username]
        );
        await client.query('COMMIT');
        return res.json({
            success: true,
            pointsEarned: TUVI_DAILY_REWARD,
            data: {
                points,
                streakDays,
                checkedToday: true,
                todayReward: TUVI_DAILY_REWARD,
                realmName: getTuViRealm(points),
                frame: getEquippedTuViFrame(
                    points,
                    profile.equipped_frame_mode,
                    profile.equipped_frame_realm,
                    profile.equipped_frame_index
                )
            }
        });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
            console.error('Tu Vi check-in rollback failed:', rollbackError.message);
        }
        console.error('Tu Vi check-in error:', error.message);
        return res.status(500).json({ success: false, error: 'Could not check in today.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/user/tu-tien/frame', requireUserSession, requireActiveUser, async (req, res) => {
    try {
        const body = req.body || {};
        const mode = body.mode;
        if (!['auto', 'none', 'frame'].includes(mode)) {
            return res.status(400).json({ success: false, error: 'Chế độ khung không hợp lệ.' });
        }

        await pool.query(
            'INSERT INTO user_cultivation (username) VALUES ($1) ON CONFLICT (username) DO NOTHING',
            [req.username]
        );
        const { rows } = await pool.query(
            'SELECT points FROM user_cultivation WHERE username = $1',
            [req.username]
        );
        if (!rows.length) throw new Error('Tu Vi profile was not initialized.');
        const points = Number(rows[0] && rows[0].points);
        if (!Number.isFinite(points) || points < 0) {
            throw new Error('Tu Vi points are invalid.');
        }
        let frame = null;
        if (mode === 'frame') {
            frame = getEquippedTuViFrame(points, mode, body.realmId, body.frameIndex);
            if (!frame) {
                return res.status(400).json({
                    success: false,
                    error: 'Khung không hợp lệ hoặc bạn chưa mở khóa khung này.'
                });
            }
        }

        await pool.query(
            `UPDATE user_cultivation
             SET equipped_frame_mode = $1, equipped_frame_realm = $2,
                 equipped_frame_index = $3, updated_at = NOW()
             WHERE username = $4`,
            [mode, frame ? frame.realmId : null, frame ? frame.frameIndex : null, req.username]
        );
        return res.json({
            success: true,
            data: {
                mode,
                realmId: frame ? frame.realmId : null,
                frameIndex: frame ? frame.frameIndex : null,
                points,
                frame: getEquippedTuViFrame(points, mode, frame && frame.realmId, frame && frame.frameIndex)
            }
        });
    } catch (error) {
        console.error('Tu Vi frame update error:', error.message);
        return res.status(500).json({ success: false, error: 'Could not update equipped frame.' });
    }
});

function buildUserStatistics(dbUser, sessionCreatedAt) {
    const depositHistory = safeParseJSON(dbUser.deposit_history);
    const purchaseHistory = safeParseJSON(dbUser.purchase_history);
    const deposits = depositHistory.filter(item => item && !/refund/i.test(String(item.method || '')));
    const refunds = depositHistory.filter(item => item && /refund/i.test(String(item.method || '')));
    const sum = (items, field) => items.reduce(
        (total, item) => total + (Number(item && item[field]) || 0),
        0
    );
    const totalDeposits = sum(deposits, 'amount');
    const now = new Date();
    const vietnamMonthParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(now);
    const currentVietnamMonth = `${vietnamMonthParts.find(part => part.type === 'year').value}-${vietnamMonthParts.find(part => part.type === 'month').value}`;
    const monthlyDeposits = sum(
        deposits.filter(item => {
            const transactionDate = new Date(item.at || item.date || item.createdAt || item.created_at || '');
            if (Number.isNaN(transactionDate.getTime())) return false;
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Ho_Chi_Minh',
                year: 'numeric',
                month: '2-digit'
            }).formatToParts(transactionDate);
            return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}` === currentVietnamMonth;
        }),
        'amount'
    );
    const currentTier = totalDeposits >= 10000000
        ? 'Diamond'
        : totalDeposits >= 2000000
            ? 'Gold'
            : totalDeposits >= 500000
                ? 'Silver'
                : 'Member';

    return {
        balance: Number(dbUser.balance) || 0,
        totalDeposits,
        monthlyDeposits,
        totalSpent: sum(purchaseHistory, 'price'),
        totalRefunded: sum(refunds, 'amount'),
        depositCount: deposits.length,
        purchaseCount: purchaseHistory.length,
        totalOrders: purchaseHistory.length,
        rank: dbUser.rank || currentTier,
        lastLoginAt: dbUser.previous_login_at || sessionCreatedAt || null,
        currentLoginAt: dbUser.last_login_at || sessionCreatedAt || null,
        createdAt: dbUser.created_at || null
    };
}

app.get('/api/user/statistics', requireUserSession, async (req, res) => {
    try {
        const dbUser = await getUserByUsername(req.username);
        if (!dbUser) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });
        return res.json({
            success: true,
            data: buildUserStatistics(dbUser, req.session.created_at)
        });
    } catch (err) {
        console.error('Lỗi lấy thống kê trang chủ:', err);
        return res.status(500).json({ success: false, error: 'Không thể tải thống kê người dùng.' });
    }
});

function getSocialUsername(value) {
    return String(value || '').trim().toLowerCase();
}

function getSocialRecordId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function handleSocialApiError(res, error, action) {
    if (error.code === '42P01') {
        return res.status(503).json({
            success: false,
            error: 'Hộp thư chưa được khởi tạo. Vui lòng chạy migration Supabase mới nhất.'
        });
    }
    console.error(`${action}:`, error);
    return res.status(500).json({ success: false, error: `Không thể ${action.toLowerCase()}.` });
}

app.get('/api/user/messages/users', requireUserSession, async (req, res) => {
    const query = String(req.query.q || '').trim().replace(/^@/, '');
    if (query.length < 2 || query.length > 60) {
        return res.status(400).json({ success: false, error: 'Từ khóa tìm kiếm phải dài từ 2 đến 60 ký tự.' });
    }

    try {
        const username = getSocialUsername(req.username);
        const search = `%${query}%`;
        const { rows } = await pool.query(
            `SELECT u.username, u.full_name, u.avatar_url, u.blue_tick_active,
                    u.blue_tick_expires_at
             FROM public.users u
             WHERE LOWER(u.username) <> $1
               AND COALESCE(LOWER(u.status), 'active') <> 'banned'
               AND (u.username ILIKE $2 OR COALESCE(u.full_name, '') ILIKE $2)
               AND NOT EXISTS (
                   SELECT 1 FROM public.user_blocks b
                   WHERE (b.blocker_username = $1 AND b.blocked_username = LOWER(u.username))
                      OR (b.blocker_username = LOWER(u.username) AND b.blocked_username = $1)
               )
             ORDER BY CASE WHEN LOWER(u.username) = LOWER($3) THEN 0 ELSE 1 END,
                      u.username
             LIMIT 15`,
            [username, search, query]
        );
        return res.json({
            success: true,
            data: rows.map(user => ({
                username: user.username,
                fullName: user.full_name || '',
                avatar: user.avatar_url || '',
                blueTickActive: Boolean(user.blue_tick_active) &&
                    user.blue_tick_expires_at &&
                    new Date(user.blue_tick_expires_at).getTime() > Date.now()
            }))
        });
    } catch (error) {
        return handleSocialApiError(res, error, 'Tìm người dùng để nhắn tin');
    }
});

app.get('/api/user/messages/conversations', requireUserSession, async (req, res) => {
    try {
        const username = getSocialUsername(req.username);
        const { rows } = await pool.query(
            `SELECT c.id, u.username, u.full_name, u.avatar_url, u.blue_tick_active,
                    u.blue_tick_expires_at, latest.body AS last_message,
                    latest.created_at AS last_message_at,
                    (SELECT COUNT(*)::INTEGER
                     FROM public.direct_messages unread
                     WHERE unread.conversation_id = c.id
                       AND LOWER(unread.sender_username) = LOWER(u.username)
                       AND unread.read_at IS NULL) AS unread_count
             FROM public.direct_conversations c
             JOIN public.users u
               ON LOWER(u.username) = CASE
                    WHEN c.participant_one = $1 THEN c.participant_two
                    ELSE c.participant_one
                  END
             LEFT JOIN LATERAL (
                 SELECT m.body, m.created_at
                 FROM public.direct_messages m
                 WHERE m.conversation_id = c.id
                 ORDER BY m.id DESC
                 LIMIT 1
             ) latest ON TRUE
             WHERE (c.participant_one = $1 OR c.participant_two = $1)
               AND NOT EXISTS (
                   SELECT 1 FROM public.user_blocks b
                   WHERE (b.blocker_username = $1 AND b.blocked_username = LOWER(u.username))
                      OR (b.blocker_username = LOWER(u.username) AND b.blocked_username = $1)
               )
             ORDER BY COALESCE(latest.created_at, c.updated_at) DESC
             LIMIT 100`,
            [username]
        );
        return res.json({
            success: true,
            data: rows.map(conversation => ({
                id: String(conversation.id),
                username: conversation.username,
                fullName: conversation.full_name || '',
                avatar: conversation.avatar_url || '',
                blueTickActive: Boolean(conversation.blue_tick_active) &&
                    conversation.blue_tick_expires_at &&
                    new Date(conversation.blue_tick_expires_at).getTime() > Date.now(),
                lastMessage: conversation.last_message || '',
                lastMessageAt: conversation.last_message_at || null,
                unreadCount: Number(conversation.unread_count) || 0
            }))
        });
    } catch (error) {
        return handleSocialApiError(res, error, 'Tải danh sách hội thoại');
    }
});

app.post('/api/user/messages/conversations', requireUserSession, requireActiveUser, async (req, res) => {
    const targetUsername = getSocialUsername(req.body && req.body.username);
    const ownUsername = getSocialUsername(req.username);
    if (!targetUsername || targetUsername.length > 100) {
        return res.status(400).json({ success: false, error: 'Tên người dùng không hợp lệ.' });
    }
    if (targetUsername === ownUsername) {
        return res.status(400).json({ success: false, error: 'Bạn không thể tự mở hội thoại với mình.' });
    }

    try {
        const { rows: users } = await pool.query(
            `SELECT username, full_name, avatar_url, blue_tick_active, blue_tick_expires_at
             FROM public.users
             WHERE LOWER(username) = $1
               AND COALESCE(LOWER(status), 'active') <> 'banned'
             LIMIT 1`,
            [targetUsername]
        );
        if (!users.length) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });

        const blocked = await pool.query(
            `SELECT 1 FROM public.user_blocks
             WHERE (blocker_username = $1 AND blocked_username = $2)
                OR (blocker_username = $2 AND blocked_username = $1)
             LIMIT 1`,
            [ownUsername, targetUsername]
        );
        if (blocked.rowCount) {
            return res.status(403).json({ success: false, error: 'Không thể nhắn tin với người dùng này.' });
        }

        const [participantOne, participantTwo] = [ownUsername, targetUsername].sort();
        let { rows } = await pool.query(
            `INSERT INTO public.direct_conversations (participant_one, participant_two)
             VALUES ($1, $2)
             ON CONFLICT (participant_one, participant_two) DO NOTHING
             RETURNING id`,
            [participantOne, participantTwo]
        );
        if (!rows.length) {
            ({ rows } = await pool.query(
                `SELECT id FROM public.direct_conversations
                 WHERE participant_one = $1 AND participant_two = $2`,
                [participantOne, participantTwo]
            ));
        }

        const target = users[0];
        return res.json({
            success: true,
            data: {
                id: String(rows[0].id),
                username: target.username,
                fullName: target.full_name || '',
                avatar: target.avatar_url || '',
                blueTickActive: Boolean(target.blue_tick_active) &&
                    target.blue_tick_expires_at &&
                    new Date(target.blue_tick_expires_at).getTime() > Date.now()
            }
        });
    } catch (error) {
        return handleSocialApiError(res, error, 'Mở hội thoại');
    }
});

app.get('/api/user/messages/conversations/:conversationId/messages', requireUserSession, async (req, res) => {
    const conversationId = getSocialRecordId(req.params.conversationId);
    const beforeId = req.query.before ? getSocialRecordId(req.query.before) : null;
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    if (!conversationId || (req.query.before && !beforeId)) {
        return res.status(400).json({ success: false, error: 'Hội thoại không hợp lệ.' });
    }

    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        const username = getSocialUsername(req.username);
        await client.query('BEGIN');
        transactionOpen = true;
        const access = await client.query(
            `SELECT 1
             FROM public.direct_conversations c
             WHERE c.id = $1
               AND (c.participant_one = $2 OR c.participant_two = $2)
               AND NOT EXISTS (
                   SELECT 1 FROM public.user_blocks b
                   WHERE (b.blocker_username = $2 AND b.blocked_username = CASE
                            WHEN c.participant_one = $2 THEN c.participant_two ELSE c.participant_one END)
                      OR (b.blocked_username = $2 AND b.blocker_username = CASE
                            WHEN c.participant_one = $2 THEN c.participant_two ELSE c.participant_one END)
               )`,
            [conversationId, username]
        );
        if (!access.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Không tìm thấy hội thoại.' });
        }

        const { rows } = await client.query(
            `SELECT id, sender_username, body, created_at, read_at
             FROM public.direct_messages
             WHERE conversation_id = $1
               AND ($2::BIGINT IS NULL OR id < $2)
             ORDER BY id DESC
             LIMIT $3`,
            [conversationId, beforeId, limit]
        );
        const messageIds = rows
            .filter(message => getSocialUsername(message.sender_username) !== username && !message.read_at)
            .map(message => String(message.id));
        if (messageIds.length) {
            await client.query(
                `UPDATE public.direct_messages
                 SET read_at = NOW()
                 WHERE id = ANY($1::BIGINT[]) AND read_at IS NULL`,
                [messageIds]
            );
        }
        await client.query('COMMIT');
        transactionOpen = false;

        return res.json({
            success: true,
            data: rows.reverse().map(message => ({
                id: String(message.id),
                senderUsername: message.sender_username,
                body: message.body,
                createdAt: message.created_at,
                readAt: message.read_at || (messageIds.includes(String(message.id)) ? new Date().toISOString() : null)
            }))
        });
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback tải tin nhắn thất bại:', rollbackError.message);
            }
        }
        return handleSocialApiError(res, error, 'Tải tin nhắn');
    } finally {
        if (client) client.release();
    }
});

app.post('/api/user/messages/conversations/:conversationId/messages', requireUserSession, requireActiveUser, async (req, res) => {
    const conversationId = getSocialRecordId(req.params.conversationId);
    const body = req.body && typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!conversationId) return res.status(400).json({ success: false, error: 'Hội thoại không hợp lệ.' });
    if (!body || body.length > 4000) {
        return res.status(400).json({ success: false, error: 'Tin nhắn phải có từ 1 đến 4.000 ký tự.' });
    }

    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        const username = getSocialUsername(req.username);
        await client.query('BEGIN');
        transactionOpen = true;
        const access = await client.query(
            `SELECT c.id
             FROM public.direct_conversations c
             WHERE c.id = $1
               AND (c.participant_one = $2 OR c.participant_two = $2)
               AND NOT EXISTS (
                   SELECT 1 FROM public.user_blocks b
                   WHERE (b.blocker_username = $2 AND b.blocked_username = CASE
                            WHEN c.participant_one = $2 THEN c.participant_two ELSE c.participant_one END)
                      OR (b.blocked_username = $2 AND b.blocker_username = CASE
                            WHEN c.participant_one = $2 THEN c.participant_two ELSE c.participant_one END)
               )
             FOR UPDATE`,
            [conversationId, username]
        );
        if (!access.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Không tìm thấy hội thoại hoặc quyền nhắn tin đã bị thu hồi.' });
        }
        const { rows } = await client.query(
            `INSERT INTO public.direct_messages (conversation_id, sender_username, body)
             VALUES ($1, $2, $3)
             RETURNING id, sender_username, body, created_at, read_at`,
            [conversationId, username, body]
        );
        await client.query(
            'UPDATE public.direct_conversations SET updated_at = NOW() WHERE id = $1',
            [conversationId]
        );
        await client.query('COMMIT');
        transactionOpen = false;
        const message = rows[0];
        return res.status(201).json({
            success: true,
            data: {
                id: String(message.id),
                senderUsername: message.sender_username,
                body: message.body,
                createdAt: message.created_at,
                readAt: null
            }
        });
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback gửi tin nhắn thất bại:', rollbackError.message);
            }
        }
        return handleSocialApiError(res, error, 'Gửi tin nhắn');
    } finally {
        if (client) client.release();
    }
});

app.get('/api/user/friends', requireUserSession, async (req, res) => {
    try {
        const username = getSocialUsername(req.username);
        const [friends, incoming, outgoing, blocked] = await Promise.all([
            pool.query(
                `SELECT r.id,
                        u.username, u.full_name, u.avatar_url, u.blue_tick_active,
                        u.blue_tick_expires_at
                 FROM public.user_friend_requests r
                 JOIN public.users u ON LOWER(u.username) = CASE
                    WHEN r.requester_username = $1 THEN r.recipient_username
                    ELSE r.requester_username END
                 WHERE r.status = 'accepted'
                   AND (r.requester_username = $1 OR r.recipient_username = $1)
                 ORDER BY LOWER(COALESCE(u.full_name, u.username)), u.username`,
                [username]
            ),
            pool.query(
                `SELECT r.id, u.username, u.full_name, u.avatar_url
                 FROM public.user_friend_requests r
                 JOIN public.users u ON LOWER(u.username) = r.requester_username
                 WHERE r.recipient_username = $1 AND r.status = 'pending'
                 ORDER BY r.created_at DESC`,
                [username]
            ),
            pool.query(
                `SELECT r.id, u.username, u.full_name, u.avatar_url
                 FROM public.user_friend_requests r
                 JOIN public.users u ON LOWER(u.username) = r.recipient_username
                 WHERE r.requester_username = $1 AND r.status = 'pending'
                 ORDER BY r.created_at DESC`,
                [username]
            ),
            pool.query(
                `SELECT u.username, u.full_name, u.avatar_url
                 FROM public.user_blocks b
                 JOIN public.users u ON LOWER(u.username) = b.blocked_username
                 WHERE b.blocker_username = $1
                 ORDER BY b.created_at DESC`,
                [username]
            )
        ]);
        const toUser = user => ({
            username: user.username,
            fullName: user.full_name || '',
            avatar: user.avatar_url || '',
            blueTickActive: Boolean(user.blue_tick_active) &&
                user.blue_tick_expires_at &&
                new Date(user.blue_tick_expires_at).getTime() > Date.now()
        });
        return res.json({
            success: true,
            data: {
                friends: friends.rows.map(user => ({ id: String(user.id), ...toUser(user) })),
                incomingRequests: incoming.rows.map(user => ({ id: String(user.id), ...toUser(user) })),
                outgoingRequests: outgoing.rows.map(user => ({ id: String(user.id), ...toUser(user) })),
                blockedUsers: blocked.rows.map(toUser)
            }
        });
    } catch (error) {
        return handleSocialApiError(res, error, 'Tải danh sách bạn bè');
    }
});

app.get('/api/user/friends/search', requireUserSession, async (req, res) => {
    const query = String(req.query.q || '').trim().replace(/^@/, '');
    if (query.length < 2 || query.length > 60) {
        return res.status(400).json({ success: false, error: 'Từ khóa tìm kiếm phải dài từ 2 đến 60 ký tự.' });
    }
    try {
        const username = getSocialUsername(req.username);
        const { rows } = await pool.query(
            `SELECT u.username, u.full_name, u.avatar_url,
                    CASE
                      WHEN blocked.blocker_username IS NOT NULL THEN 'blocked'
                      WHEN relation.status = 'accepted' THEN 'friends'
                      WHEN relation.requester_username = $1 THEN 'sent'
                      WHEN relation.recipient_username = $1 THEN 'received'
                      ELSE 'none'
                    END AS relationship,
                    (blocked.blocker_username = $1) AS blocked_by_me,
                    relation.id AS request_id
             FROM public.users u
             LEFT JOIN LATERAL (
                 SELECT r.id, r.status, r.requester_username, r.recipient_username
                 FROM public.user_friend_requests r
                 WHERE (r.requester_username = $1 AND r.recipient_username = LOWER(u.username))
                    OR (r.recipient_username = $1 AND r.requester_username = LOWER(u.username))
                 ORDER BY CASE WHEN r.status = 'accepted' THEN 0 ELSE 1 END, r.updated_at DESC
                 LIMIT 1
             ) relation ON TRUE
             LEFT JOIN LATERAL (
                 SELECT b.blocker_username
                 FROM public.user_blocks b
                 WHERE (b.blocker_username = $1 AND b.blocked_username = LOWER(u.username))
                    OR (b.blocked_username = $1 AND b.blocker_username = LOWER(u.username))
                 LIMIT 1
             ) blocked ON TRUE
             WHERE LOWER(u.username) <> $1
               AND COALESCE(LOWER(u.status), 'active') <> 'banned'
               AND (u.username ILIKE $2 OR COALESCE(u.full_name, '') ILIKE $2)
             ORDER BY LOWER(COALESCE(u.full_name, u.username)), u.username
             LIMIT 15`,
            [username, `%${query}%`]
        );
        return res.json({
            success: true,
            data: rows.map(user => ({
                username: user.username,
                fullName: user.full_name || '',
                avatar: user.avatar_url || '',
                relationship: user.relationship,
                blockedByMe: Boolean(user.blocked_by_me),
                requestId: user.request_id ? String(user.request_id) : null
            }))
        });
    } catch (error) {
        return handleSocialApiError(res, error, 'Tìm người dùng');
    }
});

app.post('/api/user/friends/requests', requireUserSession, requireActiveUser, async (req, res) => {
    const targetUsername = getSocialUsername(req.body && req.body.username);
    const ownUsername = getSocialUsername(req.username);
    if (!targetUsername || targetUsername.length > 100 || targetUsername === ownUsername) {
        return res.status(400).json({ success: false, error: 'Tên người dùng không hợp lệ.' });
    }
    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;
        const { rows: lockedUsers } = await client.query(
            `SELECT username FROM public.users
             WHERE LOWER(username) IN ($1, $2)
               AND COALESCE(LOWER(status), 'active') <> 'banned'
             ORDER BY LOWER(username)
             FOR UPDATE`,
            [ownUsername, targetUsername]
        );
        if (!lockedUsers.some(user => getSocialUsername(user.username) === targetUsername)) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
        }
        const blocked = await client.query(
            `SELECT 1 FROM public.user_blocks
             WHERE (blocker_username = $1 AND blocked_username = $2)
                OR (blocker_username = $2 AND blocked_username = $1)
             LIMIT 1`,
            [ownUsername, targetUsername]
        );
        if (blocked.rowCount) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, error: 'Không thể gửi lời mời tới người dùng này.' });
        }
        const accepted = await client.query(
            `SELECT 1 FROM public.user_friend_requests
             WHERE status = 'accepted'
               AND ((requester_username = $1 AND recipient_username = $2)
                 OR (requester_username = $2 AND recipient_username = $1))
             LIMIT 1`,
            [ownUsername, targetUsername]
        );
        if (accepted.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, error: 'Hai tài khoản đã là bạn bè.' });
        }

        const { rows: reciprocal } = await client.query(
            `UPDATE public.user_friend_requests
             SET status = 'accepted', updated_at = NOW()
             WHERE requester_username = $1 AND recipient_username = $2 AND status = 'pending'
             RETURNING id, status`,
            [targetUsername, ownUsername]
        );
        if (reciprocal.length) {
            await client.query('COMMIT');
            transactionOpen = false;
            return res.json({
                success: true,
                data: { id: String(reciprocal[0].id), status: reciprocal[0].status },
                message: 'Đã chấp nhận lời mời kết bạn.'
            });
        }

        let { rows } = await client.query(
            `INSERT INTO public.user_friend_requests (requester_username, recipient_username)
             VALUES ($1, $2)
             ON CONFLICT (requester_username, recipient_username) DO UPDATE
                 SET status = 'pending', updated_at = NOW()
                 WHERE public.user_friend_requests.status = 'rejected'
             RETURNING id, status`,
            [ownUsername, targetUsername]
        );
        if (!rows.length) {
            ({ rows } = await client.query(
                `SELECT id, status FROM public.user_friend_requests
                 WHERE requester_username = $1 AND recipient_username = $2`,
                [ownUsername, targetUsername]
            ));
        }
        await client.query('COMMIT');
        transactionOpen = false;
        return res.json({
            success: true,
            data: { id: String(rows[0].id), status: rows[0].status },
            message: rows[0].status === 'pending'
                ? 'Đã gửi lời mời kết bạn.'
                : 'Hai tài khoản đã là bạn bè.'
        });
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback gửi lời mời thất bại:', rollbackError.message);
            }
        }
        return handleSocialApiError(res, error, 'Gửi lời mời kết bạn');
    } finally {
        if (client) client.release();
    }
});

app.post('/api/user/friends/requests/:requestId/accept', requireUserSession, requireActiveUser, async (req, res) => {
    const requestId = getSocialRecordId(req.params.requestId);
    if (!requestId) return res.status(400).json({ success: false, error: 'Lời mời không hợp lệ.' });
    try {
        const username = getSocialUsername(req.username);
        const { rows } = await pool.query(
            `UPDATE public.user_friend_requests r
             SET status = 'accepted', updated_at = NOW()
             WHERE r.id = $1 AND r.recipient_username = $2 AND r.status = 'pending'
               AND NOT EXISTS (
                   SELECT 1 FROM public.user_blocks b
                   WHERE (b.blocker_username = $2 AND b.blocked_username = r.requester_username)
                      OR (b.blocker_username = r.requester_username AND b.blocked_username = $2)
               )
             RETURNING id`,
            [requestId, username]
        );
        if (!rows.length) {
            return res.status(404).json({ success: false, error: 'Lời mời không còn hiệu lực hoặc đã bị chặn.' });
        }
        return res.json({ success: true, message: 'Đã chấp nhận lời mời kết bạn.' });
    } catch (error) {
        return handleSocialApiError(res, error, 'Chấp nhận lời mời kết bạn');
    }
});

app.post('/api/user/friends/requests/:requestId/reject', requireUserSession, requireActiveUser, async (req, res) => {
    const requestId = getSocialRecordId(req.params.requestId);
    if (!requestId) return res.status(400).json({ success: false, error: 'Lời mời không hợp lệ.' });
    try {
        const { rowCount } = await pool.query(
            `UPDATE public.user_friend_requests
             SET status = 'rejected', updated_at = NOW()
             WHERE id = $1 AND recipient_username = $2 AND status = 'pending'`,
            [requestId, getSocialUsername(req.username)]
        );
        if (!rowCount) return res.status(404).json({ success: false, error: 'Không tìm thấy lời mời.' });
        return res.json({ success: true, message: 'Đã từ chối lời mời kết bạn.' });
    } catch (error) {
        return handleSocialApiError(res, error, 'Từ chối lời mời kết bạn');
    }
});

app.delete('/api/user/friends/requests/:requestId', requireUserSession, requireActiveUser, async (req, res) => {
    const requestId = getSocialRecordId(req.params.requestId);
    if (!requestId) return res.status(400).json({ success: false, error: 'Lời mời không hợp lệ.' });
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM public.user_friend_requests
             WHERE id = $1 AND requester_username = $2 AND status = 'pending'`,
            [requestId, getSocialUsername(req.username)]
        );
        if (!rowCount) return res.status(404).json({ success: false, error: 'Không tìm thấy lời mời đang chờ.' });
        return res.json({ success: true, message: 'Đã hủy lời mời kết bạn.' });
    } catch (error) {
        return handleSocialApiError(res, error, 'Hủy lời mời kết bạn');
    }
});

app.delete('/api/user/friends/:username', requireUserSession, requireActiveUser, async (req, res) => {
    const targetUsername = getSocialUsername(req.params.username);
    const ownUsername = getSocialUsername(req.username);
    if (!targetUsername || targetUsername === ownUsername) {
        return res.status(400).json({ success: false, error: 'Tên người dùng không hợp lệ.' });
    }
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM public.user_friend_requests
             WHERE status = 'accepted'
               AND ((requester_username = $1 AND recipient_username = $2)
                 OR (requester_username = $2 AND recipient_username = $1))`,
            [ownUsername, targetUsername]
        );
        if (!rowCount) return res.status(404).json({ success: false, error: 'Hai tài khoản chưa là bạn bè.' });
        return res.json({ success: true, message: 'Đã xóa bạn bè.' });
    } catch (error) {
        return handleSocialApiError(res, error, 'Xóa bạn bè');
    }
});

app.post('/api/user/friends/blocks', requireUserSession, requireActiveUser, async (req, res) => {
    const targetUsername = getSocialUsername(req.body && req.body.username);
    const ownUsername = getSocialUsername(req.username);
    if (!targetUsername || targetUsername.length > 100 || targetUsername === ownUsername) {
        return res.status(400).json({ success: false, error: 'Tên người dùng không hợp lệ.' });
    }
    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;
        const target = await client.query(
            'SELECT 1 FROM public.users WHERE LOWER(username) = $1',
            [targetUsername]
        );
        if (!target.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
        }
        await client.query(
            `INSERT INTO public.user_blocks (blocker_username, blocked_username)
             VALUES ($1, $2) ON CONFLICT (blocker_username, blocked_username) DO NOTHING`,
            [ownUsername, targetUsername]
        );
        await client.query(
            `DELETE FROM public.user_friend_requests
             WHERE (requester_username = $1 AND recipient_username = $2)
                OR (requester_username = $2 AND recipient_username = $1)`,
            [ownUsername, targetUsername]
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return res.json({ success: true, message: 'Đã chặn người dùng.' });
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback chặn người dùng thất bại:', rollbackError.message);
            }
        }
        return handleSocialApiError(res, error, 'Chặn người dùng');
    } finally {
        if (client) client.release();
    }
});

app.delete('/api/user/friends/blocks/:username', requireUserSession, requireActiveUser, async (req, res) => {
    const targetUsername = getSocialUsername(req.params.username);
    if (!targetUsername) return res.status(400).json({ success: false, error: 'Tên người dùng không hợp lệ.' });
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM public.user_blocks
             WHERE blocker_username = $1 AND blocked_username = $2`,
            [getSocialUsername(req.username), targetUsername]
        );
        if (!rowCount) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng trong danh sách chặn.' });
        return res.json({ success: true, message: 'Đã bỏ chặn người dùng.' });
    } catch (error) {
        return handleSocialApiError(res, error, 'Bỏ chặn người dùng');
    }
});

function getPartnerApiEncryptionKey() {
    const secret = String(process.env.API_KEY_ENCRYPTION_SECRET || JWT_SECRET || '').trim();
    if (!secret) throw new Error('API_KEY_ENCRYPTION_SECRET chưa được cấu hình.');
    return crypto.createHash('sha256').update(secret).digest();
}

function encryptPartnerApiKey(key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getPartnerApiEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    return {
        encryptedKey: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64')
    };
}

function decryptPartnerApiKey(record) {
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        getPartnerApiEncryptionKey(),
        Buffer.from(record.encryption_iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(record.encryption_tag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(record.encrypted_key, 'base64')),
        decipher.final()
    ]).toString('utf8');
}

app.post('/api/user/public-api-key', requireUserSession, requireActiveUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const rotate = Boolean(req.body && req.body.rotate === true);
    try {
        const existing = await pool.query(
            `SELECT encrypted_key, encryption_iv, encryption_tag, created_at
             FROM public.user_api_keys WHERE username = $1`,
            [req.username]
        );
        if (existing.rows.length && !rotate) {
            return res.json({
                success: true,
                data: {
                    key: decryptPartnerApiKey(existing.rows[0]),
                    createdAt: existing.rows[0].created_at
                }
            });
        }

        const key = `tyon_api_${crypto.randomBytes(32).toString('hex')}`;
        const encrypted = encryptPartnerApiKey(key);
        const keyHash = crypto.createHash('sha256').update(key).digest('hex');
        const saved = await pool.query(
            `INSERT INTO public.user_api_keys
                 (username, key_hash, encrypted_key, encryption_iv, encryption_tag, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (username) DO UPDATE
             SET key_hash = EXCLUDED.key_hash,
                 encrypted_key = EXCLUDED.encrypted_key,
                 encryption_iv = EXCLUDED.encryption_iv,
                 encryption_tag = EXCLUDED.encryption_tag,
                 created_at = NOW()
             RETURNING created_at`,
            [req.username, keyHash, encrypted.encryptedKey, encrypted.iv, encrypted.tag]
        );
        return res.json({
            success: true,
            data: { key, createdAt: saved.rows[0].created_at }
        });
    } catch (error) {
        if (error.code === '42P01') {
            return res.status(503).json({
                success: false,
                error: 'API key chưa được khởi tạo. Vui lòng chạy migration Supabase mới nhất.'
            });
        }
        console.error('Partner API key error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tải hoặc tạo API key.' });
    }
});

const AFFILIATE_COMMISSION_RATES_BPS = Object.freeze({
    blue_tick: 2000,
    automxh: 1000,
    ai_agent: 500,
    tyon_shop: 1000,
    optimizer: 1000
});

function isAffiliateSchemaError(error) {
    return error && (error.code === '42P01' || error.code === '42703');
}

function affiliateMigrationResponse(res) {
    return res.status(503).json({
        success: false,
        error: 'Affiliate chưa được khởi tạo. Vui lòng chạy migration Supabase mới nhất.'
    });
}

async function recordAffiliateCommission(client, { buyerUsername, sourceOrderId, category, grossAmount }) {
    const rateBps = AFFILIATE_COMMISSION_RATES_BPS[category];
    const gross = Number(grossAmount);
    if (!rateBps || !Number.isSafeInteger(gross) || gross <= 0 ||
        typeof sourceOrderId !== 'string' || !sourceOrderId || sourceOrderId.length > 160) {
        return;
    }

    const amount = Math.floor(gross * rateBps / 10000);
    if (!Number.isSafeInteger(amount) || amount <= 0) return;

    const { rows } = await client.query(
        `SELECT affiliate_username
         FROM public.affiliate_referrals
         WHERE LOWER(referred_username) = LOWER($1)
           AND eligible_until > NOW()
           AND LOWER(affiliate_username) <> LOWER($1)
         FOR UPDATE`,
        [buyerUsername]
    );
    if (!rows.length) return;

    await client.query(
        `INSERT INTO public.affiliate_commissions
             (affiliate_username, referred_username, category, source_order_id,
              gross_amount, rate_bps, amount, status, hold_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW() + INTERVAL '3 days')
         ON CONFLICT (source_order_id) DO NOTHING`,
        [rows[0].affiliate_username, buyerUsername, category, sourceOrderId, gross, rateBps, amount]
    );
}

app.post('/api/public/affiliate/click', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const code = String(req.body && req.body.code || '').trim().toUpperCase();
    const visitorId = String(req.body && req.body.visitorId || '').trim();
    if (!/^[A-Z0-9_-]{4,20}$/.test(code) ||
        !/^[a-f0-9-]{32,64}$/i.test(visitorId)) {
        return res.status(400).json({ success: false, error: 'Link affiliate không hợp lệ.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    try {
        const { rows: owners } = await pool.query(
            `SELECT code, username
             FROM public.affiliate_codes
             WHERE code = $1 AND is_current = TRUE`,
            [code]
        );
        if (!owners.length) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy mã affiliate.' });
        }

        await pool.query(
            `INSERT INTO public.affiliate_clicks
                 (code, affiliate_username, visitor_hash, attribution_token_hash, clicked_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (code, visitor_hash, click_day)
             DO UPDATE SET affiliate_username = EXCLUDED.affiliate_username,
                           attribution_token_hash = EXCLUDED.attribution_token_hash,
                           clicked_at = NOW(),
                           token_consumed_at = NULL,
                           referred_username = NULL`,
            [code, owners[0].username, hashShopGoogleValue(visitorId), hashShopGoogleValue(token)]
        );
        return res.json({
            success: true,
            data: {
                code,
                token,
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            }
        });
    } catch (error) {
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        console.error('Track affiliate click error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể ghi nhận lượt truy cập affiliate.' });
    }
});

app.get('/api/user/affiliate/code', requireUserSession, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { rows } = await pool.query(
            `SELECT code, created_at
             FROM public.affiliate_codes
             WHERE LOWER(username) = LOWER($1) AND is_current = TRUE
             LIMIT 1`,
            [req.username]
        );
        return res.json({
            success: true,
            data: rows.length
                ? { code: rows[0].code, createdAt: rows[0].created_at }
                : { code: null, createdAt: null }
        });
    } catch (error) {
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        console.error('Load affiliate code error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tải mã affiliate.' });
    }
});

app.post('/api/user/affiliate/code', requireUserSession, requireActiveUser, async (req, res) => {
    const requestedCode = String(req.body && req.body.code || '').trim().toUpperCase();
    if (requestedCode && !/^[A-Z0-9_-]{4,20}$/.test(requestedCode)) {
        return res.status(400).json({
            success: false,
            error: 'Mã affiliate phải có 4–20 ký tự gồm chữ, số, dấu gạch dưới hoặc gạch ngang.'
        });
    }

    try {
        const current = await pool.query(
            `SELECT code, created_at
             FROM public.affiliate_codes
             WHERE LOWER(username) = LOWER($1) AND is_current = TRUE
             LIMIT 1`,
            [req.username]
        );
        if (current.rows.length) {
            return res.json({
                success: true,
                data: { code: current.rows[0].code, createdAt: current.rows[0].created_at }
            });
        }

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const code = requestedCode || `TYON${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            try {
                const inserted = await pool.query(
                    `INSERT INTO public.affiliate_codes (code, username, is_current)
                     VALUES ($1, $2, TRUE)
                     ON CONFLICT (code) DO NOTHING
                     RETURNING code, created_at`,
                    [code, req.username]
                );
                if (inserted.rows.length) {
                    return res.status(201).json({
                        success: true,
                        data: { code: inserted.rows[0].code, createdAt: inserted.rows[0].created_at }
                    });
                }

                const concurrent = await pool.query(
                    `SELECT code, created_at
                     FROM public.affiliate_codes
                     WHERE LOWER(username) = LOWER($1) AND is_current = TRUE
                     LIMIT 1`,
                    [req.username]
                );
                if (concurrent.rows.length) {
                    return res.json({
                        success: true,
                        data: { code: concurrent.rows[0].code, createdAt: concurrent.rows[0].created_at }
                    });
                }
                if (requestedCode) {
                    return res.status(409).json({ success: false, error: 'Mã affiliate này đã được sử dụng.' });
                }
            } catch (error) {
                if (error.code !== '23505') throw error;
                const concurrent = await pool.query(
                    `SELECT code, created_at
                     FROM public.affiliate_codes
                     WHERE LOWER(username) = LOWER($1) AND is_current = TRUE
                     LIMIT 1`,
                    [req.username]
                );
                if (concurrent.rows.length) {
                    return res.json({
                        success: true,
                        data: { code: concurrent.rows[0].code, createdAt: concurrent.rows[0].created_at }
                    });
                }
                if (requestedCode) {
                    return res.status(409).json({ success: false, error: 'Mã affiliate này đã được sử dụng.' });
                }
            }
        }

        return res.status(503).json({
            success: false,
            error: 'Chưa thể tạo mã affiliate ngẫu nhiên. Vui lòng thử lại.'
        });
    } catch (error) {
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        console.error('Create affiliate code error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tạo mã affiliate.' });
    }
});

app.patch('/api/user/affiliate/code', requireUserSession, requireActiveUser, async (req, res) => {
    const code = String(req.body && req.body.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{4,20}$/.test(code)) {
        return res.status(400).json({
            success: false,
            error: 'Mã affiliate phải có 4–20 ký tự gồm chữ, số, dấu gạch dưới hoặc gạch ngang.'
        });
    }

    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;

        const { rows: currentRows } = await client.query(
            `SELECT code, created_at
             FROM public.affiliate_codes
             WHERE LOWER(username) = LOWER($1) AND is_current = TRUE
             FOR UPDATE`,
            [req.username]
        );
        if (!currentRows.length) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(404).json({ success: false, error: 'Chưa có mã affiliate để đổi.' });
        }

        const currentCode = currentRows[0].code;
        if (currentCode === code) {
            await client.query('COMMIT');
            transactionOpen = false;
            return res.json({ success: true, data: { code, createdAt: currentRows[0].created_at } });
        }

        const { rows: existingRows } = await client.query(
            `SELECT username, is_current, created_at
             FROM public.affiliate_codes
             WHERE code = $1
             FOR UPDATE`,
            [code]
        );
        if (existingRows.length && existingRows[0].username.toLowerCase() !== req.username.toLowerCase()) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(409).json({ success: false, error: 'Mã affiliate này đã được sử dụng.' });
        }

        await client.query(
            `UPDATE public.affiliate_codes
             SET is_current = FALSE
             WHERE LOWER(username) = LOWER($1) AND is_current = TRUE`,
            [req.username]
        );

        if (existingRows.length) {
            await client.query(
                `UPDATE public.affiliate_codes
                 SET is_current = TRUE
                 WHERE code = $1 AND LOWER(username) = LOWER($2)`,
                [code, req.username]
            );
        } else {
            await client.query(
                `INSERT INTO public.affiliate_codes (code, username, is_current)
                 VALUES ($1, $2, TRUE)`,
                [code, req.username]
            );
        }

        const { rows: updatedRows } = await client.query(
            `SELECT code, created_at
             FROM public.affiliate_codes
             WHERE LOWER(username) = LOWER($1) AND is_current = TRUE
             LIMIT 1`,
            [req.username]
        );
        await client.query(
            `UPDATE public.affiliate_clicks
             SET token_consumed_at = NOW()
             WHERE LOWER(affiliate_username) = LOWER($1)
               AND token_consumed_at IS NULL`,
            [req.username]
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return res.json({
            success: true,
            data: { code: updatedRows[0].code, createdAt: updatedRows[0].created_at }
        });
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback affiliate code change failed:', rollbackError.message);
            }
        }
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        if (error.code === '23505') {
            return res.status(409).json({ success: false, error: 'Mã affiliate này đã được sử dụng.' });
        }
        console.error('Change affiliate code error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể đổi mã affiliate.' });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/user/affiliate/dashboard', requireUserSession, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        await pool.query(
            `UPDATE public.affiliate_commissions
             SET status = 'available'
             WHERE LOWER(affiliate_username) = LOWER($1)
               AND status = 'pending'
               AND hold_until <= NOW()`,
            [req.username]
        );

        const [codeResult, statsResult, referralsResult, commissionsResult, payoutsResult] = await Promise.all([
            pool.query(
                `SELECT code, created_at
                 FROM public.affiliate_codes
                 WHERE LOWER(username) = LOWER($1) AND is_current = TRUE
                 LIMIT 1`,
                [req.username]
            ),
            pool.query(
                `SELECT
                    COALESCE((
                        SELECT SUM(GREATEST(c.amount - COALESCE((
                            SELECT SUM(pi.amount)
                            FROM public.affiliate_payout_items pi
                            JOIN public.affiliate_payouts p ON p.id = pi.payout_id
                            WHERE pi.commission_id = c.id
                              AND p.status IN ('pending', 'completed')
                        ), 0), 0))
                        FROM public.affiliate_commissions c
                        WHERE LOWER(c.affiliate_username) = LOWER($1)
                          AND c.status = 'available'
                          AND c.hold_until <= NOW()
                    ), 0)::BIGINT AS available,
                    COALESCE((
                        SELECT SUM(c.amount)
                        FROM public.affiliate_commissions c
                        WHERE LOWER(c.affiliate_username) = LOWER($1)
                          AND c.status = 'pending'
                          AND c.hold_until > NOW()
                    ), 0)::BIGINT AS pending,
                    COALESCE((
                        SELECT SUM(c.amount)
                        FROM public.affiliate_commissions c
                        WHERE LOWER(c.affiliate_username) = LOWER($1)
                          AND c.status <> 'void'
                    ), 0)::BIGINT AS total_commission,
                    COALESCE((
                        SELECT SUM(c.gross_amount)
                        FROM public.affiliate_commissions c
                        WHERE LOWER(c.affiliate_username) = LOWER($1)
                          AND c.status <> 'void'
                    ), 0)::BIGINT AS revenue,
                    COALESCE((
                        SELECT COUNT(*)
                        FROM public.affiliate_commissions c
                        WHERE LOWER(c.affiliate_username) = LOWER($1)
                          AND c.status <> 'void'
                    ), 0)::INTEGER AS order_count,
                    COALESCE((
                        SELECT COUNT(*)
                        FROM public.affiliate_referrals r
                        WHERE LOWER(r.affiliate_username) = LOWER($1)
                    ), 0)::INTEGER AS referral_count,
                    COALESCE((
                        SELECT COUNT(*)
                        FROM public.affiliate_clicks cl
                        WHERE LOWER(cl.affiliate_username) = LOWER($1)
                          AND cl.clicked_at >= NOW() - INTERVAL '30 days'
                    ), 0)::INTEGER AS click_count,
                    COALESCE((
                        SELECT SUM(p.amount)
                        FROM public.affiliate_payouts p
                        WHERE LOWER(p.username) = LOWER($1)
                          AND p.status = 'completed'
                    ), 0)::BIGINT AS withdrawn`,
                [req.username]
            ),
            pool.query(
                `SELECT referred_username AS "referredUsername", created_at AS "createdAt"
                 FROM public.affiliate_referrals
                 WHERE LOWER(affiliate_username) = LOWER($1)
                 ORDER BY created_at DESC
                 LIMIT 100`,
                [req.username]
            ),
            pool.query(
                `SELECT id, referred_username AS "referredUsername", category,
                        gross_amount AS "grossAmount", amount, status,
                        hold_until AS "holdUntil", created_at AS "createdAt"
                 FROM public.affiliate_commissions
                 WHERE LOWER(affiliate_username) = LOWER($1)
                 ORDER BY created_at DESC
                 LIMIT 100`,
                [req.username]
            ),
            pool.query(
                `SELECT id, amount, method, status, created_at AS "createdAt",
                        reviewed_at AS "reviewedAt", review_note AS "reviewNote"
                 FROM public.affiliate_payouts
                 WHERE LOWER(username) = LOWER($1)
                 ORDER BY created_at DESC
                 LIMIT 100`,
                [req.username]
            )
        ]);
        const row = statsResult.rows[0] || {};
        return res.json({
            success: true,
            data: {
                code: codeResult.rows[0]
                    ? { value: codeResult.rows[0].code, createdAt: codeResult.rows[0].created_at }
                    : null,
                stats: {
                    available: Number(row.available) || 0,
                    pending: Number(row.pending) || 0,
                    totalCommission: Number(row.total_commission) || 0,
                    orderCount: Number(row.order_count) || 0,
                    clicks: Number(row.click_count) || 0,
                    referrals: Number(row.referral_count) || 0,
                    revenue: Number(row.revenue) || 0,
                    withdrawn: Number(row.withdrawn) || 0
                },
                referrals: referralsResult.rows,
                orders: commissionsResult.rows,
                withdrawals: payoutsResult.rows
            }
        });
    } catch (error) {
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        console.error('Load affiliate dashboard error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tải dữ liệu Affiliate.' });
    }
});

app.post('/api/user/affiliate/withdrawals', requireUserSession, requireActiveUser, async (req, res) => {
    const body = req.body || {};
    const method = body.method === 'wallet' || body.method === 'bank' ? body.method : '';
    const amountText = String(body.amount == null ? '' : body.amount).trim();
    const amount = /^\d+$/.test(amountText) ? Number(amountText) : NaN;
    if (!method || !Number.isSafeInteger(amount) || amount < 100000) {
        return res.status(400).json({
            success: false,
            error: 'Số tiền rút tối thiểu là 100.000đ.'
        });
    }

    let bankDetails = null;
    if (method === 'bank') {
        const bankName = typeof body.bankName === 'string' ? body.bankName.trim() : '';
        const accountNumber = typeof body.accountNumber === 'string'
            ? body.accountNumber.replace(/\s+/g, '')
            : '';
        const accountHolder = typeof body.accountHolder === 'string'
            ? body.accountHolder.trim().normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[đĐ]/g, 'D')
                .toUpperCase()
                .replace(/\s+/g, ' ')
            : '';
        if (bankName.length < 2 || bankName.length > 100 ||
            !/^\d{6,34}$/.test(accountNumber) ||
            !/^[A-Z0-9 ]{2,100}$/.test(accountHolder)) {
            return res.status(400).json({
                success: false,
                error: 'Vui lòng nhập đúng tên ngân hàng, số tài khoản và tên chủ tài khoản không dấu.'
            });
        }
        bankDetails = { bankName, accountNumber, accountHolder };
    }

    let encryptedBankDetails = null;
    if (bankDetails) {
        try {
            encryptedBankDetails = encryptPartnerApiKey(JSON.stringify(bankDetails));
        } catch (error) {
            console.error('Encrypt affiliate payout details error:', error.message);
            return res.status(503).json({
                success: false,
                error: 'Chưa cấu hình mã hóa thông tin ngân hàng trên máy chủ.'
            });
        }
    }

    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;

        await client.query(
            `UPDATE public.affiliate_commissions
             SET status = 'available'
             WHERE LOWER(affiliate_username) = LOWER($1)
               AND status = 'pending'
               AND hold_until <= NOW()`,
            [req.username]
        );

        const { rows: commissions } = await client.query(
            `SELECT id, amount
             FROM public.affiliate_commissions
             WHERE LOWER(affiliate_username) = LOWER($1)
               AND status = 'available'
               AND hold_until <= NOW()
             ORDER BY created_at, id
             FOR UPDATE`,
            [req.username]
        );
        const commissionIds = commissions.map(item => item.id);
        const allocations = commissionIds.length
            ? await client.query(
                `SELECT pi.commission_id, SUM(pi.amount)::BIGINT AS amount
                 FROM public.affiliate_payout_items pi
                 JOIN public.affiliate_payouts p ON p.id = pi.payout_id
                 WHERE pi.commission_id = ANY($1::BIGINT[])
                   AND p.status IN ('pending', 'completed')
                 GROUP BY pi.commission_id`,
                [commissionIds]
            )
            : { rows: [] };
        const allocatedByCommission = new Map(
            allocations.rows.map(item => [String(item.commission_id), Number(item.amount)])
        );
        const available = commissions.reduce((sum, item) => {
            return sum + Math.max(0, Number(item.amount) - (allocatedByCommission.get(String(item.id)) || 0));
        }, 0);
        if (amount > available) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(400).json({ success: false, error: 'Số dư hoa hồng khả dụng không đủ.' });
        }

        const status = method === 'wallet' ? 'completed' : 'pending';
        const { rows: payoutRows } = await client.query(
            `INSERT INTO public.affiliate_payouts
                 (username, amount, method, status, bank_details_encrypted,
                  bank_details_iv, bank_details_tag, reviewed_at, reviewed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7,
                     CASE WHEN $4 = 'completed' THEN NOW() ELSE NULL END,
                     CASE WHEN $4 = 'completed' THEN 'system' ELSE NULL END)
             RETURNING id, amount, method, status, created_at`,
            [
                req.username,
                amount,
                method,
                status,
                encryptedBankDetails ? encryptedBankDetails.encryptedKey : null,
                encryptedBankDetails ? encryptedBankDetails.iv : null,
                encryptedBankDetails ? encryptedBankDetails.tag : null
            ]
        );
        const payout = payoutRows[0];
        let remaining = amount;
        for (const commission of commissions) {
            if (remaining <= 0) break;
            const commissionId = String(commission.id);
            const freeAmount = Math.max(
                0,
                Number(commission.amount) - (allocatedByCommission.get(commissionId) || 0)
            );
            const allocation = Math.min(remaining, freeAmount);
            if (allocation <= 0) continue;
            await client.query(
                `INSERT INTO public.affiliate_payout_items (payout_id, commission_id, amount)
                 VALUES ($1, $2, $3)`,
                [payout.id, commission.id, allocation]
            );
            remaining -= allocation;
        }
        if (remaining !== 0) throw new Error('Không thể phân bổ chính xác số dư hoa hồng.');

        if (method === 'wallet') {
            const { rows: users } = await client.query(
                `SELECT username, balance, deposit_history
                 FROM public.users
                 WHERE LOWER(username) = LOWER($1)
                 FOR UPDATE`,
                [req.username]
            );
            if (!users.length) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản.' });
            }
            const history = users[0].deposit_history == null
                ? []
                : safeParseJSON(users[0].deposit_history, null);
            if (!Array.isArray(history)) throw new Error('Lịch sử ví không hợp lệ.');
            history.push({
                amount,
                method: 'affiliate',
                content: `Rút hoa hồng Affiliate #${payout.id}`,
                transactionId: `AFFILIATE_WITHDRAW_${payout.id}`,
                at: new Date().toISOString()
            });
            await client.query(
                `UPDATE public.users
                 SET balance = balance + $1, deposit_history = $2
                 WHERE LOWER(username) = LOWER($3)`,
                [amount, JSON.stringify(history), req.username]
            );
        }

        await client.query('COMMIT');
        transactionOpen = false;
        return res.status(201).json({
            success: true,
            data: {
                id: Number(payout.id),
                amount: Number(payout.amount),
                method: payout.method,
                status: payout.status,
                createdAt: payout.created_at
            }
        });
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback affiliate withdrawal failed:', rollbackError.message);
            }
        }
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        console.error('Create affiliate withdrawal error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tạo yêu cầu rút hoa hồng.' });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/admin/affiliate/withdrawals', requireAdminToken, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { rows } = await pool.query(
            `SELECT id, username, amount, method, status,
                    bank_details_encrypted, bank_details_iv, bank_details_tag,
                    created_at, reviewed_at
             FROM public.affiliate_payouts
             WHERE status = 'pending' AND method = 'bank'
             ORDER BY created_at
             LIMIT 100`
        );
        const data = rows.map(row => {
            const bankDetails = JSON.parse(decryptPartnerApiKey({
                encrypted_key: row.bank_details_encrypted,
                encryption_iv: row.bank_details_iv,
                encryption_tag: row.bank_details_tag
            }));
            return {
                id: Number(row.id),
                username: row.username,
                amount: Number(row.amount),
                method: row.method,
                status: row.status,
                bankDetails,
                createdAt: row.created_at
            };
        });
        return res.json({ success: true, data });
    } catch (error) {
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        console.error('Load affiliate withdrawals for admin error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tải yêu cầu rút hoa hồng.' });
    }
});

app.post('/api/admin/affiliate/withdrawals/:id/review', requireAdminToken, async (req, res) => {
    const payoutId = Number(req.params.id);
    const action = req.body && req.body.action;
    const note = typeof (req.body && req.body.note) === 'string' ? req.body.note.trim() : '';
    if (!Number.isSafeInteger(payoutId) || payoutId < 1 ||
        !['paid', 'rejected'].includes(action) || note.length > 1000) {
        return res.status(400).json({ success: false, error: 'Thông tin duyệt yêu cầu không hợp lệ.' });
    }

    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;
        const { rows } = await client.query(
            `SELECT id, status, method
             FROM public.affiliate_payouts
             WHERE id = $1
             FOR UPDATE`,
            [payoutId]
        );
        if (!rows.length) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(404).json({ success: false, error: 'Không tìm thấy yêu cầu rút tiền.' });
        }
        if (rows[0].method !== 'bank' || rows[0].status !== 'pending') {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(409).json({ success: false, error: 'Yêu cầu này không còn chờ duyệt.' });
        }

        const status = action === 'paid' ? 'completed' : 'rejected';
        await client.query(
            `UPDATE public.affiliate_payouts
             SET status = $1, reviewed_at = NOW(), reviewed_by = $2, review_note = $3
             WHERE id = $4`,
            [status, req.admin.username || 'admin', note || null, payoutId]
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return res.json({ success: true, data: { id: payoutId, status } });
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback affiliate withdrawal review failed:', rollbackError.message);
            }
        }
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        console.error('Review affiliate withdrawal error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể cập nhật yêu cầu rút tiền.' });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/user/:username', requireAuthOnly, async (req, res) => {
    try {
        const requestedUsername = req.params.username.trim();
        if (req.username.toLowerCase() !== requestedUsername.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền truy cập' });
        }
        const dbUser = await getUserByUsername(requestedUsername);
        if (!dbUser) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });
        }
        const blueTickExpiresAt = dbUser.blue_tick_expires_at || null;
        const blueTickExpiryTime = blueTickExpiresAt ? new Date(blueTickExpiresAt).getTime() : null;
        res.json({
            success: true,
            user: {
                username: dbUser.username,
                avatar: dbUser.avatar_url || '',
                balance: Number(dbUser.balance) || 0,
                fullName: dbUser.full_name || '',
                email: dbUser.email || '',
                phone: dbUser.phone || '', 
                telegram: dbUser.telegram || '',
                job: dbUser.job || '',  
                hometown: dbUser.hometown || '',  
                status: dbUser.status || 'active',
                kyc_status: dbUser.kyc_status || 'unverified',
                blueTickActive: Boolean(dbUser.blue_tick_active) &&
                    Number.isFinite(blueTickExpiryTime) && blueTickExpiryTime > Date.now(),
                blueTickExpiresAt,
                createdAt: dbUser.created_at,
                lastLoginAt: dbUser.previous_login_at || req.session.created_at || null,
                previousLoginAt: dbUser.previous_login_at || null,
                currentLoginAt: dbUser.last_login_at || req.session.created_at || null,
                depositHistory: safeParseJSON(dbUser.deposit_history),
                purchaseHistory: safeParseJSON(dbUser.purchase_history)
            }
        });
    } catch (err) {
        console.error('Lỗi API Get User:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.get('/api/user/:username/tier', requireUserSession, async (req, res) => {
    try {
        if (req.username.toLowerCase() !== req.params.username.trim().toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền' });
        }

        const dbUser = await getUserByUsername(req.params.username);
        if (!dbUser) return res.status(404).json({ success: false, error: 'User not found' });
        const depositHistory = safeParseJSON(dbUser.deposit_history);
        const totalDeposit = depositHistory.reduce((sum, item) => {
            if (item.method === 'refund_rejected_order' || item.method === 'admin_refund') return sum;
            return sum + (Number(item.amount) || 0);
        }, 0);
        let tier = 'Member';
        let nextTier = 'Silver';
        let amountToNext = 500000 - totalDeposit;

        if (totalDeposit >= 10000000) {
            tier = 'Diamond';
            nextTier = 'Max';
            amountToNext = 0;
        } else if (totalDeposit >= 2000000) {
            tier = 'Gold';
            nextTier = 'Diamond';
            amountToNext = 10000000 - totalDeposit;
        } else if (totalDeposit >= 500000) {
            tier = 'Silver';
            nextTier = 'Gold';
            amountToNext = 2000000 - totalDeposit;
        }

        res.json({
            success: true,
            totalDeposit,
            currentTier: tier,
            nextTier: nextTier,
            amountToNext: amountToNext > 0 ? amountToNext : 0
        });
    } catch (err) {
        console.error('Lỗi lấy cấp bậc:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.get('/api/user/:username/statistics', requireUserSession, async (req, res) => {
    try {
        const requestedUsername = req.params.username.trim();
        if (req.username.toLowerCase() !== requestedUsername.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền' });
        }

        const dbUser = await getUserByUsername(requestedUsername);
        if (!dbUser) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });

        return res.json({
            success: true,
            data: buildUserStatistics(dbUser, req.session.created_at)
        });
    } catch (err) {
        console.error('Lỗi lấy thống kê người dùng:', err);
        return res.status(500).json({ success: false, error: 'Không thể tải thống kê người dùng.' });
    }
});

const BLUE_TICK_INTRO_PRICE = 149000;
const BLUE_TICK_RENEWAL_PRICE = 399000;
const BLUE_TICK_TERM_DAYS = 30;

function hasPreviouslyPurchasedBlueTick(user, purchaseHistory) {
    return Boolean(user.blue_tick_active || user.blue_tick_activated_at) ||
        purchaseHistory.some(item =>
            item && (
                ['blue-tick', 'tick-xanh'].includes(String(item.productId || '').toLowerCase()) ||
                /tick\s*xanh|blue\s*tick/i.test(String(item.productName || ''))
            )
        );
}

app.get('/api/user/:username/tick-xanh', requireUserSession, async (req, res) => {
    try {
        const requestedUsername = req.params.username.trim();
        if (req.username.toLowerCase() !== requestedUsername.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền' });
        }

        const dbUser = await getUserByUsername(requestedUsername);
        if (!dbUser) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });
        const purchaseHistory = dbUser.purchase_history == null
            ? []
            : safeParseJSON(dbUser.purchase_history, null);
        if (!Array.isArray(purchaseHistory)) {
            throw new Error('Lịch sử mua Tick xanh không hợp lệ.');
        }
        const expiresAt = dbUser.blue_tick_expires_at || null;
        const expiryTime = expiresAt ? new Date(expiresAt).getTime() : null;
        const firstPurchase = !hasPreviouslyPurchasedBlueTick(dbUser, purchaseHistory);
        return res.json({
            success: true,
            data: {
                active: Boolean(dbUser.blue_tick_active) &&
                    Number.isFinite(expiryTime) && expiryTime > Date.now(),
                activatedAt: dbUser.blue_tick_activated_at || null,
                expiresAt,
                firstPurchase,
                price: firstPurchase ? BLUE_TICK_INTRO_PRICE : BLUE_TICK_RENEWAL_PRICE
            }
        });
    } catch (err) {
        console.error('Lỗi lấy trạng thái Tick Xanh:', err);
        return res.status(500).json({ success: false, error: 'Không thể tải trạng thái Tick Xanh.' });
    }
});

app.post('/api/user/blue-tick/purchase', requireUserSession, requireActiveUser, async (req, res) => {
    const termMs = BLUE_TICK_TERM_DAYS * 24 * 60 * 60 * 1000;
    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT username, balance, purchase_history, blue_tick_active,
                    blue_tick_activated_at, blue_tick_expires_at
             FROM users
             WHERE LOWER(username) = LOWER($1)
             FOR UPDATE`,
            [req.username]
        );
        if (!rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
        }

        const dbUser = rows[0];
        const purchaseHistory = dbUser.purchase_history == null
            ? []
            : safeParseJSON(dbUser.purchase_history, null);
        if (!Array.isArray(purchaseHistory)) {
            throw new Error('Lịch sử mua hàng không hợp lệ.');
        }
        const firstPurchase = !hasPreviouslyPurchasedBlueTick(dbUser, purchaseHistory);
        const price = firstPurchase ? BLUE_TICK_INTRO_PRICE : BLUE_TICK_RENEWAL_PRICE;
        const balance = Number(dbUser.balance);
        if (!Number.isFinite(balance) || balance < price) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                error: `Số dư không đủ để mua Tick xanh. Cần ${price.toLocaleString('vi-VN')} đ.`,
                data: { balance: Number.isFinite(balance) ? balance : 0, price }
            });
        }

        const now = new Date();
        const currentExpiry = dbUser.blue_tick_expires_at
            ? new Date(dbUser.blue_tick_expires_at).getTime()
            : NaN;
        const hasCurrentTerm = Number.isFinite(currentExpiry) && currentExpiry > now.getTime();
        const startTime = hasCurrentTerm ? currentExpiry : now.getTime();
        const expiresAt = new Date(startTime + termMs);
        const activatedAt = hasCurrentTerm && dbUser.blue_tick_activated_at
            ? dbUser.blue_tick_activated_at
            : now;
        const purchasedAt = now.toISOString();
        const purchaseId = crypto.randomBytes(16).toString('hex');
        const newPurchase = {
            purchaseId,
            productId: 'blue-tick',
            productName: 'Tick xanh tài khoản (30 ngày)',
            price,
            purchasedAt,
            expiresAt: expiresAt.toISOString()
        };
        const updatedHistory = [...purchaseHistory, newPurchase];

        const updated = await client.query(
            `UPDATE users
             SET balance = balance - $1,
                 purchase_history = $2,
                 blue_tick_active = TRUE,
                 blue_tick_activated_at = $3,
                 blue_tick_expires_at = $4
             WHERE LOWER(username) = LOWER($5)
             RETURNING balance`,
            [price, JSON.stringify(updatedHistory), activatedAt, expiresAt, dbUser.username]
        );
        if (!updated.rows.length) {
            throw new Error('Không thể cập nhật giao dịch Tick xanh.');
        }

        await recordAffiliateCommission(client, {
            buyerUsername: dbUser.username,
            sourceOrderId: `blue-tick:${purchaseId}`,
            category: 'blue_tick',
            grossAmount: price
        });

        await client.query('COMMIT');
        return res.json({
            success: true,
            data: {
                balance: Number(updated.rows[0].balance),
                active: true,
                activatedAt,
                expiresAt: expiresAt.toISOString(),
                price,
                firstPurchase,
                nextPrice: BLUE_TICK_RENEWAL_PRICE
            }
        });
    } catch (error) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Không thể hoàn tác giao dịch Tick xanh:', rollbackError);
            }
        }
        if (isAffiliateSchemaError(error)) return affiliateMigrationResponse(res);
        console.error('Không thể mua Tick xanh:', error);
        return res.status(500).json({ success: false, error: 'Không thể xử lý giao dịch Tick xanh.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/change-password', requireUserSession, async (req, res) => {
    try {
        const { username, oldPassword, newPassword } = req.body;
        if (!username || !oldPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ thông tin' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
        }
        if (req.username.toLowerCase() !== username.trim().toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền' });
        }

        const dbUser = await getUserByUsername(username);
        if (!dbUser) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });

        let oldMatch = false;
        if (dbUser.password && dbUser.password.startsWith('$2')) {
            oldMatch = await bcrypt.compare(oldPassword, dbUser.password);
        } else {
            oldMatch = oldPassword.trim() === (dbUser.password || '').trim();
        }
        if (!oldMatch) return res.status(400).json({ success: false, error: 'Mật khẩu cũ không chính xác' });

        const newHashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await pool.query(
            'UPDATE users SET password = $1 WHERE LOWER(username) = LOWER($2)',
            [newHashed, username.trim()]
        );

        await pool.query('DELETE FROM sessions WHERE LOWER(username) = LOWER($1)', [username.trim()]);

        res.json({ success: true, message: 'Đổi mật khẩu thành công! Vui lòng đăng nhập lại.' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/user/submit-kyc', requireUserSession, async (req, res) => {
    try {
        const { username, fullName, idNumber, frontImage, backImage } = req.body;

        if (req.username.toLowerCase() !== (username || '').toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền' });
        }
        if (!fullName || !idNumber || !frontImage || !backImage) {
            return res.status(400).json({ success: false, error: 'Vui lòng cung cấp đủ thông tin và ảnh' });
        }
        const isValidImageBase64 = (str) => {
            if (typeof str !== 'string') return false;
            if (!str.startsWith('data:image/')) return false;
            if (str.length > 5 * 1024 * 1024) return false; 
            return true;
        };

        if (!isValidImageBase64(frontImage)) {
            return res.status(400).json({ success: false, error: 'Ảnh mặt trước không hợp lệ' });
        }
        if (!isValidImageBase64(backImage)) {
            return res.status(400).json({ success: false, error: 'Ảnh mặt sau không hợp lệ' });
        }
        await pool.query(`
            UPDATE users
            SET kyc_status = 'pending',
                kyc_full_name = $1, kyc_id_number = $2,
                kyc_front_image = $3, kyc_back_image = $4,
                kyc_submitted_at = NOW()
            WHERE username = $5
        `, [fullName, idNumber, frontImage, backImage, username]);

        res.json({ success: true, message: 'Đã gửi yêu cầu KYC, vui lòng chờ duyệt.' });
    } catch (err) {
        console.error('Submit KYC error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/user/update-avatar', requireUserSession, async (req, res) => {
    try {
        const { username, avatarBase64 } = req.body;
        
        if (req.username.toLowerCase() !== username.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền' });
        }
        if (!avatarBase64 || !avatarBase64.startsWith('data:image/')) {
            return res.status(400).json({ success: false, error: 'Ảnh không hợp lệ' });
        }
        if (avatarBase64.length > 2.5 * 1024 * 1024) {
            return res.status(400).json({ success: false, error: 'Ảnh quá lớn (tối đa 2MB)' });
        }

        await pool.query('UPDATE users SET avatar_url = $1 WHERE LOWER(username) = LOWER($2)', [avatarBase64, username]);
        res.json({ success: true, message: 'Cập nhật ảnh đại diện thành công!' });
    } catch (err) {
        console.error('Update avatar error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/heartbeat', requireUserSession, (req, res) => {
    res.json({ success: true, lastActivity: new Date().toISOString() });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 30: GOOGLE OAUTH CALLBACK
   ═══════════════════════════════════════════════════════════════════════════ */

async function createGoogleUserSession(queryable, { email, fullName, picture, rememberMe = false }) {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = typeof fullName === 'string' && fullName.trim()
        ? fullName.trim()
        : normalizedEmail.split('@')[0];

    let { rows } = await queryable.query(
        'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1 FOR UPDATE',
        [normalizedEmail]
    );
    let dbUser = rows[0] || null;

    if (!dbUser) {
        const emailPrefix = normalizedEmail.split('@')[0]
            .replace(/[^a-zA-Z0-9_]/g, '')
            .slice(0, 20);
        const baseUsername = emailPrefix.length >= 4 ? emailPrefix : `google_${emailPrefix || 'user'}`;

        for (let attempt = 0; attempt < 8 && !dbUser; attempt++) {
            const username = attempt === 0
                ? baseUsername
                : `${baseUsername.slice(0, 20)}_${crypto.randomBytes(3).toString('hex')}`;
            const inserted = await queryable.query(
                `INSERT INTO users
                    (username, password, full_name, email, balance, purchase_history, deposit_history, avatar_url, created_at)
                 VALUES ($1, '', $2, $3, 0, $4, $4, $5, NOW())
                 ON CONFLICT DO NOTHING
                 RETURNING *`,
                [username, normalizedName, normalizedEmail, JSON.stringify([]), picture || null]
            );
            dbUser = inserted.rows[0] || null;

            if (!dbUser) {
                const existing = await queryable.query(
                    'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1 FOR UPDATE',
                    [normalizedEmail]
                );
                dbUser = existing.rows[0] || null;
            }
        }
    }

    if (dbUser && !dbUser.avatar_url && picture) {
        await queryable.query(
            'UPDATE users SET avatar_url = $1 WHERE username = $2',
            [picture, dbUser.username]
        );
        dbUser.avatar_url = picture;
    }

    if (!dbUser) throw new Error('Could not create or locate the Google user.');

    const loginTimestamps = await queryable.query(
        `UPDATE users
         SET previous_login_at = last_login_at, last_login_at = NOW()
         WHERE username = $1
         RETURNING previous_login_at, last_login_at`,
        [dbUser.username]
    );
    dbUser.previous_login_at = loginTimestamps.rows[0].previous_login_at;
    dbUser.last_login_at = loginTimestamps.rows[0].last_login_at;

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (
        rememberMe ? 30 * 24 * 60 * 60 * 1000 : SESSION_ABSOLUTE_TIMEOUT_MS
    ));

    await queryable.query('DELETE FROM sessions WHERE username = $1', [dbUser.username]);
    await queryable.query(
        `INSERT INTO sessions (username, token, last_activity, created_at, expires_at)
         VALUES ($1, $2, NOW(), NOW(), $3)`,
        [dbUser.username, sessionToken, expiresAt]
    );

    return {
        success: true,
        user: {
            username: dbUser.username,
            fullName: dbUser.full_name,
            email: dbUser.email || normalizedEmail,
            balance: Number(dbUser.balance),
            status: dbUser.status || 'active',
            depositHistory: safeParseJSON(dbUser.deposit_history),
            purchaseHistory: safeParseJSON(dbUser.purchase_history),
            avatar: dbUser.avatar_url || null
        },
        sessionToken,
        expiresAt: expiresAt.toISOString()
    };
}

app.post('/api/shop-auth/google/challenge', shopGoogleChallengeLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!shopGoogleClient || !SHOP_GOOGLE_CLIENT_ID) {
        return res.status(503).json({ success: false, error: 'Đăng nhập Google chưa được cấu hình.' });
    }

    const challengeId = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SHOP_GOOGLE_CHALLENGE_TTL_MS);

    try {
        await pool.query(
            `DELETE FROM public.google_login_challenges
             WHERE expires_at <= NOW()
                OR consumed_at <= NOW() - INTERVAL '1 day'`
        );
        await pool.query(
            `INSERT INTO public.google_login_challenges
                (challenge_id_hash, nonce_hash, expires_at)
             VALUES ($1, $2, $3)`,
            [hashShopGoogleValue(challengeId), hashShopGoogleValue(nonce), expiresAt]
        );
        return res.json({
            success: true,
            challengeId,
            nonce,
            expiresAt: expiresAt.toISOString()
        });
    } catch (error) {
        console.error('Shop Google challenge error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể khởi tạo đăng nhập Google.' });
    }
});

app.post('/api/shop-auth/google/login', shopGoogleLoginLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!shopGoogleClient || !SHOP_GOOGLE_CLIENT_ID) {
        return res.status(503).json({ success: false, error: 'Đăng nhập Google chưa được cấu hình.' });
    }

    const { credential, challengeId, rememberMe } = req.body || {};
    if (typeof credential !== 'string' || credential.length > 10000 ||
        typeof challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(challengeId)) {
        return res.status(400).json({ success: false, error: 'Yêu cầu đăng nhập Google không hợp lệ.' });
    }

    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;

        const challengeHash = hashShopGoogleValue(challengeId);
        const { rows: challenges } = await client.query(
            `SELECT nonce_hash
             FROM public.google_login_challenges
             WHERE challenge_id_hash = $1
               AND consumed_at IS NULL
               AND expires_at > NOW()
             FOR UPDATE`,
            [challengeHash]
        );
        if (!challenges.length) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(401).json({
                success: false,
                error: 'Yêu cầu đăng nhập Google đã hết hạn. Vui lòng thử lại.'
            });
        }

        let payload;
        try {
            const ticket = await shopGoogleClient.verifyIdToken({
                idToken: credential,
                audience: SHOP_GOOGLE_CLIENT_ID
            });
            payload = ticket.getPayload();
        } catch {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(401).json({ success: false, error: 'Không xác thực được tài khoản Google.' });
        }

        const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
        if (typeof payload?.sub !== 'string' || payload.email_verified !== true || !isValidEmail(email) ||
            typeof payload.nonce !== 'string' ||
            !timingSafeHashEquals(challenges[0].nonce_hash, hashShopGoogleValue(payload.nonce))) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(401).json({
                success: false,
                error: 'Thông tin xác thực Google không hợp lệ hoặc đã hết hạn.'
            });
        }

        const { rowCount } = await client.query(
            `UPDATE public.google_login_challenges
             SET consumed_at = NOW()
             WHERE challenge_id_hash = $1
               AND consumed_at IS NULL
               AND expires_at > NOW()`,
            [challengeHash]
        );
        if (rowCount !== 1) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(401).json({
                success: false,
                error: 'Yêu cầu đăng nhập Google đã được sử dụng. Vui lòng thử lại.'
            });
        }

        const result = await createGoogleUserSession(client, {
            email,
            fullName: payload.name,
            picture: typeof payload.picture === 'string' ? payload.picture : null,
            rememberMe: rememberMe === true
        });
        await client.query('COMMIT');
        transactionOpen = false;
        return res.json(result);
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Shop Google login rollback error:', rollbackError.message);
            }
        }
        console.error('Shop Google login error:', error.message);
        return res.status(500).json({ success: false, error: 'Đăng nhập Google thất bại. Vui lòng thử lại.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/shop-auth/google/code-login', shopGoogleLoginLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    if (!origin || !CORS_ALLOWED_ORIGIN_SET.has(origin) ||
        req.get('X-Requested-With') !== 'XmlHttpRequest') {
        return res.status(403).json({ success: false, error: 'Yêu cầu đăng nhập Google không hợp lệ.' });
    }
    if (!shopGoogleClient || !SHOP_GOOGLE_CLIENT_ID || !SHOP_GOOGLE_CLIENT_SECRET) {
        return res.status(503).json({
            success: false,
            error: 'Đăng nhập Google chưa được cấu hình đầy đủ trên máy chủ.'
        });
    }

    const { code, challengeId, state, rememberMe } = req.body || {};
    if (typeof code !== 'string' || !code || code.length > 4096 ||
        typeof challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(challengeId) ||
        state !== challengeId || typeof rememberMe !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Yêu cầu đăng nhập Google không hợp lệ.' });
    }

    const challengeHash = hashShopGoogleValue(challengeId);
    let client;
    let transactionOpen = false;
    try {
        const { rows: pendingChallenges } = await pool.query(
            `SELECT challenge_id_hash
             FROM public.google_login_challenges
             WHERE challenge_id_hash = $1
               AND consumed_at IS NULL
               AND expires_at > NOW()`,
            [challengeHash]
        );
        if (!pendingChallenges.length) {
            return res.status(401).json({
                success: false,
                error: 'Yêu cầu đăng nhập Google đã hết hạn. Vui lòng thử lại.'
            });
        }

        const controller = new AbortController();
        const tokenTimeout = setTimeout(() => controller.abort(), 15000);
        let tokenResponse;
        let tokenData;
        try {
            tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code,
                    client_id: SHOP_GOOGLE_CLIENT_ID,
                    client_secret: SHOP_GOOGLE_CLIENT_SECRET,
                    redirect_uri: origin,
                    grant_type: 'authorization_code'
                }),
                signal: controller.signal
            });
            tokenData = await tokenResponse.json();
        } finally {
            clearTimeout(tokenTimeout);
        }

        if (!tokenResponse.ok || typeof tokenData?.id_token !== 'string') {
            console.warn('Shop Google code exchange rejected:', tokenData?.error || tokenResponse.status);
            return res.status(401).json({
                success: false,
                error: 'Google không xác thực được tài khoản. Vui lòng thử lại.'
            });
        }

        let payload;
        try {
            const ticket = await shopGoogleClient.verifyIdToken({
                idToken: tokenData.id_token,
                audience: SHOP_GOOGLE_CLIENT_ID
            });
            payload = ticket.getPayload();
        } catch {
            return res.status(401).json({ success: false, error: 'Không xác thực được tài khoản Google.' });
        }

        const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
        if (typeof payload?.sub !== 'string' || payload.email_verified !== true || !isValidEmail(email)) {
            return res.status(401).json({
                success: false,
                error: 'Thông tin xác thực Google không hợp lệ.'
            });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;

        const { rows: challenges } = await client.query(
            `SELECT challenge_id_hash
             FROM public.google_login_challenges
             WHERE challenge_id_hash = $1
               AND consumed_at IS NULL
               AND expires_at > NOW()
             FOR UPDATE`,
            [challengeHash]
        );
        if (!challenges.length) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(401).json({
                success: false,
                error: 'Yêu cầu đăng nhập Google đã hết hạn. Vui lòng thử lại.'
            });
        }

        const { rowCount } = await client.query(
            `UPDATE public.google_login_challenges
             SET consumed_at = NOW()
             WHERE challenge_id_hash = $1
               AND consumed_at IS NULL
               AND expires_at > NOW()`,
            [challengeHash]
        );
        if (rowCount !== 1) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(401).json({
                success: false,
                error: 'Yêu cầu đăng nhập Google đã được sử dụng. Vui lòng thử lại.'
            });
        }

        const result = await createGoogleUserSession(client, {
            email,
            fullName: payload.name,
            picture: typeof payload.picture === 'string' ? payload.picture : null,
            rememberMe
        });
        await client.query('COMMIT');
        transactionOpen = false;
        return res.json(result);
    } catch (error) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Shop Google code login rollback error:', rollbackError.message);
            }
        }
        console.error('Shop Google code login error:', error.message);
        return res.status(500).json({ success: false, error: 'Đăng nhập Google thất bại. Vui lòng thử lại.' });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect(`${FRONTEND_URL}?error=GoogleAuthFailed`);

    try {
        const baseUrl = process.env.BASE_URL || 'https://buyoptimizertyoncao.onrender.com';
        const redirectUri = `${baseUrl}/api/auth/google/callback`;
        
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });
        const tokenData = await tokenRes.json();

        if (tokenData.error) throw new Error(tokenData.error_description);
        
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const googleUser = await userRes.json();
        const email = (googleUser.email || '').toLowerCase();
        const fullName = googleUser.name || email.split('@')[0];

        const tempToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        await pool.query(
            `INSERT INTO google_temp_tokens (token, email, full_name, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [tempToken, email, fullName, expiresAt]
        );
        
        res.redirect(`${FRONTEND_URL}/?google_token=${tempToken}`);
    } catch (err) {
        console.error('Google callback error:', err);
        res.redirect(`${FRONTEND_URL}?error=GoogleAuthFailed`);
    }
});

app.post('/api/user/google-me', async (req, res) => {
    try {
        const { token } = req.body || {};
        if (!token) return res.status(400).json({ success: false, error: 'Thiếu token' });
        
        const { rows: tempRows } = await pool.query(
            'SELECT * FROM google_temp_tokens WHERE token = $1 AND expires_at > NOW()',
            [token]
        );

        if (tempRows.length === 0) {
            return res.status(401).json({ success: false, error: 'Token Google không hợp lệ hoặc đã hết hạn' });
        }
        const { email, full_name: fullName, picture } = tempRows[0];
        const { rowCount } = await pool.query(
            'DELETE FROM google_temp_tokens WHERE token = $1 AND expires_at > NOW()',
            [token]
        );
        if (rowCount !== 1) {
            return res.status(401).json({ success: false, error: 'Token Google đã được sử dụng hoặc hết hạn' });
        }

        const result = await createGoogleUserSession(pool, { email, fullName, picture });
        return res.json(result);
    } catch (err) {
        console.error('Google login error:', err);
        return res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 31: PAYMENT GATEWAYS (SePay)
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/sepay-create-order', requireUserSession, requireActiveUser, async (req, res) => {
    try {
        const amount = Number(req.body && req.body.amount);
        if (!Number.isSafeInteger(amount) || amount < 10000 || amount > 50000000) {
            return res.status(400).json({ success: false, error: 'Số tiền phải từ 10.000đ đến 50.000.000đ.' });
        }
        if (!SEPAY_CONFIGURED) {
            return res.status(503).json({ success: false, error: 'Thông tin tài khoản SePay chưa được cấu hình đầy đủ.' });
        }
        const orderCode = `NAP${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        const { rows } = await pool.query(
            `INSERT INTO payment_intents (gateway, order_code, username, amount, status, expires_at)
             VALUES ('sepay', $1, $2, $3, 'pending', NOW() + INTERVAL '30 minutes')
             RETURNING expires_at`,
            [orderCode, req.username, amount]
        );
        const qrUrl = `https://img.vietqr.io/image/${encodeURIComponent(SEPAY_BANK_CODE)}-${encodeURIComponent(SEPAY_BANK_ACCOUNT)}-qr_only.png?amount=${amount}&addInfo=${encodeURIComponent(orderCode)}&accountName=${encodeURIComponent(SEPAY_ACCOUNT_HOLDER)}`;
        return res.json({
            success: true,
            orderCode,
            amount,
            qrUrl,
            expiresAt: rows[0].expires_at,
            bankInfo: { bankCode: SEPAY_BANK_CODE, accountNumber: SEPAY_BANK_ACCOUNT, accountHolder: SEPAY_ACCOUNT_HOLDER }
        });
    } catch (error) {
        console.error('SePay create order error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tạo lệnh nạp SePay.' });
    }
});

app.get('/api/user/deposit-intents', requireUserSession, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT order_code, amount,
                    CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS status,
                    expires_at, paid_at
             FROM payment_intents
             WHERE gateway = 'sepay' AND LOWER(username) = LOWER($1)
               AND status IN ('pending', 'review')
             ORDER BY id DESC
             LIMIT 10`,
            [req.username]
        );
        return res.json({ success: true, deposits: rows });
    } catch (error) {
        console.error('Deposit intents error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tải các lệnh nạp đang chờ.' });
    }
});

app.get('/api/user/deposit-intents/:orderCode', requireUserSession, async (req, res) => {
    try {
        const orderCode = String(req.params.orderCode || '').trim().toUpperCase();
        const { rows } = await pool.query(
            `SELECT order_code, amount,
                    CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS status,
                    expires_at, paid_at
             FROM payment_intents
             WHERE gateway = 'sepay' AND order_code = $1 AND LOWER(username) = LOWER($2)`,
            [orderCode, req.username]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Không tìm thấy lệnh nạp.' });
        return res.json({ success: true, deposit: rows[0] });
    } catch (error) {
        console.error('Deposit status error:', error.message);
        return res.status(500).json({ success: false, error: 'Không thể tải trạng thái lệnh nạp.' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 32: BUY PRODUCT & DOWNLOAD
   ═══════════════════════════════════════════════════════════════════════════ */

const TYON_SHOP_PRODUCT_PRICES = Object.freeze({
    1: 0, 35: 850000, 34: 750000, 32: 650000, 14: 550000, 33: 500000,
    6: 450000, 5: 350000, 4: 250000, 3: 150000, 2: 100000, 15: 125000,
    16: 125000, 10: 50000, 20: 275000, 28: 120000, 31: 50000,
    17: 140000, 21: 50000, 18: 15000, 19: 75000, 12: 25000,
    13: 45000, 29: 80000, 30: 40000, 25: 75000, 26: 450000,
    27: 450000, 22: 250000, 23: 150000, 24: 350000
});

app.post('/api/buy-product', requireUserSession, requireActiveUser, async (req, res) => {
    const productId = String(req.body && req.body.productId);
    const numericPrice = TYON_SHOP_PRODUCT_PRICES[productId];
    const productName = typeof (req.body && req.body.productName) === 'string'
        ? req.body.productName.trim()
        : '';
    if (!Object.prototype.hasOwnProperty.call(TYON_SHOP_PRODUCT_PRICES, productId) ||
        !productName) {
        return res.status(400).json({ success: false, error: 'Sản phẩm không hợp lệ.' });
    }

    let client;
    let transactionOpen = false;
    try {
        const requestedUsername = String(req.body && req.body.username || '').trim();
        if (!requestedUsername ||
            req.username.toLowerCase() !== requestedUsername.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền thực hiện giao dịch này' });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;

        const { rows: users } = await client.query(
            `SELECT username, balance, purchase_history, email, full_name
             FROM users
             WHERE LOWER(username) = LOWER($1)
             FOR UPDATE`,
            [req.username]
        );
        const dbUser = users[0];
        if (!dbUser) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });
        }
        const purchaseHistory = safeParseJSON(dbUser.purchase_history);

        if (!Array.isArray(purchaseHistory)) {
            throw new Error('Lịch sử mua hàng không hợp lệ.');
        }
        if (purchaseHistory.some(p => String(p.productId) === productId)) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(400).json({ success: false, error: 'Bạn đã sở hữu sản phẩm này rồi!' });
        }

        const now = new Date().toISOString();
        const purchaseId = crypto.randomBytes(16).toString('hex');
        const newPurchase = {
            purchaseId,
            productId,
            productName,
            price: numericPrice,
            purchasedAt: now
        };
        const updatedHistory = [...purchaseHistory, newPurchase];

        const { rows: updatedUsers } = await client.query(
            `UPDATE users
             SET balance = balance - $1, purchase_history = $2
             WHERE LOWER(username) = LOWER($3) AND balance >= $1
             RETURNING balance`,
            [numericPrice, JSON.stringify(updatedHistory), dbUser.username]
        );

        if (!updatedUsers.length) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(400).json({ success: false, error: 'Số dư không đủ để thanh toán' });
        }

        await recordAffiliateCommission(client, {
            buyerUsername: dbUser.username,
            sourceOrderId: `tyon-shop:${purchaseId}`,
            category: 'tyon_shop',
            grossAmount: numericPrice
        });
        await client.query('COMMIT');
        transactionOpen = false;
        const newBalance = Number(updatedUsers[0].balance);

        if (dbUser.email) {
            const orderInfo = {
                orderCode: `TYON${purchaseId.slice(0, 12).toUpperCase()}`,
                customerName: dbUser.full_name || dbUser.username,
                planName: productName,
                amount: numericPrice,
                paidAt: now,
                transactionId: `BALANCE_${purchaseId}`,
                key: `TYON-KEY-${purchaseId.slice(-6).toUpperCase()}`
            };

            queueEmail(
                dbUser.email, 
                'Hóa đơn mua hàng thành công - TyonCao Shop',
                emailTemplates.purchaseInvoice(orderInfo)
            ).catch(err => console.error('Lỗi gửi mail hóa đơn:', err));
        }
        return res.json({
            success: true,
            message: 'Thanh toán thành công',
            newBalance,
            productId: Number(productId),
            purchasedAt: now
        });

    } catch (err) {
        if (client && transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Buy product rollback error:', rollbackError.message);
            }
        }
        if (isAffiliateSchemaError(err)) return affiliateMigrationResponse(res);
        console.error('Buy product error:', err);
        if (err.code === '23514') {
            return res.status(400).json({ success: false, error: 'Số dư không đủ (ràng buộc dữ liệu)' });
        }
        return res.status(500).json({ success: false, error: 'Lỗi server, vui lòng thử lại sau' });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/download/:productId', requireUserSession, requireActiveUser, async (req, res) => {
    const productId = String(req.params.productId || '').trim();
    const username = req.username;

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(productId)) {
        return res.status(400).send('Mã sản phẩm không hợp lệ.');
    }

    try {
        const dbUser = await getUserByUsername(username);
        if (!dbUser) return res.status(404).send('Không tìm thấy user');

        const purchaseHistory = safeParseJSON(dbUser.purchase_history);
        const ownedIds = new Set(purchaseHistory.map(p => String(p.productId)));
        if (!ownedIds.has(productId)) {
            return res.status(403).send('Chưa mua sản phẩm.');
        }

        const listCommand = new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME });
        const listResponse = await s3Client.send(listCommand);
        const allR2Files = (listResponse.Contents || []).map(item => item.Key);
        const foundFileName = allR2Files.find(f => f.startsWith(`${productId}.`));
        if (!foundFileName) return res.status(404).send('File không tồn tại trên hệ thống lưu trữ.');

        const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: foundFileName });
        const r2Response = await s3Client.send(command);
        if (!r2Response.Body) return res.status(500).send('File rỗng hoặc không đọc được.');
        const bodyBuffer = await streamToBuffer(r2Response.Body);

        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment(`TYON_Product_${productId}.zip`);
        archive.pipe(res);
        archive.on('error', (err) => {
            console.error('Lỗi nén file:', err);
            if (!res.headersSent) res.status(500).send('Lỗi nén file');
        });
        archive.append(bodyBuffer, { name: `TYON_${foundFileName}` });
        await archive.finalize();
    } catch (err) {
        console.error('Lỗi tải file từ R2:', err);
        if (!res.headersSent) res.status(500).send('Lỗi kết nối server.');
    }
});

app.get('/api/download-all', requireUserSession, requireActiveUser, async (req, res) => {
    const { ids } = req.query;
    const username = req.username;

    try {
        const dbUser = await getUserByUsername(username);
        if (!dbUser) return res.status(404).send('Không tìm thấy user');

        const purchaseHistory = safeParseJSON(dbUser.purchase_history);
        let targetIds;
        if (ids) {
            const requestedIds = String(ids).split(',').map(s => s.trim()).filter(Boolean);
            const ownedIds = new Set(purchaseHistory.map(p => String(p.productId)));
            targetIds = requestedIds.filter(id => ownedIds.has(String(id)));    
        } else {
            targetIds = [...new Set(purchaseHistory.map(p => String(p.productId)))];
        }

        if (targetIds.length === 0) return res.status(403).send('Không có file nào để tải.');

        const listCommand = new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME });
        const listResponse = await s3Client.send(listCommand);
        const allR2Files = (listResponse.Contents || []).map(item => item.Key);

        const filesData = [];
        for (const id of targetIds) {
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) continue;
            const foundFileName = allR2Files.find(f => f.startsWith(`${id}.`));
            if (!foundFileName) continue;
            try {
                const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: foundFileName });
                const r2Response = await s3Client.send(command);
                if (r2Response.Body) {
                    const buf = await streamToBuffer(r2Response.Body);
                    filesData.push({ fileName: foundFileName, buffer: buf });
                }
            } catch (err) {
                console.log(`Lỗi tải file ${foundFileName} từ R2:`, err.message);
            }
        }

        if (filesData.length === 0) return res.status(404).send('Không tìm thấy file nào trên hệ thống lưu trữ.');

        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment(`TYON_Files_${username}_${Date.now()}.zip`);
        archive.pipe(res);
        archive.on('error', (err) => {
            console.error('Lỗi nén file:', err);
            if (!res.headersSent) res.status(500).send('Lỗi nén file');
        });
        for (const { fileName, buffer } of filesData) {
            archive.append(buffer, { name: `TYON_${fileName}` });
        }
        await archive.finalize();
    } catch (error) {
        console.error('Lỗi hệ thống khi tải file:', error);
        if (!res.headersSent) res.status(500).send('Lỗi kết nối server.');
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 33: ADMIN USERS
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/admin/users', requireAdminToken, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
        const users = rows.map(u => ({
            username: u.username,
            fullName: u.full_name,
            email: u.email || '',
            balance: Number(u.balance),
            avatar: u.avatar_url || '',
            status: u.status || 'active',
            purchase_history: safeParseJSON(u.purchase_history),
            deposit_history: safeParseJSON(u.deposit_history),
            createdAt: u.created_at,
            updatedAt: u.updated_at
        }));
        res.json({ success: true, users });
    } catch (err) {
        console.error('❌ Lỗi admin users:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    }
});

app.post('/api/admin/update-user-info', requireAdminToken, async (req, res) => {
    try {
        const { username, fullName, phone, telegram, job, hometown } = req.body;
        
        if (!username) return res.status(400).json({ success: false, error: 'Thiếu username' });

        const { rowCount } = await pool.query(`
            UPDATE users 
            SET full_name = $1, phone = $2, telegram = $3, job = $4, hometown = $5
            WHERE LOWER(username) = LOWER($6)
        `, [fullName || '', phone || '', telegram || '', job || '', hometown || '', username]);

        if (rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });
        }

        res.json({ success: true, message: 'Cập nhật thông tin thành công!' });
    } catch (err) {
        console.error('Update user info error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 34: EMAIL LOGS
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/admin/email-logs', requireAdminToken, async (req, res) => {
    try {
        const { page = 1, limit = 50, status = 'all' } = req.body;
        const offset = (page - 1) * limit;

        let query = 'SELECT * FROM email_logs';
        const params = [];
        let paramIndex = 1;

        if (status !== 'all') {
            query += ` WHERE status = $${paramIndex}`;
            params.push(status.toUpperCase());
            paramIndex++;
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const { rows } = await emailLogPool.query(query, params);

        let countQuery = 'SELECT COUNT(*) FROM email_logs';
        const countParams = [];
        if (status !== 'all') {
            countQuery += ' WHERE status = $1';
            countParams.push(status.toUpperCase());
        }
        const countResult = await emailLogPool.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].count);

        res.json({
            success: true,
            logs: rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('❌ Lỗi lấy email logs:', err.message);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 35: KEYS MANAGEMENT
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/create-key', async (req, res) => {
    try {
        const { plan, customerName, transferContent, amount } = req.body;
        if (!plan || !customerName) return res.status(400).json({ error: 'Thiếu thông tin' });

        await cleanupExpiredKeys();

        const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
        const timestamp = Date.now().toString(36).toUpperCase();
        const key = `TYON-${plan.toUpperCase()}-${randomPart}-${timestamp}`;
        const newKey = {
            key, plan, customerName,
            transferContent: transferContent || '',
            amount: amount || 0,
            status: 'pending',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + KEY_EXPIRE_MS).toISOString()
        };

        await withGistLock(async () => {
            const db = USE_GIST ? (await loadFromGist()) || EMPTY_DB() : (loadLocal() || EMPTY_DB());
            db.keys.push(newKey);
            const ok = USE_GIST ? await saveToGist(db) : true;
            if (!ok) throw new Error('Không ghi được Gist');
            saveLocal(db);
        });

        res.json({
            success: true, key,
            expiresAt: newKey.expiresAt,
            message: `Key đã tạo. Xác nhận trong ${KEY_EXPIRE_HOURS}h.`
        });
    } catch (err) {
        console.error('❌ create-key error:', err);
        res.status(500).json({ error: 'Có lỗi xảy ra.' });
    }
});

app.post('/api/admin/keys', requireAdminToken, async (req, res) => {
    try {
        await cleanupExpiredKeys();
        const db = await readStorage();
        const keys = db.keys.map(k => {
            if (k.status === 'pending') {
                const rem = calcRemainingTime(k.createdAt, k.status);
                return { ...k, remainingHours: rem.hours, remainingMinutes: rem.minutes };
            }
            return k;
        });
        res.json({ keys });
    } catch (err) {
        console.error('❌ admin/keys error:', err);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.post('/api/admin/confirm-key', requireAdminToken, async (req, res) => {
    try {
        const { pin, key } = req.body;
        if (!verifyPin(pin)) return res.status(403).json({ error: 'Mã PIN không chính xác' });

        await cleanupExpiredKeys();

        let keyData = null;
        await withGistLock(async () => {
            const db = USE_GIST ? (await loadFromGist()) || EMPTY_DB() : (loadLocal() || EMPTY_DB());
            const idx = db.keys.findIndex(k => k.key === key);
            if (idx === -1) throw Object.assign(new Error('Không tìm thấy key'), { status: 404 });
            if (db.keys[idx].status === 'confirmed') {
                throw Object.assign(new Error('Đã xác nhận'), { status: 400 });
            }
            db.keys[idx].status = 'confirmed';
            db.keys[idx].confirmedAt = new Date().toISOString();
            db.keys[idx].confirmedBy = req.admin.username;
            keyData = db.keys[idx];

            const ok = USE_GIST ? await saveToGist(db) : true;
            if (!ok) throw new Error('Không ghi được Gist');
            saveLocal(db);
        });

        res.json({ success: true, message: 'Đã xác nhận Key thành công!', keyData });
    } catch (err) {
        console.error('❌ confirm-key error:', err);
        res.status(err.status || 500).json({ error: 'Có lỗi xảy ra.' });
    }
});

app.post('/api/check-key', async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: 'Thiếu key' });

        await cleanupExpiredKeys();
        const db = await readStorage();
        const k = db.keys.find(x => x.key.toUpperCase() === key.trim().toUpperCase());
        if (!k) return res.status(404).json({ error: 'Key không tồn tại' });

        const rem = calcRemainingTime(k.createdAt, k.status);
        res.json({
            success: true,
            keyData: {
                ...k,
                remainingTime: rem && !rem.isExpired ? { hours: rem.hours, minutes: rem.minutes } : null
            }
        });
    } catch (err) {
        console.error('Check key error:', err);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.post('/api/search-keys', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Nhập từ khóa' });
        const term = query.trim().toUpperCase();

        await cleanupExpiredKeys();
        const db = await readStorage();

        const matches = db.keys.filter(k =>
            (k.key && k.key.toUpperCase().includes(term)) ||
            (k.transferContent && k.transferContent.toUpperCase().includes(term)) ||
            (k.customerName && k.customerName.toUpperCase().includes(term))
        );

        const results = matches.map(k => {
            const rem = calcRemainingTime(k.createdAt, k.status);
            return {
                ...k,
                remainingTime: rem && !rem.isExpired ? rem : null,
                isExpired: rem ? rem.isExpired : false
            };
        });
        res.json({ success: true, results, count: results.length, totalMatches: results.length });
    } catch {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.get('/api/confirmed-keys', async (req, res) => {
    try {
        await cleanupExpiredKeys();
        const db = await readStorage();
        res.json({ keys: db.keys.filter(k => k.status === 'confirmed') });
    } catch {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.post('/api/admin/cleanup-now', requireAdminToken, async (req, res) => {
    try {
        const result = await cleanupExpiredKeys();
        res.json({
            success: true,
            message: `Đã xóa ${result.deletedCount} key hết hạn.`
        });
    } catch {
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 36: FEEDBACKS
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/feedbacks', async (req, res) => {
    try {
        const db = await readStorage();
        const feedbacks = [...(db.feedbacks || [])].sort(
            (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
        res.json({ feedbacks });
    } catch (err) {
        console.error('❌ Lỗi load feedbacks:', err);
        res.json({
            feedbacks: [], maintenance: true,
            error: 'Hệ thống đang bảo trì phần đánh giá. Vui lòng quay lại sau 1 tiếng!',
            retryAfter: 3600
        });
    }
});

app.post('/api/submit-feedback', async (req, res) => {
    try {
        const { username, rating, content, images } = req.body;

        if (!username) return res.status(400).json({ error: 'Thiếu thông tin người dùng!' });
        if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Đánh giá phải từ 1 đến 5 sao!' });
        if (!content || content.trim().length === 0) return res.status(400).json({ error: 'Nội dung đánh giá không được để trống!' });
        if (!pool) return res.status(500).json({ error: 'DB chưa sẵn sàng' });

        const user = await getUserByUsername(username);
        if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng!' });

        const purchaseHistory = safeParseJSON(user.purchase_history);
        const totalSpent = purchaseHistory.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
        if (totalSpent < 500000) {
            return res.status(403).json({
                error: `Bạn cần mua hàng tối thiểu 500.000đ để đánh giá. Tổng chi tiêu hiện tại: ${new Intl.NumberFormat('vi-VN').format(totalSpent)}đ`
            });
        }

        let newFeedback = null;
        await withGistLock(async () => {
            const db = USE_GIST ? (await loadFromGist()) : (loadLocal() || EMPTY_DB());
            if (!db) throw Object.assign(new Error('Gist tạm thời không khả dụng'), { status: 503, maintenance: true });

            const existing = (db.feedbacks || []).find(
                fb => fb.username && fb.username.toLowerCase() === username.toLowerCase()
            );
            if (existing) throw Object.assign(new Error('Bạn đã gửi đánh giá rồi. Cảm ơn bạn!'), { status: 400 });

            newFeedback = {
                id: Date.now().toString(),
                username: user.username,
                customerName: user.full_name || user.username,
                rating: Number(rating),
                content: content.trim(),
                images: images || [],
                createdAt: new Date().toISOString()
            };
            db.feedbacks = [...(db.feedbacks || []), newFeedback];

            const ok = USE_GIST ? await saveToGist(db) : true;
            if (!ok) throw Object.assign(new Error('Không lưu được feedback'), { status: 503, maintenance: true });
            saveLocal(db);
        });

        res.json({ success: true, message: 'Cảm ơn bạn đã gửi đánh giá!', feedback: newFeedback });
    } catch (err) {
        console.error('❌ Lỗi submit-feedback:', err);
        const status = err.status || 503;
        res.status(status).json({
            success: false,
            maintenance: err.maintenance || false,
            error: err.message || 'Hệ thống đang bảo trì phần đánh giá.',
            retryAfter: err.maintenance ? 3600 : undefined
        });
    }
});

app.post('/api/admin/feedbacks', requireAdminToken, async (req, res) => {
    try {
        const db = await readStorage();
        const feedbacks = [...(db.feedbacks || [])].sort(
            (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
        res.json({ feedbacks });
    } catch (err) {
        console.error('❌ Lỗi load feedbacks admin:', err);
        res.json({
            feedbacks: [], maintenance: true,
            error: 'Hệ thống đang bảo trì phần đánh giá.'
        });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 37: HEALTH
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/health', globalLimiter, async (req, res) => {
    let orderStats = { total: 0, pending: 0, paid: 0, underpaid: 0 };
    let totalUsers = 0;

    try {
        const { rows } = await pool.query('SELECT status, COUNT(*) as count FROM orders GROUP BY status');
        rows.forEach(r => {
            orderStats.total += Number(r.count);
            orderStats[r.status] = Number(r.count);
        });
    } catch (err) {
        console.error('Lỗi health orders:', err.message);
    }

    try {
        const { rows } = await pool.query('SELECT COUNT(*) FROM users');
        totalUsers = Number(rows[0].count);
    } catch (_) {}

    let totalKeys = 0, pendingKeys = 0, confirmedKeys = 0, totalFeedbacks = 0;
    try {
        const db = await readStorage();
        totalKeys = (db.keys || []).length;
        pendingKeys = (db.keys || []).filter(k => k.status === 'pending').length;
        confirmedKeys = (db.keys || []).filter(k => k.status === 'confirmed').length;
        totalFeedbacks = (db.feedbacks || []).length;
    } catch (_) {}

    res.json({
        status: 'ok',
        uptime: process.uptime(),
        storage: USE_GIST ? 'github-gist' : 'local-file',
        emailConfigured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN),
        sepayConfigured: SEPAY_CONFIGURED,
        googleConfigured: !!GOOGLE_CLIENT_ID,
        totalUsers, totalKeys, pendingKeys, confirmedKeys, totalFeedbacks,
        totalOrders: orderStats.total,
        pendingOrders: orderStats.pending || 0,
        paidOrders: orderStats.paid || 0,
        underpaidOrders: orderStats.underpaid || 0
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 38: VIDEO TASKS
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/video-tasks/submit', requireUserSession, requireActiveUser, async (req, res) => {
    try {
        const { videoUrl, platform, note } = req.body;
        const username = req.username;

        if (!videoUrl) {
            return res.status(400).json({ success: false, error: 'Vui lòng nhập link video' });
        }

        const { rows: existing } = await pool.query(
            "SELECT id FROM video_tasks WHERE LOWER(username) = LOWER($1) AND status = 'pending'",
            [username]
        );

        if (existing.length > 0) {
            return res.status(400).json({ success: false, error: 'Bạn đã có một video đang chờ duyệt.' });
        }

        await pool.query(
            `INSERT INTO video_tasks (username, video_url, platform, note, status, amount) 
             VALUES ($1, $2, $3, $4, 'pending', 25000)`,
            [username, videoUrl, platform || 'Khác', note || '']
        );

        res.json({ success: true, message: 'Gửi video thành công! Vui lòng chờ Admin duyệt.' });
    } catch (err) {
        console.error('Submit video task error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.get('/api/video-tasks/my-history', requireUserSession, async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT * FROM video_tasks WHERE LOWER(username) = LOWER($1) ORDER BY created_at DESC",
            [req.username]
        );
        res.json({ success: true, tasks: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/admin/video-tasks/list', requireAdminToken, async (req, res) => {
    try {
        const { status = 'all' } = req.body;
        let query = "SELECT * FROM video_tasks";
        let params = [];

        if (status !== 'all') {
            query += " WHERE status = $1";
            params.push(status);
        }
        
        query += " ORDER BY created_at DESC";
        
        const { rows } = await pool.query(query, params);
        res.json({ success: true, tasks: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/admin/video-tasks/review', requireAdminToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { taskId, action, pin } = req.body;
        
        if (!verifyPin(pin)) {
            return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });
        }

        await client.query('BEGIN');

        const { rows: taskRows } = await client.query(
            "SELECT * FROM video_tasks WHERE id = $1 FOR UPDATE",
            [taskId]
        );

        if (taskRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Không tìm thấy nhiệm vụ' });
        }

        const task = taskRows[0];
        if (task.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'Nhiệm vụ này đã được xử lý rồi' });
        }

        if (action === 'approve') {
            await client.query(
                "UPDATE video_tasks SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
                [req.admin.username, taskId]
            );

            const amount = Number(task.amount);
            const { rows: userRows } = await client.query(
                "SELECT username, balance, deposit_history FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE",
                [task.username]
            );

            if (userRows.length > 0) {
                const user = userRows[0];
                const depositHistory = safeParseJSON(user.deposit_history);
                depositHistory.push({
                    amount: amount,
                    method: 'event_video',
                    content: `Thưởng Video Event #${taskId}`,
                    transactionId: 'VIDEO_' + Date.now(),
                    at: new Date().toISOString(),
                    addedBy: req.admin.username
                });

                await client.query(
                    "UPDATE users SET balance = balance + $1, deposit_history = $2 WHERE username = $3",
                    [amount, JSON.stringify(depositHistory), user.username]
                );
            }

            await client.query('COMMIT');
            res.json({ success: true, message: `Đã duyệt và cộng ${new Intl.NumberFormat('vi-VN').format(task.amount)}đ cho ${task.username}` });

        } else {
            await client.query(
                "UPDATE video_tasks SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
                [req.admin.username, taskId]
            );
            await client.query('COMMIT');
            res.json({ success: true, message: 'Đã từ chối video này.' });
        }

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Review video task error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    } finally {
        client.release();
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 39: NOTIFICATION TEMPLATE
   ═══════════════════════════════════════════════════════════════════════════ */

function buildNotificationTemplate({ title, content, webUrl, unsubscribeUrl, username }) {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);border:1px solid #e2e8f0;">
    <tr><td style="background:linear-gradient(135deg,#1e3a5f 0%,#2c5282 100%);padding:28px 32px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:1px;">TYONCAO</td>
        <td align="right" style="color:#cbd5e1;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;">Global Optimizer</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:32px 32px 8px;">
      <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:1.5px;color:#2c5282;text-transform:uppercase;">Thông báo từ hệ thống</p>
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;line-height:1.35;">${escapeHtml(title)}</h1>
    </td></tr>
    <tr><td style="padding:16px 32px 8px;font-size:15px;line-height:1.75;color:#334155;">
      <p style="margin:0 0 16px;">Xin chào <strong style="color:#0f172a;">${escapeHtml(username || 'Quý khách')}</strong>,</p>
      <div style="color:#334155;">${content}</div>
    </td></tr>
    ${webUrl ? `
    <tr><td style="padding:12px 32px 24px;" align="center">
      <a href="${escapeHtml(webUrl)}" style="display:inline-block;padding:13px 36px;background:linear-gradient(135deg,#1e3a5f,#2c5282);color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;border-radius:10px;letter-spacing:0.3px;">Truy cập website</a>
    </td></tr>` : ''}
    <tr><td style="padding:8px 32px 24px;font-size:14px;line-height:1.7;color:#475569;">
      <p style="margin:0;">Trân trọng,</p>
      <p style="margin:4px 0 0;font-weight:700;color:#0f172a;">Đội ngũ TyonCao Global Optimizer</p>
    </td></tr>
    <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center;font-size:12px;line-height:1.6;color:#64748b;">
      <p style="margin:0 0 6px;">Email này được gửi từ hệ thống TyonCao.</p>
      <p style="margin:0 0 6px;">TYONCGO247 · (+84) 97 8568 965 · tyonoptimizer.infinityfreeapp.com</p>
      <p style="margin:8px 0 0;font-size:11px;">
        <a href="${escapeHtml(unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">Hủy nhận thông báo</a>
        &nbsp;·&nbsp; © ${new Date().getFullYear()} TyonCao. All rights reserved.
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 40: PROCESS NOTIFICATION QUEUE
   ═══════════════════════════════════════════════════════════════════════════ */

async function processNotificationQueue(notificationId) {
    if (isSendingNotification) {
        console.log('⚠️ Notification worker đang bận, skip');
        return;
    }
    isSendingNotification = true;

    try {
        await pool.query(
            `UPDATE notifications SET status='sending' WHERE id=$1`,
            [notificationId]
        );

        // ✅ FIX: Dùng đúng cột email_status
        const { rows: recipients } = await pool.query(
            `SELECT * FROM notification_recipients 
             WHERE notification_id=$1 AND email_status='pending'`,
            [notificationId]
        );

        const { rows: notifRows } = await pool.query(
            'SELECT * FROM notifications WHERE id=$1', [notificationId]
        );
        if (notifRows.length === 0) throw new Error('Notification not found');
        const notif = notifRows[0];

        const baseUrl = process.env.BASE_URL || 'https://buyoptimizertyoncao.onrender.com';
        const webUrl = process.env.FRONTEND_URL || 'https://tyonoptimizer.infinityfreeapp.com';

        let sent = 0, failed = 0;

        for (const r of recipients) {
            try {
                const unsubscribeToken = crypto
                    .createHmac('sha256', JWT_SECRET)
                    .update(r.email.toLowerCase())
                    .digest('hex')
                    .slice(0, 32);
                const unsubscribeUrl = `${baseUrl}/api/unsubscribe?token=${unsubscribeToken}&email=${encodeURIComponent(r.email)}`;

                const html = buildNotificationTemplate({
                    title: notif.title,
                    content: notif.content_html,
                    webUrl,
                    unsubscribeUrl,
                    username: r.username
                });

                const messageId = crypto.randomBytes(16).toString('hex');

                const result = await sendNotificationEmail({
                    to: r.email,
                    subject: notif.subject,
                    htmlContent: html,
                    textContent: notif.content_text || stripHtml(notif.content_html),
                    messageId,
                    unsubscribeUrl
                });

                if (result.success) {
                    // ✅ FIX: Dùng email_status='sent'
                    await pool.query(
                        `UPDATE notification_recipients SET email_status='sent', sent_at=NOW() WHERE id=$1`,
                        [r.id]
                    );
                    sent++;
                } else {
                    // ✅ FIX: Dùng email_status='failed'
                    await pool.query(
                        `UPDATE notification_recipients SET email_status='failed', error_message=$1 WHERE id=$2`,
                        [result.error, r.id]
                    );
                    failed++;
                }

                const delay = 3000 + Math.random() * 3000;
                await new Promise(res => setTimeout(res, delay));

            } catch (err) {
                // ✅ FIX: Dùng email_status='failed'
                await pool.query(
                    `UPDATE notification_recipients SET email_status='failed', error_message=$1 WHERE id=$2`,
                    [err.message, r.id]
                );
                failed++;
     
                if (String(err.message).includes('quota') || String(err.message).includes('rate')) {
                    await new Promise(res => setTimeout(res, 60000));
                }
            }
        }

        await pool.query(
            `UPDATE notifications 
             SET status='completed', total_sent=$1, total_failed=$2, completed_at=NOW() 
             WHERE id=$3`,
            [sent, failed, notificationId]
        );

        console.log(`✅ Notification #${notificationId}: ${sent} sent, ${failed} failed`);
    } catch (err) {
        console.error(`❌ Notification #${notificationId} error:`, err.message);
        await pool.query(
            `UPDATE notifications SET status='failed', completed_at=NOW() WHERE id=$1`,
            [notificationId]
        ).catch(() => {});
    } finally {
        isSendingNotification = false;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 41: ADMIN NOTIFICATIONS SEND/LIST/DETAIL
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/admin/notifications/send', requireAdminToken, async (req, res) => {
    const { pin, title, subject, content, targetType = 'all', usernames = [], type = 'all' } = req.body;

    if (!verifyPin(pin)) {
        return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });
    }
    if (!title || !title.trim()) {
        return res.status(400).json({ success: false, error: 'Thiếu tiêu đề' });
    }
    if (targetType === 'specific' && (!Array.isArray(usernames) || usernames.length === 0)) {
        return res.status(400).json({ success: false, error: 'Chưa chọn người nhận' });
    }

    const finalTitle = title.trim().normalize('NFC');
    const finalSubject = (subject && subject.trim()) ? subject.trim().normalize('NFC') : finalTitle;
    const finalContent = (content && content.trim()) ? content.trim() : `<p>${finalTitle}</p>`;
    const contentText = stripHtml(finalContent);
    const startTime = Date.now();

    const client = await pool.connect();
    try {
        await client.query('SET LOCAL statement_timeout = 30000');

        let recipients = [];
        if (targetType === 'specific') {
            const cleanUsernames = usernames.map(u => String(u).trim().toLowerCase()).filter(u => u.length > 0);
            if (cleanUsernames.length === 0) throw new Error('Danh sách username không hợp lệ');

            const { rows } = await client.query(
                `SELECT username, full_name, email FROM users 
                 WHERE LOWER(username) = ANY($1::text[]) AND email IS NOT NULL AND email <> ''`,
                [cleanUsernames]
            );
            recipients = rows;
        } else {
            const { rows } = await client.query(
                `SELECT username, full_name, email FROM users WHERE email IS NOT NULL AND email <> ''`
            );
            recipients = rows;
        }

        const { rows: unsubRows } = await client.query('SELECT LOWER(email) AS email FROM email_unsubscribes');
        const unsubSet = new Set(unsubRows.map(r => r.email));
        const beforeCount = recipients.length;
        recipients = recipients.filter(r => !unsubSet.has(r.email.toLowerCase()));

        const seenEmails = new Set();
        const finalRecipients = recipients.filter(r => {
            if (!r.username || !r.email) return false;
            const cleanUsername = String(r.username).trim().normalize('NFC');
            const cleanEmail = String(r.email).trim().toLowerCase().normalize('NFC');
            if (!cleanUsername || !cleanEmail || seenEmails.has(cleanEmail)) return false;
            seenEmails.add(cleanEmail);
            r.username = cleanUsername;
            r.email = cleanEmail;
            return true;
        });

        if (finalRecipients.length === 0) {
            throw new Error('Không có người nhận hợp lệ');
        }
        console.log(`✅ [Notification] Sau khi lọc: ${finalRecipients.length} người nhận`);

        await client.query('BEGIN');

        const { rows: notifInsert } = await client.query(
            `INSERT INTO notifications 
             (title, subject, content_html, content_text, target_type, target_usernames, sent_by, total_recipients, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING id`,
            [
                finalTitle, finalSubject, finalContent, contentText, targetType,
                targetType === 'specific' ? usernames : null,
                req.admin.username, finalRecipients.length
            ]
        );
        const notifId = notifInsert[0].id;
        console.log(`✅ [Notification] Đã tạo ID #${notifId} | ${finalRecipients.length} người`);

        let insertedCount = 0;
        for (const r of finalRecipients) {
            await client.query(
                `INSERT INTO notification_recipients 
                 (notification_id, username, email, read_status, email_status) 
                 VALUES ($1::int, $2::text, $3::text, 'unread'::varchar, 'pending'::varchar)`,
                [notifId, String(r.username).trim(), String(r.email).trim()]
            );
            insertedCount++;
        }
        console.log(`📝 [Notification] Đã insert ${insertedCount}/${finalRecipients.length} người nhận`);

        if (type === 'email' || type === 'all') {
            await client.query(`UPDATE notifications SET status = 'sending' WHERE id = $1`, [notifId]);
            await client.query('COMMIT');
            setImmediate(() => processNotificationQueue(notifId));
            console.log(`📧 [Notification] Đã COMMIT & xếp hàng gửi Email #${notifId}`);
        } else {
            await client.query(
                `UPDATE notifications SET status = 'completed', total_sent = $1, completed_at = NOW() WHERE id = $2`,
                [finalRecipients.length, notifId]
            );
            await client.query(
                `UPDATE notification_recipients SET email_status = 'no_email' WHERE notification_id = $1`,
                [notifId]
            );
            await client.query('COMMIT');
            console.log(`💻 [Notification] Đã COMMIT thông báo Hệ thống #${notifId}`);
        }

        const elapsed = Date.now() - startTime;
        res.json({
            success: true,
            notificationId: notifId,
            totalRecipients: finalRecipients.length,
            filteredUnsubscribed: beforeCount - finalRecipients.length,
            elapsedMs: elapsed,
            message: (type === 'email' || type === 'all')
                ? `✅ Đã gửi tới ${finalRecipients.length} người (đang xử lý nền).`
                : `✅ Đã lưu thông báo Hệ thống cho ${finalRecipients.length} người.`
        });

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('❌ [Notification] Lỗi:', err.message);
        
        let userMessage = err.message;
        if (err.code === '42P18') userMessage = 'Lỗi cấu trúc bảng. Vui lòng liên hệ admin.';
        else if (err.code === '23505') userMessage = 'Lỗi trùng lặp dữ liệu. Vui lòng thử lại.';
        else if (err.message.includes('timeout')) userMessage = 'Quá thời gian xử lý (30s). Vui lòng giảm số lượng người nhận.';

        res.status(500).json({ 
            success: false, 
            error: userMessage,
            errorCode: err.code || 'UNKNOWN',
            timestamp: new Date().toISOString()
        });
    } finally {
        client.release();
    }
});

app.post('/api/admin/notifications/list', requireAdminToken, async (req, res) => {
    try {
        // ✅ FIX: Thêm type, band_id
        const { rows } = await pool.query(
            `SELECT id, title, subject, target_type, sent_by, total_recipients,
                    total_sent, total_failed, status, created_at, completed_at,
                    type, band_id
             FROM notifications ORDER BY created_at DESC LIMIT 100`
        );
        res.json({ success: true, notifications: rows });
    } catch (err) {
        console.error('Lỗi notification:', err.message);
        res.status(500).json({ success: false, error: 'Có lỗi xảy ra.' });
    }
});

app.post('/api/admin/notifications/detail', requireAdminToken, async (req, res) => {
    try {
        const { id } = req.body;
        const notifId = parseInt(id);
        if (!notifId || isNaN(notifId)) {
            return res.status(400).json({ success: false, error: 'ID thông báo không hợp lệ' });
        }
        const { rows: notifRows } = await pool.query(
            'SELECT * FROM notifications WHERE id = $1',
            [notifId]
        );
        if (notifRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy thông báo' });
        }
        const notification = notifRows[0];
        // ✅ FIX: Thêm appeal_status, has_appealed
        const { rows: recipients } = await pool.query(
            `SELECT 
                username, email, read_status, email_status, error_message, sent_at,
                appeal_status, has_appealed
             FROM notification_recipients 
             WHERE notification_id = $1 
             ORDER BY id ASC`,
            [notifId]
        );
        res.json({
            success: true,
            notification,
            recipients
        });
    } catch (err) {
        console.error('❌ Lỗi lấy chi tiết thông báo:', err.message);
        res.status(500).json({ 
            success: false, 
            error: 'Có lỗi xảy ra khi lấy chi tiết thông báo: ' + err.message 
        });
    }
});

app.post('/api/admin/notifications/test', requireAdminToken, async (req, res) => {
    try {
        const { pin, toEmail, title, subject, content } = req.body;
        if (!verifyPin(pin)) return res.status(403).json({ success: false, error: 'PIN sai' });
        if (!isValidEmail(toEmail)) return res.status(400).json({ success: false, error: 'Email không hợp lệ' });

        const unsubscribeToken = crypto.createHmac('sha256', JWT_SECRET)
            .update(toEmail.toLowerCase()).digest('hex').slice(0, 32);
        const baseUrl = process.env.BASE_URL || 'https://buyoptimizertyoncao.onrender.com';
        const unsubscribeUrl = `${baseUrl}/api/unsubscribe?token=${unsubscribeToken}&email=${encodeURIComponent(toEmail)}`;

        const html = buildNotificationTemplate({
            title: title || 'Test thông báo',
            content: content || '<p>Đây là email test.</p>',
            webUrl: process.env.FRONTEND_URL,
            unsubscribeUrl,
            username: 'Test User'
        });

        const result = await sendNotificationEmail({
            to: toEmail,
            subject: (subject || 'Test') + ' [TEST]',
            htmlContent: html,
            textContent: stripHtml(content || 'Test'),
            messageId: crypto.randomBytes(16).toString('hex'),
            unsubscribeUrl
        });

        if (result.success) {
            res.json({ success: true, message: `Đã gửi test tới ${toEmail}` });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 42: USER NOTIFICATIONS
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/user/notifications', requireAuthOnly, async (req, res) => { 
    try {
        // ✅ FIX: Dùng LEFT JOIN với band_schedules thay vì N+1 query
        const { rows } = await pool.query(`
            SELECT 
                n.id, n.title, n.subject, n.content_html, n.content_text, n.created_at,
                n.type, n.band_id,
                r.read_status,
                r.email_status,
                r.appeal_status,
                r.has_appealed,
                bs.scheduled_at AS band_scheduled_at
            FROM notifications n
            JOIN notification_recipients r ON n.id = r.notification_id
            LEFT JOIN band_schedules bs ON n.band_id = bs.id
            WHERE LOWER(r.username) = LOWER($1)
            ORDER BY 
                CASE WHEN n.type = 'band_warning' THEN 0 ELSE 1 END,
                n.created_at DESC
            LIMIT 50
        `, [req.username]);

        const notifications = rows.map(n => ({
            ...n,
            band_scheduled_at: n.band_scheduled_at ? Number(n.band_scheduled_at) : null,
            content_html: n.content_html || n.content_text || '',
            content_text: n.content_text || ''
        }));
        
        const unreadCount = notifications.filter(n => n.read_status !== 'read').length;
        res.json({ success: true, notifications, unreadCount });
    } catch (err) {
        console.error('Lỗi lấy thông báo user:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/user/notifications/read', requireAuthOnly, async (req, res) => {
    try {
        await pool.query(`
            UPDATE notification_recipients 
            SET read_status = 'read' 
            WHERE LOWER(username) = LOWER($1) AND read_status != 'read'
        `, [req.username]);
        
        res.json({ success: true, message: 'Đã đánh dấu tất cả là đã đọc' });
    } catch (err) {
        console.error('Lỗi đánh dấu đã đọc:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ✅ ROUTE MỚI: Toggle đọc 1 notification
app.post('/api/user/notifications/:id/read', requireAuthOnly, async (req, res) => {
    try {
        const notificationId = parseInt(req.params.id);
        const { read } = req.body;
        
        if (isNaN(notificationId)) {
            return res.status(400).json({ success: false, error: 'ID không hợp lệ' });
        }
        
        const newStatus = read ? 'read' : 'unread';
        
        const { rowCount } = await pool.query(`
            UPDATE notification_recipients 
            SET read_status = $1
            WHERE LOWER(username) = LOWER($2) AND notification_id = $3
        `, [newStatus, req.username, notificationId]);
        
        if (rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy thông báo' });
        }
        
        res.json({ success: true, message: `Đã đánh dấu ${read ? 'đã đọc' : 'chưa đọc'}` });
    } catch (err) {
        console.error('Toggle read error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.delete('/api/user/notifications/:id', requireAuthOnly, async (req, res) => {
    try {
        const notificationId = parseInt(req.params.id);
        if (isNaN(notificationId)) {
            return res.status(400).json({ success: false, error: 'ID không hợp lệ' });
        }

        const { rowCount } = await pool.query(`
            DELETE FROM notification_recipients 
            WHERE LOWER(username) = LOWER($1) AND notification_id = $2
        `, [req.username, notificationId]);

        if (rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy thông báo' });
        }

        res.json({ success: true, message: 'Đã xóa thông báo' });
    } catch (err) {
        console.error('Lỗi xóa thông báo:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 43: UNSUBSCRIBE
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/unsubscribe', async (req, res) => {
    try {
        const { token, email } = req.query;
        if (!token || !email) {
            return res.status(400).send('<h1>Link không hợp lệ</h1>');
        }
        const expectedToken = crypto
            .createHmac('sha256', JWT_SECRET)
            .update(String(email).toLowerCase())
            .digest('hex')
            .slice(0, 32);

        if (token !== expectedToken) {
            return res.status(400).send('<h1>Link không hợp lệ hoặc đã hết hạn</h1>');
        }

        await pool.query(
            `INSERT INTO email_unsubscribes (email) VALUES ($1)
             ON CONFLICT (email) DO NOTHING`,
            [String(email).toLowerCase()]
        );
        console.log(`🚫 Unsubscribe: ${email}`);

        res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Đã hủy</title>
<style>body{font-family:sans-serif;background:#f4f6f8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.box{background:#fff;padding:40px;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,0.08);text-align:center;max-width:440px;}
h1{color:#0f172a;font-size:22px;margin:0 0 12px;}p{color:#64748b;line-height:1.6;margin:0;}</style></head>
<body><div class="box"><h1>✅ Đã hủy nhận thông báo</h1>
<p>Email <strong>${escapeHtml(email)}</strong> sẽ không nhận thêm thông báo từ TyonCao.</p></div></body></html>`);
    } catch (err) {
        console.error('Unsubscribe error:', err);
        res.status(500).send('<h1>Lỗi server</h1>');
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 44: CREATE USER NOTIFICATION (Helper)
   ═══════════════════════════════════════════════════════════════════════════ */

async function createUserNotification({
    username,
    title,
    contentHtml,
    type = 'general',
    bandId = null
}) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const contentText = stripHtml(contentHtml);

        const { rows: notifRows } = await client.query(
            `INSERT INTO notifications 
             (title, subject, content_html, content_text, target_type, target_usernames, sent_by, total_recipients, status, type, band_id)
             VALUES ($1, $2, $3, $4, 'specific', $5, 'system', 1, 'completed', $6, $7)
             RETURNING id`,
            [title, title, contentHtml, contentText, [username], type, bandId]
        );
        const notifId = notifRows[0].id;

        const { rows: userRows } = await client.query(
            'SELECT email FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        const userEmail = userRows[0]?.email || '';

        await client.query(
            `INSERT INTO notification_recipients 
             (notification_id, username, email, read_status, email_status, sent_at)
             VALUES ($1, $2, $3, 'unread', 'no_email', NULL)`,
            [notifId, username, userEmail]
        );

        await client.query('COMMIT');
        return notifId;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 45: BAND SYSTEM - ADMIN SEND WARNING
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/admin/band-user-warning', requireAdminToken, async (req, res) => {
    try {
        const { username, reason, pin } = req.body;

        if (!verifyPin(pin)) {
            return res.status(403).json({ success: false, error: 'Mã PIN Admin không đúng' });
        }

        if (!username || !reason || reason.trim().length < 20) {
            return res.status(400).json({ success: false, error: 'Thiếu username hoặc lý do quá ngắn (tối thiểu 20 ký tự)' });
        }

        const dbUser = await getUserByUsername(username);
        if (!dbUser) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });
        }

        if (dbUser.status === 'banned') {
            return res.status(400).json({ success: false, error: 'Tài khoản đã bị khóa' });
        }

        const scheduledBandAt = Date.now() + BAND_DURATION_MS;
        const bandId = 'band_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const now = Date.now();

        await pool.query(
            `UPDATE ${BAND_SCHEDULES_TABLE} SET status = 'cancelled', cancelled_reason = 'replaced'
             WHERE LOWER(username) = LOWER($1) AND status IN ('pending', 'appealing')`,
            [username]
        );

        await pool.query(
            `INSERT INTO ${BAND_SCHEDULES_TABLE}
             (id, username, reason, scheduled_at, created_at, status, created_by)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
            [bandId, username, reason.trim(), scheduledBandAt, now, req.admin.username]
        );

        const notifContent = `
<div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.7;">
  <p style="font-size: 18px; color: #ef4444; font-weight: 700; margin: 0 0 16px;">⚠️ CẢNH BÁO VI PHẠM</p>
  <p>Xin chào <strong>${escapeHtml(username)}</strong>,</p>
  <p>Tài khoản của bạn <strong style="color: #ef4444;">sẽ bị BAND sau 7 ngày</strong> vì có hành vi vi phạm chính sách của chúng tôi.</p>
  <p style="margin-top: 16px;"><strong>Lý do cụ thể:</strong></p>
  <blockquote style="border-left: 3px solid #ef4444; padding: 10px 16px; background: rgba(239,68,68,0.1); border-radius: 6px; margin: 12px 0;">
    ${escapeHtml(reason.trim())}
  </blockquote>
  <p>Bạn có thể <strong>kháng cáo</strong> trong vòng 7 ngày. Nếu kháng cáo của bạn không được chấp thuận, tài khoản sẽ buộc bị khóa.</p>
  <p style="color: #64748b; font-size: 13px; margin-top: 20px;">
    ⏰ Hạn chót: <strong>${new Date(scheduledBandAt).toLocaleString('vi-VN')}</strong>
  </p>
  <p style="margin-top: 20px;">Xin cảm ơn!</p>
</div>`;

        await createUserNotification({
            username,
            title: 'Cảnh báo: Tài khoản sẽ bị khóa sau 7 ngày',
            contentHtml: notifContent,
            type: 'band_warning',
            bandId
        });

        if (dbUser.email) {
            try {
                await sendEmailImmediate(
                    dbUser.email,
                    '⚠️ Cảnh báo: Tài khoản của bạn sẽ bị khóa sau 7 ngày',
                    `<div style="font-family: system-ui, sans-serif; line-height: 1.7; padding: 20px;">
                        <h2 style="color: #ef4444;">⚠️ CẢNH BÁO VI PHẠM</h2>
                        <p>Xin chào <strong>${escapeHtml(username)}</strong>,</p>
                        <p>Tài khoản của bạn <strong style="color: #ef4444;">sẽ bị BAND sau 7 ngày</strong> vì vi phạm chính sách.</p>
                        <p><strong>Lý do:</strong> ${escapeHtml(reason.trim())}</p>
                        <p>Bạn có thể đăng nhập vào website để <strong>kháng cáo</strong>.</p>
                        <p><strong>Hạn chót:</strong> ${new Date(scheduledBandAt).toLocaleString('vi-VN')}</p>
                        <p>Xin cảm ơn!</p>
                    </div>`
                );
            } catch (mailErr) {
                console.error('Send band warning email error:', mailErr.message);
            }
        }

        console.log(`🚫 [BAND] Admin ${req.admin.username} đã cảnh báo band ${username}, sẽ khóa lúc ${new Date(scheduledBandAt).toLocaleString('vi-VN')}`);

        res.json({
            success: true,
            message: `Đã gửi cảnh báo band tới ${username}. Sẽ tự động khóa sau 7 ngày nếu không kháng cáo thành công.`,
            bandId,
            scheduledAt: scheduledBandAt
        });

    } catch (err) {
        console.error('band-user-warning error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 46: BAND SYSTEM - USER APPEAL
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/user/appeal-band', requireAuthOnly, async (req, res) => {
    try {
        const { bandId, content, confirmed } = req.body;
        const username = req.username;

        if (!confirmed) {
            return res.status(400).json({ success: false, error: 'Bạn phải xác nhận nội dung là sự thật' });
        }

        if (!content || content.trim().length < 20) {
            return res.status(400).json({ success: false, error: 'Nội dung kháng cáo phải ít nhất 20 ký tự' });
        }

        const { rows: bandRows } = await pool.query(
            `SELECT * FROM ${BAND_SCHEDULES_TABLE}
             WHERE id = $1 AND LOWER(username) = LOWER($2)`,
            [bandId, username]
        );

        if (bandRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy cảnh báo band' });
        }

        const band = bandRows[0];
        if (band.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Cảnh báo này đã được xử lý' });
        }

        const { rows: existingRows } = await pool.query(
            `SELECT id FROM ${BAND_APPEALS_TABLE}
             WHERE band_id = $1 AND LOWER(username) = LOWER($2) AND status = 'pending'`,
            [bandId, username]
        );

        if (existingRows.length > 0) {
            return res.status(400).json({ success: false, error: 'Bạn đã gửi kháng cáo, vui lòng chờ xử lý' });
        }

        const appealId = 'appeal_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const now = Date.now();

        await pool.query(
            `INSERT INTO ${BAND_APPEALS_TABLE}
             (id, band_id, username, content, confirmed, status, created_at)
             VALUES ($1, $2, $3, $4, TRUE, 'pending', $5)`,
            [appealId, bandId, username, content.trim(), now]
        );

        await pool.query(
            `UPDATE ${BAND_SCHEDULES_TABLE}
             SET status = 'appealing', appeal_id = $1
             WHERE id = $2`,
            [appealId, bandId]
        );

        await pool.query(
            `UPDATE notification_recipients
             SET appeal_status = 'pending', has_appealed = TRUE
             WHERE notification_id IN (
                SELECT id FROM notifications WHERE band_id = $1
             ) AND LOWER(username) = LOWER($2)`,
            [bandId, username]
        );

        await createUserNotification({
            username,
            title: '📩 Đã nhận kháng cáo của bạn',
            contentHtml: `<p>Kháng cáo của bạn đã được ghi nhận. Chúng tôi sẽ xem xét trong thời gian sớm nhất.</p><p>Mã kháng cáo: <strong>${appealId}</strong></p>`,
            type: 'appeal_received'
        });

        console.log(`📩 [APPEAL] User ${username} đã kháng cáo band ${bandId}`);

        res.json({
            success: true,
            message: 'Đã gửi kháng cáo thành công! Vui lòng chờ xét duyệt.',
            appealId
        });

    } catch (err) {
        console.error('appeal-band error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 47: BAND SYSTEM - ADMIN LIST & REVIEW APPEALS
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/admin/appeals/list', requireAdminToken, async (req, res) => {
    try {
        const { status = 'all' } = req.body;

        let query = `
            SELECT a.*, 
                   u.email AS user_email,
                   u.full_name AS user_fullname,
                   u.avatar_url AS user_avatar,
                   b.reason AS band_reason,
                   b.scheduled_at AS band_scheduled_at,
                   b.status AS band_status
            FROM ${BAND_APPEALS_TABLE} a
            LEFT JOIN users u ON LOWER(u.username) = LOWER(a.username)
            LEFT JOIN ${BAND_SCHEDULES_TABLE} b ON b.id = a.band_id
        `;
        const params = [];

        if (status !== 'all') {
            query += ' WHERE a.status = $1';
            params.push(status);
        }

        query += ' ORDER BY a.created_at DESC';

        const { rows } = await pool.query(query, params);

        const enriched = rows.map(a => ({
            id: a.id,
            bandId: a.band_id,
            username: a.username,
            content: a.content,
            status: a.status,
            createdAt: Number(a.created_at),
            reviewedAt: a.reviewed_at ? Number(a.reviewed_at) : null,
            reviewedBy: a.reviewed_by,
            adminNote: a.admin_note,
            user_email: a.user_email || '',
            user_fullname: a.user_fullname || '',
            user_avatar: a.user_avatar || '',
            band_reason: a.band_reason || '',
            band_scheduled_at: a.band_scheduled_at ? Number(a.band_scheduled_at) : null,
            band_status: a.band_status || 'unknown',
            days_left: a.band_scheduled_at
                ? Math.max(0, Math.ceil((Number(a.band_scheduled_at) - Date.now()) / (24 * 60 * 60 * 1000)))
                : 0
        }));

        res.json({ success: true, appeals: enriched });
    } catch (err) {
        console.error('appeals/list error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    }
});

app.post('/api/admin/appeals/review', requireAdminToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { appealId, action, adminNote, pin } = req.body;

        if (!verifyPin(pin)) {
            return res.status(403).json({ success: false, error: 'Mã PIN Admin không đúng' });
        }

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
        }

        await client.query('BEGIN');

        const { rows: appealRows } = await client.query(
            `SELECT * FROM ${BAND_APPEALS_TABLE} WHERE id = $1 FOR UPDATE`,
            [appealId]
        );

        if (appealRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Không tìm thấy kháng cáo' });
        }

        const appeal = appealRows[0];
        if (appeal.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'Kháng cáo đã được xử lý' });
        }

        const { rows: bandRows } = await client.query(
            `SELECT * FROM ${BAND_SCHEDULES_TABLE} WHERE id = $1 FOR UPDATE`,
            [appeal.band_id]
        );
        const band = bandRows[0];

        const now = Date.now();
        const newAppealStatus = action === 'approve' ? 'approved' : 'rejected';

        await client.query(
            `UPDATE ${BAND_APPEALS_TABLE}
             SET status = $1, reviewed_at = $2, reviewed_by = $3, admin_note = $4
             WHERE id = $5`,
            [newAppealStatus, now, req.admin.username, adminNote || '', appealId]
        );

        if (action === 'approve') {
            if (band) {
                await client.query(
                    `UPDATE ${BAND_SCHEDULES_TABLE}
                     SET status = 'cancelled', cancelled_at = $1, cancelled_reason = 'appeal_approved'
                     WHERE id = $2`,
                    [now, band.id]
                );
            }

            await client.query(
                `UPDATE notification_recipients
                 SET appeal_status = 'approved'
                 WHERE notification_id IN (SELECT id FROM notifications WHERE band_id = $1)
                   AND LOWER(username) = LOWER($2)`,
                [appeal.band_id, appeal.username]
            );

            await client.query('COMMIT');

            await createUserNotification({
                username: appeal.username,
                title: '✅ Kháng cáo được chấp thuận',
                contentHtml: `<div style="line-height: 1.7;">
                    <p><strong style="color: #22c55e; font-size: 18px;">🎉 Tin vui!</strong></p>
                    <p>Kháng cáo của bạn đã được <strong style="color: #22c55e;">CHẤP THUẬN</strong>.</p>
                    <p>Tài khoản của bạn sẽ <strong>KHÔNG</strong> bị khóa. Cảnh báo band đã được hủy bỏ.</p>
                    ${adminNote ? `<p><strong>Ghi chú từ Admin:</strong> ${escapeHtml(adminNote)}</p>` : ''}
                    <p>Vui lòng tuân thủ đúng chính sách để tránh vi phạm trong tương lai.</p>
                    <p>Xin cảm ơn!</p>
                </div>`,
                type: 'appeal_approved'
            });

            console.log(`✅ [APPEAL] Admin ${req.admin.username} đã CHẤP THUẬN kháng cáo ${appealId} của ${appeal.username}`);

            return res.json({
                success: true,
                message: 'Đã chấp thuận kháng cáo. Band đã được hủy.',
                action
            });

        } else {
            if (band) {
                await client.query(
                    `UPDATE ${BAND_SCHEDULES_TABLE} SET status = 'rejected' WHERE id = $1`,
                    [band.id]
                );

                if (now >= Number(band.scheduled_at)) {
                    await client.query(
                        `UPDATE users SET status = 'banned' WHERE LOWER(username) = LOWER($1)`,
                        [appeal.username]
                    );
                    await client.query(
                        `UPDATE ${BAND_SCHEDULES_TABLE} SET status = 'executed' WHERE id = $1`,
                        [band.id]
                    );
                    await client.query(
                        `DELETE FROM sessions WHERE LOWER(username) = LOWER($1)`,
                        [appeal.username]
                    );
                    console.log(`🔒 [BAND] User ${appeal.username} bị KHÓA ngay`);
                }
            }

            await client.query(
                `UPDATE notification_recipients
                 SET appeal_status = 'rejected'
                 WHERE notification_id IN (SELECT id FROM notifications WHERE band_id = $1)
                   AND LOWER(username) = LOWER($2)`,
                [appeal.band_id, appeal.username]
            );

            await client.query('COMMIT');

            const shouldBandNow = band && now >= Number(band.scheduled_at);

            await createUserNotification({
                username: appeal.username,
                title: shouldBandNow ? '🚫 Tài khoản đã bị khóa' : '❌ Kháng cáo bị từ chối',
                contentHtml: `<div style="line-height: 1.7;">
                    <p><strong style="color: #ef4444;">Kháng cáo của bạn đã bị TỪ CHỐI</strong></p>
                    ${adminNote ? `<p><strong>Lý do:</strong> ${escapeHtml(adminNote)}</p>` : ''}
                    ${shouldBandNow
                        ? '<p>Tài khoản của bạn đã bị khóa do hết hạn kháng cáo.</p>'
                        : `<p>Tài khoản sẽ bị khóa vào <strong>${band ? new Date(Number(band.scheduled_at)).toLocaleString('vi-VN') : 'thời gian sắp tới'}</strong>.</p>`}
                    <p>Xin cảm ơn!</p>
                </div>`,
                type: 'appeal_rejected'
            });

            console.log(`❌ [APPEAL] Admin ${req.admin.username} đã TỪ CHỐI kháng cáo ${appealId} của ${appeal.username}`);

            return res.json({
                success: true,
                message: 'Đã từ chối kháng cáo.' + (shouldBandNow ? ' Tài khoản đã bị khóa.' : ''),
                action
            });
        }

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('appeals/review error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    } finally {
        client.release();
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 48: INIT NOTIFICATION & BAND TABLES
   ═══════════════════════════════════════════════════════════════════════════ */

async function initNotificationTables() {
    console.log('🔄 [Notification] Đang kiểm tra & khởi tạo bảng...');
    const client = await pool.connect();
    try {
        // ================== BƯỚC 1: BẢNG notifications ==================
        const { rows: notifTableCheck } = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'notifications'
        `);

        if (notifTableCheck.length === 0) {
            console.log('📦 [Notification] Bảng notifications chưa tồn tại, đang tạo mới...');
            await client.query(`
                CREATE TABLE notifications (
                    id SERIAL PRIMARY KEY,
                    title TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    content_html TEXT,
                    content_text TEXT,
                    target_type VARCHAR(20) DEFAULT 'all',
                    target_usernames TEXT[],
                    sent_by TEXT NOT NULL,
                    total_recipients INTEGER DEFAULT 0,
                    total_sent INTEGER DEFAULT 0,
                    total_failed INTEGER DEFAULT 0,
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT NOW(),
                    completed_at TIMESTAMP
                );
            `);
        } else {
            console.log('✅ [Notification] Bảng notifications đã tồn tại.');
        }

        // ================== BƯỚC 2: BẢNG notification_recipients ==================
        const { rows: recipTableCheck } = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'notification_recipients'
        `);

        if (recipTableCheck.length === 0) {
            console.log('📦 [Notification] Bảng notification_recipients chưa tồn tại, đang tạo mới...');
            await client.query(`
                CREATE TABLE notification_recipients (
                    id SERIAL PRIMARY KEY,
                    notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
                    username TEXT NOT NULL,
                    email TEXT NOT NULL,
                    read_status VARCHAR(20) DEFAULT 'unread',
                    email_status VARCHAR(20) DEFAULT 'pending',
                    error_message TEXT,
                    sent_at TIMESTAMP
                );
            `);
        } else {
            const existingCols = recipTableCheck.map(c => c.column_name);
            const requiredCols = ['id', 'notification_id', 'username', 'email', 'read_status', 'email_status', 'error_message', 'sent_at'];
            const missingCols = requiredCols.filter(c => !existingCols.includes(c));

            if (missingCols.length > 0) {
                console.warn(`⚠️ [Notification] Bảng notification_recipients thiếu cột: ${missingCols.join(', ')}`);
                console.warn('🔄 [Notification] Đang xóa và tạo lại bảng notification_recipients...');
                await client.query(`DROP TABLE IF EXISTS notification_recipients CASCADE;`);
                await client.query(`
                    CREATE TABLE notification_recipients (
                        id SERIAL PRIMARY KEY,
                        notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
                        username TEXT NOT NULL,
                        email TEXT NOT NULL,
                        read_status VARCHAR(20) DEFAULT 'unread',
                        email_status VARCHAR(20) DEFAULT 'pending',
                        error_message TEXT,
                        sent_at TIMESTAMP
                    );
                `);
            } else {
                console.log('✅ [Notification] Bảng notification_recipients đã đúng cấu trúc.');
            }
        }

        // ================== BƯỚC 3: BẢNG email_unsubscribes ==================
        const { rows: unsubTableCheck } = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'email_unsubscribes'
        `);

        if (unsubTableCheck.length === 0) {
            console.log('📦 [Notification] Bảng email_unsubscribes chưa tồn tại, đang tạo mới...');
            await client.query(`
                CREATE TABLE email_unsubscribes (
                    id SERIAL PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    reason TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);
        } else {
            console.log('✅ [Notification] Bảng email_unsubscribes đã tồn tại.');
        }

        // ================== BƯỚC 4: TẠO INDEX ==================
        console.log('🔧 [Notification] Đang tạo index...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_notif_recipients_notif ON notification_recipients(notification_id);
            CREATE INDEX IF NOT EXISTS idx_unsub_email ON email_unsubscribes(LOWER(email));
        `);

        // ================== BƯỚC 5: THÊM CỘT MỚI CHO BAND SYSTEM ==================
        console.log('🔧 [Notification] Đang thêm cột cho Band System...');

        await client.query(`
            ALTER TABLE notifications 
                ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'general',
                ADD COLUMN IF NOT EXISTS band_id VARCHAR(64);
        `);

        await client.query(`
            ALTER TABLE notification_recipients
                ADD COLUMN IF NOT EXISTS appeal_status VARCHAR(20),
                ADD COLUMN IF NOT EXISTS has_appealed BOOLEAN DEFAULT FALSE;
        `);

        console.log('✅ [Notification] Đã thêm cột type/band_id/appeal_status/has_appealed.');

        // ================== BƯỚC 6: TẠO BẢNG BAND ==================
        console.log('🔧 [Notification] Đang tạo bảng band_schedules & band_appeals...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS band_schedules (
                id VARCHAR(64) PRIMARY KEY,
                username VARCHAR(100) NOT NULL,
                reason TEXT NOT NULL,
                scheduled_at BIGINT NOT NULL,
                created_at BIGINT NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                appeal_id VARCHAR(64),
                created_by VARCHAR(100),
                cancelled_at BIGINT,
                cancelled_reason VARCHAR(50)
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS band_appeals (
                id VARCHAR(64) PRIMARY KEY,
                band_id VARCHAR(64) NOT NULL,
                username VARCHAR(100) NOT NULL,
                content TEXT NOT NULL,
                confirmed BOOLEAN DEFAULT TRUE,
                status VARCHAR(20) DEFAULT 'pending',
                created_at BIGINT NOT NULL,
                reviewed_at BIGINT,
                reviewed_by VARCHAR(100),
                admin_note TEXT
            );
        `);

        // ================== BƯỚC 7: INDEX BAND ==================
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_band_username ON band_schedules(LOWER(username));
            CREATE INDEX IF NOT EXISTS idx_band_status ON band_schedules(status);
            CREATE INDEX IF NOT EXISTS idx_band_scheduled ON band_schedules(scheduled_at);
            CREATE INDEX IF NOT EXISTS idx_appeal_band ON band_appeals(band_id);
            CREATE INDEX IF NOT EXISTS idx_appeal_username ON band_appeals(LOWER(username));
            CREATE INDEX IF NOT EXISTS idx_appeal_status ON band_appeals(status);
        `);

        console.log('✅ [Notification] Band System migration hoàn tất!');
        console.log('🎉 [Notification] Đã khởi tạo & kiểm tra toàn bộ bảng thành công!');

    } catch (err) {
        console.error('❌ [Notification] Lỗi khởi tạo bảng:', err.message);
        console.error('❌ Chi tiết:', err.stack);
    } finally {
        client.release();
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 49: BAND CRON — TỰ ĐỘNG KHÓA USER QUÁ HẠN 7 NGÀY
   ═══════════════════════════════════════════════════════════════════════════ */

async function checkAndExecuteBands() {
    try {
        const now = Date.now();

        const { rows: dueBands } = await pool.query(
            `SELECT * FROM ${BAND_SCHEDULES_TABLE}
             WHERE status IN ('pending', 'appealing')
               AND scheduled_at <= $1`,
            [now]
        );

        if (dueBands.length === 0) return;

        console.log(`⏰ [BAND CRON] Có ${dueBands.length} band đến hạn xử lý`);

        for (const band of dueBands) {
            const { rows: appealRows } = await pool.query(
                `SELECT status FROM ${BAND_APPEALS_TABLE}
                 WHERE band_id = $1 AND status IN ('pending', 'approved')`,
                [band.id]
            );

            if (appealRows.length > 0) {
                const appealStatus = appealRows[0].status;
                if (appealStatus === 'approved') {
                    await pool.query(
                        `UPDATE ${BAND_SCHEDULES_TABLE} 
                         SET status = 'cancelled', cancelled_reason = 'appeal_approved'
                         WHERE id = $1`,
                        [band.id]
                    );
                }
                // Nếu appealStatus === 'pending' → chờ admin duyệt, chưa band
                continue;
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                await client.query(
                    `UPDATE users SET status = 'banned' WHERE LOWER(username) = LOWER($1)`,
                    [band.username]
                );

                await client.query(
                    `DELETE FROM sessions WHERE LOWER(username) = LOWER($1)`,
                    [band.username]
                );

                await client.query(
                    `UPDATE ${BAND_SCHEDULES_TABLE} SET status = 'executed' WHERE id = $1`,
                    [band.id]
                );

                await client.query('COMMIT');

                await createUserNotification({
                    username: band.username,
                    title: '🚫 Tài khoản của bạn đã bị khóa',
                    contentHtml: `<p>Tài khoản của bạn đã bị khóa vì vi phạm chính sách.</p><p>Lý do: ${escapeHtml(band.reason)}</p>`,
                    type: 'band_executed'
                });

                console.log(`🔒 [BAND] Đã tự động khóa tài khoản ${band.username} (quá hạn 7 ngày)`);

            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`❌ [BAND] Lỗi xử lý band ${band.id}:`, err.message);
            } finally {
                client.release();
            }
        }
    } catch (err) {
        console.error('checkAndExecuteBands error:', err.message);
    }
}

// Chạy cron mỗi 1 giờ
setInterval(() => {
    checkAndExecuteBands().catch(err => console.error('Band cron error:', err.message));
}, 60 * 60 * 1000);

// Chạy lần đầu sau 30s khi server start
setTimeout(() => {
    checkAndExecuteBands().catch(err => console.error('Band init check error:', err.message));
}, 30000);

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 50: GLOBAL CLEANUP CRONS
   ═══════════════════════════════════════════════════════════════════════════ */

setInterval(() => {
    cleanupExpiredKeys().catch(err => console.error('cleanupExpiredKeys error:', err.message));
}, CLEANUP_INTERVAL_MS);

setInterval(() => {
    migratePlaintextPasswords().catch(err => console.error('migratePassword error:', err.message));
}, 60 * 60 * 1000);

setInterval(async () => {
    try {
        const { rowCount } = await pool.query(`
            DELETE FROM sessions
            WHERE expires_at < NOW()
               OR (NOW() - last_activity) > INTERVAL '60 minutes'
        `);
        if (rowCount > 0) console.log(`🧹 Đã dọn ${rowCount} session hết hạn.`);
    } catch (err) {
        console.error('Lỗi cleanup sessions:', err.message);
    }
}, 10 * 60 * 1000);

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 51: 404 & GLOBAL ERROR HANDLERS
   ═══════════════════════════════════════════════════════════════════════════ */

app.use((req, res) => res.status(404).json({ error: 'API không tồn tại: ' + req.path }));

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Hệ thống đang gặp sự cố, vui lòng thử lại sau.' });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 52: START SERVER
   ═══════════════════════════════════════════════════════════════════════════ */

async function startServer() {
    await initDB();
    await initTuTienCheckinHistory();
    await initNotificationTables();

    const server = app.listen(PORT, async () => {
        console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
        console.log(`║   🚀 TYON SERVER v3.0 — ULTIMATE PLATINUM EDITION              ║`);
        console.log(`╚══════════════════════════════════════════════════════════════╝`);
        console.log(`🌐 Server: http://localhost:${PORT}`);
        console.log(`🔐 JWT Security: BẬT`);
        console.log(`🛡️  Rate Limit: BẬT`);
        console.log(`📧 Email (Gmail API): ${process.env.GMAIL_CLIENT_ID ? '✅ Đã cấu hình' : '❌ CHƯA cấu hình'}`);
        console.log(`📨 Telegram Bot: ${TELEGRAM_ENABLED ? '✅ Đã cấu hình' : '❌ CHƯA'}`);
        console.log(`☁️  Storage Keys/Feedbacks: ${USE_GIST ? 'GitHub Gist' : 'LOCAL FILE'}`);
        console.log(`🗄️  Storage Users/Orders/Sessions: Supabase`);
        console.log(`💳 SePay: ${SEPAY_CONFIGURED ? '✅ Đã cấu hình' : '❌ CHƯA'}`);
        console.log(`🔑 Google OAuth: ${GOOGLE_CLIENT_ID ? '✅ Đã cấu hình' : '❌ CHƯA'}`);
        console.log(`🚫 Band System: ✅ BẬT (7 ngày + kháng cáo)`);
        console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
        console.log(`🏦 Bank: ${SEPAY_BANK_CODE} - ${SEPAY_BANK_ACCOUNT}\n`);

        if (TELEGRAM_ENABLED) {
            const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
            if (baseUrl.startsWith('https://')) {
                await registerTelegramWebhook(baseUrl);
            } else {
                console.warn('⚠️ BASE_URL không phải HTTPS — bỏ qua đăng ký Telegram webhook');
            }
        }
    });

    let shutting = false;
    async function shutdown(sig) {
        if (shutting) return;
        shutting = true;
        console.log(`\n👋 Nhận ${sig}, đang tắt server...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000).unref();
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
        console.error('❌ Uncaught:', err);
        setTimeout(() => process.exit(1), 2000);
    });
    process.on('unhandledRejection', (err) => console.error('❌ Unhandled:', err));
}

startServer();








