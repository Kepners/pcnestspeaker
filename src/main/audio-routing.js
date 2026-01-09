/**
 * Audio Routing Module - Controls Windows "Listen to this device" feature
 *
 * Uses NirSoft SoundVolumeCommandLine (svcl.exe) to route audio from
 * Virtual Desktop Audio → HDMI speakers for "PC + Speakers" mode.
 *
 * This keeps Cast capture clean (from Virtual Desktop Audio) while
 * allowing local playback on HDMI with APO delay applied.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Path to SoundVolumeCommandLine tool
const SVCL_PATH = path.join(__dirname, '..', '..', 'svcl', 'svcl.exe');

/**
 * Check if SoundVolumeCommandLine is available
 */
function isAvailable() {
  return fs.existsSync(SVCL_PATH);
}

/**
 * Run svcl.exe command
 */
function runSvcl(args) {
  return new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject(new Error('svcl.exe not found - download from nirsoft.net'));
      return;
    }

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
 * Get list of audio devices
 */
async function getDevices() {
  try {
    const output = await runSvcl('/scomma ""');
    // Parse CSV output
    const lines = output.split('\n');
    const devices = [];
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length >= 3) {
        devices.push({
          name: parts[0].replace(/"/g, ''),
          type: parts[1].replace(/"/g, ''),
          id: parts[2].replace(/"/g, '')
        });
      }
    }
    return devices;
  } catch (err) {
    console.error('[AudioRouting] Failed to get devices:', err.message);
    return [];
  }
}

/**
 * Enable "Listen to this device" - routes audio from source to target
 *
 * @param {string} sourceDevice - Capture device to listen FROM (e.g., "Virtual Desktop Audio")
 * @param {string} targetDevice - Render device to listen ON (e.g., "HDMI")
 */
async function enableListening(sourceDevice, targetDevice) {
  try {
    // Set the "Listen to this device" target
    // Format: /SetListenToThisDevice "DeviceName" "TargetDeviceName" 1
    await runSvcl(`/SetListenToThisDevice "${sourceDevice}" "${targetDevice}" 1`);
    console.log(`[AudioRouting] Enabled listening: ${sourceDevice} → ${targetDevice}`);
    return { success: true };
  } catch (err) {
    console.error(`[AudioRouting] Failed to enable listening:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Disable "Listen to this device" on a source device
 *
 * @param {string} sourceDevice - Capture device to stop listening from
 */
async function disableListening(sourceDevice) {
  try {
    // Disable by setting empty target
    await runSvcl(`/SetListenToThisDevice "${sourceDevice}" "" 0`);
    console.log(`[AudioRouting] Disabled listening on: ${sourceDevice}`);
    return { success: true };
  } catch (err) {
    console.error(`[AudioRouting] Failed to disable listening:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Find the virtual audio capture device
 */
async function findVirtualDevice() {
  const devices = await getDevices();
  const virtualNames = [
    'Virtual Desktop Audio',
    'virtual-audio-capturer',
    'CABLE Output',
    'VB-Audio'
  ];

  for (const device of devices) {
    if (device.type === 'Capture') {
      for (const name of virtualNames) {
        if (device.name.toLowerCase().includes(name.toLowerCase())) {
          return device.name;
        }
      }
    }
  }
  return null;
}

/**
 * Find the user's real speakers (HDMI, Realtek, etc.)
 */
async function findRealSpeakers() {
  const devices = await getDevices();
  const realNames = [
    'HDMI',
    'Speakers',
    'Realtek',
    'High Definition Audio',
    'Headphones'
  ];

  for (const device of devices) {
    if (device.type === 'Render') {
      for (const name of realNames) {
        if (device.name.toLowerCase().includes(name.toLowerCase())) {
          return device.name;
        }
      }
    }
  }
  return null;
}

/**
 * Enable PC + Speakers mode
 * Routes Virtual Desktop Audio → HDMI speakers
 */
async function enablePCSpeakersMode() {
  const virtualDevice = await findVirtualDevice();
  const realSpeakers = await findRealSpeakers();

  if (!virtualDevice) {
    return { success: false, error: 'Virtual audio device not found' };
  }

  if (!realSpeakers) {
    return { success: false, error: 'Real speakers not found' };
  }

  console.log(`[AudioRouting] Setting up: ${virtualDevice} → ${realSpeakers}`);
  return await enableListening(virtualDevice, realSpeakers);
}

/**
 * Disable PC + Speakers mode
 * Stops routing audio to local speakers
 */
async function disablePCSpeakersMode() {
  const virtualDevice = await findVirtualDevice();

  if (!virtualDevice) {
    return { success: false, error: 'Virtual audio device not found' };
  }

  return await disableListening(virtualDevice);
}

module.exports = {
  isAvailable,
  getDevices,
  enableListening,
  disableListening,
  findVirtualDevice,
  findRealSpeakers,
  enablePCSpeakersMode,
  disablePCSpeakersMode
};
