/**
 * Job Queue — quản lý hàng đợi và spawn Worker Thread cho mỗi job.
 *
 * Mỗi job có trạng thái: pending → running → done | error | cancelled
 * Số job chạy song song = concurrency (mặc định 1, có thể tăng lên)
 */

'use strict';

const { Worker } = require('worker_threads');
const path       = require('path');
const EventEmitter = require('events');
const { ffmpegPath, ffprobePath } = require('./ffmpegPath');

// Trạng thái job
const STATUS = {
  PENDING:   'pending',
  RUNNING:   'running',
  DONE:      'done',
  ERROR:     'error',
  CANCELLED: 'cancelled',
};

class JobQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.concurrency=1]  Số job chạy song song tối đa
   */
  constructor(opts = {}) {
    super();
    this.concurrency = opts.concurrency || 1;
    this._jobs    = new Map();   // jobId → jobRecord
    this._queue   = [];          // pending jobIds (FIFO)
    this._running = new Set();   // jobIds đang chạy
    this._workers = new Map();   // jobId → Worker instance
    this._nextId  = 1;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Thêm job vào queue.
   * @param {object} config  Cấu hình từ renderer (videoFolder, audioFolder, …)
   * @returns {string} jobId
   */
  add(config) {
    const jobId = String(this._nextId++);
    const record = {
      id:        jobId,
      config,
      status:    STATUS.PENDING,
      progress:  0,
      stage:     'Đang chờ...',
      result:    null,
      error:     null,
      createdAt: Date.now(),
    };
    this._jobs.set(jobId, record);
    this._queue.push(jobId);

    this.emit('job-added', this._snapshot(record));
    this._tick();
    return jobId;
  }

  /**
   * Huỷ một job (nếu đang pending → xoá khỏi queue; nếu running → kill worker)
   * @param {string} jobId
   */
  cancel(jobId) {
    const record = this._jobs.get(jobId);
    if (!record) return;

    if (record.status === STATUS.PENDING) {
      this._queue = this._queue.filter(id => id !== jobId);
      record.status = STATUS.CANCELLED;
      this.emit('job-cancelled', this._snapshot(record));
      return;
    }

    if (record.status === STATUS.RUNNING) {
      const worker = this._workers.get(jobId);
      if (worker) {
        worker.postMessage('cancel');
        // Worker sẽ tự gửi error/done sau khi bị kill
        // Ta đánh dấu cancelled ngay để UI phản hồi nhanh
        record.status = STATUS.CANCELLED;
        this.emit('job-cancelled', this._snapshot(record));
      }
    }
  }

  /** Huỷ tất cả job */
  cancelAll() {
    for (const jobId of [...this._queue]) this.cancel(jobId);
    for (const jobId of [...this._running]) this.cancel(jobId);
  }

  /** Trả về snapshot tất cả jobs (để render UI) */
  getAll() {
    return [...this._jobs.values()].map(r => this._snapshot(r));
  }

  /** Trả về snapshot một job */
  get(jobId) {
    const r = this._jobs.get(jobId);
    return r ? this._snapshot(r) : null;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _tick() {
    while (this._running.size < this.concurrency && this._queue.length > 0) {
      const jobId = this._queue.shift();
      const record = this._jobs.get(jobId);
      if (!record || record.status === STATUS.CANCELLED) continue;
      this._startJob(record);
    }
  }

  _startJob(record) {
    record.status = STATUS.RUNNING;
    this._running.add(record.id);
    this.emit('job-started', this._snapshot(record));

    const workerPath = path.join(__dirname, 'worker.js');

    const worker = new Worker(workerPath, {
      workerData: {
        job: { ...record.config, id: record.id },
        ffmpegPath,
        ffprobePath,
      }
    });

    this._workers.set(record.id, worker);

    worker.on('message', msg => {
      if (record.status === STATUS.CANCELLED) return; // ignore after cancel

      switch (msg.type) {
        case 'progress':
          record.progress = msg.progress;
          record.stage    = msg.stage;
          this.emit('job-progress', this._snapshot(record));
          break;

        case 'done':
          record.status   = STATUS.DONE;
          record.progress = 100;
          record.stage    = 'Hoàn thành';
          record.result   = msg.result;
          this._finalize(record);
          this.emit('job-done', this._snapshot(record));
          break;

        case 'error':
          record.status = STATUS.ERROR;
          record.error  = msg.message;
          this._finalize(record);
          this.emit('job-error', this._snapshot(record));
          break;
      }
    });

    worker.on('error', err => {
      if (record.status !== STATUS.CANCELLED) {
        record.status = STATUS.ERROR;
        record.error  = err.message;
        this.emit('job-error', this._snapshot(record));
      }
      this._finalize(record);
    });

    worker.on('exit', () => {
      // Nếu worker bị kill (cancel), đảm bảo cleanup
      if (record.status === STATUS.RUNNING) {
        record.status = STATUS.CANCELLED;
        this.emit('job-cancelled', this._snapshot(record));
      }
      this._finalize(record);
    });
  }

  _finalize(record) {
    this._running.delete(record.id);
    this._workers.delete(record.id);
    this._tick(); // chạy job tiếp theo nếu có
  }

  _snapshot(record) {
    return {
      id:        record.id,
      status:    record.status,
      progress:  record.progress,
      stage:     record.stage,
      result:    record.result,
      error:     record.error,
      createdAt: record.createdAt,
      config:    record.config,
    };
  }
}

module.exports = { JobQueue, STATUS };
