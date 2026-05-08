const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const { execSync } = require('child_process');

class VideoProcessor {
  constructor() {
    this.isCancelled = false;
    this.ffmpegProcesses = [];
    this.tempFiles = [];
    this.usedVideos = [];
    this.usedAudios = [];
    this.instanceId = Date.now() + '_' + Math.random().toString(36).substr(2, 9); // Unique ID per instance
    this.setupFFmpeg();
  }

  parseTimeToSeconds(time) {
    const parts = time.split(':');

    const h = parseFloat(parts[0]) || 0;
    const m = parseFloat(parts[1]) || 0;
    const s = parseFloat(parts[2]) || 0;

    return h * 3600 + m * 60 + s;
  }

  setupFFmpeg() {
    try {
      ffmpeg.setFfmpegPath(this.findFFmpeg());
      ffmpeg.setFfprobePath(this.findFFprobe());
    } catch (error) {
      console.warn('FFmpeg path not found, using system default:', error.message);
    }
  }

  findFFmpeg() {
    try {
      const result = execSync('where ffmpeg', { encoding: 'utf-8' }).trim();
      return result.split('\n')[0];
    } catch {
      return null;
    }
  }

  findFFprobe() {
    try {
      const result = execSync('where ffprobe', { encoding: 'utf-8' }).trim();
      return result.split('\n')[0];
    } catch {
      return null;
    }
  }

  cancel() {
    this.isCancelled = true;
    this.ffmpegProcesses.forEach(proc => {
      if (proc) {
        try {
          proc.kill();
        } catch (e) {
          console.error('Error killing process:', e);
        }
      }
    });
    this.cleanupTempFiles();
  }

  cleanupTempFiles() {
    this.tempFiles.forEach(file => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (e) {
        console.error('Error deleting temp file:', e);
      }
    });
    this.tempFiles = [];
  }

  async processVideos(config, progressCallback) {
    try {
      this.isCancelled = false;
      this.usedVideos = [];
      this.usedAudios = [];
      const {
        videoFolder,
        audioFolder,
        videoFormat,
        videoBitrate,
        audioCount,
        outputFolder
      } = config;

      if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
      }

      const videoFiles = this.getVideoFiles(videoFolder);
      const audioFiles = this.getAudioFiles(audioFolder);

      if (videoFiles.length === 0) {
        throw new Error('No video files found');
      }

      if (audioFiles.length === 0) {
        throw new Error('No audio files found');
      }

      progressCallback({ stage: 'Analyzing video durations', progress: 10 });

      // Step 1: Get durations of original videos
      const videoDurations = await this.getVideoDurations(videoFiles);

      if (this.isCancelled) return { cancelled: true };

      progressCallback({ stage: 'Selecting random audios', progress: 20 });

      // Step 2: Select random audios
      const selectedAudios = this.selectRandomAudios(audioFiles, audioCount);
      this.usedAudios = selectedAudios.map(f => path.basename(f));

      // Step 3: Calculate audio duration
      const audioDurations = await this.getVideoDurations(selectedAudios);
      const totalAudioDuration = Object.values(audioDurations).reduce((a, b) => a + b, 0);

      if (this.isCancelled) return { cancelled: true };

      progressCallback({ stage: 'Creating optimized concat list', progress: 30 });

      // Target duration: 0:20:59
      const targetDuration = 0 * 3600 + 20 * 60 + 59;

      // Step 4: Create optimized concatenation list
      // Videos loop nhiều lần, sau đó thêm black screen với audio
      const concatData = await this.createOptimizedConcatenationList(
        videoFiles,
        videoDurations,
        totalAudioDuration,
        targetDuration,
        outputFolder
      );

      if (this.isCancelled) return { cancelled: true };

      progressCallback({ stage: 'Encoding final video (single pass)', progress: 50 });

      // Step 5: Concat + Encode in ONE PASS (most efficient)
      // Video loops + black screen with audio at the end
      const finalOutput = await this.concatenateAndEncodeOnce(
        concatData.concatFile,
        selectedAudios,
        outputFolder,
        videoFormat,
        videoBitrate,
        targetDuration,
        totalAudioDuration,
        progressCallback
      );

      progressCallback({ stage: 'Complete', progress: 100 });

      // Step 6: Generate metadata note file
      this.generateMetadataNote(
        finalOutput,
        concatData.videoSequence,
        selectedAudios.map(f => path.basename(f)),
        targetDuration,
        videoFiles,
        audioFiles
      );

      // Cleanup temp files
      this.cleanupTempFiles();

      return {
        success: true,
        outputFile: finalOutput,
        message: 'Video processing completed successfully'
      };
    } catch (error) {
      this.cleanupTempFiles();
      return { error: error.message };
    }
  }

  getVideoFiles(folderPath) {
    const videoExtensions = ['.mp4', '.avi', '.mkv', '.mov', '.flv', '.wmv'];
    return fs.readdirSync(folderPath)
      .filter(file => videoExtensions.includes(path.extname(file).toLowerCase()))
      .map(file => path.join(folderPath, file))
      .sort();
  }

  getAudioFiles(folderPath) {
    const audioExtensions = ['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg'];
    return fs.readdirSync(folderPath)
      .filter(file => audioExtensions.includes(path.extname(file).toLowerCase()))
      .map(file => path.join(folderPath, file))
      .sort();
  }

  async createOptimizedConcatenationList(videoFiles, videoDurations, audioDuration, targetDuration, outputFolder) {
    // Use instance ID for unique filenames
    const concatList = [];
    const videoSequence = [];
    let totalDuration = 0;

    // Calculate total duration of all videos
    const totalVideosDuration = Object.values(videoDurations).reduce((a, b) => a + b, 0);

    if (totalVideosDuration === 0) {
      throw new Error('No valid video durations found');
    }

    // Calculate remaining duration after audio
    const remainingDuration = targetDuration - audioDuration;

    if (remainingDuration <= 0) {
      throw new Error('Audio duration exceeds target duration');
    }

    // Calculate how many full loops we need
    const fullLoops = Math.floor(remainingDuration / totalVideosDuration);
    const remainderDuration = remainingDuration - (fullLoops * totalVideosDuration);

    // Add full loops
    for (let loop = 0; loop < fullLoops; loop++) {
      for (const video of videoFiles) {
        concatList.push(video);
        totalDuration += videoDurations[video];
        videoSequence.push({
          order: videoSequence.length + 1,
          filename: path.basename(video),
          duration: videoDurations[video]
        });
      }
    }

    // Add partial loop to fill remaining time
    if (remainderDuration > 0) {
      let partialDuration = 0;
      for (const video of videoFiles) {
        concatList.push(video);
        const videoDur = videoDurations[video];
        partialDuration += videoDur;
        totalDuration += videoDur;
        videoSequence.push({
          order: videoSequence.length + 1,
          filename: path.basename(video),
          duration: videoDur
        });

        if (partialDuration >= remainderDuration) {
          break;
        }
      }
    }

    // Create concat demuxer file with unique instance ID
    const concatFile = path.join(outputFolder, `concat_list_${this.instanceId}.txt`);
    const concatContent = concatList
      .map(file => `file '${file.replace(/\\/g, '/')}'`)
      .join('\n');

    fs.writeFileSync(concatFile, concatContent);
    this.tempFiles.push(concatFile);

    return {
      concatFile,
      videoSequence,
      totalDuration
    };
  }

  selectRandomAudios(audioFiles, count) {
    const selected = [];
    const available = [...audioFiles];

    for (let i = 0; i < Math.min(count, audioFiles.length); i++) {
      const randomIndex = Math.floor(Math.random() * available.length);
      selected.push(available[randomIndex]);
      available.splice(randomIndex, 1);
    }

    return selected;
  }

  async concatenateAndEncodeOnce(concatFile, audioFiles, outputFolder, format, bitrate, targetDuration, audioDuration, progressCallback) {
    return new Promise((resolve, reject) => {
      // Use instance ID for unique filenames
      const finalOutput = path.join(outputFolder, `final_output_${this.instanceId}.${format}`);

      // Create concat audio file with unique instance ID
      const audioConcatFile = path.join(outputFolder, `audio_concat_list_${this.instanceId}.txt`);
      const audioContent = audioFiles
        .map(file => `file '${file.replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(audioConcatFile, audioContent);
      this.tempFiles.push(audioConcatFile);

      // Format durations
      const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      };

      const videoDuration = targetDuration - audioDuration;
      const videoTime = formatTime(videoDuration);
      const audioTime = formatTime(Math.ceil(audioDuration));
      const targetTime = formatTime(targetDuration);

      // Read concat file to count videos
      const concatContent = fs.readFileSync(concatFile, 'utf-8');
      const videoCount = (concatContent.match(/^file /gm) || []).length;

      const proc = ffmpeg();

      // Add all video inputs from concat list
      const videoFiles = concatContent
        .split('\n')
        .filter(line => line.startsWith('file '))
        .map(line => line.replace(/^file '(.+)'$/, '$1'));

      videoFiles.forEach(file => {
        proc.input(file);
      });

      // Add black screen input
      proc.input('color=c=black:s=1920x1080:r=30')
        .inputOptions(['-f', 'lavfi', `-t ${audioTime}`]);

      // Add audio input
      proc.input(audioConcatFile)
        .inputOptions(['-f', 'concat', '-safe', '0']);

      // Build concat filter for videos + black screen
      const blackIndex = videoFiles.length;
      const audioIndex = videoFiles.length + 1;

      const filterComplex = [
        // Normalize all videos to same format
        ...videoFiles.map((_, i) => `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`),
        // Normalize black screen
        `[${blackIndex}:v]scale=1920:1080,setsar=1,fps=30,format=yuv420p[vblack]`,
        // Concat all videos + black screen
        `${videoFiles.map((_, i) => `[v${i}]`).join('')}[vblack]concat=n=${videoCount + 1}:v=1:a=0[outv]`,
        // Concat audio from videos + music audio
        `${videoFiles.map((_, i) => `[${i}:a]`).join('')}[${audioIndex}:a]concat=n=${videoCount + 1}:v=0:a=1[outa]`
      ];

      proc.complexFilter(filterComplex)
        .map('[outv]')
        .map('[outa]')
        .output(finalOutput)
        .outputOptions([
          `-t ${targetTime}`,           // Exact duration
          `-b:v ${bitrate}M`,
          '-c:v libx264',
          '-preset fast',
          '-profile:v high',
          '-level 4.2',
          '-c:a aac',
          '-b:a 192k',
          '-ar 48000',                  // Standard audio sample rate
          '-ac 2',                      // Stereo
          '-pix_fmt yuv420p',           // Standard pixel format
          '-movflags', '+faststart'     // Enable streaming
        ])
        .on('progress', (progress) => {
          if (!progress.timemark) return;
          const currentSeconds = this.parseTimeToSeconds(progress.timemark);
          const percent = Math.min((currentSeconds / targetDuration) * 100, 100);
          const uiProgress = 50 + Math.floor(percent * 0.5);
          progressCallback({
            stage: `Encoding final video: ${Math.floor(percent)}%`,
            progress: Math.min(uiProgress, 99)
          });
        })
        .on('end', () => {
          this.ffmpegProcesses = this.ffmpegProcesses.filter(p => p !== proc);
          resolve(finalOutput);
        })
        .on('error', (err) => {
          this.ffmpegProcesses = this.ffmpegProcesses.filter(p => p !== proc);
          reject(new Error(`Final encoding failed: ${err.message}`));
        });

      this.ffmpegProcesses.push(proc);
      proc.run();
    });
  }

  getVideoDuration(videoFile) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoFile, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });
  }

  async getVideoDurations(videoFiles) {
    const durations = {};
    for (const file of videoFiles) {
      try {
        durations[file] = await this.getVideoDuration(file);
      } catch (error) {
        console.error(`Error getting duration for ${file}:`, error);
        durations[file] = 0;
      }
    }
    return durations;
  }



  generateMetadataNote(outputFile, videoSequence, audioSequence, totalDuration, allVideoFiles, allAudioFiles) {
    // Extract instance ID from output filename (e.g., final_output_1234567890_abc123xyz.mp4)
    const basename = path.basename(outputFile);
    const match = basename.match(/_([0-9]+_[a-z0-9]+)\./);
    const processId = match ? match[1] : this.instanceId;

    const noteFile = outputFile.replace(/\.[^.]+$/, '.txt');
    const now = new Date();
    const timestampStr = now.toLocaleString('vi-VN');

    // Convert seconds to HH:MM:SS format
    const formatDuration = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    };

    let noteContent = '═══════════════════════════════════════════════════════════\n';
    noteContent += '                    THÔNG TIN VIDEO OUTPUT\n';
    noteContent += '═══════════════════════════════════════════════════════════\n\n';

    noteContent += `📅 Ngày tạo: ${timestampStr}\n`;
    noteContent += `📁 File output: ${basename}\n`;
    noteContent += `🆔 Process ID: ${processId}\n`;
    noteContent += `⏱️  Tổng thời lượng: ${formatDuration(totalDuration)}\n\n`;

    noteContent += '───────────────────────────────────────────────────────────\n';
    noteContent += '📹 THỨ TỰ VIDEO (Video Sequence)\n';
    noteContent += '───────────────────────────────────────────────────────────\n';

    if (videoSequence.length > 0) {
      videoSequence.forEach((video, index) => {
        noteContent += `${index + 1}. ${video.filename}\n`;
        noteContent += `   Thời lượng: ${formatDuration(video.duration)}\n`;
      });
    } else {
      noteContent += 'Không có video nào\n';
    }

    noteContent += '\n───────────────────────────────────────────────────────────\n';
    noteContent += '🎵 THỨ TỰ BÀI HÁT (Audio Sequence)\n';
    noteContent += '───────────────────────────────────────────────────────────\n';

    if (audioSequence && audioSequence.length > 0) {
      audioSequence.forEach((audio, index) => {
        noteContent += `${index + 1}. ${audio}\n`;
      });
    } else {
      noteContent += 'Không có bài hát nào\n';
    }

    noteContent += '\n───────────────────────────────────────────────────────────\n';
    noteContent += '📊 THỐNG KÊ\n';
    noteContent += '───────────────────────────────────────────────────────────\n';
    noteContent += `Tổng số video được sử dụng: ${videoSequence.length}\n`;
    noteContent += `Tổng số bài hát được sử dụng: ${audioSequence ? audioSequence.length : 0}\n`;
    noteContent += `Tổng số video có sẵn: ${allVideoFiles.length}\n`;
    noteContent += `Tổng số bài hát có sẵn: ${allAudioFiles.length}\n`;
    noteContent += '\n═══════════════════════════════════════════════════════════\n';

    try {
      fs.writeFileSync(noteFile, noteContent, 'utf-8');
      console.log(`Metadata note file created: ${noteFile}`);
    } catch (error) {
      console.error(`Error creating metadata note file: ${error.message}`);
    }
  }
}

module.exports = { VideoProcessor };
