const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getVideos: (folderPath) => ipcRenderer.invoke('get-videos', folderPath),
  getAudioFiles: (folderPath) => ipcRenderer.invoke('get-audio-files', folderPath),
  processVideos: (config) => ipcRenderer.invoke('process-videos', config),
  cancelProcessing: () => ipcRenderer.invoke('cancel-processing'),
  onProgressUpdate: (callback) => ipcRenderer.on('progress-update', (event, data) => callback(data))
});
