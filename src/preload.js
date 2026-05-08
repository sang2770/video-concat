'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Folder / file helpers ──────────────────────────────────────────────────
  selectFolder:   ()           => ipcRenderer.invoke('select-folder'),
  getVideos:      (folder)     => ipcRenderer.invoke('get-videos', folder),
  getAudioFiles:  (folder)     => ipcRenderer.invoke('get-audio-files', folder),

  // ── System info ───────────────────────────────────────────────────────────
  getSysInfo:     ()           => ipcRenderer.invoke('get-sys-info'),

  // ── Job Queue ──────────────────────────────────────────────────────────────
  queueAdd:       (config)     => ipcRenderer.invoke('queue:add', config),
  queueCancel:    (jobId)      => ipcRenderer.invoke('queue:cancel', jobId),
  queueCancelAll: ()           => ipcRenderer.invoke('queue:cancel-all'),
  queueGetAll:    ()           => ipcRenderer.invoke('queue:get-all'),

  // ── Config ────────────────────────────────────────────────────────────────
  configGet:      ()        => ipcRenderer.invoke('config:get'),
  configSet:      (partial) => ipcRenderer.invoke('config:set', partial),

  // ── Queue events (main → renderer) ────────────────────────────────────────
  onJobAdded:     (cb) => ipcRenderer.on('queue:job-added',     (_, d) => cb(d)),
  onJobStarted:   (cb) => ipcRenderer.on('queue:job-started',   (_, d) => cb(d)),
  onJobProgress:  (cb) => ipcRenderer.on('queue:job-progress',  (_, d) => cb(d)),
  onJobDone:      (cb) => ipcRenderer.on('queue:job-done',      (_, d) => cb(d)),
  onJobError:     (cb) => ipcRenderer.on('queue:job-error',     (_, d) => cb(d)),
  onJobCancelled: (cb) => ipcRenderer.on('queue:job-cancelled', (_, d) => cb(d)),
});
