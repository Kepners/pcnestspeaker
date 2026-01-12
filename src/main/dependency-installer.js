/**
 * Dependency Installer - Auto-installs VB-Cable if missing
 *
 * VB-Cable is REQUIRED for PC Nest Speaker to work.
 * This module:
 * 1. Checks if VB-Cable is installed
 * 2. If missing, uses pnputil for SILENT driver installation (no browser popup!)
 * 3. Requests restart after installation
 */

const { app, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Path to bundled VB-Cable driver .inf file (for silent pnputil install)
function getVBCableDriverPath() {
  // In development
  let driverPath = path.join(__dirname, '../../dependencies/vbcable/vbMmeCable64_win10.inf');

  // In production (packaged app)
  if (!fs.existsSync(driverPath)) {
    driverPath = path.join(process.resourcesPath, 'dependencies/vbcable/vbMmeCable64_win10.inf');
  }

  return driverPath;
}

// Path to bundled VB-Cable installer (legacy - only used if pnputil fails)
function getVBCableInstallerPath() {
  // In development
  let installerPath = path.join(__dirname, '../../dependencies/vbcable/VBCABLE_Setup_x64.exe');

  // In production (packaged app)
  if (!fs.existsSync(installerPath)) {
    installerPath = path.join(process.resourcesPath, 'dependencies/vbcable/VBCABLE_Setup_x64.exe');
  }

  return installerPath;
}

/**
 * Check if VB-Cable is installed by looking for the device
 */
function isVBCableInstalled() {
  try {
    // Use PowerShell to check for VB-Cable audio device
    const result = execSync(
      'powershell -Command "Get-PnpDevice -Class AudioEndpoint -Status OK | Where-Object { $_.FriendlyName -like \'*CABLE*\' -or $_.FriendlyName -like \'*VB-Audio*\' } | Select-Object -First 1"',
      { encoding: 'utf8', timeout: 10000 }
    );

    // If we get any output, VB-Cable is installed
    if (result && result.trim().length > 0) {
      console.log('[DependencyInstaller] VB-Cable is installed');
      return true;
    }

    // Also check registry for VB-Cable driver
    try {
      const regResult = execSync(
        'reg query "HKLM\\SOFTWARE\\VB-Audio\\Cable" 2>nul || reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\VBAudioVACMME" 2>nul',
        { encoding: 'utf8', timeout: 5000 }
      );
      if (regResult && regResult.trim().length > 0) {
        console.log('[DependencyInstaller] VB-Cable found in registry');
        return true;
      }
    } catch (e) {
      // Registry key not found
    }

    console.log('[DependencyInstaller] VB-Cable NOT installed');
    return false;
  } catch (error) {
    console.log('[DependencyInstaller] Error checking VB-Cable:', error.message);
    return false;
  }
}

/**
 * Check if VB-Cable device is enabled (not just installed)
 */
function isVBCableEnabled() {
  try {
    const result = execSync(
      'powershell -Command "Get-PnpDevice -Class AudioEndpoint -Status OK | Where-Object { $_.FriendlyName -like \'*CABLE Input*\' } | Select-Object -First 1"',
      { encoding: 'utf8', timeout: 10000 }
    );
    return result && result.trim().length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Repair/re-enable VB-Cable using pnputil (SILENT - no browser popup!)
 */
async function repairVBCable(mainWindow) {
  console.log('[DependencyInstaller] Repairing VB-Cable silently with pnputil...');

  const driverPath = getVBCableDriverPath();

  if (!fs.existsSync(driverPath)) {
    console.error('[DependencyInstaller] VB-Cable driver not found at:', driverPath);
    return false;
  }

  return new Promise((resolve) => {
    console.log('[DependencyInstaller] Running pnputil to reinstall driver:', driverPath);

    // Use pnputil for SILENT driver installation - no browser popup!
    // /add-driver adds the driver package to the driver store
    // /install installs matching devices
    // /force forces reinstall even if already installed
    const psCommand = `Start-Process -FilePath 'pnputil' -ArgumentList '/add-driver', '"${driverPath}"', '/install', '/force' -Verb RunAs -Wait -WindowStyle Hidden`;

    const installer = spawn('powershell', ['-Command', psCommand], {
      shell: true,
      detached: true,
      windowsHide: true
    });

    installer.on('close', async (code) => {
      console.log('[DependencyInstaller] pnputil repair exited with code:', code);

      // Wait a moment for driver to register
      await new Promise(r => setTimeout(r, 3000));

      // Check if it worked
      if (isVBCableEnabled()) {
        console.log('[DependencyInstaller] VB-Cable repaired and enabled!');
        resolve(true);
      } else {
        console.log('[DependencyInstaller] VB-Cable still not enabled after repair');
        resolve(false);
      }
    });

    installer.on('error', (error) => {
      console.error('[DependencyInstaller] Repair error:', error);
      resolve(false);
    });
  });
}

/**
 * Install VB-Cable with admin elevation using pnputil (SILENT - no browser popup!)
 * Returns a promise that resolves when installation completes
 */
async function installVBCable(mainWindow) {
  const driverPath = getVBCableDriverPath();

  if (!fs.existsSync(driverPath)) {
    console.error('[DependencyInstaller] VB-Cable driver not found at:', driverPath);
    dialog.showErrorBox(
      'Installation Error',
      'VB-Cable driver files not found. Please reinstall PC Nest Speaker.'
    );
    return false;
  }

  // Show confirmation dialog
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'VB-Cable Required',
    message: 'VB-Cable virtual audio driver is required for PC Nest Speaker to work.',
    detail: 'This is a one-time silent installation. You will see a UAC prompt for Administrator privileges.\n\nAfter installation, you will need to restart your PC.',
    buttons: ['Install VB-Cable', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  });

  if (response.response === 1) {
    // User cancelled
    return false;
  }

  return new Promise((resolve) => {
    console.log('[DependencyInstaller] Installing VB-Cable silently with pnputil:', driverPath);

    // Use pnputil for SILENT driver installation - no browser popup!
    // /add-driver adds the driver package to the driver store
    // /install installs matching devices
    const psCommand = `Start-Process -FilePath 'pnputil' -ArgumentList '/add-driver', '"${driverPath}"', '/install' -Verb RunAs -Wait -WindowStyle Hidden`;

    const installer = spawn('powershell', ['-Command', psCommand], {
      shell: true,
      detached: true,
      windowsHide: true
    });

    installer.on('close', async (code) => {
      console.log('[DependencyInstaller] pnputil install exited with code:', code);

      // Check if installation was successful
      // Wait a moment for driver to register
      await new Promise(r => setTimeout(r, 3000));

      if (isVBCableInstalled()) {
        // Success! Ask for restart
        const restartResponse = await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Installation Complete',
          message: 'VB-Cable has been installed successfully!',
          detail: 'You need to restart your PC for the audio driver to work properly.\n\nRestart now?',
          buttons: ['Restart Now', 'Restart Later'],
          defaultId: 0,
          cancelId: 1
        });

        if (restartResponse.response === 0) {
          // Restart PC
          spawn('shutdown', ['/r', '/t', '5', '/c', 'PC Nest Speaker: Restarting to complete VB-Cable installation'], {
            shell: true,
            detached: true,
            windowsHide: true
          });
          app.quit();
        }

        resolve(true);
      } else {
        // Installation may have failed or been cancelled
        dialog.showErrorBox(
          'Installation Incomplete',
          'VB-Cable installation was not completed. Please try again or install manually from:\nhttps://vb-audio.com/Cable/'
        );
        resolve(false);
      }
    });

    installer.on('error', (error) => {
      console.error('[DependencyInstaller] pnputil error:', error);
      dialog.showErrorBox(
        'Installation Error',
        `Failed to install VB-Cable driver: ${error.message}`
      );
      resolve(false);
    });
  });
}

/**
 * Check and install dependencies on app startup
 * Call this from electron-main.js after app is ready
 */
async function checkAndInstallDependencies(mainWindow) {
  console.log('[DependencyInstaller] Checking dependencies...');

  // Check VB-Cable
  if (!isVBCableInstalled()) {
    console.log('[DependencyInstaller] VB-Cable not found - prompting installation');
    const installed = await installVBCable(mainWindow);
    return installed;
  }

  // Check if VB-Cable is enabled
  if (!isVBCableEnabled()) {
    console.log('[DependencyInstaller] VB-Cable installed but disabled - will repair');

    // Ask user permission to repair
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'VB-Cable Needs Repair',
      message: 'VB-Cable is installed but disabled.',
      detail: 'Click "Repair VB-Cable" to fix this. The installer will run with Administrator privileges.\n\nYou may need to restart your PC after repair.',
      buttons: ['Repair VB-Cable', 'Skip (audio won\'t work)'],
      defaultId: 0,
      cancelId: 1
    });

    if (response.response === 0) {
      // Run installer to repair
      const repaired = await repairVBCable(mainWindow);

      if (repaired) {
        // Success! Ask for restart
        const restartResponse = await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'VB-Cable Repaired',
          message: 'VB-Cable has been repaired successfully!',
          detail: 'A restart is recommended to ensure the driver works properly.\n\nRestart now?',
          buttons: ['Restart Now', 'Continue Without Restart'],
          defaultId: 0,
          cancelId: 1
        });

        if (restartResponse.response === 0) {
          // Restart PC
          spawn('shutdown', ['/r', '/t', '5', '/c', 'PC Nest Speaker: Restarting to complete VB-Cable repair'], {
            shell: true,
            detached: true,
            windowsHide: true
          });
          app.quit();
        }
      } else {
        // Repair failed, offer restart anyway (often fixes it)
        const restartResponse = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'VB-Cable Repair',
          message: 'VB-Cable repair may require a restart.',
          detail: 'If you completed the VB-Cable installer, try restarting your PC.\n\nRestart now?',
          buttons: ['Restart Now', 'Continue Anyway'],
          defaultId: 0,
          cancelId: 1
        });

        if (restartResponse.response === 0) {
          spawn('shutdown', ['/r', '/t', '5', '/c', 'PC Nest Speaker: Restarting to complete VB-Cable repair'], {
            shell: true,
            detached: true,
            windowsHide: true
          });
          app.quit();
        }
      }
    }
  }

  console.log('[DependencyInstaller] All dependencies OK');
  return true;
}

module.exports = {
  isVBCableInstalled,
  isVBCableEnabled,
  repairVBCable,
  installVBCable,
  checkAndInstallDependencies,
  getVBCableInstallerPath,
  getVBCableDriverPath
};
