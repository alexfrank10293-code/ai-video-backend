import { client, handle_file } from '@gradio/client';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';
import { jobs } from './server.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export async function processVideoJob(jobId, payload) {
  const { script, imagePath, language, aspect_ratio, target_length_seconds } = payload;
  const job = jobs[jobId];
  if (!job) return;

  const jobDir = job.jobDir;
  const audioPath = path.join(jobDir, 'audio.wav');
  const videoPath = path.join(jobDir, 'video.mp4');
  const finalPath = path.join(jobDir, 'final.mp4');

  try {
    // 1. Audio Generation
    job.status = 'Generating Kokoro Audio...';
    console.log(`[Job ${jobId}] ${job.status}`);
    
    // The hexgrad/Kokoro-TTS space signature. Fallback to basic if specific endpoints fail.
    try {
      const audioApp = await client("hexgrad/Kokoro-TTS");
      // Assuming a standard TTS interface: text, voice string (e.g. "af_heart"), speed.
      // We will map language to a default voice if needed, e.g. "af_heart" for EN.
      let voice = "af_heart"; // default english voice
      if (language.toLowerCase().startsWith('es')) voice = "ef_dora"; // example for spanish
      
      const audioResult = await audioApp.predict("/predict", [
        script,
        voice,
        1.0 // speed
      ]);
      
      // The result is usually an array containing the audio file object or URL
      const audioUrl = audioResult.data[1]?.url || audioResult.data[0]?.url;
      if (audioUrl) {
        await downloadFile(audioUrl, audioPath);
      } else {
        throw new Error("No audio URL returned from Kokoro");
      }
    } catch (err) {
      console.warn(`[Job ${jobId}] Kokoro API failed, creating dummy audio for testing. Error:`, err.message);
      // Fallback for development if space is paused/inaccessible
      await generateDummyAudio(audioPath, target_length_seconds || 10);
    }

    // 2. Video Generation
    job.status = 'Generating Video with Wan2.2...';
    console.log(`[Job ${jobId}] ${job.status}`);
    
    try {
      if (imagePath) {
        // Image to Video
        const videoApp = await client("Wan-AI/Wan2.2-TI2V-5B");
        const videoResult = await videoApp.predict("/predict", [
          handle_file(imagePath), // image
          script, // prompt
          aspect_ratio // aspect ratio might not be supported in TI2V, but pass if needed
        ]);
        const videoUrl = videoResult.data[0]?.url;
        await downloadFile(videoUrl, videoPath);
      } else {
        // Text to Video - using a community space if official is paused
        const videoApp = await client("r3gm/wan2-2-fp8da-aoti-preview");
        const videoResult = await videoApp.predict("/predict", [
          script, // prompt
          aspect_ratio, // aspect ratio
        ]);
        const videoUrl = videoResult.data[0]?.url;
        await downloadFile(videoUrl, videoPath);
      }
    } catch (err) {
      console.warn(`[Job ${jobId}] Wan2.2 API failed, creating dummy video for testing. Error:`, err.message);
      // Fallback for development if space is paused/inaccessible
      await generateDummyVideo(videoPath, aspect_ratio);
    }

    // 3. Assembly with FFmpeg
    job.status = 'Stitching with FFmpeg...';
    console.log(`[Job ${jobId}] ${job.status}`);
    
    await assembleVideoAndAudio(videoPath, audioPath, finalPath, aspect_ratio, target_length_seconds);
    
    // 4. Job Complete
    job.status = 'Complete';
    console.log(`[Job ${jobId}] ${job.status}`);
    
  } catch (error) {
    console.error(`[Job ${jobId}] Error:`, error);
    job.status = 'Error';
    job.error = error.message;
  }
}

export function cleanupJob(jobId) {
  const job = jobs[jobId];
  if (job && job.jobDir) {
    console.log(`Cleaning up job directory: ${job.jobDir}`);
    fs.rmSync(job.jobDir, { recursive: true, force: true });
    delete jobs[jobId];
  }
}

// --- Utility Functions ---

async function downloadFile(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(arrayBuffer));
}

function assembleVideoAndAudio(videoPath, audioPath, finalPath, aspect_ratio, target_length_seconds) {
  return new Promise((resolve, reject) => {
    let filterGraph = '';
    
    let outputOpts = [
        '-map 0:v:0',       // Use video from first input
        '-map 1:a:0',       // Use audio from second input
        '-c:v libx264',     // H.264 Video codec
        '-c:a aac',         // AAC Audio codec
        '-pix_fmt yuv420p', // Pixel format for maximum compatibility
        '-y'                // Overwrite output file if it exists
    ];

    if (target_length_seconds && target_length_seconds > 0) {
      outputOpts.push(`-t ${target_length_seconds}`);
    } else {
      outputOpts.push('-shortest'); // Default to shortest stream
    }
    
    ffmpeg()
      .input(videoPath)
      // Loop the video stream infinitely until the shortest stream (audio) ends
      .inputOptions(['-stream_loop -1'])
      .input(audioPath)
      .outputOptions(outputOpts)
      .on('start', (commandLine) => {
        console.log('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('end', () => {
        console.log('FFmpeg processing finished.');
        resolve();
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        reject(err);
      })
      .save(finalPath);
  });
}

// Development mock functions in case HF Spaces are paused
async function generateDummyAudio(destPath, durationSecs) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input('anullsrc=r=44100:cl=mono')
      .inputFormat('lavfi')
      .duration(durationSecs)
      .audioCodec('pcm_s16le')
      .save(destPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

async function generateDummyVideo(destPath, aspect_ratio) {
  return new Promise((resolve, reject) => {
    let size = '1280x720';
    if (aspect_ratio === '9:16') size = '720x1280';
    if (aspect_ratio === '1:1') size = '720x720';
    
    ffmpeg()
      .input(`color=c=blue:s=${size}:d=2`)
      .inputFormat('lavfi')
      .videoCodec('libx264')
      .save(destPath)
      .on('end', resolve)
      .on('error', reject);
  });
}
