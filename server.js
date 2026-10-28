const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CẤU HÌNH LƯU TRỮ — CHỐNG MẤT DATA TUYỆT ĐỐI
// ==========================================
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GIST_ID = (process.env.GIST_ID || '').trim();
const GIST_FILENAME = 'database.json';
const USE_GIST = !!(GITHUB_TOKEN && GIST_ID);

const LOCAL_DB_FILE = path.join(__dirname, 'database.json');
const LOCAL_BACKUP_DIR = path.join(__dirname, 'backups');

console.log(USE_GIST
    ? `☁️  Lưu trữ: GitHub Gist (${GIST_ID}) — CHỐNG MẤT DATA TUYỆT ĐỐI`
    : `⚠️  Lưu trữ: FILE LOCAL — SẼ MẤT KHI RENDER RESTART!`
);

try {
    if (!fs.existsSync(LOCAL_BACKUP_DIR)) fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
} catch (err) {
    console.error('❌ Không tạo được thư mục backup:', err.message);
}

// Thêm mảng users và products vào DB mặc định
const DEFAULT_DB = { 
    keys: [], 
    confirmedKeys: [], 
    feedbackKeys: [], 
    feedbacks: [], 
    users: [],
    // Bạn có thể lưu danh sách sản phẩm ở đây nếu muốn quản lý qua server
    // Hiện tại sản phẩm đang được hardcode ở Frontend, server chỉ cần biết giá để trừ tiền
};

let MEMORY_DB = null;
let isDirty = false;
let isSyncing = false;
let lastSyncTime = 0;

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
// ĐỒNG BỘ — DEBOUNCE + RETRY
// ==========================================
let syncTimer = null;
const SYNC_DEBOUNCE_MS = 2000;

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
            saveLocal(MEMORY_DB);
        } else {
            console.warn('⚠️  Sync Gist thất bại, sẽ retry sau 30s');
            setTimeout(() => flushToGist(true), 30000);
        }
    } finally {
        isSyncing = false;
    }
}

// ==========================================
// LOCAL CACHE
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
// READ / WRITE API
// ==========================================
function readDB() {
    if (!MEMORY_DB) {
        return { ...DEFAULT_DB, keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [], users: [] };
    }
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
// KHỞI TẠO DB
// ==========================================
async function initDB() {
    console.log('🔄 Đang tải database...');
    if (USE_GIST) {
        const remote = await loadFromGist();
        if (remote) {
            MEMORY_DB = remote;
            console.log(`✅ Đã tải từ Gist: ${remote.keys.length} keys, ${remote.feedbacks.length} feedbacks, ${remote.users.length} users`);
            saveLocal(remote);
            return;
        }
        console.warn('⚠️  Không tải được Gist, thử local cache...');
    }

    const local = loadLocal();
    if (local) {
        MEMORY_DB = local;
        console.log(`✅ Đã tải từ local cache: ${local.keys.length} keys, ${local.users.length} users`);
        if (USE_GIST) {
            console.log('📤 Đang push local cache lên Gist...');
            await saveToGist(local);
        }
        return;
    }

    MEMORY_DB = { ...DEFAULT_DB, keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [], users: [] };
    console.log('📁 Khởi tạo DB mới (empty)');
    if (USE_GIST) await saveToGist(MEMORY_DB);
    saveLocal(MEMORY_DB);
}

// ==========================================
// CẤU HÌNH
// ==========================================
const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const ADMIN_USERNAME = 'caoquangtuan';
const ADMIN_PASSWORD = 'CaoQuangTuan@026209000010';
const ADMIN_PIN = '997722';

// Pay2S Webhook Token của bạn
const PAY2S_WEBHOOK_TOKEN = 'cc06a956bb11a0a175e6e1007218277bb3322903db0a1e05df';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ==========================================
// DỌN KEY HẾT HẠN
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
            console.log(`   🗑️  Xóa key hết hạn: ${k.key} | ${k.customerName}`);
            return false;
        }
        return true;
    });

    const deletedCount = before - MEMORY_DB.keys.length;
    if (deletedCount > 0) {
        writeDB(MEMORY_DB);
        console.log(`🧹 Đã xóa ${deletedCount} key pending hết hạn.`);
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
// API ENDPOINTS (Keys & Feedback)
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
        transferContent: transferContent || '',
        amount: amount || 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + KEY_EXPIRE_MS).toISOString()
    };

    db.keys.push(newKey);
    writeDB(db);

    res.json({
        success: true, key,
        expiresAt: newKey.expiresAt,
        message: `Key đã được tạo. Vui lòng thanh toán và xác nhận trong ${KEY_EXPIRE_HOURS}h.`
    });
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

    res.json({ keys });
});

app.post('/api/admin/confirm-key', (req, res) => {
    const { username, password, pin, key } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    if (pin !== ADMIN_PIN) return res.status(403).json({ error: 'Sai mã PIN' });

    cleanupExpiredKeys();
    const db = readDB();
    const keyIndex = db.keys.findIndex(k => k.key === key);

    if (keyIndex === -1) return res.status(404).json({ error: 'Không tìm thấy key.' });
    if (db.keys[keyIndex].status === 'confirmed') return res.status(400).json({ error: 'Key đã xác nhận.' });

    db.keys[keyIndex].status = 'confirmed';
    db.keys[keyIndex].confirmedAt = new Date().toISOString();
    db.keys[keyIndex].confirmedBy = username;

    const randomFB = Math.random().toString(36).substring(2, 8).toUpperCase();
    const feedbackKey = `FB-${randomFB}`;

    db.feedbackKeys.push({
        feedbackKey,
        originalKey: key,
        customerName: db.keys[keyIndex].customerName,
        isUsed: false,
        createdAt: new Date().toISOString()
    });

    writeDB(db);

    res.json({
        success: true,
        message: 'Xác nhận Key thành công',
        feedbackKey,
        keyData: db.keys[keyIndex]
    });
});

app.post('/api/check-key', (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Thiếu key' });

    cleanupExpiredKeys();
    const db = readDB();
    const keyData = db.keys.find(k => k.key.toUpperCase() === key.trim().toUpperCase());
    if (!keyData) return res.status(404).json({ error: 'Key không tồn tại.' });

    const rem = calcRemainingTime(keyData.createdAt, keyData.status);

    res.json({
        success: true,
        keyData: {
            ...keyData,
            remainingTime: rem && !rem.isExpired ? { hours: rem.hours, minutes: rem.minutes } : null
        }
    });
});

app.post('/api/search-keys', (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Nhập từ khóa' });

        const searchTerm = query.trim().toUpperCase();
        cleanupExpiredKeys();
        const db = readDB();

        const matches = db.keys.filter(k =>
            (k.key && k.key.toUpperCase().includes(searchTerm)) ||
            (k.transferContent && k.transferContent.toUpperCase().includes(searchTerm)) ||
            (k.customerName && k.customerName.toUpperCase().includes(searchTerm))
        );

        const formattedResults = matches.map(k => {
            const rem = calcRemainingTime(k.createdAt, k.status);
            return {
                key: k.key, plan: k.plan, status: k.status,
                customerName: k.customerName,
                transferContent: k.transferContent,
                amount: k.amount,
                createdAt: k.createdAt, confirmedAt: k.confirmedAt,
                remainingTime: rem && !rem.isExpired ? rem : null,
                isExpired: rem ? rem.isExpired : false,
                _matchType: {
                    key: !!(k.key && k.key.toUpperCase().includes(searchTerm)),
                    content: !!(k.transferContent && k.transferContent.toUpperCase().includes(searchTerm)),
                    name: !!(k.customerName && k.customerName.toUpperCase().includes(searchTerm))
                }
            };
        });

        res.json({
            success: true, results: formattedResults,
            count: formattedResults.length,
            totalMatches: formattedResults.length
        });
    } catch (err) {
        console.error('❌ Search error:', err);
        res.status(500).json({ error: 'Lỗi server khi tìm kiếm' });
    }
});

app.get('/api/confirmed-keys', (req, res) => {
    cleanupExpiredKeys();
    const db = readDB();
    res.json({ keys: db.keys.filter(k => k.status === 'confirmed') });
});

app.post('/api/admin/cleanup-now', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });

    const result = cleanupExpiredKeys();
    res.json({
        success: true,
        message: `Đã xóa ${result.deletedCount} key pending hết hạn.`
    });
});

// ==========================================
// API FEEDBACK
// ==========================================
app.get('/api/feedbacks', (req, res) => {
    const db = readDB();
    res.json({ feedbacks: [...db.feedbacks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.post('/api/submit-feedback', (req, res) => {
    const { feedbackKey, rating, content, images } = req.body;
    if (!feedbackKey) return res.status(400).json({ error: 'Thiếu Feedback Key' });

    const db = readDB();
    const fbIdx = db.feedbackKeys.findIndex(fk => fk.feedbackKey === feedbackKey);

    if (fbIdx === -1) return res.status(400).json({ error: 'Feedback Key không hợp lệ.' });
    if (db.feedbackKeys[fbIdx].isUsed) return res.status(400).json({ error: 'Feedback Key đã sử dụng.' });

    db.feedbackKeys[fbIdx].isUsed = true;
    db.feedbackKeys[fbIdx].usedAt = new Date().toISOString();

    const newFeedback = {
        id: Date.now().toString(),
        customerName: db.feedbackKeys[fbIdx].customerName,
        feedbackKey,
        rating: Number(rating),
        content,
        images: images || [],
        createdAt: new Date().toISOString()
    };

    db.feedbacks.push(newFeedback);
    writeDB(db);
    res.json({ success: true, message: 'Gửi đánh giá thành công!', feedback: newFeedback });
});

app.post('/api/admin/feedbacks', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });

    const db = readDB();
    res.json({ feedbacks: [...db.feedbacks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

// ==========================================
// API USERS & PAY2S WEBHOOK
// ==========================================

// API lấy thông tin user (để frontend hiển thị số dư)
app.get('/api/user/:username', (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (user) {
        res.json({ success: true, user: { username: user.username, balance: user.balance, fullName: user.fullName } });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// API Đăng ký user
app.post('/api/register', (req, res) => {
    const { username, password, fullName } = req.body;
    if (!username || !password || !fullName) return res.status(400).json({ error: 'Thiếu thông tin' });

    const db = readDB();
    const existing = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) return res.status(400).json({ error: 'Username đã tồn tại' });

    const newUser = {
        username: username,
        password: password, // Lưu ý: Trong thực tế nên hash password
        fullName: fullName,
        balance: 0,
        createdAt: new Date().toISOString()
    };
    db.users.push(newUser);
    writeDB(db);
    res.json({ success: true, message: 'Đăng ký thành công', user: { username, fullName, balance: 0 } });
});

// API Đăng nhập user
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

// API nhận Webhook từ Pay2S (Tự động cộng tiền)
app.post('/api/pay2s-webhook', (req, res) => {
    try {
        // 1. Xác thực Token
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${PAY2S_WEBHOOK_TOKEN}`) {
            console.error('❌ Webhook Token không hợp lệ!');
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const data = req.body;
        console.log('📥 Nhận Webhook Pay2S:', data);

        // 2. Chỉ xử lý tiền vào
        if (data.transferType === 'IN') {
            const amount = parseInt(data.transferAmount);
            const content = (data.content || '').toUpperCase();

            // 3. Tìm username trong nội dung chuyển khoản
            // Quy ước: NAP_USERNAME (ví dụ: NAP_NGUYENVANA)
            const match = content.match(/NAP[_\s]?([A-Z0-9]+)/);

            if (match && match[1]) {
                const username = match[1].toLowerCase();
                const db = readDB();
                
                if (!db.users) db.users = [];
                
                const userIndex = db.users.findIndex(u => u.username.toLowerCase() === username);

                if (userIndex !== -1) {
                    db.users[userIndex].balance += amount;
                    writeDB(db);
                    console.log(`✅ Đã cộng ${amount}đ cho user: ${username}. Số dư mới: ${db.users[userIndex].balance}`);
                } else {
                    console.log(`⚠️ Không tìm thấy user: ${username} để cộng tiền.`);
                }
            } else {
                console.log('⚠️ Nội dung chuyển khoản không chứa username hợp lệ:', content);
            }
        }

        // 4. Phản hồi cho Pay2S
        return res.status(200).json({ success: true, message: 'Webhook received' });

    } catch (error) {
        console.error('❌ Lỗi xử lý Webhook:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ==========================================
// API MỚI: XỬ LÝ MUA HÀNG (TRỪ TIỀN VÍ)
// ==========================================
app.post('/api/buy-product', (req, res) => {
    try {
        const { username, productId, price, productName } = req.body;

        if (!username || !productId || price === undefined) {
            return res.status(400).json({ error: 'Thiếu thông tin giao dịch' });
        }

        const db = readDB();
        const userIndex = db.users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());

        if (userIndex === -1) {
            return res.status(404).json({ error: 'Không tìm thấy người dùng' });
        }

        const user = db.users[userIndex];

        // Kiểm tra số dư
        if (user.balance < price) {
            return res.status(400).json({ error: 'Số dư ví không đủ. Vui lòng nạp thêm tiền.' });
        }

        // Trừ tiền
        user.balance -= price;
        
        // Lưu lịch sử mua hàng (tùy chọn)
        if (!user.purchaseHistory) user.purchaseHistory = [];
        user.purchaseHistory.push({
            productId,
            productName,
            price,
            purchasedAt: new Date().toISOString()
        });

        writeDB(db);

        console.log(`✅ User ${username} đã mua ${productName} (${price}đ). Số dư còn: ${user.balance}đ`);

        res.json({ 
            success: true, 
            message: 'Thanh toán thành công', 
            newBalance: user.balance 
        });

    } catch (error) {
        console.error('❌ Lỗi mua hàng:', error);
        res.status(500).json({ error: 'Lỗi server khi xử lý giao dịch' });
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    const db = MEMORY_DB || { keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [], users: [] };
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        storage: USE_GIST ? 'github-gist' : 'local-file',
        isDirty,
        lastSyncTime: lastSyncTime ? new Date(lastSyncTime).toISOString() : null,
        totalKeys: db.keys.length,
        pendingKeys: db.keys.filter(k => k.status === 'pending').length,
        confirmedKeys: db.keys.filter(k => k.status === 'confirmed').length,
        totalFeedbackKeys: db.feedbackKeys.length,
        totalFeedbacks: db.feedbacks.length,
        totalUsers: db.users.length,
        timestamp: new Date().toISOString()
    });
});

app.use((req, res) => res.status(404).json({ error: 'API không tồn tại: ' + req.path }));

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
});

// ==========================================
// TIMERS
// ==========================================
setInterval(() => { cleanupExpiredKeys(); }, CLEANUP_INTERVAL_MS);

setInterval(() => {
    if (isDirty) {
        console.log('⏰ Force sync (60s) — isDirty=true');
        flushToGist(true);
    }
}, 60000);

// ==========================================
// KHỞI ĐỘNG
// ==========================================
async function startServer() {
    await initDB();

    const server = app.listen(PORT, () => {
        console.log(`\n╔════════════════════════════════════════════╗`);
        console.log(`║  ✅ TYON OPTIMIZER SERVER ĐANG CHẠY         ║`);
        console.log(`╚════════════════════════════════════════════╝`);
        console.log(`🌐 URL:        http://localhost:${PORT}`);
        console.log(`☁️  Storage:    ${USE_GIST ? 'GitHub Gist' : 'LOCAL FILE (⚠️ RỦI RO)'}`);
        console.log(`⏰ Key expire: ${KEY_EXPIRE_HOURS} giờ (chỉ pending)`);
        console.log(`🔄 Cleanup:    mỗi ${CLEANUP_INTERVAL_MS / 60000} phút`);
        console.log(`💰 Pay2S Webhook: ${PAY2S_WEBHOOK_TOKEN ? 'Đã cấu hình' : 'Chưa cấu hình'}\n`);
    });

    let isShuttingDown = false;
    async function gracefulShutdown(signal) {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log(`\n👋 Nhận ${signal} — đang tắt server an toàn...`);
        try {
            if (isDirty) {
                console.log('💾 Đang flush data cuối cùng lên Gist...');
                await flushToGist(true);
            }
        } catch (e) {
            console.error('❌ Flush cuối thất bại:', e.message);
        }
        server.close(() => {
            console.log('✅ Server đã đóng. Tạm biệt!');
            process.exit(0);
        });
        setTimeout(() => {
            console.error('⚠️  Force exit sau timeout.');
            process.exit(1);
        }, 10000).unref();
    }

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    process.on('uncaughtException', (err) => {
        console.error('❌ Uncaught Exception:', err);
        if (isDirty && USE_GIST) {
            try { flushToGist(true); } catch (_) {}
        }
        setTimeout(() => process.exit(1), 2000);
    });

    process.on('unhandledRejection', (err) => {
        console.error('❌ Unhandled Rejection:', err);
    });
}

startServer();
