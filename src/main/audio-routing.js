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
const https = require('https');

// Path to SoundVolumeCommandLine tool
const SVCL_DIR = path.join(__dirname, '..', '..', 'svcl');
const SVCL_PATH = path.join(SVCL_DIR, 'svcl.exe');
const SVCL_DOWNLOAD_URL = 'https://www.nirsoft.net/utils/svcl-x64.zip';

// Track download state
let isDownloading = false;
let downloadPromise = null;

/**
 * Check if SoundVolumeCommandLine is available
 */
function isAvailable() {
  return fs.existsSync(SVCL_PATH);
}

/**
 * Download and extract svcl.exe from NirSoft
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function downloadSvcl() {
  // Prevent duplicate downloads
  if (isDownloading && downloadPromise) {
    console.log('[AudioRouting] Download already in progress, waiting...');
    return downloadPromise;
  }

  if (isAvailable()) {
    return { success: true, message: 'Already installed' };
  }

  isDownloading = true;
  downloadPromise = new Promise((resolve) => {
    console.log('[AudioRouting] Downloading svcl.exe from NirSoft...');

    // Ensure svcl directory exists
    if (!fs.existsSync(SVCL_DIR)) {
      fs.mkdirSync(SVCL_DIR, { recursive: true });
    }

    const zipPath = path.join(SVCL_DIR, 'svcl.zip');
    const file = fs.createWriteStream(zipPath);

    https.get(SVCL_DOWNLOAD_URL, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        https.get(response.headers.location, (redirectResponse) => {
          redirectResponse.pipe(file);
          file.on('finish', () => {
            file.close();
            extractZip(zipPath, resolve);
          });
        }).on('error', (err) => {
          fs.unlink(zipPath, () => {});
          isDownloading = false;
          resolve({ success: false, error: `Download failed: ${err.message}` });
        });
        return;
      }

      if (response.statusCode !== 200) {
        isDownloading = false;
        resolve({ success: false, error: `Download failed: HTTP ${response.statusCode}` });
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        extractZip(zipPath, resolve);
      });
    }).on('error', (err) => {
      fs.unlink(zipPath, () => {});
      isDownloading = false;
      resolve({ success: false, error: `Download failed: ${err.message}` });
    });
  });

  return downloadPromise;
}

/**
 * Extract svcl.exe from zip file using PowerShell
 */
function extractZip(zipPath, resolve) {
  console.log('[AudioRouting] Extracting svcl.exe...');

  // Use PowerShell to extract (works on all Windows versions)
  const psCommand = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/\\/g, '\\\\')}')
    $entry = $zip.Entries | Where-Object { $_.Name -eq 'svcl.exe' }
    if ($entry) {
      $destPath = '${SVCL_PATH.replace(/\\/g, '\\\\')}'
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destPath, $true)
    }
    $zip.Dispose()
  `;

  exec(`powershell -NoProfile -Command "${psCommand}"`, { windowsHide: true }, (error) => {
    // Clean up zip file
    fs.unlink(zipPath, () => {});
    isDownloading = false;

    if (error) {
      console.error('[AudioRouting] Extract failed:', error.message);
      resolve({ success: false, error: `Extract failed: ${error.message}` });
      return;
    }

    if (fs.existsSync(SVCL_PATH)) {
      console.log('[AudioRouting] svcl.exe installed successfully!');
      resolve({ success: true });
    } else {
      resolve({ success: false, error: 'Extract completed but svcl.exe not found' });
    }
  });
}

/**
 * Ensure svcl.exe is available, download if needed
 */
async function ensureAvailable() {
  if (isAvailable()) {
    return { success: true };
  }
  return await downloadSvcl();
}

/**
 * Run svcl.exe command (auto-downloads if not available)
 */
async function runSvcl(args) {
  // Auto-download if not available
  if (!isAvailable()) {
    console.log('[AudioRouting] svcl.exe not found, downloading...');
    const downloadResult = await ensureAvailable();
    if (!downloadResult.success) {
      throw new Error(`Failed to download svcl.exe: ${downloadResult.error}`);
    }
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
 * Uses two commands (per NirSoft documentation):
 * 1. /SetListenToThisDevice "DeviceName" 1 - enables listening
 * 2. /SetPlaybackThroughDevice "SourceDevice" "TargetDevice" - sets playback target
 *
 * @param {string} sourceDevice - Capture device to listen FROM (e.g., "Stereo Mix")
 * @param {string} targetDevice - Render device to listen ON (e.g., "Speakers")
 */
async function enableListening(sourceDevice, targetDevice) {
  try {
    // Step 1: Enable "Listen to this device" on the source
    await runSvcl(`/SetListenToThisDevice "${sourceDevice}" 1`);
    console.log(`[AudioRouting] Enabled listening on: ${sourceDevice}`);

    // Step 2: Set the playback target device
    await runSvcl(`/SetPlaybackThroughDevice "${sourceDevice}" "${targetDevice}"`);
    console.log(`[AudioRouting] Set playback target: ${sourceDevice} → ${targetDevice}`);

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
    // Disable listening (0 = off)
    await runSvcl(`/SetListenToThisDevice "${sourceDevice}" 0`);
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
  ensureAvailable,
  downloadSvcl,
  getDevices,
  enableListening,
  disableListening,
  findVirtualDevice,
  findRealSpeakers,
  enablePCSpeakersMode,
  disablePCSpeakersMode
};
