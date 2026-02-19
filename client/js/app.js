// Socket.io connection
const socket = io();

// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const notesInput = document.getElementById('notesInput');
const saveNotesBtn = document.getElementById('saveNotesBtn');
const previewPlayer = document.getElementById('previewPlayer');
const noSignal = document.getElementById('noSignal');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const timer = document.getElementById('timer');
const recordingsList = document.getElementById('recordingsList');
const togglePreviewBtn = document.getElementById('togglePreviewBtn');

// State
let currentRecordingId = null;
let timerInterval = null;
let startTime = null;
let previewInterval = null;
let isPreviewEnabled = false;
let wasPreviewEnabledBeforeCapture = false;

// Capture state tracking
const captureState = {
  isCapturing: false
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadRecordings();
  setupEventListeners();
});

function setupEventListeners() {
  startBtn.addEventListener('click', startCapture);
  stopBtn.addEventListener('click', stopCapture);
  saveNotesBtn.addEventListener('click', saveNotes);
  togglePreviewBtn.addEventListener('click', togglePreview);
  
  // Socket.io events
  socket.on('captureState', handleCaptureState);
  socket.on('captureStarted', handleCaptureStarted);
  socket.on('captureEnded', handleCaptureEnded);
  socket.on('captureError', handleCaptureError);
  socket.on('uploadComplete', handleUploadComplete);
  socket.on('uploadError', handleUploadError);
  socket.on('previewStarted', handlePreviewStarted);
  socket.on('previewStopped', handlePreviewStopped);
  socket.on('previewError', handlePreviewError);
}

// Capture Control Functions
async function startCapture() {
  const notes = notesInput.value.trim();
  
  // Track if preview was enabled so we can resume it
  wasPreviewEnabledBeforeCapture = isPreviewEnabled;
  
  try {
    const response = await fetch('/api/capture/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    
    const result = await response.json();
    
    if (result.success) {
      showToast('Capture started successfully', 'success');
      notesInput.value = '';
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Failed to start capture: ' + error.message, 'error');
  }
}

async function stopCapture() {
  try {
    const response = await fetch('/api/capture/stop', {
      method: 'POST'
    });
    
    const result = await response.json();
    
    if (result.success) {
      showToast('Capture stopped successfully', 'success');
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Failed to stop capture: ' + error.message, 'error');
  }
}

// Preview Control Functions
async function togglePreview() {
  if (isPreviewEnabled) {
    await stopPreview();
  } else {
    await startPreview();
  }
}

async function startPreview() {
  try {
    const response = await fetch('/api/preview/start', {
      method: 'POST'
    });
    
    const result = await response.json();
    
    if (result.success) {
      showToast('Preview enabled', 'success');
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Failed to start preview: ' + error.message, 'error');
  }
}

async function stopPreview() {
  try {
    const response = await fetch('/api/preview/stop', {
      method: 'POST'
    });
    
    const result = await response.json();
    
    if (result.success) {
      showToast('Preview disabled', 'success');
    }
  } catch (error) {
    showToast('Failed to stop preview: ' + error.message, 'error');
  }
}

async function saveNotes() {
  if (!currentRecordingId) {
    showToast('No active recording', 'error');
    return;
  }
  
  const notes = notesInput.value.trim();
  
  try {
    const response = await fetch(`/api/capture/${currentRecordingId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    
    const result = await response.json();
    
    if (result.success) {
      showToast('Notes saved successfully', 'success');
    } else {
      showToast('Failed to save notes', 'error');
    }
  } catch (error) {
    showToast('Failed to save notes: ' + error.message, 'error');
  }
}

// Socket.io Event Handlers
function handleCaptureState(state) {
  if (state.isCapturing && state.currentRecording) {
    setCapturingState(true, state.currentRecording);
  } else {
    setCapturingState(false, null);
  }
}

function handleCaptureStarted(data) {
  currentRecordingId = data.recordingId;
  startTime = new Date(data.startTime);
  setCapturingState(true, data);
  startTimer();
  
  // Resume preview polling if it was enabled before capture
  // (The recording FFmpeg process now generates the preview)
  if (wasPreviewEnabledBeforeCapture) {
    startPreviewPolling();
    noSignal.classList.add('hidden');
  }
  
  loadRecordings();
  showToast('Recording started', 'success');
}

function handleCaptureEnded(data) {
  setCapturingState(false, null);
  stopTimer();
  currentRecordingId = null;
  
  // Automatically restart live preview after recording stops
  // This creates a seamless experience - preview continues after recording
  setTimeout(() => {
    startPreview();
  }, 500);
  
  loadRecordings();
  showToast('Recording completed and uploading...', 'info');
}

function handleCaptureError(data) {
  setCapturingState(false, null);
  stopTimer();
  showToast('Capture error: ' + data.error, 'error');
}

function handleUploadComplete(data) {
  showToast('Video uploaded to cloud storage', 'success');
  loadRecordings();
}

function handleUploadError(data) {
  showToast('Upload failed: ' + data.error, 'error');
}

function handlePreviewStarted(data) {
  isPreviewEnabled = true;
  togglePreviewBtn.textContent = 'Disable Preview';
  noSignal.classList.add('hidden');
  startPreviewPolling();
  showToast('Preview started', 'success');
}

function handlePreviewStopped(data) {
  // Only hide preview if we're not currently recording
  // (during recording, the preview comes from the recording FFmpeg process)
  if (!captureState.isCapturing) {
    isPreviewEnabled = false;
    togglePreviewBtn.textContent = 'Enable Preview';
    stopPreviewPolling();
    noSignal.classList.remove('hidden');
    if (previewPlayer) {
      previewPlayer.src = '';
    }
  }
  // If capturing, preview will continue from the recording process
}

function handlePreviewError(data) {
  showToast('Preview error: ' + data.error, 'error');
  isPreviewEnabled = false;
  togglePreviewBtn.textContent = 'Enable Preview';
  stopPreviewPolling();
  noSignal.classList.remove('hidden');
}

// UI Update Functions
function setCapturingState(isCapturing, recording) {
  startBtn.disabled = isCapturing;
  stopBtn.disabled = !isCapturing;

  if (isCapturing) {
    statusIndicator.className = 'status-indicator recording';
    statusText.textContent = 'Recording';
    // Don't hide preview - it stays visible during recording
    currentRecordingId = recording?.recordingId || currentRecordingId;
  } else {
    statusIndicator.className = 'status-indicator ready';
    statusText.textContent = 'Ready';
  }
  
  // Store capturing state for other handlers
  captureState.isCapturing = isCapturing;
}

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (startTime) {
      const elapsed = Date.now() - startTime;
      timer.textContent = formatTime(elapsed);
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timer.textContent = '00:00:00';
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    seconds.toString().padStart(2, '0')
  ].join(':');
}

function loadPreview(recordingId) {
  // Preview is disabled during recording
  console.log('Preview disabled during recording');
}

function startPreviewPolling() {
  if (previewInterval) {
    clearInterval(previewInterval);
  }
  
  const updatePreview = () => {
    const previewUrl = `/api/preview?t=${Date.now()}`;
    
    const img = new Image();
    img.onload = () => {
      previewPlayer.src = previewUrl;
    };
    img.onerror = () => {
      // Preview not ready yet
    };
    img.src = previewUrl;
  };
  
  // Initial load
  updatePreview();
  
  // Continue polling every 500ms
  previewInterval = setInterval(updatePreview, 500);
}

function stopPreviewPolling() {
  if (previewInterval) {
    clearInterval(previewInterval);
    previewInterval = null;
  }
}

async function loadRecordings() {
  try {
    const response = await fetch('/api/recordings');
    const recordings = await response.json();
    renderRecordings(recordings);
  } catch (error) {
    console.error('Failed to load recordings:', error);
  }
}

function renderRecordings(recordings) {
  if (recordings.length === 0) {
    recordingsList.innerHTML = '<p class="no-recordings">No recordings yet</p>';
    return;
  }
  
  recordingsList.innerHTML = recordings.map(recording => {
    const statusClass = getRecordingStatusClass(recording.status, recording.uploadedToRemote);
    const statusText = recording.uploadedToRemote ? 'Uploaded' : recording.status;
    const duration = recording.duration ? formatTime(recording.duration * 1000) : '--:--:--';
    const startTime = recording.startTime ? new Date(recording.startTime).toLocaleString() : 'Unknown';
    const remoteLocation = recording.sftpLocation || recording.s3Location;
    const remoteLabel = recording.sftpLocation ? '🖥️' : recording.s3Location ? '☁️' : '';
    
    return `
      <div class="recording-card">
        <div class="recording-info">
          <h3>Recording ${recording.recordingId.slice(0, 8)}...</h3>
          <div class="recording-meta">
            <span>📅 ${startTime}</span>
            <span>⏱️ ${duration}</span>
            ${remoteLocation ? `<span>${remoteLabel} <a href="${remoteLocation.replace('sftp://', 'http://')}" target="_blank">View File</a></span>` : ''}
          </div>
          ${recording.notes ? `<div class="recording-notes">📝 ${escapeHtml(recording.notes)}</div>` : ''}
        </div>
        <span class="recording-status ${statusClass}">${statusText}</span>
      </div>
    `;
  }).join('');
}

function getRecordingStatusClass(status, uploadedToS3) {
  if (uploadedToS3) return 'uploaded';
  if (status === 'recording') return 'recording';
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'error';
  return '';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.querySelector('.toast-container') || createToastContainer();
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function createToastContainer() {
  const container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}
