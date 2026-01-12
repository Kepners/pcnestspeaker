/**
 * Dependency Installer - Auto-installs VB-Cable and Equalizer APO if missing
 *
 * Required dependencies:
 * 1. VB-Cable - Virtual audio cable for capturing system audio
 * 2. Equalizer APO - Audio processing for PC speaker delay sync
 *
 * This module:
 * 1. Checks if each dependency is installed
 * 2. If missing, installs silently with admin elevation
 * 3. Configures APO for the user's PC speakers
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

// ============================================================================
// EQUALIZER APO
// ============================================================================

const APO_INSTALL_PATH = 'C:\\Program Files\\EqualizerAPO';

// Path to bundled Equalizer APO installer
function getAPOInstallerPath() {
  // In development
  let installerPath = path.join(__dirname, '../../dependencies/equalizerapo/EqualizerAPO64-1.4.exe');

  // In production (packaged app)
  if (!fs.existsSync(installerPath)) {
    installerPath = path.join(process.resourcesPath, 'dependencies/equalizerapo/EqualizerAPO64-1.4.exe');
  }

  return installerPath;
}

/**
 * Check if Equalizer APO is installed
 */
function isAPOInstalled() {
  const dllPath = path.join(APO_INSTALL_PATH, 'EqualizerAPO.dll');
  const installed = fs.existsSync(dllPath);
  console.log(`[DependencyInstaller] Equalizer APO installed: ${installed}`);
  return installed;
}

/**
 * Check if APO is configured on at least one device
 * (Looks for backup .reg files created by APO Configurator)
 */
function isAPOConfigured() {
  try {
    const files = fs.readdirSync(APO_INSTALL_PATH);
    const hasBackup = files.some(f => f.startsWith('backup_') && f.endsWith('.reg'));
    console.log(`[DependencyInstaller] Equalizer APO configured: ${hasBackup}`);
    return hasBackup;
  } catch (e) {
    return false;
  }
}

/**
 * Install Equalizer APO silently
 */
async function installAPO(mainWindow) {
  const installerPath = getAPOInstallerPath();

  if (!fs.existsSync(installerPath)) {
    console.error('[DependencyInstaller] APO installer not found at:', installerPath);
    dialog.showErrorBox(
      'Installation Error',
      'Equalizer APO installer not found. Please reinstall PC Nest Speaker.'
    );
    return false;
  }

  // Show confirmation dialog
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Equalizer APO Required',
    message: 'Equalizer APO is required for PC speaker sync to work.',
    detail: 'This is a one-time installation. You will see a UAC prompt for Administrator privileges.\n\nAfter installation, you\'ll need to select your PC speakers in the APO Configurator.',
    buttons: ['Install Equalizer APO', 'Skip (sync won\'t work)'],
    defaultId: 0,
    cancelId: 1
  });

  if (response.response === 1) {
    return false;
  }

  return new Promise((resolve) => {
    console.log('[DependencyInstaller] Installing Equalizer APO:', installerPath);

    // APO installer supports /S for silent install
    const psCommand = `Start-Process -FilePath '"${installerPath}"' -ArgumentList '/S' -Verb RunAs -Wait`;

    const installer = spawn('powershell', ['-Command', psCommand], {
      shell: true,
      detached: true,
      windowsHide: true
    });

    installer.on('close', async (code) => {
      console.log('[DependencyInstaller] APO installer exited with code:', code);

      // Wait for installation to complete
      await new Promise(r => setTimeout(r, 2000));

      if (isAPOInstalled()) {
        console.log('[DependencyInstaller] Equalizer APO installed successfully!');

        // Now open the Configurator so user can select their device
        await openAPOConfigurator(mainWindow);
        resolve(true);
      } else {
        dialog.showErrorBox(
          'Installation Incomplete',
          'Equalizer APO installation was not completed. Please try again or install manually from:\nhttps://sourceforge.net/projects/equalizerapo/'
        );
        resolve(false);
      }
    });

    installer.on('error', (error) => {
      console.error('[DependencyInstaller] APO install error:', error);
      dialog.showErrorBox(
        'Installation Error',
        `Failed to install Equalizer APO: ${error.message}`
      );
      resolve(false);
    });
  });
}

/**
 * Open APO Configurator for user to select their PC speaker device
 */
async function openAPOConfigurator(mainWindow) {
  const configuratorPath = path.join(APO_INSTALL_PATH, 'Configurator.exe');

  if (!fs.existsSync(configuratorPath)) {
    console.error('[DependencyInstaller] APO Configurator not found');
    return false;
  }

  // Show instructions
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Configure Equalizer APO',
    message: 'Select your PC speakers in the APO Configurator',
    detail: 'The APO Configurator will open. Please:\n\n1. Find your PC speakers (e.g., "Speakers (Realtek)")\n2. Check the box next to it\n3. Click "OK" to save\n\nThis enables audio delay sync on your PC speakers.',
    buttons: ['Open Configurator']
  });

  return new Promise((resolve) => {
    // Run configurator with admin (required for APO)
    const psCommand = `Start-Process -FilePath '"${configuratorPath}"' -Verb RunAs -Wait`;

    const proc = spawn('powershell', ['-Command', psCommand], {
      shell: true,
      detached: true,
      windowsHide: true
    });

    proc.on('close', async () => {
      // Check if user configured a device
      await new Promise(r => setTimeout(r, 1000));

      if (isAPOConfigured()) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Configuration Complete',
          message: 'Equalizer APO is configured!',
          detail: 'PC speaker sync is now ready to use.\n\nNote: A restart is recommended for best results.',
          buttons: ['OK']
        });
        resolve(true);
      } else {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Configuration Skipped',
          message: 'No audio device was selected in APO Configurator.',
          detail: 'PC speaker sync won\'t work until you configure Equalizer APO.\n\nYou can run the Configurator later from the Settings menu.',
          buttons: ['OK']
        });
        resolve(false);
      }
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
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

  // ========================================
  // 1. CHECK VB-CABLE (required for streaming)
  // ========================================
  if (!isVBCableInstalled()) {
    console.log('[DependencyInstaller] VB-Cable not found - prompting installation');
    const installed = await installVBCable(mainWindow);
    if (!installed) {
      return false; // Can't continue without VB-Cable
    }
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

  // ========================================
  // 2. CHECK EQUALIZER APO (required for PC speaker sync)
  // ========================================
  if (!isAPOInstalled()) {
    console.log('[DependencyInstaller] Equalizer APO not found - prompting installation');
    await installAPO(mainWindow);
    // Don't block app startup if APO install is skipped - it's only needed for sync feature
  } else if (!isAPOConfigured()) {
    // APO is installed but no device is configured
    console.log('[DependencyInstaller] Equalizer APO installed but not configured');

    const response = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Configure Equalizer APO',
      message: 'Equalizer APO needs to be configured for PC speaker sync.',
      detail: 'Would you like to select your PC speakers now?\n\nThis is required for the "Wall of Sound" feature to sync your PC speakers with Nest.',
      buttons: ['Configure Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    if (response.response === 0) {
      await openAPOConfigurator(mainWindow);
    }
  }

  console.log('[DependencyInstaller] All dependencies OK');
  return true;
}

module.exports = {
  // VB-Cable
  isVBCableInstalled,
  isVBCableEnabled,
  repairVBCable,
  installVBCable,
  getVBCableInstallerPath,
  getVBCableDriverPath,
  // Equalizer APO
  isAPOInstalled,
  isAPOConfigured,
  installAPO,
  openAPOConfigurator,
  getAPOInstallerPath,
  // Main entry point
  checkAndInstallDependencies
};
