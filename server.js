// ==========================================
// TYON OPTIMIZER - SECURE SERVER (FULL)
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
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const bcrypt = require('bcryptjs');
const BCRYPT_ROUNDS = 10;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) console.error('❌ Lỗi kết nối Supabase:', err.message);
    else console.log('✅ Đã kết nối Supabase thành công!');
});

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ⭐ KHAI BÁO DOMAIN FRONTEND
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://buyoptimizertc.infinityfreeapp.com';
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
// BẢO MẬT CƠ BẢN (HELMET + RATE LIMIT)
// ==========================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// Chặn spam request toàn cục
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    max: 200,
    message: { error: 'Quá nhiều request. Vui lòng thử lại sau 15 phút.' }
});

// Chặn spam API Admin
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: 'Quá nhiều request admin. Vui lòng thử lại sau.' }
});

// Chặn spam đăng nhập (Brute Force)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    message: { error: 'Sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.' }
});

const pollingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: { error: 'Quá nhiều request. Vui lòng thử lại sau.' }
});

// ⭐ THỨ TỰ QUAN TRỌNG: cụ thể trước, chung sau
app.use('/api/order-status/', pollingLimiter);
app.use('/api/admin/', adminLimiter);
app.use('/api/', globalLimiter);

// ==========================================
// CẤU HÌNH LƯU TRỮ
// ==========================================
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GIST_ID = (process.env.GIST_ID || '').trim();
const GIST_FILENAME = 'database.json';
const USE_GIST = !!(GITHUB_TOKEN && GIST_ID);

const LOCAL_DB_FILE = path.join(__dirname, 'database.json');
const LOCAL_BACKUP_DIR = path.join(__dirname, 'backups');

console.log(USE_GIST
    ? `☁️  Lưu trữ: GitHub Gist (${GIST_ID})`
    : `⚠️  Lưu trữ: FILE LOCAL`
);

try {
    if (!fs.existsSync(LOCAL_BACKUP_DIR)) fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
} catch (err) {
    console.error('❌ Không tạo được thư mục backup:', err.message);
}

const DEFAULT_DB = { keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [], users: [], orders: [] };

let MEMORY_DB = null;
let isDirty = false;
let isSyncing = false;
let lastSyncTime = 0;

async function pushToSupabaseQueue(action, payload) {
    if (!pool) return;
    try {
        await pool.query(`
            INSERT INTO pending_sync (action, payload, created_at) 
            VALUES ($1, $2, $3)
        `, [action, JSON.stringify(payload), new Date().toISOString()]);
        console.log(`📥 Đã lưu tạm [${action}] vào Supabase Queue.`);
    } catch (err) {
        console.error('❌ Lỗi lưu tạm vào Supabase:', err.message);
    }
}

async function syncSupabaseToGist() {
    if (!USE_GIST || !pool) return;
    try {
        const { rows } = await pool.query(
            'SELECT * FROM pending_sync ORDER BY created_at ASC'
        );
        if (rows.length === 0) return;
        console.log(`🔄 Phát hiện ${rows.length} bản ghi đang chờ. Bắt đầu đồng bộ...`);

        let db = await loadFromGist() || JSON.parse(JSON.stringify(DEFAULT_DB));
        for (const row of rows) {
            const payload = row.payload;
            if (row.action === 'BULK_UPDATE' && payload.fullData) {
                db = buildGistData(payload.fullData);
            }
        }

        const success = await saveToGist(db);
        if (success) {
            await pool.query('DELETE FROM pending_sync');
            console.log('✅ Đã đồng bộ Supabase → Gist & dọn hàng đợi.');
        }
    } catch (err) {
        console.error('❌ Lỗi syncSupabaseToGist:', err.message);
    }
}

// ==========================================
// GITHUB GIST API
// ==========================================
function gistRequest(method, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: `/gists/${GIST_ID}`,
            method: method,
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

async function loadFromGist() {
    if (!USE_GIST) return null;
    try {
        const gist = await gistRequest('GET');
        const file = gist.files && gist.files[GIST_FILENAME];
        if (!file) return { ...DEFAULT_DB };
        let content;
        if (file.truncated && file.raw_url) content = await fetchRaw(file.raw_url);
        else content = file.content;
        const parsed = JSON.parse(content || '{}');
        // ⭐ Chỉ load các field không phải orders
        for (const k of ['keys', 'confirmedKeys', 'feedbackKeys', 'feedbacks'])
            if (!parsed[k]) parsed[k] = [];
        parsed.users = [];
        parsed.orders = [];
        return parsed;
    } catch (err) {
        console.error('❌ Lỗi load Gist:', err.message);
        return null;
    }
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
        if (data.users && data.users.length > 0) {
            console.warn(`🚨 [SECURITY] Phát hiện ${data.users.length} users trong payload Gist → Đã lọc bỏ!`);
        }
        
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

let syncTimer = null;
function scheduleSync() {
    isDirty = true;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => flushToGist(), 2000);
}

async function flushToGist(force = false) {
    if (isSyncing) return;
    if (!isDirty && !force) return;
    if (!USE_GIST) { saveLocal(MEMORY_DB); isDirty = false; return; }
    isSyncing = true;
    try {
        const success = await saveToGist(buildGistData(MEMORY_DB));
        if (success) { isDirty = false; lastSyncTime = Date.now(); saveLocal(MEMORY_DB); }
        else setTimeout(() => flushToGist(true), 30000);
    } finally { isSyncing = false; }
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
    } catch (err) {}
}

function loadLocal() {
    try {
        if (!fs.existsSync(LOCAL_DB_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_FILE, 'utf8'));
        for (const k of ['keys', 'confirmedKeys', 'feedbackKeys', 'feedbacks', 'orders'])
            if (!data[k]) data[k] = [];
        data.users = [];
        return data;
    } catch { return null; }
}

function readDB() {
    if (!MEMORY_DB) return JSON.parse(JSON.stringify(DEFAULT_DB));
    return JSON.parse(JSON.stringify(MEMORY_DB));
}

async function writeDB(db) {
    if (!db) return;
    
    // Cập nhật MEMORY_DB
    MEMORY_DB = JSON.parse(JSON.stringify(db));
    isDirty = true;
    
    // Sync users sang Supabase nếu có
    if (pool && db.users && db.users.length > 0) {
        try {
            await syncUsersToSupabase(db.users);
        } catch (err) {
            console.error('Lỗi sync users:', err.message);
        }
    }
    
    // Flush lên Gist / Local
    await flushToGist(true);
    
    return true;
}

async function getOrdersFromSupabase() {
    if (!pool) return [];
    try {
        const { rows } = await pool.query(
            'SELECT * FROM orders ORDER BY created_at DESC'
        );
        return rows.map(o => ({
            orderCode: o.order_code,
            key: o.key,
            plan: o.plan,
            planName: o.plan_name,
            customerName: o.customer_name,
            amount: Number(o.amount),
            status: o.status,
            createdAt: o.created_at,
            paidAt: o.paid_at,
            paidAmount: Number(o.paid_amount || 0),
            transactionId: o.transaction_id,
            sepayTransactionId: o.sepay_transaction_id,
            confirmedBy: o.confirmed_by,
            note: o.note || ''
        }));
    } catch (err) {
        console.error('❌ Lỗi đọc orders từ Supabase:', err.message);
        return [];
    }
}

async function upsertOrderToSupabase(order) {
    if (!pool) return false;
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
            order.orderCode,
            order.key,
            order.plan,
            order.planName || null,
            order.customerName || null,
            order.amount,
            order.status || 'pending',
            order.createdAt || new Date().toISOString(),
            order.paidAt || null,
            order.paidAmount || 0,
            order.transactionId || null,
            order.sepayTransactionId || null,
            order.confirmedBy || null,
            order.note || ''
        ]);
        return true;
    } catch (err) {
        console.error('❌ Lỗi upsert order:', err.message);
        return false;
    }
}

async function writeFeedbackToGist(feedbacksArray) {
    if (!USE_GIST) {
        console.log('⚠️ Không có Gist, không thể lưu Feedback.');
        return;
    }
    try {
        // ⭐ Dùng MEMORY_DB (RAM) — luôn là bản mới nhất, không mất keys vừa tạo
        const newData = buildGistData({
            keys: MEMORY_DB.keys || [],
            confirmedKeys: MEMORY_DB.confirmedKeys || [],
            feedbackKeys: MEMORY_DB.feedbackKeys || [],
            feedbacks: feedbacksArray
        });

        await gistRequest('PATCH', {
            files: { [GIST_FILENAME]: { content: JSON.stringify(newData, null, 2) } }
        });
        console.log('✅ Đã lưu Feedback lên Gist.');
        // KHÔNG set isDirty = false — để flushToGist xử lý
    } catch (err) {
        console.error('❌ Lỗi lưu Feedback lên Gist:', err.message);
        isDirty = true;
    }
}

// ⭐ HÀM HỖ TRỢ ĐỒNG BỘ USER SANG SUPABASE
async function syncUsersToSupabase(users) {
    if (!pool) return;
    try {
        for (const u of users) {
            await pool.query(`
                INSERT INTO users (username, password, full_name, balance, purchase_history, deposit_history)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (username) DO UPDATE SET
                password = EXCLUDED.password,
                full_name = EXCLUDED.full_name,
                balance = EXCLUDED.balance,
                purchase_history = EXCLUDED.purchase_history,
                deposit_history = EXCLUDED.deposit_history;
            `, [u.username, u.password, u.fullName, u.balance, JSON.stringify(u.purchaseHistory || []), JSON.stringify(u.depositHistory || [])]);
        }
    } catch (err) {
        console.error('❌ Lỗi đồng bộ Supabase:', err.message);
    }
}


function migrateUsers(db) {
    if (!db.users) db.users = [];
    let changed = false;

    for (const user of db.users) {
        if (user.balance === undefined || user.balance === null || isNaN(user.balance)) {
            user.balance = 0;
            changed = true;
        }
        if (!Array.isArray(user.purchaseHistory)) { user.purchaseHistory = []; changed = true; }
        if (!Array.isArray(user.depositHistory)) { user.depositHistory = []; changed = true; }
        if (!user.createdAt) { user.createdAt = new Date().toISOString(); changed = true; }
        if (user.password === undefined || user.password === null) { user.password = ''; changed = true; }
        if (!user.fullName) { user.fullName = user.username || 'Unknown'; changed = true; }
        if (!user.username) { user.username = 'unknown_' + Date.now(); changed = true; }
    }

    if (changed) {
        console.log(`🔧 [MIGRATE] Đã bổ sung field thiếu cho ${db.users.length} user`);
    }
    return changed;
}


async function initDB() {
    let supabaseUsers = [];

    // 1. Tải users từ Supabase (nếu có)
    if (pool) {
        try {
            const { rows } = await pool.query('SELECT * FROM users');
            if (rows.length > 0) {
                supabaseUsers = rows.map(u => ({
                    username: u.username,
                    password: u.password,
                    fullName: u.full_name,
                    balance: Number(u.balance),
                    purchaseHistory: u.purchase_history || [],
                    depositHistory: u.deposit_history || [],
                    createdAt: u.created_at
                }));
                console.log('✅ Đã tải dữ liệu users từ Supabase');
            }
        } catch (err) {
            console.error('❌ Lỗi đọc Supabase:', err.message);
        }
    }

    // 2. Tải dữ liệu cũ từ Gist / Local (keys + feedbacks)
    let localData = null;
    if (USE_GIST) {
        localData = await loadFromGist();
        if (localData) console.log('✅ Đã tải dữ liệu cũ từ Gist');
    } else {
        localData = loadLocal();
        if (localData) console.log('✅ Đã tải dữ liệu cũ từ Local');
    }

    // 3. Gộp keys/feedbacks vào RAM
    MEMORY_DB = JSON.parse(JSON.stringify(DEFAULT_DB));

    if (localData) {
        MEMORY_DB.feedbacks     = localData.feedbacks || [];
        MEMORY_DB.keys          = localData.keys || [];
        MEMORY_DB.confirmedKeys = localData.confirmedKeys || [];
        MEMORY_DB.feedbackKeys  = localData.feedbackKeys || [];
    }   // ← ĐÓNG if (localData) TẠI ĐÂY — quan trọng!

    // ⭐ Migrate users cũ từ Gist → Supabase (nếu có)
    if (pool && localData && localData.users && localData.users.length > 0) {
        console.log(`🔄 Phát hiện ${localData.users.length} users cũ trên Gist, đang chuyển sang Supabase...`);
        for (const u of localData.users) {
            if (!u || !u.username) continue;
            if (!supabaseUsers.some(su => su.username === u.username)) {
                try {
                    await pool.query(`
                        INSERT INTO users (username, password, full_name, balance, purchase_history, deposit_history)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        ON CONFLICT (username) DO NOTHING;
                    `, [
                        u.username,
                        u.password || '',
                        u.fullName || u.username,
                        u.balance || 0,
                        JSON.stringify(u.purchaseHistory || []),
                        JSON.stringify(u.depositHistory || [])
                    ]);
                } catch (e) {
                    console.error(`❌ Lỗi migrate user ${u.username}:`, e.message);
                }
            }
        }
        console.log('✅ Đã migrate xong users cũ sang Supabase.');
    }

    // ⭐ LUÔN dọn sạch users khỏi Gist (chỉ 1 lần, sau khi migrate xong)
    if (USE_GIST && localData) {
        try {
            const clean = buildGistData(localData);
            await gistRequest('PATCH', {
                files: { [GIST_FILENAME]: { content: JSON.stringify(clean, null, 2) } }
            });
            console.log('🧹 Đã đảm bảo Gist KHÔNG còn users.');
        } catch (e) {
            console.error('❌ Lỗi dọn users khỏi Gist:', e.message);
        }
    }

    MEMORY_DB.users = supabaseUsers;

    // ⭐ MIGRATE ORDERS CŨ TỪ GIST → SUPABASE (chạy 1 lần, an toàn nếu lặp)
    if (pool && USE_GIST) {
        try {
            const gist = await gistRequest('GET');
            const file = gist.files && gist.files[GIST_FILENAME];
            if (file) {
                const content = file.truncated && file.raw_url
                    ? await fetchRaw(file.raw_url) : file.content;
                const oldData = JSON.parse(content || '{}');
                if (Array.isArray(oldData.orders) && oldData.orders.length > 0) {
                    console.log(`🔄 Migrate ${oldData.orders.length} orders cũ từ Gist → Supabase...`);
                    for (const o of oldData.orders) {
                        await upsertOrderToSupabase(o);
                    }
                    console.log('✅ Migrate orders hoàn tất.');
                }
            }
        } catch (e) {
            console.error('❌ Lỗi migrate orders:', e.message);
        }
    }

    // ⭐ ORDERS LUÔN nạp từ Supabase
    if (pool) {
        MEMORY_DB.orders = await getOrdersFromSupabase();
        console.log(`✅ Đã tải ${MEMORY_DB.orders.length} orders từ Supabase`);
    } else {
        MEMORY_DB.orders = [];
    }

    migrateUsers(MEMORY_DB);
    saveLocal(MEMORY_DB);

    if (pool && MEMORY_DB.users.length > 0) {
        syncUsersToSupabase(MEMORY_DB.users);
    }
} 

async function migratePlaintextPasswords() {
    if (!pool) {
        console.log('⚠️ Không có Supabase, bỏ qua migrate password');
        return;
    }
    try {
        const { rows } = await pool.query('SELECT username, password FROM users');
        let count = 0;
        for (const row of rows) {
            // Password bcrypt luôn bắt đầu bằng $2a$ / $2b$ / $2y$
            if (row.password && !row.password.startsWith('$2')) {
                try {
                    const hashed = await bcrypt.hash(row.password, BCRYPT_ROUNDS);
                    await pool.query(
                        'UPDATE users SET password = $1 WHERE username = $2',
                        [hashed, row.username]
                    );
                    count++;
                    console.log(`  🔐 Đã hash password cho user: ${row.username}`);
                } catch (e) {
                    console.error(`  ❌ Lỗi hash user ${row.username}:`, e.message);
                }
            }
        }
        if (count > 0) {
            console.log(`🔐 [MIGRATE] Đã hash ${count} mật khẩu plaintext cũ`);
        } else {
            console.log('🔐 [MIGRATE] Không có password plaintext nào cần migrate');
        }
    } catch (err) {
        console.error('❌ Lỗi migrate password:', err.message);
    }
}

// ==========================================
// CẤU HÌNH HỆ THỐNG & ADMIN BẢO MẬT
// ==========================================
const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// ⭐ ĐỌC TỪ BIẾN MÔI TRƯỜNG (.ENV)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_PIN = process.env.ADMIN_PIN;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_PIN || !JWT_SECRET) {
    console.error('❌ LỖI BẢO MẬT: Thiếu biến môi trường trong file .env!');
    console.error('Yêu cầu: ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_PIN, JWT_SECRET');
    // process.exit(1); // Bỏ comment dòng này nếu muốn server dừng ngay khi thiếu env
}

// CẤU HÌNH PAY2S
const PAY2S_PARTNER_CODE = process.env.PAY2S_PARTNER_CODE;
const PAY2S_ACCESS_KEY = process.env.PAY2S_ACCESS_KEY;
const PAY2S_SECRET_KEY = process.env.PAY2S_SECRET_KEY;
const PAY2S_API_URL = 'https://payment.pay2s.vn/v1/gateway/api/create';
const PAY2S_WEBHOOK_TOKEN = process.env.PAY2S_WEBHOOK_TOKEN;

// WEBHUB CONFIG
const WEBHUB_WEBHOOK_TOKEN = process.env.WEBHUB_WEBHOOK_TOKEN || '';
const WEBHUB_API_BASE = process.env.WEBHUB_API_BASE || 'https://api.webhub.vn/v1';

app.use(cors({
    origin: [
        FRONTEND_URL,
        'https://buyoptimizertc.infinityfreeapp.com',
        'https://buyoptimizertyoncao.onrender.com',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.post('/api/sepay-webhook', express.raw({ type: 'application/json' }), handleSePayWebhook);
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ==========================================
// BẢO MẬT ADMIN (VERIFY, JWT MIDDLEWARE)
// ==========================================
// So sánh mật khẩu an toàn (chống timing attack)
function verifyAdmin(username, password) {
    if (username !== ADMIN_USERNAME) return false;
    try {
        const a = Buffer.from(password || '');
        const b = Buffer.from(ADMIN_PASSWORD || '');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

// So sánh PIN an toàn
function verifyPin(pin) {
    if (!pin || pin.length !== ADMIN_PIN.length) return false;
    try {
        const a = Buffer.from(pin);
        const b = Buffer.from(ADMIN_PIN);
        return crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

// Middleware kiểm tra JWT Token
function requireAdminToken(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Từ chối truy cập: Thiếu token' });
        }
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Không có quyền admin' });
        }
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
    }
}

// ==========================================
// CLEANUP & HELPERS (CHỈ XÓA KEY CHƯA XÁC NHẬN)
// ==========================================
async function cleanupExpiredKeys() {
    if (!MEMORY_DB) return { deletedCount: 0 };
    const now = Date.now();
    let deletedCount = 0;

    // Dọn keys cũ (giữ nguyên)
    if (MEMORY_DB.keys) {
        const before = MEMORY_DB.keys.length;
        MEMORY_DB.keys = MEMORY_DB.keys.filter(k => {
            if (k.status === 'confirmed') return true; 
            if (k.status !== 'pending') return true; 
            const age = now - new Date(k.createdAt).getTime();
            return age <= KEY_EXPIRE_MS; 
        });
        deletedCount += before - MEMORY_DB.keys.length;
    }

    // ⭐ Dọn orders pending quá 24h → TRÊN SUPABASE
    if (pool) {
        try {
            const expireBefore = new Date(now - KEY_EXPIRE_MS).toISOString();
            const { rowCount } = await pool.query(`
                UPDATE orders SET
                    status = 'expired',
                    note = COALESCE(note, '') || ' | Tự động hết hạn sau 24h'
                WHERE status = 'pending' AND created_at < $1
            `, [expireBefore]);
            if (rowCount > 0) {
                console.log(`🧹 Đã expire ${rowCount} orders pending trên Supabase.`);
            }
        } catch (err) {
            console.error('❌ Lỗi expire orders:', err.message);
        }
    }

    if (deletedCount > 0) {
        isDirty = true;
        await flushToGist(true);
        console.log(`🧹 Đã tự động xóa ${deletedCount} key pending hết hạn.`);
    }
    return { deletedCount };
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

// ==========================================
// API: ADMIN LOGIN (CẤP JWT TOKEN)
// ==========================================
app.post('/api/admin/login', loginLimiter, (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Thiếu thông tin đăng nhập' });
        }

        if (!verifyAdmin(username, password)) {
            console.log(`🚫 [Login Failed] IP=${req.ip}`);
            return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
        }

        const token = jwt.sign(
            { username: ADMIN_USERNAME, role: 'admin' },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        console.log(`✅ [Login Success] admin="${username}" IP=${req.ip}`);
        res.json({ success: true, token, expiresIn: JWT_EXPIRES_IN });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.post('/api/admin/verify-token', requireAdminToken, (req, res) => {
    res.json({ success: true, admin: { username: req.admin.username }, valid: true });
});

const SEPAY_WEBHOOK_SECRET = process.env.SEPAY_WEBHOOK_SECRET;
const SEPAY_BANK_ACCOUNT = process.env.SEPAY_BANK_ACCOUNT;
const SEPAY_BANK_CODE = process.env.SEPAY_BANK_CODE;
const SEPAY_ACCOUNT_HOLDER = process.env.SEPAY_ACCOUNT_HOLDER;

if (!SEPAY_WEBHOOK_SECRET) {
    console.warn('⚠️ Thiếu SEPAY_WEBHOOK_SECRET trong .env - Webhook SePay sẽ không hoạt động!');
}

function generateOrderCode() {
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase().slice(-6);
    return `TYON${random}${timestamp}`;
}

// ⭐ API TẠO ĐƠN HÀNG (Frontend gọi khi khách chọn gói)
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
            orderCode: orderCode,
            key: key,
            plan: plan,
            planName: planName || plan.toUpperCase(),
            customerName: customerName,
            amount: parseInt(amount),
            status: 'pending',
            createdAt: new Date().toISOString(),
            paidAt: null,
            paidAmount: 0,
            transactionId: null,
            sepayTransactionId: null,
            note: ''
        };

        // ⭐ Lưu thẳng lên Supabase
        const saved = await upsertOrderToSupabase(newOrder);
        if (!saved) {
            return res.status(500).json({ success: false, error: 'Không lưu được đơn hàng' });
        }

        // Cập nhật cache RAM để đọc nhanh
        if (!MEMORY_DB.orders) MEMORY_DB.orders = [];
        MEMORY_DB.orders.push(newOrder);

        const qrContent = orderCode;
        const qrUrl = `https://img.vietqr.io/image/${SEPAY_BANK_CODE}-${SEPAY_BANK_ACCOUNT}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(qrContent)}&accountName=${encodeURIComponent(SEPAY_ACCOUNT_HOLDER)}`;

        res.json({
            success: true,
            orderCode: orderCode,
            key: key,
            amount: parseInt(amount),
            qrContent: qrContent,
            qrUrl: qrUrl,
            bankInfo: {
                bankCode: SEPAY_BANK_CODE,
                accountNumber: SEPAY_BANK_ACCOUNT,
                accountHolder: SEPAY_ACCOUNT_HOLDER
            }
        });

    } catch (err) {
        console.error('Lỗi tạo đơn hàng:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ⭐ API KIỂM TRA TRẠNG THÁI ĐƠN (Frontend polling)
app.get('/api/order-status/:orderCode', async (req, res) => {
    try {
        const { orderCode } = req.params;
        
        // ⭐ Đọc từ Supabase (luôn chính xác nhất)
        if (!pool) {
            return res.status(500).json({ success: false, error: 'DB chưa sẵn sàng' });
        }
        const { rows } = await pool.query(
            'SELECT * FROM orders WHERE order_code = $1',
            [orderCode]
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
        }
        const o = rows[0];

        res.json({
            success: true,
            orderCode: o.order_code,
            status: o.status,
            key: o.status === 'paid' ? o.key : null,
            amount: Number(o.amount),
            paidAmount: Number(o.paid_amount || 0),
            paidAt: o.paid_at,
            planName: o.plan_name
        });
    } catch (err) {
        console.error('Lỗi check order:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ⭐ HÀM XỬ LÝ WEBHOOK SEPAY (được gọi từ route raw body ở trên)
async function handleSePayWebhook(req, res) {
    try {
        // --- 1. XÁC THỰC CHỮ KÝ HMAC-SHA256 ---
        const signature = req.headers['x-sepay-signature'];
        const timestamp = req.headers['x-sepay-timestamp'];
        
        if (!signature || !timestamp) {
            console.error('❌ Webhook thiếu header signature/timestamp');
            return res.status(401).json({ success: false, error: 'Missing signature' });
        }

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - parseInt(timestamp)) > 300) {
            console.error('❌ Webhook timestamp quá cũ');
            return res.status(401).json({ success: false, error: 'Request expired' });
        }

        const rawBody = req.body.toString('utf8');
        const expectedSignature = 'sha256=' + crypto
            .createHmac('sha256', SEPAY_WEBHOOK_SECRET)
            .update(timestamp + '.' + rawBody)
            .digest('hex');

        if (signature !== expectedSignature) {
            console.error('❌ Chữ ký Webhook không khớp!');
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }

        // --- 2. PARSE DỮ LIỆU ---
        const data = JSON.parse(rawBody);
        console.log('✅ SePay Webhook:', JSON.stringify(data, null, 2));

        if (data.transferType !== 'in') {
            return res.status(200).json({ success: true, message: 'Ignored (not incoming)' });
        }

        const amount = parseInt(data.transferAmount);
        const content = (data.content || '').toUpperCase().trim();
        const transactionId = data.id || data.referenceCode || 'N/A';

        // --- 3. TÌM ĐƠN HÀNG ---
        const db = readDB();
        if (!db.orders) db.orders = [];

        let matchedOrder = null;
        if (pool) {
            const { rows } = await pool.query(
                `SELECT * FROM orders 
                 WHERE status = 'pending' 
                   AND UPPER($1) LIKE '%' || UPPER(order_code) || '%'
                 LIMIT 1`,
                [content]
            );
            if (rows.length > 0) {
                const o = rows[0];
                matchedOrder = {
                    orderCode: o.order_code,
                    key: o.key,
                    amount: Number(o.amount),
                    status: o.status,
                    note: o.note || ''
                };
            }
        }

        if (!matchedOrder) {
            console.log(`⚠️ Không tìm thấy đơn pending khớp nội dung: "${content}"`);
            return res.status(200).json({ success: true, message: 'No matching order' });
        }

        // --- 4. KIỂM TRA SỐ TIỀN ---
        const requiredAmount = matchedOrder.amount;
        
        if (amount >= requiredAmount) {
            await pool.query(`
                UPDATE orders SET
                    status = 'paid',
                    paid_at = $1,
                    paid_amount = $2,
                    transaction_id = $3,
                    sepay_transaction_id = $4
                WHERE order_code = $5
            `, [
                new Date().toISOString(),
                amount,
                transactionId,
                data.referenceCode || data.id,
                matchedOrder.orderCode
            ]);

            // Cập nhật cache RAM
            const cachedOrder = (MEMORY_DB.orders || []).find(o => o.orderCode === matchedOrder.orderCode);
            if (cachedOrder) {
                cachedOrder.status = 'paid';
                cachedOrder.paidAt = new Date().toISOString();
                cachedOrder.paidAmount = amount;
            }

            console.log(`✅ ĐƠN ${matchedOrder.orderCode} ĐÃ THANH TOÁN! Key: ${matchedOrder.key}`);
        } else {
            const note = `Thanh toán thiếu: cần ${requiredAmount}đ, nhận ${amount}đ`;
            await pool.query(`
                UPDATE orders SET
                    status = 'underpaid',
                    paid_amount = $1,
                    transaction_id = $2,
                    note = $3
                WHERE order_code = $4
            `, [amount, transactionId, note, matchedOrder.orderCode]);

            console.log(`⚠️ ĐƠN ${matchedOrder.orderCode} THIẾU TIỀN!`);
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('❌ Lỗi Webhook SePay:', error);
        return res.status(500).json({ success: false, error: 'Internal error' });
    }
}

// ⭐ API ADMIN: DANH SÁCH ĐƠN HÀNG
app.post('/api/admin/orders', requireAdminToken, async (req, res) => {
    try {
        const orders = await getOrdersFromSupabase();
        res.json({ success: true, orders });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ⭐ API ADMIN: XÁC NHẬN THỦ CÔNG
app.post('/api/admin/confirm-order', requireAdminToken, async (req, res) => {
    try {
        const { pin, orderCode } = req.body;
        
        if (!verifyPin(pin)) {
            return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });
        }

        const { rows } = await pool.query(
            'SELECT * FROM orders WHERE order_code = $1',
            [orderCode]
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
        }
        if (rows[0].status === 'paid') {
            return res.status(400).json({ success: false, error: 'Đơn này đã xác nhận rồi' });
        }

        const note = (rows[0].note || '') + ' | Admin xác nhận thủ công';
        await pool.query(`
            UPDATE orders SET
                status = 'paid',
                paid_at = $1,
                confirmed_by = $2,
                note = $3
            WHERE order_code = $4
        `, [new Date().toISOString(), req.admin.username, note, orderCode]);

        // Cập nhật cache
        const cached = (MEMORY_DB.orders || []).find(o => o.orderCode === orderCode);
        if (cached) {
            cached.status = 'paid';
            cached.paidAt = new Date().toISOString();
            cached.confirmedBy = req.admin.username;
        }

        console.log(`✅ [ADMIN] ${req.admin.username} xác nhận đơn ${orderCode}`);
        
        res.json({
            success: true,
            message: `Đã xác nhận đơn ${orderCode}. Key đã kích hoạt!`
        });
    } catch (err) {
        console.error('Admin confirm order error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// KEY ENDPOINTS
// ==========================================
app.post('/api/create-key', async (req, res) => { 
    const { plan, customerName, transferContent, amount } = req.body;
    if (!plan || !customerName) return res.status(400).json({ error: 'Thiếu thông tin' });
    await cleanupExpiredKeys();
    const db = readDB();
    const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase();
    const key = `TYON-${plan.toUpperCase()}-${randomPart}-${timestamp}`;
    const newKey = {
        key, plan, customerName,
        transferContent: transferContent || '', amount: amount || 0,
        status: 'pending', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + KEY_EXPIRE_MS).toISOString()
    };
    db.keys.push(newKey);
    await writeDB(db);
    res.json({ success: true, key, expiresAt: newKey.expiresAt,
        message: `Key đã tạo. Xác nhận trong ${KEY_EXPIRE_HOURS}h.` });
});

// ⭐ ĐÃ BẢO MẬT BẰNG JWT MIDDLEWARE
app.post('/api/admin/keys', requireAdminToken, async (req, res) => {
    await cleanupExpiredKeys();
    const db = readDB();
    const keys = db.keys.map(k => {
        if (k.status === 'pending') {
            const rem = calcRemainingTime(k.createdAt, k.status);
            return { ...k, remainingHours: rem.hours, remainingMinutes: rem.minutes };
        }
        return k;
    });
    res.json({ keys });
});

// ⭐ ĐÃ BẢO MẬT BẰNG JWT MIDDLEWARE
app.post('/api/admin/confirm-key', requireAdminToken, async (req, res) => {
    const { pin, key } = req.body;
    if (!verifyPin(pin)) return res.status(403).json({ error: 'Mã PIN không chính xác' });
    
    cleanupExpiredKeys();
    const db = readDB();
    const idx = db.keys.findIndex(k => k.key === key);
    if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy key' });
    if (db.keys[idx].status === 'confirmed') return res.status(400).json({ error: 'Đã xác nhận' });
    
    db.keys[idx].status = 'confirmed';
    db.keys[idx].confirmedAt = new Date().toISOString();
    db.keys[idx].confirmedBy = req.admin.username;
    
    await writeDB(db);
    res.json({ success: true, message: 'Đã xác nhận Key thành công!', keyData: db.keys[idx] });
});

app.post('/api/check-key', (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Thiếu key' });
    cleanupExpiredKeys();
    const db = readDB();
    const k = db.keys.find(x => x.key.toUpperCase() === key.trim().toUpperCase());
    if (!k) return res.status(404).json({ error: 'Key không tồn tại' });
    const rem = calcRemainingTime(k.createdAt, k.status);
    res.json({ success: true, keyData: { ...k,
        remainingTime: rem && !rem.isExpired ? { hours: rem.hours, minutes: rem.minutes } : null } });
});

app.post('/api/search-keys', (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Nhập từ khóa' });
        const term = query.trim().toUpperCase();
        cleanupExpiredKeys();
        const db = readDB();
        const matches = db.keys.filter(k =>
            (k.key && k.key.toUpperCase().includes(term)) ||
            (k.transferContent && k.transferContent.toUpperCase().includes(term)) ||
            (k.customerName && k.customerName.toUpperCase().includes(term))
        );
        const results = matches.map(k => {
            const rem = calcRemainingTime(k.createdAt, k.status);
            return { ...k,
                remainingTime: rem && !rem.isExpired ? rem : null,
                isExpired: rem ? rem.isExpired : false };
        });
        res.json({ success: true, results, count: results.length, totalMatches: results.length });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.get('/api/confirmed-keys', (req, res) => {
    cleanupExpiredKeys();
    res.json({ keys: readDB().keys.filter(k => k.status === 'confirmed') });
});

// ⭐ ĐÃ BẢO MẬT BẰNG JWT MIDDLEWARE
app.post('/api/admin/cleanup-now', requireAdminToken, (req, res) => {
    const result = cleanupExpiredKeys();
    res.json({ success: true, message: `Đã xóa ${result.deletedCount} key hết hạn. Các tài khoản người dùng được giữ nguyên.` });
});

// ==========================================
// FEEDBACK
// ==========================================
app.get('/api/feedbacks', (req, res) => {
    res.json({ feedbacks: [...(MEMORY_DB.feedbacks || [])].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.post('/api/submit-feedback', async (req, res) => {
    try {
        const { username, rating, content, images } = req.body;

        // 1. Validate dữ liệu đầu vào
        if (!username) {
            return res.status(400).json({ error: 'Thiếu thông tin người dùng!' });
        }
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Đánh giá phải từ 1 đến 5 sao!' });
        }
        if (!content || content.trim().length === 0) {
            return res.status(400).json({ error: 'Nội dung đánh giá không được để trống!' });
        }

        const db = readDB();
        
        // 2. Tìm user trong database
        const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!user) {
            return res.status(404).json({ error: 'Không tìm thấy người dùng!' });
        }

        // 3. Tính tổng chi tiêu từ lịch sử mua hàng
        const totalSpent = (user.purchaseHistory || []).reduce((sum, item) => sum + (item.price || 0), 0);

        // 4. Kiểm tra điều kiện (>= 500.000 VNĐ)
        if (totalSpent < 500000) {
            return res.status(403).json({ 
                error: `Bạn cần mua hàng tối thiểu 500.000đ để đánh giá. Tổng chi tiêu hiện tại: ${new Intl.NumberFormat('vi-VN').format(totalSpent)}đ` 
            });
        }

        // 5. Kiểm tra xem user đã feedback chưa (Mỗi user chỉ được feedback 1 lần)
        // Nếu bạn muốn cho feedback nhiều lần thì comment đoạn này lại
        const existingFeedback = db.feedbacks.find(fb => fb.username && fb.username.toLowerCase() === username.toLowerCase());
        if (existingFeedback) {
            return res.status(400).json({ error: 'Bạn đã gửi đánh giá rồi. Cảm ơn bạn!' });
        }

        // 6. Lưu feedback mới
        const newFeedback = {
            id: Date.now().toString(),
            username: user.username, // Lưu username để check trùng
            customerName: user.fullName || user.username,
            rating: Number(rating),
            content: content.trim(),
            images: images || [],
            createdAt: new Date().toISOString()
        };

if (!MEMORY_DB.feedbacks) MEMORY_DB.feedbacks = [];
MEMORY_DB.feedbacks.push(newFeedback);
await writeFeedbackToGist(MEMORY_DB.feedbacks);

        res.json({ success: true, message: 'Cảm ơn bạn đã gửi đánh giá!', feedback: newFeedback });

    } catch (err) {
        console.error('Lỗi submit-feedback:', err);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// ⭐ ĐÃ BẢO MẬT BẰNG JWT MIDDLEWARE
app.post('/api/admin/feedbacks', requireAdminToken, (req, res) => {
    const db = readDB();
    res.json({ feedbacks: [...db.feedbacks].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

// ⭐ ĐÃ BẢO MẬT BẰNG JWT MIDDLEWARE & ẨN PASSWORD USER
app.post('/api/admin/users', requireAdminToken, (req, res) => {
    const db = readDB();
    const users = db.users.map(u => ({
        username: u.username,
        password: u.password,
        fullName: u.fullName,
        balance: u.balance || 0,
        createdAt: u.createdAt,
        depositCount: (u.depositHistory || []).length,
        purchaseCount: (u.purchaseHistory || []).length
    }));
    res.json({ success: true, users });
});

// ⭐ ĐÃ BẢO MẬT BẰNG JWT MIDDLEWARE
app.post('/api/admin/add-balance', requireAdminToken, async (req, res) => {
    try {
        const { pin, targetUsername, amount, note } = req.body;

        if (!verifyPin(pin)) {
            return res.status(403).json({ success: false, error: 'Mã PIN không chính xác' });
        }

        const addAmount = parseInt(amount);
        if (!targetUsername || !addAmount || addAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Thiếu thông tin hoặc số tiền không hợp lệ' });
        }
        if (addAmount > 100000000) {
            return res.status(400).json({ success: false, error: 'Số tiền cộng tối đa 100.000.000đ' });
        }

        const db = readDB();
        const idx = db.users.findIndex(u => 
            u.username.toLowerCase() === targetUsername.toLowerCase().trim()
        );
        if (idx === -1) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy user: ' + targetUsername });
        }

        const user = db.users[idx];
        const oldBalance = user.balance || 0;
        user.balance = oldBalance + addAmount;

        if (!user.depositHistory) user.depositHistory = [];
        user.depositHistory.push({
            amount: addAmount,
            method: 'admin_manual',
            content: note || `Admin cộng tiền thủ công`,
            transactionId: 'ADMIN_' + Date.now(),
            at: new Date().toISOString(),
            addedBy: req.admin.username,
            ip: req.ip // Log lại IP để truy vết nếu có biến
        });

        await syncUsersToSupabase([user]);
        console.log(`💰 [AUDIT] ${req.admin.username} cộng ${addAmount}đ cho ${targetUsername} (${oldBalance} → ${user.balance})`);

        res.json({
            success: true,
            message: `Đã cộng ${addAmount.toLocaleString('vi-VN')}đ cho ${targetUsername}`,
            data: { username: user.username, fullName: user.fullName, oldBalance, newBalance: user.balance, addedAmount: addAmount }
        });

    } catch (err) {
        console.error('Admin add-balance error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server: ' + err.message });
    }
});

// ==========================================
// USER AUTH & CHỨC NĂNG NGƯỜI DÙNG
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, fullName } = req.body;
        if (!username || !password || !fullName)
            return res.status(400).json({ success: false, error: 'Thiếu thông tin' });
        if (username.length < 4 || !/^[a-zA-Z0-9_]+$/.test(username))
            return res.status(400).json({ success: false, error: 'Username không hợp lệ (≥4 ký tự, chỉ chữ/số/_)' });
        if (password.length < 6)
            return res.status(400).json({ success: false, error: 'Mật khẩu phải ≥6 ký tự' });

        const db = readDB();
        if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
            return res.status(400).json({ success: false, error: 'Username đã tồn tại' });

        // ⭐ HASH PASSWORD
        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const newUser = {
            username,
            password: password,
            fullName,
            balance: 0, purchaseHistory: [], depositHistory: [],
            createdAt: new Date().toISOString()
        };
        db.users.push(newUser);
        await syncUsersToSupabase([newUser]);

        res.json({
            success: true,
            message: 'Đăng ký thành công',
            user: { username: newUser.username, fullName: newUser.fullName, balance: 0 }
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({ success: false, error: 'Thiếu thông tin' });

        const db = readDB();
        const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());

        if (!user) return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });

        // ⭐ SO SÁNH HASH
if (password !== user.password) {
            return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });
        }

        res.json({
            success: true,
            user: {
                username: user.username,
                fullName: user.fullName,
                balance: user.balance,
                depositHistory: user.depositHistory || [],
                purchaseHistory: user.purchaseHistory || []
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.get('/api/user/:username', (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user: {
        username: user.username, 
        balance: user.balance, 
        fullName: user.fullName,
        depositHistory: user.depositHistory || [],
        purchaseHistory: user.purchaseHistory || []
    }});
});

app.post('/api/change-password', async (req, res) => {
    try {
        const { username, oldPassword, newPassword } = req.body;
        if (!username || !oldPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ thông tin' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
        }

        const db = readDB();
        const idx = db.users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
        if (idx === -1) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });

if (oldPassword !== db.users[idx].password) {
            return res.status(400).json({ success: false, error: 'Mật khẩu cũ không chính xác' });
        }

        db.users[idx].password = newPassword;
await syncUsersToSupabase([db.users[idx]]);
        res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// PAY2S & WEBHUB (THANH TOÁN)
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
        const redirectUrl = `${process.env.BASE_URL || 'https://buyoptimizertyoncao.onrender.com'}/payment-return`;
        const ipnUrl = `${process.env.BASE_URL || 'https://buyoptimizertyoncao.onrender.com'}/api/pay2s-webhook`;

        const rawSignature = `accessKey=${PAY2S_ACCESS_KEY}&amount=${amount}&bankAccounts=Array&ipnUrl=${ipnUrl}&orderId=${orderId}&orderInfo=${orderInfo}&partnerCode=${PAY2S_PARTNER_CODE}&redirectUrl=${redirectUrl}&requestId=${requestId}&requestType=pay2s`;
        const signature = crypto.createHmac('sha256', PAY2S_SECRET_KEY).update(rawSignature).digest('hex');

        const payload = {
            accessKey: PAY2S_ACCESS_KEY, partnerCode: PAY2S_PARTNER_CODE, partnerName: 'TYON Optimizer',
            requestId: requestId, amount: amount, orderId: orderId, orderInfo: orderInfo,
            requestType: 'pay2s', redirectUrl: redirectUrl, ipnUrl: ipnUrl,
            bankAccounts: [{ account_number: "0976289958", bank_id: "MBB" }], signature: signature
        };

        const response = await fetch(PAY2S_API_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
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

app.post('/api/pay2s-webhook', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        if (authHeader && !authHeader.includes(PAY2S_WEBHOOK_TOKEN)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const data = req.body;
        if (data.m2signature) {
            const rawHash = `accessKey=${data.accessKey}&amount=${data.amount}&extraData=${data.extraData || ''}&message=${data.message}&orderId=${data.orderId}&orderInfo=${data.orderInfo}&orderType=${data.orderType}&partnerCode=${data.partnerCode}&payType=${data.payType}&requestId=${data.requestId}&responseTime=${data.responseTime}&resultCode=${data.resultCode}&transId=${data.transId}`;
            const expectedSignature = crypto.createHmac('sha256', PAY2S_SECRET_KEY).update(rawHash).digest('hex');
            if (expectedSignature !== data.m2signature) {
                return res.status(400).json({ success: false, message: 'Invalid signature' });
            }
        }

        const resultCode = String(data.resultCode);
        if (resultCode !== '0') return res.status(200).json({ success: true });

        const amount = parseInt(data.amount || data.transferAmount || 0);
        const content = (data.orderInfo || data.content || '').toUpperCase();
        const match = content.match(/NAP[_\s]?([A-Z0-9_]+)/);

        if (match && match[1] && amount > 0) {
            const username = match[1].toLowerCase();
            const db = readDB();
            const idx = db.users.findIndex(u => u.username.toLowerCase() === username);

            if (idx !== -1) {
                const transId = data.transId || data.transactionNumber;
                const isDuplicate = (db.users[idx].depositHistory || []).some(d => d.transactionId === transId);
                if (isDuplicate) return res.status(200).json({ success: true });

                db.users[idx].balance += amount;
                if (!db.users[idx].depositHistory) db.users[idx].depositHistory = [];
                db.users[idx].depositHistory.push({
                    amount, method: 'pay2s', content: data.orderInfo || data.content,
                    transactionId: transId, at: new Date().toISOString()
                });
                await syncUsersToSupabase([db.users[idx]]);
            }
        }
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Pay2S webhook error:', error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/webhub-create-order', async (req, res) => {
    try {
        const { username, amount } = req.body;
        if (!username || !amount || amount < 10000)
            return res.status(400).json({ success: false, error: 'Số tiền tối thiểu 10,000đ' });
        if (!WEBHUB_WEBHOOK_TOKEN) return res.status(500).json({ success: false, error: 'WebHub chưa được cấu hình' });

        const webhubRes = await fetch(`${WEBHUB_API_BASE}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WEBHUB_WEBHOOK_TOKEN}` },
            body: JSON.stringify({ amount: amount, description: `NAP_${username}`, return_url: `${process.env.BASE_URL || 'http://localhost:3000'}/payment-return` })
        });

        const rawText = await webhubRes.text();
        let result; try { result = JSON.parse(rawText); } catch { result = { raw: rawText }; }

        if (!webhubRes.ok) return res.status(400).json({ success: false, error: result.message || result.error || `WebHub lỗi ${webhubRes.status}` });

        res.json({ success: true, paymentUrl: result.payment_url || result.checkout_url || result.paymentUrl, qrCode: result.qr_code || result.qr_string || result.qrCode, orderId: result.order_id || result.id || result.orderId });
    } catch (err) {
        console.error('WebHub create order error:', err);
        res.status(500).json({ success: false, error: 'Lỗi kết nối WebHub: ' + err.message });
    }
});

app.post('/api/webhub-webhook', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'] || req.headers['x-webhub-signature'];
        if (WEBHUB_WEBHOOK_TOKEN && (!authHeader || !authHeader.includes(WEBHUB_WEBHOOK_TOKEN))) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        const data = req.body;
        const status = data.status || data.transactionStatus;
        const amount = parseInt(data.amount || data.transferAmount || 0);
        const content = (data.description || data.content || '').toUpperCase();

        if (status === 'success' || status === 'completed' || data.transferType === 'IN') {
            const match = content.match(/NAP[_\s]?([A-Z0-9_]+)/);
            if (match && match[1]) {
                const username = match[1].toLowerCase();
                const db = readDB();
                const idx = db.users.findIndex(u => u.username.toLowerCase() === username);
                if (idx !== -1 && amount > 0) {
                    db.users[idx].balance += amount;
                    if (!db.users[idx].depositHistory) db.users[idx].depositHistory = [];
                    db.users[idx].depositHistory.push({ amount, method: 'webhub', transactionId: data.transactionId || data.orderId, at: new Date().toISOString() });
                    await syncUsersToSupabase([db.users[idx]]);
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
// MUA HÀNG / TẢI FILE
// ==========================================
app.post('/api/buy-product', async (req, res) => {
    try {
        const { username, productId, price, productName } = req.body;
        if (!username || productId === undefined || price === undefined)
            return res.status(400).json({ success: false, error: 'Thiếu thông tin' });

        const db = readDB();
        const idx = db.users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
        if (idx === -1) return res.status(404).json({ success: false, error: 'Không tìm thấy user' });

        const user = db.users[idx];
        if (user.balance < price) return res.status(400).json({ success: false, error: 'Số dư không đủ' });

        user.balance -= price;
        if (!user.purchaseHistory) user.purchaseHistory = [];
        user.purchaseHistory.push({ productId, productName, price, purchasedAt: new Date().toISOString() });
        await syncUsersToSupabase([user]);

        res.json({ success: true, newBalance: user.balance, productId });
    } catch (err) {
        console.error('Buy error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ⭐ SỬA: Tải 1 file cụ thể dưới dạng ZIP
app.get('/api/download/:productId', async (req, res) => {
    const { username } = req.query;
    const productId = req.params.productId;
    if (!username) return res.status(401).send('Chưa đăng nhập');

    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).send('Không tìm thấy user');

    const hasBought = (user.purchaseHistory || []).some(p => String(p.productId) === String(productId));
    if (!hasBought && String(productId) !== '1') {
        return res.status(403).send('Chưa mua sản phẩm.');
    }

    try {
        // BƯỚC 1: Tìm file trên R2
        const listCommand = new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME });
        const listResponse = await s3Client.send(listCommand);
        const allR2Files = (listResponse.Contents || []).map(item => item.Key);

        const foundFileName = allR2Files.find(f => f.startsWith(`${productId}.`));
        if (!foundFileName) {
            return res.status(404).send('File không tồn tại trên hệ thống lưu trữ.');
        }

        // BƯỚC 2: Tải file từ R2 → Buffer TRƯỚC khi pipe
        const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: foundFileName
        });
        const r2Response = await s3Client.send(command);
        if (!r2Response.Body) {
            return res.status(500).send('File rỗng hoặc không đọc được.');
        }
        const bodyBuffer = await streamToBuffer(r2Response.Body); // ⭐ FIX

        // BƯỚC 3: Tạo ZIP và pipe
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

// ==========================================
// TẢI NHIỀU FILE CHỈ ĐỊNH DƯỚI DẠNG ZIP
// ==========================================
app.get('/api/download-all', async (req, res) => {
    const { username, ids } = req.query;
    if (!username) return res.status(401).send('Chưa đăng nhập');

    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).send('Không tìm thấy user');

    let targetIds;
    if (ids) {
        const requestedIds = ids.split(',').map(s => s.trim()).filter(Boolean);
        const ownedIds = new Set((user.purchaseHistory || []).map(p => String(p.productId)));
        targetIds = requestedIds.filter(id => ownedIds.has(String(id)) || String(id) === '1');
    } else {
        targetIds = [...new Set((user.purchaseHistory || []).map(p => String(p.productId)))];
    }

    if (targetIds.length === 0) {
        return res.status(403).send('Không có file nào để tải.');
    }

    try {
        // BƯỚC 1: Liệt kê file trên R2
        const listCommand = new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME });
        const listResponse = await s3Client.send(listCommand);
        const allR2Files = (listResponse.Contents || []).map(item => item.Key);

        // BƯỚC 2: Tải TẤT CẢ file → Buffer TRƯỚC khi pipe
        const filesData = [];
        for (const id of targetIds) {
            const foundFileName = allR2Files.find(f => f.startsWith(`${id}.`));
            if (!foundFileName) continue;
            try {
                const command = new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: foundFileName
                });
                const r2Response = await s3Client.send(command);
                if (r2Response.Body) {
                    const buf = await streamToBuffer(r2Response.Body); // ⭐ FIX
                    filesData.push({ fileName: foundFileName, buffer: buf });
                }
            } catch (err) {
                console.log(`Lỗi tải file ${foundFileName} từ R2:`, err.message);
            }
        }

        if (filesData.length === 0) {
            return res.status(404).send('Không tìm thấy file nào trên hệ thống lưu trữ.');
        }

        // BƯỚC 3: Tạo ZIP từ các Buffer đã có
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
// TRANG THÔNG BÁO SAU KHI THANH TOÁN XONG
// ==========================================
app.get('/payment-return', (req, res) => {
    const message = req.query.message || 'Giao dịch đã được xử lý.';
    res.send(`
        <!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Kết quả thanh toán</title><style>body { font-family: sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; } .box { background: #1e293b; padding: 40px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-width: 400px; width: 90%; } h1 { color: #22c55e; font-size: 24px; margin-bottom: 10px; } p { color: #a0a5b5; font-size: 14px; margin-bottom: 20px; line-height: 1.5; } .btn { display: inline-block; padding: 12px 24px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold; transition: 0.3s; } .btn:hover { background: #2563eb; }</style></head><body><div class="box"><h1>🎉 Thanh toán hoàn tất!</h1><p>Cảm ơn bạn đã nạp tiền. Hệ thống sẽ tự động cộng tiền vào ví của bạn trong 1-2 phút.</p><p><strong>Trạng thái:</strong> ${message}</p><a href="${FRONTEND_URL}" class="btn">Quay lại trang chủ</a></div><script>setTimeout(() => { window.location.href = '${FRONTEND_URL}'; }, 5000);</script></body></html>
    `);
});

// ==========================================
// HEALTH + ERROR HANDLERS
// ==========================================
app.get('/api/health', async (req, res) => {
    const db = MEMORY_DB || DEFAULT_DB;
    
    // ⭐ Đếm orders từ Supabase
    let orderStats = { total: 0, pending: 0, paid: 0, underpaid: 0 };
    if (pool) {
        try {
            const { rows } = await pool.query(`
                SELECT status, COUNT(*) as count FROM orders GROUP BY status
            `);
            rows.forEach(r => {
                orderStats.total += Number(r.count);
                orderStats[r.status] = Number(r.count);
            });
        } catch (err) {
            console.error('Lỗi health orders:', err.message);
        }
    }

    res.json({
        status: 'ok', uptime: process.uptime(),
        storage: USE_GIST ? 'github-gist' : 'local-file',
        pay2sConfigured: !!PAY2S_PARTNER_CODE,
        webhubConfigured: !!WEBHUB_WEBHOOK_TOKEN,
        sepayConfigured: !!SEPAY_WEBHOOK_SECRET,
        isDirty, totalUsers: (db.users || []).length,
        totalKeys: db.keys.length, 
        pendingKeys: db.keys.filter(k => k.status === 'pending').length,
        confirmedKeys: db.keys.filter(k => k.status === 'confirmed').length, 
        totalFeedbacks: db.feedbacks.length,
        totalOrders: orderStats.total,
        pendingOrders: orderStats.pending || 0,
        paidOrders: orderStats.paid || 0,
        underpaidOrders: orderStats.underpaid || 0
    });
});

app.use((req, res) => res.status(404).json({ error: 'API không tồn tại: ' + req.path }));
app.use((err, req, res, next) => { console.error('❌ Server error:', err); res.status(500).json({ error: 'Lỗi server: ' + err.message }); });

// ==========================================
// TIMERS & START
// ==========================================
setInterval(() => { cleanupExpiredKeys(); }, CLEANUP_INTERVAL_MS);
setInterval(() => { flushToGist(true).catch(console.error); }, 60000);
setInterval(() => { syncSupabaseToGist(); }, 60 * 60 * 1000);

async function startServer() {
    await initDB();
    syncSupabaseToGist();
    const server = app.listen(PORT, () => {
        console.log(`\n✅ TYON SERVER BẢO MẬT chạy tại http://localhost:${PORT}`);
        console.log(`🔐 JWT Security: BẬT`);
        console.log(`🛡️ Rate Limit: BẬT`);
        console.log(`☁️  Storage: ${USE_GIST ? 'GitHub Gist' : 'LOCAL FILE'}`);
        console.log(`🗄️  Lưu Users: Supabase`);
        console.log(`💳 Pay2S: ${PAY2S_PARTNER_CODE ? 'Đã cấu hình' : 'CHƯA cấu hình'}`);
        console.log(`🌐 Frontend URL: ${FRONTEND_URL}\n`);
        console.log(`💳 SePay Webhook: ${SEPAY_WEBHOOK_SECRET ? 'Đã cấu hình' : 'CHƯA cấu hình'}`);
        console.log(`🏦 Bank: ${SEPAY_BANK_CODE} - ${SEPAY_BANK_ACCOUNT} (${SEPAY_ACCOUNT_HOLDER})`);
    });

    let shutting = false;
    async function shutdown(sig) {
        if (shutting) return; shutting = true;
        console.log(`\n👋 ${sig}...`);
        try { if (isDirty) await flushToGist(true); } catch (_) {}
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000).unref();
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
        console.error('❌ Uncaught:', err);
        if (isDirty && USE_GIST) { try { flushToGist(true); } catch (_) {} }
        setTimeout(() => process.exit(1), 2000);
    });
    process.on('unhandledRejection', (err) => console.error('❌ Unhandled:', err));
}

startServer();
