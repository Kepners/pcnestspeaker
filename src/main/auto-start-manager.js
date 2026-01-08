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

    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
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
    // In production, this will be "PC Nest Speaker.exe"
    // In dev mode, use the start-app.bat which handles ELECTRON_RUN_AS_NODE properly
    const exePath = process.execPath;
    const projectPath = path.join(__dirname, '../..');

    let appPath;
    if (app.isPackaged) {
      // Production: just the exe
      appPath = `"${exePath}"`;
    } else {
      // Dev mode: use the batch file which properly launches electron with the project
      const batPath = path.join(projectPath, 'start-app.bat');
      appPath = `"${batPath}"`;
    }

    const cmd = `reg add "${REGISTRY_PATH}" /v ${AUTO_START_KEY_NAME} /t REG_SZ /d ${appPath} /f`;

    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
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

    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
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

/**
 * Get the correct auto-start path for current environment
 */
function getCorrectAutoStartPath() {
  const projectPath = path.join(__dirname, '../..');

  if (app.isPackaged) {
    return `"${process.execPath}"`;
  } else {
    const batPath = path.join(projectPath, 'start-app.bat');
    return `"${batPath}"`;
  }
}

/**
 * Verify auto-start registry entry is correct and fix if needed
 * Call this on app startup to auto-fix outdated entries
 */
function verifyAndFixAutoStart() {
  return new Promise((resolve) => {
    const cmd = `reg query "${REGISTRY_PATH}" /v ${AUTO_START_KEY_NAME}`;

    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // Auto-start not enabled, nothing to fix
        console.log('[AutoStart] Not enabled, nothing to verify');
        resolve(false);
        return;
      }

      // Auto-start is enabled - check if path is correct
      const correctPath = getCorrectAutoStartPath();

      if (stdout.includes(correctPath.replace(/"/g, ''))) {
        console.log('[AutoStart] Registry entry is correct');
        resolve(true);
        return;
      }

      // Path is wrong - fix it automatically
      console.log('[AutoStart] Registry entry outdated, updating...');
      console.log('[AutoStart] Correct path:', correctPath);

      enableAutoStart()
        .then(() => {
          console.log('[AutoStart] Registry entry fixed automatically');
          resolve(true);
        })
        .catch((err) => {
          console.error('[AutoStart] Failed to fix registry entry:', err);
          resolve(false);
        });
    });
  });
}

module.exports = {
  isAutoStartEnabled,
  enableAutoStart,
  disableAutoStart,
  toggleAutoStart,
  verifyAndFixAutoStart
};
