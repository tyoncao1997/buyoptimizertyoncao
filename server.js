const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// TỰ ĐỘNG TÌM VÀ CẤU HÌNH FILE DATABASE
// ==========================================
// Ưu tiên tìm file database.json trong thư mục dự án hiện tại
let DB_FILE = path.join(__dirname, 'database.json');

// Nếu không có ở thư mục dự án, kiểm tra xem có file cũ ở /var/data/ không
if (!fs.existsSync(DB_FILE) && fs.existsSync('/var/data/database.json')) {
    DB_FILE = '/var/data/database.json';
    console.log('📁 Tìm thấy database cũ tại /var/data/database.json');
} else {
    console.log('📁 Sử dụng database tại thư mục dự án:', DB_FILE);
}

// Khởi tạo file database nếu chưa có (đảm bảo đủ 4 mảng)
if (!fs.existsSync(DB_FILE)) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify({ 
            keys: [], 
            confirmedKeys: [], 
            feedbackKeys: [], 
            feedbacks: [] 
        }, null, 2));
        console.log('✅ Đã tạo database.json mới');
    } catch (err) {
        console.error('❌ Lỗi tạo file database:', err);
    }
}

// ============ CẤU HÌNH CHUNG ============
const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const ADMIN_USERNAME = 'caoquangtuan';
const ADMIN_PASSWORD = 'CaoQuangTuan@026209000010';
const ADMIN_PIN = '997722';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Cho phép nhận ảnh Base64
app.use(express.static(__dirname));

// ============ ĐỌC / GHI DATABASE AN TOÀN ============
function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        // Tự động bổ sung mảng nếu file cũ bị thiếu (Giữ nguyên data cũ)
        if (!parsed.keys) parsed.keys = [];
        if (!parsed.confirmedKeys) parsed.confirmedKeys = [];
        if (!parsed.feedbackKeys) parsed.feedbackKeys = []; 
        if (!parsed.feedbacks) parsed.feedbacks = [];
        
        return parsed;
    } catch (err) {
        console.error('❌ Lỗi đọc DB:', err.message);
        return { keys: [], confirmedKeys: [], feedbackKeys: [], feedbacks: [] };
    }
}

function writeDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('❌ Lỗi ghi DB:', err.message);
    }
}

// ============ HÀM DỌN DẸP KEY HẾT HẠN ============
function cleanupExpiredKeys() {
    const db = readDB();
    const now = Date.now();

    const deletedKeys = [];
    const remainingKeys = [];

    db.keys.forEach(k => {
        if (k.status === 'pending') {
            const createdAt = new Date(k.createdAt).getTime();
            const age = now - createdAt;

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
        console.log(`\n🧹 [${new Date().toLocaleString('vi-VN')}] Đã xóa ${deletedKeys.length} key hết hạn.`);
    }

    return { deletedCount: deletedKeys.length };
}

// ============ CRON JOB DỌN DẸP TỰ ĐỘNG ============
setTimeout(() => {
    console.log('🚀 Kiểm tra key hết hạn lần đầu...');
    cleanupExpiredKeys();
}, 5000);

setInterval(() => {
    cleanupExpiredKeys();
}, CLEANUP_INTERVAL_MS);

// ============ CÁC HÀM HỖ TRỢ ============
function calcRemainingTime(createdAt, status) {
    if (status !== 'pending') return null;
    const created = new Date(createdAt).getTime();
    const expiresAt = created + KEY_EXPIRE_MS;
    const diffMs = expiresAt - Date.now();

    if (diffMs <= 0) return { hours: 0, minutes: 0, totalHours: 0, isExpired: true };
    return {
        hours: Math.floor(diffMs / (60 * 60 * 1000)),
        minutes: Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000)),
        totalHours: diffMs / (60 * 60 * 1000),
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

    db.keys.push({
        key, plan, customerName, transferContent: transferContent || '',
        amount: amount || 0, status: 'pending', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + KEY_EXPIRE_MS).toISOString()
    });
    writeDB(db);

    res.json({ success: true, key, expiresAt: new Date(Date.now() + KEY_EXPIRE_MS).toISOString() });
});

// 2. Admin lấy danh sách key
app.post('/api/admin/keys', (req, res) => {
    const { username, password } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });

    cleanupExpiredKeys();
    const db = readDB();

    const keys = db.keys.map(k => {
        // Đính kèm thời gian còn lại cho key pending
        if (k.status === 'pending') {
            const rem = calcRemainingTime(k.createdAt, k.status);
            return { ...k, remainingHours: rem.hours, remainingMinutes: rem.minutes };
        }
        // Đính kèm Feedback Key cho key đã xác nhận
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

// 3. Admin xác nhận key (TRẢ VỀ FEEDBACK KEY)
app.post('/api/admin/confirm-key', (req, res) => {
    const { username, password, pin, key } = req.body;
    if (!verifyAdmin(username, password)) return res.status(401).json({ error: 'Sai tài khoản' });
    if (pin !== ADMIN_PIN) return res.status(403).json({ error: 'Sai mã PIN' });

    cleanupExpiredKeys();
    const db = readDB();
    const keyIndex = db.keys.findIndex(k => k.key === key);

    if (keyIndex === -1) return res.status(404).json({ error: 'Không tìm thấy key.' });
    if (db.keys[keyIndex].status === 'confirmed') return res.status(400).json({ error: 'Key đã xác nhận.' });

    // Cập nhật trạng thái Key
    db.keys[keyIndex].status = 'confirmed';
    db.keys[keyIndex].confirmedAt = new Date().toISOString();
    db.keys[keyIndex].confirmedBy = username;

    // Tạo Feedback Key mới
    const randomFB = Math.random().toString(36).substring(2, 8).toUpperCase();
    const feedbackKey = `FB-${randomFB}`;
    
    db.feedbackKeys.push({
        feedbackKey: feedbackKey,
        originalKey: key,
        customerName: db.keys[keyIndex].customerName,
        isUsed: false,
        createdAt: new Date().toISOString()
    });
    
    writeDB(db);

    // TRẢ VỀ CHO FRONTEND
    res.json({
        success: true,
        message: 'Xác nhận Key thành công',
        feedbackKey: feedbackKey, 
        keyData: db.keys[keyIndex]
    });
});

// 4. Check key chính xác (Public)
app.post('/api/check-key', (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Thiếu key' });

    const db = readDB();
    const keyData = db.keys.find(k => k.key.toUpperCase() === key.trim().toUpperCase());
    if (!keyData) return res.status(404).json({ error: 'Key không tồn tại.' });

    res.json({ success: true, keyData });
});

// 5. Tìm kiếm Key nâng cao (Public)
app.post('/api/search-keys', (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Nhập từ khóa' });

    const searchTerm = query.trim().toUpperCase();
    const db = readDB();
    
    const matches = db.keys.filter(k => 
        (k.key && k.key.toUpperCase().includes(searchTerm)) ||
        (k.transferContent && k.transferContent.toUpperCase().includes(searchTerm)) ||
        (k.customerName && k.customerName.toUpperCase().includes(searchTerm))
    );
    
    res.json({ success: true, results: matches });
});

// 6. Lấy danh sách Key đã xác nhận (Public)
app.get('/api/confirmed-keys', (req, res) => {
    const db = readDB();
    res.json({ keys: db.keys.filter(k => k.status === 'confirmed') });
});

// 7. Admin dọn dẹp thủ công
app.post('/api/admin/cleanup-now', (req, res) => {
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

    // Đánh dấu đã dùng
    db.feedbackKeys[fbIdx].isUsed = true;
    db.feedbackKeys[fbIdx].usedAt = new Date().toISOString();

    // Lưu bài đánh giá
    db.feedbacks.push({
        id: Date.now().toString(), 
        customerName: db.feedbackKeys[fbIdx].customerName,
        feedbackKey, 
        rating: Number(rating), 
        content, 
        images: images || [], 
        createdAt: new Date().toISOString()
    });
    
    writeDB(db);
    res.json({ success: true, message: 'Gửi đánh giá thành công!' });
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
        totalKeys: db.keys.length, 
        totalFeedbackKeys: db.feedbackKeys.length, 
        totalFeedbacks: db.feedbacks.length 
    });
});

// 404 Handler
app.use((req, res) => res.status(404).json({ error: 'API không tồn tại: ' + req.path }));

// Khởi động Server
app.listen(PORT, () => {
    console.log(`\n✅ TYON OPTIMIZER SERVER ĐANG CHẠY`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`📁 Database: ${DB_FILE}`);
});

// Graceful Shutdown
process.on('SIGINT', () => { process.exit(0); });
process.on('uncaughtException', (err) => console.error('❌ Lỗi:', err));
process.on('unhandledRejection', (err) => console.error('❌ Lỗi:', err));
