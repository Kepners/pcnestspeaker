/**
 * Windows Volume Sync
 *
 * Monitors Windows master volume and syncs it to Nest speakers.
 * When user presses volume up/down on keyboard, Nest speaker follows.
 */

const { exec, spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');

// Path helper for production vs development
function getSoundVolumeViewPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'soundvolumeview', 'SoundVolumeView.exe')
    : path.join(__dirname, '..', '..', 'soundvolumeview', 'SoundVolumeView.exe');
}

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

// Path helper for nircmd in production vs development
function getNircmdPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'nircmd', 'nircmd.exe')
    : path.join(__dirname, '..', '..', 'nircmd', 'nircmd.exe');
}

/**
 * Fallback method using nircmd
 */
function getWindowsVolumeFallback() {
  return new Promise((resolve, reject) => {
    // Use nircmd to get volume (returns 0-65535)
    const nircmdPath = getNircmdPath();
    exec(`"${nircmdPath}" setsysvolume 0`, { windowsHide: true }, (error) => {
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
  // Always update targets and callback, even if already monitoring
  // This fixes the bug where switching devices didn't update volume targets
  targetSpeakers = speakers;
  onVolumeChangeCallback = callback;

  console.log('[VolumeSync] Target speakers:', speakers.map(s => s.name).join(', '));

  if (isMonitoring) {
    console.log('[VolumeSync] Already monitoring, updated targets');
    return;
  }

  isMonitoring = true;
  console.log('[VolumeSync] Starting Windows volume monitoring...');

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
 * Get Windows volume via PowerShell using native Core Audio API
 * Works on any Windows 10/11 without external modules
 */
function getWindowsVolumeViaPowerShell() {
  return new Promise((resolve) => {
    // Write the PowerShell script to a temp file to avoid escaping issues
    const fs = require('fs');
    const os = require('os');
    const scriptPath = path.join(os.tmpdir(), 'get-volume.ps1');

    // PowerShell script using Core Audio API directly
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int GetVolumeRange(out float pflMin, out float pflMax, out float pflIncr);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

public static class Audio {
    public static float GetVolume() {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        IAudioEndpointVolume epVol = null;
        var guid = typeof(IAudioEndpointVolume).GUID;
        dev.Activate(ref guid, 0x17, 0, out epVol);
        float v = -1;
        epVol.GetMasterVolumeLevelScalar(out v);
        return v;
    }
}
"@
[int]([Audio]::GetVolume() * 100)
`;

    try {
      fs.writeFileSync(scriptPath, psScript, 'utf8');
    } catch (e) {
      console.error('[VolumeSync] Failed to write script:', e.message);
      resolve(lastVolume !== -1 ? lastVolume : 50);
      return;
    }

    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[VolumeSync] PowerShell error:', stderr || error.message);
          resolve(lastVolume !== -1 ? lastVolume : 50);
        } else {
          const volume = parseInt(stdout.trim());
          if (isNaN(volume)) {
            console.error('[VolumeSync] Invalid volume output:', stdout);
            resolve(lastVolume !== -1 ? lastVolume : 50);
          } else {
            // Don't log here - pollVolume() logs on change only
            resolve(volume);
          }
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

// Saved volume for cast mode switching
let savedVolumeForCastMode = null;

/**
 * Set Windows master volume (0-100)
 * Uses Core Audio API via PowerShell
 */
function setWindowsVolume(volume) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const os = require('os');
    const scriptPath = path.join(os.tmpdir(), 'set-volume.ps1');

    const volumeLevel = Math.max(0, Math.min(100, volume)) / 100; // 0.0 to 1.0

    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int GetVolumeRange(out float pflMin, out float pflMax, out float pflIncr);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

public static class Audio {
    public static void SetVolume(float level) {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        IAudioEndpointVolume epVol = null;
        var guid = typeof(IAudioEndpointVolume).GUID;
        dev.Activate(ref guid, 0x17, 0, out epVol);
        epVol.SetMasterVolumeLevelScalar(level, System.Guid.Empty);
    }
}
"@
[Audio]::SetVolume(${volumeLevel})
Write-Output "OK"
`;

    try {
      fs.writeFileSync(scriptPath, psScript, 'utf8');
    } catch (e) {
      console.error('[VolumeSync] Failed to write set-volume script:', e.message);
      reject(new Error('Failed to write PowerShell script'));
      return;
    }

    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[VolumeSync] Set volume error:', stderr || error.message);
          reject(new Error(stderr || error.message));
        } else {
          console.log(`[VolumeSync] Windows volume set to ${volume}%`);
          resolve(volume);
        }
      }
    );
  });
}

/**
 * Switch to "Speakers Only" mode - mute PC, save original volume
 */
async function switchToSpeakersOnlyMode() {
  try {
    // Save current volume before muting
    const currentVolume = await getWindowsVolumeViaPowerShell();
    if (currentVolume > 0) {
      savedVolumeForCastMode = currentVolume;
      console.log(`[VolumeSync] Saved volume ${currentVolume}% before muting`);
    }

    // Mute PC (set to 0) - WASAPI loopback still captures audio!
    await setWindowsVolume(0);
    console.log('[VolumeSync] Switched to Speakers Only mode (PC muted)');

    return { success: true, savedVolume: savedVolumeForCastMode };
  } catch (error) {
    console.error('[VolumeSync] Failed to switch to Speakers Only:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Switch to "PC + Speakers" mode - restore volume
 */
async function switchToPCSpeakersMode() {
  try {
    // Restore saved volume (or default to 50%)
    const volumeToRestore = savedVolumeForCastMode || 50;
    await setWindowsVolume(volumeToRestore);
    console.log(`[VolumeSync] Restored volume to ${volumeToRestore}%`);

    savedVolumeForCastMode = null;
    console.log('[VolumeSync] Switched to PC + Speakers mode');

    return { success: true, restoredVolume: volumeToRestore };
  } catch (error) {
    console.error('[VolumeSync] Failed to switch to PC + Speakers:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Set volume on a specific audio device (not just default)
 * Uses SoundVolumeView for reliable per-device volume control
 * @param {string} deviceName - The device name (e.g., "Speakers (Realtek)")
 * @param {number} volume - Volume level 0-100
 */
function setDeviceVolume(deviceName, volume) {
  return new Promise((resolve, reject) => {
    const svvPath = getSoundVolumeViewPath();
    const fs = require('fs');

    if (!fs.existsSync(svvPath)) {
      console.error('[VolumeSync] SoundVolumeView not found:', svvPath);
      reject(new Error('SoundVolumeView not found'));
      return;
    }

    // SoundVolumeView syntax: /SetVolume "DeviceName" <percent>
    const volumePercent = Math.max(0, Math.min(100, volume));
    const cmd = `"${svvPath}" /SetVolume "${deviceName}" ${volumePercent}`;

    exec(cmd, { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[VolumeSync] Failed to set volume on ${deviceName}:`, stderr || error.message);
        reject(new Error(stderr || error.message));
      } else {
        console.log(`[VolumeSync] Set ${deviceName} volume to ${volumePercent}%`);
        resolve(volumePercent);
      }
    });
  });
}

// PC speaker device name (cached for fast access)
let pcSpeakerDevice = null;

/**
 * Set the PC speaker device name for volume control
 * @param {string} deviceName - The PC speaker device name
 */
function setPCSpeakerDevice(deviceName) {
  pcSpeakerDevice = deviceName;
  console.log(`[VolumeSync] PC speaker device set to: ${deviceName}`);
}

/**
 * Set volume on PC speakers (if device is configured)
 * @param {number} volume - Volume level 0-100
 */
async function setPCSpeakerVolume(volume) {
  if (!pcSpeakerDevice) {
    console.log('[VolumeSync] No PC speaker device configured');
    return false;
  }

  try {
    await setDeviceVolume(pcSpeakerDevice, volume);
    return true;
  } catch (error) {
    console.error('[VolumeSync] Failed to set PC speaker volume:', error.message);
    return false;
  }
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  getWindowsVolume: getWindowsVolumeViaPowerShell,
  setWindowsVolume,
  setVolumeOnSpeakers,
  switchToSpeakersOnlyMode,
  switchToPCSpeakersMode,
  setDeviceVolume,
  setPCSpeakerDevice,
  setPCSpeakerVolume
};
