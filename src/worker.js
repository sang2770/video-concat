"use strict";

const { workerData, parentPort } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { job, ffmpegPath, ffprobePath } = workerData;

// ─── helpers ─────────────────────────────────────────────────────────────────
function send(msg) {
  parentPort.postMessage(msg);
}
function progress(stage, pct) {
  send({ type: "progress", jobId: job.id, stage, progress: pct });
}

function parseTimeToSeconds(t) {
  if (!t) return 0;
  const p = t.split(":");
  return (
    (parseFloat(p[0]) || 0) * 3600 +
    (parseFloat(p[1]) || 0) * 60 +
    (parseFloat(p[2]) || 0)
  );
}

function formatTime(s) {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// Hàm tạo mã Hash để quản lý Cache an toàn (Tránh trùng file nếu người dùng đổi file khác cùng tên)
function getFileCacheHash(filePath) {
  const stat = fs.statSync(filePath);
  const str = `${path.basename(filePath)}_${stat.size}_${stat.mtimeMs}`;
  return crypto.createHash("md5").update(str).digest("hex");
}

// ─── ffprobe ──────────────────────────────────────────────────────────────────
function probeFile(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      filePath,
    ]);
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d;
    });
    proc.on("close", (code) => {
      if (code !== 0) return resolve(0);
      try {
        resolve(parseFloat(JSON.parse(out).format.duration) || 0);
      } catch {
        resolve(0);
      }
    });
    proc.on("error", () => resolve(0));
  });
}

// ─── ffmpeg ───────────────────────────────────────────────────────────────────
let activeProc = null;
let isCancelled = false;

const messageHandler = (msg) => {
  if (msg === "cancel") {
    isCancelled = true;
    if (activeProc) {
      try {
        activeProc.kill("SIGKILL");
      } catch (_) { }
    }
  }
};

parentPort.on("message", messageHandler);

function runFFmpeg(args, targetDuration = 0, onProgress = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    activeProc = proc;

    // TỐI ƯU 1: Không lưu toàn bộ Log, chỉ lưu 1000 ký tự cuối để báo lỗi nếu hỏng
    let lastStderr = "";

    // TỐI ƯU 2: Giới hạn tần suất báo Progress lên UI (Chống Spam IPC channel)
    let lastUiPct = -1;

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();

      // Chỉ gộp và cắt giữ lại 1000 ký tự cuối cùng, tránh tràn RAM
      lastStderr =
        text.length > 1000
          ? text.slice(-1000)
          : (lastStderr + text).slice(-1000);

      if (targetDuration > 0 && onProgress) {
        // Tìm chữ time=... trong đoạn text VỪA MỚI NHẬN, không tìm trong cả cục log dài
        const matches = [...text.matchAll(/time=(\d+:\d+:\d+\.\d+)/g)];
        if (matches.length > 0) {
          // Lấy match cuối cùng trong chunk này
          const lastMatch = matches[matches.length - 1][1];
          let pct = parseTimeToSeconds(lastMatch) / targetDuration;
          pct = Math.min(Math.max(pct, 0), 1); // Clamp 0-1

          // Chỉ gửi thông báo khi % thay đổi số nguyên (ví dụ: từ 90% lên 91%)
          // Tránh việc gửi 1000 tin nhắn mỗi giây làm treo giao diện App
          const currentUiPct = Math.floor(pct * 100);
          if (currentUiPct !== lastUiPct) {
            lastUiPct = currentUiPct;
            onProgress(pct);
          }
        }
      }
    });

    proc.on("close", (code) => {
      activeProc = null;
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}:\n${lastStderr}`));
    });

    proc.on("error", (err) => {
      activeProc = null;
      reject(err);
    });
  });
}

function buildEncoderArgs(encoder, bitrate, threads) {
  const { codec, preset, extraArgs = [] } = encoder;
  const isGpu = codec !== "libx264";
  const args = ["-c:v", codec, `-b:v`, `${bitrate}M`];

  if (isGpu) args.push("-preset", preset || "fast");
  else args.push("-preset", "ultrafast"); // Ép CPU chạy tốc độ cao nhất

  args.push(...extraArgs);
  if (codec !== "h264_videotoolbox")
    args.push("-profile:v", "high", "-level", "4.2");
  if (!isGpu) args.push("-threads", String(threads));

  // Rất quan trọng để đồng bộ thời gian nối file
  args.push("-video_track_timescale", "90000");
  return args;
}

// ─── main logic ──────────────────────────────────────────────────────────────
async function run() {
  try {
    const {
      id,
      videoFolder,
      audioFolder,
      outputFolder,
      videoFormat,
      videoBitrate,
      audioCount,
      threadCount,
      encoder,
    } = job;

    const activeEncoder = encoder || {
      codec: "libx264",
      vendor: "CPU",
      preset: "fast",
      extraArgs: [],
    };
    const instanceId = `${id}_${Date.now()}`;
    const tempFiles = []; // Chỉ chứa các file tạm cần xóa

    // Khởi tạo thư mục Output và Cache
    const cacheFolder = path.join(outputFolder, ".cache_encoded");
    if (!fs.existsSync(outputFolder))
      fs.mkdirSync(outputFolder, { recursive: true });
    if (!fs.existsSync(cacheFolder))
      fs.mkdirSync(cacheFolder, { recursive: true });

    const tmpTxt = (name) => {
      const p = path.join(outputFolder, `${name}_${instanceId}.txt`);
      tempFiles.push(p);
      return p;
    };
    const tmpMp4 = (name) => {
      const p = path.join(outputFolder, `${name}_${instanceId}.mp4`);
      tempFiles.push(p);
      return p;
    };

    const cleanup = () => {
      for (const f of tempFiles) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (_) { }
      }
    };

    // ── 1. Chuẩn bị File đầu vào ─────────────────────────────────────────────
    const videoExts = new Set([".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv"]);
    const audioExts = new Set([
      ".mp3",
      ".wav",
      ".aac",
      ".flac",
      ".m4a",
      ".ogg",
    ]);

    const videoFiles = fs
      .readdirSync(videoFolder)
      .filter((f) => videoExts.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(videoFolder, f))
      .sort();
    const audioFiles = fs
      .readdirSync(audioFolder)
      .filter((f) => audioExts.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(audioFolder, f))
      .sort();

    if (!videoFiles.length || !audioFiles.length)
      throw new Error("Không tìm thấy file video/audio");

    progress(`Phân tích dữ liệu... [${activeEncoder.vendor}]`, 2);

    const audioDurations = {};
    await Promise.all(
      audioFiles.map(async (f) => {
        audioDurations[f] = await probeFile(f);
      }),
    );

    // ── 2. GIAI ĐOẠN 1: ENCODE & CACHING VIDEO GỐC ───────────────────────────
    const normalizedVideos = {};
    let currentProcessed = 0;
    const vFormat = videoFormat.toLowerCase();
    const isAvi = vFormat === "avi";
    for (let i = 0; i < videoFiles.length; i++) {
      if (isCancelled) throw new Error("Job đã bị huỷ");

      const v = videoFiles[i];
      const fileHash = getFileCacheHash(v);

      const cachedFile = path.join(cacheFolder, `${fileHash}.${vFormat}`);

      if (fs.existsSync(cachedFile)) {
        const dur = await probeFile(cachedFile);
        if (dur > 0) {
          normalizedVideos[v] = { file: cachedFile, duration: dur };
          currentProcessed++;
          continue;
        }
      }

      // NẾU CHƯA CÓ CACHE -> ENCODE CHUẨN HOÁ THEO ĐỊNH DẠNG ĐÍCH
      const dur = await probeFile(v);
      const encArgs = [
        "-hwaccel",
        "auto",
        "-i",
        v,
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p",
        ...buildEncoderArgs(activeEncoder, videoBitrate, threadCount),

        "-c:a",
        isAvi ? "libmp3lame" : "aac",
        "-b:a",
        "192k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-y",
        cachedFile,
      ];

      await runFFmpeg(encArgs, dur, (pct) => {
        const overallPct =
          5 + ((currentProcessed + pct) / videoFiles.length) * 65;
        progress(
          `Chuẩn hoá ${vFormat.toUpperCase()}: ${path.basename(v)}...`,
          Math.floor(overallPct),
        );
      });

      normalizedVideos[v] = { file: cachedFile, duration: dur };
      currentProcessed++;
    }

    if (isCancelled) throw new Error("Job đã bị huỷ");

    // ── 3. TẠO VIDEO ĐUÔI (Nền Đen + Nhạc Nền) BẰNG CPU ULTRAFAST ─────────────
    progress("Đang ráp phần nhạc cuối...", 72);

    const selectedAudios = [...audioFiles]
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.min(audioCount, audioFiles.length));
    const totalAudioDuration = selectedAudios.reduce(
      (sum, f) => sum + (audioDurations[f] || 0),
      0,
    );

    const TARGET = job.targetDuration || 20 * 60 + 59;
    const videoPartDur = TARGET - totalAudioDuration;
    if (videoPartDur <= 0)
      throw new Error("Tổng thời lượng nhạc vượt quá giới hạn video (20 phút)");

    const audioConcatTxt = tmpTxt("audio_concat");
    fs.writeFileSync(
      audioConcatTxt,
      selectedAudios
        .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
        .join("\n"),
    );

    const tailFile = tmpMp4("tail_video");
    const tailArgs = [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      audioConcatTxt,
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1920x1080:r=30:sar=1",
      "-map",
      "1:v",
      "-map",
      "0:a",
      "-vf",
      "format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-b:v",
      "100k",
      "-video_track_timescale",
      "90000",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-shortest",
      "-y",
      tailFile,
    ];
    await runFFmpeg(tailArgs, totalAudioDuration, (pct) => {
      progress("Đang render phần đuôi đen...", 72 + Math.floor(pct * 15));
    });

    if (isCancelled) throw new Error("Job đã bị huỷ");

    // ── 4. TÍNH TOÁN KỊCH BẢN GHÉP CUỐI CÙNG ──────────────────────────────────
    progress("Đang tính toán kịch bản...", 88);
    const totalVideosDur = Object.values(normalizedVideos).reduce(
      (sum, obj) => sum + obj.duration,
      0,
    );
    if (totalVideosDur <= 0)
      throw new Error("Không đọc được file video hợp lệ nào");

    const concatList = [];
    const videoSequence = [];

    const fullLoops = Math.floor(videoPartDur / totalVideosDur);
    const remainder = videoPartDur - fullLoops * totalVideosDur;

    for (let loop = 0; loop < fullLoops; loop++) {
      for (const v of videoFiles) {
        if (!normalizedVideos[v]) continue;
        concatList.push(normalizedVideos[v].file);
        videoSequence.push({
          filename: path.basename(v),
          duration: normalizedVideos[v].duration,
        });
      }
    }

    if (remainder > 0) {
      let partial = 0;
      for (const v of videoFiles) {
        if (!normalizedVideos[v]) continue;
        concatList.push(normalizedVideos[v].file);
        videoSequence.push({
          filename: path.basename(v),
          duration: normalizedVideos[v].duration,
        });
        partial += normalizedVideos[v].duration;
        if (partial >= remainder) break;
      }
    }

    concatList.push(tailFile);

    const master_concatTxt = tmpTxt("master_concat");
    fs.writeFileSync(
      master_concatTxt,
      concatList.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    );

    // ── 5. GIAI ĐOẠN 2: GHÉP SIÊU TỐC (-c copy) ──────────────────────────────
    progress("Đang đóng gói xuất file...", 90);

    const finalOutput = path.join(
      outputFolder,
      `output_${instanceId}.${videoFormat}`,
    );
    const targetTime = formatTime(TARGET);

    const finalArgs = [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      master_concatTxt,
      "-c",
      "copy",
      "-t",
      targetTime,
      "-y",
      finalOutput,
    ];

    await runFFmpeg(finalArgs, TARGET, (pct) => {
      progress(`Đang ghi dữ liệu ổ cứng...`, 90 + Math.floor(pct * 8));
    });

    if (isCancelled) throw new Error("Job đã bị huỷ");

    // ── 6. Hoàn tất ──────────────────────────────────────────────────────────
    progress("Hoàn tất!", 99);
    cleanup();
    generateNote(
      finalOutput,
      videoSequence,
      selectedAudios,
      TARGET,
      videoFiles,
      audioFiles,
      activeEncoder,
    );

    send({
      type: "done",
      jobId: job.id,
      result: {
        success: true,
        outputFile: finalOutput,
        encoder: activeEncoder.vendor,
        videoSequence,
        audioFiles: selectedAudios.map((f) => path.basename(f)),
      },
    });
  } catch (err) {
    cleanup();
    if (!isCancelled) {
      send({ type: "error", jobId: job.id, message: err.message });
    }
  } finally {
    parentPort.off("message", messageHandler);
  }
}

// ─── metadata note ────────────────────────────────────────────────────────────
function generateNote(
  outputFile,
  videoSequence,
  selectedAudios,
  totalDuration,
  allVideos,
  allAudios,
  encoder,
) {
  const fmt = (s) => {
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = Math.floor(s % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  const noteFile = outputFile.replace(/\.[^.]+$/, ".txt");
  let c = `═══════════════════════════════════════════════════════════\n                    THÔNG TIN VIDEO OUTPUT\n═══════════════════════════════════════════════════════════\n\n📅 Ngày tạo: ${new Date().toLocaleString("vi-VN")}\n📁 File output: ${path.basename(outputFile)}\n⏱️  Tổng thời lượng: ${fmt(totalDuration)}\n🎮 Encoder: ${encoder?.vendor || "libx264"} (Smart Cache + Stream Copy)\n\n───────────────────────────────────────────────────────────\n📹 THỨ TỰ VIDEO\n───────────────────────────────────────────────────────────\n`;
  videoSequence.forEach((v, i) => {
    c += `${i + 1}. ${v.filename}  [${fmt(v.duration)}]\n`;
  });
  c += `\n───────────────────────────────────────────────────────────\n🎵 BÀI HÁT CUỐI\n───────────────────────────────────────────────────────────\n`;
  selectedAudios.forEach((a, i) => {
    c += `${i + 1}. ${path.basename(a)}\n`;
  });
  try {
    fs.writeFileSync(noteFile, c, "utf-8");
  } catch (_) { }
}

run();
