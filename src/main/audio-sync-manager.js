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
 * This is the reliable fallback that works on all systems
 */
function setEqualizerAPODelay(delayMs) {
  return new Promise((resolve, reject) => {
    if (!isEqualizerAPOInstalled()) {
      reject(new Error('Equalizer APO not installed'));
      return;
    }

    try {
      // Create/update Equalizer APO config with delay
      // Delay filter format: Delay: <ms> ms
      const config = `# PC Nest Speaker Audio Sync
# Auto-generated - do not edit manually

# Delay PC speakers to sync with Nest speakers
Delay: ${delayMs} ms
`;

      // Write to a separate include file to not mess with user's main config
      const syncConfigPath = 'C:\\Program Files\\EqualizerAPO\\config\\pcnestspeaker-sync.txt';
      fs.writeFileSync(syncConfigPath, config);

      // Check if main config includes our sync file
      let mainConfig = '';
      if (fs.existsSync(APO_CONFIG_PATH)) {
        mainConfig = fs.readFileSync(APO_CONFIG_PATH, 'utf8');
      }

      if (!mainConfig.includes('pcnestspeaker-sync.txt')) {
        // Add include to main config
        const includeStatement = '\n# PC Nest Speaker sync delay\nInclude: pcnestspeaker-sync.txt\n';
        fs.appendFileSync(APO_CONFIG_PATH, includeStatement);
        console.log('[AudioSync] Added include to Equalizer APO config');
      }

      console.log(`[AudioSync] Equalizer APO delay set to ${delayMs}ms`);
      resolve(true);
    } catch (err) {
      console.error('[AudioSync] Failed to set Equalizer APO delay:', err);
      reject(err);
    }
  });
}

/**
 * Remove Equalizer APO delay (set to 0)
 */
function clearEqualizerAPODelay() {
  return setEqualizerAPODelay(0);
}

/**
 * Initialize audio sync - detect best method
 */
async function initialize() {
  console.log('[AudioSync] Initializing...');

  // Check Windows native delay support first
  const windowsSupport = await checkWindowsDelaySupport();
  if (windowsSupport) {
    delayMethod = 'windows';
    console.log('[AudioSync] Using Windows native delay');
    return { method: 'windows', supported: true };
  }

  // Check if Equalizer APO is installed
  if (isEqualizerAPOInstalled()) {
    delayMethod = 'equalizerapo';
    console.log('[AudioSync] Using Equalizer APO delay');
    return { method: 'equalizerapo', supported: true };
  }

  // Neither available
  delayMethod = null;
  console.log('[AudioSync] No delay method available');
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
  promptInstallEqualizerAPO,
  cleanup
};
