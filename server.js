const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_FILE = '/var/data/database.json';

// ============ CẤU HÌNH THỜI GIAN XÓA KEY ============
const KEY_EXPIRE_HOURS = 24;
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// ============ ADMIN CREDENTIALS ============
const ADMIN_USERNAME = 'caoquangtuan';
const ADMIN_PASSWORD = 'CaoQuangTuan@026209000010';
const ADMIN_PIN = '997722';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Tăng giới hạn payload để nhận ảnh Base64
app.use(express.static(__dirname));

// Khởi tạo database nếu chưa có (thêm mảng feedbacks)
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ keys: [], confirmedKeys: [], feedbacks: [] }, null, 2));
    console.log('📁 Đã tạo database.json mới');
}

// ============ ĐỌC / GHI DATABASE ============
function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(data);
        // Đảm bảo cấu trúc hợp lệ
        if (!parsed.keys) parsed.keys = [];
        if (!parsed.confirmedKeys) parsed.confirmedKeys = [];
        if (!parsed.feedbacks) parsed.feedbacks = []; // Khởi tạo mảng feedbacks nếu chưa có
        return parsed;
    } catch (err) {
        console.error('❌ Lỗi đọc DB:', err.message);
        return { keys: [], confirmedKeys: [], feedbacks: [] };
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
                deletedKeys.push({
                    key: k.key,
                    customerName: k.customerName,
                    plan: k.plan,
                    createdAt: k.createdAt,
                    ageHours: Math.floor(age / (60 * 60 * 1000))
                });
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

        console.log(`\n🧹 [${new Date().toLocaleString('vi-VN')}] Đã xóa ${deletedKeys.length} key hết hạn:`);
        deletedKeys.forEach(k => {
            console.log(`   └─ ${k.key} | ${k.customerName} | ${k.plan} | Tạo cách đây ${k.ageHours}h`);
        });
    }

    return { deletedCount: deletedKeys.length, deletedKeys };
}

// ============ CRON JOB ============
setTimeout(() => {
    console.log('🚀 Kiểm tra key hết hạn lần đầu...');
    cleanupExpiredKeys();
}, 5000);

setInterval(() => {
    const result = cleanupExpiredKeys();
    if (result.deletedCount === 0) {
        console.log(`✅ [${new Date().toLocaleString('vi-VN')}] Không có key nào hết hạn.`);
    }
}, CLEANUP_INTERVAL_MS);

// ============ HELPER: TÍNH THỜI GIAN CÒN LẠI ============
function calcRemainingTime(createdAt, status) {
    if (status !== 'pending') return null;

    const created = new Date(createdAt).getTime();
    const expiresAt = created + KEY_EXPIRE_MS;
    const diffMs = expiresAt - Date.now();

    if (diffMs <= 0) {
        return {
            hours: 0,
            minutes: 0,
            totalHours: 0,
            isExpired: true
        };
    }

    return {
        hours: Math.floor(diffMs / (60 * 60 * 1000)),
        minutes: Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000)),
        totalHours: diffMs / (60 * 60 * 1000),
        isExpired: false
    };
}

// ============ HELPER: XÁC THỰC ADMIN ============
function verifyAdmin(username, password) {
    return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

// ============ API ENDPOINTS ============

// 1. Tạo key mới
app.post('/api/create-key', (req, res) => {
    const { plan, customerName, transferContent, amount } = req.body;

    if (!plan || !customerName) {
        return res.status(400).json({ error: 'Thiếu thông tin (plan, customerName)' });
    }

    cleanupExpiredKeys();

    const db = readDB();

    const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase();
    const key = `TYON-${plan.toUpperCase()}-${randomPart}-${timestamp}`;

    const newKey = {
        key: key,
        plan: plan,
        customerName: customerName,
        transferContent: transferContent || '',
        amount: amount || 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + KEY_EXPIRE_MS).toISOString(),
        confirmedAt: null,
        confirmedBy: null,
        feedbackKey: null // Thêm trường lưu Feedback Key
    };

    db.keys.push(newKey);
    writeDB(db);

    res.json({
        success: true,
        key: key,
        expiresAt: newKey.expiresAt,
        message: `Key đã được tạo. Vui lòng thanh toán và xác nhận trong ${KEY_EXPIRE_HOURS}h.`
    });
});

// 2. Admin lấy tất cả key
app.post('/api/admin/keys', (req, res) => {
    const { username, password } = req.body;

    if (!verifyAdmin(username, password)) {
        return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    }

    const cleanupResult = cleanupExpiredKeys();
    const db = readDB();

    const keysWithRemainingTime = db.keys.map(k => {
        if (k.status === 'pending') {
            const rem = calcRemainingTime(k.createdAt, k.status);
            return {
                ...k,
                remainingHours: rem ? rem.hours : 0,
                remainingMinutes: rem ? rem.minutes : 0,
                isExpiringSoon: rem ? rem.hours < 6 : false
            };
        }
        return k;
    });

    res.json({
        keys: keysWithRemainingTime,
        cleanupInfo: {
            deletedCount: cleanupResult.deletedCount,
            expireHours: KEY_EXPIRE_HOURS
        }
    });
});

// 3. Admin xác nhận key (Đã thêm logic tạo Feedback Key)
app.post('/api/admin/confirm-key', (req, res) => {
    const { username, password, pin, key } = req.body;

    if (!verifyAdmin(username, password)) {
        return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    }

    if (pin !== ADMIN_PIN) {
        return res.status(403).json({ error: 'Mã PIN không đúng' });
    }

    cleanupExpiredKeys();

    const db = readDB();
    const keyIndex = db.keys.findIndex(k => k.key === key);

    if (keyIndex === -1) {
        return res.status(404).json({
            error: 'Không tìm thấy key. Key có thể đã bị xóa do quá 24h chưa xác nhận.'
        });
    }

    if (db.keys[keyIndex].status === 'confirmed') {
        return res.status(400).json({ error: 'Key này đã được xác nhận trước đó.' });
    }

    // Tạo Feedback Key ngẫu nhiên
    const randomFB = Math.random().toString(36).substring(2, 8).toUpperCase();
    const feedbackKey = `FB-${randomFB}`;

    db.keys[keyIndex].status = 'confirmed';
    db.keys[keyIndex].confirmedAt = new Date().toISOString();
    db.keys[keyIndex].confirmedBy = username;
    db.keys[keyIndex].feedbackKey = feedbackKey; // Lưu Feedback Key vào data
    db.keys[keyIndex].isFeedbackUsed = false;    // Đánh dấu Feedback Key chưa sử dụng

    writeDB(db);

    res.json({
        success: true,
        message: 'Xác nhận Key thành công',
        feedbackKey: feedbackKey, // Trả về cho Frontend hiển thị
        keyData: db.keys[keyIndex]
    });
});

// 4. Check key CHÍNH XÁC (public)
app.post('/api/check-key', (req, res) => {
    const { key } = req.body;

    if (!key) {
        return res.status(400).json({ error: 'Thiếu key' });
    }

    cleanupExpiredKeys();

    const db = readDB();
    const keyData = db.keys.find(k => k.key.toUpperCase() === key.trim().toUpperCase());

    if (!keyData) {
        return res.status(404).json({
            error: 'Key không tồn tại hoặc đã hết hạn (quá 24h chưa xác nhận).'
        });
    }

    const rem = calcRemainingTime(keyData.createdAt, keyData.status);

    res.json({
        success: true,
        keyData: {
            key: keyData.key,
            plan: keyData.plan,
            status: keyData.status,
            customerName: keyData.customerName,
            transferContent: keyData.transferContent,
            amount: keyData.amount,
            createdAt: keyData.createdAt,
            confirmedAt: keyData.confirmedAt,
            expiresAt: keyData.expiresAt,
            remainingTime: rem ? { hours: rem.hours, minutes: rem.minutes } : null
        }
    });
});

// 5. SEARCH KEY NÂNG CAO
app.post('/api/search-keys', (req, res) => {
    try {
        const { query } = req.body;

        if (!query || !query.trim()) {
            return res.status(400).json({
                error: 'Vui lòng nhập từ khóa tìm kiếm!'
            });
        }

        cleanupExpiredKeys();

        const searchTerm = query.trim().toUpperCase();
        const db = readDB();
        const allKeys = db.keys || [];

        const matches = allKeys.filter(k => {
            const keyMatch = k.key && k.key.toUpperCase().includes(searchTerm);
            const contentMatch = k.transferContent && k.transferContent.toUpperCase().includes(searchTerm);
            const nameMatch = k.customerName && k.customerName.toUpperCase().includes(searchTerm);
            return keyMatch || contentMatch || nameMatch;
        });

        matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const totalMatches = matches.length;
        const limitedMatches = matches.slice(0, 50);

        const results = limitedMatches.map(k => {
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
                expiresAt: k.expiresAt,
                remainingTime: rem && !rem.isExpired
                    ? { hours: rem.hours, minutes: rem.minutes, totalHours: rem.totalHours }
                    : null,
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
            query: searchTerm,
            count: results.length,
            totalMatches: totalMatches,
            results: results
        });

    } catch (err) {
        console.error('❌ Search keys error:', err);
        res.status(500).json({
            error: 'Lỗi server khi tìm kiếm: ' + err.message
        });
    }
});

// 6. Lấy key đã xác nhận (public)
app.get('/api/confirmed-keys', (req, res) => {
    cleanupExpiredKeys();
    const db = readDB();
    const confirmed = db.keys
        .filter(k => k.status === 'confirmed')
        .map(k => ({
            key: k.key,
            plan: k.plan,
            customerName: k.customerName,
            confirmedAt: k.confirmedAt
        }));
    res.json({ keys: confirmed });
});

// 7. Admin dọn dẹp thủ công
app.post('/api/admin/cleanup-now', (req, res) => {
    const { username, password } = req.body;

    if (!verifyAdmin(username, password)) {
        return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    }

    const result = cleanupExpiredKeys();
    res.json({
        success: true,
        message: `Đã xóa ${result.deletedCount} key hết hạn.`,
        deletedKeys: result.deletedKeys
    });
});

// ============ API DÀNH CHO FEEDBACK ============

// 8. Public: Lấy danh sách Feedback
app.get('/api/feedbacks', (req, res) => {
    const db = readDB();
    // Trả về mảng feedbacks (sắp xếp mới nhất trước)
    const sortedFeedbacks = [...db.feedbacks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ feedbacks: sortedFeedbacks });
});

// 9. User: Gửi Feedback mới (Có xác thực Feedback Key)
app.post('/api/submit-feedback', (req, res) => {
    const { feedbackKey, rating, content, images } = req.body;

    if (!feedbackKey || !rating || !content) {
        return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin đánh giá.' });
    }

    const db = readDB();
    // Tìm key chứa feedbackKey này
    const targetKeyIndex = db.keys.findIndex(k => k.feedbackKey === feedbackKey);

    if (targetKeyIndex === -1) {
        return res.status(400).json({ error: 'Feedback Key không hợp lệ hoặc không tồn tại.' });
    }

    if (db.keys[targetKeyIndex].isFeedbackUsed) {
        return res.status(400).json({ error: 'Feedback Key này đã được sử dụng rồi.' });
    }

    // Đánh dấu đã dùng
    db.keys[targetKeyIndex].isFeedbackUsed = true;

    // Tạo đối tượng feedback mới
    const newFeedback = {
        id: Date.now().toString(),
        customerName: db.keys[targetKeyIndex].customerName || 'Khách ẩn danh',
        feedbackKey: feedbackKey,
        rating: Number(rating),
        content: content,
        images: images || [], // Mảng base64
        createdAt: new Date().toISOString()
    };

    db.feedbacks.push(newFeedback);
    writeDB(db);

    res.json({ success: true, message: 'Gửi đánh giá thành công!', feedback: newFeedback });
});

// 10. Admin: Lấy danh sách Feedback
app.post('/api/admin/feedbacks', (req, res) => {
    const { username, password } = req.body;

    if (!verifyAdmin(username, password)) {
        return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu Admin!' });
    }

    const db = readDB();
    const sortedFeedbacks = [...db.feedbacks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ feedbacks: sortedFeedbacks });
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    const db = readDB();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        totalKeys: db.keys.length,
        pendingKeys: db.keys.filter(k => k.status === 'pending').length,
        confirmedKeys: db.keys.filter(k => k.status === 'confirmed').length,
        totalFeedbacks: db.feedbacks.length,
        timestamp: new Date().toISOString()
    });
});

// ============ 404 HANDLER ============
app.use((req, res) => {
    res.status(404).json({ error: 'API endpoint không tồn tại: ' + req.path });
});

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
});

// ============ KHỞI ĐỘNG SERVER ============
app.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════════╗`);
    console.log(`║  ✅ TYON OPTIMIZER SERVER ĐANG CHẠY         ║`);
    console.log(`╚════════════════════════════════════════════╝`);
    console.log(`🌐 URL:        http://localhost:${PORT}`);
    console.log(`📁 Database:   ${DB_FILE}`);
    console.log(`⏰ Key expire: ${KEY_EXPIRE_HOURS} giờ`);
    console.log(`🔄 Cleanup:    mỗi ${CLEANUP_INTERVAL_MS / (60 * 1000)} phút`);
    console.log(`\n📋 API Endpoints:`);
    console.log(`   [KEYS]`);
    console.log(`   POST /api/create-key       - Tạo key mới`);
    console.log(`   POST /api/check-key        - Check chính xác 1 key`);
    console.log(`   POST /api/search-keys      - 🔍 Tìm kiếm nâng cao`);
    console.log(`   GET  /api/confirmed-keys   - Danh sách key đã xác nhận`);
    console.log(`   POST /api/admin/keys       - [ADMIN] Danh sách tất cả key`);
    console.log(`   POST /api/admin/confirm-key- [ADMIN] Xác nhận key`);
    console.log(`   POST /api/admin/cleanup-now- [ADMIN] Dọn dẹp ngay`);
    console.log(`   [FEEDBACK]`);
    console.log(`   GET  /api/feedbacks        - Danh sách đánh giá (public)`);
    console.log(`   POST /api/submit-feedback  - Gửi đánh giá mới`);
    console.log(`   POST /api/admin/feedbacks  - [ADMIN] Xem danh sách đánh giá\n`);
});

// ============ GRACEFUL SHUTDOWN ============
process.on('SIGINT', () => {
    console.log('\n\n👋 Đang tắt server...');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
});
