# fb_worker.py
import sys
import json
import os
import time
import traceback
from datetime import datetime
import random

# Import class Facebook từ file nuoifb.py của bạn
try:
    from nuoifb import Facebook, kiem_tra_cookie
except ImportError:
    print("Lỗi: Không tìm thấy file nuoifb.py")
    sys.exit(1)

def write_status(job_file, data):
    # Ghi an toàn (tránh file bị hỏng khi đang ghi)
    tmp = job_file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, job_file)

def main():
    # Đọc dữ liệu Node.js truyền vào qua stdin
    try:
        payload = json.loads(sys.stdin.read())
    except:
        sys.exit(1)

    job_id = payload["job_id"]
    
    # Đảm bảo thư mục jobs tồn tại
    os.makedirs("jobs", exist_ok=True)
    job_file = os.path.join("jobs", f"{job_id}.json")

    # Khởi tạo trạng thái
    state = {
        "job_id": job_id,
        "status": "running",
        "done": 0,
        "count": payload["count"],
        "log": [],
        "started_at": datetime.now().isoformat(),
        "finished_at": None,
        "error": None
    }
    write_status(job_file, state)

    try:
        cookies = payload["cookies"]
        targets = payload["targets"]
        so_lan = payload["count"]
        delay = payload["delay"]
        cam_xuc_list = payload.get("reactions", ["LIKE"])
        comments = payload.get("comments", ["👍"])

        # 1. Kiểm tra cookie sống/chết
        cookies_hop_le = []
        for ck in cookies:
            r = kiem_tra_cookie(ck)
            if r.get("status") == "success":
                cookies_hop_le.append(ck)
                
        if not cookies_hop_le:
            state["status"] = "failed"
            state["error"] = "Tất cả cookie đều chết hoặc không hợp lệ."
            state["finished_at"] = datetime.now().isoformat()
            write_status(job_file, state)
            return

        # 2. Bắt đầu vòng lặp chạy tool
        stt = 0
        loi_lien_tuc = 0
        cookie_index = 0
        target_index = 0

        while stt < so_lan and target_index < len(targets):
            cookie = cookies_hop_le[cookie_index]
            target = targets[target_index]
            loai = target["loai"]
            tid = target["id"]
            noi_dung = target.get("noi_dung", "")

            fb = Facebook(cookie)
            info = fb.info()
            
            # Nếu cookie bị checkpoint / die
            if info in ("cookieout", "956", "282", "spam"):
                cookies_hop_le.pop(cookie_index)
                if not cookies_hop_le:
                    state["error"] = "Toàn bộ cookie bị die giữa chừng."
                    break
                cookie_index = cookie_index % len(cookies_hop_le)
                continue

            # Thực hiện tác vụ
            kq = {"trangthai": "thatbai"}
            mo_ta = ""
            if loai == "reaction":
                cam_xuc = noi_dung.upper() if noi_dung else random.choice(cam_xuc_list)
                kq = fb.tha_cam_xuc(tid, cam_xuc)
                mo_ta = f"Thả {cam_xuc} bài {tid}"
            elif loai == "comment":
                nd = noi_dung or random.choice(comments)
                kq = fb.binh_luan(tid, nd)
                mo_ta = f"Comment bài {tid}"
            elif loai == "friend":
                kq = fb.ket_ban(tid)
                mo_ta = f"Kết bạn UID {tid}"
            elif loai == "group":
                kq = fb.tham_gia_nhom(tid)
                mo_ta = f"Join nhóm {tid}"

            # Cập nhật log
            time_now = datetime.now().strftime("%H:%M:%S")
            if kq.get("trangthai") == "thanhcong":
                stt += 1
                loi_lien_tuc = 0
                target_index += 1
                state["log"].append({"time": time_now, "result": "success", "detail": mo_ta})
            else:
                loi_lien_tuc += 1
                state["log"].append({"time": time_now, "result": "fail", "detail": mo_ta})

            state["done"] = stt
            state["log"] = state["log"][-50:] # Chỉ giữ 50 dòng log mới nhất để nhẹ file
            write_status(job_file, state)

            # Dừng nếu sai liên tục quá nhiều (tránh ban nick)
            if loi_lien_tuc >= 20:
                state["error"] = "Dừng do sai liên tục quá 20 lần."
                break

            # Đổi cookie
            cookie_index = (cookie_index + 1) % len(cookies_hop_le)
            
            # Delay
            if stt < so_lan:
                time.sleep(delay)

        # Kết thúc
        state["done"] = stt
        state["status"] = "done" if not state["error"] else "failed"
        state["finished_at"] = datetime.now().isoformat()
        write_status(job_file, state)

    except Exception as e:
        state["status"] = "failed"
        state["error"] = str(e)
        state["finished_at"] = datetime.now().isoformat()
        state["log"].append({"time": datetime.now().strftime("%H:%M:%S"), "result": "error", "detail": traceback.format_exc()})
        write_status(job_file, state)

if __name__ == "__main__":
    main()
