/**
 * Job Queue — quản lý hàng đợi và spawn Worker Thread cho mỗi video input.
 *
 * Mỗi job sẽ tạo nhiều task (1 task = 1 video input1)
 * Mỗi task có trạng thái: pending → running → done | error | cancelled
 * Số task chạy song song = concurrency (số luồng)
 */

'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { ffmpegPath, ffprobePath } = require('./ffmpegPath');

// Trạng thái job/task
const STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

class JobQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.concurrency=1]  Số task chạy song song tối đa (mặc định 1)
   */
  constructor(opts = {}) {
    super();
    this.concurrency = opts.concurrency || 1;
    this._jobs = new Map();   // jobId → jobRecord
    this._tasks = new Map();   // taskId → taskRecord
    this._queue = [];          // pending taskIds (FIFO)
    this._running = new Set();   // taskIds đang chạy
    this._workers = new Map();   // taskId → Worker instance
    this._nextJobId = 1;
    this._nextTaskId = 1;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Thêm job vào queue - tạo nhiều task cho mỗi video input
   * @param {object} config  Cấu hình từ renderer (videoFolder, audioFolder, …)
   * @returns {string} jobId
   */
  add(config) {
    const jobId = String(this._nextJobId++);

    // Lấy danh sách video files
    const videoExts = new Set(['.mp4', '.avi', '.mkv', '.mov', '.flv', '.wmv']);
    const videoFiles = fs.readdirSync(config.videoFolder)
      .filter(f => videoExts.has(path.extname(f).toLowerCase()))
      .map(f => path.join(config.videoFolder, f))
      .sort();

    if (!videoFiles.length) {
      throw new Error('Không tìm thấy file video trong thư mục');
    }

    // Cập nhật concurrency theo threadCount từ config
    if (config.threadCount) {
      this.concurrency = config.threadCount;
    }

    // Tạo job record
    const jobRecord = {
      id: jobId,
      config,
      status: STATUS.PENDING,
      progress: 0,
      stage: 'Đang chuẩn bị...',
      result: null,
      error: null,
      createdAt: Date.now(),
      taskIds: [],
      totalTasks: videoFiles.length,
      completedTasks: 0,
      failedTasks: 0,
    };

    this._jobs.set(jobId, jobRecord);

    // Tạo task cho mỗi video
    videoFiles.forEach((videoFile, index) => {
      const taskId = `${jobId}-${this._nextTaskId++}`;
      const taskRecord = {
        id: taskId,
        jobId,
        videoFile,
        videoIndex: index,
        config: {
          ...config,
          videoFile,
        },
        status: STATUS.PENDING,
        progress: 0,
        stage: 'Đang chờ...',
        result: null,
        error: null,
        createdAt: Date.now(),
      };

      this._tasks.set(taskId, taskRecord);
      this._queue.push(taskId);
      jobRecord.taskIds.push(taskId);
    });

    this.emit('job-added', this._snapshotJob(jobRecord));
    this._tick();
    return jobId;
  }

  /**
   * Huỷ một job (huỷ tất cả task của job đó)
   * @param {string} jobId
   */
  cancel(jobId) {
    const jobRecord = this._jobs.get(jobId);
    if (!jobRecord) return;

    jobRecord.status = STATUS.CANCELLED;

    // Huỷ tất cả task của job này
    jobRecord.taskIds.forEach(taskId => {
      this._cancelTask(taskId);
    });

    this.emit('job-cancelled', this._snapshotJob(jobRecord));
  }

  /**
   * Huỷ một task
   * @param {string} taskId
   */
  _cancelTask(taskId) {
    const taskRecord = this._tasks.get(taskId);
    if (!taskRecord) return;

    if (taskRecord.status === STATUS.PENDING) {
      this._queue = this._queue.filter(id => id !== taskId);
      taskRecord.status = STATUS.CANCELLED;
      return;
    }

    if (taskRecord.status === STATUS.RUNNING) {
      const worker = this._workers.get(taskId);
      if (worker) {
        worker.postMessage('cancel');
        taskRecord.status = STATUS.CANCELLED;
        this._finalize(taskRecord);
      }
    }
  }

  /** Huỷ tất cả job */
  cancelAll() {
    for (const jobId of [...this._jobs.keys()]) {
      this.cancel(jobId);
    }
  }

  /** Trả về snapshot tất cả jobs (để render UI) */
  getAll() {
    return [...this._jobs.values()].map(r => this._snapshotJob(r));
  }

  /** Trả về snapshot một job */
  get(jobId) {
    const r = this._jobs.get(jobId);
    return r ? this._snapshotJob(r) : null;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _tick() {
    while (this._running.size < this.concurrency && this._queue.length > 0) {
      const taskId = this._queue.shift();
      const taskRecord = this._tasks.get(taskId);
      if (!taskRecord || taskRecord.status === STATUS.CANCELLED) continue;
      this._startTask(taskRecord);
    }
  }

  _startTask(taskRecord) {
    taskRecord.status = STATUS.RUNNING;
    this._running.add(taskRecord.id);

    // Cập nhật job status
    const jobRecord = this._jobs.get(taskRecord.jobId);
    if (jobRecord && jobRecord.status === STATUS.PENDING) {
      jobRecord.status = STATUS.RUNNING;
      this.emit('job-started', this._snapshotJob(jobRecord));
    }

    const workerPath = path.join(__dirname, 'singleVideoWorker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        task: {
          id: taskRecord.id,
          videoFile: taskRecord.videoFile,
          audioFolder: taskRecord.config.audioFolder,
          outputFolder: taskRecord.config.outputFolder,
          videoFormat: taskRecord.config.videoFormat,
          videoBitrate: taskRecord.config.videoBitrate,
          enableVideoBitrate: taskRecord.config.enableVideoBitrate,
          audioCount: taskRecord.config.audioCount,
          threadCount: taskRecord.config.threadCount,
          encoder: taskRecord.config.encoder,
          targetDuration: taskRecord.config.targetDuration,
        },
        ffmpegPath,
        ffprobePath,
      }
    });

    this._workers.set(taskRecord.id, worker);

    worker.on('message', msg => {
      const wasCancelled = taskRecord.status === STATUS.CANCELLED;

      switch (msg.type) {
        case 'progress':
          if (wasCancelled) return;
          taskRecord.progress = msg.progress;
          taskRecord.stage = msg.stage;
          this._updateJobProgress(taskRecord.jobId);
          break;

        case 'done':
          if (!wasCancelled) {
            taskRecord.status = STATUS.DONE;
            taskRecord.progress = 100;
            taskRecord.stage = 'Hoàn thành';
            taskRecord.result = msg.result;
            this._updateJobProgress(taskRecord.jobId);
          }
          this._finalize(taskRecord);
          break;

        case 'error':
          if (!wasCancelled) {
            taskRecord.status = STATUS.ERROR;
            taskRecord.error = msg.message;
            this._updateJobProgress(taskRecord.jobId);
          }
          this._finalize(taskRecord);
          break;
      }
    });

    worker.on('error', err => {
      if (taskRecord.status !== STATUS.CANCELLED) {
        taskRecord.status = STATUS.ERROR;
        taskRecord.error = err.message;
        this._updateJobProgress(taskRecord.jobId);
      }
      this._finalize(taskRecord);
    });

    worker.on('exit', () => {
      if (taskRecord.status === STATUS.RUNNING) {
        taskRecord.status = STATUS.CANCELLED;
      }
      this._finalize(taskRecord);
    });
  }

  _updateJobProgress(jobId) {
    const jobRecord = this._jobs.get(jobId);
    if (!jobRecord) return;

    const tasks = jobRecord.taskIds.map(id => this._tasks.get(id)).filter(Boolean);

    // Tính progress tổng
    const totalProgress = tasks.reduce((sum, t) => sum + (t.progress || 0), 0);
    jobRecord.progress = Math.floor(totalProgress / tasks.length);

    // Đếm task hoàn thành và lỗi
    jobRecord.completedTasks = tasks.filter(t => t.status === STATUS.DONE).length;
    jobRecord.failedTasks = tasks.filter(t => t.status === STATUS.ERROR).length;

    // Cập nhật stage
    const runningTasks = tasks.filter(t => t.status === STATUS.RUNNING);
    if (runningTasks.length > 0) {
      jobRecord.stage = `Đang xử lý ${runningTasks.length}/${jobRecord.totalTasks} video...`;
    }

    // Kiểm tra xem job đã hoàn thành chưa
    const finishedTasks = tasks.filter(t =>
      t.status === STATUS.DONE ||
      t.status === STATUS.ERROR ||
      t.status === STATUS.CANCELLED
    ).length;

    if (finishedTasks === jobRecord.totalTasks) {
      if (jobRecord.completedTasks === jobRecord.totalTasks) {
        jobRecord.status = STATUS.DONE;
        jobRecord.stage = 'Hoàn thành tất cả';
        jobRecord.result = {
          success: true,
          totalVideos: jobRecord.totalTasks,
          completedVideos: jobRecord.completedTasks,
          outputs: tasks.filter(t => t.result).map(t => t.result.outputFile),
        };
        this.emit('job-done', this._snapshotJob(jobRecord));
      } else if (jobRecord.completedTasks > 0) {
        jobRecord.status = STATUS.DONE;
        jobRecord.stage = `Hoàn thành ${jobRecord.completedTasks}/${jobRecord.totalTasks} video`;
        jobRecord.result = {
          success: true,
          totalVideos: jobRecord.totalTasks,
          completedVideos: jobRecord.completedTasks,
          failedVideos: jobRecord.failedTasks,
          outputs: tasks.filter(t => t.result).map(t => t.result.outputFile),
        };
        this.emit('job-done', this._snapshotJob(jobRecord));
      } else {
        jobRecord.status = STATUS.ERROR;
        jobRecord.error = 'Tất cả video đều xử lý thất bại';
        this.emit('job-error', this._snapshotJob(jobRecord));
      }
    } else {
      this.emit('job-progress', this._snapshotJob(jobRecord));
    }
  }

  _finalize(taskRecord) {
    if (!this._running.has(taskRecord.id)) return;
    this._running.delete(taskRecord.id);

    const worker = this._workers.get(taskRecord.id);
    if (worker) {
      worker.terminate().catch(() => { });
      this._workers.delete(taskRecord.id);
    }

    this._tick(); // chạy task tiếp theo nếu có
  }

  _snapshotJob(jobRecord) {
    const tasks = jobRecord.taskIds.map(id => {
      const t = this._tasks.get(id);
      return t ? {
        id: t.id,
        videoFile: path.basename(t.videoFile),
        status: t.status,
        progress: t.progress,
        stage: t.stage,
        error: t.error,
        result: t.result,
      } : null;
    }).filter(Boolean);

    return {
      id: jobRecord.id,
      status: jobRecord.status,
      progress: jobRecord.progress,
      stage: jobRecord.stage,
      result: jobRecord.result,
      error: jobRecord.error,
      createdAt: jobRecord.createdAt,
      config: jobRecord.config,
      totalTasks: jobRecord.totalTasks,
      completedTasks: jobRecord.completedTasks,
      failedTasks: jobRecord.failedTasks,
      tasks,
    };
  }
}

module.exports = { JobQueue, STATUS };
