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
app.use(express.json());
app.use(express.static(__dirname));

// Khởi tạo database nếu chưa có
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ keys: [], confirmedKeys: [] }, null, 2));
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
        return parsed;
    } catch (err) {
        console.error('❌ Lỗi đọc DB:', err.message);
        return { keys: [], confirmedKeys: [] };
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
        confirmedBy: null
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

// 3. Admin xác nhận key
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

    db.keys[keyIndex].status = 'confirmed';
    db.keys[keyIndex].confirmedAt = new Date().toISOString();
    db.keys[keyIndex].confirmedBy = username;

    writeDB(db);

    res.json({
        success: true,
        message: 'Key đã được xác nhận thành công',
        keyData: db.keys[keyIndex]
    });
});

// 4. Check key CHÍNH XÁC (public - giữ nguyên cho tương thích)
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

// 5. ✅ SEARCH KEY NÂNG CAO - TÌM THEO KEY / NỘI DUNG CK / TÊN KH
app.post('/api/search-keys', (req, res) => {
    try {
        const { query } = req.body;

        if (!query || !query.trim()) {
            return res.status(400).json({
                error: 'Vui lòng nhập từ khóa tìm kiếm!'
            });
        }

        // Dọn dẹp trước để không hiển thị key đã hết hạn
        cleanupExpiredKeys();

        const searchTerm = query.trim().toUpperCase();
        const db = readDB();
        const allKeys = db.keys || [];  // ✅ FIX: dùng db.keys thay vì keysDB

        // Tìm kiếm substring trên 3 trường: key, transferContent, customerName
        const matches = allKeys.filter(k => {
            const keyMatch = k.key && k.key.toUpperCase().includes(searchTerm);
            const contentMatch = k.transferContent && k.transferContent.toUpperCase().includes(searchTerm);
            const nameMatch = k.customerName && k.customerName.toUpperCase().includes(searchTerm);
            return keyMatch || contentMatch || nameMatch;
        });

        // Sắp xếp: mới nhất trước
        matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const totalMatches = matches.length;
        const limitedMatches = matches.slice(0, 50);

        // Format kết quả trả về
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
                // Đánh dấu trường nào match để frontend highlight
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

// 8. Health check
app.get('/api/health', (req, res) => {
    const db = readDB();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        totalKeys: db.keys.length,
        pendingKeys: db.keys.filter(k => k.status === 'pending').length,
        confirmedKeys: db.keys.filter(k => k.status === 'confirmed').length,
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
    console.log(`   POST /api/create-key       - Tạo key mới`);
    console.log(`   POST /api/check-key        - Check chính xác 1 key`);
    console.log(`   POST /api/search-keys      - 🔍 Tìm kiếm nâng cao`);
    console.log(`   GET  /api/confirmed-keys   - Danh sách key đã xác nhận`);
    console.log(`   GET  /api/health           - Health check`);
    console.log(`   POST /api/admin/keys       - [ADMIN] Danh sách tất cả key`);
    console.log(`   POST /api/admin/confirm-key- [ADMIN] Xác nhận key`);
    console.log(`   POST /api/admin/cleanup-now- [ADMIN] Dọn dẹp ngay\n`);
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
