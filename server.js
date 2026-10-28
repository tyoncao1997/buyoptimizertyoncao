const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CẤU HÌNH LƯU TRỮ (GITHUB GIST)
// ==========================================
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GIST_ID = (process.env.GIST_ID || '').trim();
const GIST_FILENAME = 'database.json';
const USE_GIST = !!(GITHUB_TOKEN && GIST_ID);

const LOCAL_DB_FILE = path.join(__dirname, 'database.json');
const DEFAULT_DB = { keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [], users: [] };
let MEMORY_DB = null;
let isDirty = false;
let isSyncing = false;

// Middleware bắt buộc
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

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
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
                } else { reject(new Error(`Gist ${res.statusCode}`)); }
            });
        });
        req.on('error', reject);
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
        let content = file.truncated ? await fetchRaw(file.raw_url) : file.content;
        const parsed = JSON.parse(content || '{}');
        return {
            keys: parsed.keys || [],
            confirmedKeys: parsed.confirmedKeys || [],
            feedbackKeys: parsed.feedbackKeys || [],
            feedbacks: parsed.feedbacks || [],
            users: parsed.users || []
        };
    } catch (err) { console.error('Lỗi load Gist:', err.message); return null; }
}

function fetchRaw(url) {
    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'TyonOptimizer' } }, (res) => {
            let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
        });
    });
}

async function saveToGist(data) {
    if (!USE_GIST) return false;
    try {
        await gistRequest('PATCH', { files: { [GIST_FILENAME]: { content: JSON.stringify(data, null, 2) } } });
        return true;
    } catch (err) { console.error('Lỗi save Gist:', err.message); return false; }
}

function scheduleSync() {
    isDirty = true;
    setTimeout(async () => {
        if (isSyncing || !isDirty) return;
        isSyncing = true;
        const success = await saveToGist(MEMORY_DB);
        if (success) isDirty = false;
        isSyncing = false;
    }, 2000);
}

async function initDB() {
    if (USE_GIST) {
        const remote = await loadFromGist();
        if (remote) { MEMORY_DB = remote; console.log('✅ Đã tải DB từ Gist'); return; }
    }
    if (fs.existsSync(LOCAL_DB_FILE)) {
        try { MEMORY_DB = JSON.parse(fs.readFileSync(LOCAL_DB_FILE)); } catch(e){}
    }
    if (!MEMORY_DB) MEMORY_DB = { ...DEFAULT_DB };
}
initDB();

function readDB() { return JSON.parse(JSON.stringify(MEMORY_DB || DEFAULT_DB)); }
function writeDB(data) {
    MEMORY_DB = data;
    scheduleSync();
    try { fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(data, null, 2)); } catch(e){}
}

// ==========================================
// HÀM TIỆN ÍCH & CẤU HÌNH
// ==========================================
const KEY_EXPIRE_MS = 24 * 60 * 60 * 1000;
const ADMIN_USERNAME = 'caoquangtuan';
const ADMIN_PASSWORD = 'CaoQuangTuan@026209000010';
const ADMIN_PIN = '997722';
const PAY2S_WEBHOOK_TOKEN = 'cc06a956bb11a0a175e6e1007218277bb3322903db0a1e05df';

function verifyAdmin(username, password) { return username === ADMIN_USERNAME && password === ADMIN_PASSWORD; }
function calcRemainingTime(createdAt, status) {
    if (status !== 'pending') return null;
    const diffMs = (new Date(createdAt).getTime() + KEY_EXPIRE_MS) - Date.now();
    if (diffMs <= 0) return { hours: 0, minutes: 0, isExpired: true };
    return { hours: Math.floor(diffMs / 3600000), minutes: Math.floor((diffMs % 3600000) / 60000), isExpired: false };
}
function cleanupExpiredKeys() {
    if (!MEMORY_DB) return;
    const now = Date.now();
    const before = MEMORY_DB.keys.length;
    MEMORY_DB.keys = MEMORY_DB.keys.filter(k => {
        if (k.status === 'confirmed') return true;
        if (k.status !== 'pending') return true;
        return (now - new Date(k.createdAt).getTime()) <= KEY_EXPIRE_MS;
    });
    if (before !== MEMORY_DB.keys.length) writeDB(MEMORY_DB);
}

// ==========================================
// API ROUTES
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', storage: USE_GIST ? 'github-gist' : 'local', users: readDB().users.length });
});

// --- AUTH (ĐĂNG KÝ / ĐĂNG NHẬP) ---
app.post('/api/register', (req, res) => {
    const { username, password, fullName } = req.body;
    if (!username || !password || !fullName) return res.status(400).json({ error: 'Thiếu thông tin' });
    const db = readDB();
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ error: 'Username đã tồn tại' });
    }
    db.users.push({ username, password, fullName, balance: 0, createdAt: new Date().toISOString() });
    writeDB(db);
    res.json({ success: true, user: { username, fullName, balance: 0 } });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
    if (user) res.json({ success: true, user: { username: user.username, fullName: user.fullName, balance: user.balance } });
    else res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
});

app.get('/api/user/:username', (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (user) res.json({ success: true, user: { username: user.username, balance: user.balance, fullName: user.fullName } });
    else res.status(404).json({ error: 'User not found' });
});

// --- KEY & PAYMENT ---
app.post('/api/create-key', (req, res) => {
    const { plan, customerName, transferContent, amount } = req.body;
    if (!plan || !customerName) return res.status(400).json({ error: 'Thiếu thông tin' });
    const db = readDB();
    const key = `TYON-${plan.toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    db.keys.push({ key, plan, customerName, transferContent: transferContent || '', amount: amount || 0, status: 'pending', createdAt: new Date().toISOString() });
    writeDB(db);
    res.json({ success: true, key });
});

app.post('/api/check-key', (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Thiếu từ khóa' });
    const db = readDB();
    const searchTerm = query.trim().toUpperCase();
    const matches = db.keys.filter(k => 
        (k.key && k.key.toUpperCase().includes(searchTerm)) || 
        (k.transferContent && k.transferContent.toUpperCase().includes(searchTerm)) ||
        (k.customerName && k.customerName.toUpperCase().includes(searchTerm))
    );
    res.json({ success: true, keys: matches });
});

// --- ADMIN ---
app.post('/api/admin/keys', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    cleanupExpiredKeys();
    res.json({ success: true, keys: readDB().keys });
});

app.post('/api/admin/confirm-key', (req, res) => {
    const { username, password, pin, key } = req.body;
    if (!verifyAdmin(username, password) || pin !== ADMIN_PIN) return res.status(401).json({ error: 'Sai tài khoản hoặc PIN' });
    const db = readDB();
    const idx = db.keys.findIndex(k => k.key === key);
    if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy key' });
    db.keys[idx].status = 'confirmed';
    const feedbackKey = `FB-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    db.feedbackKeys.push({ feedbackKey, originalKey: key, customerName: db.keys[idx].customerName, isUsed: false });
    writeDB(db);
    res.json({ success: true, feedbackKey });
});

// --- FEEDBACK ---
app.get('/api/feedbacks', (req, res) => {
    res.json({ success: true, feedbacks: readDB().feedbacks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.post('/api/submit-feedback', (req, res) => {
    const { feedbackKey, rating, content, images } = req.body;
    const db = readDB();
    const fbIdx = db.feedbackKeys.findIndex(f => f.feedbackKey === feedbackKey);
    if (fbIdx === -1 || db.feedbackKeys[fbIdx].isUsed) return res.status(400).json({ error: 'Key không hợp lệ hoặc đã dùng' });
    db.feedbackKeys[fbIdx].isUsed = true;
    db.feedbacks.push({ id: Date.now().toString(), customerName: db.feedbackKeys[fbIdx].customerName, rating, content, images: images || [], createdAt: new Date().toISOString() });
    writeDB(db);
    res.json({ success: true });
});

// --- MUA HÀNG ---
app.post('/api/buy-product', (req, res) => {
    const { username, productId, price, productName } = req.body;
    const db = readDB();
    const idx = db.users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy user' });
    if (db.users[idx].balance < price) return res.status(400).json({ error: 'Số dư không đủ' });
    db.users[idx].balance -= price;
    if(!db.users[idx].purchaseHistory) db.users[idx].purchaseHistory = [];
    db.users[idx].purchaseHistory.push({ productId, productName, price, date: new Date().toISOString() });
    writeDB(db);
    res.json({ success: true, newBalance: db.users[idx].balance });
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

// Khởi động
setInterval(cleanupExpiredKeys, 60 * 60 * 1000);
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ TYON Server running on port ${PORT}`);
});
