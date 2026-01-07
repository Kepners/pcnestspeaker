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
const businessLink = document.getElementById('business-link');
const debugLog = document.getElementById('debug-log');
const clearLogBtn = document.getElementById('clear-log-btn');
const autoConnectToggle = document.getElementById('auto-connect-toggle');
const autoStartToggle = document.getElementById('auto-start-toggle');

// Options elements
const optionsCard = document.getElementById('options-card');
const volumeBoostToggle = document.getElementById('volume-boost-toggle');

// Cast mode elements
const castSpeakersBtn = document.getElementById('cast-speakers-btn');
const castAllBtn = document.getElementById('cast-all-btn');
const castModeHint = document.getElementById('cast-mode-hint');
const syncDelayRow = document.getElementById('sync-delay-row');

// Sync delay elements
const syncDelaySlider = document.getElementById('sync-delay-slider');
const syncDelayValue = document.getElementById('sync-delay-value');

// Trial info elements
const trialCard = document.getElementById('trial-card');
const trialTime = document.getElementById('trial-time');
const purchaseBtn = document.getElementById('purchase-btn');

// State
let speakers = [];
let selectedSpeaker = null;
let isStreaming = false;
let streamingMode = 'webrtc-system'; // Default to WebRTC system audio (best latency)
let dependencies = {
  vbcable: null,      // null = checking, true = installed, false = missing
  screenCapture: null,
  mediamtx: null,
  ffmpeg: null
};

// Volume boost state (slider removed - Windows keys control volume)
let volumeBoostEnabled = false; // When true, speaker stays at 100%

// Cast mode state: 'speakers' = Nest only, 'all' = PC + Nest (shows delay)
let castMode = 'speakers';

// Sync delay state
let currentSyncDelayMs = 0;
let syncDelayTimeout = null; // Debounce timer
let audioSyncAvailable = false;
let audioSyncMethod = null;

// Stereo separation state
let stereoMode = {
  enabled: false,
  leftSpeaker: null,   // index of speaker assigned to left channel
  rightSpeaker: null,  // index of speaker assigned to right channel
  streaming: false     // true when stereo streaming is active
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

// Load and apply settings
async function loadSettings() {
  try {
    const settings = await window.api.getSettings();
    log('Settings loaded');

    // Apply auto-connect checkbox state
    if (autoConnectToggle) {
      autoConnectToggle.checked = settings.autoConnect || false;
    }

    // Apply auto-start checkbox state
    if (autoStartToggle) {
      const autoStartResult = await window.api.isAutoStartEnabled();
      autoStartToggle.checked = autoStartResult.enabled || false;
    }

    // Apply volume boost checkbox state
    if (volumeBoostToggle) {
      volumeBoostEnabled = settings.volumeBoost || false;
      volumeBoostToggle.checked = volumeBoostEnabled;
      log(`Volume boost: ${volumeBoostEnabled ? 'ON (100%)' : 'OFF'}`);
    }

    // Apply sync delay slider state
    if (syncDelaySlider && settings.syncDelayMs !== undefined) {
      currentSyncDelayMs = settings.syncDelayMs || 0;
      syncDelaySlider.value = currentSyncDelayMs;
      if (syncDelayValue) {
        syncDelayValue.textContent = `${currentSyncDelayMs}ms`;
      }
      log(`Sync delay: ${currentSyncDelayMs}ms`);
    }

    // Apply cast mode state
    if (settings.castMode) {
      setCastMode(settings.castMode);
    }
  } catch (error) {
    log(`Failed to load settings: ${error.message}`, 'error');
  }
}

// Splash screen handling
function initSplashScreen() {
  const splash = document.getElementById('splash-screen');
  const video = document.getElementById('splash-video');

  if (!splash || !video) return;

  // When video ends, fade out splash screen
  video.addEventListener('ended', () => {
    splash.classList.add('fade-out');
    setTimeout(() => {
      splash.style.display = 'none';
    }, 500);
  });

  // Fallback: If video fails to play, hide splash after 2 seconds
  video.addEventListener('error', () => {
    setTimeout(() => {
      splash.classList.add('fade-out');
      setTimeout(() => {
        splash.style.display = 'none';
      }, 500);
    }, 2000);
  });

  // Start video playback (with audio)
  video.muted = false;
  video.play().catch(() => {
    // Autoplay blocked, try muted
    video.muted = true;
    video.play().catch(() => {
      // Still blocked, hide splash
      splash.classList.add('fade-out');
      setTimeout(() => {
        splash.style.display = 'none';
      }, 500);
    });
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Start splash screen
  initSplashScreen();

  log('App initialized');

  // Load and apply settings
  await loadSettings();

  // Load license status
  await loadLicenseStatus();

  // Update trial display
  await updateTrialDisplay();

  // Update trial display every 30 seconds
  setInterval(updateTrialDisplay, 30000);

  // Check dependencies first
  await checkDependencies();

  // Initialize audio sync (PC speaker delay)
  await initAudioSync();

  // Check current status
  const status = await window.api.getStatus();
  if (status.isStreaming) {
    setStreamingState(true);
    log('Resumed streaming session', 'success');
  }

  // Set up event listeners
  setupEventListeners();

  // Auto-discover speakers on startup
  await discoverDevices();
});

function setupEventListeners() {
  // Window controls (frameless window)
  const minimizeBtn = document.getElementById('minimize-btn');
  const closeBtn = document.getElementById('close-btn');

  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => window.api.minimizeWindow());
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => window.api.closeWindow());
  }

  businessLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal('https://choppedonions.xyz');
  });

  // Bottom tab navigation
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;

      // Remove active class from all tabs and content
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      // Add active class to clicked tab and corresponding content
      btn.classList.add('active');
      const tabContent = document.getElementById(`tab-${tabId}`);
      if (tabContent) {
        tabContent.classList.add('active');
      }
    });
  });

  // Clear log button
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      debugLog.innerHTML = '';
      log('Log cleared');
    });
  }

  // Debug log toggle (click copyright symbol)
  const toggleDebug = document.getElementById('toggle-debug');
  const debugCard = document.getElementById('debug-card');
  if (toggleDebug && debugCard) {
    toggleDebug.addEventListener('click', () => {
      debugCard.style.display = debugCard.style.display === 'none' ? 'block' : 'none';
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
    discoveredSpeakers.forEach(s => log(`  - ${s.name} (${s.model}) [${s.cast_type || 'audio'}]`));
    renderSpeakers();
  });

  // Listen for auto-discovered audio devices (fired on app startup)
  window.api.onAudioDevicesDiscovered((devices) => {
    log(`Auto-discovered ${devices.length} audio devices`);
    devices.forEach(d => log(`  - ${d}`));
  });

  // Settings: Auto-connect toggle
  if (autoConnectToggle) {
    autoConnectToggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      log(`Auto-connect ${enabled ? 'enabled' : 'disabled'}`);
      await window.api.updateSettings({ autoConnect: enabled });
    });
  }

  // Settings: Auto-start toggle
  if (autoStartToggle) {
    autoStartToggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      log(`Toggling auto-start...`);

      try {
        const result = await window.api.toggleAutoStart();
        if (result.success) {
          log(`Auto-start ${result.enabled ? 'enabled' : 'disabled'}`, 'success');
          // Update checkbox to match actual state
          autoStartToggle.checked = result.enabled;
        } else {
          log(`Auto-start toggle failed: ${result.error}`, 'error');
          // Revert checkbox
          autoStartToggle.checked = !enabled;
        }
      } catch (error) {
        log(`Auto-start error: ${error.message}`, 'error');
        // Revert checkbox
        autoStartToggle.checked = !enabled;
      }
    });
  }

  // Settings: Volume boost toggle (signal amplification, not speaker volume)
  if (volumeBoostToggle) {
    volumeBoostToggle.addEventListener('change', async (e) => {
      volumeBoostEnabled = e.target.checked;
      log(`Volume boost ${volumeBoostEnabled ? 'enabled (+25%)' : 'disabled'}`);

      // Save setting
      await window.api.updateSettings({ volumeBoost: volumeBoostEnabled });

      // If currently streaming, restart FFmpeg to apply the boost
      if (isStreaming || stereoMode.streaming) {
        log('Applying boost setting...', 'info');
        try {
          const result = await window.api.restartFfmpeg();
          if (result.success) {
            log(`Boost ${volumeBoostEnabled ? 'activated' : 'deactivated'}`, 'success');
          } else {
            log(`Restart failed: ${result.error}`, 'warning');
          }
        } catch (error) {
          log(`Boost apply failed: ${error.message}`, 'warning');
        }
      }
    });
  }

  // Cast mode toggle buttons
  if (castSpeakersBtn && castAllBtn) {
    castSpeakersBtn.addEventListener('click', () => setCastMode('speakers'));
    castAllBtn.addEventListener('click', () => setCastMode('all'));
  }

  // Listen for auto-connect event from main process
  window.api.onAutoConnect(async (speaker) => {
    log(`Auto-connecting to ${speaker.name}...`, 'info');

    // Find speaker in list
    const speakerIndex = speakers.findIndex(s => s.name === speaker.name);
    if (speakerIndex !== -1) {
      await selectSpeaker(speakerIndex);
    } else {
      log(`Speaker "${speaker.name}" not found`, 'error');
    }
  });

  // Listen for tray stop streaming event
  window.api.onTrayStopStreaming(async () => {
    log('Stop requested from tray menu', 'info');
    if (isStreaming) {
      await stopStreaming();
    } else {
      // Try stopping anyway - backend might have different state
      log('No active stream detected, sending stop anyway...', 'info');
      try {
        await window.api.stopStreaming();
        setStreamingState(false);
      } catch (e) {
        log(`Stop from tray failed: ${e.message}`, 'warning');
      }
    }
  });

  // Purchase button - opens license modal
  if (purchaseBtn) {
    purchaseBtn.addEventListener('click', () => {
      log('Opening license activation...');
      showLicenseModal();
    });
  }
}

// Set cast mode and update UI
function setCastMode(mode) {
  castMode = mode;
  log(`Cast mode: ${mode === 'speakers' ? 'Speakers Only' : 'PC + Speakers'}`);

  // Update button states
  if (castSpeakersBtn && castAllBtn) {
    castSpeakersBtn.classList.toggle('active', mode === 'speakers');
    castAllBtn.classList.toggle('active', mode === 'all');
  }

  // Update hint text
  if (castModeHint) {
    if (mode === 'speakers') {
      castModeHint.textContent = 'Audio only goes to Nest speakers';
    } else {
      castModeHint.textContent = 'PC speakers + Nest (use delay to sync)';
    }
  }

  // Show/hide sync delay row
  if (syncDelayRow) {
    syncDelayRow.style.display = mode === 'all' ? 'flex' : 'none';
  }

  // Save setting
  window.api.updateSettings({ castMode: mode });
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

  speakerList.innerHTML = speakers.map((speaker, index) => {
    const isLeft = stereoMode.leftSpeaker === index;
    const isRight = stereoMode.rightSpeaker === index;
    const isSelected = selectedSpeaker === index;

    // Detect if this is a group, TV, or stereo pair (already outputs stereo)
    // cast_type: "group" = multi-room group OR stereo pair (always stereo)
    // cast_type: "cast" = Chromecast/TV with display (usually stereo)
    // cast_type: "audio" = Nest Mini, Nest Audio (mono unless paired)
    const model = (speaker.model || '').toLowerCase();
    const name = (speaker.name || '').toLowerCase();
    const castType = speaker.cast_type || 'audio';

    // Groups are always treated as stereo (includes stereo pairs)
    // TVs and Shields have stereo output
    const isStereoDevice = castType === 'group' ||
                           model.includes('tv') ||
                           model.includes('shield') ||
                           name.includes('pair');

    // For stereo devices: show "STEREO" indicator with type badge
    // For mono speakers: show L/R buttons for manual stereo separation
    const stereoControls = isStereoDevice
      ? `<div class="stereo-indicator">
           <span class="stereo-badge">${castType === 'group' ? 'GROUP' : 'STEREO'}</span>
           <button class="info-btn" data-index="${index}" title="Stereo info">ⓘ</button>
         </div>`
      : `<div class="stereo-toggles">
           <button class="stereo-toggle ${isLeft ? 'active' : ''}" data-index="${index}" data-channel="left">L</button>
           <button class="stereo-toggle ${isRight ? 'active' : ''}" data-index="${index}" data-channel="right">R</button>
         </div>`;

    return `
    <div class="speaker-item ${isSelected ? 'selected' : ''} ${isLeft ? 'speaker-left' : ''} ${isRight ? 'speaker-right' : ''}" data-index="${index}">
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
      ${stereoControls}
      <svg class="speaker-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
  `}).join('');

  // Add click handlers for speaker selection (main area, not toggles)
  speakerList.querySelectorAll('.speaker-item').forEach((item) => {
    // Left-click = select and ping speaker
    item.addEventListener('click', (e) => {
      // Don't select speaker if clicking on stereo toggles
      if (e.target.classList.contains('stereo-toggle')) return;
      selectSpeaker(parseInt(item.dataset.index));
    });

    // Right-click = start streaming to speaker
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.target.classList.contains('stereo-toggle')) return;
      const index = parseInt(item.dataset.index);
      startStreamingToSpeaker(index);
    });
  });

  // Add click handlers for stereo toggles
  speakerList.querySelectorAll('.stereo-toggle').forEach((toggle) => {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent speaker selection
      const index = parseInt(toggle.dataset.index);
      const channel = toggle.dataset.channel;
      toggleStereoChannel(index, channel);
    });
  });

  // Add click handlers for stereo info buttons
  speakerList.querySelectorAll('.info-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent speaker selection
      showStereoInfoPopup();
    });
  });
}

/**
 * Show popup explaining stereo options for grouped speakers
 */
function showStereoInfoPopup() {
  // Remove existing popup if any
  const existing = document.querySelector('.stereo-info-popup');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.className = 'stereo-info-popup';
  popup.innerHTML = `
    <div class="popup-content">
      <button class="popup-close">&times;</button>
      <h3>Stereo Audio Options</h3>
      <p>This device already outputs <strong>stereo audio</strong> when you click to stream.</p>
      <hr>
      <h4>Want true stereo separation?</h4>
      <p>To send left audio to one speaker and right to another:</p>
      <ol>
        <li><strong>Option A:</strong> Create a "Stereo pair" in the Google Home app (best quality)</li>
        <li><strong>Option B:</strong> Use our L/R buttons on individual Nest speakers</li>
      </ol>
      <p class="popup-note">Note: If you have a Google Home "group", ungroup it first to use individual speakers with L/R buttons.</p>
      <button class="popup-ok">Got it</button>
    </div>
  `;

  document.body.appendChild(popup);

  // Close handlers
  popup.querySelector('.popup-close').addEventListener('click', () => popup.remove());
  popup.querySelector('.popup-ok').addEventListener('click', () => popup.remove());
  popup.addEventListener('click', (e) => {
    if (e.target === popup) popup.remove();
  });
}

/**
 * Toggle stereo channel assignment (L or R) for a speaker
 * Auto-starts streaming when both L and R are selected
 */
async function toggleStereoChannel(index, channel) {
  const speaker = speakers[index];
  log(`Toggle ${channel.toUpperCase()} for "${speaker.name}"`);

  // Ping the speaker immediately so user gets feedback
  try {
    log(`Pinging ${speaker.name}...`, 'info');
    window.api.pingSpeaker(speaker.name).catch(() => {}); // Fire and forget
  } catch (e) {
    // Ignore ping errors
  }

  if (channel === 'left') {
    // Toggle left channel
    if (stereoMode.leftSpeaker === index) {
      // Unassign
      stereoMode.leftSpeaker = null;
      log(`Unassigned left channel from "${speaker.name}"`, 'info');
    } else {
      // Assign left, unassign from other speaker if needed
      if (stereoMode.leftSpeaker !== null) {
        log(`Moving left channel from "${speakers[stereoMode.leftSpeaker].name}" to "${speaker.name}"`, 'info');
      }
      stereoMode.leftSpeaker = index;

      // Can't be both L and R
      if (stereoMode.rightSpeaker === index) {
        stereoMode.rightSpeaker = null;
      }

      log(`Assigned left channel to "${speaker.name}"`, 'success');
    }
  } else {
    // Toggle right channel
    if (stereoMode.rightSpeaker === index) {
      // Unassign
      stereoMode.rightSpeaker = null;
      log(`Unassigned right channel from "${speaker.name}"`, 'info');
    } else {
      // Assign right, unassign from other speaker if needed
      if (stereoMode.rightSpeaker !== null) {
        log(`Moving right channel from "${speakers[stereoMode.rightSpeaker].name}" to "${speaker.name}"`, 'info');
      }
      stereoMode.rightSpeaker = index;

      // Can't be both L and R
      if (stereoMode.leftSpeaker === index) {
        stereoMode.leftSpeaker = null;
      }

      log(`Assigned right channel to "${speaker.name}"`, 'success');
    }
  }

  // Update UI
  renderSpeakers();

  // Auto-start if both L and R are assigned
  if (stereoMode.leftSpeaker !== null && stereoMode.rightSpeaker !== null) {
    if (!stereoMode.streaming) {
      log('Both speakers assigned - auto-starting stereo streaming...', 'success');
      await startStereoStreaming();
    } else {
      // Already streaming - just swap channels dynamically
      log('Swapping channels...', 'info');
      await startStereoStreaming(); // Restart with new assignment
    }
  } else if (stereoMode.streaming) {
    // One speaker unassigned while streaming - stop streaming
    log('Speaker unassigned - stopping stereo streaming...', 'warning');
    await stopStereoStreaming();
  }
}

/**
 * Start stereo separation streaming
 */
async function startStereoStreaming() {
  if (stereoMode.leftSpeaker === null || stereoMode.rightSpeaker === null) {
    log('Error: Both left and right speakers must be assigned', 'error');
    return;
  }

  const leftSpeaker = speakers[stereoMode.leftSpeaker];
  const rightSpeaker = speakers[stereoMode.rightSpeaker];

  log(`Starting stereo streaming: L="${leftSpeaker.name}", R="${rightSpeaker.name}"`, 'info');

  try {
    // Call the IPC handler to start stereo streaming
    const result = await window.api.startStereoStreaming(leftSpeaker, rightSpeaker);

    if (result.success) {
      stereoMode.streaming = true;
      stereoMode.enabled = true;
      log('Stereo streaming started!', 'success');
      renderSpeakers();

      // Show volume control for stereo mode
      // Show volume boost card when streaming
      if (volumeCard) {
        volumeCard.style.display = 'block';
      }
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (error) {
    log(`Stereo streaming failed: ${error.message}`, 'error');
    stereoMode.streaming = false;
    renderSpeakers();
  }
}

/**
 * Stop stereo separation streaming
 */
async function stopStereoStreaming() {
  if (!stereoMode.streaming) return;

  log('Stopping stereo streaming...', 'info');

  const leftSpeaker = stereoMode.leftSpeaker !== null ? speakers[stereoMode.leftSpeaker] : null;
  const rightSpeaker = stereoMode.rightSpeaker !== null ? speakers[stereoMode.rightSpeaker] : null;

  try {
    // Call the IPC handler to stop stereo streaming
    const result = await window.api.stopStereoStreaming(leftSpeaker, rightSpeaker);

    if (result.success) {
      stereoMode.streaming = false;
      log('Stereo streaming stopped', 'success');
      renderSpeakers();

      // Hide volume card if no single speaker is selected
      if (volumeCard && !selectedSpeaker) {
        volumeCard.style.display = 'none';
      }
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (error) {
    log(`Stop failed: ${error.message}`, 'error');
    // Mark as stopped anyway to avoid stuck state
    stereoMode.streaming = false;
    renderSpeakers();
  }
}

function renderAudioDevices() {
  // Audio device selection is automatic (virtual-audio-capturer)
  // This function just logs available devices for debugging
  if (audioDevices.length === 0) {
    log('No audio devices found', 'warning');
    return;
  }
  // Devices are auto-selected in the backend (virtual-audio-capturer preferred)
}

async function selectSpeaker(index) {
  selectedSpeaker = speakers[index];
  log(`Selected speaker: ${selectedSpeaker.name}`);

  // Save as last speaker for auto-connect
  try {
    await window.api.saveLastSpeaker(selectedSpeaker);
  } catch (error) {
    log(`Failed to save speaker: ${error.message}`, 'warning');
  }

  // Update UI
  speakerList.querySelectorAll('.speaker-item').forEach((item, i) => {
    item.classList.toggle('selected', i === index);
  });

  // Show volume boost card when speaker selected
  if (volumeCard) {
    volumeCard.style.display = 'block';
  }

  // Ping the speaker to test connection (plays a sound)
  log(`Pinging ${selectedSpeaker.name}...`);
  try {
    await window.api.pingSpeaker(selectedSpeaker.name);
    log(`Ping sent to ${selectedSpeaker.name}`, 'success');
  } catch (error) {
    log(`Ping failed: ${error.message}`, 'warning');
  }
}

// Start streaming to a speaker (called by right-click)
async function startStreamingToSpeaker(index) {
  const speaker = speakers[index];
  if (!speaker) return;

  // Select the speaker first
  selectedSpeaker = speaker;
  speakerList.querySelectorAll('.speaker-item').forEach((item, i) => {
    item.classList.toggle('selected', i === index);
  });

  // Save as last speaker for auto-connect
  try {
    await window.api.saveLastSpeaker(speaker);
  } catch (error) {
    log(`Failed to save speaker: ${error.message}`, 'warning');
  }

  // If stereo mode is active (L/R assigned), stop it first
  if (stereoMode.streaming || (stereoMode.leftSpeaker !== null && stereoMode.rightSpeaker !== null)) {
    log('Stopping stereo mode for single speaker stream...');
    try {
      const leftSpeaker = stereoMode.leftSpeaker !== null ? speakers[stereoMode.leftSpeaker] : null;
      const rightSpeaker = stereoMode.rightSpeaker !== null ? speakers[stereoMode.rightSpeaker] : null;
      await window.api.stopStereoStreaming(leftSpeaker, rightSpeaker);
      stereoMode.streaming = false;
      stereoMode.enabled = false;
      // Clear stereo assignments
      stereoMode.leftSpeaker = null;
      stereoMode.rightSpeaker = null;
      setStreamingState(false);
      renderSpeakers(); // Re-render to clear L/R buttons
    } catch (error) {
      log(`Stereo stop failed: ${error.message}`, 'warning');
    }
  }

  // If already streaming (regular stream), stop current stream first
  if (isStreaming) {
    log('Stopping current stream...');
    try {
      await window.api.stopStreaming();
      setStreamingState(false);
    } catch (error) {
      log(`Stop failed: ${error.message}`, 'error');
    }
  }

  // Start streaming to selected speaker
  log(`Starting stream to ${speaker.name}...`);

  try {
    const result = await window.api.startStreaming(
      speaker.name,
      null, // no audio device selection needed
      'webrtc-system' // always use WebRTC System Audio
    );

    if (result.success) {
      setStreamingState(true);

      // Update UI to show streaming mode
      const modeText = result.fallback ? '(HTTP fallback)' : '(WebRTC)';
      const modeClass = result.fallback ? 'mode-http' : 'mode-webrtc';

      // Update speaker card with mode indicator
      const speakerCard = speakerList.querySelector('.speaker-item.selected .speaker-info');
      if (speakerCard) {
        const existingMode = speakerCard.querySelector('.streaming-mode');
        if (existingMode) {
          existingMode.remove();
        }

        const modeSpan = document.createElement('div');
        modeSpan.className = `streaming-mode ${modeClass}`;
        modeSpan.textContent = modeText;
        speakerCard.appendChild(modeSpan);
      }

      // Show volume card
      if (volumeCard) {
        volumeCard.style.display = 'block';
      }

      log(`Streaming to ${speaker.name} ${modeText}!`, 'success');
    } else {
      // Check if trial expired
      if (result.trialExpired) {
        log('Trial expired! Please purchase a license to continue.', 'error');
        showError('Your 10-hour trial has expired. Click "Purchase License" to continue using PC Nest Speaker.');
        await updateTrialDisplay();
        return;
      }

      throw new Error(result.error || 'Failed to start streaming');
    }
  } catch (error) {
    log(`Stream failed: ${error.message}`, 'error');
    showError(error.message || 'Failed to start streaming');
  }
}

// Volume is now controlled by Windows volume keys (no slider/mute UI)

// Trial tracking functions
async function updateTrialDisplay() {
  if (!trialCard || !trialTime) return;

  try {
    const usage = await window.api.getUsage();

    // Don't show trial card if user has license
    if (usage.hasLicense) {
      trialCard.style.display = 'none';
      return;
    }

    // Show trial card
    trialCard.style.display = 'block';

    // Update time display
    trialTime.textContent = usage.formattedRemaining;

    // Show purchase button if trial expired or low on time (<1 hour)
    if (usage.trialExpired || usage.remainingSeconds < 3600) {
      if (purchaseBtn) {
        purchaseBtn.style.display = 'block';
      }
    }

    // Change color to warning if low on time
    if (usage.remainingSeconds < 3600 && !usage.trialExpired) {
      trialTime.style.color = '#FF2A6D'; // Warning color
    } else if (usage.trialExpired) {
      trialTime.textContent = 'Trial Expired';
      trialTime.style.color = '#FF2A6D';
    } else {
      trialTime.style.color = 'var(--color-blush)';
    }
  } catch (error) {
    log(`Failed to update trial display: ${error.message}`, 'warning');
  }
}

function updateStreamButtonState() {
  // UI elements that may not exist (removed in simplified UI)
  const streamBtn = document.getElementById('stream-btn');
  const pingBtn = document.getElementById('ping-btn');

  // Only update if elements exist
  if (!streamBtn) return;

  const hasSpeaker = selectedSpeaker !== null;
  const missingDeps = getMissingDepsForMode(streamingMode);
  const hasRequiredDeps = missingDeps.length === 0;

  // Audio device is auto-selected (virtual-audio-capturer)
  const hasAudioDevice = true;

  streamBtn.disabled = !hasSpeaker || !hasRequiredDeps || !hasAudioDevice;
  if (pingBtn) pingBtn.disabled = !hasSpeaker;

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

  // Audio device is auto-selected by backend (virtual-audio-capturer)
  const audioDevice = null;

  log(`Starting ${streamingMode} stream to ${selectedSpeaker.name}...`);
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
  // Update status indicator instead of showing overlay
  statusIndicator.className = 'status-indicator connecting';
  statusIndicator.querySelector('.status-text').textContent = text;
}

function hideLoading() {
  // Reset status indicator to ready state
  statusIndicator.className = 'status-indicator ready';
  statusIndicator.querySelector('.status-text').textContent = 'Ready';
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

// ===================
// Stream Monitor
// ===================

const streamMonitor = document.getElementById('stream-monitor');
const statBitrate = document.getElementById('stat-bitrate');
const statData = document.getElementById('stat-data');
const statConnection = document.getElementById('stat-connection');
const visualizerBars = document.querySelectorAll('.visualizer-bar');

/**
 * Update stream monitor with new stats
 */
function updateStreamMonitor(stats) {
  if (!stats.isActive) {
    // Hide monitor when not streaming
    if (streamMonitor) {
      streamMonitor.style.display = 'none';
    }
    return;
  }

  // Show monitor when streaming
  if (streamMonitor) {
    streamMonitor.style.display = 'block';
  }

  // Update bitrate
  if (statBitrate) {
    statBitrate.textContent = `${stats.bitrate} kbps`;
  }

  // Update data sent
  if (statData) {
    statData.textContent = `${stats.data} MB`;
  }

  // Update connection status with color coding
  if (statConnection) {
    statConnection.textContent = stats.connection;
    statConnection.className = 'stat-value';

    if (stats.connection === 'Active') {
      statConnection.classList.add('good');
    } else if (stats.connection === 'Inactive') {
      statConnection.classList.add('error');
    }
  }

  // Update audio visualizer bars
  if (stats.audioLevels && visualizerBars.length > 0) {
    stats.audioLevels.forEach((level, index) => {
      if (visualizerBars[index]) {
        // Set bar height (level is 0-100)
        visualizerBars[index].style.height = `${level}%`;

        // Add active class if level is significant
        if (level > 30) {
          visualizerBars[index].classList.add('active');
        } else {
          visualizerBars[index].classList.remove('active');
        }
      }
    });
  }
}

// ===================
// License Management
// ===================

// DOM Elements
const licenseCard = document.getElementById('license-card');
const licenseStatus = document.getElementById('license-status');
const licenseStatusExpanded = document.getElementById('license-status-expanded');
const licenseKeyDisplay = document.getElementById('license-key-display');
const licenseModal = document.getElementById('license-modal');
const licenseInput = document.getElementById('license-input');
const licenseError = document.getElementById('license-error');

// State
let hasValidLicense = false;

/**
 * Format license input as user types: PNS-XXXX-XXXX-XXXX-XXXX
 */
function formatLicenseInput(input) {
  // Remove everything except alphanumeric
  let clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Remove PNS prefix if user typed it (we'll add it back)
  if (clean.startsWith('PNS')) {
    clean = clean.slice(3);
  }

  // Split into groups of 4 characters
  const parts = clean.match(/.{1,4}/g) || [];
  const limited = parts.slice(0, 4);

  return 'PNS-' + limited.join('-');
}

/**
 * Mask license key for display: PNS-XXXX-****-****-XXXX
 */
function maskLicenseKey(key) {
  if (!key || key.length < 23) return 'PNS-****-****-****-****';
  // Show: PNS-XXXX-****-****-XXXX
  return key.slice(0, 9) + '-****-****-' + key.slice(-4);
}

/**
 * Show license modal
 */
function showLicenseModal() {
  if (licenseModal) {
    licenseModal.style.display = 'flex';
    if (licenseInput) {
      licenseInput.value = '';
      licenseInput.focus();
    }
    if (licenseError) {
      licenseError.style.display = 'none';
    }
  }
}

/**
 * Hide license modal
 */
function hideLicenseModal() {
  if (licenseModal) {
    licenseModal.style.display = 'none';
  }
}

/**
 * Open purchase link (Stripe payment - will be set up later)
 */
function openPurchaseLink() {
  log('Opening purchase page...');
  window.api.openExternal('https://pcnestspeaker.app/purchase'); // TODO: Update with actual Stripe link
}

/**
 * Open support link
 */
function openSupportLink() {
  window.api.openExternal('mailto:support@choppedonions.xyz?subject=Lost%20License%20Key');
}

/**
 * Activate license key
 */
async function activateLicense() {
  const input = licenseInput ? licenseInput.value.trim() : '';

  if (!input) {
    if (licenseError) {
      licenseError.textContent = 'Please enter a license key';
      licenseError.style.display = 'block';
    }
    return;
  }

  // Format the input
  const formatted = formatLicenseInput(input);

  // Basic client-side validation
  if (formatted.length !== 23) {
    if (licenseError) {
      licenseError.textContent = 'License key is incomplete. Format: PNS-XXXX-XXXX-XXXX-XXXX';
      licenseError.style.display = 'block';
    }
    return;
  }

  // Hide error
  if (licenseError) {
    licenseError.style.display = 'none';
  }

  // Send to main process for validation
  try {
    const result = await window.api.activateLicense(formatted);

    if (result.success) {
      hideLicenseModal();
      updateLicenseDisplay(result.license);
      log('License activated! Enjoy PC Nest Speaker', 'success');

      // Refresh trial display (will hide if licensed)
      await updateTrialDisplay();
    } else {
      if (licenseError) {
        licenseError.textContent = result.error || 'Invalid license key';
        licenseError.style.display = 'block';
      }
      log(`License activation failed: ${result.error}`, 'error');
    }
  } catch (error) {
    if (licenseError) {
      licenseError.textContent = 'Failed to activate license. Please try again.';
      licenseError.style.display = 'block';
    }
    log(`License error: ${error.message}`, 'error');
  }
}

/**
 * Deactivate license
 */
async function deactivateLicense() {
  if (confirm('Deactivate your license? You will need to enter a license key to continue using PC Nest Speaker after the trial.')) {
    try {
      await window.api.deactivateLicense();
      log('License deactivated', 'info');

      // Update UI
      hasValidLicense = false;
      updateLicenseDisplay(null);

      // Refresh trial display
      await updateTrialDisplay();
    } catch (error) {
      log(`Deactivation failed: ${error.message}`, 'error');
    }
  }
}

/**
 * Update license display
 */
function updateLicenseDisplay(license) {
  if (license && license.licenseKey) {
    hasValidLicense = true;

    // Update collapsed view
    if (licenseStatus) {
      licenseStatus.textContent = 'Active ✓';
      licenseStatus.style.color = 'var(--color-blush)';
    }

    // Update expanded view
    if (licenseStatusExpanded) {
      licenseStatusExpanded.textContent = 'Active ✓';
      licenseStatusExpanded.style.color = 'var(--color-blush)';
    }

    if (licenseKeyDisplay) {
      licenseKeyDisplay.textContent = maskLicenseKey(license.licenseKey);
    }
  } else {
    hasValidLicense = false;

    // Update collapsed view
    if (licenseStatus) {
      licenseStatus.textContent = 'Not Active';
      licenseStatus.style.color = '#FF2A6D';
    }

    // Update expanded view
    if (licenseStatusExpanded) {
      licenseStatusExpanded.textContent = 'Not Active';
      licenseStatusExpanded.style.color = '#FF2A6D';
    }

    if (licenseKeyDisplay) {
      licenseKeyDisplay.textContent = 'No license';
    }
  }
}

/**
 * Toggle license card expansion
 */
function toggleLicenseDetails(event) {
  // Don't toggle if clicking buttons
  if (event.target.tagName === 'BUTTON') return;

  if (licenseCard) {
    licenseCard.classList.toggle('expanded');
  }
}

/**
 * Load license status on startup
 */
async function loadLicenseStatus() {
  try {
    const license = await window.api.getLicense();
    updateLicenseDisplay(license);

    // If no license, show the license modal (user must activate before using)
    // But only if trial is also expired
    const usage = await window.api.getUsage();
    if (!license && usage.trialExpired) {
      showLicenseModal();
    }
  } catch (error) {
    log(`Failed to load license: ${error.message}`, 'error');
    updateLicenseDisplay(null);
  }
}

// License input auto-formatting
if (licenseInput) {
  licenseInput.addEventListener('input', (e) => {
    const cursorPos = e.target.selectionStart;
    const oldLen = e.target.value.length;
    e.target.value = formatLicenseInput(e.target.value);
    const newLen = e.target.value.length;

    // Adjust cursor position
    e.target.setSelectionRange(cursorPos + (newLen - oldLen), cursorPos + (newLen - oldLen));
  });

  licenseInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') activateLicense();
  });
}

// Listen for stream stats updates from main process
window.api.onStreamStats(updateStreamMonitor);

// ===================
// Audio Sync (PC Speaker Delay)
// ===================

/**
 * Initialize audio sync system
 * Checks for Windows delay support or Equalizer APO
 */
async function initAudioSync() {
  try {
    const result = await window.api.initAudioSync();
    audioSyncAvailable = result.supported;
    audioSyncMethod = result.method;

    if (result.supported) {
      log(`Audio sync available (${result.method})`, 'success');
    } else if (result.needsInstall) {
      log('Audio sync: Equalizer APO not installed', 'warning');
      // User can install from UI if they want sync feature
    } else {
      log('Audio sync: No delay method available', 'info');
    }

    // Update UI based on availability
    updateSyncDelayUI();
  } catch (error) {
    log(`Audio sync init failed: ${error.message}`, 'error');
    audioSyncAvailable = false;
  }
}

/**
 * Update sync delay UI based on availability
 */
function updateSyncDelayUI() {
  const syncRow = document.querySelector('.sync-delay-row');
  if (!syncRow) return;

  if (!audioSyncAvailable) {
    // Show install prompt instead of slider
    const hint = syncRow.nextElementSibling;
    if (hint && hint.classList.contains('option-hint')) {
      hint.innerHTML = 'Sync requires <a href="#" id="install-apo-link" style="color: var(--color-blush);">Equalizer APO</a> (free). Click to install.';

      // Add click handler for install link
      const installLink = document.getElementById('install-apo-link');
      if (installLink) {
        installLink.addEventListener('click', async (e) => {
          e.preventDefault();
          log('Opening Equalizer APO download...');
          await window.api.installEqualizerApo();
        });
      }
    }

    // Disable slider
    if (syncDelaySlider) {
      syncDelaySlider.disabled = true;
    }
  } else {
    // Enable slider
    if (syncDelaySlider) {
      syncDelaySlider.disabled = false;
    }
  }
}

/**
 * Handle sync delay slider change (with debounce)
 */
function handleSyncDelayChange(delayMs) {
  // Update display immediately
  if (syncDelayValue) {
    syncDelayValue.textContent = `${delayMs}ms`;
  }

  // Debounce the actual delay setting (wait 300ms after user stops sliding)
  if (syncDelayTimeout) {
    clearTimeout(syncDelayTimeout);
  }

  syncDelayTimeout = setTimeout(async () => {
    if (!audioSyncAvailable) {
      log('Audio sync not available', 'warning');
      return;
    }

    try {
      const result = await window.api.setSyncDelay(delayMs);
      if (result.success) {
        currentSyncDelayMs = delayMs;
        log(`PC speaker delay: ${delayMs}ms`, 'success');
      } else {
        log(`Sync delay failed: ${result.error}`, 'error');
      }
    } catch (error) {
      log(`Sync delay error: ${error.message}`, 'error');
    }
  }, 300);
}

// Sync delay slider event listener
if (syncDelaySlider) {
  syncDelaySlider.addEventListener('input', (e) => {
    handleSyncDelayChange(parseInt(e.target.value, 10));
  });
}
