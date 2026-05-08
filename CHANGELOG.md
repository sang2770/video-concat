# Changelog - Video Concatenation Tool

## Phiên bản mới - Xử lý song song nhiều video

### Thay đổi chính

#### 1. **Số luồng = Số video xử lý song song**
- **Trước:** Số luồng là số thread encode của FFmpeg
- **Sau:** Số luồng là số video input1 được xử lý đồng thời
- Mỗi worker xử lý 1 video input1 → tạo 1 video output
- Output: n video tương ứng với n video input1

#### 2. **Chọn GPU**
- Detect tất cả GPU encoder khả dụng (NVIDIA, AMD, Intel, Apple)
- Cho phép chọn GPU cụ thể nếu máy có nhiều GPU
- Hiển thị dropdown để chọn GPU khi có nhiều hơn 1 GPU

#### 3. **Cấu trúc Job mới**
- **Job:** Đại diện cho 1 batch xử lý (tất cả video trong folder)
- **Task:** Đại diện cho 1 video input1 cụ thể
- Mỗi job có nhiều task, mỗi task chạy trong 1 worker riêng
- Hiển thị tiến độ chi tiết cho từng task

#### 4. **Màn hình đen + Nhạc**
- **Fix:** Đảm bảo mỗi video output đều có phần màn hình đen với nhạc random
- Mỗi worker tạo phần màn hình đen riêng với bài hát random
- Không bị thiếu màn hình đen như trước

### Cấu trúc file mới

```
src/
├── singleVideoWorker.js  (MỚI) - Worker xử lý 1 video input1
├── jobQueue.js           (CẬP NHẬT) - Quản lý job và task
├── sysInfo.js            (CẬP NHẬT) - Detect tất cả GPU
├── renderer.js           (CẬP NHẬT) - UI cho chọn GPU và hiển thị task
├── index.html            (CẬP NHẬT) - Thêm GPU selector
└── index.css             (CẬP NHẬT) - Style cho task display
```

### Workflow mới

1. **User chọn folder video input1** (ví dụ: 5 video)
2. **User chọn số luồng** (ví dụ: 2 luồng)
3. **User chọn GPU** (nếu có nhiều GPU)
4. **Nhấn "Thêm vào hàng đợi"**
5. **Hệ thống tạo:**
   - 1 Job với 5 task (1 task/video)
   - Chạy 2 task song song (theo số luồng)
6. **Mỗi task:**
   - Encode video input1 (cache nếu đã encode)
   - Tạo màn hình đen + nhạc random
   - Lặp lại video input1 cho đủ thời lượng
   - Ghép video lặp + màn hình đen
   - Tạo 1 file output riêng

### Output

Với 5 video input1 (`video1.mp4`, `video2.mp4`, ..., `video5.mp4`):

```
output/
├── video1_output_xxx.mp4
├── video1_output_xxx.txt
├── video2_output_xxx.mp4
├── video2_output_xxx.txt
├── video3_output_xxx.mp4
├── video3_output_xxx.txt
├── video4_output_xxx.mp4
├── video4_output_xxx.txt
├── video5_output_xxx.mp4
├── video5_output_xxx.txt
└── .cache_encoded/       (cache các video đã encode)
```

### Ưu điểm

1. **Xử lý song song thực sự:** Nhiều video được xử lý cùng lúc
2. **Linh hoạt GPU:** Chọn GPU phù hợp nếu có nhiều GPU
3. **Dễ theo dõi:** Hiển thị tiến độ từng video riêng biệt
4. **Đảm bảo màn hình đen:** Mỗi video đều có phần màn hình đen + nhạc
5. **Cache thông minh:** Video đã encode được cache, không encode lại

### Lưu ý

- **Số luồng tối đa:** Phụ thuộc vào số core CPU (mặc định = số core - 1)
- **RAM:** Mỗi luồng cần ~500MB-1GB RAM
- **GPU:** Nếu dùng GPU, encode nhanh hơn nhiều so với CPU
- **Cache:** Folder `.cache_encoded` có thể lớn, xóa định kỳ nếu cần
