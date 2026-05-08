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

    return crypto.createHash("md5").update(str).digest("hex");
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
                const matches = [
                    ...text.matchAll(/time=(\d+:\d+:\d+\.\d+)/g),
                ];

                if (matches.length > 0) {
                    const lastMatch = matches[matches.length - 1][1];

                    let pct =
                        parseTimeToSeconds(lastMatch) / targetDuration;

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
// main
// ─────────────────────────────────────────────────────────────

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

        const cpuLogicalCores = Math.max(
            1,
            Array.isArray(os.cpus()) ? os.cpus().length : 1,
        );

        const parallelTasks = Math.max(
            1,
            parseInt(String(threadCount || 1), 10) || 1,
        );

        const parsedVideoBitrate =
            parseFloat(String(videoBitrate || "")) || 0;

        const hasTargetVideoBitrate = parsedVideoBitrate > 0;

        const targetVideoBitrate = hasTargetVideoBitrate
            ? `${parsedVideoBitrate}M`
            : null;

        // Split available CPU budget across parallel tasks to avoid CPU saturation.
        const ffmpegThreadLimit = Math.max(
            1,
            Math.floor(Math.max(1, cpuLogicalCores - 1) / parallelTasks),
        );

        const activeEncoder = encoder || {
            codec: "libx264",
            vendor: "CPU",
            preset: "fast",
            extraArgs: [],
        };

        const instanceId = `${id}_${Date.now()}`;

        const cacheFolder = path.join(
            outputFolder,
            ".cache_encoded",
        );

        if (!fs.existsSync(outputFolder)) {
            fs.mkdirSync(outputFolder, {
                recursive: true,
            });
        }

        if (!fs.existsSync(cacheFolder)) {
            fs.mkdirSync(cacheFolder, {
                recursive: true,
            });
        }

        const tmpTxt = (name) => {
            const p = path.join(
                outputFolder,
                `${name}_${instanceId}.txt`,
            );

            tempFiles.push(p);

            return p;
        };

        const tmpMp4 = (name) => {
            const p = path.join(
                outputFolder,
                `${name}_${instanceId}.mp4`,
            );

            tempFiles.push(p);

            return p;
        };

        const cleanup = () => {
            for (const f of tempFiles) {
                try {
                    if (fs.existsSync(f)) {
                        fs.unlinkSync(f);
                    }
                } catch (_) { }
            }
        };

        // ─────────────────────────────────────────────────────
        // audio
        // ─────────────────────────────────────────────────────

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
            .filter((f) =>
                audioExts.has(path.extname(f).toLowerCase()),
            )
            .map((f) => path.join(audioFolder, f))
            .sort();

        if (!audioFiles.length) {
            throw new Error("Không tìm thấy file audio");
        }

        progress(
            `Phân tích video: ${path.basename(videoFile)}...`,
            2,
        );

        const audioDurations = {};

        await Promise.all(
            audioFiles.map(async (f) => {
                const probeResult = await probeFile(f);

                audioDurations[f] = probeResult.duration;
            }),
        );

        // ─────────────────────────────────────────────────────
        // probe video
        // ─────────────────────────────────────────────────────

        progress("Phân tích codec video...", 5);

        const probeResult = await probeFile(videoFile);

        const inputDuration = probeResult.duration;

        const codecInfo = getVideoCodecInfo(
            probeResult.streams,
        );

        if (!codecInfo) {
            throw new Error(
                "Không thể phát hiện video codec",
            );
        }

        const sourceFps = parseFrameRate(codecInfo.r_frame_rate);
        const fpsArg = Number.isInteger(sourceFps)
            ? String(sourceFps)
            : sourceFps.toFixed(3).replace(/\.0+$/, "").replace(/\.$/, "");

        const gopSize = String(Math.max(30, Math.round(sourceFps * 2)));

        const vFormat = videoFormat.toLowerCase();

        const cacheProfile = {
            format: vFormat,
            codec: activeEncoder.codec,
            preset: activeEncoder.preset || null,
            extraArgs: Array.isArray(activeEncoder.extraArgs)
                ? activeEncoder.extraArgs
                : [],
            fps: fpsArg,
            gop: gopSize,
            videoBitrate: hasTargetVideoBitrate
                ? targetVideoBitrate
                : "quality-mode",
        };

        const fileHash = getFileCacheHash(videoFile, cacheProfile);

        const cachedFile = path.join(
            cacheFolder,
            `${fileHash}.${vFormat}`,
        );

        let normalizedVideo = null;

        // ─────────────────────────────────────────────────────
        // cache
        // ─────────────────────────────────────────────────────

        if (fs.existsSync(cachedFile)) {
            const cachedProbe = await probeFile(cachedFile);

            if (cachedProbe.duration > 0) {
                normalizedVideo = {
                    file: cachedFile,
                    duration: cachedProbe.duration,
                };

                progress(
                    `Sử dụng cache: ${path.basename(videoFile)}`,
                    30,
                );
            }
        }

        // ─────────────────────────────────────────────────────
        // normalize video
        // ─────────────────────────────────────────────────────

        if (!normalizedVideo) {
            const encArgs = [
                "-i",
                videoFile,

                "-c:v",
                activeEncoder.codec,
            ];

            // Add preset if encoder supports it
            if (activeEncoder.preset) {
                encArgs.push("-preset", activeEncoder.preset);
            }

            // Add encoder-specific parameters
            if (activeEncoder.extraArgs && activeEncoder.extraArgs.length > 0) {
                encArgs.push(...activeEncoder.extraArgs);
            }

            // Prefer explicit bitrate mode when user sets videoBitrate.
            if (hasTargetVideoBitrate && targetVideoBitrate) {
                encArgs.push(
                    "-b:v",
                    targetVideoBitrate,
                    "-maxrate",
                    targetVideoBitrate,
                    "-bufsize",
                    `${parsedVideoBitrate * 2}M`,
                );
            } else if (activeEncoder.codec === "libx264") {
                encArgs.push("-crf", "28");
            } else if (activeEncoder.codec === "h264_nvenc") {
                // NVIDIA NVENC uses CQ (constant quality)
                encArgs.push("-cq", "23");
            } else if (activeEncoder.codec === "h264_amf") {
                // AMD AMF uses QP (quantization parameter)
                encArgs.push("-qp", "23");
            } else if (activeEncoder.codec === "h264_qsv") {
                // Intel QSV uses global_quality
                encArgs.push("-global_quality", "23");
            }

            encArgs.push("-threads", String(ffmpegThreadLimit));


            // Add keyframe settings
            encArgs.push(
                "-g", gopSize,
                "-pix_fmt", "yuv420p",
                "-r", fpsArg,
                "-c:a", "aac",
                "-b:a", "192k",
                "-ar", "48000",
                "-ac", "2",
                "-movflags", "+faststart",
                "-y",
                cachedFile
            );

            await runFFmpeg(
                encArgs,
                inputDuration,
                (pct) => {
                    progress(
                        `Chuẩn bị video: ${path.basename(
                            videoFile,
                        )}...`,
                        5 + Math.floor(pct * 25),
                    );
                },
            );

            normalizedVideo = {
                file: cachedFile,
                duration: inputDuration,
            };
        }

        if (isCancelled) {
            throw new Error("Task đã bị huỷ");
        }

        // ─────────────────────────────────────────────────────
        // random audio
        // ─────────────────────────────────────────────────────

        const selectedAudios = [...audioFiles]
            .sort(() => Math.random() - 0.5)
            .slice(
                0,
                Math.min(audioCount, audioFiles.length),
            );

        const totalAudioDuration = selectedAudios.reduce(
            (sum, f) => sum + (audioDurations[f] || 0),
            0,
        );

        const TARGET = targetDuration;

        const videoPartDur =
            TARGET - totalAudioDuration;

        if (videoPartDur <= 0) {
            throw new Error(
                "Tổng thời lượng nhạc vượt quá target",
            );
        }

        // ─────────────────────────────────────────────────────
        // audio concat txt
        // ─────────────────────────────────────────────────────

        const audioConcatTxt = tmpTxt("audio_concat");

        fs.writeFileSync(
            audioConcatTxt,
            selectedAudios
                .map(
                    (f) =>
                        `file '${f.replace(/'/g, "'\\''")}'`,
                )
                .join("\n"),
        );

        // ─────────────────────────────────────────────────────
        // blackscreen tail
        // ─────────────────────────────────────────────────────

        progress("Đang render blackscreen...", 35);

        const tailFile = tmpMp4("tail");

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
            `color=c=black:s=${codecInfo.width}x${codecInfo.height}:r=${fpsArg}`,

            "-t",
            String(totalAudioDuration),

            "-map",
            "1:v",

            "-map",
            "0:a",

            "-c:v",
            activeEncoder.codec,
        ];

        // Add preset if encoder supports it
        if (activeEncoder.preset) {
            tailArgs.push("-preset", activeEncoder.preset);
        }

        // Add encoder-specific parameters
        if (activeEncoder.extraArgs && activeEncoder.extraArgs.length > 0) {
            tailArgs.push(...activeEncoder.extraArgs);
        }

        // Add quality/bitrate control
        if (activeEncoder.codec === "libx264") {
            tailArgs.push("-crf", "28");
        } else if (activeEncoder.codec === "h264_nvenc") {
            tailArgs.push("-cq", "23");
        } else if (activeEncoder.codec === "h264_amf") {
            tailArgs.push("-qp", "23");
        } else if (activeEncoder.codec === "h264_qsv") {
            tailArgs.push("-global_quality", "23");
        }

        tailArgs.push("-threads", String(ffmpegThreadLimit));

        // Add remaining parameters
        tailArgs.push(
            "-g", gopSize,
            "-tune", "stillimage",
            "-pix_fmt", "yuv420p",
            "-r", fpsArg,
            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "48000",
            "-ac", "2",
            "-shortest",
            "-movflags", "+faststart",
            "-y",
            tailFile
        );

        await runFFmpeg(
            tailArgs,
            totalAudioDuration,
            (pct) => {
                progress(
                    "Đang render blackscreen + nhạc...",
                    35 + Math.floor(pct * 30),
                );
            },
        );

        if (isCancelled) {
            throw new Error("Task đã bị huỷ");
        }

        // ─────────────────────────────────────────────────────
        // concat build
        // ─────────────────────────────────────────────────────

        progress("Đang build concat...", 66);

        const concatList = [];

        const videoSequence = [];

        // Calculate how much video we need to fill videoPartDur
        let remainingVideoDur = videoPartDur;

        // full loops

        while (remainingVideoDur >= normalizedVideo.duration) {
            concatList.push({
                file: normalizedVideo.file,
                duration: normalizedVideo.duration,
            });

            videoSequence.push({
                filename: path.basename(videoFile),
                duration: normalizedVideo.duration,
            });

            remainingVideoDur -= normalizedVideo.duration;
        }

        // remainder clip (if needed)

        if (remainingVideoDur > 0.2) {
            const trimFile = tmpMp4("trim");

            const trimArgs = [
                "-ss",
                "0",

                "-t",
                String(remainingVideoDur),

                "-i",
                normalizedVideo.file,

                "-c",
                "copy",

                "-avoid_negative_ts",
                "make_zero",

                "-y",

                trimFile,
            ];

            await runFFmpeg(trimArgs);

            concatList.push({
                file: trimFile,
                duration: remainingVideoDur,
            });

            videoSequence.push({
                filename: path.basename(videoFile),
                duration: remainingVideoDur,
            });
        }

        // tail (black screen + audio)

        concatList.push({
            file: tailFile,
            duration: totalAudioDuration,
        });

        // ─────────────────────────────────────────────────────
        // master concat
        // ─────────────────────────────────────────────────────

        const masterConcatTxt =
            tmpTxt("master_concat");

        fs.writeFileSync(
            masterConcatTxt,
            concatList
                .map((seg) => {
                    const escaped = seg.file.replace(/'/g, "'\\''");
                    const durationLine =
                        Number.isFinite(seg.duration) && seg.duration > 0
                            ? `\nduration ${seg.duration.toFixed(6)}`
                            : "";

                    return `file '${escaped}'${durationLine}`;
                })
                .join("\n"),
        );

        // ─────────────────────────────────────────────────────
        // final output
        // ─────────────────────────────────────────────────────

        progress("Đang render output...", 70);

        const videoBaseName = path.basename(
            videoFile,
            path.extname(videoFile),
        );

        const finalOutput = path.join(
            outputFolder,
            `${videoBaseName}_output_${instanceId}.${videoFormat}`,
        );

        const targetTime = formatTime(TARGET);

        const finalArgs = [
            "-fflags",
            "+genpts",

            "-f",
            "concat",

            "-safe",
            "0",

            "-i",
            masterConcatTxt,

            "-c:v",
            "copy",

            "-c:a",
            "copy",

            "-avoid_negative_ts",
            "make_zero",

            "-movflags",
            "+faststart",

            "-y",

            finalOutput,
        ];

        await runFFmpeg(
            finalArgs,
            TARGET,
            (pct) => {
                progress(
                    "Đang ghi output...",
                    70 + Math.floor(pct * 28),
                );
            },
        );

        if (isCancelled) {
            throw new Error("Task đã bị huỷ");
        }

        // ─────────────────────────────────────────────────────
        // done
        // ─────────────────────────────────────────────────────

        progress("Hoàn tất!", 100);

        cleanup();

        generateNote(
            finalOutput,
            videoSequence,
            selectedAudios,
            TARGET,
        );

        send({
            type: "done",
            taskId: task.id,
            result: {
                success: true,
                outputFile: finalOutput,
                encoder: activeEncoder.vendor,
                videoFile: path.basename(videoFile),
                audioFiles: selectedAudios.map((f) =>
                    path.basename(f),
                ),
            },
        });
    } catch (err) {
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

// ─────────────────────────────────────────────────────────────
// metadata note
// ─────────────────────────────────────────────────────────────

function generateNote(
    outputFile,
    videoSequence,
    selectedAudios,
    totalDuration,
) {
    const fmt = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);

        return `${String(h).padStart(2, "0")}:${String(
            m,
        ).padStart(2, "0")}:${String(sec).padStart(
            2,
            "0",
        )}`;
    };

    const noteFile = outputFile.replace(
        /\.[^.]+$/,
        ".txt",
    );

    let c = `
═══════════════════════════════════════════════════════════
VIDEO CONCAT REPORT
═══════════════════════════════════════════════════════════

📹 VIDEO SEQUENCE (Duration: ${fmt(totalDuration)})

`;

    videoSequence.forEach((v, i) => {
        c += `${i + 1}. ${v.filename} [${fmt(
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

run();