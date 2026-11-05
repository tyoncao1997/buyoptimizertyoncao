// ==========================================
// TYON OPTIMIZER - SECURE SERVER (STATELESS) - PRODUCTION READY
// ==========================================
require('dotenv').config();

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
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');

const BCRYPT_ROUNDS = 10;

// ==========================================
// 1. SUPABASE POOL
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});
pool.on('error', (err) => console.error('❌ Pool error:', err.message));

// ==========================================
// 2. MAILER + SEND EMAIL
// ==========================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendEmail(to, subject, htmlContent) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.warn('⚠️ Chưa cấu hình EMAIL_USER/EMAIL_PASS, không thể gửi mail.');
        return false;
    }
    try {
        await transporter.sendMail({
            from: `"${process.env.EMAIL_FROM_NAME || 'TYONCAO GLOBAL OPTIMIZER'}" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html: htmlContent
        });
        console.log(`✅ Đã gửi email đến ${to}: ${subject}`);
        return true;
    } catch (error) {
        console.error('❌ Lỗi gửi email:', error.message);
        return false;
    }
}

// ==========================================
// 3. ⭐ OTP STORES + HELPERS (KHAI BÁO TRƯỚC KHI DÙNG)
// ==========================================
const registerOtpStore = new Map();
const otpStore = new Map();

const OTP_TTL_MS = 5 * 60 * 1000;             // 5 phút
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;     // 60s
const OTP_MAX_ATTEMPTS = 5;
const RESET_OTP_TTL_MS = 15 * 60 * 1000;      // 15 phút

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
function isValidEmail(email) {
    return typeof email === 'string' && /^\S+@\S+\.\S+$/.test(email);
}
function isValidUsername(username) {
    return typeof username === 'string' && username.length >= 4 && /^[a-zA-Z0-9_]+$/.test(username);
}

// Dọn OTP hết hạn mỗi 5 phút
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of registerOtpStore.entries()) {
        if (now > v.expiresAt) registerOtpStore.delete(k);
    }
    for (const [k, v] of otpStore.entries()) {
        if (now > v.expiresAt) otpStore.delete(k);
    }
}, 5 * 60 * 1000).unref();

// ==========================================
// 4. TEMPLATE EMAIL (HTML)
// ==========================================
const emailTemplates = {
    welcome: (fullName, username) => `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 10px; border: 1px solid #ddd;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #2c3e50; margin: 0;">TYONCAO GLOBAL OPTIMIZER</h1>
                <p style="color: #7f8c8d; font-size: 12px;">tyonoptimizer.infinityfreeapp.com</p>
            </div>
            <div style="background: #fff; padding: 20px; border-radius: 8px;">
                <h2 style="color: #27ae60;">Xin chào quý khách ${fullName}!</h2>
                <p style="font-size: 14px; line-height: 1.6; color: #333;">
                    Cảm ơn quý khách đã tin tưởng và trở thành người dùng thân cận của <strong>TyonCao Global Optimizer</strong>.
                </p>
                <p style="font-size: 14px; line-height: 1.6; color: #333;">
                    Tài khoản của quý khách đã được kích hoạt với username: <strong>${username}</strong>.
                </p>
                <p style="font-size: 14px; line-height: 1.6; color: #333;">
                    Nếu có bất kỳ câu hỏi nào, xin vui lòng <a href="https://api.whatsapp.com/send/?phone=84978568965" style="color: #3498db; text-decoration: none; font-weight: bold;">liên hệ với chúng tôi</a>.
                </p>
                <p style="font-size: 14px; line-height: 1.6; color: #333; margin-top: 30px;">
                    Trân trọng,<br><strong>Đội ngũ TyonCao Global Optimizer</strong>
                </p>
            </div>
            <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #95a5a6;">
                <p>TYON CAO GLOBAL OPTIMIZER</p>
                <p>TYONCGO247 | (+84) 97 8568 965</p>
            </div>
        </div>
    `,

    kycSuccess: (fullName) => `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 10px; border: 1px solid #ddd;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #2c3e50; margin: 0;">TYONCAO GLOBAL OPTIMIZER</h1>
            </div>
            <div style="background: #fff; padding: 20px; border-radius: 8px;">
                <h2 style="color: #27ae60;">Xác thực danh tính thành công!</h2>
                <p style="font-size: 14px; line-height: 1.6; color: #333;">Xin chào <strong>${fullName}</strong>,</p>
                <p style="font-size: 14px; line-height: 1.6; color: #333;">
                    Chúc mừng bạn! Yêu cầu xác minh danh tính (KYC) của bạn đã được <strong>phê duyệt thành công</strong>.
                </p>
                <p style="font-size: 14px; line-height: 1.6; color: #333; margin-top: 30px;">
                    Trân trọng,<br><strong>Đội ngũ TyonCao Global Optimizer</strong>
                </p>
            </div>
        </div>
    `,

    forgotPassword: (fullName, otp) => `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 10px; border: 1px solid #ddd;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #2c3e50; margin: 0;">TYONCAO GLOBAL OPTIMIZER</h1>
            </div>
            <div style="background: #fff; padding: 20px; border-radius: 8px;">
                <h2 style="color: #e67e22;">Yêu cầu đặt lại mật khẩu</h2>
                <p style="font-size: 14px; line-height: 1.6; color: #333;">Xin chào <strong>${fullName}</strong>,</p>
                <p style="font-size: 14px; line-height: 1.6; color: #333;">
                    Vui lòng sử dụng mã xác thực dưới đây để tiếp tục:
                </p>
                <div style="text-align: center; margin: 30px 0;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #e67e22; background: #fef5e7; padding: 10px 20px; border-radius: 5px;">${otp}</span>
                </div>
                <p style="font-size: 14px; line-height: 1.6; color: #333;">
                    Mã này sẽ hết hạn sau 15 phút. Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.
                </p>
                <p style="font-size: 14px; line-height: 1.6; color: #333; margin-top: 30px;">
                    Trân trọng,<br><strong>Đội ngũ TyonCao Global Optimizer</strong>
                </p>
            </div>
        </div>
    `,

    purchaseInvoice: (order) => `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 10px; border: 1px solid #ddd;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #2c3e50; margin: 0;">TYONCAO GLOBAL OPTIMIZER</h1>
                <p style="color: #7f8c8d; font-size: 12px;">tyonoptimizer.infinityfreeapp.com</p>
            </div>
            <div style="background: #fff; padding: 20px; border-radius: 8px; border-top: 4px solid #2c3e50;">
                <h2 style="color: #2c3e50; text-align: center;">THÔNG BÁO GIAO DỊCH THÀNH CÔNG</h2>
                <p style="font-size: 14px; line-height: 1.6; color: #333; text-align: center;">
                    Cảm ơn Quý khách đã sử dụng dịch vụ TyonCao Shop.
                </p>
                <table style="width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px;">
                    <tr style="background: #f2f2f2;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Mã đơn hàng</td><td style="padding: 10px; border: 1px solid #ddd;">${order.orderCode}</td></tr>
                    <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Tên khách hàng</td><td style="padding: 10px; border: 1px solid #ddd;">${order.customerName}</td></tr>
                    <tr style="background: #f2f2f2;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Gói dịch vụ</td><td style="padding: 10px; border: 1px solid #ddd;">${order.planName}</td></tr>
                    <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Số tiền</td><td style="padding: 10px; border: 1px solid #ddd; color: #e74c3c; font-weight: bold;">${new Intl.NumberFormat('vi-VN').format(order.amount)} VNĐ</td></tr>
                    <tr style="background: #f2f2f2;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Thời gian</td><td style="padding: 10px; border: 1px solid #ddd;">${new Date(order.paidAt).toLocaleString('vi-VN')}</td></tr>
                    <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Mã giao dịch</td><td style="padding: 10px; border: 1px solid #ddd;">${order.transactionId || 'N/A'}</td></tr>
                    <tr style="background: #f2f2f2;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Key</td><td style="padding: 10px; border: 1px solid #ddd; color: #2980b9; font-weight: bold;">${order.key}</td></tr>
                </table>
                <p style="font-size: 14px; line-height: 1.6; color: #333; margin-top: 20px; text-align: center;">Xin chân thành cảm ơn.</p>
            </div>
            <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #95a5a6;">
                <p><strong>TYON CAO GLOBAL OPTIMIZER</strong></p>
                <p>TYONCGO247 | (+84) 97 8568 965</p>
            </div>
        </div>
    `
};

// ==========================================
// 5. APP + CẤU HÌNH CHUNG
// ==========================================
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://buyoptimizertc.infinityfreeapp.com';

// ⭐ HẰNG SỐ SESSION - PHẢI KHAI BÁO TRƯỚC requireUserSession
const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;             // 60 phút
const SESSION_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

// ⭐ GOOGLE OAUTH - KHAI BÁO SỚM
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠️ Thiếu GOOGLE_CLIENT_ID - chức năng đăng nhập Google sẽ không hoạt động');
}
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const ALLOWED_ADMIN_EMAILS = (process.env.ALLOWED_ADMIN_EMAILS || 'caoquangtuan97@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ⭐ R2
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

// ==========================================
// 6. BẢO MẬT CƠ BẢN
// ==========================================
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 200,
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
const pollingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 500,
    message: { error: 'Quá nhiều request. Vui lòng thử lại sau.' }
});

// ⭐ THỨ TỰ QUAN TRỌNG: specific trước, general sau
app.use('/api/order-status/', pollingLimiter);
app.use('/api/admin/', adminLimiter);
app.use('/api/', globalLimiter);

// ==========================================
// 7. GIST + LOCAL STORAGE
// ==========================================
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

// ==========================================
// 8. SUPABASE HELPERS
// ==========================================
async function getOrdersFromSupabase() {
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        return rows.map(o => ({
            orderCode: o.order_code, key: o.key, plan: o.plan, planName: o.plan_name,
            customerName: o.customer_name, amount: Number(o.amount), status: o.status,
            createdAt: o.created_at, paidAt: o.paid_at, paidAmount: Number(o.paid_amount || 0),
            transactionId: o.transaction_id, sepayTransactionId: o.sepay_transaction_id,
            confirmedBy: o.confirmed_by, note: o.note || ''
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
                                sepay_transaction_id, confirmed_by, note)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            ON CONFLICT (order_code) DO UPDATE SET
                status = EXCLUDED.status,
                paid_at = EXCLUDED.paid_at,
                paid_amount = EXCLUDED.paid_amount,
                transaction_id = EXCLUDED.transaction_id,
                sepay_transaction_id = EXCLUDED.sepay_transaction_id,
                confirmed_by = EXCLUDED.confirmed_by,
                note = EXCLUDED.note;
        `, [
            order.orderCode, order.key, order.plan, order.planName || null,
            order.customerName || null, order.amount, order.status || 'pending',
            order.createdAt || new Date().toISOString(), order.paidAt || null,
            order.paidAmount || 0, order.transactionId || null,
            order.sepayTransactionId || null, order.confirmedBy || null, order.note || ''
        ]);
        return true;
    } catch (err) {
        console.error('❌ Lỗi upsert order:', err.message);
        return false;
    }
}

async function getUserByUsername(username) {
    if (!username) return null;
    const { rows } = await pool.query(
        'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
        [username.trim()]
    );
    return rows[0] || null;
}

// ⭐ Parse JSON an toàn
function safeParseJSON(value, fallback = []) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value) || fallback; } catch { return fallback; }
    }
    return fallback;
}

// ==========================================
// 9. INIT DB + MIGRATE
// ==========================================
async function initDB() {
    if (!pool) return;
    try {
        const { rows } = await pool.query('SELECT COUNT(*) FROM users');
        console.log(`✅ Đã kết nối Supabase. Tổng số Users: ${rows[0].count}`);
    } catch (err) {
        console.error('❌ Lỗi kết nối Supabase:', err.message);
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

// ==========================================
// 10. CẤU HÌNH HỆ THỐNG - SECRETS
// ==========================================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_PIN = process.env.ADMIN_PIN;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_PIN || !JWT_SECRET) {
    console.error('❌ LỖI BẢO MẬT: Thiếu biến môi trường ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_PIN / JWT_SECRET');
    process.exit(1);
}

const PAY2S_PARTNER_CODE = process.env.PAY2S_PARTNER_CODE;
const PAY2S_ACCESS_KEY = process.env.PAY2S_ACCESS_KEY;
const PAY2S_SECRET_KEY = process.env.PAY2S_SECRET_KEY;
const PAY2S_API_URL = 'https://payment.pay2s.vn/v1/gateway/api/create';
const PAY2S_WEBHOOK_TOKEN = process.env.PAY2S_WEBHOOK_TOKEN || '';

const WEBHUB_WEBHOOK_TOKEN = process.env.WEBHUB_WEBHOOK_TOKEN || '';
const WEBHUB_API_BASE = process.env.WEBHUB_API_BASE || 'https://api.webhub.vn/v1';

const SEPAY_WEBHOOK_SECRET = process.env.SEPAY_WEBHOOK_SECRET;
const SEPAY_BANK_ACCOUNT = process.env.SEPAY_BANK_ACCOUNT;
const SEPAY_BANK_CODE = process.env.SEPAY_BANK_CODE;
const SEPAY_ACCOUNT_HOLDER = process.env.SEPAY_ACCOUNT_HOLDER;

if (!SEPAY_WEBHOOK_SECRET) console.warn('⚠️ Thiếu SEPAY_WEBHOOK_SECRET - Webhook SePay sẽ không hoạt động!');

// ==========================================
// 11. MIDDLEWARE CORS + BODY
// ==========================================
app.use(cors({
    origin: [
        FRONTEND_URL,
        'https://buyoptimizertc.infinityfreeapp.com',
        'https://buyoptimizertyoncao.onrender.com',
        'https://dashboardtc.infinityfreeapp.com',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// ⭐ SePay webhook cần raw body — đăng ký TRƯỚC express.json
app.post('/api/sepay-webhook', express.raw({ type: 'application/json' }), handleSePayWebhook);

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ==========================================
// 12. USER SESSION MIDDLEWARE
// ==========================================
async function requireUserSession(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Chưa đăng nhập', code: 'NO_TOKEN' });
        }
        const token = authHeader.substring(7);
        const { rows } = await pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Phiên không hợp lệ', code: 'INVALID_TOKEN' });
        }
        const session = rows[0];
        const now = Date.now();
        const lastActivity = new Date(session.last_activity).getTime();
        const createdAt = new Date(session.created_at).getTime();
        const expiresAt = session.expires_at ? new Date(session.expires_at).getTime() : null;

        if (now - lastActivity > SESSION_IDLE_TIMEOUT_MS) {
            return res.status(401).json({ success: false, error: 'Phiên đã hết hạn do không hoạt động quá 60 phút.', code: 'IDLE_TIMEOUT' });
        }
        if (now - createdAt > SESSION_ABSOLUTE_TIMEOUT_MS || (expiresAt && now > expiresAt)) {
            await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
            return res.status(401).json({ success: false, error: 'Phiên đã hết hạn tuyệt đối. Vui lòng đăng nhập lại.', code: 'ABSOLUTE_TIMEOUT' });
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

// ==========================================
// 13. ADMIN AUTH
// ==========================================
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

// ⭐ So sánh token an toàn (timing-safe)
function safeCompareToken(input, expected) {
    if (!input || !expected) return false;
    try {
        const a = Buffer.from(input);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

// ==========================================
// 14. HELPERS
// ==========================================
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

async function cleanupExpiredKeys() {
    let deletedCount = 0;
    const db = await readStorage();
    const before = db.keys.length;
    db.keys = db.keys.filter(k => {
        if (k.status !== 'pending') return true;
        const age = Date.now() - new Date(k.createdAt).getTime();
        return age <= KEY_EXPIRE_MS;
    });
    deletedCount = before - db.keys.length;
    if (deletedCount > 0) {
        await writeStorage(db);
        console.log(`🧹 Đã xóa ${deletedCount} key pending hết hạn.`);
    }
    if (pool) {
        try {
            const expireBefore = new Date(Date.now() - KEY_EXPIRE_MS).toISOString();
            const { rowCount } = await pool.query(
                `DELETE FROM orders WHERE status = 'pending' AND created_at < $1`,
                [expireBefore]
            );
            if (rowCount > 0) {
                console.log(`🧹 Đã XÓA VĨNH VIỄN ${rowCount} orders pending quá hạn.`);
                deletedCount += rowCount;
            }
        } catch (err) {
            console.error('❌ Lỗi xóa orders:', err.message);
        }
    }
    return { deletedCount };
}

// ==========================================
// 15. ADMIN: GOOGLE LOGIN + CONFIG
// ==========================================
app.post('/api/admin/google-login', loginLimiter, async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) return res.status(400).json({ success: false, error: 'Thiếu credential' });

        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = (payload.email || '').toLowerCase();

        if (!payload.email_verified) return res.status(401).json({ success: false, error: 'Email chưa xác thực' });
        if (!ALLOWED_ADMIN_EMAILS.includes(email)) {
            console.warn(`🚫 [Admin] Từ chối email không có quyền: ${email}`);
            return res.status(403).json({ success: false, error: `Email ${email} không có quyền admin` });
        }

        const token = jwt.sign(
            { username: email, email, name: payload.name, picture: payload.picture, role: 'admin', method: 'google' },
            JWT_SECRET, { expiresIn: '8h' }
        );
        console.log(`✅ [Admin Login] ${email} - IP=${req.ip}`);
        res.json({ success: true, token, email });
    } catch (err) {
        console.error('❌ Google login error:', err.message);
        res.status(401).json({ success: false, error: 'Xác thực Google thất bại' });
    }
});

app.get('/api/config', (req, res) => {
    res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
});

// ==========================================
// 16. ADMIN STATS + REVENUE
// ==========================================
app.post('/api/admin/stats', requireAdminToken, async (req, res) => {
    try {
        const { rows: kycRows } = await pool.query("SELECT COUNT(*) FROM users WHERE kyc_status = 'pending'");
        const kycPending = Number(kycRows[0].count);

        const { rows: allUsers } = await pool.query('SELECT * FROM users');
        const totalUsers = allUsers.length;

        let cashIn = 0, actualRevenue = 0, totalIncurred = 0;
        const spenderMap = new Map();

        allUsers.forEach(u => {
            const deposits = safeParseJSON(u.deposit_history);
            deposits.forEach(d => {
                const amt = Number(d.amount || 0);
                if (d.method === 'refund_rejected_order' || d.method === 'admin_refund') totalIncurred += amt;
                else if (d.status === 'success' || !d.status) cashIn += amt;
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
        const paidOrdersList = orderRows.filter(o => o.status === 'paid');
        const pendingOrdersList = orderRows.filter(o => o.status === 'pending');
        const underpaidOrdersList = orderRows.filter(o => o.status === 'underpaid');
        const rejectedOrdersList = orderRows.filter(o => o.status === 'rejected' || o.status === 'cancelled');
        const pendingAmount = pendingOrdersList.reduce((sum, o) => sum + Number(o.amount), 0);

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
        const netProfit = actualRevenue - inputCost - totalIncurred;

        res.json({
            success: true, totalUsers, kycPending, totalFeedbacks,
            totalRevenue: actualRevenue, cashIn, incurred: totalIncurred,
            netProfit, inputCost, pendingAmount, totalOrders,
            pendingOrders: pendingOrdersList.length,
            paidOrders: paidOrdersList.length,
            underpaidOrdersList: underpaidOrdersList.length,
            revenue7d,
            orderStatus: {
                paid: paidOrdersList.length, pending: pendingOrdersList.length,
                underpaid: underpaidOrdersList.length, rejected: rejectedOrdersList.length,
                other: totalOrders - paidOrdersList.length - pendingOrdersList.length - underpaidOrdersList.length - rejectedOrdersList.length
            },
            recentOrders, topSpenders
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/revenue', requireAdminToken, async (req, res) => {
    try {
        const { period = '7d' } = req.body;
        const { rows: allUsers } = await pool.query('SELECT * FROM users');

        let daysLimit = 7;
        if (period === '30d') daysLimit = 30;
        else if (period === '90d') daysLimit = 90;
        else if (period === 'all') daysLimit = 99999;

        const cutoff = Date.now() - daysLimit * 24 * 60 * 60 * 1000;

        let purchaseTotal = 0, depositTotal = 0;
        const chartMap = new Map();
        const transactions = [];

        allUsers.forEach(u => {
            const deposits = safeParseJSON(u.deposit_history);
            deposits.forEach(d => {
                const at = d.at || d.createdAt;
                if (!at || new Date(at).getTime() < cutoff) return;
                const amt = Number(d.amount) || 0;
                depositTotal += amt;
                transactions.push({ time: at, username: u.username, type: 'deposit', amount: amt, desc: d.method || 'nạp tiền' });
                const key = new Date(at).toISOString().slice(0, 10);
                chartMap.set(key, (chartMap.get(key) || 0) + amt);
            });

            const purchases = safeParseJSON(u.purchase_history);
            purchases.forEach(p => {
                const at = p.purchasedAt || p.createdAt;
                if (!at || new Date(at).getTime() < cutoff) return;
                const amt = Number(p.price) || 0;
                purchaseTotal += amt;
                transactions.push({ time: at, username: u.username, type: 'purchase', amount: amt, desc: p.productName || 'mua file' });
                const key = new Date(at).toISOString().slice(0, 10);
                chartMap.set(key, (chartMap.get(key) || 0) + amt);
            });
        });

        const chartData = [];
        const totalDays = Math.min(daysLimit, 30);
        for (let i = totalDays - 1; i >= 0; i--) {
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
            depositTotal, purchaseTotal, chartData,
            transactions: transactions.slice(0, 500)
        });
    } catch (err) {
        console.error('Admin revenue error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 17. ADMIN LOGIN
// ==========================================
app.post('/api/admin/login', loginLimiter, (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Thiếu thông tin đăng nhập' });
        if (!verifyAdmin(username, password)) {
            console.log(`🚫 [Login Failed] IP=${req.ip}`);
            return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
        }
        const token = jwt.sign({ username: ADMIN_USERNAME, role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        console.log(`✅ [Login Success] admin="${username}" IP=${req.ip}`);
        res.json({ success: true, token, expiresIn: JWT_EXPIRES_IN });
    } catch {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.post('/api/admin/verify-token', requireAdminToken, (req, res) => {
    res.json({ success: true, admin: { username: req.admin.username }, valid: true });
});

// ==========================================
// 18. CREATE ORDER + ORDER STATUS
// ==========================================
app.post('/api/create-order', async (req, res) => {
    try {
        const { plan, customerName, planName, amount } = req.body;
        if (!plan || !customerName || !amount) {
            return res.status(400).json({ success: false, error: 'Thiếu thông tin đơn hàng' });
        }
        const orderCode = generateOrderCode();
        const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
        const key = `TYON-${plan.toUpperCase()}-${randomPart}-${orderCode.slice(-6)}`;

        const newOrder = {
            orderCode, key, plan,
            planName: planName || plan.toUpperCase(),
            customerName,
            amount: parseInt(amount),
            status: 'pending',
            createdAt: new Date().toISOString(),
            paidAt: null, paidAmount: 0,
            transactionId: null, sepayTransactionId: null, note: ''
        };

        const saved = await upsertOrderToSupabase(newOrder);
        if (!saved) return res.status(500).json({ success: false, error: 'Không lưu được đơn hàng' });

        const qrContent = `SEVQR ${orderCode}`;
        const qrUrl = `https://img.vietqr.io/image/${SEPAY_BANK_CODE}-${SEPAY_BANK_ACCOUNT}-qr_only.png?amount=${amount}&addInfo=${encodeURIComponent(qrContent)}&accountName=${encodeURIComponent(SEPAY_ACCOUNT_HOLDER)}`;

        res.json({
            success: true, orderCode, key, amount: parseInt(amount),
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
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
        const o = rows[0];
        res.json({
            success: true, orderCode: o.order_code, status: o.status,
            key: o.status === 'paid' ? o.key : null,
            amount: Number(o.amount), paidAmount: Number(o.paid_amount || 0),
            paidAt: o.paid_at, planName: o.plan_name
        });
    } catch (err) {
        console.error('Lỗi check order:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// 19. SEPAY WEBHOOK — function đặt TRƯỚC app.post
// ==========================================
async function handleSePayWebhook(req, res) {
    try {
        const signature = req.headers['x-sepay-signature'];
        const timestamp = req.headers['x-sepay-timestamp'];
        if (!signature || !timestamp) return res.status(401).json({ success: false, error: 'Missing signature' });

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - parseInt(timestamp)) > 300) return res.status(401).json({ success: false, error: 'Request expired' });

        const rawBody = req.body.toString('utf8');
        const expectedSignature = 'sha256=' + crypto
            .createHmac('sha256', SEPAY_WEBHOOK_SECRET)
            .update(timestamp + '.' + rawBody).digest('hex');

        if (signature !== expectedSignature) {
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }

        const data = JSON.parse(rawBody);
        console.log('✅ SePay Webhook:', JSON.stringify(data, null, 2));

        if (data.transferType !== 'in') return res.status(200).json({ success: true, message: 'Ignored' });

        const amount = parseInt(data.transferAmount);
        const content = (data.content || '').toUpperCase().replace(/SEVQR\s*/g, '').trim();
        const transactionId = data.id || data.referenceCode || 'N/A';

        const { rows } = await pool.query(
            `SELECT * FROM orders WHERE status = 'pending' AND UPPER($1) LIKE '%' || UPPER(order_code) || '%' LIMIT 1`,
            [content]
        );
        if (rows.length === 0) {
            console.log(`⚠️ Không tìm thấy đơn pending khớp: "${content}"`);
            return res.status(200).json({ success: true, message: 'No matching order' });
        }

        const o = rows[0];
        const requiredAmount = Number(o.amount);

        if (amount >= requiredAmount) {
            await pool.query(
                `UPDATE orders SET status='paid', paid_at=$1, paid_amount=$2, transaction_id=$3, sepay_transaction_id=$4 WHERE order_code=$5`,
                [new Date().toISOString(), amount, transactionId, data.referenceCode || data.id, o.order_code]
            );
            console.log(`✅ ĐƠN ${o.order_code} ĐÃ THANH TOÁN! Key: ${o.key}`);
        } else {
            const note = `Thanh toán thiếu: cần ${requiredAmount}đ, nhận ${amount}đ`;
            await pool.query(
                `UPDATE orders SET status='underpaid', paid_amount=$1, transaction_id=$2, note=$3 WHERE order_code=$4`,
                [amount, transactionId, note, o.order_code]
            );
            console.log(`⚠️ ĐƠN ${o.order_code} THIẾU TIỀN!`);
        }
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('❌ Lỗi Webhook SePay:', error);
        return res.status(500).json({ success: false, error: 'Internal error' });
    }
}

// ==========================================
// 20. ADMIN: ORDERS
// ==========================================
app.post('/api/admin/orders', requireAdminToken, async (req, res) => {
    try {
        const orders = await getOrdersFromSupabase();
        res.json({ success: true, orders });
    } catch {
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/admin/confirm-order', requireAdminToken, async (req, res) => {
    try {
        const { pin, orderCode } = req.body;
        if (!verifyPin(pin)) return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });

        const { rows } = await pool.query('SELECT * FROM orders WHERE order_code = $1', [orderCode]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
        if (rows[0].status === 'paid') return res.status(400).json({ success: false, error: 'Đơn này đã xác nhận rồi' });

        const note = (rows[0].note || '') + ' | Admin xác nhận thủ công';
        await pool.query(
            `UPDATE orders SET status='paid', paid_at=$1, confirmed_by=$2, note=$3 WHERE order_code=$4`,
            [new Date().toISOString(), req.admin.username, note, orderCode]
        );

        console.log(`✅ [ADMIN] ${req.admin.username} xác nhận đơn ${orderCode}`);
        res.json({ success: true, message: `Đã xác nhận đơn ${orderCode}. Key đã kích hoạt!` });
    } catch (err) {
        console.error('Admin confirm order error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ⭐ REJECT ORDER — TRANSACTION + CHỈ HOÀN KHI ĐƠN ĐÃ THU TIỀN
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

            // ⭐ Chỉ hoàn tiền nếu đơn ĐÃ thu tiền (paid_amount > 0)
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
                        console.log(`💰 [REFUND] Hoàn ${paidAmount}đ cho ${user.username} (đơn ${orderCode})`);
                    }
                }
            } else {
                console.log(`ℹ️ [REJECT] Đơn ${orderCode} chưa thu tiền, không hoàn.`);
            }

            await client.query('COMMIT');
            return res.json({
                success: true,
                message: `Đã từ chối đơn ${orderCode}.${paidAmount > 0 ? ' Tiền đã được hoàn vào ví khách hàng.' : ''}`
            });
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Admin reject order error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    }
});

// ==========================================
// 21. ADMIN: KYC
// ==========================================
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
        res.status(500).json({ success: false, error: err.message });
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
                sendEmail(user.email, 'Xác thực danh tính thành công - TyonCao Global Optimizer',
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
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    }
});

// ==========================================
// 22. ADMIN: ADD BALANCE — TRANSACTION
// ==========================================
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
            console.log(`💰 [AUDIT] ${req.admin.username} cộng ${addAmount}đ cho ${targetUsername} (${oldBalance} → ${newBalance})`);

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
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    }
});

// ==========================================
// 23. USER AUTH: SEND OTP (DUY NHẤT)
// ==========================================
app.post('/api/send-otp', async (req, res) => {
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

        const mailSent = await sendEmail(
            emailKey,
            'Mã OTP đăng ký tài khoản - TYON Optimizer',
            `
            <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:20px;border:1px solid #ddd;border-radius:10px;">
                <h2 style="color:#2c3e50;text-align:center">Xác thực đăng ký</h2>
                <p>Mã OTP của bạn là:</p>
                <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#e67e22;text-align:center">${otp}</p>
                <p>Mã có hiệu lực <b>5 phút</b>. Không chia sẻ mã này cho ai.</p>
                <p style="color:#888;font-size:12px">Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>
            </div>
            `
        );

        if (!mailSent) {
            registerOtpStore.delete(emailKey);
            return res.status(500).json({ success: false, error: 'Không gửi được email, vui lòng thử lại sau' });
        }
        return res.json({ success: true, message: 'Đã gửi OTP tới email của bạn' });
    } catch (err) {
        console.error('send-otp error:', err);
        return res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// Alias tương thích ngược
app.post('/api/send-register-otp', (req, res, next) => {
    req.url = '/api/send-otp';
    app._router.handle(req, res, next);
});

// ==========================================
// 24. USER AUTH: REGISTER (CÓ OTP)
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, fullName, email, otp } = req.body || {};

        if (!username || !password || !fullName || !email || !otp) {
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
        if (password.length < 6) return res.status(400).json({ success: false, error: 'Mật khẩu phải ≥6 ký tự' });
        if (fullNameTrim.length < 2) return res.status(400).json({ success: false, error: 'Họ tên quá ngắn' });

        const storedOtp = registerOtpStore.get(emailKey);
        if (!storedOtp) return res.status(400).json({ success: false, error: 'Vui lòng yêu cầu gửi mã OTP trước!' });
        if (Date.now() > storedOtp.expiresAt) {
            registerOtpStore.delete(emailKey);
            return res.status(400).json({ success: false, error: 'Mã OTP đã hết hạn. Vui lòng gửi lại!' });
        }
        if (storedOtp.attempts >= OTP_MAX_ATTEMPTS) {
            registerOtpStore.delete(emailKey);
            return res.status(400).json({ success: false, error: 'Nhập sai OTP quá nhiều lần. Vui lòng gửi lại!' });
        }
        if (storedOtp.otp !== otpTrim) {
            storedOtp.attempts += 1;
            registerOtpStore.set(emailKey, storedOtp);
            return res.status(400).json({
                success: false,
                error: `Mã OTP không chính xác! Còn ${OTP_MAX_ATTEMPTS - storedOtp.attempts} lần thử.`
            });
        }

        const { rows: dup } = await pool.query(
            'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
            [usernameTrim, emailTrim]
        );
        if (dup.length > 0) return res.status(400).json({ success: false, error: 'Username hoặc Email đã tồn tại' });

        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

        await pool.query(
            `INSERT INTO users (username, password, full_name, email, balance, purchase_history, deposit_history, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [usernameTrim, hashedPassword, fullNameTrim, emailTrim, 0, JSON.stringify([]), JSON.stringify([])]
        );

        registerOtpStore.delete(emailKey);

        sendEmail(
            emailTrim,
            'Chào mừng bạn đến với TyonCao Global Optimizer!',
            emailTemplates.welcome(fullNameTrim, usernameTrim)
        ).catch(err => console.error('Lỗi gửi mail welcome:', err));

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TIMEOUT_MS);
        await pool.query(
            `INSERT INTO sessions (username, token, last_activity, created_at, expires_at)
             VALUES ($1, $2, NOW(), NOW(), $3)`,
            [usernameTrim, sessionToken, expiresAt]
        );

        return res.json({
            success: true,
            message: 'Đăng ký thành công',
            user: { username: usernameTrim, fullName: fullNameTrim, email: emailTrim, balance: 0 },
            sessionToken,
            expiresAt: expiresAt.toISOString()
        });
    } catch (err) {
        console.error('Register error:', err);
        if (err.code === '23505') return res.status(400).json({ success: false, error: 'Username hoặc Email đã tồn tại' });
        return res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// 25. FORGOT / RESET PASSWORD
// ==========================================
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

        await sendEmail(
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
        if (newPassword.length < 6) return res.status(400).json({ success: false, error: 'Mật khẩu phải ≥6 ký tự' });

        const record = otpStore.get(email.trim().toLowerCase());
        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            return res.status(400).json({ success: false, error: 'Mã xác thực không đúng hoặc đã hết hạn' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await pool.query('UPDATE users SET password = $1 WHERE LOWER(username) = LOWER($2)',
            [hashedPassword, record.username]);

        // ⭐ Xoá tất cả session của user sau khi đổi pass
        await pool.query('DELETE FROM sessions WHERE LOWER(username) = LOWER($1)', [record.username]);

        otpStore.delete(email.trim().toLowerCase());
        res.json({ success: true, message: 'Đặt lại mật khẩu thành công! Vui lòng đăng nhập lại.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// 26. LOGIN / LOGOUT
// ==========================================
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, error: 'Thiếu thông tin' });

        const dbUser = await getUserByUsername(username);
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

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TIMEOUT_MS);

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
            depositHistory, purchaseHistory
        };
        console.log(`✅ [Login] ${dbUser.username} - Token: ${sessionToken.slice(0, 8)}...`);
        res.json({ success: true, user: userData, sessionToken, expiresAt: expiresAt.toISOString() });
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

// ==========================================
// 27. USER INFO + CHANGE PASSWORD
// ==========================================
app.get('/api/user/:username', requireUserSession, async (req, res) => {
    try {
        if (req.username.toLowerCase() !== req.params.username.trim().toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền truy cập' });
        }
        const dbUser = await getUserByUsername(req.params.username);
        if (!dbUser) return res.status(404).json({ success: false, error: 'User not found' });

        res.json({
            success: true,
            user: {
                username: dbUser.username,
                balance: Number(dbUser.balance),
                fullName: dbUser.full_name,
                email: dbUser.email || '',
                kyc_status: dbUser.kyc_status || 'unverified',
                depositHistory: safeParseJSON(dbUser.deposit_history),
                purchaseHistory: safeParseJSON(dbUser.purchase_history)
            }
        });
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
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

        // ⭐ Xoá tất cả session cũ
        await pool.query('DELETE FROM sessions WHERE LOWER(username) = LOWER($1)', [username.trim()]);

        res.json({ success: true, message: 'Đổi mật khẩu thành công! Vui lòng đăng nhập lại.' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// 28. SUBMIT KYC
// ==========================================
app.post('/api/user/submit-kyc', requireUserSession, async (req, res) => {
    try {
        const { username, fullName, idNumber, frontImage, backImage } = req.body;

        if (req.username.toLowerCase() !== (username || '').toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền' });
        }
        if (!fullName || !idNumber || !frontImage || !backImage) {
            return res.status(400).json({ success: false, error: 'Vui lòng cung cấp đủ thông tin và ảnh' });
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

// ==========================================
// 29. PAY2S
// ==========================================
app.post('/api/pay2s-create-order', async (req, res) => {
    try {
        const { username, amount } = req.body;
        if (!username || !amount || amount < 10000) {
            return res.status(400).json({ success: false, error: 'Số tiền tối thiểu 10,000đ' });
        }

        const orderId = `NAP_${username}_${Date.now()}`;
        const requestId = Date.now().toString();
        const orderInfo = `NAP ${username}`;
        const baseUrl = process.env.BASE_URL || 'https://buyoptimizertyoncao.onrender.com';
        const redirectUrl = `${baseUrl}/payment-return`;
        const ipnUrl = `${baseUrl}/api/pay2s-webhook`;

        const rawSignature = `accessKey=${PAY2S_ACCESS_KEY}&amount=${amount}&bankAccounts=Array&ipnUrl=${ipnUrl}&orderId=${orderId}&orderInfo=${orderInfo}&partnerCode=${PAY2S_PARTNER_CODE}&redirectUrl=${redirectUrl}&requestId=${requestId}&requestType=pay2s`;
        const signature = crypto.createHmac('sha256', PAY2S_SECRET_KEY).update(rawSignature).digest('hex');

        const payload = {
            accessKey: PAY2S_ACCESS_KEY, partnerCode: PAY2S_PARTNER_CODE, partnerName: 'TYON Optimizer',
            requestId, amount, orderId, orderInfo,
            requestType: 'pay2s', redirectUrl, ipnUrl,
            bankAccounts: [{ account_number: '0976289958', bank_id: 'MBB' }],
            signature
        };

        const response = await fetch(PAY2S_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (result.status === true || result.resultCode === 0) {
            res.json({ success: true, paymentUrl: result.payUrl || result.paymentUrl || result.data?.payUrl });
        } else {
            res.status(400).json({ success: false, error: result.message || 'Tạo đơn Pay2S thất bại', raw: result });
        }
    } catch (err) {
        console.error('Pay2S create order error:', err);
        res.status(500).json({ success: false, error: 'Lỗi kết nối Pay2S: ' + err.message });
    }
});

// ⭐ PAY2S WEBHOOK — TRANSACTION + CHỐNG REPLAY
app.post('/api/pay2s-webhook', async (req, res) => {
    try {
        // Auth: nếu có cấu hình token thì BẮT BUỘC phải khớp (timing-safe)
        if (PAY2S_WEBHOOK_TOKEN) {
            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.replace(/^Bearer\s+/i, '');
            if (!safeCompareToken(token, PAY2S_WEBHOOK_TOKEN)) {
                return res.status(401).json({ success: false, message: 'Unauthorized' });
            }
        }

        const data = req.body;

        // Verify signature nếu có
        if (data.m2signature) {
            const rawHash = `accessKey=${data.accessKey}&amount=${data.amount}&extraData=${data.extraData || ''}&message=${data.message}&orderId=${data.orderId}&orderInfo=${data.orderInfo}&orderType=${data.orderType}&partnerCode=${data.partnerCode}&payType=${data.payType}&requestId=${data.requestId}&responseTime=${data.responseTime}&resultCode=${data.resultCode}&transId=${data.transId}`;
            const expectedSignature = crypto.createHmac('sha256', PAY2S_SECRET_KEY).update(rawHash).digest('hex');
            if (expectedSignature !== data.m2signature) {
                return res.status(400).json({ success: false, message: 'Invalid signature' });
            }
        }

        if (String(data.resultCode) !== '0') return res.status(200).json({ success: true });

        const amount = parseInt(data.amount || data.transferAmount || 0);
        const content = (data.orderInfo || data.content || '').toUpperCase();
        const match = content.match(/NAP[_\s]?([A-Z0-9_]+)/);

        if (match && match[1] && amount > 0) {
            const username = match[1].toLowerCase();
            const transId = data.transId || data.transactionNumber;
            if (!transId) {
                console.warn('⚠️ Pay2S webhook không có transId, bỏ qua');
                return res.status(200).json({ success: true });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows: userRows } = await client.query(
                    'SELECT username, balance, deposit_history FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE',
                    [username]
                );
                if (userRows.length > 0) {
                    const user = userRows[0];
                    const depositHistory = safeParseJSON(user.deposit_history);
                    const isDuplicate = depositHistory.some(d => d.transactionId === transId);
                    if (!isDuplicate) {
                        depositHistory.push({
                            amount, method: 'pay2s',
                            content: data.orderInfo || data.content,
                            transactionId: transId,
                            at: new Date().toISOString()
                        });
                        await client.query(
                            'UPDATE users SET balance = balance + $1, deposit_history = $2 WHERE username = $3',
                            [amount, JSON.stringify(depositHistory), user.username]
                        );
                        console.log(`💰 Đã cộng ${amount}đ cho ${username} qua Pay2S (transId=${transId})`);
                    } else {
                        console.log(`⚠️ Pay2S transId ${transId} đã xử lý, bỏ qua (chống replay)`);
                    }
                } else {
                    console.warn(`⚠️ Không tìm thấy user "${username}" cho Pay2S transId=${transId}`);
                }
                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            } finally {
                client.release();
            }
        }
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Pay2S webhook error:', error);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 30. WEBHUB
// ==========================================
app.post('/api/webhub-create-order', async (req, res) => {
    try {
        const { username, amount } = req.body;
        if (!username || !amount || amount < 10000) {
            return res.status(400).json({ success: false, error: 'Số tiền tối thiểu 10,000đ' });
        }
        if (!WEBHUB_WEBHOOK_TOKEN) return res.status(500).json({ success: false, error: 'WebHub chưa được cấu hình' });

        const webhubRes = await fetch(`${WEBHUB_API_BASE}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WEBHUB_WEBHOOK_TOKEN}` },
            body: JSON.stringify({
                amount,
                description: `NAP_${username}`,
                return_url: `${process.env.BASE_URL || 'http://localhost:3000'}/payment-return`
            })
        });
        const rawText = await webhubRes.text();
        let result;
        try { result = JSON.parse(rawText); } catch { result = { raw: rawText }; }
        if (!webhubRes.ok) {
            return res.status(400).json({ success: false, error: result.message || result.error || `WebHub lỗi ${webhubRes.status}` });
        }
        res.json({
            success: true,
            paymentUrl: result.payment_url || result.checkout_url || result.paymentUrl,
            qrCode: result.qr_code || result.qr_string || result.qrCode,
            orderId: result.order_id || result.id || result.orderId
        });
    } catch (err) {
        console.error('WebHub create order error:', err);
        res.status(500).json({ success: false, error: 'Lỗi kết nối WebHub: ' + err.message });
    }
});

app.post('/api/webhub-webhook', async (req, res) => {
    try {
        if (WEBHUB_WEBHOOK_TOKEN) {
            const authHeader = req.headers['authorization'] || req.headers['x-webhub-signature'] || '';
            const token = authHeader.replace(/^Bearer\s+/i, '');
            if (!safeCompareToken(token, WEBHUB_WEBHOOK_TOKEN)) {
                return res.status(401).json({ success: false, message: 'Unauthorized' });
            }
        }
        const data = req.body;
        const status = data.status || data.transactionStatus;
        const amount = parseInt(data.amount || data.transferAmount || 0);
        const content = (data.description || data.content || '').toUpperCase();

        if (status === 'success' || status === 'completed' || data.transferType === 'IN') {
            const match = content.match(/NAP[_\s]?([A-Z0-9_]+)/);
            if (match && match[1] && amount > 0) {
                const username = match[1].toLowerCase();
                const transId = data.transactionId || data.orderId;
                if (!transId) return res.status(200).json({ success: true });

                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const { rows: userRows } = await client.query(
                        'SELECT username, balance, deposit_history FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE',
                        [username]
                    );
                    if (userRows.length > 0) {
                        const user = userRows[0];
                        const depositHistory = safeParseJSON(user.deposit_history);
                        const isDuplicate = depositHistory.some(d => d.transactionId === transId);
                        if (!isDuplicate) {
                            depositHistory.push({
                                amount, method: 'webhub',
                                transactionId: transId,
                                at: new Date().toISOString()
                            });
                            await client.query(
                                'UPDATE users SET balance = balance + $1, deposit_history = $2 WHERE username = $3',
                                [amount, JSON.stringify(depositHistory), user.username]
                            );
                            console.log(`💰 Đã cộng ${amount}đ cho ${username} qua WebHub (transId=${transId})`);
                        }
                    }
                    await client.query('COMMIT');
                } catch (txErr) {
                    await client.query('ROLLBACK');
                    throw txErr;
                } finally {
                    client.release();
                }
            }
        }
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('WebHub webhook error:', error);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 31. BUY PRODUCT — ATOMIC UPDATE
// ==========================================
app.post('/api/buy-product', requireUserSession, async (req, res) => {
    try {
        const { username, productId, price, productName } = req.body;
        if (!username || productId === undefined || price === undefined) {
            return res.status(400).json({ success: false, error: 'Thiếu thông tin' });
        }
        if (req.username.toLowerCase() !== username.trim().toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Không có quyền' });
        }

        const dbUser = await getUserByUsername(username);
        if (!dbUser) return res.status(404).json({ success: false, error: 'Không tìm thấy user' });

        const purchaseHistory = safeParseJSON(dbUser.purchase_history);

        if (String(productId) !== '1' && purchaseHistory.some(p => String(p.productId) === String(productId))) {
            return res.status(400).json({ success: false, error: 'Bạn đã sở hữu file này!' });
        }

        const now = new Date().toISOString();
        const newPurchase = { productId, productName, price, purchasedAt: now };
        const updatedHistory = [...purchaseHistory, newPurchase];

        // ⭐ UPDATE ATOMIC: chỉ trừ khi balance >= price
        const { rowCount } = await pool.query(
            `UPDATE users
             SET balance = balance - $1, purchase_history = $2
             WHERE LOWER(username) = LOWER($3) AND balance >= $1`,
            [price, JSON.stringify(updatedHistory), dbUser.username]
        );

        if (rowCount === 0) {
            return res.status(400).json({ success: false, error: 'Số dư không đủ' });
        }

        const { rows: after } = await pool.query(
            'SELECT balance FROM users WHERE LOWER(username) = LOWER($1)',
            [dbUser.username]
        );
        const newBalance = Number(after[0].balance);

        if (dbUser.email) {
            const orderInfo = {
                orderCode: `TYON${Date.now().toString(36).toUpperCase()}`,
                customerName: dbUser.full_name || dbUser.username,
                planName: productName,
                amount: price,
                paidAt: now,
                transactionId: `BALANCE_${Date.now()}`,
                key: `TYON-KEY-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
            };
            sendEmail(dbUser.email, 'Hóa đơn mua hàng thành công - TyonCao Shop',
                emailTemplates.purchaseInvoice(orderInfo))
                .catch(err => console.error('Lỗi gửi mail hóa đơn:', err));
        }

        res.json({ success: true, newBalance, productId });
    } catch (err) {
        console.error('Buy error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// 32. DOWNLOAD (R2)
// ==========================================
app.get('/api/download/:productId', requireUserSession, async (req, res) => {
    const productId = String(req.params.productId || '').trim();
    const username = req.username;

    // ⭐ Validate productId (chỉ chữ/số/gạch)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(productId)) {
        return res.status(400).send('Mã sản phẩm không hợp lệ.');
    }

    try {
        const dbUser = await getUserByUsername(username);
        if (!dbUser) return res.status(404).send('Không tìm thấy user');

        const purchaseHistory = safeParseJSON(dbUser.purchase_history);
        const ownedIds = new Set(purchaseHistory.map(p => String(p.productId)));
        if (!ownedIds.has(productId) && productId !== '1') {
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

app.get('/api/download-all', requireUserSession, async (req, res) => {
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
            targetIds = requestedIds.filter(id => ownedIds.has(String(id)) || String(id) === '1');
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

// ==========================================
// 33. ADMIN: USERS + KEYS + FEEDBACKS
// ==========================================
app.post('/api/admin/users', requireAdminToken, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
        const users = rows.map(u => ({
            username: u.username,
            fullName: u.full_name,
            email: u.email || '',
            balance: Number(u.balance),
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

// ==========================================
// 34. KEYS (Gist)
// ==========================================
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
        res.status(500).json({ error: 'Không thể tạo key: ' + err.message });
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
        res.status(err.status || 500).json({ error: err.message });
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

// ==========================================
// 35. FEEDBACK
// ==========================================
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

// ==========================================
// 36. PAYMENT RETURN PAGE
// ==========================================
app.get('/payment-return', (req, res) => {
    const message = req.query.message || 'Giao dịch đã được xử lý.';
    const safeMessage = String(message).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    res.send(`
<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kết quả thanh toán</title>
<style>
body { font-family: sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
.box { background: #1e293b; padding: 40px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-width: 400px; width: 90%; }
h1 { color: #22c55e; font-size: 24px; margin-bottom: 10px; }
p { color: #a0a5b5; font-size: 14px; margin-bottom: 20px; line-height: 1.5; }
.btn { display: inline-block; padding: 12px 24px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold; transition: 0.3s; }
.btn:hover { background: #2563eb; }
</style></head>
<body><div class="box">
<h1>🎉 Thanh toán hoàn tất!</h1>
<p>Cảm ơn bạn đã nạp tiền. Hệ thống sẽ tự động cộng tiền vào ví của bạn trong 1-2 phút.</p>
<p><strong>Trạng thái:</strong> ${safeMessage}</p>
<a href="${FRONTEND_URL}" class="btn">Quay lại trang chủ</a>
</div>
<script>setTimeout(() => { window.location.href = ${JSON.stringify(FRONTEND_URL)}; }, 5000);</script>
</body></html>`);
});

// ==========================================
// 37. HEALTH + HEARTBEAT + GOOGLE TOKEN
// ==========================================
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
        emailConfigured: !!(process.env.EMAIL_USER && process.env.EMAIL_PASS),
        pay2sConfigured: !!PAY2S_PARTNER_CODE,
        webhubConfigured: !!WEBHUB_WEBHOOK_TOKEN,
        sepayConfigured: !!SEPAY_WEBHOOK_SECRET,
        googleConfigured: !!GOOGLE_CLIENT_ID,
        totalUsers, totalKeys, pendingKeys, confirmedKeys, totalFeedbacks,
        totalOrders: orderStats.total,
        pendingOrders: orderStats.pending || 0,
        paidOrders: orderStats.paid || 0,
        underpaidOrders: orderStats.underpaid || 0
    });
});

app.post('/api/heartbeat', requireUserSession, (req, res) => {
    res.json({ success: true, lastActivity: new Date().toISOString() });
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

        console.log(`✅ [Admin Login Redirect] ${email} - IP=${req.ip}`);
        res.json({ success: true, token, email });
    } catch (err) {
        console.error('❌ Lỗi đổi token Google:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// 38. 404 + ERROR HANDLERS
// ==========================================
app.use((req, res) => res.status(404).json({ error: 'API không tồn tại: ' + req.path }));
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
});

// ==========================================
// 39. TIMERS
// ==========================================
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

// ==========================================
// 40. START SERVER
// ==========================================
async function startServer() {
    await initDB();

    const server = app.listen(PORT, () => {
        console.log(`\n✅ TYON SERVER chạy tại http://localhost:${PORT}`);
        console.log(`🔐 JWT Security: BẬT`);
        console.log(`🛡️ Rate Limit: BẬT`);
        console.log(`📧 Email: ${process.env.EMAIL_USER ? 'Đã cấu hình' : 'CHƯA cấu hình'}`);
        console.log(`☁️  Storage Keys/Feedbacks: ${USE_GIST ? 'GitHub Gist' : 'LOCAL FILE'}`);
        console.log(`🗄️  Storage Users/Orders/Sessions: Supabase`);
        console.log(`💳 Pay2S: ${PAY2S_PARTNER_CODE ? 'Đã cấu hình' : 'CHƯA'}`);
        console.log(`💳 SePay: ${SEPAY_WEBHOOK_SECRET ? 'Đã cấu hình' : 'CHƯA'}`);
        console.log(`💳 WebHub: ${WEBHUB_WEBHOOK_TOKEN ? 'Đã cấu hình' : 'CHƯA'}`);
        console.log(`🔑 Google OAuth: ${GOOGLE_CLIENT_ID ? 'Đã cấu hình' : 'CHƯA'}`);
        console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
        console.log(`🏦 Bank: ${SEPAY_BANK_CODE} - ${SEPAY_BANK_ACCOUNT}\n`);
    });

    let shutting = false;
    async function shutdown(sig) {
        if (shutting) return;
        shutting = true;
        console.log(`\n👋 ${sig}...`);
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
