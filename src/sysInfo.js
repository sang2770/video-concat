/**
 * sysInfo.js — Thông tin hệ thống: CPU threads + GPU encoder detection
 *
 * GPU detection: chạy `ffmpeg -encoders` và kiểm tra các encoder hardware:
 *   NVIDIA  → h264_nvenc   (NVENC)
 *   AMD     → h264_amf     (AMF / VCE)
 *   Intel   → h264_qsv     (Quick Sync)
 *   Apple   → h264_videotoolbox
 *
 * Ưu tiên: nvenc > amf > qsv > videotoolbox > libx264 (CPU fallback)
 */

'use strict';

const os = require('os');
const { spawnSync } = require('child_process');

// ── CPU threads ───────────────────────────────────────────────────────────────

/**
 * Trả về số thread tối đa nên dùng cho ffmpeg.
 * Giữ lại ít nhất 1 core cho hệ điều hành.
 * Giới hạn cứng: 16 (ffmpeg không benefit nhiều hơn).
 */
function getMaxThreads() {
  const logical = os.cpus().length;          // logical cores (hyperthreading)
  const safe = Math.max(1, logical - 1);  // để lại 1 core cho OS
  return Math.min(safe, 16);
}

/**
 * Trả về số thread mặc định hợp lý (50% cores, tối thiểu 2).
 */
function getDefaultThreads() {
  const logical = os.cpus().length;
  return Math.max(2, Math.floor(logical / 2));
}

// ── GPU encoder detection ─────────────────────────────────────────────────────

/**
 * Danh sách encoder ưu tiên theo thứ tự.
 * preset tương đương "fast" của libx264 cho mỗi encoder.
 */
const GPU_ENCODERS = [
  {
    codec: 'h264_nvenc',
    vendor: 'NVIDIA (NVENC)',
    preset: 'p4',       // balanced quality
    presetFast: 'p1',       // fastest (dùng khi chỉ cần append black screen)
    extraArgs: ['-rc', 'vbr', '-cq', '23'],  // use CQ instead of cq 0
  },
  {
    codec: 'h264_amf',
    vendor: 'AMD (AMF/VCE)',
    preset: 'balanced',
    presetFast: 'speed',
    extraArgs: [],
  },
  {
    codec: 'h264_qsv',
    vendor: 'Intel (Quick Sync)',
    preset: 'fast',           // QSV có hỗ trợ preset từ FFmpeg 4.0+
    presetFast: 'veryfast',
    extraArgs: ['-look_ahead', '0'],  // tắt look ahead để tăng tốc
  },
  {
    codec: 'h264_videotoolbox',
    vendor: 'Apple (VideoToolbox)',
    preset: null,       // không có -preset
    presetFast: null,
    extraArgs: [],
  },
];

const CPU_ENCODER = {
  codec: 'libx264',
  vendor: 'CPU (libx264)',
  preset: 'fast',
  presetFast: 'ultrafast',
  extraArgs: [],
};

/**
 * Detect TẤT CẢ GPU encoder khả dụng bằng cách:
 * 1. Chạy `ffmpeg -encoders` để lấy danh sách encoder được compile vào binary
 * 2. Thử encode 1 frame test với từng GPU encoder (xác nhận driver hoạt động)
 *
 * @param {string} ffmpegPath
 * @returns {Array<{ codec, vendor, preset, extraArgs, id }>}  Mảng các GPU khả dụng
 */
function detectAllGpuEncoders(ffmpegPath) {
  // Bước 1: lấy danh sách encoder compiled-in
  let encoderList = '';
  try {
    const result = spawnSync(ffmpegPath, ['-encoders', '-v', 'quiet'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    encoderList = (result.stdout || '') + (result.stderr || '');
  } catch (_) {
    console.log('[sysInfo] Không thể lấy danh sách encoder');
    return [];
  }

  const availableGpus = [];
  let gpuIndex = 0;

  // Bước 2: với mỗi GPU encoder có trong list, thử encode 1 frame
  for (const enc of GPU_ENCODERS) {
    if (!encoderList.includes(enc.codec)) {
      console.log(`[sysInfo] ${enc.codec} không có trong FFmpeg build`);
      continue;
    }

    console.log(`[sysInfo] Đang test ${enc.codec}...`);

    // Thử encode 1 frame siêu nhỏ và nhanh
    const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
    let testArgs = [
      '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1:d=0.1',
      '-frames:v', '1',
      '-c:v', enc.codec,
    ];

    // Thêm preset và parameters encoder-specific
    if (enc.codec === 'h264_nvenc') {
      testArgs.push('-preset', 'p1'); // fastest preset
      // Add NVIDIA-specific parameters for better compatibility
      testArgs.push('-rc', 'vbr', '-cq', '23');
    } else if (enc.codec === 'h264_amf') {
      testArgs.push('-preset', 'speed');
      // Add AMD-specific parameters
      testArgs.push('-quality', 'speed');
    } else if (enc.codec === 'h264_qsv') {
      testArgs.push('-preset', 'veryfast');
      // Add Intel-specific parameters
      testArgs.push('-look_ahead', '0');
    }

    testArgs.push('-f', 'null', nullOut, '-v', 'quiet');

    try {
      const test = spawnSync(ffmpegPath, testArgs, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'], // Capture stderr for debugging
      });
      
      // Log detailed error info for debugging
      if (test.status !== 0) {
        console.log(`[sysInfo] ✗ ${enc.vendor} test failed (exit ${test.status})`);
        if (test.stderr) {
          console.log(`[sysInfo]   stderr: ${test.stderr.substring(0, 200)}`);
        }
      }
      
      // Chỉ cần exit code 0 là đủ
      if (test.status === 0) {
        console.log(`[sysInfo] ✓ ${enc.vendor} khả dụng`);
        availableGpus.push({
          ...enc,
          id: `gpu-${gpuIndex}`,
          displayName: `${enc.vendor}`,
        });
        gpuIndex++;
      } else {
        console.log(`[sysInfo] ✗ ${enc.vendor} không khả dụng (exit ${test.status})`);
      }
    } catch (err) {
      console.log(`[sysInfo] ✗ ${enc.vendor} timeout hoặc lỗi: ${err.message}`);
    }
  }

  console.log(`[sysInfo] Tìm thấy ${availableGpus.length} GPU encoder khả dụng`);
  return availableGpus;
}

/**
 * Detect GPU encoder khả dụng (trả về GPU đầu tiên - backward compatibility)
 * @param {string} ffmpegPath
 * @returns {{ codec, vendor, preset, extraArgs } | null}  null = không có GPU
 */
function detectGpuEncoder(ffmpegPath) {
  const gpus = detectAllGpuEncoders(ffmpegPath);
  return gpus.length > 0 ? gpus[0] : null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Thu thập toàn bộ thông tin hệ thống cần thiết.
 * Hàm này chạy đồng bộ (blocking) nhưng chỉ gọi 1 lần lúc app khởi động.
 *
 * @param {string} ffmpegPath
 * @returns {{
 *   cpuModel:       string,
 *   logicalCores:   number,
 *   maxThreads:     number,
 *   defaultThreads: number,
 *   gpuEncoder:     { codec, vendor, preset, extraArgs } | null,
 *   platform:       string,
 * }}
 */
function getSysInfo(ffmpegPath) {
  const cpus = os.cpus();
  const availableGpus = detectAllGpuEncoders(ffmpegPath);
  const gpuEncoder = availableGpus.length > 0 ? availableGpus[0] : null;

  return {
    cpuModel: cpus[0]?.model || 'Unknown CPU',
    logicalCores: cpus.length,
    maxThreads: getMaxThreads(),
    defaultThreads: getDefaultThreads(),
    gpuEncoder,          // GPU đầu tiên (backward compatibility)
    availableGpus,       // Tất cả GPU khả dụng
    cpuEncoder: CPU_ENCODER,
    platform: process.platform,
  };
}

module.exports = { getSysInfo, getMaxThreads, getDefaultThreads, CPU_ENCODER, GPU_ENCODERS };
