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

/**
 * Check if auto-start is enabled
 */
function isAutoStartEnabled() {
  return new Promise((resolve) => {
    const cmd = `powershell -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).${AUTO_START_KEY_NAME}"`;

    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      if (error || !stdout.trim()) {
        // Key doesn't exist - auto-start is disabled
        resolve(false);
        return;
      }

      // Auto-start is enabled if there's any value
      resolve(true);
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
    const projectPath = path.join(__dirname, '../..');

    let appPath;
    if (app.isPackaged) {
      // Production: just the exe (with quotes for paths with spaces)
      appPath = `"${process.execPath}"`;
    } else {
      // Dev mode: use the batch file which properly launches electron with the project
      appPath = path.join(projectPath, 'start-app.bat');
    }

    // Use PowerShell for reliable registry writes (handles paths with spaces properly)
    const escapedPath = appPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const cmd = `powershell -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${AUTO_START_KEY_NAME}' -Value '${escapedPath}'"`;

    console.log('[AutoStart] Setting registry:', appPath);

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
    const cmd = `powershell -Command "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${AUTO_START_KEY_NAME}' -ErrorAction SilentlyContinue"`;

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
    const cmd = `powershell -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).${AUTO_START_KEY_NAME}"`;

    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      const currentValue = stdout.trim();

      if (error || !currentValue) {
        // Auto-start not enabled, nothing to fix
        console.log('[AutoStart] Not enabled, nothing to verify');
        resolve(false);
        return;
      }

      // Auto-start is enabled - check if path is correct
      const correctPath = getCorrectAutoStartPath();

      // Normalize paths for comparison (remove quotes, normalize slashes)
      const normalizedCurrent = currentValue.replace(/"/g, '').toLowerCase();
      const normalizedCorrect = correctPath.replace(/"/g, '').toLowerCase();

      if (normalizedCurrent === normalizedCorrect) {
        console.log('[AutoStart] Registry entry is correct');
        resolve(true);
        return;
      }

      // Path is wrong - fix it automatically
      console.log('[AutoStart] Registry entry outdated');
      console.log('[AutoStart] Current:', currentValue);
      console.log('[AutoStart] Correct:', correctPath);

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
