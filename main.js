const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { VideoProcessor } = require('./src/videoProcessor');

let mainWindow;
let videoProcessor;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'src/preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('src/index.html');
  // mainWindow.webContents.openDevTools();
}

app.on('ready', () => {
  createWindow();
  videoProcessor = new VideoProcessor();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC Handlers
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0] || null;
});

ipcMain.handle('get-videos', async (event, folderPath) => {
  try {
    const files = fs.readdirSync(folderPath);
    const videoExtensions = ['.mp4', '.avi', '.mkv', '.mov', '.flv', '.wmv'];
    const videos = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return videoExtensions.includes(ext);
    });
    return videos;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('get-audio-files', async (event, folderPath) => {
  try {
    const files = fs.readdirSync(folderPath);
    const audioExtensions = ['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg'];
    const audios = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return audioExtensions.includes(ext);
    });
    return audios;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('process-videos', async (event, config) => {
  try {
    const result = await videoProcessor.processVideos(config, (progress) => {
      mainWindow.webContents.send('progress-update', progress);
    });
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('cancel-processing', async () => {
  videoProcessor.cancel();
  return { success: true };
});
