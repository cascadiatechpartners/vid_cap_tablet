const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const SftpClient = require('ssh2-sftp-client');
require('dotenv').config({ path: path.join(__dirname, '../config/.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Setup logging
const logFile = path.join(__dirname, '../logs/app.log');
const logDir = path.dirname(logFile);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}\n`;
  fs.appendFileSync(logFile, logLine);
  console.log(logLine.trim());
}

function logError(message, error) {
  log(`${message}: ${error.message}`, 'ERROR');
  if (error.stack) {
    fs.appendFileSync(logFile, error.stack + '\n');
  }
}

// Configuration
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/vid_cap_tablet';
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || 'vid_cap_tablet';
const UPLOADS_DIR = path.join(__dirname, process.env.UPLOADS_DIR || '../uploads');
const PREVIEW_RESOLUTION = process.env.PREVIEW_RESOLUTION || '640x360';
const PREVIEW_FRAMERATE = process.env.PREVIEW_FRAMERATE || 15;
const VIDEO_CAPTURE_DEVICE = process.env.VIDEO_CAPTURE_DEVICE || '/dev/video0';
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || '1920x1080';
const VIDEO_FRAMERATE = process.env.VIDEO_FRAMERATE || 30;
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || '5000k';
const UPLOAD_METHOD = process.env.UPLOAD_METHOD || 'sftp';

// SFTP Configuration
const SFTP_CONFIG = {
  host: process.env.SFTP_HOST || 'localhost',
  port: parseInt(process.env.SFTP_PORT) || 22,
  username: process.env.SFTP_USERNAME || 'tom',
  password: process.env.SFTP_PASSWORD || '',
  privateKey: process.env.SFTP_PRIVATE_KEY_PATH && process.env.SFTP_PRIVATE_KEY_PATH.trim() ? 
    fs.readFileSync(process.env.SFTP_PRIVATE_KEY_PATH) : null,
  uploadDir: process.env.SFTP_UPLOAD_DIR || '/home/tom/videos'
};

// Remove password from console logs for security
const SFTP_CONFIG_SAFE = {
  ...SFTP_CONFIG,
  password: SFTP_CONFIG.password ? '***' : undefined,
  privateKey: SFTP_CONFIG.privateKey ? '***' : undefined
};

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// MongoDB connection
let db;
let videosCollection;
let notesCollection;

async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DATABASE);
    videosCollection = db.collection('videos');
    notesCollection = db.collection('notes');
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('MongoDB connection error:', error);
  }
}

// Capture state
let captureState = {
  isCapturing: false,
  isPreviewing: false,
  currentRecording: null,
  ffmpegProcess: null,
  previewProcess: null
};

// AWS S3 configuration
const AWS = require('aws-sdk');
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current capture state to new client
  socket.emit('captureState', {
    isCapturing: captureState.isCapturing,
    isPreviewing: captureState.isPreviewing,
    currentRecording: captureState.currentRecording
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Check if video device is accessible
async function checkDeviceAccess(devicePath, maxRetries = 3) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    
    const tryAccess = () => {
      attempts++;
      log(`Checking device access: ${devicePath} (attempt ${attempts}/${maxRetries})`);
      
      // Simple check: just verify device file exists and is readable
      fs.access(devicePath, fs.constants.R_OK | fs.constants.W_OK, (err) => {
        if (err) {
          log(`Device check error: ${err.message}`);
          if (attempts < maxRetries) {
            log(`Device not accessible, retrying in 500ms...`);
            setTimeout(tryAccess, 500);
          } else {
            reject(new Error('Device is busy or inaccessible: ' + err.message));
          }
          return;
        }
        
        log('Device access confirmed');
        resolve(true);
      });
    };
    
    tryAccess();
  });
}

// Start preview
async function startPreview() {
  if (captureState.isPreviewing || captureState.isCapturing) {
    throw new Error('Already previewing or capturing');
  }

  const [width, height] = PREVIEW_RESOLUTION.split('x').map(Number);
  const previewDir = path.join(UPLOADS_DIR, 'live_preview');
  
  if (!fs.existsSync(previewDir)) {
    fs.mkdirSync(previewDir, { recursive: true });
  }
  
  const previewPath = path.join(previewDir, 'preview.jpg');
  
  // Flag to track intentional stop
  captureState.previewStopping = false;

  captureState.previewProcess = ffmpeg()
    .input(VIDEO_CAPTURE_DEVICE)
    .inputOptions([
      '-framerate', VIDEO_FRAMERATE,
      '-video_size', VIDEO_RESOLUTION
    ])
    .outputOptions([
      '-vf', `scale=${width}:${height}`,
      '-q:v', '5',
      '-update', '1'
    ])
    .output(previewPath)
    .on('start', () => {
      log('Preview started');
      captureState.isPreviewing = true;
      io.emit('previewStarted', {});
    })
    .on('error', (err) => {
      // Only emit error if not intentionally stopping
      if (!captureState.previewStopping) {
        log('Preview error: ' + err.message);
        captureState.isPreviewing = false;
        io.emit('previewError', { error: err.message });
      } else {
        log('Preview stopped (intentional)');
      }
    })
    .run();

  return { success: true };
}

// Stop preview
async function stopPreview() {
  if (!captureState.isPreviewing || !captureState.previewProcess) {
    return { success: false, error: 'Not previewing' };
  }

  log('Stopping preview...');
  captureState.previewStopping = true;
  
  return new Promise((resolve) => {
    let resolved = false;
    
    captureState.previewProcess.on('end', () => {
      if (!resolved) {
        resolved = true;
        captureState.isPreviewing = false;
        captureState.previewStopping = false;
        log('Preview stopped');
        io.emit('previewStopped', {});
        resolve({ success: true });
      }
    }).on('error', (err) => {
      // Ignore signal 15 errors - that's expected when stopping
      if (err.message && err.message.includes('signal 15')) {
        if (!resolved) {
          resolved = true;
          captureState.isPreviewing = false;
          captureState.previewStopping = false;
          log('Preview stopped (SIGTERM)');
          io.emit('previewStopped', {});
          resolve({ success: true });
        }
        return;
      }
      if (!resolved) {
        resolved = true;
        captureState.isPreviewing = false;
        captureState.previewStopping = false;
        io.emit('previewStopped', {});
        resolve({ success: true });
      }
    });

    captureState.previewProcess.kill('SIGTERM');
    
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        captureState.isPreviewing = false;
        captureState.previewStopping = false;
        resolve({ success: true });
      }
    }, 1000);
  });
}

// Start video capture
async function startCapture(notes = '') {
  if (captureState.isCapturing) {
    throw new Error('Already capturing');
  }

  // Stop live preview if running (we'll use recording preview instead)
  if (captureState.isPreviewing) {
    log('Stopping live preview before capture...');
    await stopPreview();
  }

  // Check if device is accessible before starting
  try {
    await checkDeviceAccess(VIDEO_CAPTURE_DEVICE);
  } catch (err) {
    logError('Device access check failed', err);
    throw new Error('Cannot access video device: ' + err.message + '. Make sure no other application is using it.');
  }

  const recordingId = uuidv4();
  const filename = `${recordingId}.mp4`;
  const filepath = path.join(UPLOADS_DIR, filename);
  const startTime = new Date();

  // Create database record
  const videoRecord = {
    _id: new ObjectId(),
    recordingId,
    filename,
    filepath,
    status: 'recording',
    startTime,
    notes,
    createdAt: new Date(),
    updatedAt: new Date(),
    uploadedToRemote: false
  };

  if (videosCollection) {
    await videosCollection.insertOne(videoRecord);
  }

  captureState.isCapturing = true;
  captureState.currentRecording = videoRecord;
  captureState.stopRequested = false;
  captureState.previewProcess = null;

  // Create preview directory
  const previewDir = path.join(UPLOADS_DIR, `${recordingId}_preview`);
  if (!fs.existsSync(previewDir)) {
    fs.mkdirSync(previewDir, { recursive: true });
  }

  const previewPath = path.join(previewDir, 'preview.jpg');

  // Set up FFmpeg for recording with PREVIEW using filter_complex
  // This creates both the recording AND preview from a single device read
  captureState.ffmpegProcess = ffmpeg()
    .input(VIDEO_CAPTURE_DEVICE)
    .inputOptions([
      '-framerate', VIDEO_FRAMERATE,
      '-video_size', VIDEO_RESOLUTION,
      '-use_wallclock_as_timestamps', '1',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay'
    ])
    // Use filter_complex to split the stream
    .complexFilter([
      // Split input into two streams
      'split=2[rec][prev]',
      // Scale preview to lower resolution
      '[prev]scale=' + PREVIEW_RESOLUTION.replace('x', ':') + '[scaled]'
    ])
    // Main recording output (full quality)
    .output(filepath)
    .outputOptions([
      '-map', '[rec]',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero'
    ])
    // Preview output (low resolution, updates same file)
    .output(previewPath)
    .outputOptions([
      '-map', '[scaled]',
      '-q:v', '5',
      '-update', '1',
      '-fps_mode', 'cfr'
    ])
    .on('start', (commandLine) => {
      log('FFmpeg started: ' + commandLine);
      io.emit('captureStarted', { recordingId, startTime });
    })
    .on('error', async (err, stdout, stderr) => {
      const errorMsg = err.message + '\n\nFFmpeg stderr:\n' + (stderr || 'No stderr output');
      
      // Check if this is a normal termination (signal 15 = SIGTERM from stop button)
      if (stderr && stderr.includes('Exiting normally, received signal 15')) {
        log('FFmpeg stopped normally by user');
        return; // Don't treat as error
      }
      
      logError('FFmpeg error', err);
      captureState.isCapturing = false;

      if (videosCollection) {
        await videosCollection.updateOne(
          { recordingId },
          { $set: { status: 'error', error: errorMsg, updatedAt: new Date() } }
        );
      }

      io.emit('captureError', { error: errorMsg });
    })
    .on('end', async () => {
      // If stop was requested, the stop endpoint handles cleanup
      if (captureState.stopRequested) {
        return;
      }
      
      // FFmpeg ended naturally (e.g., device disconnected)
      log('Recording completed');
      const endTime = new Date();
      captureState.isCapturing = false;

      // Update database record
      if (videosCollection) {
        await videosCollection.updateOne(
          { recordingId },
          {
            $set: {
              status: 'completed',
              endTime,
              duration: (endTime - startTime) / 1000,
              updatedAt: new Date()
            }
          }
        );
      }

      // Upload to remote storage (S3 or SFTP)
      try {
        await uploadFile(filepath, recordingId);
        if (videosCollection) {
          await videosCollection.updateOne(
            { recordingId },
            { $set: { uploadedToRemote: true, updatedAt: new Date() } }
          );
        }
        io.emit('uploadComplete', { recordingId });
      } catch (uploadError) {
        logError('Upload error', uploadError);
        if (videosCollection) {
          await videosCollection.updateOne(
            { recordingId },
            { $set: { uploadedToRemote: false, uploadError: uploadError.message, updatedAt: new Date() } }
          );
        }
        io.emit('uploadError', { error: uploadError.message });
      }

      io.emit('captureEnded', { recordingId, endTime });
      captureState.currentRecording = null;
    })
    .run();

  return { recordingId, startTime };
}

// Stop video capture
async function stopCapture() {
  if (!captureState.isCapturing || !captureState.ffmpegProcess) {
    throw new Error('Not capturing');
  }

  log('Stopping capture...');
  captureState.stopRequested = true;
  
  return new Promise((resolve, reject) => {
    let resolved = false;
    
    // Handle the process ending after kill
    captureState.ffmpegProcess.on('end', () => {
      if (!resolved) {
        resolved = true;
        log('Capture stopped successfully');
        resolve({ success: true });
      }
    }).on('error', (err) => {
      // Ignore signal 15 errors - that's expected
      if (err.message && err.message.includes('signal 15')) {
        if (!resolved) {
          resolved = true;
          log('Capture stopped successfully (SIGTERM)');
          resolve({ success: true });
        }
        return;
      }
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    // Send SIGTERM to gracefully stop FFmpeg
    captureState.ffmpegProcess.kill('SIGTERM');
    
    // Timeout in case end/error doesn't fire
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log('Capture stopped (timeout)');
        resolve({ success: true });
      }
    }, 2000);
  });
}

// Upload to remote storage (S3 or SFTP)
async function uploadFile(filepath, recordingId) {
  if (UPLOAD_METHOD === 'sftp') {
    return await uploadToSFTP(filepath, recordingId);
  } else if (UPLOAD_METHOD === 's3') {
    return await uploadToS3(filepath, recordingId);
  } else {
    // Local only - no upload
    console.log('Local storage only - no upload configured');
    return { Location: filepath };
  }
}

// Upload to SFTP
async function uploadToSFTP(filepath, recordingId) {
  const sftp = new SftpClient();
  const filename = path.basename(filepath);
  const remotePath = `${SFTP_CONFIG.uploadDir}/${recordingId}/${filename}`;
  
  try {
    await sftp.connect({
      host: SFTP_CONFIG.host,
      port: SFTP_CONFIG.port,
      username: SFTP_CONFIG.username,
      password: SFTP_CONFIG.password || undefined,
      privateKey: SFTP_CONFIG.privateKey || undefined
    });
    
    console.log(`Connected to SFTP: ${SFTP_CONFIG.host} as ${SFTP_CONFIG.username}`);
    
    // Create remote directory if it doesn't exist
    const remoteDir = `${SFTP_CONFIG.uploadDir}/${recordingId}`;
    try {
      await sftp.mkdir(remoteDir, true);
    } catch (err) {
      // Directory may already exist, ignore error
      console.log('Remote directory check:', err.message);
    }
    
    // Upload file
    await sftp.put(filepath, remotePath);
    console.log('Uploaded to SFTP:', remotePath);
    
    await sftp.end();
    
    const sftpLocation = `sftp://${SFTP_CONFIG.username}@${SFTP_CONFIG.host}${remotePath}`;
    
    // Update database with SFTP location
    if (videosCollection) {
      await videosCollection.updateOne(
        { recordingId },
        { $set: { sftpLocation, uploadedToRemote: true, updatedAt: new Date() } }
      );
    }
    
    return { Location: sftpLocation };
  } catch (error) {
    console.error('SFTP upload error:', error.message);
    throw error;
  }
}

// Upload to S3
async function uploadToS3(filepath, recordingId) {
  const s3Folder = process.env.AWS_S3_FOLDER || 'videos';
  const filename = path.basename(filepath);
  
  const fileContent = fs.readFileSync(filepath);
  
  const params = {
    Bucket: process.env.AWS_S3_BUCKET,
    Key: `${s3Folder}/${recordingId}/${filename}`,
    Body: fileContent,
    ContentType: 'video/mp4'
  };

  const result = await s3.upload(params).promise();
  console.log('Uploaded to S3:', result.Location);
  
  // Update database with S3 location
  if (videosCollection) {
    await videosCollection.updateOne(
      { recordingId },
      { $set: { s3Location: result.Location, uploadedToRemote: true, updatedAt: new Date() } }
    );
  }

  return result;
}

// Update notes for a recording
async function updateNotes(recordingId, notes) {
  if (videosCollection) {
    const result = await videosCollection.updateOne(
      { recordingId },
      { $set: { notes, updatedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }
  return false;
}

// Get all recordings
async function getRecordings() {
  if (videosCollection) {
    return await videosCollection.find().sort({ createdAt: -1 }).toArray();
  }
  return [];
}

// Get single recording
async function getRecording(recordingId) {
  if (videosCollection) {
    return await videosCollection.findOne({ recordingId });
  }
  return null;
}

// API Routes
app.post('/api/capture/start', async (req, res) => {
  try {
    const { notes } = req.body;
    const result = await startCapture(notes || '');
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/capture/stop', async (req, res) => {
  try {
    const recordingId = captureState.currentRecording?.recordingId;
    const result = await stopCapture();

    // Finalize the recording after successful stop
    if (result.success && recordingId) {
      const endTime = new Date();
      const startTime = captureState.currentRecording?.startTime;

      // Update database record
      if (videosCollection) {
        await videosCollection.updateOne(
          { recordingId },
          {
            $set: {
              status: 'completed',
              endTime,
              duration: startTime ? (endTime - startTime) / 1000 : 0,
              updatedAt: new Date()
            }
          }
        );
      }

      // Upload to remote storage
      const filepath = captureState.currentRecording?.filepath;
      if (filepath) {
        try {
          await uploadFile(filepath, recordingId);
          if (videosCollection) {
            await videosCollection.updateOne(
              { recordingId },
              { $set: { uploadedToRemote: true, updatedAt: new Date() } }
            );
          }
          io.emit('uploadComplete', { recordingId });
        } catch (uploadError) {
          logError('Upload error', uploadError);
          if (videosCollection) {
            await videosCollection.updateOne(
              { recordingId },
              { $set: { uploadedToRemote: false, uploadError: uploadError.message, updatedAt: new Date() } }
            );
          }
          io.emit('uploadError', { error: uploadError.message });
        }
      }

      io.emit('captureEnded', { recordingId, endTime });
      captureState.isCapturing = false;
      captureState.currentRecording = null;
      captureState.stopRequested = false;
    }

    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/capture/:recordingId/notes', async (req, res) => {
  try {
    const { recordingId } = req.params;
    const { notes } = req.body;
    const result = await updateNotes(recordingId, notes);
    res.json({ success: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/recordings', async (req, res) => {
  try {
    const recordings = await getRecordings();
    res.json(recordings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/recordings/:recordingId', async (req, res) => {
  try {
    const recording = await getRecording(req.params.recordingId);
    if (recording) {
      res.json(recording);
    } else {
      res.status(404).json({ error: 'Recording not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Preview control routes
app.post('/api/preview/start', async (req, res) => {
  try {
    const result = await startPreview();
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/preview/stop', async (req, res) => {
  try {
    const result = await stopPreview();
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Preview endpoint - serves the latest preview image
app.get('/api/preview', (req, res) => {
  // If currently recording, use the recording's preview
  if (captureState.isCapturing && captureState.currentRecording) {
    const recordingId = captureState.currentRecording.recordingId;
    const previewPath = path.join(UPLOADS_DIR, `${recordingId}_preview`, 'preview.jpg');
    
    if (fs.existsSync(previewPath)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(previewPath);
      return;
    }
  }
  
  // Otherwise use the live preview (when not recording)
  const previewPath = path.join(UPLOADS_DIR, 'live_preview', 'preview.jpg');
  
  if (fs.existsSync(previewPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(previewPath);
  } else {
    res.status(404).json({ error: 'Preview not available' });
  }
});

// Start server
async function startServer() {
  await connectToMongoDB();
  log(`Starting server on ${HOST}:${PORT}`);
  
  server.listen(PORT, HOST, () => {
    log(`Server running at http://${HOST}:${PORT}`);
    log(`Log file: ${logFile}`);
  });
}

startServer().catch(console.error);
