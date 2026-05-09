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
            Array.isArray(os.cpus())
                ? os.cpus().length
                : 1,
        );

        const parallelTasks = Math.max(
            1,
            parseInt(String(threadCount || 1), 10) || 1,
        );

        // CPU LIMIT
        const ffmpegThreadLimit = Math.max(
            1,
            Math.min(
                4,
                Math.floor(
                    cpuLogicalCores /
                    Math.max(1, parallelTasks),
                ),
            ),
        );

        const parsedVideoBitrate =
            parseFloat(String(videoBitrate || "")) ||
            8;

        const targetVideoBitrate =
            `${parsedVideoBitrate}M`;

        const activeEncoder = encoder || {
            codec: "libx264",
            vendor: "CPU",
            preset: "veryfast",
            extraArgs: [],
        };

        const instanceId = `${id}_${Date.now()}`;

        const cacheFolder = path.join(
            outputFolder,
            ".cache_encoded",
        );

        fs.mkdirSync(outputFolder, {
            recursive: true,
        });

        fs.mkdirSync(cacheFolder, {
            recursive: true,
        });

        const tmpTxt = (name) => {
            const p = path.join(
                outputFolder,
                `${name}_${instanceId}.txt`,
            );

            tempFiles.push(p);

            return p;
        };

        const tmpTs = (name) => {
            const p = path.join(
                outputFolder,
                `${name}_${instanceId}.ts`,
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
        // AUDIO
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
                audioExts.has(
                    path.extname(f).toLowerCase(),
                ),
            )
            .map((f) => path.join(audioFolder, f))
            .sort();

        if (!audioFiles.length) {
            throw new Error(
                "Không tìm thấy file audio",
            );
        }

        const audioDurations = {};

        await Promise.all(
            audioFiles.map(async (f) => {
                const p = await probeFile(f);

                audioDurations[f] = p.duration;
            }),
        );

        // ─────────────────────────────────────────────────────
        // PROBE VIDEO
        // ─────────────────────────────────────────────────────

        progress("Phân tích video...", 5);

        const probeResult = await probeFile(videoFile);

        const inputDuration = probeResult.duration;

        const codecInfo = getVideoCodecInfo(
            probeResult.streams,
        );

        if (!codecInfo) {
            throw new Error(
                "Không phát hiện được codec video",
            );
        }

        const sourceFps = parseFrameRate(
            codecInfo.r_frame_rate,
        );

        const fpsArg = Number.isInteger(sourceFps)
            ? String(sourceFps)
            : sourceFps.toFixed(3);

        const gopSize = String(
            Math.max(
                30,
                Math.round(sourceFps * 2),
            ),
        );

        const cacheProfile = {
            bitrate: targetVideoBitrate,
            codec: activeEncoder.codec,
            fps: fpsArg,
            gop: gopSize,
        };

        const fileHash = getFileCacheHash(
            videoFile,
            cacheProfile,
        );

        const normalizedFile = path.join(
            cacheFolder,
            `${fileHash}.ts`,
        );

        // ─────────────────────────────────────────────────────
        // NORMALIZE VIDEO
        // ─────────────────────────────────────────────────────

        if (!fs.existsSync(normalizedFile)) {
            progress("Encode video...", 10);

            const encArgs = [
    // INPUT OPTIONS
    "-hwaccel",
    "auto",

    "-i",
    videoFile,

    // STREAM MAP
    "-map",
    "0:v:0?",

    "-map",
    "0:a?",

    "-dn",

    "-sn",

    // VIDEO
    "-c:v",
    activeEncoder.codec,

    "-preset",
    getEncoderPreset(activeEncoder),

    "-b:v",
    targetVideoBitrate,

    "-maxrate",
    targetVideoBitrate,

    "-bufsize",
    `${parsedVideoBitrate * 2}M`,

    "-pix_fmt",
    "yuv420p",

    "-fps_mode",
    "cfr",

    "-r",
    fpsArg,

    "-g",
    gopSize,

    "-keyint_min",
    gopSize,

    "-sc_threshold",
    "0",

    "-force_key_frames",
    "expr:gte(t,n_forced*2)",

    // AUDIO
    "-c:a",
    "aac",

    "-b:a",
    "192k",

    "-ar",
    "48000",

    "-ac",
    "2",

    "-af",
    "aresample=async=1:first_pts=0",

    // PERFORMANCE
    "-threads",
    String(ffmpegThreadLimit),

    // OUTPUT FORMAT
    "-f",
    "mpegts",

    "-y",

    normalizedFile,
];

            await runFFmpeg(
                encArgs,
                inputDuration,
                (pct) => {
                    progress(
                        "Đang encode video...",
                        10 +
                        Math.floor(pct * 35),
                    );
                },
            );
        }

        if (isCancelled) {
            throw new Error("Task đã bị huỷ");
        }

        // ─────────────────────────────────────────────────────
        // RANDOM AUDIO
        // ─────────────────────────────────────────────────────

        const selectedAudios = [...audioFiles]
            .sort(() => Math.random() - 0.5)
            .slice(
                0,
                Math.min(audioCount, audioFiles.length),
            );

        const totalAudioDuration =
            selectedAudios.reduce(
                (sum, f) =>
                    sum + (audioDurations[f] || 0),
                0,
            );

        const TARGET = targetDuration;

        const videoPartDur =
            TARGET - totalAudioDuration;

        if (videoPartDur <= 0) {
            throw new Error(
                "Tổng thời lượng audio vượt target",
            );
        }

        // ─────────────────────────────────────────────────────
        // AUDIO CONCAT TXT
        // ─────────────────────────────────────────────────────

        const audioConcatTxt =
            tmpTxt("audio_concat");

        fs.writeFileSync(
            audioConcatTxt,
            selectedAudios
                .map(
                    (f) =>
                        `file '${f.replace(
                            /'/g,
                            "'\\''",
                        )}'`,
                )
                .join("\n"),
        );

        // ─────────────────────────────────────────────────────
        // BLACK SCREEN TAIL
        // ─────────────────────────────────────────────────────

        progress("Render blackscreen...", 50);

        const tailFile = tmpTs("tail");

        const tailArgs = [
    // AUDIO INPUT
    "-f",
    "concat",

    "-safe",
    "0",

    "-i",
    audioConcatTxt,

    // BLACK VIDEO INPUT
    "-f",
    "lavfi",

    "-i",
    `color=c=black:s=${codecInfo.width}x${codecInfo.height}:r=${fpsArg}`,

    // MAP
    "-map",
    "1:v:0",

    "-map",
    "0:a:0",

    // VIDEO
    "-c:v",
    activeEncoder.codec,

    "-preset",
    activeEncoder.codec.includes("_nvenc")
        ? "p1"
        : "ultrafast",

    "-b:v",
    "400k",

    "-pix_fmt",
    "yuv420p",

    "-fps_mode",
    "cfr",

    "-r",
    fpsArg,

    "-g",
    gopSize,

    "-keyint_min",
    gopSize,

    "-sc_threshold",
    "0",

    "-tune",
    "stillimage",

    // AUDIO
    "-c:a",
    "aac",

    "-b:a",
    "192k",

    "-ar",
    "48000",

    "-ac",
    "2",

    "-af",
    "aresample=async=1:first_pts=0",

    // PERFORMANCE
    "-shortest",

    "-threads",
    "2",

    // OUTPUT
    "-f",
    "mpegts",

    "-muxpreload",
    "0",

    "-muxdelay",
    "0",

    "-y",

    tailFile,
];

        await runFFmpeg(
            tailArgs,
            totalAudioDuration,
            (pct) => {
                progress(
                    "Đang render nhạc...",
                    50 +
                    Math.floor(pct * 20),
                );
            },
        );

        // ─────────────────────────────────────────────────────
        // CONCAT BUILD
        // ─────────────────────────────────────────────────────

        progress("Build concat...", 72);

        const concatList = [];
        const videoSequence = [];

        const normalizedProbe = await probeFile(
            normalizedFile,
        );

        const normalizedDuration =
            normalizedProbe.duration;

        let remainingVideoDur = videoPartDur;

        while (
            remainingVideoDur >=
            normalizedDuration
        ) {
            concatList.push(normalizedFile);

            videoSequence.push({
                filename: path.basename(videoFile),
                duration: normalizedDuration,
            });

            remainingVideoDur -= normalizedDuration;
        }

        // partial remainder

        if (remainingVideoDur > 1) {
            const trimFile = tmpTs("trim");

            const trimArgs = [
                "-ss",
                "0",

                "-t",
                String(remainingVideoDur),

                "-i",
                normalizedFile,

                "-c",
                "copy",

                "-avoid_negative_ts",
                "make_zero",

                "-f",
                "mpegts",

                "-y",

                trimFile,
            ];

            await runFFmpeg(trimArgs);

            concatList.push(trimFile);

            videoSequence.push({
                filename: path.basename(videoFile),
                duration: remainingVideoDur,
            });
        }

        // tail

        concatList.push(tailFile);

        // ─────────────────────────────────────────────────────
        // MASTER CONCAT
        // ─────────────────────────────────────────────────────

        const masterConcatTxt =
            tmpTxt("master_concat");

        fs.writeFileSync(
            masterConcatTxt,
            concatList
                .map(
                    (f) =>
                        `file '${f.replace(
                            /'/g,
                            "'\\''",
                        )}'`,
                )
                .join("\n"),
        );

        // ─────────────────────────────────────────────────────
        // FINAL OUTPUT
        // ─────────────────────────────────────────────────────

        progress("Final render...", 80);

        const videoBaseName = path.basename(
            videoFile,
            path.extname(videoFile),
        );

        const finalOutput = path.join(
            outputFolder,
            `${videoBaseName}_output_${instanceId}.${videoFormat}`,
        );

        const finalArgs = [
    "-fflags",
    "+genpts",

    "-f",
    "concat",

    "-safe",
    "0",

    "-i",
    masterConcatTxt,

    "-c",
    "copy",

    // "-movflags",
    // "+faststart",

    "-muxpreload",
    "0",

    "-muxdelay",
    "0",

    "-avoid_negative_ts",
    "make_zero",

    "-max_interleave_delta",
    "0",

    "-y",

    finalOutput,
];

        await runFFmpeg(
            finalArgs,
            TARGET,
            (pct) => {
                progress(
                    "Đang xuất file...",
                    80 +
                    Math.floor(pct * 19),
                );
            },
        );

        if (isCancelled) {
            throw new Error("Task đã bị huỷ");
        }

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
                videoFile:
                    path.basename(videoFile),
                audioFiles:
                    selectedAudios.map((f) =>
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
        parentPort.off(
            "message",
            messageHandler,
        );
    }
}

run();