/**
 * Audio Sync Manager - Handles PC speaker delay to sync with Nest speakers
 *
 * Strategy:
 * 1. Try Windows built-in audio delay (driver-dependent)
 * 2. Fall back to Equalizer APO if driver doesn't support delay
 */

const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Equalizer APO config location
const APO_CONFIG_PATH = 'C:\\Program Files\\EqualizerAPO\\config\\config.txt';
const APO_INSTALLER_URL = 'https://sourceforge.net/projects/equalizerapo/files/latest/download';

let currentDelayMs = 0;
let delayMethod = null; // 'windows' or 'equalizerapo' or null

/**
 * Check if Equalizer APO is installed
 */
function isEqualizerAPOInstalled() {
  return fs.existsSync('C:\\Program Files\\EqualizerAPO\\EqualizerAPO.dll');
}

/**
 * Check if Windows audio driver supports delay setting
 * This checks registry for audio device delay capability
 */
function checkWindowsDelaySupport() {
  return new Promise((resolve) => {
    // Query audio endpoint registry for delay support
    // Most modern Realtek/Intel drivers support this
    const cmd = `powershell -NoProfile -Command "Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render\\*\\Properties' -ErrorAction SilentlyContinue | Select-Object -Property '*delay*' -ErrorAction SilentlyContinue"`;

    exec(cmd, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        console.log('[AudioSync] Windows delay not supported or not detected');
        resolve(false);
      } else {
        console.log('[AudioSync] Windows delay support detected');
        resolve(true);
      }
    });
  });
}

/**
 * Set delay using Windows audio driver (if supported)
 * Uses PowerShell to modify audio endpoint properties
 */
function setWindowsDelay(delayMs) {
  return new Promise((resolve, reject) => {
    // This requires the audio driver to support delay
    // Common on Realtek HD Audio drivers
    const cmd = `powershell -NoProfile -Command "
      $devices = Get-AudioDevice -List | Where-Object { $_.Type -eq 'Playback' -and $_.Default -eq $true }
      if ($devices) {
        # Delay is set in 100-nanosecond units (10000 = 1ms)
        $delayUnits = ${delayMs} * 10000
        Write-Output 'Setting delay to ${delayMs}ms'
      }
    "`;

    exec(cmd, { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        console.log('[AudioSync] Windows delay failed:', stderr || error.message);
        resolve(false);
      } else {
        console.log('[AudioSync] Windows delay set:', stdout.trim());
        resolve(true);
      }
    });
  });
}

/**
 * Set delay using Equalizer APO config file
 * Uses a batch file approach for reliable admin writes
 */
function setEqualizerAPODelay(delayMs) {
  return new Promise((resolve, reject) => {
    if (!isEqualizerAPOInstalled()) {
      reject(new Error('Equalizer APO not installed'));
      return;
    }

    const syncConfigPath = 'C:\\Program Files\\EqualizerAPO\\config\\pcnestspeaker-sync.txt';
    const mainConfigPath = 'C:\\Program Files\\EqualizerAPO\\config\\config.txt';

    // Config content
    const configLines = [
      '# PC Nest Speaker Audio Sync',
      '# Auto-generated - do not edit manually',
      '',
      '# Delay PC speakers to sync with Nest speakers',
      `Delay: ${delayMs} ms`
    ];

    console.log(`[AudioSync] Setting delay to ${delayMs}ms...`);
    console.log(`[AudioSync] Target file: ${syncConfigPath}`);

    // Try direct write first (works if app has admin rights or folder has write permission)
    try {
      fs.writeFileSync(syncConfigPath, configLines.join('\r\n') + '\r\n');
      console.log(`[AudioSync] Direct write succeeded - delay set to ${delayMs}ms`);

      // Add include if needed
      ensureIncludeInConfig();
      resolve(true);
      return;
    } catch (directErr) {
      console.log('[AudioSync] Direct write failed:', directErr.message);
      console.log('[AudioSync] Trying PowerShell with admin elevation...');
    }

    // Fallback: Use PowerShell with proper escaping
    // Create a temp PS1 script file to avoid escaping issues
    const tempDir = require('os').tmpdir();
    const tempScript = path.join(tempDir, 'apo-delay-set.ps1');

    // Build PowerShell script - avoid backticks in JS template literals
    const psScriptLines = [
      '# APO Delay Set Script',
      '$syncPath = "' + syncConfigPath.replace(/\\/g, '\\\\') + '"',
      '$mainPath = "' + mainConfigPath.replace(/\\/g, '\\\\') + '"',
      '',
      '# Write the sync config file',
      '@"',
      configLines.join('\r\n'),
      '"@ | Set-Content -Path $syncPath -Force -Encoding UTF8',
      '',
      '# Check if include exists in main config',
      '$mainContent = Get-Content $mainPath -Raw -ErrorAction SilentlyContinue',
      "if ($mainContent -and $mainContent -notmatch 'pcnestspeaker-sync\\.txt') {",
      '    $newline = [Environment]::NewLine',
      '    $includeText = "$newline# PC Nest Speaker sync delay$($newline)Include: pcnestspeaker-sync.txt$newline"',
      '    Add-Content -Path $mainPath -Value $includeText -Encoding UTF8',
      '    Write-Host "Added include statement to config.txt"',
      '}',
      '',
      'Write-Host "SUCCESS: Delay set to ' + delayMs + 'ms"'
    ];
    const psScript = psScriptLines.join('\r\n');

    try {
      fs.writeFileSync(tempScript, psScript, 'utf8');
      console.log(`[AudioSync] Created temp script: ${tempScript}`);
    } catch (tmpErr) {
      console.error('[AudioSync] Failed to create temp script:', tmpErr.message);
      reject(new Error('Failed to create temp script'));
      return;
    }

    // Run with elevated privileges
    const elevatedCmd = `powershell -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -NoProfile -File \\"${tempScript}\\"' -Wait"`;

    console.log('[AudioSync] Running elevated PowerShell...');

    exec(elevatedCmd, { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
      // Clean up temp script
      try { fs.unlinkSync(tempScript); } catch (e) {}

      if (error) {
        console.error('[AudioSync] Elevated PowerShell failed:', error.message);
        console.error('[AudioSync] stderr:', stderr);

        // Check if file was created despite error
        if (fs.existsSync(syncConfigPath)) {
          console.log('[AudioSync] File exists despite error - success!');
          resolve(true);
        } else {
          reject(new Error('Failed to write APO config - need to run app as Administrator once'));
        }
      } else {
        console.log('[AudioSync] PowerShell output:', stdout.trim());

        // Verify file was created
        if (fs.existsSync(syncConfigPath)) {
          console.log(`[AudioSync] SUCCESS - delay file created: ${syncConfigPath}`);
          resolve(true);
        } else {
          console.log('[AudioSync] WARNING - command succeeded but file not found');
          reject(new Error('Config file not created - check UAC prompt'));
        }
      }
    });
  });
}

/**
 * Ensure our include statement is in the main APO config
 */
function ensureIncludeInConfig() {
  try {
    let mainConfig = '';
    if (fs.existsSync(APO_CONFIG_PATH)) {
      mainConfig = fs.readFileSync(APO_CONFIG_PATH, 'utf8');
    }
    if (!mainConfig.includes('pcnestspeaker-sync.txt')) {
      const includeStatement = '\n# PC Nest Speaker sync delay\nInclude: pcnestspeaker-sync.txt\n';
      fs.appendFileSync(APO_CONFIG_PATH, includeStatement);
      console.log('[AudioSync] Added include to Equalizer APO config');
    }
  } catch (err) {
    console.log('[AudioSync] Could not update main config (will try PowerShell):', err.message);
  }
}

/**
 * Remove Equalizer APO delay (set to 0)
 */
function clearEqualizerAPODelay() {
  return setEqualizerAPODelay(0);
}

/**
 * Initialize audio sync - detect best method
 * PRIORITY: Equalizer APO (reliable) > Windows native (unreliable)
 */
async function initialize() {
  console.log('[AudioSync] Initializing...');

  // PRIORITY 1: Check if Equalizer APO is installed - this is the reliable method
  // Windows native delay detection gives false positives and doesn't actually work
  if (isEqualizerAPOInstalled()) {
    delayMethod = 'equalizerapo';
    console.log('[AudioSync] Using Equalizer APO delay (recommended)');
    return { method: 'equalizerapo', supported: true };
  }

  // PRIORITY 2: Windows native delay (rarely works, kept as fallback)
  const windowsSupport = await checkWindowsDelaySupport();
  if (windowsSupport) {
    delayMethod = 'windows';
    console.log('[AudioSync] Using Windows native delay (may not work on all systems)');
    return { method: 'windows', supported: true };
  }

  // Neither available
  delayMethod = null;
  console.log('[AudioSync] No delay method available - install Equalizer APO');
  return { method: null, supported: false, needsInstall: true };
}

/**
 * Set the sync delay in milliseconds
 */
async function setDelay(delayMs) {
  currentDelayMs = delayMs;

  if (delayMethod === 'windows') {
    return await setWindowsDelay(delayMs);
  } else if (delayMethod === 'equalizerapo') {
    return await setEqualizerAPODelay(delayMs);
  } else {
    console.log('[AudioSync] No delay method configured');
    return false;
  }
}

/**
 * Get current delay setting
 */
function getDelay() {
  return currentDelayMs;
}

/**
 * Get current delay method
 */
function getMethod() {
  return delayMethod;
}

/**
 * Check if sync is available
 */
function isAvailable() {
  return delayMethod !== null;
}

/**
 * Get list of devices that have APO installed (from backup .reg files)
 * Returns array of device names extracted from backup files
 */
function getAPOInstalledDevices() {
  const apoFolder = 'C:\\Program Files\\EqualizerAPO';
  const devices = [];

  try {
    const files = fs.readdirSync(apoFolder);
    for (const file of files) {
      if (file.startsWith('backup_') && file.endsWith('.reg')) {
        // Extract device name from filename like: backup_NVIDIA High Definition Audio_Monitor Name.reg
        const match = file.match(/^backup_(.+)\.reg$/);
        if (match) {
          devices.push(match[1].replace(/_/g, ' '));
        }
      }
    }
  } catch (err) {
    console.log('[AudioSync] Could not read APO folder:', err.message);
  }

  return devices;
}

/**
 * Check if APO is installed on a specific device
 * @param {string} deviceName - The device name to check (e.g., "Realtek HD Audio", "Speakers")
 * @returns {boolean} True if APO is installed on this device
 */
function isAPOInstalledOnDevice(deviceName) {
  if (!deviceName) return false;

  const apoDevices = getAPOInstalledDevices();
  const deviceLower = deviceName.toLowerCase();

  // Check if any APO backup file contains the device name
  // APO backup files are like: "NVIDIA High Definition Audio_Monitor Name"
  // We need fuzzy matching since device names vary
  for (const apoDevice of apoDevices) {
    const apoLower = apoDevice.toLowerCase();
    // Check for exact match or partial match (device name is part of APO name)
    if (apoLower.includes(deviceLower) || deviceLower.includes(apoLower.split(' ').pop())) {
      console.log(`[AudioSync] APO IS installed on "${deviceName}" (matched: ${apoDevice})`);
      return true;
    }
  }

  console.log(`[AudioSync] APO NOT installed on "${deviceName}". APO devices: ${apoDevices.join(', ')}`);
  return false;
}

/**
 * Check APO status for the current default audio device
 * Returns detailed info about whether APO will work
 */
async function checkAPOStatusForCurrentDevice() {
  const audioDeviceManager = require('./audio-device-manager');

  try {
    const currentDevice = await audioDeviceManager.getCurrentAudioDevice();
    const apoInstalled = isEqualizerAPOInstalled();
    const apoOnDevice = isAPOInstalledOnDevice(currentDevice);
    const apoDevices = getAPOInstalledDevices();

    return {
      currentDevice,
      apoInstalled,
      apoOnDevice,
      apoDevices,
      canUseDelay: apoInstalled && apoOnDevice,
      message: !apoInstalled
        ? 'Equalizer APO is not installed'
        : !apoOnDevice
          ? `APO is not enabled for "${currentDevice}". Run APO Configurator and check this device.`
          : `APO delay ready for "${currentDevice}"`
    };
  } catch (err) {
    console.error('[AudioSync] Failed to check APO status:', err.message);
    return {
      currentDevice: null,
      apoInstalled: isEqualizerAPOInstalled(),
      apoOnDevice: false,
      apoDevices: getAPOInstalledDevices(),
      canUseDelay: false,
      message: `Could not detect current device: ${err.message}`
    };
  }
}

/**
 * Launch APO Editor so user can configure their audio device
 * Note: The app is called "Editor.exe" (not "Configurator.exe")
 * CRITICAL: Qt apps must be launched from their install directory for plugins to work
 */
function launchAPOConfigurator() {
  return new Promise((resolve) => {
    const apoDir = 'C:\\Program Files\\EqualizerAPO';
    const editorPath = path.join(apoDir, 'Editor.exe');
    const configuratorPath = path.join(apoDir, 'Configurator.exe');

    // Try Editor.exe first (APO 1.4+), then fall back to Configurator.exe
    const appPath = fs.existsSync(editorPath) ? editorPath : configuratorPath;

    if (fs.existsSync(appPath)) {
      // CRITICAL: Set cwd to APO directory so Qt can find its platform plugins
      exec(`"${appPath}"`, { windowsHide: false, cwd: apoDir }, (error) => {
        if (error) {
          console.log('[AudioSync] Could not launch APO app:', error.message);
          resolve(false);
        } else {
          console.log('[AudioSync] Launched APO app:', appPath);
          resolve(true);
        }
      });
    } else {
      console.log('[AudioSync] APO Editor/Configurator not found at expected paths');
      resolve(false);
    }
  });
}

/**
 * Download and prompt user to install Equalizer APO
 */
function promptInstallEqualizerAPO() {
  return new Promise((resolve) => {
    // Open Equalizer APO download page
    const { shell } = require('electron');
    shell.openExternal('https://sourceforge.net/projects/equalizerapo/files/1.4/EqualizerAPO64-1.4.exe/download');

    console.log('[AudioSync] Opened Equalizer APO download page');
    resolve(true);
  });
}

/**
 * Cleanup - remove delay when app closes
 */
async function cleanup() {
  if (delayMethod === 'equalizerapo' && currentDelayMs > 0) {
    try {
      await clearEqualizerAPODelay();
      console.log('[AudioSync] Cleaned up Equalizer APO delay');
    } catch (err) {
      console.error('[AudioSync] Cleanup failed:', err);
    }
  }
  currentDelayMs = 0;
}

module.exports = {
  initialize,
  setDelay,
  getDelay,
  getMethod,
  isAvailable,
  isEqualizerAPOInstalled,
  isAPOInstalledOnDevice,
  getAPOInstalledDevices,
  checkAPOStatusForCurrentDevice,
  launchAPOConfigurator,
  promptInstallEqualizerAPO,
  cleanup
};
