# Hướng dẫn sử dụng - Video Concatenation Tool

## Tổng quan

Tool này giúp bạn xử lý nhiều video song song, mỗi video sẽ:
1. Được lặp lại nhiều lần
2. Thêm phần màn hình đen với nhạc random ở cuối
3. Tạo thành 1 video output với thời lượng mong muốn

## Cách sử dụng

### Bước 1: Chọn thư mục

1. **Thư mục video:** Chọn folder chứa các video input1 (video gốc cần lặp lại)
2. **Thư mục nhạc:** Chọn folder chứa các file nhạc (sẽ random chọn để thêm vào màn hình đen)
3. **Thư mục output:** Chọn folder để lưu kết quả

### Bước 2: Cấu hình

#### Video & Cấu hình
- **Định dạng output:** MP4, AVI, MKV, hoặc MOV
- **Bitrate video:** 1-50 Mbps (khuyến nghị: 5-10 Mbps)
- **Số luồng xử lý:** Số video được xử lý đồng thời
  - Ví dụ: Có 10 video, chọn 2 luồng → xử lý 2 video cùng lúc
  - Tối đa = số core CPU - 1
  - Khuyến nghị: 2-4 luồng (tùy RAM)

#### GPU
- **Dùng GPU để encode:** Bật nếu máy có GPU hỗ trợ
- **Chọn GPU:** Nếu có nhiều GPU, chọn GPU muốn dùng
- GPU encode nhanh hơn CPU rất nhiều (3-10 lần)

#### Audio & Output
- **Số bài hát random:** Số bài hát sẽ được chọn ngẫu nhiên để ghép vào màn hình đen
- **Thời lượng video output:** Thời lượng mong muốn cho mỗi video output (hh:mm:ss)
  - Ví dụ: 00:20:59 = 20 phút 59 giây
  - Video gốc sẽ lặp lại cho đủ thời lượng này

### Bước 3: Thêm vào hàng đợi

1. Nhấn **"Thêm vào hàng đợi"**
2. Hệ thống sẽ tạo 1 job với nhiều task (1 task = 1 video input1)
3. Các task sẽ được xử lý song song theo số luồng đã chọn

### Bước 4: Theo dõi tiến độ

- **Job card** hiển thị:
  - Tổng số video và số video đã hoàn thành
  - Tiến độ từng video đang xử lý
  - Encoder đang dùng (GPU hoặc CPU)
  - Danh sách file output khi hoàn thành

- **Huỷ job:** Nhấn nút "Huỷ" trên job card để dừng xử lý

## Ví dụ cụ thể

### Tình huống: Có 5 video cần xử lý

**Input:**
- Folder video: `D:\Videos\Input` (5 video: video1.mp4, video2.mp4, ..., video5.mp4)
- Folder nhạc: `D:\Music` (20 bài nhạc)
- Thời lượng mong muốn: 20 phút 59 giây
- Số luồng: 2

**Quá trình:**
1. Hệ thống tạo 5 task (1 task/video)
2. Chạy 2 task đầu tiên song song:
   - Task 1: Xử lý video1.mp4
   - Task 2: Xử lý video2.mp4
3. Khi Task 1 hoàn thành → Task 3 bắt đầu
4. Khi Task 2 hoàn thành → Task 4 bắt đầu
5. Tiếp tục cho đến khi xử lý xong cả 5 video

**Output:**
```
D:\Output\
├── video1_output_1234567890.mp4  (20:59)
├── video1_output_1234567890.txt  (thông tin chi tiết)
├── video2_output_1234567891.mp4  (20:59)
├── video2_output_1234567891.txt
├── video3_output_1234567892.mp4  (20:59)
├── video3_output_1234567892.txt
├── video4_output_1234567893.mp4  (20:59)
├── video4_output_1234567893.txt
├── video5_output_1234567894.mp4  (20:59)
├── video5_output_1234567894.txt
└── .cache_encoded/  (cache video đã encode)
```

## Mỗi video output bao gồm:

1. **Phần video lặp lại:**
   - Video gốc được lặp lại nhiều lần
   - Ví dụ: Video gốc 3 phút, cần 18 phút → lặp 6 lần

2. **Phần màn hình đen + nhạc:**
   - Màn hình đen (1920x1080)
   - Nhạc random từ folder nhạc
   - Thời lượng = tổng thời lượng các bài hát được chọn

## Tips & Tricks

### Tối ưu hiệu suất

1. **Số luồng:**
   - Máy 4 core: Chọn 2 luồng
   - Máy 8 core: Chọn 4 luồng
   - Máy 16 core: Chọn 6-8 luồng
   - Lưu ý: Mỗi luồng cần ~500MB-1GB RAM

2. **GPU:**
   - Luôn bật GPU nếu có
   - NVIDIA GPU thường nhanh nhất
   - Apple M1/M2 cũng rất nhanh với VideoToolbox

3. **Cache:**
   - Video đã encode được cache trong `.cache_encoded`
   - Lần chạy sau sẽ nhanh hơn nhiều
   - Xóa cache nếu thay đổi bitrate hoặc format

### Xử lý lỗi

1. **Lỗi "Không tìm thấy file video":**
   - Kiểm tra folder video có file .mp4, .avi, .mkv, .mov, .flv, .wmv
   - Kiểm tra quyền truy cập folder

2. **Lỗi "Tổng thời lượng nhạc vượt quá...":**
   - Giảm số bài hát random
   - Hoặc tăng thời lượng video output

3. **Video bị lag/giật:**
   - Tăng bitrate (khuyến nghị 8-10 Mbps)
   - Kiểm tra video gốc có bị lỗi không

4. **Hết RAM:**
   - Giảm số luồng
   - Đóng các ứng dụng khác

## Câu hỏi thường gặp

**Q: Tại sao cần màn hình đen + nhạc?**
A: Để đảm bảo video đủ thời lượng mong muốn mà không cần lặp lại video gốc quá nhiều lần.

**Q: Có thể xử lý bao nhiêu video cùng lúc?**
A: Phụ thuộc vào RAM và CPU. Khuyến nghị không quá 4-6 video cùng lúc.

**Q: GPU encode có ảnh hưởng chất lượng không?**
A: Không đáng kể. GPU encode nhanh hơn nhiều và chất lượng tương đương CPU.

**Q: Cache có thể xóa được không?**
A: Có, xóa folder `.cache_encoded` trong thư mục output. Lần chạy sau sẽ encode lại từ đầu.

**Q: Có thể dừng giữa chừng không?**
A: Có, nhấn nút "Huỷ" trên job card. Các video đã hoàn thành sẽ được giữ lại.
