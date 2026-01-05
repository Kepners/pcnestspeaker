/**
 * PC Nest Speaker - Renderer Process
 * Uses Python pychromecast for reliable Nest casting
 */

// DOM Elements
const statusIndicator = document.getElementById('status-indicator');
const speakerList = document.getElementById('speaker-list');
const discoverBtn = document.getElementById('discover-btn');
const streamBtn = document.getElementById('stream-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const businessLink = document.getElementById('business-link');
const audioDeviceSelect = document.getElementById('audio-device-select');
const debugLog = document.getElementById('debug-log');
const clearLogBtn = document.getElementById('clear-log-btn');
const pingBtn = document.getElementById('ping-btn');

// State
let speakers = [];
let audioDevices = [];
let selectedSpeaker = null;
let isStreaming = false;

// Debug logging
function log(message, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span>${message}`;
  debugLog.appendChild(entry);
  debugLog.scrollTop = debugLog.scrollHeight;
  console.log(`[${type}] ${message}`);
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  log('App initialized');

  // Check current status
  const status = await window.api.getStatus();
  if (status.isStreaming) {
    setStreamingState(true);
    log('Resumed streaming session', 'success');
  }

  // Set up event listeners
  setupEventListeners();
});

function setupEventListeners() {
  discoverBtn.addEventListener('click', discoverDevices);
  streamBtn.addEventListener('click', toggleStreaming);
  pingBtn.addEventListener('click', pingSelectedSpeaker);

  businessLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal('https://choppedonions.xyz');
  });

  // Clear log button
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      debugLog.innerHTML = '';
      log('Log cleared');
    });
  }

  // Listen for logs from main process
  window.api.onLog((message, type) => {
    log(`[Main] ${message}`, type);
  });

  // Listen for status updates from main process
  window.api.onStreamingStatus((status) => {
    setStreamingState(status.isStreaming);
  });

  window.api.onError((error) => {
    log(`Error: ${error}`, 'error');
    showError(error);
  });
}

async function discoverDevices() {
  log('Starting discovery...');
  showLoading('Discovering devices...');

  try {
    const result = await window.api.discoverDevices();

    if (result.success) {
      speakers = result.speakers || [];
      audioDevices = result.audioDevices || [];

      log(`Found ${speakers.length} speakers`, 'success');
      speakers.forEach(s => log(`  - ${s.name} (${s.model})`));

      log(`Found ${audioDevices.length} audio devices`);
      audioDevices.forEach(d => log(`  - ${d}`));

      renderSpeakers();
      renderAudioDevices();

      if (result.warning) {
        log(`Warning: ${result.warning}`, 'warn');
      }
    } else {
      log(`Discovery failed: ${result.error}`, 'error');
      showError(result.error || 'Failed to discover devices');
    }
  } catch (error) {
    log(`Discovery error: ${error.message}`, 'error');
    showError(error.message);
  }

  hideLoading();
}

function renderSpeakers() {
  if (speakers.length === 0) {
    speakerList.innerHTML = `
      <div class="empty-state">
        <p>No speakers found on network</p>
        <p style="font-size: 12px; opacity: 0.7;">Make sure your Nest/Chromecast is on the same Wi-Fi</p>
      </div>
    `;
    updateStreamButtonState();
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

  // Add click handlers
  speakerList.querySelectorAll('.speaker-item').forEach((item) => {
    item.addEventListener('click', () => selectSpeaker(parseInt(item.dataset.index)));
  });
}

function renderAudioDevices() {
  if (audioDevices.length === 0) {
    audioDeviceSelect.innerHTML = '<option value="">No audio devices found</option>';
    audioDeviceSelect.disabled = true;
    return;
  }

  // Find best default device (prefer virtual-audio-capturer for WASAPI loopback)
  // virtual-audio-capturer captures system audio WITHOUT requiring Windows audio output changes
  let defaultIndex = 0;
  const preferredKeywords = ['virtual-audio-capturer', 'stereo mix', 'what u hear', 'wave out'];
  for (let i = 0; i < audioDevices.length; i++) {
    const deviceLower = audioDevices[i].toLowerCase();
    if (preferredKeywords.some(kw => deviceLower.includes(kw))) {
      defaultIndex = i;
      break;
    }
  }

  audioDeviceSelect.innerHTML = audioDevices.map((device, index) =>
    `<option value="${device}" ${index === defaultIndex ? 'selected' : ''}>${device}</option>`
  ).join('');

  audioDeviceSelect.disabled = false;
  updateStreamButtonState();
}

function selectSpeaker(index) {
  selectedSpeaker = speakers[index];
  log(`Selected speaker: ${selectedSpeaker.name}`);

  // Update UI
  speakerList.querySelectorAll('.speaker-item').forEach((item, i) => {
    item.classList.toggle('selected', i === index);
  });

  updateStreamButtonState();
}

function updateStreamButtonState() {
  const hasAudioDevice = audioDeviceSelect.value && !audioDeviceSelect.disabled;
  const hasSpeaker = selectedSpeaker !== null;
  streamBtn.disabled = !hasSpeaker || !hasAudioDevice;
  pingBtn.disabled = !hasSpeaker; // Ping only requires speaker selection
}

async function toggleStreaming() {
  if (isStreaming) {
    await stopStreaming();
  } else {
    await startStreaming();
  }
}

async function startStreaming() {
  if (!selectedSpeaker) {
    log('No speaker selected', 'error');
    showError('Please select a speaker first');
    return;
  }

  const selectedAudioDevice = audioDeviceSelect.value;
  if (!selectedAudioDevice) {
    log('No audio device selected', 'error');
    showError('Please select an audio source');
    return;
  }

  log(`Starting stream to ${selectedSpeaker.name}...`);
  log(`Audio source: ${selectedAudioDevice}`);
  showLoading('Starting stream...');

  try {
    const result = await window.api.startStreaming(selectedSpeaker.name, selectedAudioDevice);

    if (result.success) {
      setStreamingState(true);
      log(`Streaming to ${selectedSpeaker.name}!`, 'success');
    } else {
      throw new Error(result.error || 'Failed to start streaming');
    }
  } catch (error) {
    log(`Stream failed: ${error.message}`, 'error');
    showError(error.message || 'Failed to start streaming');
  }

  hideLoading();
}

async function stopStreaming() {
  log('Stopping stream...');
  showLoading('Stopping stream...');

  try {
    const speakerName = selectedSpeaker?.name;
    const result = await window.api.stopStreaming(speakerName);

    if (result.success) {
      setStreamingState(false);
      log('Stream stopped', 'success');
    } else {
      log(`Stop failed: ${result.error}`, 'error');
      showError(result.error || 'Failed to stop streaming');
    }
  } catch (error) {
    log(`Stop error: ${error.message}`, 'error');
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

// Test ping - plays a sound on the selected speaker without streaming
async function pingSelectedSpeaker() {
  if (!selectedSpeaker) {
    log('No speaker selected', 'error');
    showError('Please select a speaker first');
    return;
  }

  log(`Pinging ${selectedSpeaker.name}...`);
  showLoading('Testing speaker...');
  pingBtn.disabled = true;

  try {
    const result = await window.api.pingSpeaker(selectedSpeaker.name);

    if (result.success) {
      log('Ping successful!', 'success');
      statusIndicator.className = 'status-indicator ready';
      statusIndicator.querySelector('.status-text').textContent = 'Ping OK!';
    } else {
      log(`Ping failed: ${result.error}`, 'error');
      showError(result.error || 'Ping failed');
    }
  } catch (error) {
    log(`Ping error: ${error.message}`, 'error');
    showError(error.message);
  }

  hideLoading();
  pingBtn.disabled = false;
}
