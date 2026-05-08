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

const os     = require('os');
const { spawnSync } = require('child_process');

// ── CPU threads ───────────────────────────────────────────────────────────────

/**
 * Trả về số thread tối đa nên dùng cho ffmpeg.
 * Giữ lại ít nhất 1 core cho hệ điều hành.
 * Giới hạn cứng: 16 (ffmpeg không benefit nhiều hơn).
 */
function getMaxThreads() {
  const logical = os.cpus().length;          // logical cores (hyperthreading)
  const safe    = Math.max(1, logical - 1);  // để lại 1 core cho OS
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
    codec:       'h264_nvenc',
    vendor:      'NVIDIA (NVENC)',
    preset:      'p4',       // balanced quality
    presetFast:  'p1',       // fastest (dùng khi chỉ cần append black screen)
    extraArgs:   ['-rc', 'vbr', '-cq', '23'],  // use CQ instead of cq 0
  },
  {
    codec:       'h264_amf',
    vendor:      'AMD (AMF/VCE)',
    preset:      'balanced',
    presetFast:  'speed',
    extraArgs:   [],
  },
  {
    codec:       'h264_qsv',
    vendor:      'Intel (Quick Sync)',
    preset:      null,           // QSV doesn't use standard presets
    presetFast:  null,           // use quality settings instead
    extraArgs:   ['-global_quality', '23'],  // use global_quality for QSV
  },
  {
    codec:       'h264_videotoolbox',
    vendor:      'Apple (VideoToolbox)',
    preset:      null,       // không có -preset
    presetFast:  null,
    extraArgs:   [],
  },
];

const CPU_ENCODER = {
  codec:      'libx264',
  vendor:     'CPU (libx264)',
  preset:     'fast',
  presetFast: 'ultrafast',
  extraArgs:  [],
};

/**
 * Detect GPU encoder khả dụng bằng cách:
 * 1. Chạy `ffmpeg -encoders` để lấy danh sách encoder được compile vào binary
 * 2. Thử encode 1 frame test với từng GPU encoder (xác nhận driver hoạt động)
 *
 * @param {string} ffmpegPath
 * @returns {{ codec, vendor, preset, extraArgs } | null}  null = không có GPU
 */
function detectGpuEncoder(ffmpegPath) {
  // Bước 1: lấy danh sách encoder compiled-in
  let encoderList = '';
  try {
    const result = spawnSync(ffmpegPath, ['-encoders', '-v', 'quiet'], {
      encoding: 'utf-8',
      timeout:  5000,
    });
    encoderList = (result.stdout || '') + (result.stderr || '');
  } catch (_) {
    return null;
  }

  // Bước 2: với mỗi GPU encoder có trong list, thử encode 1 frame
  for (const enc of GPU_ENCODERS) {
    if (!encoderList.includes(enc.codec)) continue;

    // Thử encode 1 frame null → /dev/null (hoặc NUL trên Windows)
    const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const testArgs = [
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1',
      '-frames:v', '1',
      '-c:v', enc.codec,
      '-f', 'null',
      nullOut,
      '-v', 'error',
    ];

    try {
      const test = spawnSync(ffmpegPath, testArgs, {
        encoding: 'utf-8',
        timeout:  8000,
      });
      // exit 0 và không có error output = encoder hoạt động
      if (test.status === 0 && !(test.stderr || '').toLowerCase().includes('error')) {
        return enc;
      }
    } catch (_) {
      // encoder này không dùng được, thử cái tiếp theo
    }
  }

  return null; // không có GPU encoder nào hoạt động
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
  const gpuEncoder = detectGpuEncoder(ffmpegPath);

  return {
    cpuModel:       cpus[0]?.model || 'Unknown CPU',
    logicalCores:   cpus.length,
    maxThreads:     getMaxThreads(),
    defaultThreads: getDefaultThreads(),
    gpuEncoder,          // null nếu không có GPU
    cpuEncoder:     CPU_ENCODER,
    platform:       process.platform,
  };
}

module.exports = { getSysInfo, getMaxThreads, getDefaultThreads, CPU_ENCODER, GPU_ENCODERS };
