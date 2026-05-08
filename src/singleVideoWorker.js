"use strict";

const { workerData, parentPort } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { task, ffmpegPath, ffprobePath } = workerData;

// ─── helpers ─────────────────────────────────────────────────────────────────
function send(msg) {
    parentPort.postMessage(msg);
}

function progress(stage, pct) {
    send({ type: "progress", taskId: task.id, stage, progress: pct });
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

        let lastStderr = "";
        let lastUiPct = -1;

        proc.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            lastStderr =
                text.length > 1000
                    ? text.slice(-1000)
                    : (lastStderr + text).slice(-1000);

            if (targetDuration > 0 && onProgress) {
                const matches = [...text.matchAll(/time=(\d+:\d+:\d+\.\d+)/g)];
                if (matches.length > 0) {
                    const lastMatch = matches[matches.length - 1][1];
                    let pct = parseTimeToSeconds(lastMatch) / targetDuration;
                    pct = Math.min(Math.max(pct, 0), 1);

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
    else args.push("-preset", "ultrafast");

    args.push(...extraArgs);
    if (codec !== "h264_videotoolbox")
        args.push("-profile:v", "high", "-level", "4.2");
    if (!isGpu) args.push("-threads", String(threads));

    args.push("-video_track_timescale", "90000");
    return args;
}

// ─── main logic ──────────────────────────────────────────────────────────────
async function run() {
    const tempFiles = [];

    try {
        const {
            id,
            videoFile,
            audioFolder,
            outputFolder,
            videoFormat,
            videoBitrate,
            audioCount,
            threadCount,
            encoder,
            targetDuration,
        } = task;

        const activeEncoder = encoder || {
            codec: "libx264",
            vendor: "CPU",
            preset: "fast",
            extraArgs: [],
        };

        const instanceId = `${id}_${Date.now()}`;

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

        // ── 1. Chuẩn bị File audio ───────────────────────────────────────────────
        const audioExts = new Set([
            ".mp3",
            ".wav",
            ".aac",
            ".flac",
            ".m4a",
            ".ogg",
        ]);

        const audioFiles = fs
            .readdirSync(audioFolder)
            .filter((f) => audioExts.has(path.extname(f).toLowerCase()))
            .map((f) => path.join(audioFolder, f))
            .sort();

        if (!audioFiles.length)
            throw new Error("Không tìm thấy file audio");

        progress(`Phân tích video: ${path.basename(videoFile)}...`, 2);

        const audioDurations = {};
        await Promise.all(
            audioFiles.map(async (f) => {
                audioDurations[f] = await probeFile(f);
            }),
        );

        // ── 2. ENCODE & CACHE VIDEO GỐC ──────────────────────────────────────────
        const vFormat = videoFormat.toLowerCase();
        const isAvi = vFormat === "avi";
        const fileHash = getFileCacheHash(videoFile);
        const cachedFile = path.join(cacheFolder, `${fileHash}.${vFormat}`);

        let normalizedVideo = null;

        if (fs.existsSync(cachedFile)) {
            const dur = await probeFile(cachedFile);
            if (dur > 0) {
                normalizedVideo = { file: cachedFile, duration: dur };
                progress(`Sử dụng cache: ${path.basename(videoFile)}`, 30);
            }
        }

        if (!normalizedVideo) {
            const dur = await probeFile(videoFile);
            const encArgs = [
                "-hwaccel",
                "auto",
                "-i",
                videoFile,
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
                progress(
                    `Chuẩn hoá ${vFormat.toUpperCase()}: ${path.basename(videoFile)}...`,
                    5 + Math.floor(pct * 25),
                );
            });

            normalizedVideo = { file: cachedFile, duration: dur };
        }

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 3. TẠO VIDEO ĐUÔI (Màn hình đen + Nhạc random) ────────────────────────
        progress("Đang tạo phần nhạc cuối...", 35);

        const selectedAudios = [...audioFiles]
            .sort(() => Math.random() - 0.5)
            .slice(0, Math.min(audioCount, audioFiles.length));
        const totalAudioDuration = selectedAudios.reduce(
            (sum, f) => sum + (audioDurations[f] || 0),
            0,
        );

        const TARGET = targetDuration;
        const videoPartDur = TARGET - totalAudioDuration;
        if (videoPartDur <= 0)
            throw new Error("Tổng thời lượng nhạc vượt quá thời lượng target");

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
            progress("Đang render màn hình đen + nhạc...", 35 + Math.floor(pct * 30));
        });

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 4. TÍNH TOÁN KỊCH BẢN GHÉP ────────────────────────────────────────────
        progress("Đang tính toán kịch bản lặp...", 66);

        const concatList = [];
        const videoSequence = [];

        const fullLoops = Math.floor(videoPartDur / normalizedVideo.duration);
        const remainder = videoPartDur - fullLoops * normalizedVideo.duration;

        // Lặp lại video đầy đủ
        for (let loop = 0; loop < fullLoops; loop++) {
            concatList.push(normalizedVideo.file);
            videoSequence.push({
                filename: path.basename(videoFile),
                duration: normalizedVideo.duration,
            });
        }

        // Thêm phần dư nếu có
        if (remainder > 0) {
            concatList.push(normalizedVideo.file);
            videoSequence.push({
                filename: path.basename(videoFile),
                duration: normalizedVideo.duration,
            });
        }

        // Thêm phần đuôi màn hình đen
        concatList.push(tailFile);

        const master_concatTxt = tmpTxt("master_concat");
        fs.writeFileSync(
            master_concatTxt,
            concatList.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
        );

        // ── 5. GHÉP VIDEO CUỐI CÙNG ───────────────────────────────────────────────
        progress("Đang ghép video cuối cùng...", 70);

        const videoBaseName = path.basename(videoFile, path.extname(videoFile));
        const finalOutput = path.join(
            outputFolder,
            `${videoBaseName}_output_${instanceId}.${videoFormat}`,
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
            progress(`Đang ghi file output...`, 70 + Math.floor(pct * 28));
        });

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 6. Hoàn tất ───────────────────────────────────────────────────────────
        progress("Hoàn tất!", 99);
        cleanup();

        generateNote(
            finalOutput,
            videoSequence,
            selectedAudios,
            TARGET,
            activeEncoder,
        );

        send({
            type: "done",
            taskId: task.id,
            result: {
                success: true,
                outputFile: finalOutput,
                encoder: activeEncoder.vendor,
                videoFile: path.basename(videoFile),
                audioFiles: selectedAudios.map((f) => path.basename(f)),
            },
        });
    } catch (err) {
        const cleanup = () => {
            for (const f of tempFiles) {
                try {
                    if (fs.existsSync(f)) fs.unlinkSync(f);
                } catch (_) { }
            }
        };
        cleanup();
        if (!isCancelled) {
            send({ type: "error", taskId: task.id, message: err.message });
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
    encoder,
) {
    const fmt = (s) => {
        const h = Math.floor(s / 3600),
            m = Math.floor((s % 3600) / 60),
            sec = Math.floor(s % 60);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    };
    const noteFile = outputFile.replace(/\.[^.]+$/, ".txt");
    let c = `═══════════════════════════════════════════════════════════\n                    THÔNG TIN VIDEO OUTPUT\n═══════════════════════════════════════════════════════════\n\n📅 Ngày tạo: ${new Date().toLocaleString("vi-VN")}\n📁 File output: ${path.basename(outputFile)}\n⏱️  Tổng thời lượng: ${fmt(totalDuration)}\n🎮 Encoder: ${encoder?.vendor || "libx264"}\n\n───────────────────────────────────────────────────────────\n📹 VIDEO LẶP LẠI\n───────────────────────────────────────────────────────────\n`;
    videoSequence.forEach((v, i) => {
        c += `${i + 1}. ${v.filename}  [${fmt(v.duration)}]\n`;
    });
    c += `\n───────────────────────────────────────────────────────────\n🎵 BÀI HÁT CUỐI (Màn hình đen)\n───────────────────────────────────────────────────────────\n`;
    selectedAudios.forEach((a, i) => {
        c += `${i + 1}. ${path.basename(a)}\n`;
    });
    try {
        fs.writeFileSync(noteFile, c, "utf-8");
    } catch (_) { }
}

run();
