/**
 * PC Nest Speaker - Renderer Process
 * Handles UI interactions, audio capture, and communicates with main process via IPC
 */

// DOM Elements
const statusIndicator = document.getElementById('status-indicator');
const speakerList = document.getElementById('speaker-list');
const discoverBtn = document.getElementById('discover-btn');
const streamBtn = document.getElementById('stream-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const businessLink = document.getElementById('business-link');

// State
let speakers = [];
let selectedSpeaker = null;
let isStreaming = false;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let streamUrl = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Check current status
  const status = await window.api.getStatus();
  if (status.isStreaming) {
    setStreamingState(true);
  }

  // Set up event listeners
  setupEventListeners();
});

function setupEventListeners() {
  discoverBtn.addEventListener('click', discoverSpeakers);
  streamBtn.addEventListener('click', toggleStreaming);
  businessLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal('https://choppedonions.xyz');
  });

  // Listen for status updates from main process
  window.api.onStreamingStatus((status) => {
    setStreamingState(status.isStreaming);
  });

  window.api.onError((error) => {
    showError(error);
  });
}

async function discoverSpeakers() {
  showLoading('Discovering speakers...');

  try {
    const result = await window.api.discoverSpeakers();

    if (result.success) {
      speakers = result.speakers;
      renderSpeakers();
    } else {
      showError(result.error || 'Failed to discover speakers');
    }
  } catch (error) {
    showError(error.message);
  }

  hideLoading();
}

function renderSpeakers() {
  if (speakers.length === 0) {
    speakerList.innerHTML = `
      <div class="empty-state">
        <p>No speakers found on network</p>
        <button class="btn btn-secondary" id="discover-btn">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          Try Again
        </button>
      </div>
    `;
    document.getElementById('discover-btn').addEventListener('click', discoverSpeakers);
    streamBtn.disabled = true;
    return;
  }

  speakerList.innerHTML = speakers.map((speaker, index) => `
    <div class="speaker-item" data-index="${index}">
      <div class="speaker-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="2" width="16" height="20" rx="2"/>
          <circle cx="12" cy="14" r="4"/>
          <line x1="12" y1="6" x2="12" y2="6"/>
        </svg>
      </div>
      <div class="speaker-info">
        <div class="speaker-name">${speaker.name}</div>
        <div class="speaker-model">${speaker.model || 'Chromecast'}</div>
      </div>
      <svg class="speaker-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
  `).join('');

  // Add refresh button at the end
  speakerList.innerHTML += `
    <button class="btn btn-secondary" id="refresh-btn" style="margin-top: 8px;">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 4v6h-6M1 20v-6h6"/>
        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
      </svg>
      Refresh
    </button>
  `;

  // Add click handlers
  speakerList.querySelectorAll('.speaker-item').forEach((item) => {
    item.addEventListener('click', () => selectSpeaker(parseInt(item.dataset.index)));
  });

  document.getElementById('refresh-btn').addEventListener('click', discoverSpeakers);
}

function selectSpeaker(index) {
  selectedSpeaker = speakers[index];

  // Update UI
  speakerList.querySelectorAll('.speaker-item').forEach((item, i) => {
    item.classList.toggle('selected', i === index);
  });

  // Enable stream button
  streamBtn.disabled = false;
}

async function toggleStreaming() {
  if (isStreaming) {
    await stopStreaming();
  } else {
    await startStreaming();
  }
}

/**
 * Get system audio loopback using electron-audio-loopback
 * This captures "what you hear" via WASAPI loopback
 */
async function getLoopbackAudioStream() {
  // Tell main process to enable loopback mode
  await window.api.enableLoopbackAudio();

  // Get a MediaStream with system audio
  // electron-audio-loopback overrides getDisplayMedia to provide loopback
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // Required by Chromium, but we remove the track
    audio: true,
  });

  // Remove video tracks we don't need
  const videoTracks = stream.getVideoTracks();
  videoTracks.forEach(track => {
    track.stop();
    stream.removeTrack(track);
  });

  // Restore normal getDisplayMedia behavior
  await window.api.disableLoopbackAudio();

  return stream;
}

/**
 * Set up audio processing to send PCM to main process
 */
function setupAudioProcessing(stream) {
  audioContext = new AudioContext({
    sampleRate: 48000,
    latencyHint: 'interactive',
  });

  const source = audioContext.createMediaStreamSource(stream);

  // Create a ScriptProcessorNode to get raw audio samples
  // Note: ScriptProcessorNode is deprecated but still works, AudioWorklet would be better
  const bufferSize = 4096;
  audioProcessor = audioContext.createScriptProcessor(bufferSize, 2, 2);

  audioProcessor.onaudioprocess = (e) => {
    if (!isStreaming) return;

    // Get audio data from both channels
    const left = e.inputBuffer.getChannelData(0);
    const right = e.inputBuffer.getChannelData(1);

    // Interleave stereo channels (L R L R L R...)
    const interleaved = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      interleaved[i * 2] = left[i];
      interleaved[i * 2 + 1] = right[i];
    }

    // Send to main process for FFmpeg encoding
    window.api.sendAudioData(interleaved.buffer);
  };

  // Connect the pipeline
  source.connect(audioProcessor);
  audioProcessor.connect(audioContext.destination);
}

async function startStreaming() {
  if (!selectedSpeaker) {
    showError('Please select a speaker first');
    return;
  }

  showLoading('Starting stream...');

  try {
    // 1. Prepare streaming (start HTTP server and FFmpeg)
    const prepResult = await window.api.prepareStreaming();
    if (!prepResult.success) {
      throw new Error(prepResult.error || 'Failed to prepare streaming');
    }
    streamUrl = prepResult.url;

    // 2. Get system audio loopback
    showLoading('Capturing audio...');
    mediaStream = await getLoopbackAudioStream();

    // 3. Set up audio processing to send PCM to main
    setupAudioProcessing(mediaStream);

    // 4. Cast to speaker
    showLoading('Casting to speaker...');
    const castResult = await window.api.castToSpeaker(selectedSpeaker.name, streamUrl);
    if (!castResult.success) {
      throw new Error(castResult.error || 'Failed to cast to speaker');
    }

    setStreamingState(true);
  } catch (error) {
    console.error('Start streaming error:', error);
    showError(error.message || 'Failed to start streaming');

    // Cleanup on error
    await cleanupAudio();
  }

  hideLoading();
}

async function cleanupAudio() {
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
}

async function stopStreaming() {
  showLoading('Stopping stream...');

  try {
    // Stop audio capture
    await cleanupAudio();

    // Stop streaming in main process
    const result = await window.api.stopStreaming();

    if (result.success) {
      setStreamingState(false);
    } else {
      showError(result.error || 'Failed to stop streaming');
    }
  } catch (error) {
    showError(error.message);
  }

  hideLoading();
}

function setStreamingState(streaming) {
  isStreaming = streaming;

  // Update status indicator
  statusIndicator.className = 'status-indicator ' + (streaming ? 'streaming' : 'ready');
  statusIndicator.querySelector('.status-text').textContent = streaming ? 'Streaming' : 'Ready';

  // Update button
  streamBtn.innerHTML = streaming ? `
    <svg class="icon" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16"/>
      <rect x="14" y="4" width="4" height="16"/>
    </svg>
    <span>Stop Streaming</span>
  ` : `
    <svg class="icon" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z"/>
    </svg>
    <span>Start Streaming</span>
  `;
}

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.hidden = false;
}

function hideLoading() {
  loadingOverlay.hidden = true;
}

function showError(message) {
  // Update status to error
  statusIndicator.className = 'status-indicator error';
  statusIndicator.querySelector('.status-text').textContent = message;

  // Reset after 5 seconds
  setTimeout(() => {
    if (!isStreaming) {
      statusIndicator.className = 'status-indicator ready';
      statusIndicator.querySelector('.status-text').textContent = 'Ready';
    }
  }, 5000);
}
