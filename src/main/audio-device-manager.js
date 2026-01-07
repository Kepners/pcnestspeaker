/**
 * Audio Device Manager - Windows Default Audio Device Switching
 *
 * Automatically switches Windows default audio output when streaming starts
 * and restores the original device when streaming stops.
 *
 * Uses NirCmd (simple, reliable, no PowerShell needed)
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// NirCmd is a tiny (47KB) command-line utility for Windows
// Download from: https://www.nirsoft.net/utils/nircmd.html
// We'll bundle it with the app
const NIRCMD_PATH = path.join(__dirname, '../../nircmd', 'nircmd.exe');

let originalAudioDevice = null;

/**
 * Get the current default audio device name
 */
function getCurrentAudioDevice() {
  return new Promise((resolve, reject) => {
    // Use Windows WMIC to get current audio device
    const cmd = 'wmic soundconfig get defaultsoundplayback /value';

    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      // Parse output: "DefaultSoundPlayback=Device Name"
      const match = stdout.match(/DefaultSoundPlayback=(.+)/);
      if (match && match[1]) {
        const deviceName = match[1].trim();
        resolve(deviceName);
      } else {
        reject(new Error('Could not determine current audio device'));
      }
    });
  });
}

/**
 * Set Windows default audio playback device
 * @param {string} deviceName - Name of the audio device
 */
function setDefaultAudioDevice(deviceName) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(NIRCMD_PATH)) {
      reject(new Error('NirCmd not found. Please install audio device switching utilities.'));
      return;
    }

    // NirCmd command to set default audio device
    // Format: nircmd.exe setdefaultsounddevice "Device Name" 1
    const args = ['setdefaultsounddevice', deviceName, '1'];

    const process = spawn(NIRCMD_PATH, args, {
      windowsHide: true,
      stdio: 'pipe'
    });

    let errorOutput = '';

    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    process.on('close', (code) => {
      if (code === 0) {
        console.log(`[AudioDeviceManager] Switched to: ${deviceName}`);
        resolve();
      } else {
        reject(new Error(`Failed to switch audio device: ${errorOutput || 'Unknown error'}`));
      }
    });

    process.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Switch to streaming audio device (virtual-audio-capturer)
 * Saves the current device for later restoration
 */
async function switchToStreamingDevice() {
  try {
    // Save current device
    originalAudioDevice = await getCurrentAudioDevice();
    console.log(`[AudioDeviceManager] Original device: ${originalAudioDevice}`);

    // Switch to virtual audio device
    // Note: The exact device name might vary - we'll try common names
    const virtualDeviceNames = [
      'virtual-audio-capturer',
      'Virtual Audio Capturer',
      'CABLE Input',
      'VB-Audio Virtual Cable'
    ];

    let switched = false;
    for (const deviceName of virtualDeviceNames) {
      try {
        await setDefaultAudioDevice(deviceName);
        console.log(`[AudioDeviceManager] Successfully switched to: ${deviceName}`);
        switched = true;
        break;
      } catch (err) {
        // Try next device name
        continue;
      }
    }

    if (!switched) {
      throw new Error('Could not find virtual audio device. Please ensure virtual-audio-capturer is installed.');
    }

    return { success: true, originalDevice: originalAudioDevice };
  } catch (error) {
    console.error('[AudioDeviceManager] Failed to switch to streaming device:', error);
    throw error;
  }
}

/**
 * Restore the original audio device
 */
async function restoreOriginalDevice() {
  if (!originalAudioDevice) {
    console.log('[AudioDeviceManager] No original device to restore');
    return { success: false, message: 'No original device saved' };
  }

  try {
    await setDefaultAudioDevice(originalAudioDevice);
    console.log(`[AudioDeviceManager] Restored original device: ${originalAudioDevice}`);
    originalAudioDevice = null;
    return { success: true };
  } catch (error) {
    console.error('[AudioDeviceManager] Failed to restore original device:', error);
    throw error;
  }
}

module.exports = {
  switchToStreamingDevice,
  restoreOriginalDevice,
  getCurrentAudioDevice,
  setDefaultAudioDevice
};
