/**
 * PC Nest Speaker - Renderer Process
 * Supports three streaming modes:
 * 1. HTTP MP3 (~8 sec latency) - Most reliable
 * 2. WebRTC System Audio (<1 sec) - Captures any audio
 * 3. WebRTC VB-CABLE (<1 sec) - Manual audio routing
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
const audioSourceCard = document.getElementById('audio-source-card');
const debugLog = document.getElementById('debug-log');
const clearLogBtn = document.getElementById('clear-log-btn');
const pingBtn = document.getElementById('ping-btn');
const modeRadios = document.querySelectorAll('input[name="stream-mode"]');
const modeDescription = document.getElementById('mode-description');

// State
let speakers = [];
let audioDevices = [];
let selectedSpeaker = null;
let isStreaming = false;
let streamingMode = 'http'; // 'http', 'webrtc-system', or 'webrtc-vbcable'
let dependencies = {
  vbcable: null,      // null = checking, true = installed, false = missing
  screenCapture: null,
  mediamtx: null,
  ffmpeg: null
};

// Mode descriptions
const modeDescriptions = {
  'http': 'HTTP streaming is the most reliable option. Requires VB-CABLE as your Windows audio output device. ~8 second latency.',
  'webrtc-system': 'WebRTC with system audio capture. Automatically captures any audio playing on your PC. Requires screen-capture-recorder to be installed. <1 second latency.',
  'webrtc-vbcable': 'WebRTC with VB-CABLE. You must set VB-CABLE as your Windows audio output. Most stable low-latency option. <1 second latency.'
};

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

  // Check dependencies first
  await checkDependencies();

  // Check current status
  const status = await window.api.getStatus();
  if (status.isStreaming) {
    setStreamingState(true);
    log('Resumed streaming session', 'success');
  }

  // Set up event listeners
  setupEventListeners();

  // Update UI for default mode
  updateModeUI();
});

function setupEventListeners() {
  discoverBtn.addEventListener('click', discoverDevices);
  streamBtn.addEventListener('click', toggleStreaming);
  pingBtn.addEventListener('click', pingSelectedSpeaker);

  businessLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal('https://choppedonions.xyz');
  });

  // Mode selection
  modeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      streamingMode = e.target.value;
      log(`Streaming mode: ${streamingMode}`);
      updateModeUI();
    });
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

  // Listen for auto-discovered speakers (fired on app startup)
  window.api.onSpeakersDiscovered((discoveredSpeakers) => {
    log(`Auto-discovered ${discoveredSpeakers.length} speakers`, 'success');
    speakers = discoveredSpeakers;
    discoveredSpeakers.forEach(s => log(`  - ${s.name} (${s.model})`));
    renderSpeakers();
  });

  // Listen for auto-discovered audio devices (fired on app startup)
  window.api.onAudioDevicesDiscovered((devices) => {
    log(`Auto-discovered ${devices.length} audio devices`);
    audioDevices = devices;
    devices.forEach(d => log(`  - ${d}`));
    renderAudioDevices();
  });
}

// Check all dependencies
async function checkDependencies() {
  log('Checking dependencies...');

  try {
    const result = await window.api.checkDependencies();
    dependencies = result;

    log(`VB-CABLE: ${result.vbcable ? 'OK' : 'Missing'}`);
    log(`screen-capture-recorder: ${result.screenCapture ? 'OK' : 'Missing'}`);
    log(`MediaMTX: ${result.mediamtx ? 'OK' : 'Bundled'}`);
    log(`FFmpeg: ${result.ffmpeg ? 'OK' : 'Bundled'}`);

    updateDependencyIndicators();
  } catch (error) {
    log(`Dependency check failed: ${error.message}`, 'error');
    // Assume all missing on error
    dependencies = {
      vbcable: false,
      screenCapture: false,
      mediamtx: true, // Bundled
      ffmpeg: true // Bundled
    };
    updateDependencyIndicators();
  }
}

// Update dependency status indicators in UI
function updateDependencyIndicators() {
  // HTTP mode deps
  const httpDeps = document.getElementById('http-deps');
  if (httpDeps) {
    httpDeps.innerHTML = `
      <span class="dep-item ${dependencies.vbcable ? 'dep-ok' : 'dep-missing'}">VB-CABLE</span>
    `;
  }

  // WebRTC System mode deps
  const webrtcSystemDeps = document.getElementById('webrtc-system-deps');
  if (webrtcSystemDeps) {
    webrtcSystemDeps.innerHTML = `
      <span class="dep-item ${dependencies.screenCapture ? 'dep-ok' : 'dep-missing'}">screen-capture</span>
      <span class="dep-item dep-ok">MediaMTX</span>
    `;
  }

  // WebRTC VB-CABLE mode deps
  const webrtcVbcableDeps = document.getElementById('webrtc-vbcable-deps');
  if (webrtcVbcableDeps) {
    webrtcVbcableDeps.innerHTML = `
      <span class="dep-item ${dependencies.vbcable ? 'dep-ok' : 'dep-missing'}">VB-CABLE</span>
      <span class="dep-item dep-ok">MediaMTX</span>
    `;
  }
}

// Update UI based on streaming mode
function updateModeUI() {
  // Update description
  if (modeDescription) {
    modeDescription.textContent = modeDescriptions[streamingMode] || '';

    // Add install buttons if dependencies missing
    const missingDeps = getMissingDepsForMode(streamingMode);
    if (missingDeps.length > 0) {
      const installBtns = missingDeps.map(dep =>
        `<button class="btn btn-secondary install-btn" onclick="installDependency('${dep}')">Install ${dep}</button>`
      ).join(' ');
      modeDescription.innerHTML += `<div style="margin-top: 8px;">${installBtns}</div>`;
    }
  }

  // Always show audio source card - users should see what device is being used
  // WebRTC-system auto-selects virtual-audio-capturer but user can still see it
  if (audioSourceCard) {
    audioSourceCard.style.display = 'block';

    // Update the card title to indicate auto-selection for webrtc-system
    const cardTitle = audioSourceCard.querySelector('.card-title');
    if (cardTitle) {
      if (streamingMode === 'webrtc-system') {
        cardTitle.textContent = 'Audio Source (Auto-selected)';
      } else {
        cardTitle.textContent = 'Audio Source';
      }
    }
  }

  // Re-render audio devices to select the appropriate default for the mode
  if (audioDevices.length > 0) {
    renderAudioDevices();
  }

  updateStreamButtonState();
}

// Get missing dependencies for a given mode
function getMissingDepsForMode(mode) {
  const missing = [];

  switch (mode) {
    case 'http':
      if (!dependencies.vbcable) missing.push('VB-CABLE');
      break;
    case 'webrtc-system':
      if (!dependencies.screenCapture) missing.push('screen-capture-recorder');
      break;
    case 'webrtc-vbcable':
      if (!dependencies.vbcable) missing.push('VB-CABLE');
      break;
  }

  return missing;
}

// Install a dependency
async function installDependency(dep) {
  log(`Installing ${dep}...`);
  showLoading(`Installing ${dep}...`);

  try {
    const result = await window.api.installDependency(dep);

    if (result.success) {
      log(`${dep} installed successfully!`, 'success');
      await checkDependencies(); // Re-check
      updateModeUI();
    } else {
      log(`Failed to install ${dep}: ${result.error}`, 'error');
      showError(result.error || `Failed to install ${dep}`);
    }
  } catch (error) {
    log(`Install error: ${error.message}`, 'error');
    showError(error.message);
  }

  hideLoading();
}

// Make installDependency available globally for onclick
window.installDependency = installDependency;

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

  // Find best default device based on mode
  let defaultIndex = 0;

  if (streamingMode === 'webrtc-vbcable' || streamingMode === 'http') {
    // Prefer VB-CABLE for these modes
    const preferredKeywords = ['cable output', 'vb-audio', 'vb-cable'];
    for (let i = 0; i < audioDevices.length; i++) {
      const deviceLower = audioDevices[i].toLowerCase();
      if (preferredKeywords.some(kw => deviceLower.includes(kw))) {
        defaultIndex = i;
        break;
      }
    }
  } else if (streamingMode === 'webrtc-system') {
    // Prefer virtual-audio-capturer for system capture
    const preferredKeywords = ['virtual-audio-capturer', 'stereo mix', 'what u hear'];
    for (let i = 0; i < audioDevices.length; i++) {
      const deviceLower = audioDevices[i].toLowerCase();
      if (preferredKeywords.some(kw => deviceLower.includes(kw))) {
        defaultIndex = i;
        break;
      }
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
  // Note: Removed auto-ping on selection. User can manually ping with the Test button.
}

function updateStreamButtonState() {
  const hasSpeaker = selectedSpeaker !== null;
  const missingDeps = getMissingDepsForMode(streamingMode);
  const hasRequiredDeps = missingDeps.length === 0;

  // For modes that need audio device selection
  let hasAudioDevice = true;
  if (streamingMode === 'http' || streamingMode === 'webrtc-vbcable') {
    hasAudioDevice = audioDeviceSelect.value && !audioDeviceSelect.disabled;
  }

  streamBtn.disabled = !hasSpeaker || !hasRequiredDeps || !hasAudioDevice;
  pingBtn.disabled = !hasSpeaker;

  // Update button text if deps missing
  if (!hasRequiredDeps) {
    streamBtn.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
      </svg>
      <span>Install Dependencies First</span>
    `;
  } else if (isStreaming) {
    streamBtn.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg>
      <span>Stop Streaming</span>
    `;
  } else {
    streamBtn.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
      </svg>
      <span>Start Streaming</span>
    `;
  }
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

  // Check dependencies for current mode
  const missingDeps = getMissingDepsForMode(streamingMode);
  if (missingDeps.length > 0) {
    log(`Missing dependencies: ${missingDeps.join(', ')}`, 'error');
    showError(`Please install: ${missingDeps.join(', ')}`);
    return;
  }

  let audioDevice = null;
  if (streamingMode === 'http' || streamingMode === 'webrtc-vbcable') {
    audioDevice = audioDeviceSelect.value;
    if (!audioDevice) {
      log('No audio device selected', 'error');
      showError('Please select an audio source');
      return;
    }
  }

  log(`Starting ${streamingMode} stream to ${selectedSpeaker.name}...`);
  if (audioDevice) {
    log(`Audio source: ${audioDevice}`);
  }
  showLoading('Starting stream...');

  try {
    const result = await window.api.startStreaming(
      selectedSpeaker.name,
      audioDevice,
      streamingMode
    );

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
  updateStreamButtonState();
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
