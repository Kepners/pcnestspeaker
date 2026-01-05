/**
 * Firewall Setup - Automatically configures Windows Firewall for streaming
 * Prompts user for admin permissions on first run
 */

const { exec } = require('child_process');
const sudo = require('sudo-prompt');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const RULE_NAME = 'PC Nest Speaker';
const PORT_RANGE = '8000-8010';

/**
 * Check if firewall rule already exists
 */
function checkFirewallRule() {
  return new Promise((resolve) => {
    exec(
      `netsh advfirewall firewall show rule name="${RULE_NAME}"`,
      (error, stdout) => {
        if (error || !stdout.includes(RULE_NAME)) {
          resolve(false);
        } else {
          resolve(true);
        }
      }
    );
  });
}

/**
 * Add firewall rule with admin elevation
 */
function addFirewallRule() {
  return new Promise((resolve, reject) => {
    const command = `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow protocol=TCP localport=${PORT_RANGE}`;

    const options = {
      name: 'PC Nest Speaker',
      icns: path.join(__dirname, '../../assets/icon.icns'), // macOS
    };

    console.log('Requesting admin permissions to add firewall rule...');

    sudo.exec(command, options, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to add firewall rule:', error);
        reject(error);
      } else {
        console.log('Firewall rule added successfully');
        resolve(true);
      }
    });
  });
}

/**
 * Get the settings file path for tracking firewall setup
 */
function getSettingsPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
}

/**
 * Check if firewall setup has been completed before
 */
function hasCompletedSetup() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.firewallSetupComplete === true;
    }
  } catch (e) {
    // Ignore errors
  }
  return false;
}

/**
 * Mark firewall setup as complete
 */
function markSetupComplete() {
  try {
    const settingsPath = getSettingsPath();
    let settings = {};

    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }

    settings.firewallSetupComplete = true;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

/**
 * Setup firewall on first run
 * Returns true if setup succeeded or was already done
 */
async function setupFirewall() {
  // Skip on non-Windows platforms
  if (process.platform !== 'win32') {
    return true;
  }

  // Check if already set up in our settings
  if (hasCompletedSetup()) {
    console.log('Firewall setup already completed (settings)');
    return true;
  }

  // Check if rule actually exists in Windows Firewall
  const ruleExists = await checkFirewallRule();
  if (ruleExists) {
    console.log('Firewall rule already exists');
    markSetupComplete();
    return true;
  }

  // Need to add the rule
  console.log('Firewall rule not found, requesting admin permissions...');

  try {
    await addFirewallRule();
    markSetupComplete();
    return true;
  } catch (error) {
    console.error('Firewall setup failed:', error);
    // Don't block the app, just warn
    return false;
  }
}

module.exports = { setupFirewall, checkFirewallRule, addFirewallRule };
