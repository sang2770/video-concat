/**
 * Resolve đường dẫn ffmpeg/ffprobe đúng cả khi dev lẫn khi build ra .exe
 *
 * Ưu tiên:
 *  1. runtime/ bên cạnh app (portable / dev)
 *  2. runtime/ bên trong asar-unpacked (electron-builder extraResources)
 *  3. Fallback: system PATH
 */

const path = require('path');
const fs   = require('fs');

function getAppRoot() {
  // Khi đã build: process.resourcesPath trỏ tới thư mục resources bên trong .exe
  // Khi dev: __dirname là src/, nên lùi lên 1 cấp
  if (process.resourcesPath) {
    return process.resourcesPath;
  }
  return path.join(__dirname, '..');
}

function resolveRuntime(bin) {
  const exe = process.platform === 'win32' ? `${bin}.exe` : bin;

  const candidates = [
    // 1. runtime/ cạnh main.js (dev + portable)
    path.join(getAppRoot(), '..', 'runtime', exe),
    // 2. extraResources khi build (resources/runtime/)
    path.join(getAppRoot(), 'runtime', exe),
    // 3. Thư mục runtime/ cạnh file này (fallback dev)
    path.join(__dirname, '..', 'runtime', exe),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }

  // Fallback: để fluent-ffmpeg tự tìm trên PATH
  return bin;
}

const ffmpegPath  = resolveRuntime('ffmpeg');
const ffprobePath = resolveRuntime('ffprobe');

module.exports = { ffmpegPath, ffprobePath };
