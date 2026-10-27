const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// ============ CẤU HÌNH THỜI GIAN XÓA KEY ============
const KEY_EXPIRE_HOURS = 24; // Key chưa xác nhận sẽ bị xóa sau 24h
const KEY_EXPIRE_MS = KEY_EXPIRE_HOURS * 60 * 60 * 1000; // 24h tính bằng ms
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Chạy dọn dẹp mỗi 1 giờ

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Khởi tạo database nếu chưa có
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ keys: [], confirmedKeys: [] }, null, 2));
}

// ============ ĐỌC / GHI DATABASE ============
function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return { keys: [], confirmedKeys: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ============ HÀM DỌN DẸP KEY HẾT HẠN ============
/**
 * Xóa tất cả key có status = 'pending' và đã tạo quá 24h
 * @returns {object} { deletedCount, deletedKeys }
 */
function cleanupExpiredKeys() {
    const db = readDB();
    const now = Date.now();

    const deletedKeys = [];
    const remainingKeys = [];

    db.keys.forEach(k => {
        // Chỉ xử lý key đang pending
        if (k.status === 'pending') {
            const createdAt = new Date(k.createdAt).getTime();
            const age = now - createdAt;

            if (age > KEY_EXPIRE_MS) {
                // Quá 24h → xóa
                deletedKeys.push({
                    key: k.key,
                    customerName: k.customerName,
                    plan: k.plan,
                    createdAt: k.createdAt,
                    ageHours: Math.floor(age / (60 * 60 * 1000))
                });
            } else {
                // Còn hạn → giữ lại
                remainingKeys.push(k);
            }
        } else {
            // Key đã confirmed → luôn giữ
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

// ============ CRON JOB: CHẠY DỌN DẸP ĐỊNH KỲ ============
// Chạy ngay lần đầu khi khởi động server
setTimeout(() => {
    console.log('🚀 Kiểm tra key hết hạn lần đầu...');
    cleanupExpiredKeys();
}, 5000); // Đợi 5s để server khởi động xong

// Chạy định kỳ mỗi 1 giờ
setInterval(() => {
    const result = cleanupExpiredKeys();
    if (result.deletedCount === 0) {
        console.log(`✅ [${new Date().toLocaleString('vi-VN')}] Không có key nào hết hạn.`);
    }
}, CLEANUP_INTERVAL_MS);

// ============ API ENDPOINTS ============

// 1. Tạo key mới
app.post('/api/create-key', (req, res) => {
    const { plan, customerName, transferContent, amount } = req.body;

    if (!plan || !customerName) {
        return res.status(400).json({ error: 'Thiếu thông tin' });
    }

    // Dọn dẹp trước khi tạo key mới (đảm bảo data sạch)
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
        expiresAt: new Date(Date.now() + KEY_EXPIRE_MS).toISOString(), // Thêm thời gian hết hạn
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

    if (username !== 'caoquangtuan' || password !== 'CaoQuangTuan@026209000010') {
        return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    }

    // Dọn dẹp key hết hạn trước khi trả về
    const cleanupResult = cleanupExpiredKeys();
    const db = readDB();

    // Tính thời gian còn lại cho mỗi key pending
    const now = Date.now();
    const keysWithRemainingTime = db.keys.map(k => {
        if (k.status === 'pending') {
            const createdAt = new Date(k.createdAt).getTime();
            const expiresAt = createdAt + KEY_EXPIRE_MS;
            const remainingMs = expiresAt - now;
            const remainingHours = Math.max(0, Math.floor(remainingMs / (60 * 60 * 1000)));
            const remainingMinutes = Math.max(0, Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000)));

            return {
                ...k,
                remainingHours,
                remainingMinutes,
                isExpiringSoon: remainingHours < 6 // Cảnh báo nếu còn dưới 6h
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

    if (username !== 'caoquangtuan' || password !== 'CaoQuangTuan@026209000010') {
        return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    }

    if (pin !== '997722') {
        return res.status(403).json({ error: 'Mã PIN không đúng' });
    }

    // Dọn dẹp trước (nếu key đã hết hạn thì không tìm thấy nữa)
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

// 4. Check key (public)
app.post('/api/check-key', (req, res) => {
    const { key } = req.body;

    if (!key) {
        return res.status(400).json({ error: 'Thiếu key' });
    }

    // Dọn dẹp trước (key hết hạn sẽ không tồn tại)
    cleanupExpiredKeys();

    const db = readDB();
    const keyData = db.keys.find(k => k.key === key);

    if (!keyData) {
        return res.status(404).json({
            error: 'Key không tồn tại hoặc đã hết hạn (quá 24h chưa xác nhận).'
        });
    }

    // Tính thời gian còn lại
    let remainingTime = null;
    if (keyData.status === 'pending') {
        const createdAt = new Date(keyData.createdAt).getTime();
        const expiresAt = createdAt + KEY_EXPIRE_MS;
        const remainingMs = expiresAt - Date.now();
        remainingTime = {
            hours: Math.max(0, Math.floor(remainingMs / (60 * 60 * 1000))),
            minutes: Math.max(0, Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000)))
        };
    }

    res.json({
        success: true,
        keyData: {
            key: keyData.key,
            plan: keyData.plan,
            status: keyData.status,
            createdAt: keyData.createdAt,
            confirmedAt: keyData.confirmedAt,
            expiresAt: keyData.expiresAt,
            remainingTime
        }
    });
});

// 5. Lấy key đã xác nhận (public)
app.get('/api/confirmed-keys', (req, res) => {
    cleanupExpiredKeys();
    const db = readDB();
    const confirmed = db.keys.filter(k => k.status === 'confirmed');
    res.json({ keys: confirmed });
});

// 6. API thủ công để admin dọn dẹp ngay (tùy chọn)
app.post('/api/admin/cleanup-now', (req, res) => {
    const { username, password } = req.body;

    if (username !== 'caoquangtuan' || password !== 'CaoQuangTuan@026209000010') {
        return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    }

    const result = cleanupExpiredKeys();
    res.json({
        success: true,
        message: `Đã xóa ${result.deletedCount} key hết hạn.`,
        deletedKeys: result.deletedKeys
    });
});

// ============ KHỞI ĐỘNG SERVER ============
app.listen(PORT, () => {
    console.log(`\n✅ Server đang chạy tại http://localhost:${PORT}`);
    console.log(`📁 Database: ${DB_FILE}`);
    console.log(`⏰ Key chưa xác nhận sẽ tự động xóa sau ${KEY_EXPIRE_HOURS} giờ`);
    console.log(`🔄 Dọn dẹp tự động mỗi ${CLEANUP_INTERVAL_MS / (60 * 1000)} phút\n`);
});