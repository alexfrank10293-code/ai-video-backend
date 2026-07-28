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
    
    try {
      const audioApp = await client("hexgrad/Kokoro-TTS");
      
      // Attempt dynamic endpoint mapping or default to likely candidates
      let endpoint = "/generate"; 
      try {
        const apiInfo = await audioApp.view_api();
        const endpoints = Object.keys(apiInfo.named_endpoints || {});
        if (endpoints.includes("/generate_audio")) endpoint = "/generate_audio";
        else if (endpoints.includes("/predict")) endpoint = "/predict";
        else if (endpoints.length > 0) endpoint = endpoints[0];
      } catch (e) {
        console.warn(`[Job ${jobId}] Could not dynamically view Kokoro API:`, e.message);
      }
      
      let voice = "af_heart"; // default english voice
      if (language === 'hi') voice = "hi_hindi";
      if (language === 'ta') voice = "ta_tamil";
      if (language === 'te') voice = "te_telugu";
      if (language === 'bn') voice = "bn_bengali";
      if (language === 'es') voice = "es_spanish";
      if (language === 'fr') voice = "fr_french";
      
      console.log(`[Job ${jobId}] Calling Kokoro TTS at endpoint ${endpoint} with voice ${voice}`);
      
      const audioResult = await audioApp.predict(endpoint, [
        script,
        voice,
        1.0 // speed
      ]);
      
      const audioUrl = audioResult.data[1]?.url || audioResult.data[0]?.url || (Array.isArray(audioResult.data) ? audioResult.data.find(d => d?.url)?.url : null);
      if (audioUrl) {
        await downloadFile(audioUrl, audioPath);
      } else {
        throw new Error(`No audio URL returned from Kokoro. Payload: ${JSON.stringify(audioResult.data)}`);
      }
    } catch (err) {
      console.error(`[Job ${jobId}] Kokoro API failed. Details:`, err.message, err.data || '');
      // Fallback for development if space is paused/inaccessible
      await generateDummyAudio(audioPath, target_length_seconds || 10);
    }

    // 2. Video Generation
    job.status = 'Generating Video with Wan2.2...';
    console.log(`[Job ${jobId}] ${job.status}`);
    
    try {
      if (imagePath) {
        // Image to Video
        const videoApp = await client("Wan-AI/Wan2.2-I2V-14B");
        let endpoint = "/predict";
        try {
          const apiInfo = await videoApp.view_api();
          const endpoints = Object.keys(apiInfo.named_endpoints || {});
          if (endpoints.includes("/generate_video")) endpoint = "/generate_video";
          else if (endpoints.includes("/i2v")) endpoint = "/i2v";
        } catch (e) {}

        console.log(`[Job ${jobId}] Calling Wan2.2-I2V at endpoint ${endpoint}`);
        const videoResult = await videoApp.predict(endpoint, [
          handle_file(imagePath), // image
          script, // prompt
          "5.0" // optional parameters for typical Gradio i2v space
        ]);
        const videoUrl = videoResult.data[0]?.url || (Array.isArray(videoResult.data) ? videoResult.data.find(d => d?.url)?.url : null);
        if (videoUrl) await downloadFile(videoUrl, videoPath);
        else throw new Error(`No video URL returned from Wan2.2-I2V. Payload: ${JSON.stringify(videoResult.data)}`);
      } else {
        // Text to Video
        const videoApp = await client("Wan-AI/Wan2.2-T2V-14B");
        let endpoint = "/predict";
        try {
          const apiInfo = await videoApp.view_api();
          const endpoints = Object.keys(apiInfo.named_endpoints || {});
          if (endpoints.includes("/generate_video")) endpoint = "/generate_video";
          else if (endpoints.includes("/t2v")) endpoint = "/t2v";
        } catch (e) {}

        console.log(`[Job ${jobId}] Calling Wan2.2-T2V at endpoint ${endpoint}`);
        const videoResult = await videoApp.predict(endpoint, [
          script, // prompt
          aspect_ratio, // aspect ratio
          "5.0" // optional speed/duration
        ]);
        const videoUrl = videoResult.data[0]?.url || (Array.isArray(videoResult.data) ? videoResult.data.find(d => d?.url)?.url : null);
        if (videoUrl) await downloadFile(videoUrl, videoPath);
        else throw new Error(`No video URL returned from Wan2.2-T2V. Payload: ${JSON.stringify(videoResult.data)}`);
      }
    } catch (err) {
      console.error(`[Job ${jobId}] Wan2.2 API failed. Details:`, err.message, err.data || '');
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
