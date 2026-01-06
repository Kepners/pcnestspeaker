/**
 * Auto-Start Manager - Windows Startup Configuration
 *
 * Handles adding/removing PC Nest Speaker from Windows startup
 * Uses Windows Registry to register the app to start on boot
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const AUTO_START_KEY_NAME = 'PCNestSpeaker';
const REGISTRY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/**
 * Check if auto-start is enabled
 */
function isAutoStartEnabled() {
  return new Promise((resolve) => {
    const cmd = `reg query "${REGISTRY_PATH}" /v ${AUTO_START_KEY_NAME}`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        // Key doesn't exist - auto-start is disabled
        resolve(false);
        return;
      }

      // Check if the registered path matches current executable
      const exePath = process.execPath;
      const registered = stdout.includes(exePath);
      resolve(registered);
    });
  });
}

/**
 * Enable auto-start on Windows boot
 */
function enableAutoStart() {
  return new Promise((resolve, reject) => {
    // Get path to executable
    // In dev mode, this will be electron.exe
    // In production, this will be "PC Nest Speaker.exe"
    const exePath = process.execPath;
    const appPath = app.isPackaged
      ? `"${exePath}"`
      : `"${exePath}" "${path.join(__dirname, '../..')}"`;

    const cmd = `reg add "${REGISTRY_PATH}" /v ${AUTO_START_KEY_NAME} /t REG_SZ /d ${appPath} /f`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('[AutoStart] Failed to enable:', error);
        reject(error);
        return;
      }

      console.log('[AutoStart] Enabled successfully');
      resolve(true);
    });
  });
}

/**
 * Disable auto-start on Windows boot
 */
function disableAutoStart() {
  return new Promise((resolve, reject) => {
    const cmd = `reg delete "${REGISTRY_PATH}" /v ${AUTO_START_KEY_NAME} /f`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        // Key might not exist - that's okay
        console.log('[AutoStart] Already disabled or key not found');
        resolve(false);
        return;
      }

      console.log('[AutoStart] Disabled successfully');
      resolve(true);
    });
  });
}

/**
 * Toggle auto-start
 */
async function toggleAutoStart() {
  const enabled = await isAutoStartEnabled();

  if (enabled) {
    await disableAutoStart();
    return false;
  } else {
    await enableAutoStart();
    return true;
  }
}

module.exports = {
  isAutoStartEnabled,
  enableAutoStart,
  disableAutoStart,
  toggleAutoStart
};
