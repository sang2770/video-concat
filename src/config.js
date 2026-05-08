'use strict';

/**
 * config.js — đọc/ghi config người dùng vào file JSON.
 * Chạy trong main process, dùng app.getPath('userData') để lưu đúng chỗ:
 *   dev  : %APPDATA%\video-concat\config.json
 *   build: %APPDATA%\Video Concat\config.json
 */

const path = require('path');
const fs   = require('fs');

// Fields được phép lưu (whitelist — không lưu encoder/sysInfo)
const SAVEABLE_KEYS = [
  'videoFolder',
  'audioFolder',
  'outputFolder',
  'videoFormat',
  'videoBitrate',
  'audioCount',
  'targetDuration',
  'threadCount',
  'useGpu',
];

const DEFAULTS = {
  videoFolder:    null,
  audioFolder:    null,
  outputFolder:   null,
  videoFormat:    'mp4',
  videoBitrate:   5,
  audioCount:     5,
  targetDuration: 1259,   // 00:20:59
  threadCount:    2,
  useGpu:         true,
};

class ConfigStore {
  constructor(userDataPath) {
    this._file = path.join(userDataPath, 'config.json');
    this._data = { ...DEFAULTS };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this._file)) {
        const raw  = fs.readFileSync(this._file, 'utf-8');
        const parsed = JSON.parse(raw);
        // Chỉ lấy các key hợp lệ, bỏ qua key lạ
        for (const key of SAVEABLE_KEYS) {
          if (key in parsed) this._data[key] = parsed[key];
        }
      }
    } catch (_) {
      // File lỗi → dùng defaults, không crash
    }
  }

  get() {
    return { ...this._data };
  }

  set(partial) {
    for (const key of SAVEABLE_KEYS) {
      if (key in partial) this._data[key] = partial[key];
    }
    this._save();
  }

  _save() {
    try {
      const dir = path.dirname(this._file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (_) {}
  }
}

module.exports = { ConfigStore, DEFAULTS };
