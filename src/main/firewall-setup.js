/**
 * Firewall Setup - Automatically configures Windows Firewall for streaming
 * Prompts user for admin permissions on first run
 */

const { exec } = require('child_process');
const sudo = require('sudo-prompt');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Firewall rules needed for streaming
const RULES = [
  { name: 'PC Nest Speaker HTTP', ports: '8000-8010', protocol: 'TCP' },
  { name: 'PC Nest Speaker WebRTC', ports: '8889', protocol: 'TCP' },
  { name: 'PC Nest Speaker ICE UDP', ports: '8189', protocol: 'UDP' },
  { name: 'PC Nest Speaker ICE TCP', ports: '8189', protocol: 'TCP' }
];

/**
 * Check if a specific firewall rule exists
 */
function checkFirewallRule(ruleName) {
  return new Promise((resolve) => {
    exec(
      `netsh advfirewall firewall show rule name="${ruleName}"`,
      { windowsHide: true },
      (error, stdout) => {
        if (error || !stdout.includes(ruleName)) {
          resolve(false);
        } else {
          resolve(true);
        }
      }
    );
  });
}

/**
 * Check which firewall rules are missing
 */
async function getMissingRules() {
  const missing = [];
  for (const rule of RULES) {
    const exists = await checkFirewallRule(rule.name);
    if (!exists) {
      missing.push(rule);
    }
  }
  return missing;
}

/**
 * Add firewall rules with admin elevation
 * @param {Array} rules - Array of rule objects to add
 */
function addFirewallRules(rules) {
  return new Promise((resolve, reject) => {
    // Build command to add all missing rules in one admin prompt
    const commands = rules.map(rule =>
      `netsh advfirewall firewall add rule name="${rule.name}" dir=in action=allow protocol=${rule.protocol} localport=${rule.ports}`
    ).join(' && ');

    const options = {
      name: 'PC Nest Speaker',
      icns: path.join(__dirname, '../../assets/icon.icns'), // macOS
    };

    console.log(`Requesting admin permissions to add ${rules.length} firewall rule(s)...`);
    console.log('Rules:', rules.map(r => `${r.name} (${r.protocol}:${r.ports})`).join(', '));

    sudo.exec(commands, options, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to add firewall rules:', error);
        reject(error);
      } else {
        console.log('Firewall rules added successfully');
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
    // Still check for missing rules (in case we added new ones in an update)
  }

  // Check which rules are missing
  const missingRules = await getMissingRules();

  if (missingRules.length === 0) {
    console.log('All firewall rules already exist');
    markSetupComplete();
    return true;
  }

  // Need to add missing rules
  console.log(`Missing ${missingRules.length} firewall rule(s), requesting admin permissions...`);

  try {
    await addFirewallRules(missingRules);
    markSetupComplete();
    return true;
  } catch (error) {
    console.error('Firewall setup failed:', error);
    // Don't block the app, just warn
    return false;
  }
}

module.exports = { setupFirewall, checkFirewallRule, addFirewallRules, getMissingRules };
