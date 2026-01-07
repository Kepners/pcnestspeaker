/**
 * Windows Volume Sync
 *
 * Monitors Windows master volume and syncs it to Nest speakers.
 * When user presses volume up/down on keyboard, Nest speaker follows.
 */

const { exec, spawn } = require('child_process');
const path = require('path');

// Debounce to avoid spamming the speaker
let volumeDebounceTimer = null;
const DEBOUNCE_MS = 200;

// Track current state
let isMonitoring = false;
let monitorProcess = null;
let lastVolume = -1;
let onVolumeChangeCallback = null;

// Speaker info for fast volume control
let targetSpeakers = [];  // Array of { name, ip } for stereo support

/**
 * Get current Windows master volume (0-100)
 */
function getWindowsVolume() {
  return new Promise((resolve, reject) => {
    // PowerShell command to get master volume
    const ps = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `[Math]::Round((Get-AudioDevice -PlaybackVolume))`
    ], { windowsHide: true });

    let output = '';
    ps.stdout.on('data', (data) => {
      output += data.toString();
    });

    ps.on('close', (code) => {
      if (code === 0) {
        const volume = parseInt(output.trim());
        if (!isNaN(volume)) {
          resolve(volume);
        } else {
          // Fallback: try alternative method
          getWindowsVolumeFallback().then(resolve).catch(reject);
        }
      } else {
        getWindowsVolumeFallback().then(resolve).catch(reject);
      }
    });

    ps.on('error', () => {
      getWindowsVolumeFallback().then(resolve).catch(reject);
    });
  });
}

/**
 * Fallback method using nircmd
 */
function getWindowsVolumeFallback() {
  return new Promise((resolve, reject) => {
    // Use nircmd to get volume (returns 0-65535)
    const nircmdPath = path.join(__dirname, '..', '..', 'nircmd', 'nircmd.exe');
    exec(`"${nircmdPath}" setsysvolume 0`, (error) => {
      // nircmd doesn't have a get volume command, so we'll poll
      resolve(50); // Default to 50% if we can't get it
    });
  });
}

/**
 * Start monitoring Windows volume changes
 * @param {Object[]} speakers - Array of speaker objects with { name, ip }
 * @param {Function} callback - Called with (volume) when volume changes
 */
function startMonitoring(speakers, callback) {
  if (isMonitoring) {
    console.log('[VolumeSync] Already monitoring');
    return;
  }

  targetSpeakers = speakers;
  onVolumeChangeCallback = callback;
  isMonitoring = true;

  console.log('[VolumeSync] Starting Windows volume monitoring...');
  console.log('[VolumeSync] Target speakers:', speakers.map(s => s.name).join(', '));

  // Poll Windows volume every 500ms
  // (Windows doesn't have a clean event API for this without native modules)
  pollVolume();
}

/**
 * Poll Windows volume and detect changes
 */
async function pollVolume() {
  if (!isMonitoring) return;

  try {
    const volume = await getWindowsVolumeViaPowerShell();

    if (lastVolume !== -1 && volume !== lastVolume) {
      console.log(`[VolumeSync] Windows volume changed: ${lastVolume}% -> ${volume}%`);
      handleVolumeChange(volume);
    }

    lastVolume = volume;
  } catch (error) {
    // Silently ignore polling errors
  }

  // Continue polling if still monitoring
  if (isMonitoring) {
    setTimeout(pollVolume, 500);
  }
}

/**
 * Get Windows volume via PowerShell (more reliable)
 */
function getWindowsVolumeViaPowerShell() {
  return new Promise((resolve, reject) => {
    // Simple PowerShell one-liner to get volume
    exec(
      'powershell -NoProfile -Command "(Get-AudioDevice -PlaybackVolume)"',
      { timeout: 2000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // Fallback: try using .NET directly
          exec(
            'powershell -NoProfile -Command "[Audio]::Volume"',
            { timeout: 2000, windowsHide: true },
            (err2, stdout2) => {
              if (err2) {
                resolve(lastVolume !== -1 ? lastVolume : 50);
              } else {
                const vol = parseFloat(stdout2.trim()) * 100;
                resolve(Math.round(vol));
              }
            }
          );
        } else {
          const volume = parseInt(stdout.trim());
          resolve(isNaN(volume) ? 50 : volume);
        }
      }
    );
  });
}

/**
 * Handle volume change with debouncing
 */
function handleVolumeChange(volume) {
  // Clear existing timer
  if (volumeDebounceTimer) {
    clearTimeout(volumeDebounceTimer);
  }

  // Debounce to avoid spamming during rapid changes
  volumeDebounceTimer = setTimeout(() => {
    if (onVolumeChangeCallback) {
      onVolumeChangeCallback(volume);
    }
  }, DEBOUNCE_MS);
}

/**
 * Stop monitoring
 */
function stopMonitoring() {
  console.log('[VolumeSync] Stopping volume monitoring');
  isMonitoring = false;
  targetSpeakers = [];
  onVolumeChangeCallback = null;
  lastVolume = -1;

  if (volumeDebounceTimer) {
    clearTimeout(volumeDebounceTimer);
    volumeDebounceTimer = null;
  }
}

/**
 * Set volume on all target speakers
 * Uses cached IP for fast connection
 */
async function setVolumeOnSpeakers(volume, runPythonFn) {
  const volumeLevel = volume / 100;  // Convert 0-100 to 0.0-1.0

  console.log(`[VolumeSync] Setting volume to ${volume}% on ${targetSpeakers.length} speaker(s)`);

  // Set volume on all speakers in parallel
  const promises = targetSpeakers.map(speaker => {
    return runPythonFn([
      'set-volume-fast',
      speaker.name,
      volumeLevel.toString(),
      speaker.ip || ''
    ]).catch(err => {
      console.error(`[VolumeSync] Failed to set volume on ${speaker.name}:`, err.message);
    });
  });

  await Promise.all(promises);
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  getWindowsVolume: getWindowsVolumeViaPowerShell,
  setVolumeOnSpeakers
};
