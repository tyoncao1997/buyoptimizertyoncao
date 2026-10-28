const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. CẤU HÌNH LƯU TRỮ (BẮT BUỘC TRÊN RENDER)
// ==========================================
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GIST_ID = (process.env.GIST_ID || '').trim();
const GIST_FILENAME = 'database.json';
const USE_GIST = !!(GITHUB_TOKEN && GIST_ID);

if (!USE_GIST) {
    console.error('❌ CẢNH BÁO: Bạn chưa cấu hình GITHUB_TOKEN và GIST_ID trên Render!');
    console.error('❌ Dữ liệu sẽ bị MẤT mỗi khi Render restart (sau 15 phút không truy cập).');
} else {
    console.log(`☁️  Lưu trữ: GitHub Gist (${GIST_ID}) — CHỐNG MẤT DATA TUYỆT ĐỐI`);
}

const LOCAL_DB_FILE = path.join(__dirname, 'database.json');
const LOCAL_BACKUP_DIR = path.join(__dirname, 'backups');

try {
    if (!fs.existsSync(LOCAL_BACKUP_DIR)) fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
} catch (err) {}

// Khung dữ liệu chuẩn
const DEFAULT_DB = { 
    keys: [], 
    confirmedKeys: [], 
    feedbackKeys: [], 
    feedbacks: [], 
    users: [] 
};

let MEMORY_DB = null;
let isDirty = false;
let isSyncing = false;
let lastSyncTime = 0;

// ==========================================
// 2. GITHUB GIST API (LƯU TRỮ VĨNH VIỄN)
// ==========================================
function gistRequest(method, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: `/gists/${GIST_ID}`,
            method: method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'TyonOptimizer-Render',
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { resolve(data); }
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
        if (file.truncated && file.raw_url) {
            content = await fetchRaw(file.raw_url);
        } else {
            content = file.content;
        }

        const parsed = JSON.parse(content || '{}');
        // Đảm bảo không bị lỗi undefined
        if (!parsed.keys) parsed.keys = [];
        if (!parsed.confirmedKeys) parsed.confirmedKeys = [];
        if (!parsed.feedbackKeys) parsed.feedbackKeys = [];
        if (!parsed.feedbacks) parsed.feedbacks = [];
        if (!parsed.users) parsed.users = []; 
        return parsed;
    } catch (err) {
        console.error('❌ Lỗi load từ Gist:', err.message);
        return null;
    }
}

function fetchRaw(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'TyonOptimizer-Render' } }, (res) => {
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
            files: {
                [GIST_FILENAME]: {
                    content: JSON.stringify(data, null, 2)
                }
            }
        });
        return true;
    } catch (err) {
        console.error('❌ Lỗi save lên Gist:', err.message);
        return false;
    }
}

// ==========================================
// 3. ĐỒNG BỘ DỮ LIỆU (DEBOUNCE CHỐNG SPAM GITHUB)
// ==========================================
let syncTimer = null;
const SYNC_DEBOUNCE_MS = 2000; // Đợi 2s gộp thay đổi rồi mới lưu

function scheduleSync() {
    isDirty = true;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => flushToGist(), SYNC_DEBOUNCE_MS);
}

async function flushToGist(force = false) {
    if (isSyncing) return;
    if (!isDirty && !force) return;
    
    if (!USE_GIST) {
        saveLocal(MEMORY_DB);
        isDirty = false;
        return;
    }

    isSyncing = true;
    try {
        const success = await saveToGist(MEMORY_DB);
        if (success) {
            isDirty = false;
            lastSyncTime = Date.now();
            saveLocal(MEMORY_DB); // Lưu cache local dự phòng
        } else {
            console.warn('⚠️ Sync Gist thất bại, sẽ retry sau 30s');
            setTimeout(() => flushToGist(true), 30000);
        }
    } finally {
        isSyncing = false;
    }
}

// ==========================================
// 4. LOCAL CACHE (DỰ PHÒNG)
// ==========================================
function saveLocal(data) {
    try {
        const tmp = LOCAL_DB_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, LOCAL_DB_FILE);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(LOCAL_DB_FILE, path.join(LOCAL_BACKUP_DIR, `db-${ts}.json`));
        const backups = fs.readdirSync(LOCAL_BACKUP_DIR).filter(f => f.startsWith('db-') && f.endsWith('.json')).sort().reverse();
        backups.slice(5).forEach(f => { try { fs.unlinkSync(path.join(LOCAL_BACKUP_DIR, f)); } catch (_) {} });
    } catch (err) {}
}

function loadLocal() {
    try {
        if (!fs.existsSync(LOCAL_DB_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_FILE, 'utf8'));
        if (!data.keys) data.keys = [];
        if (!data.confirmedKeys) data.confirmedKeys = [];
        if (!data.feedbackKeys) data.feedbackKeys = [];
        if (!data.feedbacks) data.feedbacks = [];
        if (!data.users) data.users = [];
        return data;
    } catch (err) {
        return null;
    }
}

// ==========================================
// 5. HÀM ĐỌC/GHI DB CHÍNH
// ==========================================
function readDB() {
    if (!MEMORY_DB) return { ...DEFAULT_DB };
    return JSON.parse(JSON.stringify(MEMORY_DB));
}

function writeDB(data) {
    if (!data.keys) data.keys = [];
    if (!data.confirmedKeys) data.confirmedKeys = [];
    if (!data.feedbackKeys) data.feedbackKeys = [];
    if (!data.feedbacks) data.feedbacks = [];
    if (!data.users) data.users = []; 

    MEMORY_DB = data;
    scheduleSync();
}

// ==========================================
// 6. KHỞI TẠO DB KHI SERVER START
// ==========================================
async function initDB() {
    console.log('🔄 Đang tải database...');
    if (USE_GIST) {
        const remote = await loadFromGist();
        if (remote) {
            MEMORY_DB = remote;
            console.log(`✅ Đã tải từ Gist: ${remote.keys.length} keys, ${remote.users.length} users`);
            saveLocal(remote);
            return;
        }
    }

    const local = loadLocal();
    if (local) {
        MEMORY_DB = local;
        console.log(`✅ Đã tải từ local cache: ${local.keys.length} keys`);
        if (USE_GIST) await saveToGist(local);
        return;
    }

    MEMORY_DB = { ...DEFAULT_DB };
    console.log('📁 Khởi tạo DB mới (empty)');
    if (USE_GIST) await saveToGist(MEMORY_DB);
    saveLocal(MEMORY_DB);
}

// ==========================================
// 7. CẤU HÌNH CHUNG & MIDDLEWARE
// ==========================================
const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const ADMIN_USERNAME = 'caoquangtuan';
const ADMIN_PASSWORD = 'CaoQuangTuan@026209000010';
const ADMIN_PIN = '997722';

const PAY2S_WEBHOOK_TOKEN = 'cc06a956bb11a0a175e6e1007218277bb3322903db0a1e05df';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ==========================================
// 8. HÀM TIỆN ÍCH
// ==========================================
function cleanupExpiredKeys() {
    if (!MEMORY_DB) return { deletedCount: 0 };
    const now = Date.now();
    const before = MEMORY_DB.keys.length;

    MEMORY_DB.keys = MEMORY_DB.keys.filter(k => {
        if (k.status === 'confirmed') return true;
        if (k.status !== 'pending') return true;
        const age = now - new Date(k.createdAt).getTime();
        if (age > KEY_EXPIRE_MS) {
            console.log(`   🗑️ Xóa key hết hạn: ${k.key}`);
            return false;
        }
        return true;
    });

    const deletedCount = before - MEMORY_DB.keys.length;
    if (deletedCount > 0) writeDB(MEMORY_DB);
    return { deletedCount };
}

function calcRemainingTime(createdAt, status) {
    if (status !== 'pending') return null;
    const diffMs = (new Date(createdAt).getTime() + KEY_EXPIRE_MS) - Date.now();
    if (diffMs <= 0) return { hours: 0, minutes: 0, isExpired: true };
    return {
        hours: Math.floor(diffMs / 3600000),
        minutes: Math.floor((diffMs % 3600000) / 60000),
        isExpired: false
    };
}

function verifyAdmin(username, password) {
    return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

// ==========================================
// 9. API KEY & ADMIN
// ==========================================
app.post('/api/create-key', (req, res) => {
    const { plan, customerName, transferContent, amount } = req.body;
    if (!plan || !customerName) return res.status(400).json({ error: 'Thiếu thông tin' });

    cleanupExpiredKeys();
    const db = readDB();

    const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase();
    const key = `TYON-${plan.toUpperCase()}-${randomPart}-${timestamp}`;

    db.keys.push({
        key, plan, customerName,
        transferContent: transferContent || '',
        amount: amount || 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + KEY_EXPIRE_MS).toISOString()
    });
    
    writeDB(db);
    res.json({ success: true, key });
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
            if (fbRecord) {
                k.feedbackKey = fbRecord.feedbackKey;
                k.isFeedbackUsed = fbRecord.isUsed;
            }
        }
        return k;
    });
    res.json({ success: true, keys });
});

app.post('/api/admin/confirm-key', (req, res) => {
    const { username, password, pin, key } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    if (pin !== ADMIN_PIN) return res.status(403).json({ error: 'Sai mã PIN' });

    const db = readDB();
    const keyIndex = db.keys.findIndex(k => k.key === key);
    if (keyIndex === -1) return res.status(404).json({ error: 'Không tìm thấy key.' });
    if (db.keys[keyIndex].status === 'confirmed') return res.status(400).json({ error: 'Key đã xác nhận.' });

    db.keys[keyIndex].status = 'confirmed';
    db.keys[keyIndex].confirmedAt = new Date().toISOString();
    
    const feedbackKey = `FB-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    db.feedbackKeys.push({
        feedbackKey,
        originalKey: key,
        customerName: db.keys[keyIndex].customerName,
        isUsed: false,
        createdAt: new Date().toISOString()
    });

    writeDB(db);
    res.json({ success: true, feedbackKey });
});

// 🔥 API CHECK KEY (ĐÃ FIX CHO FRONTEND)
app.post('/api/check-key', (req, res) => {
    const { query } = req.body; // Nhận query từ Frontend
    if (!query) return res.status(400).json({ error: 'Thiếu từ khóa' });

    cleanupExpiredKeys();
    const db = readDB();
    const searchTerm = query.trim().toUpperCase();

    const matches = db.keys.filter(k =>
        (k.key && k.key.toUpperCase().includes(searchTerm)) ||
        (k.transferContent && k.transferContent.toUpperCase().includes(searchTerm)) ||
        (k.customerName && k.customerName.toUpperCase().includes(searchTerm))
    );

    const formattedResults = matches.map(k => {
        const rem = calcRemainingTime(k.createdAt, k.status);
        return {
            ...k,
            remainingTime: rem && !rem.isExpired ? rem : null,
            isExpired: rem ? rem.isExpired : false
        };
    });

    // Trả về cả 2 key 'keys' và 'results' để tương thích mọi phiên bản Frontend
    res.json({ success: true, keys: formattedResults, results: formattedResults });
});

app.post('/api/admin/cleanup-now', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    const result = cleanupExpiredKeys();
    res.json({ success: true, message: `Đã xóa ${result.deletedCount} key.` });
});

// ==========================================
// 10. API FEEDBACK
// ==========================================
app.get('/api/feedbacks', (req, res) => {
    const db = readDB();
    res.json({ success: true, feedbacks: [...db.feedbacks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

// 🔥 API SUBMIT FEEDBACK (ĐÃ FIX CHO FRONTEND)
app.post('/api/submit-feedback', (req, res) => {
    const { key, feedbackKey, rating, content, images } = req.body;
    const actualKey = feedbackKey || key; // Hỗ trợ cả 2 biến

    if (!actualKey) return res.status(400).json({ error: 'Thiếu Feedback Key' });

    const db = readDB();
    const fbIdx = db.feedbackKeys.findIndex(fk => fk.feedbackKey === actualKey);

    if (fbIdx === -1) return res.status(400).json({ error: 'Feedback Key không hợp lệ.' });
    if (db.feedbackKeys[fbIdx].isUsed) return res.status(400).json({ error: 'Feedback Key đã sử dụng.' });

    db.feedbackKeys[fbIdx].isUsed = true;
    db.feedbackKeys[fbIdx].usedAt = new Date().toISOString();

    db.feedbacks.push({
        id: Date.now().toString(),
        customerName: db.feedbackKeys[fbIdx].customerName,
        feedbackKey: actualKey,
        rating: Number(rating),
        content,
        images: images || [],
        createdAt: new Date().toISOString()
    });

    writeDB(db);
    res.json({ success: true, message: 'Gửi đánh giá thành công!' });
});

// ==========================================
// 11. API USERS, PAY2S & MUA HÀNG
// ==========================================
app.get('/api/user/:username', (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (user) {
        res.json({ success: true, user: { username: user.username, balance: user.balance, fullName: user.fullName } });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

app.post('/api/register', (req, res) => {
    const { username, password, fullName } = req.body;
    if (!username || !password || !fullName) return res.status(400).json({ error: 'Thiếu thông tin' });

    const db = readDB();
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ error: 'Username đã tồn tại' });
    }

    db.users.push({
        username, password, fullName, balance: 0, createdAt: new Date().toISOString()
    });
    writeDB(db);
    res.json({ success: true, message: 'Đăng ký thành công', user: { username, fullName, balance: 0 } });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
    if (user) {
        res.json({ success: true, user: { username: user.username, fullName: user.fullName, balance: user.balance } });
    } else {
        res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    }
});

app.post('/api/pay2s-webhook', (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${PAY2S_WEBHOOK_TOKEN}`) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const data = req.body;
        if (data.transferType === 'IN') {
            const amount = parseInt(data.transferAmount);
            const content = (data.content || '').toUpperCase();
            const match = content.match(/NAP[_\s]?([A-Z0-9]+)/);

            if (match && match[1]) {
                const username = match[1].toLowerCase();
                const db = readDB();
                const userIndex = db.users.findIndex(u => u.username.toLowerCase() === username);

                if (userIndex !== -1) {
                    db.users[userIndex].balance += amount;
                    writeDB(db);
                    console.log(`✅ Cộng ${amount}đ cho: ${username}`);
                }
            }
        }
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/buy-product', (req, res) => {
    const { username, productId, price, productName } = req.body;
    if (!username || !productId || price === undefined) return res.status(400).json({ error: 'Thiếu thông tin' });

    const db = readDB();
    const userIndex = db.users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (userIndex === -1) return res.status(404).json({ error: 'Không tìm thấy user' });

    const user = db.users[userIndex];
    if (user.balance < price) return res.status(400).json({ error: 'Số dư không đủ' });

    user.balance -= price;
    if (!user.purchaseHistory) user.purchaseHistory = [];
    user.purchaseHistory.push({ productId, productName, price, purchasedAt: new Date().toISOString() });

    writeDB(db);
    res.json({ success: true, newBalance: user.balance });
});

app.get('/api/download/:productId', (req, res) => {
    const { username } = req.query;
    const productId = req.params.productId;
    if (!username) return res.status(401).send('Chưa đăng nhập');

    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).send('Không tìm thấy user');

    const hasBought = user.purchaseHistory && user.purchaseHistory.some(p => String(p.productId) === String(productId));
    if (hasBought || String(productId) === '1') {
        const filePath = path.join(__dirname, 'files', `${productId}.reg`);
        if (fs.existsSync(filePath)) res.download(filePath, `TYON_${productId}.reg`);
        else res.status(404).send('File không tồn tại.');
    } else {
        res.status(403).send('Chưa mua sản phẩm.');
    }
});

// ==========================================
// 12. HEALTH CHECK & KHỞI ĐỘNG
// ==========================================
app.get('/api/health', (req, res) => {
    const db = MEMORY_DB || DEFAULT_DB;
    res.json({
        status: 'ok',
        storage: USE_GIST ? 'github-gist' : 'local-file (RỦI RO)',
        users: db.users.length,
        keys: db.keys.length,
        feedbacks: db.feedbacks.length
    });
});

app.use((req, res) => res.status(404).json({ error: 'API không tồn tại' }));

// Dọn rác định kỳ
setInterval(() => { cleanupExpiredKeys(); }, CLEANUP_INTERVAL_MS);
setInterval(() => { if (isDirty) flushToGist(true); }, 60000);

async function startServer() {
    await initDB();

    const server = app.listen(PORT, () => {
        console.log(`\n✅ TYON OPTIMIZER SERVER ĐANG CHẠY TRÊN PORT ${PORT}`);
        console.log(`☁️ Storage: ${USE_GIST ? 'GitHub Gist' : '⚠️ LOCAL FILE'}`);
    });

    // Xử lý tắt server an toàn (Graceful Shutdown)
    const shutdown = async () => {
        console.log('\n👋 Đang tắt server...');
        if (isDirty) await flushToGist(true);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

startServer();
