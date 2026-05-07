const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

class VideoProcessor {
  constructor() {
    this.isCancelled = false;
    this.ffmpegProcesses = [];
    this.tempFiles = [];
    this.setupFFmpeg();
  }

  setupFFmpeg() {
    try {
      const ffmpegPath = this.findFFmpeg();
      if (ffmpegPath) {
        ffmpeg.setFfmpegPath(ffmpegPath);
        ffmpeg.setFfprobePath(this.findFFprobe());
      }
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
      const {
        videoFolder,
        audioFolder,
        videoFormat,
        videoBitrate,
        audioCount,
        threadCount,
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

      progressCallback({ stage: 'Processing input videos', progress: 5 });

      // Step 1: Process input videos with thread count
      const processedVideos = await this.processInputVideos(
        videoFiles,
        outputFolder,
        videoFormat,
        videoBitrate,
        threadCount,
        progressCallback
      );

      if (this.isCancelled) return { cancelled: true };

      progressCallback({ stage: 'Creating audio video', progress: 40 });

      // Step 2: Create black screen video with random audio
      const audioVideo = await this.createAudioVideo(
        audioFiles,
        outputFolder,
        audioCount,
        videoFormat,
        videoBitrate
      );

      if (this.isCancelled) return { cancelled: true };

      progressCallback({ stage: 'Calculating durations', progress: 55 });

      // Step 3: Get durations
      const videoDurations = await this.getVideoDurations(processedVideos);
      const audioVideoDuration = await this.getVideoDuration(audioVideo);

      const targetDuration = 49 * 3600 + 59 * 60 + 59; // 49:59:59 in seconds

      progressCallback({ stage: 'Creating final concatenation', progress: 70 });

      // Step 4: Create concatenation list with proper looping
      const concatList = await this.createConcatenationList(
        processedVideos,
        audioVideo,
        videoDurations,
        audioVideoDuration,
        targetDuration,
        outputFolder
      );

      if (this.isCancelled) return { cancelled: true };

      progressCallback({ stage: 'Concatenating videos', progress: 85 });

      // Step 5: Concatenate all videos
      const finalOutput = await this.concatenateVideos(
        concatList,
        outputFolder,
        videoFormat
      );

      progressCallback({ stage: 'Complete', progress: 100 });

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

  async processInputVideos(videoFiles, outputFolder, format, bitrate, threadCount, progressCallback) {
    const processedVideos = [];
    const totalVideos = videoFiles.length;
    let completedVideos = 0;

    // Process videos in batches based on thread count
    for (let i = 0; i < totalVideos; i += threadCount) {
      if (this.isCancelled) break;

      // Get batch of videos to process in parallel
      const batch = videoFiles.slice(i, Math.min(i + threadCount, totalVideos));
      
      // Process all videos in batch in parallel
      const batchPromises = batch.map((videoFile, batchIndex) => {
        const actualIndex = i + batchIndex;
        const fileName = path.basename(videoFile, path.extname(videoFile));
        const outputFile = path.join(outputFolder, `processed_${actualIndex}_${fileName}.${format}`);
        
        return this.convertVideo(videoFile, outputFile, format, bitrate)
          .then(() => {
            completedVideos++;
            const progress = 5 + Math.floor(completedVideos / totalVideos * 35);
            progressCallback({ 
              stage: `Processing videos (${completedVideos}/${totalVideos}) - ${threadCount} threads`, 
              progress 
            });
            return outputFile;
          });
      });

      // Wait for all videos in batch to complete
      const batchResults = await Promise.all(batchPromises);
      processedVideos.push(...batchResults);
      
      // Add to temp files
      batchResults.forEach(file => this.tempFiles.push(file));
    }

    return processedVideos;
  }

  convertVideo(inputFile, outputFile, format, bitrate) {
    return new Promise((resolve, reject) => {
      const proc = ffmpeg(inputFile)
        .output(outputFile)
        .outputOptions([
          `-b:v ${bitrate}M`,
          '-c:v libx264',
          '-preset fast',
          '-c:a aac'
        ])
        .on('end', () => {
          this.ffmpegProcesses = this.ffmpegProcesses.filter(p => p !== proc);
          resolve();
        })
        .on('error', (err) => {
          this.ffmpegProcesses = this.ffmpegProcesses.filter(p => p !== proc);
          reject(new Error(`Video conversion failed: ${err.message}`));
        });

      this.ffmpegProcesses.push(proc);
      proc.run();
    });
  }

  async createAudioVideo(audioFiles, outputFolder, audioCount, format, bitrate) {
    const selectedAudios = this.selectRandomAudios(audioFiles, audioCount);
    const outputFile = path.join(outputFolder, `audio_video.${format}`);
    this.tempFiles.push(outputFile);

    // Create a black screen video with concatenated audio
    return await this.createBlackVideoWithAudio(selectedAudios, outputFile, format, bitrate);
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

  createBlackVideoWithAudio(audioFiles, outputFile, format, bitrate) {
    return new Promise((resolve, reject) => {
      // Create a 1 hour black video with audio
      const proc = ffmpeg()
        .input('color=c=black:s=1920x1080:d=3600')
        .inputOptions(['-f', 'lavfi'])
        .input(audioFiles[0])
        .outputOptions([
          `-b:v ${bitrate}M`,
          '-c:v libx264',
          '-c:a aac',
          '-shortest'
        ])
        .output(outputFile)
        .on('end', () => {
          this.ffmpegProcesses = this.ffmpegProcesses.filter(p => p !== proc);
          resolve(outputFile);
        })
        .on('error', (err) => {
          this.ffmpegProcesses = this.ffmpegProcesses.filter(p => p !== proc);
          reject(new Error(`Audio video creation failed: ${err.message}`));
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

  async createConcatenationList(processedVideos, audioVideo, videoDurations, audioVideoDuration, targetDuration, outputFolder) {
    const concatList = [];
    let totalDuration = 0;

    // Calculate total duration of all processed videos
    const totalVideosDuration = Object.values(videoDurations).reduce((a, b) => a + b, 0);

    if (totalVideosDuration === 0) {
      throw new Error('No valid video durations found');
    }

    // Calculate how many times to loop all videos
    const remainingDuration = targetDuration - audioVideoDuration;
    const loopCount = Math.ceil(remainingDuration / totalVideosDuration);

    // Add videos to concat list
    for (let loop = 0; loop < loopCount; loop++) {
      for (const video of processedVideos) {
        concatList.push(video);
        totalDuration += videoDurations[video];

        if (totalDuration >= remainingDuration) {
          break;
        }
      }

      if (totalDuration >= remainingDuration) {
        break;
      }
    }

    // Add audio video at the end
    concatList.push(audioVideo);
    totalDuration += audioVideoDuration;

    // Create concat demuxer file
    const concatFile = path.join(outputFolder, 'concat_list.txt');
    const concatContent = concatList
      .map(file => `file '${file.replace(/\\/g, '/')}'`)
      .join('\n');

    fs.writeFileSync(concatFile, concatContent);
    this.tempFiles.push(concatFile);

    return concatFile;
  }

  concatenateVideos(concatFile, outputFolder, format) {
    return new Promise((resolve, reject) => {
      const finalOutput = path.join(outputFolder, `final_output.${format}`);

      const proc = ffmpeg()
        .input(concatFile)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .output(finalOutput)
        .outputOptions(['-c', 'copy'])
        .on('end', () => {
          this.ffmpegProcesses = this.ffmpegProcesses.filter(p => p !== proc);
          resolve(finalOutput);
        })
        .on('error', (err) => {
          this.ffmpegProcesses = this.ffmpegProcesses.filter(p => p !== proc);
          reject(new Error(`Concatenation failed: ${err.message}`));
        });

      this.ffmpegProcesses.push(proc);
      proc.run();
    });
  }
}

module.exports = { VideoProcessor };
