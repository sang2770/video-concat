# 🎬 Video Concatenation Tool

Công cụ ghép video chuyên nghiệp với giao diện Electron, hỗ trợ xử lý đa luồng và định dạng video linh hoạt.

## Tính năng

✅ **Xử lý video đa luồng** - Xử lý nhiều video cùng lúc  
✅ **Cấu hình linh hoạt** - Chọn định dạng (MP4, AVI, MKV, MOV) và chất lượng (Mbps)  
✅ **Tạo video âm thanh** - Tạo video màn hình đen với danh sách bài hát random  
✅ **Ghép video chính xác** - Loop video để đạt đúng thời gian 49:59:59  
✅ **Giao diện hiện đại** - UI dark theme với glassmorphism và animation mượt mà  
✅ **Theo dõi tiến độ** - Hiển thị tiến độ xử lý real-time  

## Yêu cầu hệ thống

- **Node.js** >= 14.0.0
- **FFmpeg** (cần cài đặt riêng)
- **Windows/Mac/Linux**

## Cài đặt FFmpeg

### Windows
```bash
# Sử dụng Chocolatey
choco install ffmpeg

# Hoặc tải từ: https://ffmpeg.org/download.html
```

### macOS
```bash
brew install ffmpeg
```

### Linux
```bash
sudo apt-get install ffmpeg
```

## Cài đặt và chạy

```bash
# Cài đặt dependencies
npm install

# Chạy ứng dụng
npm start

# Chạy ở chế độ development
npm run dev
```

## Hướng dẫn sử dụng

### Input 1: Video & Cấu hình
1. Chọn thư mục chứa danh sách video
2. Chọn định dạng video (MP4, AVI, MKV, MOV)
3. Nhập chất lượng video (1-50 Mbps)

### Input 2: Audio & Số lượng
1. Chọn thư mục chứa danh sách bài hát
2. Nhập số lượng bài hát random cần sử dụng
3. Chọn thư mục lưu kết quả

### Xử lý
1. Nhấn "Bắt đầu xử lý"
2. Theo dõi tiến độ trên thanh progress
3. Chờ cho đến khi hoàn thành

## Quy trình xử lý

```
Input 1 (Video) → Chuyển đổi định dạng + Bitrate → Output 1
                                                    ↓
                                            Loop để đạt 49:59:59
                                                    ↓
Input 2 (Audio) → Tạo video màn hình đen → Output 2
                                                    ↓
                                            Ghép Output 1 + Output 2
                                                    ↓
                                            Final Output
```

## Cấu trúc dự án

```
video-concat/
├── main.js                 # Electron main process
├── src/
│   ├── index.html         # UI HTML
│   ├── index.css          # Styling
│   ├── renderer.js        # Renderer process
│   ├── preload.js         # IPC preload
│   └── videoProcessor.js  # Video processing logic
├── package.json
└── README.md
```

## Lưu ý quan trọng

⚠️ **FFmpeg phải được cài đặt** trên hệ thống và có thể truy cập từ PATH  
⚠️ **Thời gian xử lý** phụ thuộc vào số lượng video, chất lượng và tốc độ CPU  
⚠️ **Dung lượng ổ cứng** cần đủ để lưu các file tạm và output cuối cùng  
⚠️ **Định dạng file** được hỗ trợ: MP4, AVI, MKV, MOV (video); MP3, WAV, AAC, FLAC, M4A, OGG (audio)

## Troubleshooting

### FFmpeg không tìm thấy
```bash
# Kiểm tra FFmpeg đã cài đặt
ffmpeg -version

# Nếu không có, cài đặt lại FFmpeg
```

### Lỗi "No video files found"
- Kiểm tra thư mục có chứa file video
- Kiểm tra định dạng file có được hỗ trợ

### Lỗi "No audio files found"
- Kiểm tra thư mục có chứa file audio
- Kiểm tra định dạng file có được hỗ trợ

## Phát triển

```bash
# Chạy ở chế độ development với DevTools
npm run dev

# Build production (nếu cần)
npm run build
```

## License

ISC

## Tác giả

Video Concatenation Tool - 2026
