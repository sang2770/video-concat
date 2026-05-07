// DOM Elements
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
const threadCount = document.getElementById('threadCount');
const startButton = document.getElementById('startButton');
const resetButton = document.getElementById('resetButton');
const cancelButton = document.getElementById('cancelButton');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressStage = document.getElementById('progressStage');
const progressPercentage = document.getElementById('progressPercentage');
const statusMessage = document.getElementById('statusMessage');
const actionButtons = document.getElementById('actionButtons');

// State
let state = {
  videoFolder: null,
  audioFolder: null,
  outputFolder: null,
  videoFiles: [],
  audioFiles: [],
  isProcessing: false
};

// Event Listeners
selectVideoFolderBtn.addEventListener('click', selectVideoFolder);
selectAudioFolderBtn.addEventListener('click', selectAudioFolder);
selectOutputFolderBtn.addEventListener('click', selectOutputFolder);
startButton.addEventListener('click', startProcessing);
resetButton.addEventListener('click', resetForm);
cancelButton.addEventListener('click', cancelProcessing);

// Folder Selection Functions
async function selectVideoFolder() {
  const folder = await window.api.selectFolder();
  if (folder) {
    state.videoFolder = folder;
    videoFolderPath.textContent = folder;
    await loadVideoFiles(folder);
  }
}

async function selectAudioFolder() {
  const folder = await window.api.selectFolder();
  if (folder) {
    state.audioFolder = folder;
    audioFolderPath.textContent = folder;
    await loadAudioFiles(folder);
  }
}

async function selectOutputFolder() {
  const folder = await window.api.selectFolder();
  if (folder) {
    state.outputFolder = folder;
    outputFolderPath.textContent = folder;
  }
}

async function loadVideoFiles(folder) {
  const files = await window.api.getVideos(folder);
  if (files.error) {
    showStatus(`Lỗi: ${files.error}`, 'error');
    return;
  }
  state.videoFiles = files;
  displayFileList(videoFileList, files);
}

async function loadAudioFiles(folder) {
  const files = await window.api.getAudioFiles(folder);
  if (files.error) {
    showStatus(`Lỗi: ${files.error}`, 'error');
    return;
  }
  state.audioFiles = files;
  displayFileList(audioFileList, files);
}

function displayFileList(container, files) {
  container.innerHTML = '';
  if (files.length === 0) {
    container.innerHTML = '<div class="file-item">Không tìm thấy file</div>';
    return;
  }
  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.textContent = file;
    container.appendChild(item);
  });
}

// Validation
function validateInputs() {
  const errors = [];

  if (!state.videoFolder) {
    errors.push('Vui lòng chọn thư mục video');
  }
  if (!state.audioFolder) {
    errors.push('Vui lòng chọn thư mục audio');
  }
  if (!state.outputFolder) {
    errors.push('Vui lòng chọn thư mục lưu kết quả');
  }
  if (state.videoFiles.length === 0) {
    errors.push('Thư mục video không chứa file video');
  }
  if (state.audioFiles.length === 0) {
    errors.push('Thư mục audio không chứa file audio');
  }

  const bitrate = parseInt(videoBitrate.value);
  if (isNaN(bitrate) || bitrate < 1 || bitrate > 50) {
    errors.push('Bitrate phải từ 1 đến 50 Mbps');
  }

  const count = parseInt(audioCount.value);
  if (isNaN(count) || count < 1) {
    errors.push('Số lượng bài hát phải >= 1');
  }

  const threads = parseInt(threadCount.value);
  if (isNaN(threads) || threads < 1 || threads > 16) {
    errors.push('Số luồng phải từ 1 đến 16');
  }

  return errors;
}

// Processing
async function startProcessing() {
  const errors = validateInputs();
  if (errors.length > 0) {
    showStatus(errors.join('\n'), 'error');
    return;
  }

  state.isProcessing = true;
  progressSection.classList.remove('hidden');
  actionButtons.classList.add('hidden');
  statusMessage.innerHTML = '';

  const config = {
    videoFolder: state.videoFolder,
    audioFolder: state.audioFolder,
    outputFolder: state.outputFolder,
    videoFormat: videoFormat.value,
    videoBitrate: parseInt(videoBitrate.value),
    audioCount: parseInt(audioCount.value),
    threadCount: parseInt(threadCount.value)
  };

  // Listen for progress updates
  window.api.onProgressUpdate((data) => {
    updateProgress(data);
  });

  // Start processing
  const result = await window.api.processVideos(config);

  state.isProcessing = false;

  if (result.cancelled) {
    showStatus('Đã hủy xử lý', 'info');
  } else if (result.error) {
    showStatus(`Lỗi: ${result.error}`, 'error');
  } else if (result.success) {
    const noteFile = result.outputFile.replace(/\.[^.]+$/, '.txt');
    showStatus(`✅ Thành công!\n📹 Video: ${result.outputFile}\n📝 File note: ${noteFile}`, 'success');
  }

  progressSection.classList.add('hidden');
  actionButtons.classList.remove('hidden');
}

function updateProgress(data) {
  const { stage, progress } = data;
  progressStage.textContent = stage;
  progressPercentage.textContent = `${progress}%`;
  progressBar.style.width = `${progress}%`;
}

async function cancelProcessing() {
  if (state.isProcessing) {
    await window.api.cancelProcessing();
    state.isProcessing = false;
    progressSection.classList.add('hidden');
    actionButtons.classList.remove('hidden');
    showStatus('Đã hủy xử lý', 'info');
  }
}

function resetForm() {
  state = {
    videoFolder: null,
    audioFolder: null,
    outputFolder: null,
    videoFiles: [],
    audioFiles: [],
    isProcessing: false
  };

  videoFolderPath.textContent = 'Chưa chọn';
  audioFolderPath.textContent = 'Chưa chọn';
  outputFolderPath.textContent = 'Chưa chọn';
  videoFileList.innerHTML = '';
  audioFileList.innerHTML = '';
  videoFormat.value = 'mp4';
  videoBitrate.value = '5';
  audioCount.value = '5';
  threadCount.value = '2';
  statusMessage.innerHTML = '';
  progressSection.classList.add('hidden');
  actionButtons.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressPercentage.textContent = '0%';
  progressStage.textContent = 'Chuẩn bị...';
}

function showStatus(message, type) {
  statusMessage.innerHTML = `<div class="status-message status-${type}">${message}</div>`;
}

// Initialize
console.log('Renderer process initialized');
