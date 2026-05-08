'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { JobQueue }  = require('./src/jobQueue');
const { getSysInfo } = require('./src/sysInfo');
const { ffmpegPath } = require('./src/ffmpegPath');

let mainWindow;
let sysInfo = null;   // populated after app ready

const queue = new JobQueue({ concurrency: 1 });

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 960,
    webPreferences: {
      preload:            path.join(__dirname, 'src/preload.js'),
      contextIsolation:   true,
      nodeIntegration:    false,
      enableRemoteModule: false,
    }
  });

  mainWindow.loadFile('src/index.html');
  // mainWindow.webContents.openDevTools();
}

app.on('ready', () => {
  // Detect GPU + CPU info once at startup (blocking, ~1-3s)
  console.log('[main] Detecting system capabilities...');
  sysInfo = getSysInfo(ffmpegPath);
  console.log(`[main] CPU: ${sysInfo.cpuModel} (${sysInfo.logicalCores} cores, max ${sysInfo.maxThreads} threads)`);
  console.log(`[main] GPU encoder: ${sysInfo.gpuEncoder ? sysInfo.gpuEncoder.vendor : 'none (CPU fallback)'}`);

  createWindow();

  // Forward queue events → renderer
  const forward = (event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(event, data);
    }
  };

  queue.on('job-added',     d => forward('queue:job-added',     d));
  queue.on('job-started',   d => forward('queue:job-started',   d));
  queue.on('job-progress',  d => forward('queue:job-progress',  d));
  queue.on('job-done',      d => forward('queue:job-done',      d));
  queue.on('job-error',     d => forward('queue:job-error',     d));
  queue.on('job-cancelled', d => forward('queue:job-cancelled', d));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0] || null;
});

ipcMain.handle('get-videos', async (_, folderPath) => {
  try {
    const exts = new Set(['.mp4','.avi','.mkv','.mov','.flv','.wmv']);
    return fs.readdirSync(folderPath)
      .filter(f => exts.has(path.extname(f).toLowerCase()));
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-audio-files', async (_, folderPath) => {
  try {
    const exts = new Set(['.mp3','.wav','.aac','.flac','.m4a','.ogg']);
    return fs.readdirSync(folderPath)
      .filter(f => exts.has(path.extname(f).toLowerCase()));
  } catch (e) {
    return { error: e.message };
  }
});

// Trả về thông tin hệ thống cho renderer
ipcMain.handle('get-sys-info', async () => sysInfo);

// Thêm job vào queue → trả về jobId ngay lập tức
ipcMain.handle('queue:add', async (_, config) => {
  // Gắn encoder info vào config nếu renderer chọn dùng GPU
  // config.useGpu: boolean — renderer gửi lên
  const resolvedConfig = {
    ...config,
    // Truyền encoder object xuống worker
    encoder: config.useGpu && sysInfo?.gpuEncoder
      ? sysInfo.gpuEncoder
      : sysInfo?.cpuEncoder,
    // Clamp threadCount theo maxThreads của hệ thống
    threadCount: Math.min(
      config.threadCount || sysInfo?.defaultThreads || 2,
      sysInfo?.maxThreads || 16
    ),
  };
  const jobId = queue.add(resolvedConfig);
  return { jobId };
});

// Huỷ một job
ipcMain.handle('queue:cancel', async (_, jobId) => {
  queue.cancel(jobId);
  return { ok: true };
});

// Huỷ tất cả
ipcMain.handle('queue:cancel-all', async () => {
  queue.cancelAll();
  return { ok: true };
});

// Lấy danh sách jobs (để khôi phục UI khi reload)
ipcMain.handle('queue:get-all', async () => {
  return queue.getAll();
});
