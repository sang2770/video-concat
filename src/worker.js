/**
 * Worker Thread — chạy một job ffmpeg độc lập.
 *
 * workerData: { job, ffmpegPath, ffprobePath }
 *   job.encoder = { codec, vendor, preset, extraArgs }  ← từ sysInfo
 *   job.threadCount = number (đã clamp theo maxThreads)
 *
 * Messages → parentPort:
 *   { type: 'progress', jobId, stage, progress }
 *   { type: 'done',     jobId, result }
 *   { type: 'error',    jobId, message }
 */

'use strict';

const { workerData, parentPort } = require('worker_threads');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');

const { job, ffmpegPath, ffprobePath } = workerData;

// ─── helpers ─────────────────────────────────────────────────────────────────

function send(msg)              { parentPort.postMessage(msg); }
function progress(stage, pct)  { send({ type: 'progress', jobId: job.id, stage, progress: pct }); }

function parseTimeToSeconds(t) {
  if (!t) return 0;
  const p = t.split(':');
  return (parseFloat(p[0]) || 0) * 3600
       + (parseFloat(p[1]) || 0) * 60
       + (parseFloat(p[2]) || 0);
}

function formatTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// ─── ffprobe ──────────────────────────────────────────────────────────────────

function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', filePath
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe error: ${err}`));
      try   { resolve(parseFloat(JSON.parse(out).format.duration) || 0); }
      catch (e) { reject(new Error(`ffprobe parse: ${e.message}`)); }
    });
    proc.on('error', reject);
  });
}

// ─── ffmpeg ───────────────────────────────────────────────────────────────────

let activeProc = null;

parentPort.on('message', msg => {
  if (msg === 'cancel' && activeProc) {
    try { activeProc.kill('SIGKILL'); } catch (_) {}
  }
});

function runFFmpeg(args, targetDuration, progressOffset, progressRange) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    activeProc = proc;

    let stderr = '';
    proc.stderr.on('data', chunk => {
      const line = chunk.toString();
      stderr += line;
      const m = line.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (m && targetDuration > 0) {
        const pct    = Math.min(parseTimeToSeconds(m[1]) / targetDuration, 1);
        const uiPct  = Math.floor(progressOffset + pct * progressRange);
        progress(`Encoding: ${Math.floor(pct * 100)}%`, uiPct);
      }
    });

    proc.on('close', code => {
      activeProc = null;
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-600)}`));
    });
    proc.on('error', err => { activeProc = null; reject(err); });
  });
}

// ─── build encoder args ───────────────────────────────────────────────────────

/**
 * Trả về mảng ffmpeg output args cho encoder được chọn.
 *
 * GPU encoders (nvenc/amf/qsv) không dùng -threads vì chúng chạy trên GPU.
 * libx264 dùng -threads để tận dụng CPU.
 *
 * @param {object} encoder   { codec, vendor, preset, extraArgs }
 * @param {number} bitrate   Mbps
 * @param {number} threads   số CPU threads (chỉ dùng cho libx264)
 * @returns {string[]}
 */
function buildEncoderArgs(encoder, bitrate, threads) {
  const { codec, preset, extraArgs = [] } = encoder;
  const isGpu = codec !== 'libx264';

  const args = [
    '-c:v', codec,
    `-b:v`, `${bitrate}M`,
  ];

  // preset (nvenc dùng -preset p4, qsv/amf/x264 dùng -preset fast/speed)
  if (preset) args.push('-preset', preset);

  // extra args đặc thù từng encoder (rc mode, quality hint…)
  args.push(...extraArgs);

  // profile + level (nvenc/qsv hỗ trợ, amf/videotoolbox bỏ qua nếu lỗi)
  if (codec !== 'h264_videotoolbox') {
    args.push('-profile:v', 'high', '-level', '4.2');
  }

  // CPU threads chỉ có ý nghĩa với libx264
  if (!isGpu) {
    args.push('-threads', String(threads));
  }

  return args;
}

// ─── main logic ──────────────────────────────────────────────────────────────

async function run() {
  const {
    id,
    videoFolder,
    audioFolder,
    outputFolder,
    videoFormat,
    videoBitrate,
    audioCount,
    threadCount,
    encoder,          // { codec, vendor, preset, extraArgs }
  } = job;

  // Fallback nếu encoder không được truyền xuống
  const activeEncoder = encoder || { codec: 'libx264', vendor: 'CPU (libx264)', preset: 'fast', extraArgs: [] };
  const isGpu = activeEncoder.codec !== 'libx264';

  const instanceId = `${id}_${Date.now()}`;
  const tempFiles  = [];
  const tmpFile = name => {
    const p = path.join(outputFolder, `${name}_${instanceId}.tmp`);
    tempFiles.push(p);
    return p;
  };
  const cleanup = () => {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  };

  try {
    if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder, { recursive: true });

    // ── 1. Collect files ────────────────────────────────────────────────────
    const videoExts = new Set(['.mp4','.avi','.mkv','.mov','.flv','.wmv']);
    const audioExts = new Set(['.mp3','.wav','.aac','.flac','.m4a','.ogg']);

    const videoFiles = fs.readdirSync(videoFolder)
      .filter(f => videoExts.has(path.extname(f).toLowerCase()))
      .map(f => path.join(videoFolder, f)).sort();

    const audioFiles = fs.readdirSync(audioFolder)
      .filter(f => audioExts.has(path.extname(f).toLowerCase()))
      .map(f => path.join(audioFolder, f)).sort();

    if (!videoFiles.length) throw new Error('Không tìm thấy file video');
    if (!audioFiles.length) throw new Error('Không tìm thấy file audio');

    // ── 2. Probe durations ──────────────────────────────────────────────────
    progress(`Phân tích video... [${activeEncoder.vendor}]`, 5);

    const videoDurations = {};
    for (const f of videoFiles) videoDurations[f] = await probeFile(f);

    // ── 3. Select random audios ─────────────────────────────────────────────
    progress('Chọn bài hát ngẫu nhiên...', 15);

    const selectedAudios = [...audioFiles]
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.min(audioCount, audioFiles.length));

    const audioDurations = {};
    for (const f of selectedAudios) audioDurations[f] = await probeFile(f);
    const totalAudioDuration = Object.values(audioDurations).reduce((a, b) => a + b, 0);

    // ── 4. Build concat list ────────────────────────────────────────────────
    progress('Tạo danh sách ghép video...', 25);

    const TARGET          = job.targetDuration || (20 * 60 + 59);  // fallback 20:59
    const videoPartDur    = TARGET - totalAudioDuration;
    if (videoPartDur <= 0) throw new Error('Tổng thời lượng audio vượt quá target (20:59)');

    const totalVideosDur  = Object.values(videoDurations).reduce((a, b) => a + b, 0);
    if (totalVideosDur === 0) throw new Error('Không đọc được thời lượng video');

    const concatList    = [];
    const videoSequence = [];
    const fullLoops     = Math.floor(videoPartDur / totalVideosDur);
    const remainder     = videoPartDur - fullLoops * totalVideosDur;

    for (let loop = 0; loop < fullLoops; loop++) {
      for (const v of videoFiles) {
        concatList.push(v);
        videoSequence.push({ filename: path.basename(v), duration: videoDurations[v] });
      }
    }
    if (remainder > 0) {
      let partial = 0;
      for (const v of videoFiles) {
        concatList.push(v);
        videoSequence.push({ filename: path.basename(v), duration: videoDurations[v] });
        partial += videoDurations[v];
        if (partial >= remainder) break;
      }
    }

    const videoConcatFile = tmpFile('video_concat');
    fs.writeFileSync(videoConcatFile, concatList.map(f => `file '${f.replace(/\\/g,'/')}'`).join('\n'));

    const audioConcatFile = tmpFile('audio_concat');
    fs.writeFileSync(audioConcatFile, selectedAudios.map(f => `file '${f.replace(/\\/g,'/')}'`).join('\n'));

    // ── 5. Encode ───────────────────────────────────────────────────────────
    progress(`Encode bằng ${activeEncoder.vendor}...`, 35);

    const finalOutput = path.join(outputFolder, `output_${instanceId}.${videoFormat}`);
    const targetTime  = formatTime(TARGET);
    const audioTime   = formatTime(Math.ceil(totalAudioDuration));
    const n           = concatList.length;
    const blackIdx    = n;
    const audioIdx    = n + 1;

    // ── filtergraph ─────────────────────────────────────────────────────────
    // GPU encoders yêu cầu pixel format khác nhau:
    //   nvenc → yuv420p (hoặc p010le cho 10-bit, nhưng giữ đơn giản)
    //   qsv   → nv12 (hoặc yuv420p, qsv tự convert)
    //   amf   → yuv420p
    //   cpu   → yuv420p
    // → dùng yuv420p cho tất cả, an toàn nhất

    const vFilters = concatList.map((_, i) =>
      `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,` +
      `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`
    );
    const blackFilter =
      `[${blackIdx}:v]scale=1920:1080,setsar=1,fps=30,format=yuv420p[vblack]`;
    const concatVFilter =
      `${concatList.map((_,i) => `[v${i}]`).join('')}[vblack]concat=n=${n+1}:v=1:a=0[outv]`;
    const concatAFilter =
      `${concatList.map((_,i) => `[${i}:a]`).join('')}[${audioIdx}:a]concat=n=${n+1}:v=0:a=1[outa]`;

    const filterComplex = [...vFilters, blackFilter, concatVFilter, concatAFilter].join(';');

    // ── ffmpeg args ─────────────────────────────────────────────────────────
    const ffArgs = [];

    // Video inputs
    for (const f of concatList) ffArgs.push('-i', f);

    // Black screen
    ffArgs.push('-f', 'lavfi', '-t', audioTime, '-i', 'color=c=black:s=1920x1080:r=30');

    // Audio concat
    ffArgs.push('-f', 'concat', '-safe', '0', '-i', audioConcatFile);

    // Filter + map
    ffArgs.push(
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-map', '[outa]',
      '-t', targetTime,
    );

    // Video encoder (GPU or CPU)
    ffArgs.push(...buildEncoderArgs(activeEncoder, videoBitrate, threadCount));

    // Audio (luôn dùng AAC trên CPU — không có GPU audio encoder cần thiết)
    ffArgs.push(
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar',  '48000',
      '-ac',  '2',
    );

    // Output flags
    ffArgs.push(
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      finalOutput,
    );

    await runFFmpeg(ffArgs, TARGET, 35, 60);

    // ── 6. Metadata ─────────────────────────────────────────────────────────
    progress('Ghi metadata...', 97);
    generateNote(finalOutput, videoSequence, selectedAudios, TARGET,
                 videoFiles, audioFiles, activeEncoder);

    cleanup();

    send({
      type: 'done',
      jobId: job.id,
      result: {
        success:  true,
        outputFile: finalOutput,
        encoder:  activeEncoder.vendor,
        videoSequence,
        audioFiles: selectedAudios.map(f => path.basename(f)),
      }
    });

  } catch (err) {
    cleanup();
    send({ type: 'error', jobId: job.id, message: err.message });
  }
}

// ─── metadata note ────────────────────────────────────────────────────────────

function generateNote(outputFile, videoSequence, selectedAudios, totalDuration,
                      allVideos, allAudios, encoder) {
  const fmt = s => {
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };

  const noteFile = outputFile.replace(/\.[^.]+$/, '.txt');
  let c = '═══════════════════════════════════════════════════════════\n';
  c    += '                    THÔNG TIN VIDEO OUTPUT\n';
  c    += '═══════════════════════════════════════════════════════════\n\n';
  c    += `📅 Ngày tạo: ${new Date().toLocaleString('vi-VN')}\n`;
  c    += `📁 File output: ${path.basename(outputFile)}\n`;
  c    += `⏱️  Tổng thời lượng: ${fmt(totalDuration)}\n`;
  c    += `🎮 Encoder: ${encoder?.vendor || 'libx264'}\n\n`;

  c    += '───────────────────────────────────────────────────────────\n';
  c    += '📹 THỨ TỰ VIDEO\n';
  c    += '───────────────────────────────────────────────────────────\n';
  videoSequence.forEach((v, i) => { c += `${i+1}. ${v.filename}  [${fmt(v.duration)}]\n`; });

  c    += '\n───────────────────────────────────────────────────────────\n';
  c    += '🎵 BÀI HÁT\n';
  c    += '───────────────────────────────────────────────────────────\n';
  selectedAudios.forEach((a, i) => { c += `${i+1}. ${path.basename(a)}\n`; });

  c    += '\n───────────────────────────────────────────────────────────\n';
  c    += '📊 THỐNG KÊ\n';
  c    += '───────────────────────────────────────────────────────────\n';
  c    += `Video sử dụng: ${videoSequence.length} / ${allVideos.length}\n`;
  c    += `Bài hát sử dụng: ${selectedAudios.length} / ${allAudios.length}\n`;
  c    += '\n═══════════════════════════════════════════════════════════\n';

  try { fs.writeFileSync(noteFile, c, 'utf-8'); } catch (_) {}
}

// ─── entry ────────────────────────────────────────────────────────────────────
run();
