'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const selectVideoFolderBtn = document.getElementById('selectVideoFolder');
const selectAudioFolderBtn = document.getElementById('selectAudioFolder');
const selectOutputFolderBtn = document.getElementById('selectOutputFolder');
const videoFolderPath  = document.getElementById('videoFolderPath');
const audioFolderPath  = document.getElementById('audioFolderPath');
const outputFolderPath = document.getElementById('outputFolderPath');
const videoFileList    = document.getElementById('videoFileList');
const audioFileList    = document.getElementById('audioFileList');
const videoFormat      = document.getElementById('videoFormat');
const videoBitrate     = document.getElementById('videoBitrate');
const audioCount       = document.getElementById('audioCount');
const targetHH         = document.getElementById('targetHH');
const targetMM         = document.getElementById('targetMM');
const targetSS         = document.getElementById('targetSS');
const targetHint       = document.getElementById('targetHint');
const threadCount      = document.getElementById('threadCount');
const addJobBtn        = document.getElementById('addJobBtn');
const cancelAllBtn     = document.getElementById('cancelAllBtn');
const resetBtn         = document.getElementById('resetButton');
const statusMessage    = document.getElementById('statusMessage');
const queueContainer   = document.getElementById('queueContainer');
const queueList        = document.getElementById('queueList');
const emptyQueue       = document.getElementById('emptyQueue');
const useGpuToggle     = document.getElementById('useGpuToggle');
const gpuEncoderBadge  = document.getElementById('gpuEncoderBadge');
const gpuHint          = document.getElementById('gpuHint');
const threadCountLabel = document.getElementById('threadCountLabel');
const sysInfoCpuText   = document.getElementById('sysInfoCpuText');
const sysInfoGpuText   = document.getElementById('sysInfoGpuText');
const sysInfoThreadText= document.getElementById('sysInfoThreadText');

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  videoFolder: null,
  audioFolder: null,
  outputFolder: null,
  videoFiles: [],
  audioFiles: [],
  sysInfo: null,
};

// jobId → { el, data }
const jobCards = new Map();

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  // Load system info
  const info = await window.api.getSysInfo();
  state.sysInfo = info;
  applySysInfo(info);

  // Restore jobs that were already in queue (e.g. after devtools reload)
  const existing = await window.api.queueGetAll();
  existing.forEach(job => upsertJobCard(job));
  updateQueueVisibility();
})();

function applySysInfo(info) {
  if (!info) return;

  // CPU info
  sysInfoCpuText.textContent =
    `${info.cpuModel} · ${info.logicalCores} cores`;

  // Thread input: clamp max + set default
  threadCount.max   = String(info.maxThreads);
  threadCount.value = String(info.defaultThreads);
  threadCountLabel.textContent = `(tối đa ${info.maxThreads} theo hệ thống)`;
  sysInfoThreadText.textContent =
    `Threads: mặc định ${info.defaultThreads} / tối đa ${info.maxThreads}`;

  // GPU info
  if (info.gpuEncoder) {
    const enc = info.gpuEncoder;
    sysInfoGpuText.textContent = `GPU: ${enc.vendor} (${enc.codec})`;
    gpuEncoderBadge.textContent = enc.vendor;
    gpuEncoderBadge.className   = 'gpu-badge gpu-available';
    useGpuToggle.disabled       = false;
    useGpuToggle.checked        = true;   // bật GPU mặc định nếu có
    gpuHint.textContent         = `✅ Sẽ dùng ${enc.codec} — encode nhanh hơn đáng kể`;
    gpuHint.className           = 'gpu-hint gpu-hint-ok';
  } else {
    sysInfoGpuText.textContent = 'GPU: Không phát hiện encoder phần cứng';
    gpuEncoderBadge.textContent = 'Không có GPU';
    gpuEncoderBadge.className   = 'gpu-badge gpu-none';
    useGpuToggle.disabled       = true;
    useGpuToggle.checked        = false;
    gpuHint.textContent         = 'Sẽ dùng libx264 (CPU)';
    gpuHint.className           = 'gpu-hint';
  }
}

// Cập nhật hint khi toggle GPU
useGpuToggle.addEventListener('change', () => {
  const info = state.sysInfo;
  if (!info) return;
  if (useGpuToggle.checked && info.gpuEncoder) {
    gpuHint.textContent = `✅ Sẽ dùng ${info.gpuEncoder.codec} — encode nhanh hơn đáng kể`;
    gpuHint.className   = 'gpu-hint gpu-hint-ok';
  } else {
    gpuHint.textContent = 'Sẽ dùng libx264 (CPU)';
    gpuHint.className   = 'gpu-hint';
  }
});

// Clamp thread input khi user nhập tay
threadCount.addEventListener('change', () => {
  const info = state.sysInfo;
  if (!info) return;
  const val = parseInt(threadCount.value) || 1;
  threadCount.value = String(Math.max(1, Math.min(val, info.maxThreads)));
});

// ── Target duration helpers ───────────────────────────────────────────────────

function getTargetSeconds() {
  const h = Math.max(0, parseInt(targetHH.value) || 0);
  const m = Math.max(0, Math.min(59, parseInt(targetMM.value) || 0));
  const s = Math.max(0, Math.min(59, parseInt(targetSS.value) || 0));
  return h * 3600 + m * 60 + s;
}

function formatHMS(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function updateTargetHint() {
  const secs = getTargetSeconds();
  if (secs <= 0) {
    targetHint.textContent = '⚠️ Thời lượng phải > 0';
    targetHint.className   = 'target-hint target-hint-warn';
  } else {
    targetHint.textContent = `⏱️ ${formatHMS(secs)} = ${secs} giây`;
    targetHint.className   = 'target-hint';
  }
}

[targetHH, targetMM, targetSS].forEach(el => {
  el.addEventListener('input', updateTargetHint);
  el.addEventListener('change', () => {
    // clamp on blur/change
    const max = el === targetHH ? 23 : 59;
    el.value  = String(Math.max(0, Math.min(max, parseInt(el.value) || 0)));
    updateTargetHint();
  });
});

// ── Queue event listeners ─────────────────────────────────────────────────────
window.api.onJobAdded(    job => { upsertJobCard(job); updateQueueVisibility(); });
window.api.onJobStarted(  job => { upsertJobCard(job); });
window.api.onJobProgress( job => { upsertJobCard(job); });
window.api.onJobDone(     job => { upsertJobCard(job); showStatus(`✅ Job #${job.id} hoàn thành: ${job.result?.outputFile || ''}`, 'success'); });
window.api.onJobError(    job => { upsertJobCard(job); showStatus(`❌ Job #${job.id} lỗi: ${job.error}`, 'error'); });
window.api.onJobCancelled(job => { upsertJobCard(job); });

// ── Folder selection ──────────────────────────────────────────────────────────
selectVideoFolderBtn.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  state.videoFolder = folder;
  videoFolderPath.textContent = folder;
  const files = await window.api.getVideos(folder);
  if (files.error) return showStatus(`Lỗi: ${files.error}`, 'error');
  state.videoFiles = files;
  renderFileList(videoFileList, files);
});

selectAudioFolderBtn.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  state.audioFolder = folder;
  audioFolderPath.textContent = folder;
  const files = await window.api.getAudioFiles(folder);
  if (files.error) return showStatus(`Lỗi: ${files.error}`, 'error');
  state.audioFiles = files;
  renderFileList(audioFileList, files);
});

selectOutputFolderBtn.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  state.outputFolder = folder;
  outputFolderPath.textContent = folder;
});

// ── Add job ───────────────────────────────────────────────────────────────────
addJobBtn.addEventListener('click', async () => {
  const errors = validate();
  if (errors.length) return showStatus(errors.join('\n'), 'error');

  const config = {
    videoFolder:    state.videoFolder,
    audioFolder:    state.audioFolder,
    outputFolder:   state.outputFolder,
    videoFormat:    videoFormat.value,
    videoBitrate:   parseInt(videoBitrate.value),
    audioCount:     parseInt(audioCount.value),
    targetDuration: getTargetSeconds(),
    threadCount:    parseInt(threadCount.value),
    useGpu:         useGpuToggle.checked && !useGpuToggle.disabled,
  };

  const { jobId } = await window.api.queueAdd(config);
  showStatus(`📋 Đã thêm Job #${jobId} vào hàng đợi`, 'info');
});

// ── Cancel all ────────────────────────────────────────────────────────────────
cancelAllBtn.addEventListener('click', async () => {
  await window.api.queueCancelAll();
});

// ── Reset form ────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  state.videoFolder = state.audioFolder = state.outputFolder = null;
  state.videoFiles  = state.audioFiles  = [];
  videoFolderPath.textContent  = 'Chưa chọn';
  audioFolderPath.textContent  = 'Chưa chọn';
  outputFolderPath.textContent = 'Chưa chọn';
  videoFileList.innerHTML = '';
  audioFileList.innerHTML = '';
  videoFormat.value   = 'mp4';
  videoBitrate.value  = '5';
  audioCount.value    = '5';
  targetHH.value      = '0';
  targetMM.value      = '20';
  targetSS.value      = '59';
  updateTargetHint();
  threadCount.value   = '2';
  statusMessage.innerHTML = '';
});

// ── Validation ────────────────────────────────────────────────────────────────
function validate() {
  const errs = [];
  if (!state.videoFolder)        errs.push('Vui lòng chọn thư mục video');
  if (!state.audioFolder)        errs.push('Vui lòng chọn thư mục audio');
  if (!state.outputFolder)       errs.push('Vui lòng chọn thư mục lưu kết quả');
  if (!state.videoFiles.length)  errs.push('Thư mục video không chứa file video');
  if (!state.audioFiles.length)  errs.push('Thư mục audio không chứa file audio');

  const br = parseInt(videoBitrate.value);
  if (isNaN(br) || br < 1 || br > 50) errs.push('Bitrate phải từ 1–50 Mbps');

  const ac = parseInt(audioCount.value);
  if (isNaN(ac) || ac < 1) errs.push('Số lượng bài hát phải ≥ 1');

  const target = getTargetSeconds();
  if (target <= 0) errs.push('Thời lượng video output phải > 0');

  const tc = parseInt(threadCount.value);
  const maxT = state.sysInfo?.maxThreads || 16;
  if (isNaN(tc) || tc < 1 || tc > maxT) errs.push(`Số luồng phải từ 1–${maxT}`);

  return errs;
}

// ── Job card UI ───────────────────────────────────────────────────────────────
const STATUS_LABEL = {
  pending:   '⏳ Đang chờ',
  running:   '⚙️ Đang xử lý',
  done:      '✅ Hoàn thành',
  error:     '❌ Lỗi',
  cancelled: '🚫 Đã huỷ',
};

const STATUS_CLASS = {
  pending:   'job-pending',
  running:   'job-running',
  done:      'job-done',
  error:     'job-error',
  cancelled: 'job-cancelled',
};

function upsertJobCard(job) {
  let entry = jobCards.get(job.id);

  if (!entry) {
    const el = document.createElement('div');
    el.className = 'job-card';
    el.dataset.jobId = job.id;
    el.innerHTML = buildCardHTML(job);
    queueList.appendChild(el);

    // Cancel button inside card
    el.querySelector('.job-cancel-btn')?.addEventListener('click', () => {
      window.api.queueCancel(job.id);
    });

    entry = { el, data: job };
    jobCards.set(job.id, entry);
  } else {
    entry.data = job;
    entry.el.innerHTML = buildCardHTML(job);
    entry.el.querySelector('.job-cancel-btn')?.addEventListener('click', () => {
      window.api.queueCancel(job.id);
    });
  }

  // Update card class
  entry.el.className = `job-card ${STATUS_CLASS[job.status] || ''}`;
  updateQueueVisibility();
}

function buildCardHTML(job) {
  const canCancel = job.status === 'pending' || job.status === 'running';
  const pct       = job.progress || 0;
  const label     = STATUS_LABEL[job.status] || job.status;
  const cfg       = job.config || {};

  return `
    <div class="job-header">
      <span class="job-id">Job #${job.id}</span>
      <span class="job-status-badge ${STATUS_CLASS[job.status]}">${label}</span>
      ${canCancel ? `<button class="job-cancel-btn btn-danger">Huỷ</button>` : ''}
    </div>
    <div class="job-meta">
      <span>📁 ${shortPath(cfg.videoFolder)}</span>
      <span>🎵 ${shortPath(cfg.audioFolder)}</span>
      <span>💾 ${shortPath(cfg.outputFolder)}</span>
      <span>⏱️ ${cfg.targetDuration ? formatHMS(cfg.targetDuration) : '—'}</span>
      <span class="job-encoder-badge ${cfg.encoder?.codec !== 'libx264' ? 'gpu' : 'cpu'}">
        ${cfg.encoder?.codec !== 'libx264' ? '🎮' : '🖥️'} ${cfg.encoder?.vendor || 'libx264'}
      </span>
    </div>
    <div class="job-stage">${job.stage || ''}</div>
    <div class="job-progress-bar-wrap">
      <div class="job-progress-bar" style="width:${pct}%"></div>
    </div>
    <div class="job-progress-pct">${pct}%</div>
    ${job.status === 'done' && job.result?.outputFile
      ? `<div class="job-output">📹 ${job.result.outputFile}</div>`
      : ''}
    ${job.status === 'error'
      ? `<div class="job-error-msg">⚠️ ${job.error}</div>`
      : ''}
  `;
}

function shortPath(p) {
  if (!p) return '—';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

function updateQueueVisibility() {
  const hasJobs = jobCards.size > 0;
  queueContainer.classList.toggle('hidden', !hasJobs);
  emptyQueue.classList.toggle('hidden', hasJobs);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function renderFileList(container, files) {
  container.innerHTML = '';
  if (!files.length) {
    container.innerHTML = '<div class="file-item">Không tìm thấy file</div>';
    return;
  }
  files.forEach(f => {
    const d = document.createElement('div');
    d.className = 'file-item';
    d.textContent = f;
    container.appendChild(d);
  });
}

function showStatus(msg, type) {
  statusMessage.innerHTML = `<div class="status-message status-${type}">${msg}</div>`;
}

console.log('Renderer initialized');
