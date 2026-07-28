import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { processVideoJob, cleanupJob } from './videoProcessor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// In-memory job tracker
export const jobs = {};

// Configure Multer for image uploads (stored in temp)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// TTL Cleanup Interval: every 10 minutes, sweep temp folders older than 10 mins
setInterval(() => {
  const now = Date.now();
  Object.keys(jobs).forEach(jobId => {
    if (now - jobs[jobId].createdAt > 10 * 60 * 1000) {
      cleanupJob(jobId);
    }
  });
}, 10 * 60 * 1000);

app.post('/api/generate-video', upload.single('image'), (req, res) => {
  try {
    const { script, language, aspect_ratio, target_length_seconds } = req.body;
    const image = req.file;

    const parsedLength = Number(target_length_seconds) || 10;

    console.log(`[API REQUEST] /api/generate-video received:
      - Script Length: ${script ? script.length : 0} characters
      - Language: ${language}
      - Aspect Ratio: ${aspect_ratio}
      - Target Length: ${parsedLength} seconds
      - Image Uploaded: ${image ? 'Yes (' + image.originalname + ')' : 'No'}
    `);

    const jobId = uuidv4();
    const jobDir = path.join(TEMP_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    let imagePath = null;
    if (image) {
      imagePath = path.join(jobDir, image.filename);
      // Move uploaded image to job directory
      fs.renameSync(image.path, imagePath);
    }

    jobs[jobId] = {
      id: jobId,
      status: 'Initializing job...',
      videoUrl: null,
      jobDir: jobDir,
      createdAt: Date.now(),
      error: null
    };

    // Start background processing
    processVideoJob(jobId, {
      script,
      imagePath,
      language: language || 'en',
      aspect_ratio: aspect_ratio || '16:9',
      target_length_seconds: parsedLength
    }).catch(err => {
      console.error(`Job ${jobId} failed:`, err);
      if (jobs[jobId]) {
        jobs[jobId].status = 'Error';
        jobs[jobId].error = err.message;
      }
    });

    res.json({ jobId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ status: job.status, videoUrl: job.videoUrl, error: job.error });
});

app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'Complete') {
    return res.status(404).send('Video not ready or job not found');
  }

  const finalVideoPath = path.join(job.jobDir, 'final.mp4');
  if (fs.existsSync(finalVideoPath)) {
    res.download(finalVideoPath, 'final_video.mp4', (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      // Immediate cleanup after download completes
      cleanupJob(req.params.jobId);
    });
  } else {
    res.status(404).send('Final video file not found');
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
