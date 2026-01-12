/**
 * Audio Routing Module - Manages Windows audio device switching for PC + Speakers mode
 *
 * PC + Speakers mode works by:
 * 1. Keep Windows default on VB-Cable Input (PRE-APO capture for Cast)
 * 2. Enable "Listen to this device" on VB-Cable Output → PC speakers
 * 3. APO delay is applied ONLY on PC speakers output pipeline
 * 4. Cast gets PRE-APO audio, PC speakers get POST-APO delayed audio
 *
 * WHY VB-CABLE (not Virtual Desktop Audio):
 * - VDA's CAPTURE device is only visible to DirectShow apps (FFmpeg), NOT Windows
 * - VB-Cable's "CABLE Output" IS visible to Windows WASAPI
 * - "Listen to this device" requires a Windows-visible CAPTURE device
 * - VB-Cable provides both RENDER (CABLE Input) and CAPTURE (CABLE Output)
 *
 * Uses:
 * - NirSoft SoundVolumeCommandLine (svcl.exe) for device switching
 * - WindowsAudioControl-CLI (audioctl.exe) for "Listen to this device" control
 */

const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const settingsManager = require('./settings-manager');

// Path helpers for production vs development
// In dev: tools in project root (e.g., soundvolumeview/)
// In production: tools in resources folder (e.g., resources/soundvolumeview/)
function getSoundVolumeViewPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'soundvolumeview', 'SoundVolumeView.exe')
    : path.join(__dirname, '..', '..', 'soundvolumeview', 'SoundVolumeView.exe');
}

function getAudioctlPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'audioctl', 'audioctl.exe')
    : path.join(__dirname, '..', '..', 'audioctl', 'audioctl.exe');
}

// Legacy constants for compatibility (use functions above for production builds)
const SVV_DIR = path.join(__dirname, '..', '..', 'soundvolumeview');
const SVV_PATH = path.join(SVV_DIR, 'SoundVolumeView.exe');
const AUDIOCTL_DIR = path.join(__dirname, '..', '..', 'audioctl');
const AUDIOCTL_PATH = path.join(AUDIOCTL_DIR, 'audioctl.exe');

// Store original default device for restoration
let originalDefaultDevice = null;
// Cache the command-line ID for sync restore on exit
let originalDefaultDeviceCmdId = null;

/**
 * Save the current default audio device (call BEFORE switching to VB-Cable)
 * This should be called once when app takes over audio
 * Also caches the cmdId for synchronous restore on app exit
 */
async function saveOriginalDevice() {
  if (originalDefaultDevice) {
    console.log(`[AudioRouting] Original device already saved: ${originalDefaultDevice}`);
    return originalDefaultDevice;
  }

  // Get full device info including cmdId for sync restore
  const devices = await getDevices();
  const defaultDevice = devices.find(d => d.direction === 'Render' && d.isDefault);

  if (defaultDevice) {
    // CRITICAL: Don't save VB-Cable as "original" - that's what WE use!
    // If VB-Cable is current default, it means previous run didn't clean up properly
    const nameLower = defaultDevice.name.toLowerCase();
    const deviceNameLower = (defaultDevice.deviceName || '').toLowerCase();
    if (nameLower.includes('vb-audio') || nameLower.includes('cable') ||
        deviceNameLower.includes('vb-audio') || deviceNameLower.includes('cable')) {
      console.log(`[AudioRouting] Current default is VB-Cable (${defaultDevice.name}) - looking for real speakers...`);

      // Find the first non-VB-Cable render device to use as "original"
      const realSpeaker = devices.find(d => {
        if (d.direction !== 'Render') return false;
        const n = d.name.toLowerCase();
        const dn = (d.deviceName || '').toLowerCase();
        return !n.includes('vb-audio') && !n.includes('cable') &&
               !dn.includes('vb-audio') && !dn.includes('cable');
      });

      if (realSpeaker) {
        originalDefaultDevice = realSpeaker.name;
        originalDefaultDeviceCmdId = realSpeaker.cmdId;
        console.log(`[AudioRouting] Found real speakers to restore to: ${originalDefaultDevice}`);
        console.log(`[AudioRouting] Cached cmdId: ${originalDefaultDeviceCmdId}`);
        return originalDefaultDevice;
      } else {
        console.log(`[AudioRouting] WARNING: No real speakers found! Cannot save original device.`);
        return null;
      }
    }

    originalDefaultDevice = defaultDevice.name;
    originalDefaultDeviceCmdId = defaultDevice.cmdId;
    console.log(`[AudioRouting] Saved original default device: ${originalDefaultDevice}`);
    console.log(`[AudioRouting] Cached cmdId for sync restore: ${originalDefaultDeviceCmdId}`);
  }
  return originalDefaultDevice;
}

/**
 * Restore the original default audio device (call when app exits or stops streaming)
 * Returns the user to their normal audio setup
 */
async function restoreOriginalDevice() {
  if (!originalDefaultDevice) {
    console.log('[AudioRouting] No original device saved to restore');
    return { success: false, error: 'No original device saved' };
  }

  console.log(`[AudioRouting] Restoring original device: ${originalDefaultDevice}`);
  const result = await setDefaultDevice(originalDefaultDevice);

  if (result.success) {
    console.log(`[AudioRouting] Restored default device to: ${originalDefaultDevice}`);
    // Clear saved device after successful restore
    originalDefaultDevice = null;
    originalDefaultDeviceCmdId = null;
  }

  return result;
}

/**
 * SYNCHRONOUS version of restoreOriginalDevice - for use in app cleanup/exit
 * Uses cached cmdId to avoid async device lookup
 * This ensures audio is restored BEFORE the app process exits
 */
function restoreOriginalDeviceSync() {
  if (!originalDefaultDeviceCmdId) {
    console.log('[AudioRouting] No original device cmdId cached for sync restore');
    return { success: false, error: 'No original device cmdId cached' };
  }

  if (!isAvailable()) {
    console.log('[AudioRouting] SoundVolumeView not available for sync restore');
    return { success: false, error: 'SoundVolumeView not found' };
  }

  try {
    console.log(`[AudioRouting] SYNC restoring original device: ${originalDefaultDevice}`);
    console.log(`[AudioRouting] Using cached cmdId: ${originalDefaultDeviceCmdId}`);

    // Use execSync with SoundVolumeView - blocks until complete
    const svvPath = getSoundVolumeViewPath();
    const cmd = `powershell -Command "& '${svvPath}' /SetDefault '${originalDefaultDeviceCmdId}' all"`;
    execSync(cmd, { windowsHide: true, timeout: 5000, stdio: 'ignore' });

    console.log(`[AudioRouting] SYNC restored default device to: ${originalDefaultDevice}`);

    // Clear cached values
    const restoredDevice = originalDefaultDevice;
    originalDefaultDevice = null;
    originalDefaultDeviceCmdId = null;

    return { success: true, device: restoredDevice };
  } catch (error) {
    console.error(`[AudioRouting] SYNC restore failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get the saved original device (if any)
 */
function getOriginalDevice() {
  return originalDefaultDevice;
}

/**
 * Check if SoundVolumeView is available (bundled with app)
 */
function isAvailable() {
  return fs.existsSync(getSoundVolumeViewPath());
}

/**
 * Check if WindowsAudioControl-CLI (audioctl) is available
 */
function isAudioctlAvailable() {
  const audioctlPath = getAudioctlPath();
  const available = fs.existsSync(audioctlPath);
  if (!available) {
    console.log(`[AudioRouting] audioctl.exe not found at: ${audioctlPath}`);
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
    const audioctlPath = getAudioctlPath();
    const cmd = `"${audioctlPath}" ${args}`;
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
 * Run SoundVolumeView command via PowerShell (for proper escaping)
 */
async function runSVV(args) {
  if (!isAvailable()) {
    throw new Error('SoundVolumeView.exe not found. It should be bundled with the app.');
  }

  return new Promise((resolve, reject) => {
    // Use PowerShell for reliable execution with proper escaping
    const svvPath = getSoundVolumeViewPath();
    const cmd = `powershell -Command "& '${svvPath}' ${args}"`;
    console.log(`[AudioRouting] Running: ${cmd}`);

    exec(cmd, { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
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
 * Export SoundVolumeView device list to temp CSV and parse it
 */
async function getSVVDevices() {
  const os = require('os');
  const tmpPath = path.join(os.tmpdir(), 'svv_devices.csv');

  // Export device list
  await runSVV(`/scomma '${tmpPath}'`);

  // Wait a bit for file to be written
  await new Promise(resolve => setTimeout(resolve, 500));

  if (!fs.existsSync(tmpPath)) {
    throw new Error('Failed to export device list');
  }

  // Read and parse CSV (handle BOM with utf-8-sig equivalent)
  let content = fs.readFileSync(tmpPath, 'utf8');
  // Remove BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);
  const devices = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const device = {};
    headers.forEach((h, idx) => {
      device[h] = values[idx] || '';
    });
    devices.push(device);
  }

  // Clean up
  try { fs.unlinkSync(tmpPath); } catch (e) {}

  return devices;
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
 * Get list of audio devices using SoundVolumeView
 */
async function getDevices() {
  try {
    const svvDevices = await getSVVDevices();
    const devices = [];

    for (const d of svvDevices) {
      // Only include Device type (not Application, Subunit, etc.)
      if (d['Type'] !== 'Device') continue;

      devices.push({
        name: d['Name'] || '',
        type: d['Type'] || '',
        direction: d['Direction'] || '',
        deviceName: d['Device Name'] || '',
        cmdId: d['Command-Line Friendly ID'] || '',  // KEY: Used for /SetDefault
        isDefault: d['Default'] === 'Render'  // "Render" in Default column = default
      });
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
 * Set the default Windows audio output device using SoundVolumeView
 * @param {string} deviceName - Name of the device (e.g., "HDMI Output" or full device name)
 */
async function setDefaultDevice(deviceName) {
  try {
    // Get all devices to find the Command-Line Friendly ID
    const devices = await getDevices();
    const deviceNameLower = deviceName.toLowerCase();

    // Find matching Render device
    const target = devices.find(d =>
      d.direction === 'Render' &&
      (d.name.toLowerCase().includes(deviceNameLower) ||
       d.deviceName.toLowerCase().includes(deviceNameLower))
    );

    if (!target) {
      console.error(`[AudioRouting] Device not found: ${deviceName}`);
      return { success: false, error: `Device '${deviceName}' not found` };
    }

    if (!target.cmdId) {
      console.error(`[AudioRouting] Device has no Command-Line Friendly ID: ${deviceName}`);
      return { success: false, error: 'Device has no Command-Line Friendly ID' };
    }

    console.log(`[AudioRouting] Found device: ${target.name} (${target.deviceName})`);
    console.log(`[AudioRouting] Command-Line ID: ${target.cmdId}`);

    // Use SoundVolumeView with the Command-Line Friendly ID
    await runSVV(`/SetDefault '${target.cmdId}' all`);

    console.log(`[AudioRouting] Set default device to: ${target.name}`);
    return { success: true, device: target.name };
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
 *
 * SMART DETECTION: On first run, we capture the Windows default audio device
 * BEFORE we change anything. This is the device the user actually hears from.
 * We save it and use it forever - no guessing needed!
 */
async function findRealSpeakers() {
  // First, check if we saved the user's original default device on first run
  const settings = settingsManager.getAllSettings();
  if (settings.detectedRealSpeakers && settings.detectedRealSpeakers.length > 0) {
    const savedDevice = settings.detectedRealSpeakers[0];
    console.log(`[AudioRouting] Using saved PC speaker from first run: ${savedDevice}`);
    return savedDevice;
  }

  // Fallback: pattern-match if no saved device (shouldn't happen normally)
  console.log('[AudioRouting] No saved device, falling back to pattern detection...');
  const devices = await getRenderDevices();

  // Priority order for finding real speakers (universal patterns only)
  const priorityPatterns = [
    'HDMI',                    // HDMI audio output (monitors, TVs)
    'NVIDIA High Definition',  // NVIDIA GPU HDMI audio
    'AMD High Definition',     // AMD GPU HDMI audio
    'Intel Display Audio',     // Intel GPU audio
    'Realtek',                 // Onboard audio (most common)
    'High Definition Audio',   // Generic HD Audio
    'Speakers',                // Default speakers
    'Headphones',              // Headphones
    'Line Out',                // Line out jacks
    'DisplayPort'              // DisplayPort audio
  ];

  // Skip ONLY our internal routing devices - don't filter user's real hardware
  const skipPatterns = [
    'Virtual Desktop Audio',  // Our internal routing
    'CABLE',                  // VB-Cable internal routing
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
 * Enable "Listen to this device" using SoundVolumeView
 *
 * SoundVolumeView /SetListenToThisDevice is more reliable than audioctl.
 * Syntax: /SetListenToThisDevice "SourceDevice" 1 "TargetDevice"
 *
 * @param {string} sourceDevice - Device to listen FROM (e.g., "Virtual Desktop Audio")
 * @param {string} targetDevice - Device to play TO (e.g., "HDMI Output") - if null, uses default
 */
async function enableListenToDevice(sourceDevice, targetDevice = null) {
  console.log(`[AudioRouting] Enabling Listen: ${sourceDevice} → ${targetDevice || 'default output'}`);

  try {
    // Get all devices to find Command-Line Friendly IDs
    const devices = await getDevices();

    // Find source device (usually a Capture device like "Virtual Desktop Audio")
    // But for loopback, it might be the Render version
    const allSvvDevices = await getSVVDevices();
    const sourceDeviceLower = sourceDevice.toLowerCase();

    // Look for the source device (could be Capture or Render depending on setup)
    const source = allSvvDevices.find(d =>
      (d['Name'] || '').toLowerCase().includes(sourceDeviceLower) ||
      (d['Device Name'] || '').toLowerCase().includes(sourceDeviceLower)
    );

    if (!source || !source['Command-Line Friendly ID']) {
      // Fallback to audioctl if SoundVolumeView can't find it
      console.log('[AudioRouting] Source device not found in SVV, trying audioctl...');
      return await enableListenWithAudioctl(sourceDevice, targetDevice);
    }

    // Find target device
    let targetCmdId = '';
    if (targetDevice) {
      const targetDeviceLower = targetDevice.toLowerCase();
      const target = allSvvDevices.find(d =>
        d['Direction'] === 'Render' &&
        ((d['Name'] || '').toLowerCase().includes(targetDeviceLower) ||
         (d['Device Name'] || '').toLowerCase().includes(targetDeviceLower))
      );
      if (target && target['Command-Line Friendly ID']) {
        targetCmdId = target['Command-Line Friendly ID'];
      }
    }

    // Use SoundVolumeView: /SetListenToThisDevice "Source" 1 "Target"
    // 1 = enable, 0 = disable
    const sourceCmdId = source['Command-Line Friendly ID'];
    const cmd = targetCmdId
      ? `/SetListenToThisDevice '${sourceCmdId}' 1 '${targetCmdId}'`
      : `/SetListenToThisDevice '${sourceCmdId}' 1`;

    await runSVV(cmd);

    console.log(`[AudioRouting] Listen enabled successfully via SoundVolumeView`);
    return { success: true };
  } catch (err) {
    console.error(`[AudioRouting] SoundVolumeView Listen failed, trying audioctl:`, err.message);
    // Fallback to audioctl
    return await enableListenWithAudioctl(sourceDevice, targetDevice);
  }
}

/**
 * Enable "Listen to this device" using audioctl CLI tool (PRIMARY method)
 *
 * audioctl is more reliable than SoundVolumeView for Listen control
 * Returns JSON with confirmation: {"listenSet": {"enabled": true}}
 */
async function enableListenWithAudioctl(sourceDevice, targetDevice = null) {
  try {
    let args = `listen --name "${sourceDevice}" --enable`;
    if (targetDevice) {
      args += ` --playback-target-name "${targetDevice}"`;
    }
    const result = await runAudioctl(args);

    // audioctl returns: {"listenSet": {"id": "...", "name": "...", "enabled": true}}
    if (result && result.listenSet && result.listenSet.enabled === true) {
      console.log(`[AudioRouting] Listen enabled via audioctl - confirmed: ${result.listenSet.name}`);
      return { success: true, verified: true, device: result.listenSet.name };
    }

    // Got response but not the expected format
    console.log(`[AudioRouting] audioctl response:`, JSON.stringify(result));
    return { success: true, verified: false, result };
  } catch (err) {
    console.error(`[AudioRouting] audioctl failed:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Disable "Listen to this device" using audioctl CLI tool
 */
async function disableListenWithAudioctl(sourceDevice) {
  try {
    const args = `listen --name "${sourceDevice}" --disable`;
    const result = await runAudioctl(args);

    // audioctl returns: {"listenSet": {"id": "...", "name": "...", "enabled": false}}
    if (result && result.listenSet && result.listenSet.enabled === false) {
      console.log(`[AudioRouting] Listen disabled via audioctl - confirmed: ${result.listenSet.name}`);
      return { success: true, verified: true };
    }

    console.log(`[AudioRouting] audioctl response:`, JSON.stringify(result));
    return { success: true, verified: false, result };
  } catch (err) {
    console.error(`[AudioRouting] audioctl failed:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Enable "Listen to this device" using the Command-Line Friendly ID directly
 * This is more reliable as we already have the exact device ID
 *
 * @param {string} sourceCmdId - Command-Line Friendly ID of the CAPTURE device
 * @param {string} targetDeviceName - Name of the target RENDER device (e.g., "HDMI Output")
 */
async function enableListenToDeviceWithCmdId(sourceCmdId, targetDeviceName) {
  console.log(`[AudioRouting] Enabling Listen with CmdId: ${sourceCmdId} → ${targetDeviceName}`);

  try {
    // Find target device's Command-Line Friendly ID
    const allSvvDevices = await getSVVDevices();
    const targetDeviceLower = targetDeviceName.toLowerCase();

    const target = allSvvDevices.find(d =>
      d['Direction'] === 'Render' &&
      d['Type'] === 'Device' &&
      ((d['Name'] || '').toLowerCase().includes(targetDeviceLower) ||
       (d['Device Name'] || '').toLowerCase().includes(targetDeviceLower))
    );

    if (!target || !target['Command-Line Friendly ID']) {
      console.error(`[AudioRouting] Target device not found: ${targetDeviceName}`);
      // Try without target - will use default playback
      console.log('[AudioRouting] Trying to enable Listen without specific target...');
      await runSVV(`/SetListenToThisDevice '${sourceCmdId}' 1`);
      return { success: true, warning: 'Using default playback device' };
    }

    const targetCmdId = target['Command-Line Friendly ID'];
    console.log(`[AudioRouting] Target CmdId: ${targetCmdId}`);

    // SoundVolumeView: /SetListenToThisDevice "SourceCmdId" 1 "TargetCmdId"
    // 1 = enable, 0 = disable
    await runSVV(`/SetListenToThisDevice '${sourceCmdId}' 1 '${targetCmdId}'`);

    console.log(`[AudioRouting] Listen enabled: ${sourceCmdId} → ${targetCmdId}`);
    return { success: true };
  } catch (err) {
    console.error(`[AudioRouting] Failed to enable Listen with CmdId:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Disable "Listen to this device" using SoundVolumeView
 *
 * @param {string} sourceDevice - Device to stop listening from
 */
async function disableListenToDevice(sourceDevice) {
  console.log(`[AudioRouting] Disabling Listen on: ${sourceDevice}`);

  try {
    // Try SoundVolumeView first
    const allSvvDevices = await getSVVDevices();
    const sourceDeviceLower = sourceDevice.toLowerCase();

    const source = allSvvDevices.find(d =>
      (d['Name'] || '').toLowerCase().includes(sourceDeviceLower) ||
      (d['Device Name'] || '').toLowerCase().includes(sourceDeviceLower)
    );

    if (source && source['Command-Line Friendly ID']) {
      // Use SoundVolumeView: /SetListenToThisDevice "Source" 0
      // 0 = disable
      await runSVV(`/SetListenToThisDevice '${source['Command-Line Friendly ID']}' 0`);
      console.log(`[AudioRouting] Listen disabled via SoundVolumeView`);
      return { success: true };
    }

    // Fallback to audioctl
    console.log('[AudioRouting] Source device not found in SVV, trying audioctl...');
    const args = `listen --name "${sourceDevice}" --disable`;
    const result = await runAudioctl(args);
    console.log(`[AudioRouting] Listen disabled via audioctl`);
    return { success: true, result };
  } catch (err) {
    console.error(`[AudioRouting] Failed to disable Listen:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Enable PC Audio - just toggles "Listen to this device" on VB-Cable Output
 * Does NOT affect streaming - that runs independently via FFmpeg/MediaMTX
 *
 * Uses audioctl as PRIMARY method (more reliable than SoundVolumeView for Listen)
 * audioctl returns verified confirmation: {"listenSet": {"enabled": true}}
 *
 * @param {string} targetDevice - Optional specific PC speaker device name
 */
async function enablePCSpeakersMode(targetDevice = null) {
  console.log('[AudioRouting] enablePCSpeakersMode called');

  try {
    // Step 1: Find PC speakers (target for Listen)
    const pcSpeakers = targetDevice || await findRealSpeakers();
    if (!pcSpeakers) {
      return { success: false, error: 'No PC speakers found.' };
    }

    // Step 2: Enable "Listen to this device" using audioctl (PRIMARY - more reliable)
    // Use "CABLE Output" directly - this is the standard VB-Cable capture device name
    console.log(`[AudioRouting] Enabling Listen: CABLE Output → ${pcSpeakers}`);

    // Try audioctl FIRST (it returns verified confirmation)
    if (isAudioctlAvailable()) {
      console.log('[AudioRouting] Using audioctl for Listen control...');
      const result = await enableListenWithAudioctl('CABLE Output', pcSpeakers);

      if (result.success && result.verified) {
        console.log(`[AudioRouting] PC Audio ON - Listen enabled and VERIFIED via audioctl`);
        return { success: true, device: pcSpeakers, method: 'audioctl', verified: true };
      }

      if (result.success) {
        // Got success but not verified - still try
        console.log(`[AudioRouting] PC Audio ON - Listen enabled via audioctl (unverified)`);
        return { success: true, device: pcSpeakers, method: 'audioctl', verified: false };
      }

      console.log('[AudioRouting] audioctl failed, trying SoundVolumeView...');
    }

    // Fallback to SoundVolumeView if audioctl failed or unavailable
    const virtualCaptureDevice = await findVirtualCaptureDevice();
    if (!virtualCaptureDevice) {
      return { success: false, error: 'VB-Cable not found. Install from https://vb-audio.com/Cable/' };
    }

    console.log('[AudioRouting] Trying SoundVolumeView for Listen control...');
    const svvResult = await enableListenToDeviceWithCmdId(virtualCaptureDevice.cmdId, pcSpeakers);

    if (svvResult.success) {
      // SVV doesn't give verified confirmation - warn user
      console.log(`[AudioRouting] PC Audio ON - Listen enabled via SVV (cannot verify)`);
      return { success: true, device: pcSpeakers, method: 'svv', verified: false };
    }

    return svvResult;
  } catch (err) {
    console.error('[AudioRouting] enablePCSpeakersMode error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Find a virtual audio RENDER device for "Speakers Only" mode
 * Returns the UNIQUE deviceName (e.g., "VB-Audio Virtual Cable") not ambiguous name ("CABLE Input")
 *
 * WHY VB-CABLE: VB-Cable's CAPTURE device is visible to Windows WASAPI, which is required
 * for "Listen to this device" to work. Virtual Desktop Audio's capture is DirectShow-only.
 */
async function findVirtualDevice() {
  const devices = await getRenderDevices();

  // Virtual devices to look for - VB-Cable ONLY (not VoiceMeeter's CABLE 16, etc.)
  // VB-Cable provides:
  // - RENDER device: "CABLE Input" (where apps output to)
  // - CAPTURE device: "CABLE Output" (Windows-visible, for "Listen to this device")
  // IMPORTANT: Only match "VB-Audio Virtual Cable" to avoid VoiceMeeter confusion
  const virtualPatterns = [
    'VB-Audio Virtual Cable',    // VB-Cable device name (only specific match!)
    'Virtual Desktop Audio'      // Fallback to VDA if VB-Cable not installed
  ];

  for (const pattern of virtualPatterns) {
    // First pass: find VB-Audio devices that DON'T have "16" in the name (prefer standard)
    for (const device of devices) {
      const nameLower = device.name.toLowerCase();
      const deviceNameLower = device.deviceName.toLowerCase();
      const patternLower = pattern.toLowerCase();

      if ((nameLower.includes(patternLower) || deviceNameLower.includes(patternLower)) &&
          !nameLower.includes('16') && !deviceNameLower.includes('16')) {
        // CRITICAL: Return deviceName (unique) not name (ambiguous)
        console.log(`[AudioRouting] Found virtual RENDER device: ${device.deviceName} (display: ${device.name})`);
        return device.deviceName;
      }
    }

    // Second pass: fallback to any VB-Audio device including 16ch if no standard found
    for (const device of devices) {
      if (device.name.toLowerCase().includes(pattern.toLowerCase()) ||
          device.deviceName.toLowerCase().includes(pattern.toLowerCase())) {
        console.log(`[AudioRouting] Found virtual RENDER device (16ch fallback): ${device.deviceName} (display: ${device.name})`);
        return device.deviceName;
      }
    }
  }

  console.log('[AudioRouting] No virtual device found. Install VB-Cable from https://vb-audio.com/Cable/');
  return null;
}

/**
 * Find a virtual audio CAPTURE device for "Listen to this device"
 * "Listen to this device" is a CAPTURE device feature - it takes audio from a capture source
 * and plays it through a render device
 *
 * CRITICAL: VB-Cable's "CABLE Output" IS visible to Windows WASAPI!
 * Virtual Desktop Audio's capture is DirectShow-only and NOT visible to Windows.
 *
 * @param {string} matchRenderDevice - Optional: Match capture device to this render device name
 */
async function findVirtualCaptureDevice(matchRenderDevice = null) {
  const allSvvDevices = await getSVVDevices();

  // If we need to match a specific render device, look for its capture counterpart
  if (matchRenderDevice) {
    const matchLower = matchRenderDevice.toLowerCase();
    console.log(`[AudioRouting] Looking for CAPTURE device matching render: ${matchRenderDevice}`);

    for (const device of allSvvDevices) {
      if (device['Direction'] !== 'Capture') continue;
      if (device['Type'] !== 'Device') continue;

      const name = device['Name'] || '';
      const deviceName = device['Device Name'] || '';

      // For VB-Cable: render="VB-Audio Virtual Cable" -> capture="VB-Audio Virtual Cable"
      if (deviceName.toLowerCase().includes(matchLower) ||
          matchLower.includes(deviceName.toLowerCase())) {
        console.log(`[AudioRouting] Found matching CAPTURE device: ${deviceName} (display: ${name})`);
        console.log(`[AudioRouting]   Command-Line ID: ${device['Command-Line Friendly ID']}`);
        return {
          name: name,
          deviceName: deviceName,
          cmdId: device['Command-Line Friendly ID']
        };
      }
    }
    console.log(`[AudioRouting] No CAPTURE device found matching: ${matchRenderDevice}`);
  }

  // Virtual capture devices to look for - VB-Cable ONLY (not VoiceMeeter's CABLE 16, etc.)
  // VB-Cable's "CABLE Output" IS visible to Windows WASAPI (required for Listen)
  // Virtual Desktop Audio's capture is DirectShow-only and won't work
  // IMPORTANT: Only match "VB-Audio Virtual Cable" to avoid VoiceMeeter confusion
  const virtualPatterns = [
    'VB-Audio Virtual Cable',    // VB-Cable device name (only specific match!)
    'Virtual Desktop Audio'      // Fallback (won't work for Listen, but try anyway)
  ];

  for (const pattern of virtualPatterns) {
    // First pass: find VB-Audio devices that DON'T have "16" in the name (prefer standard)
    for (const device of allSvvDevices) {
      if (device['Direction'] !== 'Capture') continue;
      if (device['Type'] !== 'Device') continue;

      const name = device['Name'] || '';
      const deviceName = device['Device Name'] || '';
      const nameLower = name.toLowerCase();
      const deviceNameLower = deviceName.toLowerCase();
      const patternLower = pattern.toLowerCase();

      if ((nameLower.includes(patternLower) || deviceNameLower.includes(patternLower)) &&
          !nameLower.includes('16') && !deviceNameLower.includes('16')) {
        console.log(`[AudioRouting] Found virtual CAPTURE device: ${deviceName} (display: ${name})`);
        console.log(`[AudioRouting]   Command-Line ID: ${device['Command-Line Friendly ID']}`);
        return {
          name: name,
          deviceName: deviceName,
          cmdId: device['Command-Line Friendly ID']
        };
      }
    }

    // Second pass: fallback to any VB-Audio device including 16ch if no standard found
    for (const device of allSvvDevices) {
      if (device['Direction'] !== 'Capture') continue;
      if (device['Type'] !== 'Device') continue;

      const name = device['Name'] || '';
      const deviceName = device['Device Name'] || '';

      if (name.toLowerCase().includes(pattern.toLowerCase()) ||
          deviceName.toLowerCase().includes(pattern.toLowerCase())) {
        console.log(`[AudioRouting] Found virtual CAPTURE device (16ch fallback): ${deviceName} (display: ${name})`);
        console.log(`[AudioRouting]   Command-Line ID: ${device['Command-Line Friendly ID']}`);
        return {
          name: name,
          deviceName: deviceName,
          cmdId: device['Command-Line Friendly ID']
        };
      }
    }
  }

  console.log('[AudioRouting] No virtual CAPTURE device found. Install VB-Cable from https://vb-audio.com/Cable/');
  return null;
}

/**
 * Disable PC Audio - just disables "Listen to this device" on VB-Cable Output
 * Does NOT affect streaming - that runs independently via FFmpeg/MediaMTX
 *
 * Uses audioctl as PRIMARY method (returns verified confirmation)
 */
async function disablePCSpeakersMode() {
  console.log('[AudioRouting] disablePCSpeakersMode called');

  try {
    // Try audioctl FIRST with standard "CABLE Output" name
    if (isAudioctlAvailable()) {
      console.log('[AudioRouting] Disabling Listen via audioctl on: CABLE Output');
      const result = await disableListenWithAudioctl('CABLE Output');

      if (result.success && result.verified) {
        console.log(`[AudioRouting] PC Audio OFF - Listen disabled and VERIFIED via audioctl`);
        return { success: true, method: 'audioctl', verified: true };
      }

      if (result.success) {
        console.log(`[AudioRouting] PC Audio OFF - Listen disabled via audioctl (unverified)`);
        return { success: true, method: 'audioctl', verified: false };
      }

      console.log('[AudioRouting] audioctl failed, trying SoundVolumeView...');
    }

    // Fallback to SoundVolumeView
    const virtualCaptureDevice = await findVirtualCaptureDevice();
    if (virtualCaptureDevice && virtualCaptureDevice.cmdId) {
      console.log(`[AudioRouting] Disabling Listen via SVV on: ${virtualCaptureDevice.deviceName}`);
      await runSVV(`/SetListenToThisDevice '${virtualCaptureDevice.cmdId}' 0`);
      console.log(`[AudioRouting] PC Audio OFF - Listen disabled via SVV`);
      return { success: true, method: 'svv', verified: false };
    }

    console.log('[AudioRouting] VB-Cable not found');
    return { success: false, error: 'VB-Cable not found' };
  } catch (err) {
    console.error('[AudioRouting] disablePCSpeakersMode error:', err.message);
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
  saveOriginalDevice,
  restoreOriginalDevice,
  restoreOriginalDeviceSync,  // Sync version for app cleanup/exit
  getOriginalDevice,
  findRealSpeakers,
  findVirtualDevice,
  findVirtualCaptureDevice,
  enableListenToDevice,
  enableListenToDeviceWithCmdId,
  disableListenToDevice,
  enablePCSpeakersMode,
  disablePCSpeakersMode
};
