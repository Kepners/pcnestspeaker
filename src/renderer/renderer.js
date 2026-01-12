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

// PC Audio toggle (simplified from cast mode)
const pcAudioToggle = document.getElementById('pc-audio-toggle');
const syncCalibrateRow = document.getElementById('sync-calibrate-row');
const apoStatus = document.getElementById('apo-status');
const apoDevicesText = document.getElementById('apo-devices-text');
const launchApoBtn = document.getElementById('launch-apo-btn');

// Sync calibration elements
const syncCalibrateBtn = document.getElementById('sync-calibrate-btn');
const measureLatencyBtn = document.getElementById('measure-latency-btn');
const syncDelaySlider = document.getElementById('sync-delay-slider');
const syncDelayValue = document.getElementById('sync-delay-value');
const syncBarsWrapper = document.getElementById('sync-bars-wrapper');
const syncBars = document.getElementById('sync-bars');
const syncHint = document.getElementById('sync-hint');
const autoSyncToggle = document.getElementById('auto-sync-toggle');
const autoSyncHint = document.getElementById('auto-sync-hint');

// Number of visual bars for sync delay
const SYNC_BAR_COUNT = 20;
const SYNC_MAX_DELAY = 2000; // ms - keep high for networks with larger latency

// Calibration state
let isCalibrating = false;
let currentSyncDelay = 0;

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

// PC Audio state: true = also play on PC speakers (via Listen + APO delay)
let pcAudioEnabled = false;

// Sync delay state
let currentSyncDelayMs = 0;
let syncDelayTimeout = null; // Debounce timer
let audioSyncAvailable = false;
let audioSyncMethod = null;

// Auto-sync state
let autoSyncEnabled = false;

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

    // Apply sync delay slider state and visual bars
    if (syncDelaySlider && settings.syncDelayMs !== undefined) {
      currentSyncDelayMs = settings.syncDelayMs || 0;
      syncDelaySlider.value = currentSyncDelayMs;
      if (syncDelayValue) {
        syncDelayValue.textContent = `${currentSyncDelayMs}ms`;
      }
      // Update visual bars after a small delay (DOM needs to be ready)
      setTimeout(() => updateSyncBars(currentSyncDelayMs), 100);
      log(`Sync delay: ${currentSyncDelayMs}ms`);
      // Note: APO delay is restored in initAudioSync() after confirming APO is available
    }

    // Apply PC audio toggle state (default to OFF)
    if (pcAudioToggle) {
      pcAudioToggle.checked = settings.pcAudioEnabled || false;
      pcAudioEnabled = pcAudioToggle.checked;
    }

    // Apply auto-sync toggle state (default to OFF)
    if (autoSyncToggle) {
      autoSyncEnabled = settings.autoSyncEnabled || false;
      autoSyncToggle.checked = autoSyncEnabled;
      if (autoSyncHint && autoSyncEnabled) {
        autoSyncHint.textContent = 'Monitoring network latency and auto-adjusting delay';
      }
      log(`Auto-sync: ${autoSyncEnabled ? 'ON' : 'OFF'}`);
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

  // Load APO device info for Settings tab
  await loadApoDevices();

  // Load audio outputs for quick switching in Settings tab
  await loadAudioOutputs();

  // Set up first-run event listener
  setupFirstRunListener();

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

// ===================
// First-Run Setup
// ===================

let firstRunData = null;

function setupFirstRunListener() {
  // Listen for first-run event from main process
  window.api.onFirstRunSetup((data) => {
    console.log('[FirstRun] Received first-run setup event:', data);
    firstRunData = data;
    showFirstRunModal(data);
  });

  // Set up button click handlers
  const installApoBtn = document.getElementById('install-apo-btn');
  const skipApoBtn = document.getElementById('skip-apo-btn');
  const finishBtn = document.getElementById('finish-btn');

  if (installApoBtn) {
    installApoBtn.addEventListener('click', handleInstallApo);
  }
  if (skipApoBtn) {
    skipApoBtn.addEventListener('click', handleSkipApo);
  }
  if (finishBtn) {
    finishBtn.addEventListener('click', handleFinishFirstRun);
  }
}

function showFirstRunModal(data) {
  const modal = document.getElementById('first-run-modal');
  const mainDeviceName = document.getElementById('main-device-name');
  const deviceToCheck = document.getElementById('device-to-check');

  if (!modal) return;

  // Show the detected device name
  if (data.realSpeakers && data.realSpeakers.length > 0) {
    const primaryDevice = data.realSpeakers[0];
    mainDeviceName.textContent = primaryDevice;
    deviceToCheck.textContent = `"${primaryDevice}"`;
  } else {
    mainDeviceName.textContent = 'Default audio device';
    deviceToCheck.textContent = 'your Default device';
  }

  // Show the modal
  modal.style.display = 'flex';
  log('First-run setup started', 'info');
}

function hideFirstRunModal() {
  const modal = document.getElementById('first-run-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

async function handleInstallApo() {
  const apoSection = document.getElementById('apo-section');
  const deviceSection = document.getElementById('device-section');
  const completeSection = document.getElementById('complete-section');
  const completionMessage = document.getElementById('completion-message');

  // Open Equalizer APO download
  await window.api.installEqualizerApo();
  log('Opening Equalizer APO download page...', 'success');

  // Show completion section
  if (apoSection) apoSection.style.display = 'none';
  if (deviceSection) deviceSection.style.display = 'none';
  if (completeSection) {
    completeSection.style.display = 'block';
    if (completionMessage) {
      const deviceName = firstRunData?.realSpeakers?.[0] || 'Default device';
      completionMessage.innerHTML = `
        <strong>After installing Equalizer APO:</strong><br>
        ✓ Check ONLY "${deviceName}"<br>
        ✓ Restart Windows<br><br>
        Then you can use "PC + Speakers" mode!
      `;
    }
  }

  // Mark APO as being installed (user initiated)
  await window.api.completeFirstRun({ installedApo: true });
}

async function handleSkipApo() {
  const apoSection = document.getElementById('apo-section');
  const deviceSection = document.getElementById('device-section');
  const completeSection = document.getElementById('complete-section');
  const completionMessage = document.getElementById('completion-message');

  // Show completion section
  if (apoSection) apoSection.style.display = 'none';
  if (deviceSection) deviceSection.style.display = 'none';
  if (completeSection) {
    completeSection.style.display = 'block';
    if (completionMessage) {
      completionMessage.innerHTML = `
        You're all set for <strong>Nest Only</strong> mode!<br><br>
        You can install Equalizer APO later if you want "PC + Speakers" mode.
      `;
    }
  }

  // Complete first-run without APO
  await window.api.completeFirstRun({ installedApo: false });
  log('First-run setup complete (Nest Only mode)', 'success');
}

async function handleFinishFirstRun() {
  hideFirstRunModal();
  log('Welcome to PC Nest Speaker!', 'success');
}

function setupEventListeners() {
  // Window controls (frameless window)
  const refreshBtn = document.getElementById('refresh-btn');
  const minimizeBtn = document.getElementById('minimize-btn');
  const closeBtn = document.getElementById('close-btn');
  const quitBtn = document.getElementById('quit-btn');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      log('Refreshing speakers...', 'info');
      await discoverDevices();
    });
  }
  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => window.api.minimizeWindow());
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => window.api.closeWindow());
  }
  if (quitBtn) {
    quitBtn.addEventListener('click', () => {
      log('Quitting and restoring audio settings...', 'info');
      window.api.quitApp();
    });
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

  // PC Audio toggle (simple on/off)
  if (pcAudioToggle) {
    pcAudioToggle.addEventListener('change', () => togglePCAudio(pcAudioToggle.checked));
  }

  // Ⓦ info icon - click to go to Settings sync section
  const pcAudioInfo = document.getElementById('pc-audio-info');
  if (pcAudioInfo) {
    pcAudioInfo.addEventListener('click', () => {
      // Switch to Settings tab
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector('[data-tab="settings"]').classList.add('active');
      document.getElementById('tab-settings').classList.add('active');
      // Scroll to sync section
      const syncSection = document.getElementById('sync-section-settings');
      if (syncSection) syncSection.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Sync delay slider - adjust HDMI delay to match Cast latency
  if (syncDelaySlider) {
    syncDelaySlider.addEventListener('input', (e) => {
      const delayMs = parseInt(e.target.value, 10);
      handleSyncDelayChange(delayMs);
      updateSyncBars(delayMs);
    });
  }

  // Initialize visual bars for sync delay
  initSyncBars();

  // Scroll wheel control for sync delay
  if (syncBarsWrapper) {
    syncBarsWrapper.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = 10; // 10ms per scroll step
      const direction = e.deltaY < 0 ? 1 : -1; // Scroll up = increase, down = decrease
      const currentVal = parseInt(syncDelaySlider?.value || 0, 10);
      const newVal = Math.max(0, Math.min(SYNC_MAX_DELAY, currentVal + (step * direction)));

      if (syncDelaySlider) {
        syncDelaySlider.value = newVal;
        handleSyncDelayChange(newVal);
        updateSyncBars(newVal);
      }
    }, { passive: false });

    // Keyboard control when focused
    syncBarsWrapper.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        const currentVal = parseInt(syncDelaySlider?.value || 0, 10);
        const newVal = Math.max(0, currentVal - 50);
        if (syncDelaySlider) {
          syncDelaySlider.value = newVal;
          handleSyncDelayChange(newVal);
          updateSyncBars(newVal);
        }
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        const currentVal = parseInt(syncDelaySlider?.value || 0, 10);
        const newVal = Math.min(SYNC_MAX_DELAY, currentVal + 50);
        if (syncDelaySlider) {
          syncDelaySlider.value = newVal;
          handleSyncDelayChange(newVal);
          updateSyncBars(newVal);
        }
      }
    });
  }

  // Listen for auto-connect event from main process (single speaker)
  window.api.onAutoConnect(async (speaker) => {
    log(`Auto-connecting to ${speaker.name}...`, 'info');

    // Retry logic: If speaker not found, re-discover and try again (speakers may have just turned on)
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Find speaker in list
      const speakerIndex = speakers.findIndex(s => s.name === speaker.name);
      if (speakerIndex !== -1) {
        // Use startStreamingToSpeaker() which actually starts streaming
        // (selectSpeaker only pings without streaming!)
        await startStreamingToSpeaker(speakerIndex);

        // RESTORE PC SPEAKER MODE: If setting was saved as ON, enable it now that streaming is active
        // This ensures auto-sync starts automatically on boot without user having to toggle
        if (pcAudioEnabled && pcAudioToggle && pcAudioToggle.checked) {
          log('Restoring PC speaker mode from saved settings...', 'info');
          await togglePCAudio(true);
        }

        return; // Success - exit
      }

      // Speaker not found - try re-discovering
      if (attempt < MAX_RETRIES) {
        log(`Speaker "${speaker.name}" not found (attempt ${attempt}/${MAX_RETRIES}), re-discovering...`, 'warning');
        try {
          await discoverDevices();
        } catch (e) {
          log(`Re-discovery failed: ${e.message}`, 'error');
        }
        // Wait before next attempt
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    // All retries exhausted
    log(`Speaker "${speaker.name}" not found after ${MAX_RETRIES} attempts`, 'error');
    log('Make sure the speaker is online and on the same network', 'warning');
  });

  // Listen for stereo auto-connect event from main process (L/R pair)
  window.api.onAutoConnectStereo(async ({ left, right }) => {
    log(`Auto-connecting stereo: L="${left.name}", R="${right.name}"...`, 'info');

    // Retry logic: If speakers not found, re-discover and try again
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Find both speakers in list
      const leftIndex = speakers.findIndex(s => s.name === left.name);
      const rightIndex = speakers.findIndex(s => s.name === right.name);

      if (leftIndex !== -1 && rightIndex !== -1) {
        // Set up stereo mode with L/R assignments
        stereoMode.leftSpeaker = leftIndex;
        stereoMode.rightSpeaker = rightIndex;

        // Start stereo streaming
        await startStereoStreaming();

        // RESTORE PC SPEAKER MODE: If setting was saved as ON, enable it now that streaming is active
        // This ensures auto-sync starts automatically on boot without user having to toggle
        if (pcAudioEnabled && pcAudioToggle && pcAudioToggle.checked) {
          log('Restoring PC speaker mode from saved settings...', 'info');
          await togglePCAudio(true);
        }

        return; // Success - exit
      }

      // One or both speakers not found - try re-discovering
      if (attempt < MAX_RETRIES) {
        const missing = [];
        if (leftIndex === -1) missing.push(`L="${left.name}"`);
        if (rightIndex === -1) missing.push(`R="${right.name}"`);
        log(`Speakers not found (${missing.join(', ')}) - attempt ${attempt}/${MAX_RETRIES}, re-discovering...`, 'warning');
        try {
          await discoverDevices();
        } catch (e) {
          log(`Re-discovery failed: ${e.message}`, 'error');
        }
        // Wait before next attempt
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    // All retries exhausted - log which speakers are missing
    const leftIndex = speakers.findIndex(s => s.name === left.name);
    const rightIndex = speakers.findIndex(s => s.name === right.name);
    if (leftIndex === -1) {
      log(`Left speaker "${left.name}" not found after ${MAX_RETRIES} attempts`, 'error');
    }
    if (rightIndex === -1) {
      log(`Right speaker "${right.name}" not found after ${MAX_RETRIES} attempts`, 'error');
    }
    log('Make sure both speakers are online and on the same network', 'warning');
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

  // Listen for auto-sync adjustments
  window.api.onAutoSyncAdjusted((data) => {
    const { newDelay, oldDelay } = data;
    log(`Auto-sync: adjusted ${oldDelay}ms → ${newDelay}ms`, 'info');

    // Update the sync delay UI to reflect the new value
    currentSyncDelayMs = newDelay;
    if (syncDelaySlider) {
      syncDelaySlider.value = newDelay;
    }
    if (syncDelayValue) {
      syncDelayValue.textContent = `${newDelay}ms`;
    }
    updateSyncBars(newDelay);
  });

  // Listen for sync delay auto-correction (when old high delay corrected for optimized WebRTC)
  window.api.onSyncDelayCorrected((newDelayMs) => {
    log(`Sync delay auto-corrected to ${newDelayMs}ms (optimized for WebRTC)`, 'info');

    // Update the sync delay UI to reflect the corrected value
    currentSyncDelayMs = newDelayMs;
    if (syncDelaySlider) {
      syncDelaySlider.value = newDelayMs;
    }
    if (syncDelayValue) {
      syncDelayValue.textContent = `${newDelayMs}ms`;
    }
    updateSyncBars(newDelayMs);
  });

  // Listen for audio device change (when Windows audio switches to VB-Cable, refresh pill UI)
  window.api.onAudioDeviceChanged((deviceName) => {
    console.log(`[Renderer] Audio device changed to: ${deviceName}`);
    // Refresh the audio output list to show new active device
    loadAudioOutputs();
  });

  // Auto-sync toggle handler
  if (autoSyncToggle) {
    autoSyncToggle.addEventListener('change', async (e) => {
      autoSyncEnabled = e.target.checked;
      log(`Auto-sync: ${autoSyncEnabled ? 'ON' : 'OFF'}`);

      // Update hint
      if (autoSyncHint) {
        autoSyncHint.textContent = autoSyncEnabled
          ? 'Monitoring network latency and auto-adjusting delay'
          : 'Monitors network and auto-adjusts delay';
      }

      try {
        if (autoSyncEnabled) {
          // Get current speaker info for baseline measurement
          const speakerInfo = selectedSpeaker !== null ? speakers[selectedSpeaker] : null;
          const result = await window.api.enableAutoSync(speakerInfo);
          if (result.success) {
            log('Auto-sync enabled - will adjust when network changes', 'success');
          }
        } else {
          await window.api.disableAutoSync();
          log('Auto-sync disabled', 'info');
        }
      } catch (err) {
        log(`Auto-sync error: ${err.message}`, 'error');
      }
    });
  }

  // Purchase button - opens license modal
  if (purchaseBtn) {
    purchaseBtn.addEventListener('click', () => {
      log('Opening license activation...');
      showLicenseModal();
    });
  }

  // Configure APO button - launches Equalizer APO Configurator
  if (launchApoBtn) {
    launchApoBtn.addEventListener('click', async () => {
      log('Opening APO Configurator...');
      try {
        const result = await window.api.launchApoConfigurator();
        if (result.success) {
          log('APO Configurator opened. Select your PC speakers, then restart Windows.', 'info');
        } else {
          log('Could not launch APO Configurator', 'error');
        }
      } catch (error) {
        log(`APO Configurator error: ${error.message}`, 'error');
      }
    });
  }

  // Refresh audio outputs button
  if (refreshOutputsBtn) {
    refreshOutputsBtn.addEventListener('click', async () => {
      log('Refreshing audio outputs...');
      await loadAudioOutputs();
    });
  }

  // License row click - expand/collapse
  const licenseRow = document.getElementById('license-row');
  if (licenseRow) {
    licenseRow.addEventListener('click', (event) => {
      toggleLicenseDetails(event);
    });
  }

  // Change Key button
  const changeKeyBtn = document.getElementById('change-key-btn');
  if (changeKeyBtn) {
    changeKeyBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      showLicenseModal();
    });
  }

  // Deactivate button
  const deactivateBtn = document.getElementById('deactivate-btn');
  if (deactivateBtn) {
    deactivateBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      deactivateLicense();
    });
  }

  // Buy License button (in modal)
  const buyLicenseBtn = document.getElementById('buy-license-btn');
  if (buyLicenseBtn) {
    buyLicenseBtn.addEventListener('click', () => {
      openPurchaseLink();
    });
  }

  // Activate button (in modal)
  const activateLicenseBtn = document.getElementById('activate-license-btn');
  if (activateLicenseBtn) {
    activateLicenseBtn.addEventListener('click', () => {
      activateLicense();
    });
  }

  // Support link (in modal)
  const supportLink = document.getElementById('support-link');
  if (supportLink) {
    supportLink.addEventListener('click', (event) => {
      event.preventDefault();
      openSupportLink();
    });
  }
}

// Track if Equalizer APO is installed
let equalizerApoInstalled = false;

// Check Equalizer APO on startup
async function checkEqualizerApo() {
  try {
    const result = await window.api.checkEqualizerApo();
    equalizerApoInstalled = result.installed;
    log(`Equalizer APO: ${equalizerApoInstalled ? 'Installed' : 'Not installed'}`);
    return equalizerApoInstalled;
  } catch (err) {
    log(`Equalizer APO check failed: ${err.message}`, 'warning');
    return false;
  }
}

// Show install prompt for Equalizer APO
async function showEqualizerApoPrompt() {
  // Get the detected device name for personalized instructions
  let deviceName = 'your Default device';

  // Try to get from firstRunData (if we did first-run detection)
  if (firstRunData?.realSpeakers?.[0]) {
    deviceName = `"${firstRunData.realSpeakers[0]}"`;
  } else {
    // Fallback: fetch from settings
    try {
      const status = await window.api.getFirstRunStatus();
      if (status?.detectedRealSpeakers?.[0]) {
        deviceName = `"${status.detectedRealSpeakers[0]}"`;
      }
    } catch (e) {
      console.log('[APO Prompt] Could not get detected speakers');
    }
  }

  const confirmed = confirm(
    '🔊 Sync Delay requires Equalizer APO\n\n' +
    'This adds delay to your PC speakers so they sync with Nest.\n\n' +
    'Click OK to download (30 second install).\n\n' +
    'DURING INSTALL:\n' +
    `✓ Check ONLY ${deviceName}\n\n` +
    'After install → Restart Windows'
  );

  if (confirmed) {
    window.api.installEqualizerApo();
    log('Opening Equalizer APO download page...', 'success');
  }
}

// Toggle PC Audio on/off (simplified from cast mode)
// ON = Enable "Listen to this device" on VB-Cable + APO delay
// OFF = Disable Listen, clear APO delay
async function togglePCAudio(enabled) {
  pcAudioEnabled = enabled;
  log(`PC Audio: ${enabled ? 'ON' : 'OFF'}`);

  // Stop calibration if turning off
  if (!enabled && isCalibrating) {
    stopCalibration();
  }

  // Save setting
  window.api.updateSettings({ pcAudioEnabled: enabled });

  // Call backend to toggle Listen + APO
  try {
    const result = await window.api.togglePCAudio(enabled);
    if (result.success) {
      log(`PC Audio ${enabled ? 'enabled' : 'disabled'}`, 'success');

      // AUTO-START SYNC: When PC audio enabled, immediately start auto-sync
      // This captures the baseline BEFORE the user has a chance to adjust anything
      if (enabled && !autoSyncEnabled) {
        autoSyncEnabled = true;
        if (autoSyncToggle) autoSyncToggle.checked = true;
        if (autoSyncHint) {
          autoSyncHint.textContent = 'Monitoring network latency and auto-adjusting delay';
        }

        // Start auto-sync with current speaker info
        const speakerInfo = selectedSpeaker !== null ? speakers[selectedSpeaker] : null;
        const syncResult = await window.api.enableAutoSync(speakerInfo);
        if (syncResult.success) {
          log('Auto-sync started - capturing baseline', 'info');
        }

        // Save auto-sync state
        window.api.updateSettings({ autoSyncEnabled: true });

        // SMART CALIBRATION: Measure ping and calculate starting delay
        log('Measuring network latency to calculate smart default...', 'info');
        const calibration = await window.api.calibrateSmartDefault();
        if (calibration.success) {
          // Update the slider to show calibrated value
          const syncDelaySlider = document.getElementById('sync-delay');
          const syncDelayValue = document.getElementById('sync-delay-value');
          if (syncDelaySlider) {
            syncDelaySlider.value = calibration.delay;
          }
          if (syncDelayValue) {
            syncDelayValue.textContent = calibration.delay;
          }

          // Show helpful toast explaining what happened
          showSyncCalibrationToast(calibration);
        }
      }
    } else {
      log(`PC Audio toggle failed: ${result.error}`, 'error');
    }
  } catch (err) {
    log(`PC Audio error: ${err.message}`, 'error');
  }
}

// Show a helpful toast when sync is calibrated
function showSyncCalibrationToast(calibration) {
  // Create toast container if it doesn't exist
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      z-index: 10000;
    `;
    document.body.appendChild(toastContainer);
  }

  // Create toast
  const toast = document.createElement('div');
  toast.className = 'sync-toast';
  toast.style.cssText = `
    background: linear-gradient(135deg, var(--color-blue), #2a3f47);
    border: 1px solid var(--color-blush);
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 10px;
    max-width: 320px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    animation: slideIn 0.3s ease;
  `;

  toast.innerHTML = `
    <div style="color: var(--color-blush); font-weight: 600; margin-bottom: 8px;">
      🎯 Smart Sync Started
    </div>
    <div style="color: #fff; font-size: 13px; line-height: 1.4; margin-bottom: 10px;">
      Ping to speaker: <b>${calibration.rtt}ms</b><br>
      Starting delay: <b>${calibration.delay}ms</b>
    </div>
    <div style="color: #aaa; font-size: 11px; line-height: 1.4;">
      If audio is out of sync, adjust the slider in Settings → Sync.
      The app will track from your setting.
    </div>
    <button onclick="this.parentElement.remove()" style="
      position: absolute;
      top: 8px;
      right: 8px;
      background: none;
      border: none;
      color: #888;
      cursor: pointer;
      font-size: 16px;
    ">&times;</button>
  `;
  toast.style.position = 'relative';

  toastContainer.appendChild(toast);

  // Auto-remove after 8 seconds
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }
  }, 8000);
}

// Legacy alias for compatibility
async function setCastMode(mode) {
  const enabled = mode === 'all';
  if (pcAudioToggle) pcAudioToggle.checked = enabled;
  await togglePCAudio(enabled);
}

// Check all dependencies
async function checkDependencies() {
  log('Checking dependencies...');

  try {
    const result = await window.api.checkDependencies();
    dependencies = result;

    // Virtual Audio: from screen-capture-recorder (virtual-audio-capturer / Virtual Desktop Audio)
    if (result.virtualAudio) {
      log('Virtual Audio: OK');
    } else if (result.vbcableFallback) {
      log('Virtual Audio: Missing (VB-CABLE fallback available)');
    } else {
      log('Virtual Audio: Missing - install screen-capture-recorder');
    }

    log(`MediaMTX: ${result.mediamtx ? 'OK' : 'Bundled'}`);

    updateDependencyIndicators();
  } catch (error) {
    log(`Dependency check failed: ${error.message}`, 'error');
    // Assume all missing on error
    dependencies = {
      virtualAudio: false,
      vbcableFallback: false,
      mediamtx: true, // Bundled
      ffmpeg: true // Bundled
    };
    updateDependencyIndicators();
  }
}

// Update dependency status indicators in UI
function updateDependencyIndicators() {
  // Check if we have ANY virtual audio device (preferred or fallback)
  const hasVirtualAudio = dependencies.virtualAudio || dependencies.vbcableFallback;

  // HTTP mode deps (legacy - uses VB-CABLE)
  const httpDeps = document.getElementById('http-deps');
  if (httpDeps) {
    httpDeps.innerHTML = `
      <span class="dep-item ${hasVirtualAudio ? 'dep-ok' : 'dep-missing'}">Virtual Audio</span>
    `;
  }

  // WebRTC System mode deps (primary mode)
  const webrtcSystemDeps = document.getElementById('webrtc-system-deps');
  if (webrtcSystemDeps) {
    webrtcSystemDeps.innerHTML = `
      <span class="dep-item ${hasVirtualAudio ? 'dep-ok' : 'dep-missing'}">Virtual Audio</span>
      <span class="dep-item dep-ok">MediaMTX</span>
    `;
  }

  // WebRTC VB-CABLE mode deps (legacy fallback)
  const webrtcVbcableDeps = document.getElementById('webrtc-vbcable-deps');
  if (webrtcVbcableDeps) {
    webrtcVbcableDeps.innerHTML = `
      <span class="dep-item ${hasVirtualAudio ? 'dep-ok' : 'dep-missing'}">Virtual Audio</span>
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
  const hasVirtualAudio = dependencies.virtualAudio || dependencies.vbcableFallback;

  switch (mode) {
    case 'http':
      if (!hasVirtualAudio) missing.push('Virtual Audio (screen-capture-recorder)');
      break;
    case 'webrtc-system':
      if (!hasVirtualAudio) missing.push('Virtual Audio (screen-capture-recorder)');
      break;
    case 'webrtc-vbcable':
      if (!hasVirtualAudio) missing.push('Virtual Audio (screen-capture-recorder)');
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

/**
 * Get the appropriate icon SVG for a speaker based on its type
 * Icons designed to match Google's actual device shapes - Rose Pink (#FCBFB7)
 */
function getSpeakerIcon(speaker) {
  const model = (speaker.model || '').toLowerCase();
  const name = (speaker.name || '').toLowerCase();
  const castType = speaker.cast_type || 'audio';

  // TV / Shield / Display devices - TV with Cast icon
  if (model.includes('tv') || model.includes('shield') || model.includes('display') ||
      name.includes('tv') || castType === 'cast') {
    return `<svg viewBox="0 0 24 24" fill="#FCBFB7" stroke="#FCBFB7" stroke-width="1.5">
      <rect x="2" y="4" width="20" height="13" rx="1" fill="none"/>
      <line x1="7" y1="20" x2="17" y2="20"/>
      <line x1="12" y1="17" x2="12" y2="20"/>
      <path d="M6 11c2.2 0 4 1.8 4 4" stroke-linecap="round" fill="none"/>
      <path d="M6 8c4 0 7 3 7 7" stroke-linecap="round" fill="none"/>
      <circle cx="6" cy="15" r="1"/>
    </svg>`;
  }

  // Groups (multi-room or stereo pairs) - Two round pucks
  if (castType === 'group' || name.includes('pair')) {
    return `<svg viewBox="0 0 24 24" fill="#FCBFB7" stroke="#FCBFB7" stroke-width="1.5">
      <ellipse cx="7" cy="12" rx="5.5" ry="3.5" fill="none"/>
      <ellipse cx="17" cy="12" rx="5.5" ry="3.5" fill="none"/>
      <circle cx="5.5" cy="12" r="0.7"/>
      <circle cx="7" cy="12" r="0.7"/>
      <circle cx="8.5" cy="12" r="0.7"/>
      <circle cx="15.5" cy="12" r="0.7"/>
      <circle cx="17" cy="12" r="0.7"/>
      <circle cx="18.5" cy="12" r="0.7"/>
    </svg>`;
  }

  // Nest Hub (has display) - Screen with fabric speaker base
  if (model.includes('hub') || model.includes('home hub')) {
    return `<svg viewBox="0 0 24 24" fill="#FCBFB7" stroke="#FCBFB7" stroke-width="1.5">
      <rect x="3" y="3" width="18" height="11" rx="1" fill="none"/>
      <path d="M4 17c0-2 3.5-3 8-3s8 1 8 3v2c0 1-2 2-8 2s-8-1-8-2v-2z" fill="none"/>
    </svg>`;
  }

  // Nest Audio (larger speaker) - Tall cylinder with fabric lines
  if (model.includes('nest audio') || model.includes('google home max')) {
    return `<svg viewBox="0 0 24 24" fill="#FCBFB7" stroke="#FCBFB7" stroke-width="1.5">
      <path d="M7 4c0-1.1 2.2-2 5-2s5 0.9 5 2v16c0 1.1-2.2 2-5 2s-5-0.9-5-2V4z" fill="none"/>
      <ellipse cx="12" cy="4" rx="5" ry="2" fill="none"/>
      <line x1="7" y1="9" x2="17" y2="9" opacity="0.5"/>
      <line x1="7" y1="12" x2="17" y2="12" opacity="0.5"/>
      <line x1="7" y1="15" x2="17" y2="15" opacity="0.5"/>
      <line x1="7" y1="18" x2="17" y2="18" opacity="0.5"/>
    </svg>`;
  }

  // Default: Nest Mini / Google Home Mini - Round puck with LED dots
  return `<svg viewBox="0 0 24 24" fill="#FCBFB7" stroke="#FCBFB7" stroke-width="1.5">
    <ellipse cx="12" cy="12" rx="9" ry="5" fill="none"/>
    <path d="M3 12c0 2 4 4 9 4s9-2 9-4" fill="none"/>
    <circle cx="9" cy="11.5" r="0.8"/>
    <circle cx="11" cy="11.5" r="0.8"/>
    <circle cx="13" cy="11.5" r="0.8"/>
    <circle cx="15" cy="11.5" r="0.8"/>
  </svg>`;
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
    const isSelected = selectedSpeaker && selectedSpeaker.name === speaker.name;
    const isActivelyStreaming = isSelected && isStreaming;

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
    // Info button is in its own column for alignment
    const stereoControls = isStereoDevice
      ? `<div class="stereo-toggles">
           <span class="stereo-badge ${isActivelyStreaming ? 'active' : ''}">${castType === 'group' ? 'GROUP' : 'STEREO'}</span>
         </div>
         <button class="info-btn" data-index="${index}" title="Stereo info">ⓘ</button>`
      : `<div class="stereo-toggles">
           <button class="stereo-toggle ${isLeft ? 'active' : ''}" data-index="${index}" data-channel="left">L</button>
           <button class="stereo-toggle ${isRight ? 'active' : ''}" data-index="${index}" data-channel="right">R</button>
         </div>
         <div class="info-btn-placeholder"></div>`;

    return `
    <div class="speaker-item ${isSelected ? 'selected' : ''} ${isActivelyStreaming ? 'streaming' : ''} ${isStereoDevice && isActivelyStreaming ? 'speaker-left speaker-right' : ''} ${!isStereoDevice && isLeft ? 'speaker-left' : ''} ${!isStereoDevice && isRight ? 'speaker-right' : ''}" data-index="${index}">
      <div class="speaker-icon">
        ${getSpeakerIcon(speaker)}
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
    // Left-click = START STREAMING to speaker (what users expect!)
    item.addEventListener('click', (e) => {
      // Don't trigger if clicking on stereo toggles
      if (e.target.classList.contains('stereo-toggle')) return;
      if (e.target.classList.contains('info-btn')) return;
      startStreamingToSpeaker(parseInt(item.dataset.index));
    });

    // Right-click = just ping speaker (for testing connection)
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.target.classList.contains('stereo-toggle')) return;
      const index = parseInt(item.dataset.index);
      // Just select and ping, don't stream
      selectSpeaker(index);
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

  // NOTE: Removed immediate ping here - the webrtc-launch connection
  // already provides audio feedback, and pinging before causes double ping

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
  } else if (stereoMode.leftSpeaker !== null || stereoMode.rightSpeaker !== null) {
    // FIX: Only ONE speaker assigned (L or R) - start streaming to it!
    // This is what users expect when clicking L or R on a single speaker
    const speakerIndex = stereoMode.leftSpeaker !== null
      ? stereoMode.leftSpeaker
      : stereoMode.rightSpeaker;
    const speaker = speakers[speakerIndex];

    // Check if this speaker is actually a stereo device (group, TV, stereo pair)
    // If so, we should send full stereo audio, not prepare for L/R separation
    const castType = speaker.cast_type || 'audio';
    const model = (speaker.model || '').toLowerCase();
    const speakerName = (speaker.name || '').toLowerCase();
    const isStereoDevice = castType === 'group' ||
                           model.includes('tv') ||
                           model.includes('shield') ||
                           speakerName.includes('pair');

    if (isStereoDevice) {
      // Stereo device - clear L/R assignment since it doesn't apply
      log(`"${speaker.name}" is a stereo device - sending full stereo audio`, 'success');
      stereoMode.leftSpeaker = null;
      stereoMode.rightSpeaker = null;
      renderSpeakers(); // Update UI to clear L/R highlights
      await startStreamingToSpeaker(speakerIndex, true); // Clear stereo state
    } else {
      // Mono speaker - start streaming but preserve L/R assignment
      // so user can add a second speaker for stereo separation
      log(`Starting stream to "${speaker.name}" (add another for stereo separation)...`, 'success');
      await startStreamingToSpeaker(speakerIndex, false);
    }
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
      setStreamingState(true); // Update status indicator
      log('Stereo streaming started!', 'success');
      renderSpeakers();

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
      setStreamingState(false); // Update status indicator
      log('Stereo streaming stopped', 'success');
      renderSpeakers();
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

  // Update Cast URL section visibility (only shows for TVs)
  if (typeof updateCastUrlSection === 'function') {
    updateCastUrlSection();
  }

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

  // DON'T ping if already streaming - ping quits the Cast app and breaks the stream!
  if (isStreaming || stereoMode.streaming) {
    log(`${selectedSpeaker.name} selected (no ping while streaming)`, 'info');
    return;
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

// Start streaming to a speaker (called by left-click on speaker row)
// Set clearStereoState=false when called from stereo toggle to preserve L/R assignments
async function startStreamingToSpeaker(index, clearStereoState = true) {
  const speaker = speakers[index];
  if (!speaker) return;

  // If already streaming to this speaker (mono or stereo), do nothing
  // User confusion: clicking a connected speaker was stopping the stream
  // Now: clicking a connected speaker just logs and does nothing
  const isSameSpeaker = selectedSpeaker && selectedSpeaker.name === speaker.name;
  const inStereoWithSpeaker = stereoMode.streaming && (
    (stereoMode.leftSpeaker !== null && speakers[stereoMode.leftSpeaker]?.name === speaker.name) ||
    (stereoMode.rightSpeaker !== null && speakers[stereoMode.rightSpeaker]?.name === speaker.name)
  );

  // TOGGLE behavior: If already streaming to this speaker, STOP streaming (disconnect)
  if ((isSameSpeaker && isStreaming) || inStereoWithSpeaker) {
    log(`Stopping stream to ${speaker.name}...`);

    try {
      if (inStereoWithSpeaker && stereoMode.streaming) {
        // Stop stereo streaming
        const leftSpeaker = stereoMode.leftSpeaker !== null ? speakers[stereoMode.leftSpeaker] : null;
        const rightSpeaker = stereoMode.rightSpeaker !== null ? speakers[stereoMode.rightSpeaker] : null;
        await window.api.stopStereoStreaming(leftSpeaker, rightSpeaker);
        stereoMode.streaming = false;
        stereoMode.enabled = false;
        stereoMode.leftSpeaker = null;
        stereoMode.rightSpeaker = null;
        log('Stereo streaming stopped', 'success');
      } else {
        // Stop mono streaming
        await window.api.stopStreaming();
        log('Streaming stopped', 'success');
      }

      // Clear selection state
      selectedSpeaker = null;
      setStreamingState(false);
      renderSpeakers(); // Re-render to clear selected/streaming states

      // Hide Cast URL section when no speaker selected
      if (typeof updateCastUrlSection === 'function') {
        updateCastUrlSection();
      }

    } catch (error) {
      log(`Failed to stop stream: ${error.message}`, 'error');
    }
    return; // Done - we disconnected
  }

  // Select the speaker first
  selectedSpeaker = speaker;
  speakerList.querySelectorAll('.speaker-item').forEach((item, i) => {
    item.classList.toggle('selected', i === index);
  });

  // Update Cast URL section visibility (only shows for TVs)
  if (typeof updateCastUrlSection === 'function') {
    updateCastUrlSection();
  }

  // Save as last speaker for auto-connect
  try {
    await window.api.saveLastSpeaker(speaker);
  } catch (error) {
    log(`Failed to save speaker: ${error.message}`, 'warning');
  }

  // If stereo mode is active (L/R assigned), stop it first (unless we're preserving stereo state)
  if (clearStereoState && (stereoMode.streaming || (stereoMode.leftSpeaker !== null && stereoMode.rightSpeaker !== null))) {
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

  // If already streaming to a DIFFERENT speaker, stop that first
  if (isStreaming) {
    log('Stopping current stream to switch speakers...');
    try {
      await window.api.stopStreaming();
      setStreamingState(false);
    } catch (error) {
      log(`Stop failed: ${error.message}`, 'error');
    }
  }

  // Start streaming to selected speaker
  log(`Starting stream to ${speaker.name}...`);
  showLoading('Connecting...');

  try {
    const result = await window.api.startStreaming(
      speaker.name,
      null, // no audio device selection needed
      'webrtc-system' // always use WebRTC System Audio
    );

    if (result.success) {
      setStreamingState(true);
      renderSpeakers(); // Update UI to show selected state
      log(`Streaming to ${speaker.name}!`, 'success');
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

    // Also update equalizerApoInstalled for setCastMode()
    equalizerApoInstalled = result.method === 'equalizerapo' || result.supported;

    if (result.supported) {
      log(`Audio sync available (${result.method})`, 'success');

      // Restore saved sync delay now that APO is confirmed available
      if (currentSyncDelayMs > 0) {
        window.api.setSyncDelay(currentSyncDelayMs).then(res => {
          if (res.success) {
            log(`Restored sync delay: ${currentSyncDelayMs}ms`, 'info');
          }
        }).catch(() => {}); // Silent fail
      }
    } else if (result.needsInstall) {
      log('Audio sync: Equalizer APO not installed', 'warning');
      equalizerApoInstalled = false;
      // User can install from UI if they want sync feature
    } else {
      log('Audio sync: No delay method available', 'info');
    }

    // Update UI based on availability
    updateSyncDelayUI();
  } catch (error) {
    log(`Audio sync init failed: ${error.message}`, 'error');
    audioSyncAvailable = false;
    equalizerApoInstalled = false;
  }
}

/**
 * Update sync calibration UI based on availability
 */
function updateSyncDelayUI() {
  const syncRow = document.querySelector('.sync-calibrate-row');
  if (!syncRow) return;

  if (!audioSyncAvailable) {
    // Show install prompt
    if (syncHint) {
      syncHint.innerHTML = 'Sync requires <a href="#" id="install-apo-link" style="color: var(--color-blush);">Equalizer APO</a> (free). Click to install.';

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

    // Disable calibrate button
    if (syncCalibrateBtn) {
      syncCalibrateBtn.disabled = true;
    }
  } else {
    // Enable calibrate button
    if (syncCalibrateBtn) {
      syncCalibrateBtn.disabled = false;
    }
  }
}

/**
 * Load and display APO installed devices + check current device status
 */
async function loadApoDevices() {
  if (!apoDevicesText) return;

  const apoWarning = document.getElementById('apo-warning');
  const apoWarningText = document.getElementById('apo-warning-text');

  try {
    // Get list of APO-enabled devices
    const result = await window.api.getApoDevices();
    const devices = result.devices || [];

    if (devices.length === 0) {
      apoDevicesText.textContent = 'APO installed on: No devices (click Configure to add your speakers)';
      apoDevicesText.classList.add('warning');
    } else {
      // Shorten device names for display
      const shortNames = devices.map(d => {
        // Remove common prefixes/suffixes
        return d.replace(/ Speakers?$/i, '')
                .replace(/^Speakers? \(/, '(')
                .replace(/ High Definition Audio$/i, '');
      });
      apoDevicesText.textContent = `APO installed on: ${shortNames.join(', ')}`;
      apoDevicesText.classList.remove('warning');
    }

    // Check if APO is installed on CURRENT device
    try {
      const status = await window.api.checkApoStatus();
      if (apoWarning && apoWarningText) {
        if (!status.apoInstalled) {
          // APO not installed at all
          apoWarning.style.display = 'flex';
          apoWarningText.textContent = 'Equalizer APO not installed. Required for PC + Speakers mode.';
        } else if (!status.apoOnDevice) {
          // APO installed but not enabled on current device
          const deviceName = status.currentDevice || 'current device';
          apoWarning.style.display = 'flex';
          apoWarningText.textContent = `APO not enabled on "${deviceName}". Click Configure APO to add it.`;
        } else {
          // APO installed and enabled on current device - hide warning
          apoWarning.style.display = 'none';
        }
      }
    } catch (statusErr) {
      log(`Could not check APO status: ${statusErr.message}`, 'warning');
    }
  } catch (error) {
    apoDevicesText.textContent = 'APO installed on: Error loading devices';
    apoDevicesText.classList.add('warning');
    log(`Failed to load APO devices: ${error.message}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// QUICK AUDIO OUTPUT SWITCHER
// ═══════════════════════════════════════════════════════════

/**
 * Load and display all audio output devices for quick switching
 * New pill design with expanding circles
 */
async function loadAudioOutputs() {
  const listEl = document.getElementById('audio-output-list');
  if (!listEl) return;

  // Show loading state
  listEl.innerHTML = '<div class="audio-output-loading">...</div>';

  try {
    const result = await window.api.getAudioOutputs();

    if (!result.success || !result.devices || result.devices.length === 0) {
      listEl.innerHTML = '<div class="audio-output-loading">No devices</div>';
      return;
    }

    // Build the device list - circles with icons
    listEl.innerHTML = result.devices.map(device => {
      const icon = getAudioDeviceIcon(device.name);
      const isActive = device.isDefault;
      // Short name for display (first meaningful word)
      const shortName = getShortDeviceName(device.name);
      // Check if this is VB-Cable (required for streaming)
      const isVBCable = device.name.toLowerCase().includes('cable') &&
                        device.name.toLowerCase().includes('vb');

      return `
        <div class="audio-output-item ${isActive ? 'active' : ''} ${isVBCable ? 'vb-cable' : ''}"
             data-device-name="${escapeHtml(device.name)}"
             title="${escapeHtml(device.name)}${isVBCable ? ' (Required for streaming)' : ''}">
          <span class="audio-output-icon">${icon}</span>
          <span class="audio-output-name">${escapeHtml(shortName)}</span>
          ${isVBCable ? '<span class="vb-cable-indicator"></span>' : ''}
        </div>
      `;
    }).join('');

    // Add click handlers with expand/collapse overlay animation
    const items = listEl.querySelectorAll('.audio-output-item');
    const gridRect = listEl.getBoundingClientRect();

    items.forEach((item, index) => {
      const deviceName = item.dataset.deviceName;

      item.addEventListener('click', async () => {
        // If already active, just flash (don't switch)
        if (item.classList.contains('active')) {
          item.style.transform = 'scale(1.15)';
          setTimeout(() => item.style.transform = '', 150);
          return;
        }

        // Get item's position before expanding
        const itemRect = item.getBoundingClientRect();
        const containerRect = listEl.getBoundingClientRect();

        // Calculate position relative to container
        const leftOffset = itemRect.left - containerRect.left;
        const rightSpace = containerRect.right - itemRect.right;

        // Determine if we should expand left (item is on right side)
        const expandLeft = rightSpace < 80;  // Less than 80px on right = expand left

        // Store original position for restoration
        item.dataset.originalLeft = leftOffset + 'px';

        // Position the item absolutely at its current spot
        item.style.left = expandLeft ? 'auto' : leftOffset + 'px';
        item.style.right = expandLeft ? (containerRect.width - leftOffset - itemRect.width) + 'px' : 'auto';

        // Add expanded class (triggers overlay)
        item.classList.add('expanded');
        if (expandLeft) item.classList.add('expand-left');

        // Helper to clean up expanded state
        const collapse = () => {
          item.classList.remove('expanded', 'expand-left');
          item.style.left = '';
          item.style.right = '';
        };

        // Small delay to show the text, then switch
        setTimeout(async () => {
          try {
            await switchAudioOutput(deviceName);
          } finally {
            // ALWAYS collapse after, even on error
            setTimeout(collapse, 300);
          }
        }, 400);
      });
    });

  } catch (error) {
    listEl.innerHTML = '<div class="audio-output-loading">Error</div>';
    log(`Failed to load audio outputs: ${error.message}`, 'error');
  }
}

/**
 * Get short name for device (for expanded pill display)
 */
function getShortDeviceName(name) {
  // Remove common suffixes/prefixes
  let short = name
    .replace(/\(.*?\)/g, '')  // Remove parentheses content
    .replace(/VB-Audio Virtual Cable/gi, 'VB-Cable')
    .replace(/High Definition Audio/gi, '')
    .replace(/Audio Device/gi, '')
    .trim();

  // If still too long, take first 15 chars
  if (short.length > 18) {
    short = short.substring(0, 15) + '...';
  }

  return short || name.substring(0, 12);
}

/**
 * Get icon for audio device based on name
 */
function getAudioDeviceIcon(name) {
  const nameLower = name.toLowerCase();
  if (nameLower.includes('headphone') || nameLower.includes('headset')) return '🎧';
  if (nameLower.includes('hdmi') || nameLower.includes('nvidia') || nameLower.includes('display')) return '🖥️';
  if (nameLower.includes('virtual') || nameLower.includes('cable')) return '🔌';
  if (nameLower.includes('bluetooth') || nameLower.includes('bt')) return '📶';
  if (nameLower.includes('usb')) return '🔊';
  return '🔈'; // Default speaker icon
}

/**
 * Switch to a specific audio output device (toggle on/off)
 */
async function switchAudioOutput(deviceName) {
  console.log('[switchAudioOutput] Called with:', deviceName);
  const listEl = document.getElementById('audio-output-list');
  if (!listEl) {
    console.log('[switchAudioOutput] ERROR: listEl not found');
    return;
  }

  // Find the clicked item
  const items = listEl.querySelectorAll('.audio-output-item');
  let clickedItem = null;
  items.forEach(item => {
    if (item.dataset.deviceName === deviceName) {
      clickedItem = item;
    }
  });

  console.log('[switchAudioOutput] Found item:', !!clickedItem);

  // TOGGLE: If already active, deselect it (remove active from all)
  if (clickedItem && clickedItem.classList.contains('active')) {
    items.forEach(item => item.classList.remove('active'));
    log(`Deselected audio output: ${deviceName}`, 'info');
    return;
  }

  // Otherwise, switch to this device
  if (clickedItem) clickedItem.classList.add('switching');
  log(`Switching audio to: ${deviceName}`, 'info');

  try {
    console.log('[switchAudioOutput] Calling API...');
    const result = await window.api.switchAudioOutput(deviceName);
    console.log('[switchAudioOutput] API result:', result);

    if (result.success) {
      // Update active states
      items.forEach(item => {
        item.classList.remove('active', 'switching');
        if (item.dataset.deviceName === deviceName) {
          item.classList.add('active');
        }
      });
      log(`Audio switched to: ${deviceName}`, 'success');
    } else {
      if (clickedItem) clickedItem.classList.remove('switching');
      log(`Failed to switch: ${result.error}`, 'error');
    }
  } catch (error) {
    console.log('[switchAudioOutput] ERROR:', error);
    if (clickedItem) clickedItem.classList.remove('switching');
    log(`Error switching audio: ${error.message}`, 'error');
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Initialize visual bars for sync delay display
 */
function initSyncBars() {
  if (!syncBars) return;

  // Clear existing bars
  syncBars.innerHTML = '';

  // Create bars with varying heights for visual interest
  for (let i = 0; i < SYNC_BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'sync-bar';
    // Varying heights: shorter at edges, taller in middle (wave pattern)
    const baseHeight = 0.3 + 0.7 * Math.sin((i / SYNC_BAR_COUNT) * Math.PI);
    bar.style.height = `${baseHeight * 100}%`;
    bar.dataset.index = i;
    syncBars.appendChild(bar);
  }

  // Set initial state from current value
  const initialValue = parseInt(syncDelaySlider?.value || 0, 10);
  updateSyncBars(initialValue);
}

/**
 * Update visual bars based on current delay value
 * @param {number} delayMs - Current delay in milliseconds
 */
function updateSyncBars(delayMs) {
  if (!syncBars) return;

  const bars = syncBars.querySelectorAll('.sync-bar');
  const activeBars = Math.round((delayMs / SYNC_MAX_DELAY) * SYNC_BAR_COUNT);

  bars.forEach((bar, index) => {
    bar.classList.remove('active', 'peak');

    if (index < activeBars) {
      bar.classList.add('active');
      // Peak bar (rightmost active) gets special styling
      if (index === activeBars - 1) {
        bar.classList.add('peak');
      }
    }
  });

  // Update the value display
  if (syncDelayValue) {
    syncDelayValue.textContent = `${delayMs}ms`;
  }
}

/**
 * Handle sync delay slider change
 * - Updates display immediately
 * - Plays dual ping (PC + Nest) if ping mode is enabled
 * - Debounces the actual APO config write
 */
let lastPingTime = 0;
const PING_THROTTLE_MS = 400; // Minimum time between pings
let pingModeEnabled = false; // Toggle state for pings during slider movement

function handleSyncDelayChange(delayMs) {
  // Update display immediately
  if (syncDelayValue) {
    syncDelayValue.textContent = `${delayMs}ms`;
  }

  // Play dual ping if ping mode is enabled and throttle allows
  if (pingModeEnabled) {
    const now = Date.now();
    if (now - lastPingTime >= PING_THROTTLE_MS) {
      lastPingTime = now;
      playDualSyncPing();
    }
  }

  // Debounce the actual delay setting (wait 500ms after user stops sliding)
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
  }, 500);
}

/**
 * Play dual sync ping - beep on PC speakers AND ping on Nest speaker
 * This helps user adjust the delay until both sounds are in sync
 *
 * IMPORTANT: When streaming is active, DO NOT call pingSpeaker!
 * The ping quits the Cast app and breaks the WebRTC stream.
 * Instead, the PC beep goes through the virtual audio device
 * and is streamed to Nest speakers automatically.
 */
async function playDualSyncPing() {
  // Always play PC beep first
  playTestBeep();

  // If streaming is active, the beep will go through the stream to Nest speakers
  // No need to ping separately (and pinging would break the stream!)
  if (isStreaming || stereoMode.streaming) {
    // Beep goes through virtual audio -> FFmpeg -> MediaMTX -> WebRTC -> Nest
    // User will hear beep on PC first, then on Nest after stream delay
    return;
  }

  // Not streaming - ping speaker directly to test connectivity
  const speakerName = selectedSpeaker?.name ||
    (stereoMode.leftSpeaker !== null ? speakers[stereoMode.leftSpeaker]?.name : null);

  if (!speakerName) {
    return;
  }

  try {
    await window.api.pingSpeaker(speakerName);
  } catch (e) {
    // Ignore ping errors during sync testing
  }
}

// ===================
// Sync Calibration Mode
// ===================

let calibrationStarting = false; // Prevent double-clicks during startup

/**
 * Start calibration mode - sets up EVERYTHING needed first:
 * 1. Ensures speakers are discovered
 * 2. Switches to PC + Speakers mode (changes Windows audio device)
 * 3. Starts streaming to a speaker
 * 4. Waits for pipeline to stabilize
 * 5. Then enables ping testing
 */
async function startCalibration() {
  // Prevent double-clicks
  if (calibrationStarting) return;
  calibrationStarting = true;

  // Show "starting" state immediately
  if (syncCalibrateBtn) {
    syncCalibrateBtn.textContent = '⏳ Starting...';
    syncCalibrateBtn.disabled = true;
  }
  if (syncHint) {
    syncHint.textContent = 'Checking speakers...';
  }

  try {
    // Step 1: Make sure we have speakers discovered
    if (!speakers || speakers.length === 0) {
      log('No speakers found, discovering...');
      if (syncHint) syncHint.textContent = 'Discovering speakers...';

      try {
        speakers = await window.api.discoverSpeakers();
        renderSpeakers();
        log(`Found ${speakers.length} speaker(s)`);
      } catch (e) {
        throw new Error('Could not discover speakers. Check your network.');
      }
    }

    if (speakers.length === 0) {
      throw new Error('No speakers found on network');
    }

    // Step 2: Make sure we have a speaker to stream to
    // Priority: stereo pair > selected speaker > last speaker from settings > first available
    let targetSpeakerIndex = null;

    if (stereoMode.leftSpeaker !== null && stereoMode.rightSpeaker !== null) {
      // Stereo pair is set - use that
      log('Using stereo pair for calibration');
    } else if (stereoMode.leftSpeaker !== null) {
      targetSpeakerIndex = stereoMode.leftSpeaker;
    } else if (stereoMode.rightSpeaker !== null) {
      targetSpeakerIndex = stereoMode.rightSpeaker;
    } else if (selectedSpeaker) {
      targetSpeakerIndex = speakers.findIndex(s => s.name === selectedSpeaker.name);
      if (targetSpeakerIndex < 0) targetSpeakerIndex = null;
    }

    // If still no speaker, try to get last used from settings
    if (targetSpeakerIndex === null && stereoMode.leftSpeaker === null && stereoMode.rightSpeaker === null) {
      try {
        const settings = await window.api.getSettings();
        if (settings.lastSpeaker) {
          targetSpeakerIndex = speakers.findIndex(s => s.name === settings.lastSpeaker.name);
          if (targetSpeakerIndex >= 0) {
            log(`Using last speaker: ${settings.lastSpeaker.name}`);
          }
        }
      } catch (e) {
        // Ignore settings error
      }
    }

    // Last resort: use first available speaker
    if (targetSpeakerIndex === null && stereoMode.leftSpeaker === null && stereoMode.rightSpeaker === null) {
      targetSpeakerIndex = 0;
      log(`Using first available speaker: ${speakers[0].name}`);
    }

    // Step 3: Enable PC audio if not already (for calibration to work)
    if (syncHint) syncHint.textContent = 'Enabling PC audio...';

    if (!pcAudioEnabled) {
      log('Enabling PC audio for calibration...');
      await togglePCAudio(true);
      if (pcAudioToggle) pcAudioToggle.checked = true;
      // Wait for Windows audio device to switch
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 4: Start streaming if not already active
    if (!isStreaming && !stereoMode.streaming) {
      if (syncHint) syncHint.textContent = 'Starting audio stream...';
      log('Starting stream for calibration...');

      if (stereoMode.leftSpeaker !== null && stereoMode.rightSpeaker !== null) {
        await startStereoStreaming();
      } else if (targetSpeakerIndex !== null) {
        await startStreamingToSpeaker(targetSpeakerIndex, false);
      }
    }

    // Step 5: Verify streaming actually started
    await new Promise(r => setTimeout(r, 1000));
    if (!isStreaming && !stereoMode.streaming) {
      throw new Error('Stream failed to start. Try selecting a speaker manually.');
    }

    // Step 6: Wait for pipeline to stabilize (10 seconds)
    if (syncHint) syncHint.textContent = 'Waiting for audio to stabilize...';
    log('Waiting 10 seconds for pipeline to stabilize...');

    // Countdown display
    for (let i = 10; i > 0; i--) {
      // Allow cancellation during countdown
      if (!calibrationStarting) {
        log('Calibration cancelled during countdown');
        return;
      }
      if (syncCalibrateBtn) {
        syncCalibrateBtn.textContent = `⏳ ${i}s...`;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // Step 7: Now enable actual calibration mode
    isCalibrating = true;
    pingModeEnabled = true;

    if (syncCalibrateBtn) {
      syncCalibrateBtn.textContent = '✓ Done';
      syncCalibrateBtn.disabled = false;
      syncCalibrateBtn.classList.add('calibrating');
    }
    if (syncVisual) {
      syncVisual.classList.add('calibrating');
    }
    if (syncHint) {
      syncHint.textContent = 'Scroll up/down until you hear ONE ping, then click Done';
    }

    // Play initial ping
    playDualSyncPing();

    log('Calibration ready - scroll to adjust sync delay');

  } catch (err) {
    log(`Calibration setup failed: ${err.message}`, 'error');
    if (syncCalibrateBtn) {
      syncCalibrateBtn.textContent = '🔊 Calibrate';
      syncCalibrateBtn.disabled = false;
    }
    if (syncHint) {
      syncHint.textContent = `Error: ${err.message}`;
    }
  } finally {
    calibrationStarting = false;
  }
}

/**
 * Stop calibration mode (or cancel startup)
 */
function stopCalibration() {
  // If still starting up, just cancel the startup
  if (calibrationStarting) {
    calibrationStarting = false;
    log('Calibration startup cancelled');
  }

  isCalibrating = false;
  pingModeEnabled = false;

  if (syncCalibrateBtn) {
    syncCalibrateBtn.textContent = '🔊 Calibrate';
    syncCalibrateBtn.disabled = false;
    syncCalibrateBtn.classList.remove('calibrating');
  }
  if (syncVisual) {
    syncVisual.classList.remove('calibrating');
  }
  if (syncHint) {
    syncHint.textContent = 'Click Calibrate, then scroll until you hear ONE ping';
  }

  if (currentSyncDelay > 0) {
    log(`Calibration done - sync delay: ${currentSyncDelay}ms`);
  }
}

// Calibrate button click handler
if (syncCalibrateBtn) {
  syncCalibrateBtn.addEventListener('click', () => {
    if (isCalibrating || calibrationStarting) {
      stopCalibration();
    } else {
      startCalibration();
    }
  });
}

// Measure Latency button click handler - auto-measures RTT and sets slider
if (measureLatencyBtn) {
  measureLatencyBtn.addEventListener('click', async () => {
    // Need an active speaker to measure
    const activeSpeaker = speakers.find(s => s.isStreaming);
    if (!activeSpeaker) {
      log('Start streaming to a speaker first to measure latency', 'warning');
      return;
    }

    // Show measuring state
    measureLatencyBtn.classList.add('measuring');
    measureLatencyBtn.textContent = '📡 Measuring...';
    if (syncHint) syncHint.textContent = 'Measuring network latency (~10 seconds)...';

    try {
      log(`Measuring latency to ${activeSpeaker.name}...`, 'info');
      const result = await window.api.measureLatency(activeSpeaker.name, activeSpeaker.ip);

      if (result.success) {
        // Auto-populate the sync delay slider with recommended value
        const recommendedDelay = result.recommendedDelay || 700;
        currentSyncDelay = recommendedDelay;

        if (syncDelaySlider) syncDelaySlider.value = recommendedDelay;
        if (syncDelayValue) syncDelayValue.textContent = `${recommendedDelay}ms`;

        // Apply the delay
        await window.api.setSyncDelay(recommendedDelay);

        log(`Latency measured: RTT=${result.rtt}ms → Recommended delay: ${recommendedDelay}ms`, 'success');
        if (syncHint) syncHint.textContent = `Auto-set to ${recommendedDelay}ms (RTT: ${result.rtt}ms)`;
      } else {
        log(`Failed to measure latency: ${result.error}`, 'error');
        if (syncHint) syncHint.textContent = 'Measurement failed - use manual calibration';
      }
    } catch (error) {
      log(`Error measuring latency: ${error.message}`, 'error');
      if (syncHint) syncHint.textContent = 'Measurement error - use manual calibration';
    } finally {
      // Reset button state
      measureLatencyBtn.classList.remove('measuring');
      measureLatencyBtn.textContent = '📡 Measure';
    }
  });
}

// Scroll wheel for calibration - works anywhere on page when calibrating
document.addEventListener('wheel', (e) => {
  if (!isCalibrating) return;

  e.preventDefault(); // Don't scroll the page

  const step = 10; // 10ms per scroll tick
  const min = 0;

  // Scroll up (negative deltaY) = increase, scroll down = decrease
  if (e.deltaY < 0) {
    currentSyncDelay = Math.min(SYNC_MAX_DELAY, currentSyncDelay + step);
  } else {
    currentSyncDelay = Math.max(min, currentSyncDelay - step);
  }

  // Update hidden slider and display
  if (syncDelaySlider) syncDelaySlider.value = currentSyncDelay;
  if (syncDelayValue) syncDelayValue.textContent = `${currentSyncDelay}ms`;

  // Apply the delay change
  handleSyncDelayChange(currentSyncDelay);
}, { passive: false });

// ===================
// Test Sync Button - Plays beep to help user sync audio
// ===================
const testSyncBtn = document.getElementById('test-sync-btn');
let audioContext = null;

// Clean up all audio when app closes
window.addEventListener('beforeunload', () => {
  // Stop any calibration in progress
  if (isCalibrating) {
    isCalibrating = false;
  }

  // Stop test beep interval
  if (testBeepInterval) {
    clearInterval(testBeepInterval);
    testBeepInterval = null;
  }

  // Close audio context
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
});

/**
 * Play a test beep sound using Web Audio API
 * This plays through the system default audio device (PC speakers)
 * Cast speakers will receive it via the FFmpeg stream with ~1s delay
 */
function playTestBeep() {
  try {
    // Create audio context on demand (browser requires user interaction first)
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Resume if suspended
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    // Create a short beep (click sound)
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Configure beep - 880Hz (A5 note), short duration
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);

    // Sharp attack, quick decay for a "click" sound
    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.15);

    // Play for 150ms
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.15);
  } catch (err) {
    console.error('Test beep failed:', err.message);
  }
}

/**
 * Play repeating test beeps for easier sync calibration
 * Plays 5 beeps, 1 second apart
 */
let testBeepInterval = null;
let testBeepCount = 0;

function startTestSync() {
  if (testBeepInterval) {
    // Already playing - stop it
    stopTestSync();
    return;
  }

  // Show hint
  if (syncHint) {
    syncHint.style.display = 'block';
  }

  // Add playing class to button
  if (testSyncBtn) {
    testSyncBtn.classList.add('playing');
    testSyncBtn.textContent = '⏹️ Stop';
  }

  testBeepCount = 0;
  log('Starting sync test - 5 beeps coming...');

  // Play first beep immediately
  playTestBeep();
  testBeepCount++;

  // Then play 4 more beeps, 1 second apart
  testBeepInterval = setInterval(() => {
    playTestBeep();
    testBeepCount++;

    if (testBeepCount >= 5) {
      stopTestSync();
    }
  }, 1000);
}

function stopTestSync() {
  if (testBeepInterval) {
    clearInterval(testBeepInterval);
    testBeepInterval = null;
  }

  // Remove playing class
  if (testSyncBtn) {
    testSyncBtn.classList.remove('playing');
    testSyncBtn.textContent = '🔊 Test';
  }

  // Hide hint after a delay
  setTimeout(() => {
    if (syncHint && !testBeepInterval) {
      syncHint.style.display = 'none';
    }
  }, 3000);
}

// Test sync button event listener
if (testSyncBtn) {
  testSyncBtn.addEventListener('click', startTestSync);
}

// ===================
// TV Settings (moved from dedicated TV tab)
// ===================
const tvVisualsToggle = document.getElementById('tv-visuals-toggle');

// Handle TV visuals toggle (in Settings tab)
if (tvVisualsToggle) {
  tvVisualsToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    log(`TV ambient visuals: ${enabled ? 'ON' : 'OFF'}`);
    window.api.updateSettings({ tvVisualsEnabled: enabled });
  });
}

// ===================
// Cast URL to TV Feature
// ===================
const castUrlSection = document.getElementById('cast-url-section');
const castUrlInput = document.getElementById('cast-url-input');
const castUrlType = document.getElementById('cast-url-type');
const castUrlBtn = document.getElementById('cast-url-btn');
const castUrlStatus = document.getElementById('cast-url-status');

// Track currently selected TV for URL casting
let selectedTvForUrlCast = null;

// Show/hide Cast URL section based on device selection
function updateCastUrlSection() {
  if (!castUrlSection) return;

  // DISABLED: Don't auto-show Cast URL section when TV selected
  // User can manually trigger this feature if needed via settings
  castUrlSection.style.display = 'none';

  // Still track selected TV for when user manually triggers cast URL
  const isTvSelected = selectedSpeaker && selectedSpeaker.cast_type === 'cast';
  if (isTvSelected) {
    selectedTvForUrlCast = selectedSpeaker;
  }
}

// Handle Cast URL button click
if (castUrlBtn) {
  castUrlBtn.addEventListener('click', async () => {
    if (!selectedTvForUrlCast) {
      if (castUrlStatus) {
        castUrlStatus.textContent = 'No TV selected';
        castUrlStatus.className = 'cast-url-status error';
      }
      return;
    }

    const url = castUrlInput?.value?.trim();
    if (!url) {
      if (castUrlStatus) {
        castUrlStatus.textContent = 'Please enter a URL';
        castUrlStatus.className = 'cast-url-status error';
      }
      return;
    }

    // Get content type (empty string = auto-detect)
    const contentType = castUrlType?.value || null;

    log(`Casting URL to ${selectedTvForUrlCast.name}...`);
    if (castUrlStatus) {
      castUrlStatus.textContent = 'Casting...';
      castUrlStatus.className = 'cast-url-status';
    }

    try {
      const result = await window.api.castUrl(
        selectedTvForUrlCast.name,
        url,
        contentType,
        selectedTvForUrlCast.ip
      );

      if (result.success) {
        log(`URL casting started: ${result.content_type}`, 'success');
        if (castUrlStatus) {
          castUrlStatus.textContent = `Playing on ${selectedTvForUrlCast.name}`;
          castUrlStatus.className = 'cast-url-status success';
        }
      } else {
        log(`URL casting failed: ${result.error}`, 'error');
        if (castUrlStatus) {
          castUrlStatus.textContent = result.error || 'Cast failed';
          castUrlStatus.className = 'cast-url-status error';
        }
      }
    } catch (error) {
      log(`URL casting error: ${error.message}`, 'error');
      if (castUrlStatus) {
        castUrlStatus.textContent = error.message || 'Cast failed';
        castUrlStatus.className = 'cast-url-status error';
      }
    }
  });
}

// Make license functions available globally for onclick handlers
window.showLicenseModal = showLicenseModal;
window.activateLicense = activateLicense;
window.deactivateLicense = deactivateLicense;
window.openPurchaseLink = openPurchaseLink;
window.openSupportLink = openSupportLink;
window.toggleLicenseDetails = toggleLicenseDetails;
