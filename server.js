const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto'); 

const app = express();
const PORT = process.env.PORT || 3000;

// ⭐ KHAI BÁO DOMAIN FRONTEND
const FRONTEND_URL = 'https://buyoptimizertc.infinityfreeapp.com';

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

const DEFAULT_DB = { keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [], users: [] };

let MEMORY_DB = null;
let isDirty = false;
let isSyncing = false;
let lastSyncTime = 0;

// ==========================================
// GITHUB GIST
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
        for (const k of ['keys', 'confirmedKeys', 'feedbackKeys', 'feedbacks', 'users'])
            if (!parsed[k]) parsed[k] = [];
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

async function saveToGist(data) {
    if (!USE_GIST) return false;
    try {
        await gistRequest('PATCH', {
            files: { [GIST_FILENAME]: { content: JSON.stringify(data, null, 2) } }
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
        const success = await saveToGist(MEMORY_DB);
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
        for (const k of ['keys', 'confirmedKeys', 'feedbackKeys', 'feedbacks', 'users'])
            if (!data[k]) data[k] = [];
        return data;
    } catch { return null; }
}

function readDB() {
    if (!MEMORY_DB) return JSON.parse(JSON.stringify(DEFAULT_DB));
    return JSON.parse(JSON.stringify(MEMORY_DB));
}

function writeDB(data) {
    for (const k of ['keys', 'confirmedKeys', 'feedbackKeys', 'feedbacks', 'users'])
        if (!data[k]) data[k] = [];
    MEMORY_DB = data;
    scheduleSync();
}

async function initDB() {
    if (USE_GIST) {
        const remote = await loadFromGist();
        if (remote) { MEMORY_DB = remote; saveLocal(remote); return; }
    }
    const local = loadLocal();
    if (local) { MEMORY_DB = local; if (USE_GIST) await saveToGist(local); return; }
    MEMORY_DB = JSON.parse(JSON.stringify(DEFAULT_DB));
    if (USE_GIST) await saveToGist(MEMORY_DB);
    saveLocal(MEMORY_DB);
}

// ==========================================
// CONFIG
// ==========================================
const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const ADMIN_USERNAME = 'caoquangtuan';
const ADMIN_PASSWORD = 'CaoQuangTuan@026209000010';
const ADMIN_PIN = '997722';

// CẤU HÌNH PAY2S
const PAY2S_PARTNER_CODE = process.env.PAY2S_PARTNER_CODE || 'PAY2SBB7A1S4XSJKIT8J';
const PAY2S_ACCESS_KEY = process.env.PAY2S_ACCESS_KEY || '9fce013493559f0aff6385819e583c9308a9a922999fe8e2119ca3775637e9f6'; 
const PAY2S_SECRET_KEY = process.env.PAY2S_SECRET_KEY || '653b08db2e03f9aa1499d4ce40c63e2c525cdd0f64a09b4ed37e5d5d40772dc0'; 
const PAY2S_API_URL = 'https://payment.pay2s.vn/v1/gateway/api/create';
const PAY2S_WEBHOOK_TOKEN = process.env.PAY2S_WEBHOOK_TOKEN || 'cc06a956bb11a0a175e6e1007218277bb3322903db0a1e05df';

// WEBHUB CONFIG (Dự phòng)
const WEBHUB_WEBHOOK_TOKEN = process.env.WEBHUB_WEBHOOK_TOKEN || '';
const WEBHUB_API_BASE = process.env.WEBHUB_API_BASE || 'https://api.webhub.vn/v1';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ==========================================
// CLEANUP & HELPERS (CHỈ XÓA KEY CHƯA XÁC NHẬN)
// ==========================================
function cleanupExpiredKeys() {
    if (!MEMORY_DB) return { deletedCount: 0 };
    const now = Date.now();
    const before = MEMORY_DB.keys.length;

    // CHỈ LỌC MẢNG keys, TUYỆT ĐỐI KHÔNG ĐỘNG VÀO MẢNG users
    MEMORY_DB.keys = MEMORY_DB.keys.filter(k => {
        if (k.status === 'confirmed') return true; 
        if (k.status !== 'pending') return true; 
        const age = now - new Date(k.createdAt).getTime();
        return age <= KEY_EXPIRE_MS; 
    });

    const deletedCount = before - MEMORY_DB.keys.length;
    if (deletedCount > 0) {
        writeDB(MEMORY_DB);
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

function verifyAdmin(username, password) {
    return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

// ==========================================
// KEY ENDPOINTS
// ==========================================
app.post('/api/create-key', (req, res) => {
    const { plan, customerName, transferContent, amount } = req.body;
    if (!plan || !customerName) return res.status(400).json({ error: 'Thiếu thông tin' });
    cleanupExpiredKeys();
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
    writeDB(db);
    res.json({ success: true, key, expiresAt: newKey.expiresAt,
        message: `Key đã tạo. Xác nhận trong ${KEY_EXPIRE_HOURS}h.` });
});

app.post('/api/admin/keys', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    cleanupExpiredKeys();
    const db = readDB();
    const keys = db.keys.map(k => {
        if (k.status === 'pending') {
            const rem = calcRemainingTime(k.createdAt, k.status);
            return { ...k, remainingHours: rem.hours, remainingMinutes: rem.minutes };
        }
        if (k.status === 'confirmed') {
            const fbRecord = db.feedbackKeys.find(fk => fk.originalKey === k.key);
            if (fbRecord) { k.feedbackKey = fbRecord.feedbackKey; k.isFeedbackUsed = fbRecord.isUsed; }
        }
        return k;
    });
    res.json({ keys });
});

app.post('/api/admin/confirm-key', (req, res) => {
    const { username, password, pin, key } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    if (pin !== ADMIN_PIN) return res.status(403).json({ error: 'Sai PIN' });
    cleanupExpiredKeys();
    const db = readDB();
    const idx = db.keys.findIndex(k => k.key === key);
    if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy key' });
    if (db.keys[idx].status === 'confirmed') return res.status(400).json({ error: 'Đã xác nhận' });
    db.keys[idx].status = 'confirmed';
    db.keys[idx].confirmedAt = new Date().toISOString();
    db.keys[idx].confirmedBy = username;
    const feedbackKey = `FB-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    db.feedbackKeys.push({
        feedbackKey, originalKey: key,
        customerName: db.keys[idx].customerName, isUsed: false,
        createdAt: new Date().toISOString()
    });
    writeDB(db);
    res.json({ success: true, message: 'OK', feedbackKey, keyData: db.keys[idx] });
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

app.post('/api/admin/cleanup-now', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    const result = cleanupExpiredKeys();
    res.json({ success: true, message: `Đã xóa ${result.deletedCount} key hết hạn. Các tài khoản người dùng được giữ nguyên.` });
});

// ==========================================
// FEEDBACK
// ==========================================
app.get('/api/feedbacks', (req, res) => {
    const db = readDB();
    res.json({ feedbacks: [...db.feedbacks].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.post('/api/submit-feedback', (req, res) => {
    const { feedbackKey, rating, content, images } = req.body;
    if (!feedbackKey) return res.status(400).json({ error: 'Thiếu Feedback Key' });
    const db = readDB();
    const idx = db.feedbackKeys.findIndex(fk => fk.feedbackKey === feedbackKey);
    if (idx === -1) return res.status(400).json({ error: 'Feedback Key không hợp lệ' });
    if (db.feedbackKeys[idx].isUsed) return res.status(400).json({ error: 'Key đã sử dụng' });
    db.feedbackKeys[idx].isUsed = true;
    db.feedbackKeys[idx].usedAt = new Date().toISOString();
    const fb = {
        id: Date.now().toString(),
        customerName: db.feedbackKeys[idx].customerName,
        feedbackKey, rating: Number(rating), content,
        images: images || [], createdAt: new Date().toISOString()
    };
    db.feedbacks.push(fb);
    writeDB(db);
    res.json({ success: true, message: 'OK', feedback: fb });
});

app.post('/api/admin/feedbacks', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    const db = readDB();
    res.json({ feedbacks: [...db.feedbacks].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.post('/api/admin/users', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    
    const db = readDB();
    // Trả về danh sách users (có thể ẩn bớt password nếu muốn bảo mật)
    const users = db.users.map(u => ({
        username: u.username,
        password: u.password, // Có thể xóa dòng này nếu không muốn Admin thấy pass
        fullName: u.fullName,
        balance: u.balance || 0,
        createdAt: u.createdAt,
        depositCount: (u.depositHistory || []).length,
        purchaseCount: (u.purchaseHistory || []).length
    }));
    
    res.json({ success: true, users });
});

// ==========================================
// USER AUTH
// ==========================================
app.post('/api/register', (req, res) => {
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

        const newUser = {
            username, password, fullName,
            balance: 0,
            purchaseHistory: [],
            depositHistory: [],
            createdAt: new Date().toISOString()
        };
        db.users.push(newUser);
        writeDB(db);

        await flushToGist(true); 

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

app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({ success: false, error: 'Thiếu thông tin' });

        const db = readDB();
        const user = db.users.find(u =>
            u.username.toLowerCase() === username.toLowerCase() && u.password === password);

        if (!user) return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu' });

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
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ⭐ ĐÃ SỬA: TRẢ VỀ ĐẦY ĐỦ LỊCH SỬ
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

// ==========================================
// API ĐỔI MẬT KHẨU
// ==========================================
app.post('/api/change-password', (req, res) => {
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

        if (db.users[idx].password !== oldPassword) {
            return res.status(400).json({ success: false, error: 'Mật khẩu cũ không chính xác' });
        }

        db.users[idx].password = newPassword;
        writeDB(db);
        res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// ==========================================
// PAY2S: TẠO ĐƠN HÀNG
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

        const rawSignature = `accessKey=${PAY2S_ACCESS_KEY}` +
            `&amount=${amount}` +
            `&bankAccounts=Array` +
            `&ipnUrl=${ipnUrl}` +
            `&orderId=${orderId}` +
            `&orderInfo=${orderInfo}` +
            `&partnerCode=${PAY2S_PARTNER_CODE}` +
            `&redirectUrl=${redirectUrl}` +
            `&requestId=${requestId}` +
            `&requestType=pay2s`;

        const signature = crypto.createHmac('sha256', PAY2S_SECRET_KEY)
            .update(rawSignature)
            .digest('hex');

        const payload = {
            accessKey: PAY2S_ACCESS_KEY,
            partnerCode: PAY2S_PARTNER_CODE,
            partnerName: 'TYON Optimizer',
            requestId: requestId,
            amount: amount,
            orderId: orderId,
            orderInfo: orderInfo,
            requestType: 'pay2s',
            redirectUrl: redirectUrl,
            ipnUrl: ipnUrl,
            bankAccounts: [{ account_number: "0976289958", bank_id: "MBB" }],
            signature: signature
        };

        console.log('[Pay2S] Tạo đơn:', payload);

        const response = await fetch(PAY2S_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        console.log('[Pay2S] Response:', result);

        if (result.status === true || result.resultCode === 0) {
            res.json({
                success: true,
                paymentUrl: result.payUrl || result.paymentUrl || result.data?.payUrl
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.message || 'Tạo đơn Pay2S thất bại',
                raw: result
            });
        }

    } catch (err) {
        console.error('Pay2S create order error:', err);
        res.status(500).json({ success: false, error: 'Lỗi kết nối Pay2S: ' + err.message });
    }
});

// ==========================================
// PAY2S: WEBHOOK IPN (SỬA LỖI CỘNG TIỀN KHI HỦY)
// ==========================================
app.post('/api/pay2s-webhook', (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        if (authHeader && !authHeader.includes(PAY2S_WEBHOOK_TOKEN)) {
            console.log('[Pay2S Webhook] Unauthorized - Token không khớp');
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const data = req.body;
        console.log('📥 Pay2S webhook:', JSON.stringify(data).substring(0, 500));

        if (data.m2signature) {
            const rawHash = `accessKey=${data.accessKey}&amount=${data.amount}&extraData=${data.extraData || ''}&message=${data.message}&orderId=${data.orderId}&orderInfo=${data.orderInfo}&orderType=${data.orderType}&partnerCode=${data.partnerCode}&payType=${data.payType}&requestId=${data.requestId}&responseTime=${data.responseTime}&resultCode=${data.resultCode}&transId=${data.transId}`;
            
            const expectedSignature = crypto.createHmac('sha256', PAY2S_SECRET_KEY)
                .update(rawHash)
                .digest('hex');

            if (expectedSignature !== data.m2signature) {
                console.log('[Pay2S Webhook] Chữ ký không hợp lệ!');
                return res.status(400).json({ success: false, message: 'Invalid signature' });
            }
        }

        // ⭐ BẮT ĐẦU SỬA: Chỉ cộng tiền nếu resultCode = 0 (Thành công)
        const resultCode = String(data.resultCode);
        if (resultCode !== '0') {
            console.log(`⚠️ [Pay2S] Giao dịch không thành công (Mã: ${resultCode}). Không cộng tiền.`);
            return res.status(200).json({ success: true });
        }

        const amount = parseInt(data.amount || data.transferAmount || 0);
        const content = (data.orderInfo || data.content || '').toUpperCase();
        const match = content.match(/NAP[_\s]?([A-Z0-9_]+)/);

        if (match && match[1] && amount > 0) {
            const username = match[1].toLowerCase();
            const db = readDB();
            const idx = db.users.findIndex(u => u.username.toLowerCase() === username);

            if (idx !== -1) {
                // Kiểm tra trùng lặp giao dịch
                const transId = data.transId || data.transactionNumber;
                const isDuplicate = (db.users[idx].depositHistory || []).some(d => d.transactionId === transId);
                
                if (isDuplicate) {
                    console.log(`⚠️ [Pay2S] Giao dịch ${transId} đã được xử lý trước đó. Bỏ qua.`);
                    return res.status(200).json({ success: true });
                }

                db.users[idx].balance += amount;
                if (!db.users[idx].depositHistory) db.users[idx].depositHistory = [];
                db.users[idx].depositHistory.push({
                    amount, method: 'pay2s', content: data.orderInfo || data.content,
                    transactionId: transId,
                    at: new Date().toISOString()
                });
                writeDB(db);
                console.log(`✅ [Pay2S] Cộng ${amount}đ cho: ${username}`);
            } else {
                console.log(`⚠️ [Pay2S] Không tìm thấy user: ${username}`);
            }
        }

        res.status(200).json({ success: true });

    } catch (error) {
        console.error('Pay2S webhook error:', error);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// WEBHUB (DỰ PHÒNG)
// ==========================================
app.post('/api/webhub-create-order', async (req, res) => {
    try {
        const { username, amount } = req.body;
        if (!username || !amount || amount < 10000)
            return res.status(400).json({ success: false, error: 'Số tiền tối thiểu 10,000đ' });

        if (!WEBHUB_WEBHOOK_TOKEN) {
            return res.status(500).json({ success: false, error: 'WebHub chưa được cấu hình' });
        }

        const webhubRes = await fetch(`${WEBHUB_API_BASE}/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WEBHUB_WEBHOOK_TOKEN}`
            },
            body: JSON.stringify({
                amount: amount,
                description: `NAP_${username}`,
                return_url: `${process.env.BASE_URL || 'http://localhost:3000'}/payment-return`
            })
        });

        const rawText = await webhubRes.text();
        let result;
        try { result = JSON.parse(rawText); } catch { result = { raw: rawText }; }

        if (!webhubRes.ok) {
            return res.status(400).json({
                success: false,
                error: result.message || result.error || `WebHub trả về lỗi ${webhubRes.status}`
            });
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

app.post('/api/webhub-webhook', (req, res) => {
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
                    db.users[idx].depositHistory.push({
                        amount, method: 'webhub',
                        transactionId: data.transactionId || data.orderId,
                        at: new Date().toISOString()
                    });
                    writeDB(db);
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
app.post('/api/buy-product', (req, res) => {
    try {
        const { username, productId, price, productName } = req.body;
        if (!username || productId === undefined || price === undefined)
            return res.status(400).json({ success: false, error: 'Thiếu thông tin' });

        const db = readDB();
        const idx = db.users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
        if (idx === -1) return res.status(404).json({ success: false, error: 'Không tìm thấy user' });

        const user = db.users[idx];
        if (user.balance < price)
            return res.status(400).json({ success: false, error: 'Số dư không đủ' });

        user.balance -= price;
        if (!user.purchaseHistory) user.purchaseHistory = [];
        user.purchaseHistory.push({
            productId, productName, price, purchasedAt: new Date().toISOString()
        });
        writeDB(db);

        res.json({ success: true, newBalance: user.balance });
    } catch (err) {
        console.error('Buy error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

app.get('/api/download/:productId', (req, res) => {
    const { username } = req.query;
    const productId = req.params.productId;
    if (!username) return res.status(401).send('Chưa đăng nhập');

    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).send('Không tìm thấy user');

    const hasBought = (user.purchaseHistory || []).some(p => String(p.productId) === String(productId));
    
    if (hasBought || String(productId) === '1') {
        const filesDir = path.join(__dirname, 'files');
        let filePath = '';
        let originalFileName = '';

        if (fs.existsSync(filesDir)) {
            const filesInDir = fs.readdirSync(filesDir);
            const foundFile = filesInDir.find(f => f.startsWith(`${productId}.`));
            
            if (foundFile) {
                filePath = path.join(filesDir, foundFile);
                originalFileName = foundFile; 
            }
        }

        if (filePath && fs.existsSync(filePath)) {
            res.download(filePath, `TYON_${originalFileName}`);
        } else {
            res.status(404).send('File không tồn tại trên server.');
        }
    } else {
        res.status(403).send('Chưa mua sản phẩm.');
    }
});

// ==========================================
// TRANG THÔNG BÁO SAU KHI THANH TOÁN XONG
// ==========================================
app.get('/payment-return', (req, res) => {
    const message = req.query.message || 'Giao dịch đã được xử lý.';
    
    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Kết quả thanh toán - TYON Optimizer</title>
            <style>
                body { font-family: sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
                .box { background: #1e293b; padding: 40px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-width: 400px; width: 90%; }
                h1 { color: #22c55e; font-size: 24px; margin-bottom: 10px; }
                p { color: #a0a5b5; font-size: 14px; margin-bottom: 20px; line-height: 1.5; }
                .btn { display: inline-block; padding: 12px 24px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold; transition: 0.3s; }
                .btn:hover { background: #2563eb; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>🎉 Thanh toán hoàn tất!</h1>
                <p>Cảm ơn bạn đã nạp tiền. Hệ thống sẽ tự động cộng tiền vào ví của bạn trong 1-2 phút.</p>
                <p><strong>Trạng thái:</strong> ${message}</p>
                
                <a href="${FRONTEND_URL}" class="btn">Quay lại trang chủ</a>
            </div>
            
            <script>
                setTimeout(() => { window.location.href = '${FRONTEND_URL}'; }, 5000);
            </script>
        </body>
        </html>
    `);
});

// ==========================================
// HEALTH + ERROR HANDLERS
// ==========================================
app.get('/api/health', (req, res) => {
    const db = MEMORY_DB || DEFAULT_DB;
    res.json({
        status: 'ok', uptime: process.uptime(),
        storage: USE_GIST ? 'github-gist' : 'local-file',
        pay2sConfigured: !!PAY2S_PARTNER_CODE,
        webhubConfigured: !!WEBHUB_WEBHOOK_TOKEN,
        isDirty, totalUsers: (db.users || []).length,
        totalKeys: db.keys.length,
        pendingKeys: db.keys.filter(k => k.status === 'pending').length,
        confirmedKeys: db.keys.filter(k => k.status === 'confirmed').length,
        totalFeedbacks: db.feedbacks.length
    });
});

// 404 — PHẢI NẰM CUỐI CÙNG
app.use((req, res) => res.status(404).json({ error: 'API không tồn tại: ' + req.path }));

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
});

// ==========================================
// TIMERS
// ==========================================
setInterval(() => { cleanupExpiredKeys(); }, CLEANUP_INTERVAL_MS);
setInterval(() => { if (isDirty) flushToGist(true); }, 60000);

// ==========================================
// START
// ==========================================
async function startServer() {
    await initDB();
    const server = app.listen(PORT, () => {
        console.log(`\n✅ TYON SERVER chạy tại http://localhost:${PORT}`);
        console.log(`☁️  Storage: ${USE_GIST ? 'GitHub Gist' : 'LOCAL FILE'}`);
        console.log(`💳 Pay2S: ${PAY2S_PARTNER_CODE ? 'Đã cấu hình' : 'CHƯA cấu hình'}`);
        console.log(`🌐 Frontend URL: ${FRONTEND_URL}\n`);
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
