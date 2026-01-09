/**
 * Audio Routing Module - Manages Windows audio device switching for PC + Speakers mode
 *
 * PC + Speakers mode works by:
 * 1. Setting Windows default output to the user's PC speakers (e.g., ASUS VG32V)
 * 2. virtual-audio-capturer captures system audio (what's playing on default device)
 * 3. FFmpeg sends that audio to Cast
 * 4. Equalizer APO delays the PC speakers to sync with Cast latency
 *
 * Uses NirSoft SoundVolumeCommandLine (svcl.exe) for device switching.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Path to SoundVolumeCommandLine tool
const SVCL_DIR = path.join(__dirname, '..', '..', 'svcl');
const SVCL_PATH = path.join(SVCL_DIR, 'svcl.exe');
// Store original default device for restoration
let originalDefaultDevice = null;

/**
 * Check if SoundVolumeCommandLine is available (bundled with app)
 */
function isAvailable() {
  return fs.existsSync(SVCL_PATH);
}

/**
 * Run svcl.exe command
 */
async function runSvcl(args) {
  if (!isAvailable()) {
    throw new Error('svcl.exe not found. It should be bundled with the app.');
  }

  return new Promise((resolve, reject) => {
    const cmd = `"${SVCL_PATH}" ${args}`;
    console.log(`[AudioRouting] Running: ${cmd}`);

    exec(cmd, { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[AudioRouting] Error:`, error.message);
        reject(error);
      } else {
        console.log(`[AudioRouting] Success:`, stdout.trim() || 'OK');
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Parse a CSV line properly, handling quoted fields with commas
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Get list of audio devices
 */
async function getDevices() {
  try {
    const output = await runSvcl('/scomma ""');
    // Parse CSV output with proper quote handling
    // Format: Name,Type,Direction,Device Name,Default,...
    const lines = output.split('\n').filter(l => l.trim());
    const devices = [];

    for (const line of lines) {
      const parts = parseCSVLine(line);
      if (parts.length >= 5 && parts[1] === 'Device') {
        devices.push({
          name: parts[0],
          type: parts[1],           // "Device" or "Application" etc.
          direction: parts[2],      // "Capture" or "Render"
          deviceName: parts[3],     // Full device name (e.g., "NVIDIA High Definition Audio")
          isDefault: parts[4] === 'Render' // Check if this is the default render device
        });
      }
    }
    console.log(`[AudioRouting] Parsed ${devices.length} device entries`);
    return devices;
  } catch (err) {
    console.error('[AudioRouting] Failed to get devices:', err.message);
    return [];
  }
}

/**
 * Get the current default render (output) device
 */
async function getCurrentDefaultDevice() {
  const devices = await getDevices();
  const defaultDevice = devices.find(d => d.direction === 'Render' && d.isDefault);
  if (defaultDevice) {
    console.log(`[AudioRouting] Current default device: ${defaultDevice.name}`);
    return defaultDevice.name;
  }
  return null;
}

/**
 * Set the default Windows audio output device
 * @param {string} deviceName - Name of the device (e.g., "ASUS VG32V")
 */
async function setDefaultDevice(deviceName) {
  try {
    // svcl uses /SetDefault to set a device as default for all roles
    await runSvcl(`/SetDefault "${deviceName}" all`);
    console.log(`[AudioRouting] Set default device to: ${deviceName}`);
    return { success: true };
  } catch (err) {
    console.error(`[AudioRouting] Failed to set default device:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get all Render (output) devices
 */
async function getRenderDevices() {
  const devices = await getDevices();
  return devices.filter(d => d.direction === 'Render');
}

/**
 * Find the user's real speakers (HDMI, monitor speakers, etc.)
 * Returns the first matching device by priority
 */
async function findRealSpeakers() {
  const devices = await getRenderDevices();

  // Priority order for finding real speakers
  const priorityPatterns = [
    'ASUS',                    // Gaming monitors with speakers (user's device)
    'HDMI',                    // HDMI audio output
    'NVIDIA High Definition',  // NVIDIA HDMI
    'Realtek',                 // Onboard audio
    'High Definition Audio',   // Generic HD Audio
    'Speakers',                // Default speakers
    'Headphones'               // Headphones
  ];

  // Skip these virtual devices
  const skipPatterns = [
    'Virtual Desktop Audio',
    'VB-Audio',
    'CABLE',
    'Steam Streaming',
    'Oculus',
    'DroidCam'
  ];

  for (const pattern of priorityPatterns) {
    for (const device of devices) {
      const nameLower = device.name.toLowerCase();
      const deviceNameLower = device.deviceName.toLowerCase();

      // Skip virtual devices
      const isVirtual = skipPatterns.some(skip =>
        nameLower.includes(skip.toLowerCase()) ||
        deviceNameLower.includes(skip.toLowerCase())
      );
      if (isVirtual) continue;

      if (nameLower.includes(pattern.toLowerCase()) ||
          deviceNameLower.includes(pattern.toLowerCase())) {
        console.log(`[AudioRouting] Found real speakers: ${device.name} (${device.deviceName})`);
        return device.name;
      }
    }
  }

  console.log('[AudioRouting] No real speakers found');
  return null;
}

/**
 * Enable PC + Speakers mode
 *
 * Sets Windows default output to the user's PC speakers (e.g., ASUS VG32V)
 * so audio plays locally. virtual-audio-capturer will capture this audio
 * for Cast streaming. APO applies delay to sync with Cast latency.
 *
 * @param {string} targetDevice - Optional specific device name to use
 */
async function enablePCSpeakersMode(targetDevice = null) {
  console.log('[AudioRouting] enablePCSpeakersMode called');

  try {
    // Save current default device so we can restore it later
    originalDefaultDevice = await getCurrentDefaultDevice();
    console.log(`[AudioRouting] Saved original device: ${originalDefaultDevice}`);

    // Find target device (PC speakers)
    const pcSpeakers = targetDevice || await findRealSpeakers();

    if (!pcSpeakers) {
      return { success: false, error: 'No PC speakers found. Please check your audio devices.' };
    }

    // If already set to this device, nothing to do
    if (originalDefaultDevice === pcSpeakers) {
      console.log(`[AudioRouting] Already using ${pcSpeakers} as default`);
      return { success: true, device: pcSpeakers };
    }

    // Switch Windows default to PC speakers
    const result = await setDefaultDevice(pcSpeakers);
    if (!result.success) {
      return result;
    }

    console.log(`[AudioRouting] PC + Speakers mode enabled! Output: ${pcSpeakers}`);
    return { success: true, device: pcSpeakers };
  } catch (err) {
    console.error('[AudioRouting] Failed to enable PC + Speakers mode:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Find a virtual audio device for "Speakers Only" mode
 * Returns the first virtual device found
 */
async function findVirtualDevice() {
  const devices = await getRenderDevices();

  // Virtual devices to look for (in priority order)
  const virtualPatterns = [
    'Virtual Desktop Audio',
    'CABLE Input',
    'VB-Audio Virtual Cable',
    'VoiceMeeter'
  ];

  for (const pattern of virtualPatterns) {
    for (const device of devices) {
      if (device.name.toLowerCase().includes(pattern.toLowerCase()) ||
          device.deviceName.toLowerCase().includes(pattern.toLowerCase())) {
        console.log(`[AudioRouting] Found virtual device: ${device.name}`);
        return device.name;
      }
    }
  }

  console.log('[AudioRouting] No virtual device found');
  return null;
}

/**
 * Disable PC + Speakers mode (switch to "Speakers Only")
 *
 * Switches Windows default to a virtual audio device so audio
 * ONLY goes to Cast speakers (not PC speakers).
 */
async function disablePCSpeakersMode() {
  console.log('[AudioRouting] disablePCSpeakersMode called (Speakers Only mode)');

  try {
    // Find a virtual audio device to switch to
    const virtualDevice = await findVirtualDevice();

    if (virtualDevice) {
      console.log(`[AudioRouting] Switching to virtual device: ${virtualDevice}`);
      const result = await setDefaultDevice(virtualDevice);
      if (result.success) {
        console.log(`[AudioRouting] Speakers Only mode: audio goes to ${virtualDevice}`);
        return { success: true, device: virtualDevice };
      }
      return result;
    }

    // Fallback: try to restore original if we have it
    if (originalDefaultDevice) {
      console.log(`[AudioRouting] No virtual device, restoring: ${originalDefaultDevice}`);
      const result = await setDefaultDevice(originalDefaultDevice);
      originalDefaultDevice = null;
      return result;
    }

    console.log('[AudioRouting] No virtual device found and no original to restore');
    return { success: false, error: 'No virtual audio device found. Install Virtual Desktop Audio or VB-Cable.' };
  } catch (err) {
    console.error('[AudioRouting] Failed to switch to Speakers Only mode:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  isAvailable,
  getDevices,
  getRenderDevices,
  getCurrentDefaultDevice,
  setDefaultDevice,
  findRealSpeakers,
  enablePCSpeakersMode,
  disablePCSpeakersMode
};
