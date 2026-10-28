const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CẤU HÌNH DATABASE — TỰ ĐỘNG + AN TOÀN
// ==========================================
// Ưu tiên: ENV > /var/data (nếu ghi được) > thư mục dự án
function resolveDbFile() {
    // 1. Nếu có ENV chỉ định
    if (process.env.DB_FILE) {
        return process.env.DB_FILE;
    }

    // 2. Thử /var/data (Render persistent disk)
    const varDataPath = '/var/data/database.json';
    try {
        if (!fs.existsSync('/var/data')) {
            fs.mkdirSync('/var/data', { recursive: true });
        }
        // Test quyền ghi
        fs.accessSync('/var/data', fs.constants.W_OK);
        return varDataPath;
    } catch (e) {
        // Không có quyền → fallback
    }

    // 3. Fallback: thư mục dự án (luôn ghi được)
    return path.join(__dirname, 'database.json');
}

const DB_FILE = resolveDbFile();
const DB_DIR = path.dirname(DB_FILE);
const DB_BACKUP_DIR = path.join(DB_DIR, 'backups');

console.log(`📁 Database: ${DB_FILE}`);

// Đảm bảo thư mục tồn tại
try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    if (!fs.existsSync(DB_BACKUP_DIR)) fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });
} catch (err) {
    console.error('❌ Không tạo được thư mục DB:', err.message);
}

// Khởi tạo DB nếu chưa có
const DEFAULT_DB = { keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [] };

if (!fs.existsSync(DB_FILE)) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
        console.log('✅ Đã tạo database.json mới');
    } catch (err) {
        console.error('❌ Lỗi tạo file database:', err.message);
    }
}

// ==========================================
// ĐỌC / GHI DATABASE — ATOMIC + BACKUP
// ==========================================
function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        if (!data.trim()) return { ...DEFAULT_DB };

        const parsed = JSON.parse(data);
        if (!parsed.keys) parsed.keys = [];
        if (!parsed.confirmedKeys) parsed.confirmedKeys = [];
        if (!parsed.feedbackKeys) parsed.feedbackKeys = [];
        if (!parsed.feedbacks) parsed.feedbacks = [];
        return parsed;
    } catch (err) {
        console.error('❌ Lỗi đọc DB:', err.message);
        // Thử khôi phục từ backup gần nhất
        try {
            const backups = fs.readdirSync(DB_BACKUP_DIR)
                .filter(f => f.startsWith('database-') && f.endsWith('.json'))
                .sort()
                .reverse();

            if (backups.length > 0) {
                const latest = path.join(DB_BACKUP_DIR, backups[0]);
                console.log(`♻️  Khôi phục từ backup: ${latest}`);
                const parsed = JSON.parse(fs.readFileSync(latest, 'utf8'));
                if (!parsed.keys) parsed.keys = [];
                if (!parsed.confirmedKeys) parsed.confirmedKeys = [];
                if (!parsed.feedbackKeys) parsed.feedbackKeys = [];
                if (!parsed.feedbacks) parsed.feedbacks = [];
                return parsed;
            }
        } catch (e) {
            console.error('❌ Không khôi phục được backup:', e.message);
        }
        return { ...DEFAULT_DB };
    }
}

// Ghi atomic: ghi file tạm rồi rename → tránh corrupt khi crash
function writeDB(data) {
    try {
        const tmpFile = DB_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
        fs.renameSync(tmpFile, DB_FILE);
    } catch (err) {
        console.error('❌ Lỗi ghi DB:', err.message);
        // Fallback: ghi trực tiếp
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('❌ Fallback ghi DB cũng lỗi:', e.message);
        }
    }
}

// Backup định kỳ (giữ 7 bản gần nhất)
function backupDB() {
    try {
        if (!fs.existsSync(DB_FILE)) return;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(DB_BACKUP_DIR, `database-${ts}.json`);
        fs.copyFileSync(DB_FILE, backupFile);

        // Dọn backup cũ, giữ 7 bản mới nhất
        const backups = fs.readdirSync(DB_BACKUP_DIR)
            .filter(f => f.startsWith('database-') && f.endsWith('.json'))
            .sort()
            .reverse();

        backups.slice(7).forEach(f => {
            try { fs.unlinkSync(path.join(DB_BACKUP_DIR, f)); } catch (_) {}
        });
    } catch (err) {
        console.error('⚠️  Lỗi backup DB:', err.message);
    }
}

// ============ CẤU HÌNH ============
const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h backup/lần

const ADMIN_USERNAME = 'caoquangtuan';
const ADMIN_PASSWORD = 'CaoQuangTuan@026209000010';
const ADMIN_PIN = '997722';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ============ DỌN KEY HẾT HẠN ============
function cleanupExpiredKeys() {
    const db = readDB();
    const now = Date.now();
    const deletedKeys = [];
    const remainingKeys = [];

    db.keys.forEach(k => {
        if (k.status === 'pending') {
            const age = now - new Date(k.createdAt).getTime();
            if (age > KEY_EXPIRE_MS) {
                deletedKeys.push({ key: k.key, customerName: k.customerName });
            } else {
                remainingKeys.push(k);
            }
        } else {
            remainingKeys.push(k);
        }
    });

    if (deletedKeys.length > 0) {
        db.keys = remainingKeys;
        writeDB(db);
        console.log(`\n🧹 Đã xóa ${deletedKeys.length} key hết hạn.`);
    }
    return { deletedCount: deletedKeys.length };
}

// ============ HELPER ============
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
// API ENDPOINTS
// ==========================================

// 1. Tạo key mới
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
        success: true,
        key,
        expiresAt: newKey.expiresAt,
        message: `Key đã được tạo. Vui lòng thanh toán và xác nhận trong ${KEY_EXPIRE_HOURS}h.`
    });
});

// 2. Admin lấy danh sách key
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

// 3. Admin xác nhận key → tạo Feedback Key
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

// 4. Check key chính xác (Public)
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

// 5. Tìm kiếm Key nâng cao
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
                key: k.key,
                plan: k.plan,
                status: k.status,
                customerName: k.customerName,
                transferContent: k.transferContent,
                amount: k.amount,
                createdAt: k.createdAt,
                confirmedAt: k.confirmedAt,
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
            success: true,
            results: formattedResults,
            count: formattedResults.length,
            totalMatches: formattedResults.length
        });
    } catch (err) {
        console.error('❌ Search error:', err);
        res.status(500).json({ error: 'Lỗi server khi tìm kiếm' });
    }
});

// 6. Danh sách Key đã xác nhận (Public)
app.get('/api/confirmed-keys', (req, res) => {
    cleanupExpiredKeys();
    const db = readDB();
    res.json({ keys: db.keys.filter(k => k.status === 'confirmed') });
});

// 7. Admin dọn dẹp thủ công
app.post('/api/admin/cleanup-now', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });

    const result = cleanupExpiredKeys();
    res.json({ success: true, message: `Đã xóa ${result.deletedCount} key hết hạn.` });
});

// ==========================================
// API FEEDBACK
// ==========================================

// 8. Public: Lấy danh sách đánh giá
app.get('/api/feedbacks', (req, res) => {
    const db = readDB();
    res.json({ feedbacks: [...db.feedbacks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

// 9. User: Gửi đánh giá mới
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

// 10. Admin: Lấy danh sách đánh giá
app.post('/api/admin/feedbacks', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });

    const db = readDB();
    res.json({ feedbacks: [...db.feedbacks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

// ==========================================
// HEALTH CHECK & KHỞI ĐỘNG
// ==========================================
app.get('/api/health', (req, res) => {
    const db = readDB();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        dbFile: DB_FILE,
        totalKeys: db.keys.length,
        pendingKeys: db.keys.filter(k => k.status === 'pending').length,
        confirmedKeys: db.keys.filter(k => k.status === 'confirmed').length,
        totalFeedbackKeys: db.feedbackKeys.length,
        totalFeedbacks: db.feedbacks.length,
        timestamp: new Date().toISOString()
    });
});

app.use((req, res) => res.status(404).json({ error: 'API không tồn tại: ' + req.path }));

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
});

// ==========================================
// TIMERS — cleanup + backup
// ==========================================
setTimeout(() => { cleanupExpiredKeys(); }, 5000);
setInterval(() => { cleanupExpiredKeys(); }, CLEANUP_INTERVAL_MS);

// Backup ngay khi khởi động + định kỳ
setTimeout(() => { backupDB(); }, 10000);
setInterval(() => { backupDB(); }, BACKUP_INTERVAL_MS);

// ==========================================
// KHỞI ĐỘNG SERVER
// ==========================================
const server = app.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════════╗`);
    console.log(`║  ✅ TYON OPTIMIZER SERVER ĐANG CHẠY         ║`);
    console.log(`╚════════════════════════════════════════════╝`);
    console.log(`🌐 URL:        http://localhost:${PORT}`);
    console.log(`📁 Database:   ${DB_FILE}`);
    console.log(`💾 Backup dir: ${DB_BACKUP_DIR}`);
    console.log(`⏰ Key expire: ${KEY_EXPIRE_HOURS} giờ`);
    console.log(`🔄 Cleanup:    mỗi ${CLEANUP_INTERVAL_MS / 60000} phút`);
    console.log(`🗄️  Backup:     mỗi ${BACKUP_INTERVAL_MS / 3600000} giờ\n`);
});

// ==========================================
// GRACEFUL SHUTDOWN — FLUSH DATA TRƯỚC KHI TẮT
// ==========================================
let isShuttingDown = false;
function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n👋 Nhận ${signal} — đang tắt server an toàn...`);

    // Flush lần cuối
    try { backupDB(); } catch (_) {}

    server.close(() => {
        console.log('✅ Server đã đóng. Tạm biệt!');
        process.exit(0);
    });

    // Force exit sau 10s nếu không đóng được
    setTimeout(() => {
        console.error('⚠️  Force exit sau timeout.');
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// QUAN TRỌNG: uncaughtException phải EXIT để tránh zombie process
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    // Flush data trước khi chết
    try { backupDB(); } catch (_) {}
    // Thoát để process manager (PM2/Render) restart sạch
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
    // Không exit — chỉ log, vì rejection thường không nghiêm trọng bằng uncaught
});
