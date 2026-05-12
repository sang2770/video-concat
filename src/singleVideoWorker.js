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
    if (
        codec.includes("_nvenc")
    ) {
        return "p4";
    }

    // AMD
    if (
        codec.includes("_amf")
    ) {
        return "balanced";
    }

    // Intel
    if (
        codec.includes("_qsv")
    ) {
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
        "0",
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
                    duration:
                        parseFloat(data.format.duration) || 0,
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

function runFFmpeg(
    args,
    targetDuration = 0,
    onProgress = null,
) {
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
                    ...text.matchAll(
                        /time=(\d+:\d+:\d+\.\d+)/g,
                    ),
                ];

                if (matches.length > 0) {
                    const lastMatch =
                        matches[matches.length - 1][1];

                    let pct =
                        parseTimeToSeconds(lastMatch) /
                        targetDuration;

                    pct = Math.min(
                        Math.max(pct, 0),
                        1,
                    );

                    const currentUiPct = Math.floor(
                        pct * 100,
                    );

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
                    new Error(
                        `ffmpeg exited ${code}:\n${lastStderr}`,
                    ),
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
    const videoStream = streams.find(
        (s) => s.codec_type === "video",
    );

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

function generateNote(
    outputFile,
    videoSequence,
    selectedAudios,
    totalDuration,
) {
    const noteFile = outputFile.replace(
        /\.[^.]+$/,
        ".txt",
    );

    let c = `
═══════════════════════════════════════════════════════════
VIDEO CONCAT REPORT
═══════════════════════════════════════════════════════════

📹 VIDEO SEQUENCE
Duration: ${formatTime(totalDuration)}

`;

    videoSequence.forEach((v, i) => {
        c += `${i + 1}. ${v.filename} [${formatTime(
            v.duration,
        )}]\n`;
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
            } catch (_) {}
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

        // ── 1. Probe input video ───────────────────────────────────
        progress("Phân tích video đầu vào...", 2);
        const { duration: srcDuration, streams } = await probeFile(videoFile);
        if (!srcDuration) {
            throw new Error("Không thể đọc metadata video đầu vào");
        }

        const codecInfo = getVideoCodecInfo(streams);
        const fps       = codecInfo ? parseFrameRate(codecInfo.r_frame_rate) : 30;
        const width     = codecInfo?.width   || 1920;
        const height    = codecInfo?.height  || 1080;
        const pixFmt    = codecInfo?.pix_fmt || "yuv420p";

        const codec       = encoder?.codec || "libx264";
        const preset      = getEncoderPreset(encoder);
        const bitrateArgs = videoBitrate ? ["-b:v", String(videoBitrate)] : ["-crf", "23"];
        const threadArgs  = threadCount > 0 ? ["-threads", String(threadCount)] : [];

        // Detect whether re-encoding is needed (same codec family → stream copy)
        const INPUT_CODEC = codecInfo?.codec; // e.g. "h264", "hevc"
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

        // Encoder used for synthetic segments (black screen) — must match input codec
        // so that stream-copy concat works when canStreamCopy is true.
        const CODEC_MAP = { h264: "libx264", hevc: "libx265", vp9: "libvpx-vp9", av1: "libaom-av1" };
        const outroEncoder = canStreamCopy
            ? (CODEC_MAP[INPUT_CODEC] || "libx264")
            : codec;
        const outroPreset      = canStreamCopy ? "veryfast" : preset;
        const outroBitrateArgs = canStreamCopy
            ? ["-crf", "23"]
            : bitrateArgs;

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 2. Random audio selection ──────────────────────────────
        progress("Chọn audio ngẫu nhiên...", 5);
        const AUDIO_EXTS = new Set([".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"]);
        const allAudioFiles = fs
            .readdirSync(audioFolder)
            .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
            .map((f) => path.join(audioFolder, f));

        if (allAudioFiles.length === 0) {
            throw new Error(`Không tìm thấy file audio trong: ${audioFolder}`);
        }

        // Shuffle + pick audioCount files
        const shuffled      = [...allAudioFiles].sort(() => Math.random() - 0.5);
        const selectedAudios = shuffled.slice(0, Math.min(audioCount, shuffled.length));

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 3. Concatenate selected audio → temp AAC ──────────────
        progress("Ghép file audio...", 8);
        const tmpDir          = os.tmpdir();
        const concatAudioPath = path.join(tmpDir, `vc_audio_${id}.aac`);
        tempFiles.push(concatAudioPath);

        // Add padding to ensure audio reaches full target duration
        const audioDurationStr = (targetDuration + 0.1).toFixed(2);

        if (selectedAudios.length === 1) {
            await runFFmpeg([
                "-i", selectedAudios[0],
                "-t", audioDurationStr,
                "-c:a", "aac", "-b:a", "192k",
                "-y", concatAudioPath,
            ]);
        } else {
            const audioListPath = path.join(tmpDir, `vc_alist_${id}.txt`);
            tempFiles.push(audioListPath);
            const listContent = selectedAudios
                .map((f) => `file '${f.replace(/\\/g, "/")}'`)
                .join("\n");
            fs.writeFileSync(audioListPath, listContent, "utf-8");

            await runFFmpeg(
                [
                    "-f", "concat", "-safe", "0",
                    "-i", audioListPath,
                    "-t", audioDurationStr,
                    "-c:a", "aac", "-b:a", "192k",
                    "-y", concatAudioPath,
                ],
                targetDuration,
                (pct) => progress("Ghép audio...", 8 + Math.floor(pct * 7)),
            );
        }

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 4. Compute loop count & outro (black screen) duration ──
        const TARGET = targetDuration + 1;
        let fullLoops, videoPlayDuration;

        if (srcDuration >= TARGET) {
            // Input is longer than target: use one trimmed pass
            fullLoops         = 1;
            videoPlayDuration = TARGET;
        } else {
            // Floor keeps only complete loops; remainder → black screen
            fullLoops         = Math.floor(TARGET / srcDuration);
            videoPlayDuration = fullLoops * srcDuration;
        }

        const outroDuration = Math.max(0, TARGET - videoPlayDuration);

        // ── 5. Looped video segment (video only, no audio) ───────
        // Stream-copy when codec family matches → much faster; re-encode only when needed.
        progress(canStreamCopy ? "Copy video vòng lặp..." : "Mã hóa video vòng lặp...", 15);
        const loopedVideoPath = path.join(tmpDir, `vc_looped_${id}.mp4`);
        tempFiles.push(loopedVideoPath);

        // -stream_loop N means N additional loops after the first play,
        // so N-1 gives exactly fullLoops total plays.
        const loopArgs = canStreamCopy
            ? [
                  "-stream_loop", String(fullLoops - 1),
                  "-i", videoFile,
                  "-t", String(videoPlayDuration),
                  "-an",
                  "-c:v", "copy",
                  "-avoid_negative_ts", "make_zero",
                  "-y", loopedVideoPath,
              ]
            : [
                  "-stream_loop", String(fullLoops - 1),
                  "-i", videoFile,
                  "-t", String(videoPlayDuration),
                  "-an",
                  "-c:v", codec, ...bitrateArgs, "-preset", preset,
                  "-r", String(fps), "-pix_fmt", pixFmt,
                  ...threadArgs,
                  "-y", loopedVideoPath,
              ];

        await runFFmpeg(
            loopArgs,
            videoPlayDuration,
            (pct) => progress(
                canStreamCopy ? "Copy video vòng lặp..." : "Mã hóa video vòng lặp...",
                15 + Math.floor(pct * 35),
            ),
        );

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 6. Create black-screen outro (if needed) ───────────────
        let finalVideoPath = loopedVideoPath;

        if (outroDuration > 0.05) {
            progress("Tạo màn hình đen...", 50);
            const outroPath = path.join(tmpDir, `vc_outro_${id}.mp4`);
            tempFiles.push(outroPath);

            await runFFmpeg(
                [
                    "-f", "lavfi",
                    "-i", `color=c=black:size=${width}x${height}:rate=${fps}`,
                    "-t", String(outroDuration),
                    "-c:v", outroEncoder, ...outroBitrateArgs, "-preset", outroPreset,
                    "-pix_fmt", pixFmt,
                    ...threadArgs,
                    "-y", outroPath,
                ],
                outroDuration,
                (pct) => progress("Tạo màn hình đen...", 50 + Math.floor(pct * 8)),
            );

            if (isCancelled) throw new Error("Task đã bị huỷ");

            // Concat looped video + black screen → full video track
            progress("Ghép video + outro...", 58);
            const vidListPath  = path.join(tmpDir, `vc_vlist_${id}.txt`);
            const fullVideoPath = path.join(tmpDir, `vc_full_${id}.mp4`);
            tempFiles.push(vidListPath, fullVideoPath);

            fs.writeFileSync(
                vidListPath,
                [
                    `file '${loopedVideoPath.replace(/\\/g, "/")}'`,
                    `file '${outroPath.replace(/\\/g, "/")}'`,
                ].join("\n"),
                "utf-8",
            );

            await runFFmpeg(
                [
                    "-f", "concat", "-safe", "0",
                    "-i", vidListPath,
                    "-c", "copy",
                    "-y", fullVideoPath,
                ],
                TARGET,
                (pct) => progress("Ghép video + outro...", 58 + Math.floor(pct * 10)),
            );

            finalVideoPath = fullVideoPath;
        }

        if (isCancelled) throw new Error("Task đã bị huỷ");

        // ── 7. Mux video track + audio track → final output ────────
        progress("Ghép video và audio...", 68);

        const ext         = videoFormat || "mp4";
        const baseName    = path.basename(videoFile, path.extname(videoFile));
        const finalOutput = path.join(outputFolder, `${baseName}_${id}.${ext}`);

        // Add small padding to avoid ffmpeg rounding down duration
        const outputDuration = (TARGET + 0.05).toFixed(2);

        await runFFmpeg(
            [
                "-i", finalVideoPath,
                "-i", concatAudioPath,
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k",
                "-t", outputDuration,
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-y", finalOutput,
            ],
            TARGET,
            (pct) => progress("Ghép video và audio...", 68 + Math.floor(pct * 30)),
        );

        if (isCancelled) throw new Error("Task đã bị huỷ");

        progress("Hoàn tất!", 100);

        cleanupTemp();

        // Build sequence metadata for note
        const videoSequence = [];
        for (let i = 0; i < fullLoops; i++) {
            videoSequence.push({
                filename: path.basename(videoFile),
                duration: i === fullLoops - 1 && srcDuration >= TARGET ? TARGET : srcDuration,
            });
        }
        if (outroDuration > 0.05) {
            videoSequence.push({ filename: "Màn hình đen", duration: outroDuration });
        }

        generateNote(finalOutput, videoSequence, selectedAudios, TARGET);

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