/**
 * Audio Routing Module - Manages Windows audio device switching for PC + Speakers mode
 *
 * PC + Speakers mode works by:
 * 1. Keep Windows default on Virtual Desktop Audio (PRE-APO capture for Cast)
 * 2. Enable "Listen to this device" on Virtual Desktop Audio → PC speakers
 * 3. APO delay is applied ONLY on PC speakers output pipeline
 * 4. Cast gets PRE-APO audio, PC speakers get POST-APO delayed audio
 *
 * Uses:
 * - NirSoft SoundVolumeCommandLine (svcl.exe) for device switching
 * - WindowsAudioControl-CLI (audioctl.exe) for "Listen to this device" control
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Path to SoundVolumeCommandLine tool
const SVCL_DIR = path.join(__dirname, '..', '..', 'svcl');
const SVCL_PATH = path.join(SVCL_DIR, 'svcl.exe');

// Path to WindowsAudioControl-CLI (audioctl) tool
const AUDIOCTL_DIR = path.join(__dirname, '..', '..', 'audioctl');
const AUDIOCTL_PATH = path.join(AUDIOCTL_DIR, 'audioctl.exe');

// Store original default device for restoration
let originalDefaultDevice = null;

/**
 * Check if SoundVolumeCommandLine is available (bundled with app)
 */
function isAvailable() {
  return fs.existsSync(SVCL_PATH);
}

/**
 * Check if WindowsAudioControl-CLI (audioctl) is available
 */
function isAudioctlAvailable() {
  const available = fs.existsSync(AUDIOCTL_PATH);
  if (!available) {
    console.log(`[AudioRouting] audioctl.exe not found at: ${AUDIOCTL_PATH}`);
    console.log('[AudioRouting] Download from: https://github.com/Mr5niper/WindowsAudioControl-CLI-wGUI/releases');
  }
  return available;
}

/**
 * Run audioctl.exe command
 * @param {string} args - Command line arguments
 * @returns {Promise<object>} - Parsed JSON response from audioctl
 */
async function runAudioctl(args) {
  if (!isAudioctlAvailable()) {
    throw new Error('audioctl.exe not found. Download from GitHub and place in audioctl/ folder.');
  }

  return new Promise((resolve, reject) => {
    const cmd = `"${AUDIOCTL_PATH}" ${args}`;
    console.log(`[AudioRouting] Running: ${cmd}`);

    exec(cmd, { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[AudioRouting] audioctl error:`, error.message);
        console.error(`[AudioRouting] stderr:`, stderr);
        reject(new Error(stderr || error.message));
      } else {
        console.log(`[AudioRouting] audioctl output:`, stdout.trim());
        // audioctl returns JSON on success
        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch (e) {
          // Not JSON, just return the raw output
          resolve({ success: true, output: stdout.trim() });
        }
      }
    });
  });
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
 * Returns the UNIQUE deviceName (not ambiguous name)
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
        // CRITICAL: Return deviceName (unique) not name (ambiguous)
        console.log(`[AudioRouting] Found real speakers: ${device.deviceName} (display: ${device.name})`);
        return device.deviceName;
      }
    }
  }

  console.log('[AudioRouting] No real speakers found');
  return null;
}

/**
 * Enable "Listen to this device" using audioctl CLI tool
 *
 * Uses WindowsAudioControl-CLI (audioctl.exe) which properly handles the Windows
 * Core Audio API to enable Listen just like the UI does.
 *
 * @param {string} sourceDevice - Device to listen FROM (e.g., "Virtual Desktop Audio")
 * @param {string} targetDevice - Device to play TO (e.g., "ASUS VG32V") - if null, uses default
 */
async function enableListenToDevice(sourceDevice, targetDevice = null) {
  console.log(`[AudioRouting] Enabling Listen: ${sourceDevice} → ${targetDevice || 'default output'}`);

  try {
    // Build the audioctl command
    // audioctl listen --name "Virtual Desktop Audio" --enable --playback-target-name "ASUS VG32V"
    // Note: NO --flow parameter - audioctl doesn't have that option!
    let args = `listen --name "${sourceDevice}" --enable`;

    // If targetDevice is specified, use --playback-target-name for the output device
    if (targetDevice) {
      args += ` --playback-target-name "${targetDevice}"`;
    } else {
      // Empty string means default playback device
      args += ` --playback-target-name ""`;
    }

    const result = await runAudioctl(args);

    console.log(`[AudioRouting] Listen enabled successfully`);
    return { success: true, result };
  } catch (err) {
    console.error(`[AudioRouting] Failed to enable Listen:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Disable "Listen to this device" using audioctl CLI tool
 *
 * Uses WindowsAudioControl-CLI (audioctl.exe) which properly handles the Windows
 * Core Audio API to disable Listen just like the UI does.
 *
 * @param {string} sourceDevice - Device to stop listening from
 */
async function disableListenToDevice(sourceDevice) {
  console.log(`[AudioRouting] Disabling Listen on: ${sourceDevice}`);

  try {
    // audioctl listen --name "Virtual Desktop Audio" --disable
    // Note: NO --flow parameter - audioctl doesn't have that option!
    const args = `listen --name "${sourceDevice}" --disable`;

    const result = await runAudioctl(args);

    console.log(`[AudioRouting] Listen disabled successfully`);
    return { success: true, result };
  } catch (err) {
    console.error(`[AudioRouting] Failed to disable Listen:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Enable PC + Speakers mode
 *
 * CORRECT ARCHITECTURE:
 * 1. Keep Windows default on Virtual Desktop Audio (so FFmpeg captures PRE-APO)
 * 2. Enable "Listen to this device" on Virtual Desktop Audio → PC speakers
 * 3. APO delay is applied ONLY on PC speakers pipeline
 * 4. Cast gets PRE-APO audio, PC speakers get POST-APO audio
 *
 * @param {string} targetDevice - Optional specific PC speaker device name
 */
async function enablePCSpeakersMode(targetDevice = null) {
  console.log('[AudioRouting] enablePCSpeakersMode called');

  try {
    // Step 1: Find virtual device (keep this as Windows default)
    const virtualDevice = await findVirtualDevice();
    if (!virtualDevice) {
      return { success: false, error: 'No virtual audio device found. Install Virtual Desktop Audio.' };
    }

    // Step 2: Find PC speakers (target for Listen)
    const pcSpeakers = targetDevice || await findRealSpeakers();
    if (!pcSpeakers) {
      return { success: false, error: 'No PC speakers found. Please check your audio devices.' };
    }

    // Step 3: Ensure Windows default is on virtual device (for PRE-APO capture)
    const currentDefault = await getCurrentDefaultDevice();
    if (currentDefault !== virtualDevice) {
      console.log(`[AudioRouting] Switching default to virtual device: ${virtualDevice}`);
      await setDefaultDevice(virtualDevice);
    }

    // Step 4: Enable "Listen to this device" - route virtual audio to PC speakers
    // This creates a SEPARATE pipeline where APO delay is applied
    const listenResult = await enableListenToDevice(virtualDevice, pcSpeakers);
    if (!listenResult.success) {
      return listenResult;
    }

    console.log(`[AudioRouting] PC + Speakers mode enabled!`);
    console.log(`[AudioRouting]   Default: ${virtualDevice} (PRE-APO, captured by FFmpeg)`);
    console.log(`[AudioRouting]   Listen → ${pcSpeakers} (POST-APO, delayed for sync)`);
    return { success: true, virtualDevice, pcSpeakers };
  } catch (err) {
    console.error('[AudioRouting] Failed to enable PC + Speakers mode:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Find a virtual audio device for "Speakers Only" mode
 * Returns the UNIQUE deviceName (e.g., "Virtual Desktop Audio") not ambiguous name ("Speakers")
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
        // CRITICAL: Return deviceName (unique) not name (ambiguous "Speakers")
        // Multiple devices can have name="Speakers" but deviceName is unique
        console.log(`[AudioRouting] Found virtual device: ${device.deviceName} (display: ${device.name})`);
        return device.deviceName;
      }
    }
  }

  console.log('[AudioRouting] No virtual device found');
  return null;
}

/**
 * Disable PC + Speakers mode (switch to "Speakers Only")
 *
 * 1. Disable "Listen to this device" so PC speakers stop playing
 * 2. Keep Windows default on virtual device (FFmpeg keeps capturing)
 * 3. Only Cast gets audio now
 */
async function disablePCSpeakersMode() {
  console.log('[AudioRouting] disablePCSpeakersMode called (Speakers Only mode)');

  try {
    // Find virtual device
    const virtualDevice = await findVirtualDevice();

    if (virtualDevice) {
      // Disable Listen - PC speakers stop playing
      await disableListenToDevice(virtualDevice);

      // Ensure default is still virtual device
      const currentDefault = await getCurrentDefaultDevice();
      if (currentDefault !== virtualDevice) {
        await setDefaultDevice(virtualDevice);
      }

      console.log(`[AudioRouting] Speakers Only mode: ${virtualDevice} → Cast only (no PC speakers)`);
      return { success: true, device: virtualDevice };
    }

    console.log('[AudioRouting] No virtual device found');
    return { success: false, error: 'No virtual audio device found. Install Virtual Desktop Audio or VB-Cable.' };
  } catch (err) {
    console.error('[AudioRouting] Failed to switch to Speakers Only mode:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  isAvailable,
  isAudioctlAvailable,
  getDevices,
  getRenderDevices,
  getCurrentDefaultDevice,
  setDefaultDevice,
  findRealSpeakers,
  findVirtualDevice,
  enableListenToDevice,
  disableListenToDevice,
  enablePCSpeakersMode,
  disablePCSpeakersMode
};
