"use strict";

const { workerData, parentPort } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { task, ffmpegPath, ffprobePath } = workerData;

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

function send(msg) {
    parentPort.postMessage(msg);
}

function getEncoderPreset(encoder) {
    const codec = encoder?.codec || "libx264";

    // NVIDIA
    if (codec.includes("_nvenc")) {
        return "p4";
    }

    // AMD
    if (codec.includes("_amf")) {
        return "balanced";
    }

    // Intel
    if (codec.includes("_qsv")) {
        return "medium";
    }

    // CPU x264/x265
    return "veryfast";
}

function progress(stage, pct) {
    send({
        type: "progress",
        taskId: task.id,
        stage,
        progress: pct,
    });
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

function parseFrameRate(rFrameRate) {
    if (!rFrameRate) return 30;

    const raw = String(rFrameRate).trim();

    if (!raw) return 30;

    if (raw.includes("/")) {
        const [numStr, denStr] = raw.split("/");
        const num = parseFloat(numStr);
        const den = parseFloat(denStr);

        if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
            const fps = num / den;

            if (Number.isFinite(fps) && fps > 0) {
                return fps;
            }
        }
    }

    const fps = parseFloat(raw);

    if (Number.isFinite(fps) && fps > 0) {
        return fps;
    }

    return 30;
}

function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);

    return `${String(h).padStart(2, "0")}:${String(m).padStart(
        2,
        "0"
    )}:${String(sec).padStart(2, "0")}`;
}

function getFileCacheHash(filePath, profile = null) {
    const stat = fs.statSync(filePath);

    const profileKey = profile
        ? JSON.stringify(profile)
        : "default";

    const str = `${path.basename(filePath)}_${stat.size}_${stat.mtimeMs}_${profileKey}`;

    return crypto
        .createHash("md5")
        .update(str)
        .digest("hex");
}

// ─────────────────────────────────────────────────────────────
// ffprobe
// ─────────────────────────────────────────────────────────────

function probeFile(filePath) {
    return new Promise((resolve) => {
        const proc = spawn(ffprobePath, [
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            filePath,
        ]);

        let out = "";

        proc.stdout.on("data", (d) => {
            out += d;
        });

        proc.on("close", (code) => {
            if (code !== 0) {
                return resolve({
                    duration: 0,
                    streams: [],
                });
            }

            try {
                const data = JSON.parse(out);

                resolve({
                    duration: parseFloat(data.format.duration) || 0,
                    streams: data.streams || [],
                });
            } catch {
                resolve({
                    duration: 0,
                    streams: [],
                });
            }
        });

        proc.on("error", () => {
            resolve({
                duration: 0,
                streams: [],
            });
        });
    });
}

// ─────────────────────────────────────────────────────────────
// ffmpeg
// ─────────────────────────────────────────────────────────────

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
        const proc = spawn(ffmpegPath, args, {
            windowsHide: true,
            detached: false,
            stdio: ["ignore", "pipe", "pipe"],
        });

        activeProc = proc;

        let lastStderr = "";
        let lastUiPct = -1;

        proc.stderr.on("data", (chunk) => {
            const text = chunk.toString();

            lastStderr =
                text.length > 2000
                    ? text.slice(-2000)
                    : (lastStderr + text).slice(-2000);

            if (targetDuration > 0 && onProgress) {
                const matches = [
                    ...text.matchAll(/time=(\d+:\d+:\d+\.\d+)/g),
                ];

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

            if (code === 0) {
                resolve();
            } else {
                reject(
                    new Error(`ffmpeg exited ${code}:\n${lastStderr}`)
                );
            }
        });

        proc.on("error", (err) => {
            activeProc = null;
            reject(err);
        });
    });
}

// ─────────────────────────────────────────────────────────────
// codec info
// ─────────────────────────────────────────────────────────────

function getVideoCodecInfo(streams) {
    const videoStream = streams.find((s) => s.codec_type === "video");

    if (!videoStream) return null;

    return {
        codec: videoStream.codec_name,
        width: videoStream.width,
        height: videoStream.height,
        pix_fmt: videoStream.pix_fmt,
        r_frame_rate: videoStream.r_frame_rate,
    };
}

// ─────────────────────────────────────────────────────────────
// metadata note
// ─────────────────────────────────────────────────────────────

function generateNote(outputFile, videoSequence, selectedAudios, totalDuration) {
    const noteFile = outputFile.replace(/\.[^.]+$/, ".txt");

    let c = `
═══════════════════════════════════════════════════════════
VIDEO CONCAT REPORT
═══════════════════════════════════════════════════════════

📹 VIDEO SEQUENCE
Duration: ${formatTime(totalDuration)}

`;

    videoSequence.forEach((v, i) => {
        c += `${i + 1}. ${v.filename} [${formatTime(v.duration)}]\n`;
    });

    c += `
───────────────────────────────────────────────────────────
🎵 BACKGROUND MUSIC

`;

    selectedAudios.forEach((a, i) => {
        c += `${i + 1}. ${path.basename(a)}\n`;
    });

    try {
        fs.writeFileSync(noteFile, c, "utf-8");
    } catch (_) { }
}

// ─────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────

async function run() {
    const tempFiles = [];

    function cleanupTemp() {
        for (const f of tempFiles) {
            try {
                if (fs.existsSync(f)) fs.unlinkSync(f);
            } catch (_) { }
        }
    }

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

        if (isCancelled) throw new Error("Task đã bị huỷ");
        const tmpDir = os.tmpdir();

        // ── 1. Phân tích video đầu vào ───────────────────────────────────
        progress("Phân tích video đầu vào...", 2);
        const { duration: srcDuration, streams } = await probeFile(videoFile);
        if (!srcDuration) {
            throw new Error("Không thể đọc metadata video đầu vào");
        }

        const codecInfo = getVideoCodecInfo(streams);
        const hasAudio = streams.some((s) => s.codec_type === "audio");
        const fps = codecInfo ? parseFrameRate(codecInfo.r_frame_rate) : 30;
        const width = codecInfo?.width || 1920;
        const height = codecInfo?.height || 1080;
        const pixFmt = codecInfo?.pix_fmt || "yuv420p";

        const codec = encoder?.codec || "libx264";
        const preset = getEncoderPreset(encoder);
        const bitrateArgs = videoBitrate ? ["-b:v", String(videoBitrate)] : ["-crf", "23"];
        const threadArgs = threadCount > 0 ? ["-threads", String(threadCount)] : [];

        // Kiểm tra khả năng copy stream không cần mã hoá
        const INPUT_CODEC = codecInfo?.codec;
        const H264 = new Set(["h264", "libx264", "h264_nvenc", "h264_amf", "h264_qsv"]);
        const HEVC = new Set(["hevc", "libx265", "hevc_nvenc", "hevc_amf", "hevc_qsv"]);

        function codecFamily(name) {
            if (!name) return null;
            if (H264.has(name)) return "h264";
            if (HEVC.has(name)) return "hevc";
            return name;
        }

        const canStreamCopy =
            !videoBitrate &&
            (!encoder?.codec ||
                codecFamily(INPUT_CODEC) === codecFamily(encoder.codec));

        const CODEC_MAP = { h264: "libx264", hevc: "libx265", vp9: "libvpx-vp9", av1: "libaom-av1" };
        const outroEncoder = canStreamCopy ? (CODEC_MAP[INPUT_CODEC] || "libx264") : codec;
        const outroPreset = canStreamCopy ? "veryfast" : preset;
        const outroBitrateArgs = canStreamCopy ? ["-crf", "23"] : bitrateArgs;

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 2. Chọn và ghép các đoạn Audio thành 1 khối (Audio A) ──
        progress("Chọn và ghép audio nền...", 5);
        const AUDIO_EXTS = new Set([".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"]);
        const allAudioFiles = fs
            .readdirSync(audioFolder)
            .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
            .map((f) => path.join(audioFolder, f));

        if (allAudioFiles.length === 0) {
            throw new Error(`Không tìm thấy file audio trong: ${audioFolder}`);
        }

        const shuffled = [...allAudioFiles].sort(() => Math.random() - 0.5);
        const selectedAudios = shuffled.slice(0, Math.min(audioCount, shuffled.length));

        const audioAPath = path.join(tmpDir, `vc_audioA_${id}.aac`);
        tempFiles.push(audioAPath);

        // Tạo ra audio có format AAC chuẩn cho khối Audio đầu tiên
        if (selectedAudios.length === 1) {
            await runFFmpeg([
                "-i", selectedAudios[0],
                "-t", String(targetDuration),
                "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "44100",
                "-y", audioAPath,
            ]);
        } else {
            const audioListPath = path.join(tmpDir, `vc_src_alist_${id}.txt`);
            tempFiles.push(audioListPath);
            const listContent = selectedAudios
                .map((f) => `file '${f.replace(/\\/g, "/")}'`)
                .join("\n");
            fs.writeFileSync(audioListPath, listContent, "utf-8");

            await runFFmpeg([
                "-f", "concat", "-safe", "0",
                "-i", audioListPath,
                "-t", String(targetDuration),
                "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "44100",
                "-y", audioAPath,
            ],
                targetDuration,
                (pct) => progress("Ghép audio nền...", 5 + Math.floor(pct * 5))
            );
        }

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // Probe khối Audio A để lấy thời gian chính xác
        const probedAudio = await probeFile(audioAPath);
        let A_dur = probedAudio.duration || 0;
        A_dur = Math.min(A_dur, targetDuration); // Đảm bảo không dài hơn targetDuration

        if (A_dur <= 0) {
            throw new Error("Không thể tạo audio nền hoặc audio quá ngắn.");
        }

        // Tính thời gian còn thiếu
        const timeRemain = Math.max(0, targetDuration - A_dur);

        // ── 3. Tạo Video A (Màn hình đen kéo dài bằng A_dur) ─────────
        let videoAPath = null;
        if (A_dur > 0.05) {
            progress("Tạo video màn hình đen...", 10);
            videoAPath = path.join(tmpDir, `vc_videoA_${id}.mp4`);
            tempFiles.push(videoAPath);
            await runFFmpeg([
                "-f", "lavfi",
                "-i", `color=c=black:size=${width}x${height}:rate=${fps}`,
                "-t", String(A_dur),
                "-c:v", outroEncoder, ...outroBitrateArgs, "-preset", outroPreset,
                "-pix_fmt", pixFmt,
                ...threadArgs,
                "-an", // Chỉ tạo hình, không kèm âm thanh ở bước này
                "-y", videoAPath,
            ],
                A_dur,
                (pct) => progress("Tạo video màn hình đen...", 10 + Math.floor(pct * 15))
            );
        }

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 4. Tạo Video B & Audio B (Lặp file gốc bằng timeRemain) ──
        let videoBPath = null;
        let audioBPath = null;

        let fullLoops = 0;
        if (timeRemain > 0.05) {
            fullLoops = Math.ceil(timeRemain / srcDuration);

            // Generate Video lặp (chỉ hình)
            progress("Tạo video lặp...", 25);
            videoBPath = path.join(tmpDir, `vc_videoB_${id}.mp4`);
            tempFiles.push(videoBPath);

            const vBArgs = [
                "-stream_loop", String(fullLoops - 1),
                "-i", videoFile,
                "-t", String(timeRemain),
                "-an", // Chỉ tạo hình
                "-c:v", canStreamCopy ? "copy" : codec,
            ];
            if (!canStreamCopy) {
                vBArgs.push(...bitrateArgs, "-preset", preset, "-r", String(fps), "-pix_fmt", pixFmt);
            }
            vBArgs.push("-avoid_negative_ts", "make_zero", ...threadArgs, "-y", videoBPath);

            await runFFmpeg(
                vBArgs,
                timeRemain,
                (pct) => progress(canStreamCopy ? "Copy video lặp..." : "Mã hoá video lặp...", 25 + Math.floor(pct * 25))
            );

            if (isCancelled) throw new Error("Task đã bị huỷ");

            // Generate Audio lặp cho Video B
            progress("Tạo audio lặp...", 50);
            audioBPath = path.join(tmpDir, `vc_audioB_${id}.aac`);
            tempFiles.push(audioBPath);

            if (hasAudio) {
                // Nếu file gốc có âm thanh, lặp âm thanh của nó
                await runFFmpeg([
                    "-stream_loop", String(fullLoops - 1),
                    "-i", videoFile,
                    "-t", String(timeRemain),
                    "-vn", // Lấy nguyên âm thanh
                    "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "44100", // convert format standard
                    "-avoid_negative_ts", "make_zero",
                    "-y", audioBPath,
                ],
                    timeRemain,
                    (pct) => progress("Xử lý audio lặp...", 50 + Math.floor(pct * 15))
                );
            } else {
                // Nếu file gốc không có âm thanh, tạo khoảng lặng (để không bị lỗi nối)
                await runFFmpeg([
                    "-f", "lavfi",
                    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                    "-t", String(timeRemain),
                    "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "44100",
                    "-y", audioBPath,
                ],
                    timeRemain,
                    (pct) => progress("Tạo audio im lặng...", 50 + Math.floor(pct * 15))
                );
            }
        }

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 5. Ghép các Video/Audio lại với nhau (Nối Sequence) ───────────

        // 5.1 Nối Hình (Video Track)
        let finalVTrack = null;
        const vList = [];
        if (videoBPath) vList.push(videoBPath);
        if (videoAPath) vList.push(videoAPath);

        if (vList.length === 1) {
            finalVTrack = vList[0];
        } else if (vList.length === 2) {
            progress("Ghép video sequence...", 65);
            const concatVPath = path.join(tmpDir, `vc_concatV_${id}.mp4`);
            tempFiles.push(concatVPath);
            const listTxt = vList.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n");
            const listFile = path.join(tmpDir, `vc_vlist_${id}.txt`);
            tempFiles.push(listFile);
            fs.writeFileSync(listFile, listTxt, "utf-8");

            await runFFmpeg(
                [
                    "-f", "concat", "-safe", "0",
                    "-i", listFile,
                    "-c", "copy",
                    "-y", concatVPath,
                ],
                targetDuration,
                (pct) => progress("Ghép video sequence...", 65 + Math.floor(pct * 10))
            );
            finalVTrack = concatVPath;
        }

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // 5.2 Nối Tiếng (Audio Track)
        let finalATrack = null;
        const aList = [];
        if (audioBPath && timeRemain > 0.05) aList.push(audioBPath);
        if (audioAPath && A_dur > 0.05) aList.push(audioAPath);

        if (aList.length === 1) {
            finalATrack = aList[0];
        } else if (aList.length === 2) {
            progress("Ghép audio sequence...", 75);
            const concatAPath = path.join(tmpDir, `vc_concatA_${id}.aac`);
            tempFiles.push(concatAPath);
            const listTxt = aList.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n");
            const listFile = path.join(tmpDir, `vc_alist_${id}.txt`);
            tempFiles.push(listFile);
            fs.writeFileSync(listFile, listTxt, "utf-8");

            await runFFmpeg(
                [
                    "-f", "concat", "-safe", "0",
                    "-i", listFile,
                    "-c", "copy",
                    "-y", concatAPath,
                ],
                targetDuration,
                (pct) => progress("Ghép audio sequence...", 75 + Math.floor(pct * 10))
            );
            finalATrack = concatAPath;
        }

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 6. Mux ghép Hình và Tiếng để xuất file Final ──────────────────
        progress("Muxing final video...", 85);
        const ext = videoFormat || "mp4";
        const baseName = path.basename(videoFile, path.extname(videoFile));
        const finalOutput = path.join(outputFolder, `${baseName}_${id}.${ext}`);

        const outputDuration = (targetDuration + 0.05).toFixed(2);

        const finalMuxArgs = [
            "-i", finalVTrack,
            "-i", finalATrack,
            "-c:v", "copy",
            "-c:a", "copy",
        ];

        if (ext === "avi") {
            finalMuxArgs.push("-tag:a", "0x1610");
        }

        finalMuxArgs.push(
            "-t", outputDuration,
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-y", finalOutput
        );

        await runFFmpeg(finalMuxArgs,
            targetDuration,
            (pct) => progress("Muxing final video...", 85 + Math.floor(pct * 15))
        );

        if (isCancelled) throw new Error("Task đã bị huỷ");

        progress("Hoàn tất!", 100);

        cleanupTemp();

        // Build Sequence Metadata note xuất ra file .txt
        const videoSequence = [];
        if (fullLoops > 0) {
            for (let i = 0; i < fullLoops; i++) {
                let dur = srcDuration;
                if (i === fullLoops - 1) {
                    const elapsed = i * srcDuration;
                    dur = Math.max(0, timeRemain - elapsed);
                }
                if (dur > 0.01) {
                    videoSequence.push({
                        filename: path.basename(videoFile),
                        duration: dur,
                    });
                }
            }
        }

        if (A_dur > 0) {
            videoSequence.push({
                filename: "Màn hình đen",
                duration: A_dur,
            });
        }

        generateNote(finalOutput, videoSequence, selectedAudios, targetDuration);

        send({
            type: "done",
            taskId: task.id,
            result: {
                success: true,
                outputFile: finalOutput,
                encoder: encoder?.vendor || codec,
                videoFile: path.basename(videoFile),
                audioFiles: selectedAudios.map((f) => path.basename(f)),
            },
        });
    } catch (err) {
        cleanupTemp();

        if (!isCancelled) {
            send({
                type: "error",
                taskId: task.id,
                message: err.message,
            });
        }
    } finally {
        parentPort.off("message", messageHandler);
    }
}

run();