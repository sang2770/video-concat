'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const selectVideoFolderBtn = document.getElementById('selectVideoFolder');
const selectAudioFolderBtn = document.getElementById('selectAudioFolder');
const selectOutputFolderBtn = document.getElementById('selectOutputFolder');
const videoFolderPath = document.getElementById('videoFolderPath');
const audioFolderPath = document.getElementById('audioFolderPath');
const outputFolderPath = document.getElementById('outputFolderPath');
const videoFileList = document.getElementById('videoFileList');
const audioFileList = document.getElementById('audioFileList');
const videoFormat = document.getElementById('videoFormat');
const videoBitrate = document.getElementById('videoBitrate');
const audioCount = document.getElementById('audioCount');
const targetHH = document.getElementById('targetHH');
const targetMM = document.getElementById('targetMM');
const targetSS = document.getElementById('targetSS');
const targetHint = document.getElementById('targetHint');
const threadCount = document.getElementById('threadCount');
const addJobBtn = document.getElementById('addJobBtn');
const cancelAllBtn = document.getElementById('cancelAllBtn');
const resetBtn = document.getElementById('resetButton');
const statusMessage = document.getElementById('statusMessage');
const queueContainer = document.getElementById('queueContainer');
const queueList = document.getElementById('queueList');
const emptyQueue = document.getElementById('emptyQueue');
const useGpuToggle = document.getElementById('useGpuToggle');
const gpuEncoderBadge = document.getElementById('gpuEncoderBadge');
const gpuHint = document.getElementById('gpuHint');
const gpuSelector = document.getElementById('gpuSelector');
const threadCountLabel = document.getElementById('threadCountLabel');
const sysInfoCpuText = document.getElementById('sysInfoCpuText');
const sysInfoGpuText = document.getElementById('sysInfoGpuText');
const sysInfoThreadText = document.getElementById('sysInfoThreadText');

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

  // Load saved config → điền vào form
  const cfg = await window.api.configGet();
  applyConfig(cfg);

  // Restore jobs that were already in queue (e.g. after devtools reload)
  const existing = await window.api.queueGetAll();
  existing.forEach(job => upsertJobCard(job));
  updateQueueVisibility();
})();

function applySysInfo(info) {
  console.log('[renderer] applySysInfo called with:', info);
  if (!info) return;

  // CPU info
  sysInfoCpuText.textContent =
    `${info.cpuModel} · ${info.logicalCores} cores`;

  // Thread input: clamp max + set default
  threadCount.max = String(info.maxThreads);
  threadCount.value = String(info.defaultThreads);
  threadCountLabel.textContent = `(số video xử lý song song, tối đa ${info.maxThreads})`;
  sysInfoThreadText.textContent =
    `Luồng: mặc định ${info.defaultThreads} / tối đa ${info.maxThreads}`;

  // GPU info
  console.log('[renderer] availableGpus:', info.availableGpus);
  if (info.availableGpus && info.availableGpus.length > 0) {
    const gpus = info.availableGpus;
    console.log('[renderer] Found GPUs:', gpus);
    sysInfoGpuText.textContent = `GPU: ${gpus.length} encoder khả dụng`;
    gpuEncoderBadge.textContent = `${gpus.length} GPU`;
    gpuEncoderBadge.className = 'gpu-badge gpu-available';
    useGpuToggle.disabled = false;
    useGpuToggle.checked = true;

    // Populate GPU selector
    gpuSelector.innerHTML = '';
    gpus.forEach((gpu, index) => {
      const option = document.createElement('option');
      option.value = gpu.id;
      option.textContent = gpu.displayName;
      if (index === 0) option.selected = true;
      gpuSelector.appendChild(option);
      console.log('[renderer] Added GPU option:', gpu.displayName);
    });
    gpuSelector.disabled = false;

    gpuHint.textContent = `✅ Sẽ dùng ${gpus[0].codec} — encode nhanh hơn đáng kể`;
    gpuHint.className = 'gpu-hint gpu-hint-ok';
  } else {
    console.log('[renderer] No GPUs found');
    sysInfoGpuText.textContent = 'GPU: Không phát hiện encoder phần cứng';
    gpuEncoderBadge.textContent = 'Không có GPU';
    gpuEncoderBadge.className = 'gpu-badge gpu-none';
    useGpuToggle.disabled = true;
    useGpuToggle.checked = false;
    gpuSelector.disabled = true;
    gpuHint.textContent = 'Sẽ dùng libx264 (CPU)';
    gpuHint.className = 'gpu-hint';
  }
}

// ── Config load / save ────────────────────────────────────────────────────────

function applyConfig(cfg) {
  if (!cfg) return;

  // Folders
  if (cfg.videoFolder) { state.videoFolder = cfg.videoFolder; videoFolderPath.textContent = cfg.videoFolder; }
  if (cfg.audioFolder) { state.audioFolder = cfg.audioFolder; audioFolderPath.textContent = cfg.audioFolder; }
  if (cfg.outputFolder) { state.outputFolder = cfg.outputFolder; outputFolderPath.textContent = cfg.outputFolder; }

  // Reload file lists nếu folder đã lưu còn tồn tại
  if (cfg.videoFolder) window.api.getVideos(cfg.videoFolder).then(f => { if (!f.error) { state.videoFiles = f; renderFileList(videoFileList, f); } });
  if (cfg.audioFolder) window.api.getAudioFiles(cfg.audioFolder).then(f => { if (!f.error) { state.audioFiles = f; renderFileList(audioFileList, f); } });

  // Form fields
  if (cfg.videoFormat) videoFormat.value = cfg.videoFormat;
  if (cfg.videoBitrate) videoBitrate.value = String(cfg.videoBitrate);
  if (cfg.audioCount) audioCount.value = String(cfg.audioCount);

  // Target duration
  if (cfg.targetDuration > 0) {
    const h = Math.floor(cfg.targetDuration / 3600);
    const m = Math.floor((cfg.targetDuration % 3600) / 60);
    const s = cfg.targetDuration % 60;
    targetHH.value = String(h);
    targetMM.value = String(m);
    targetSS.value = String(s);
    updateTargetHint();
  }

  // threadCount — áp dụng sau applySysInfo để không bị ghi đè
  if (cfg.threadCount) {
    const maxT = state.sysInfo?.maxThreads || 16;
    threadCount.value = String(Math.max(1, Math.min(cfg.threadCount, maxT)));
  }

  // GPU toggle
  if (typeof cfg.useGpu === 'boolean' && !useGpuToggle.disabled) {
    useGpuToggle.checked = cfg.useGpu;
    // trigger hint update
    useGpuToggle.dispatchEvent(new Event('change'));
  }

  // GPU selection
  if (cfg.selectedGpuId && state.sysInfo?.availableGpus) {
    const gpuExists = state.sysInfo.availableGpus.find(g => g.id === cfg.selectedGpuId);
    if (gpuExists) {
      gpuSelector.value = cfg.selectedGpuId;
      // trigger hint update
      gpuSelector.dispatchEvent(new Event('change'));
    }
  }
}

// Debounce save — tránh ghi file liên tục khi user đang gõ
let _saveTimer = null;
function saveConfig() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.api.configSet({
      videoFolder: state.videoFolder,
      audioFolder: state.audioFolder,
      outputFolder: state.outputFolder,
      videoFormat: videoFormat.value,
      videoBitrate: parseInt(videoBitrate.value) || 5,
      audioCount: parseInt(audioCount.value) || 5,
      targetDuration: getTargetSeconds(),
      threadCount: parseInt(threadCount.value) || 2,
      useGpu: useGpuToggle.checked && !useGpuToggle.disabled,
      selectedGpuId: gpuSelector.value, // ID của GPU được chọn
    });
  }, 500);
}

// ── Cập nhật hint khi toggle GPU hoặc chọn GPU
useGpuToggle.addEventListener('change', () => {
  const info = state.sysInfo;
  if (!info) return;
  if (useGpuToggle.checked && info.availableGpus && info.availableGpus.length > 0) {
    const selectedGpuId = gpuSelector.value;
    const selectedGpu = info.availableGpus.find(g => g.id === selectedGpuId) || info.availableGpus[0];
    gpuHint.textContent = `✅ Sẽ dùng ${selectedGpu.codec} — encode nhanh hơn đáng kể`;
    gpuHint.className = 'gpu-hint gpu-hint-ok';
    gpuSelector.disabled = false;
  } else {
    gpuHint.textContent = 'Sẽ dùng libx264 (CPU)';
    gpuHint.className = 'gpu-hint';
    gpuSelector.disabled = true;
  }
  saveConfig();
});

// Cập nhật hint khi chọn GPU khác
gpuSelector.addEventListener('change', () => {
  const info = state.sysInfo;
  if (!info || !useGpuToggle.checked) return;
  const selectedGpuId = gpuSelector.value;
  const selectedGpu = info.availableGpus.find(g => g.id === selectedGpuId);
  if (selectedGpu) {
    gpuHint.textContent = `✅ Sẽ dùng ${selectedGpu.codec} — encode nhanh hơn đáng kể`;
    gpuHint.className = 'gpu-hint gpu-hint-ok';
  }
  saveConfig();
});

// Clamp thread input khi user nhập tay
threadCount.addEventListener('change', () => {
  const info = state.sysInfo;
  if (!info) return;
  const val = parseInt(threadCount.value) || 1;
  threadCount.value = String(Math.max(1, Math.min(val, info.maxThreads)));
  saveConfig();
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
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateTargetHint() {
  const secs = getTargetSeconds();
  if (secs <= 0) {
    targetHint.textContent = '⚠️ Thời lượng phải > 0';
    targetHint.className = 'target-hint target-hint-warn';
  } else {
    targetHint.textContent = `⏱️ ${formatHMS(secs)} = ${secs} giây`;
    targetHint.className = 'target-hint';
  }
}

[targetHH, targetMM, targetSS].forEach(el => {
  el.addEventListener('input', updateTargetHint);
  el.addEventListener('change', () => {
    const max = 59;
    el.value = el === targetHH ? String(Math.max(0, parseInt(el.value) || 0)) : String(Math.max(0, Math.min(max, parseInt(el.value) || 0)));
    updateTargetHint();
    saveConfig();
  });
});

// Save khi thay đổi các input số khác
[videoFormat, videoBitrate, audioCount].forEach(el => {
  el.addEventListener('change', saveConfig);
});

// ── Queue event listeners ─────────────────────────────────────────────────────
window.api.onJobAdded(job => { upsertJobCard(job); updateQueueVisibility(); });
window.api.onJobStarted(job => { upsertJobCard(job); });
window.api.onJobProgress(job => { upsertJobCard(job); });
window.api.onJobDone(job => {
  upsertJobCard(job);
  const msg = job.result?.completedVideos
    ? `✅ Job #${job.id} hoàn thành: ${job.result.completedVideos}/${job.result.totalVideos} video`
    : `✅ Job #${job.id} hoàn thành`;
  showStatus(msg, 'success');
});
window.api.onJobError(job => { upsertJobCard(job); showStatus(`❌ Job #${job.id} lỗi: ${job.error}`, 'error'); });
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
  saveConfig();
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
  saveConfig();
});

selectOutputFolderBtn.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  state.outputFolder = folder;
  outputFolderPath.textContent = folder;
  saveConfig();
});

// ── Add job ───────────────────────────────────────────────────────────────────
addJobBtn.addEventListener('click', async () => {
  const errors = validate();
  if (errors.length) return showStatus(errors.join('\n'), 'error');

  const config = {
    videoFolder: state.videoFolder,
    audioFolder: state.audioFolder,
    outputFolder: state.outputFolder,
    videoFormat: videoFormat.value,
    videoBitrate: parseInt(videoBitrate.value),
    audioCount: parseInt(audioCount.value),
    targetDuration: getTargetSeconds(),
    threadCount: parseInt(threadCount.value),
    useGpu: useGpuToggle.checked && !useGpuToggle.disabled,
    selectedGpuId: gpuSelector.value, // ID của GPU được chọn
  };

  const { jobId } = await window.api.queueAdd(config);
  showStatus(`📋 Đã thêm Job #${jobId} vào hàng đợi (${state.videoFiles.length} video sẽ được xử lý)`, 'info');
});

// ── Cancel all ────────────────────────────────────────────────────────────────
cancelAllBtn.addEventListener('click', async () => {
  await window.api.queueCancelAll();
});

// ── Reset form ────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  state.videoFolder = state.audioFolder = state.outputFolder = null;
  state.videoFiles = state.audioFiles = [];
  videoFolderPath.textContent = 'Chưa chọn';
  audioFolderPath.textContent = 'Chưa chọn';
  outputFolderPath.textContent = 'Chưa chọn';
  videoFileList.innerHTML = '';
  audioFileList.innerHTML = '';
  videoFormat.value = 'mp4';
  videoBitrate.value = '5';
  audioCount.value = '5';
  targetHH.value = '0';
  targetMM.value = '20';
  targetSS.value = '59';
  updateTargetHint();
  threadCount.value = '2';
  statusMessage.innerHTML = '';
});

// ── Validation ────────────────────────────────────────────────────────────────
function validate() {
  const errs = [];
  if (!state.videoFolder) errs.push('Vui lòng chọn thư mục video');
  if (!state.audioFolder) errs.push('Vui lòng chọn thư mục audio');
  if (!state.outputFolder) errs.push('Vui lòng chọn thư mục lưu kết quả');
  if (!state.videoFiles.length) errs.push('Thư mục video không chứa file video');
  if (!state.audioFiles.length) errs.push('Thư mục audio không chứa file audio');

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
  pending: '⏳ Đang chờ',
  running: '⚙️ Đang xử lý',
  done: '✅ Hoàn thành',
  error: '❌ Lỗi',
  cancelled: '🚫 Đã huỷ',
};

const STATUS_CLASS = {
  pending: 'job-pending',
  running: 'job-running',
  done: 'job-done',
  error: 'job-error',
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
  const pct = job.progress || 0;
  const label = STATUS_LABEL[job.status] || job.status;
  const cfg = job.config || {};

  // Hiển thị thông tin tasks nếu có
  let tasksHTML = '';
  if (job.tasks && job.tasks.length > 0) {
    tasksHTML = `
      <div class="job-tasks-summary">
        <strong>📊 Tiến độ:</strong> ${job.completedTasks || 0}/${job.totalTasks || 0} video hoàn thành
        ${job.failedTasks > 0 ? `<span class="task-failed">(${job.failedTasks} lỗi)</span>` : ''}
      </div>
    `;

    // Hiển thị chi tiết các task đang chạy
    const runningTasks = job.tasks.filter(t => t.status === 'running');
    if (runningTasks.length > 0) {
      tasksHTML += '<div class="job-tasks-detail">';
      runningTasks.forEach(task => {
        tasksHTML += `
          <div class="task-item">
            <span class="task-name">🎬 ${task.videoFile}</span>
            <span class="task-progress">${task.progress || 0}%</span>
            <div class="task-stage">${task.stage || ''}</div>
          </div>
        `;
      });
      tasksHTML += '</div>';
    }
  }

  // Hiển thị output files nếu hoàn thành
  let outputHTML = '';
  if (job.status === 'done' && job.result?.outputs && job.result.outputs.length > 0) {
    outputHTML = `
      <div class="job-outputs">
        <strong>📹 Output files (${job.result.outputs.length}):</strong>
        <div class="output-list">
          ${job.result.outputs.map(f => {
      const fileName = f.split(/[\\/]/).pop();
      return `<div class="output-item">${fileName}</div>`;
    }).join('')}
        </div>
      </div>
    `;
  }

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
    ${tasksHTML}
    <div class="job-progress-bar-wrap">
      <div class="job-progress-bar" style="width:${pct}%"></div>
    </div>
    <div class="job-progress-pct">${pct}%</div>
    ${outputHTML}
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
