// fb_api_routes.js
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JOBS_DIR = path.join(__dirname, 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

// Giới hạn chạy song song (tránh sập server Render)
const MAX_CONCURRENT = 3;
const runningJobs = new Set();

module.exports = function setupFbRoutes(app, { requireUserSession }) {
    
    // 1. API Tạo Job (Người dùng bấm "Bắt đầu")
    app.post('/api/fb/jobs', requireUserSession, (req, res) => {
        try {
            const { cookies, targets, count, delay, reactions, comments } = req.body;

            if (!Array.isArray(cookies) || cookies.length === 0)
                return res.status(400).json({ success: false, error: 'Chưa có cookie' });
            if (!Array.isArray(targets) || targets.length === 0)
                return res.status(400).json({ success: false, error: 'Chưa có mục tiêu' });
            if (!count || count <= 0)
                return res.status(400).json({ success: false, error: 'Số lần không hợp lệ' });
            if (!delay || delay < 10)
                return res.status(400).json({ success: false, error: 'Delay tối thiểu 10s để bảo vệ nick' });

            if (runningJobs.size >= MAX_CONCURRENT) {
                return res.status(429).json({ success: false, error: 'Server đang bận, vui lòng thử lại sau ít phút.' });
            }

            const jobId = crypto.randomBytes(6).toString('hex');
            runningJobs.add(jobId);

            // Gọi Python chạy ngầm
            const py = spawn('python3', [path.join(__dirname, 'fb_worker.py')], {
                cwd: __dirname,
                env: { ...process.env, PYTHONUNBUFFERED: '1' }
            });

            // Truyền data cho Python
            py.stdin.write(JSON.stringify({
                job_id: jobId, cookies, targets, count, delay,
                reactions: reactions || ['LIKE'],
                comments: comments || ['👍']
            }));
            py.stdin.end();

            py.stdout.on('data', d => console.log(`[FB-Worker ${jobId}]`, d.toString().trim()));
            py.stderr.on('data', d => console.error(`[FB-Worker ${jobId} ERR]`, d.toString().trim()));

            py.on('close', (code) => {
                runningJobs.delete(jobId);
                console.log(`[FB-Worker ${jobId}] Đã đóng (code=${code})`);
            });

            return res.status(202).json({ success: true, job_id: jobId, message: 'Đã bắt đầu chạy ngầm' });
        } catch (err) {
            console.error('❌ Lỗi tạo Job:', err);
            res.status(500).json({ success: false, error: 'Lỗi server' });
        }
    });

    // 2. API Lấy tiến độ (Frontend gọi mỗi 2 giây)
    app.get('/api/fb/jobs/:jobId', requireUserSession, (req, res) => {
        const f = path.join(JOBS_DIR, `${req.params.jobId}.json`);
        if (!fs.existsSync(f)) {
            return res.status(404).json({ success: false, error: 'Không tìm thấy dữ liệu job này.' });
        }
        try {
            const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
            res.json({ success: true, ...data });
        } catch (e) {
            res.status(500).json({ success: false, error: 'Lỗi đọc tiến độ' });
        }
    });

    // 3. API Hủy Job (nếu muốn dừng giữa chừng)
    app.post('/api/fb/jobs/:jobId/cancel', requireUserSession, (req, res) => {
        const jobId = req.params.jobId;
        const f = path.join(JOBS_DIR, `${jobId}.json`);
        if (!fs.existsSync(f)) return res.status(404).json({ success: false, error: 'Job không tồn tại' });

        try {
            const st = JSON.parse(fs.readFileSync(f, 'utf-8'));
            if (['done', 'failed', 'cancelled'].includes(st.status)) {
                return res.status(400).json({ success: false, error: 'Job đã kết thúc từ trước' });
            }
            st.status = 'cancelled';
            st.finished_at = new Date().toISOString();
            fs.writeFileSync(f, JSON.stringify(st));
            res.json({ success: true, message: 'Đã gửi yêu cầu hủy' });
        } catch (e) {
            res.status(500).json({ success: false, error: 'Lỗi server' });
        }
    });
};
