/**
 * PC Speaker Delay - Handles HDMI/speaker delay via Equalizer APO
 *
 * IMPORTANT: This module is COMPLETELY SEPARATE from streaming code!
 * It ONLY writes APO config files. It does NOT touch FFmpeg, MediaMTX, or Cast.
 *
 * The delay is applied to the Windows audio OUTPUT (HDMI speakers).
 * The Nest/Cast stream is captured BEFORE this delay is applied.
 */

const fs = require('fs');
const path = require('path');

// APO paths
const APO_INSTALL_PATH = 'C:\\Program Files\\EqualizerAPO';
const APO_CONFIG_PATH = path.join(APO_INSTALL_PATH, 'config', 'config.txt');
const SYNC_CONFIG_PATH = path.join(APO_INSTALL_PATH, 'config', 'pcnestspeaker-sync.txt');

/**
 * Check if Equalizer APO is installed
 */
function isInstalled() {
  return fs.existsSync(path.join(APO_INSTALL_PATH, 'EqualizerAPO.dll'));
}

/**
 * Get current delay from config file (if exists)
 */
function getCurrentDelay() {
  try {
    if (!fs.existsSync(SYNC_CONFIG_PATH)) {
      return 0;
    }
    const content = fs.readFileSync(SYNC_CONFIG_PATH, 'utf8');
    const match = content.match(/Delay:\s*(\d+)\s*ms/);
    return match ? parseInt(match[1], 10) : 0;
  } catch (err) {
    console.log('[PCSpeakerDelay] Could not read current delay:', err.message);
    return 0;
  }
}

/**
 * Set PC speaker delay in milliseconds
 *
 * This writes to the APO config file. APO will pick up the change
 * and apply the delay to the audio OUTPUT (HDMI/speakers).
 *
 * @param {number} delayMs - Delay in milliseconds (0-2000)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function setDelay(delayMs) {
  if (!isInstalled()) {
    return { success: false, error: 'Equalizer APO not installed' };
  }

  // Validate delay range
  const delay = Math.max(0, Math.min(2000, parseInt(delayMs, 10) || 0));

  // Build config content
  const configContent = [
    '# PC Nest Speaker Audio Sync',
    '# Auto-generated - do not edit manually',
    '',
    '# Delay PC speakers to sync with Nest speakers',
    `Delay: ${delay} ms`,
    ''
  ].join('\r\n');

  try {
    // Write the sync config file
    fs.writeFileSync(SYNC_CONFIG_PATH, configContent, 'utf8');
    console.log(`[PCSpeakerDelay] Delay set to ${delay}ms`);

    // Ensure our config is included in main APO config
    ensureIncluded();

    return { success: true, delayMs: delay };
  } catch (err) {
    console.error('[PCSpeakerDelay] Failed to write config:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Ensure our sync config is included in the main APO config
 */
function ensureIncluded() {
  try {
    if (!fs.existsSync(APO_CONFIG_PATH)) {
      return;
    }

    const content = fs.readFileSync(APO_CONFIG_PATH, 'utf8');

    if (!content.includes('pcnestspeaker-sync.txt')) {
      const includeStatement = '\n# PC Nest Speaker sync delay\nInclude: pcnestspeaker-sync.txt\n';
      fs.appendFileSync(APO_CONFIG_PATH, includeStatement, 'utf8');
      console.log('[PCSpeakerDelay] Added include to APO config');
    }
  } catch (err) {
    console.log('[PCSpeakerDelay] Could not update main config:', err.message);
  }
}

/**
 * Clear the delay (set to 0)
 */
async function clearDelay() {
  return setDelay(0);
}

/**
 * Get list of devices that have APO installed (from backup .reg files)
 */
function getInstalledDevices() {
  const devices = [];

  try {
    const files = fs.readdirSync(APO_INSTALL_PATH);
    for (const file of files) {
      if (file.startsWith('backup_') && file.endsWith('.reg')) {
        // Extract device name from filename like: backup_DeviceName_Output.reg
        const match = file.match(/^backup_(.+)\.reg$/);
        if (match) {
          devices.push(match[1].replace(/_/g, ' '));
        }
      }
    }
  } catch (err) {
    // Ignore - APO folder might not exist
  }

  return devices;
}

/**
 * Open APO Configurator for user to select devices
 */
function openConfigurator() {
  const { exec } = require('child_process');
  const configuratorPath = path.join(APO_INSTALL_PATH, 'Configurator.exe');

  if (fs.existsSync(configuratorPath)) {
    exec(`"${configuratorPath}"`, { windowsHide: false });
    return true;
  }
  return false;
}

module.exports = {
  isInstalled,
  getCurrentDelay,
  setDelay,
  clearDelay,
  getInstalledDevices,
  openConfigurator
};
