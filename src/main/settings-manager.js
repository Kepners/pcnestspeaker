/**
 * Settings Manager - Persistent App Settings
 *
 * Saves and loads app settings to/from JSON file
 * Settings include:
 * - Last used speaker
 * - Auto-connect on startup
 * - Auto-start on Windows boot
 * - Preferred streaming mode
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Settings file path (in user data directory) - lazy initialization
function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Default settings
const DEFAULT_SETTINGS = {
  lastSpeaker: null,           // { name, ip, cast_type } - single speaker mode
  lastStereoSpeakers: null,    // { left: {...}, right: {...} } - stereo mode L/R pair
  lastMode: 'single',          // 'single' or 'stereo' - which mode was active
  autoConnect: false,          // Auto-connect to last speaker on startup
  autoStart: false,            // Start app on Windows boot
  streamingMode: 'webrtc-system',  // Default streaming mode
  volumeBoost: false,          // When true, speaker stays at 100%
  syncDelayMs: 0,              // PC speaker delay in ms (to sync with Nest)
  pcAudioEnabled: false,       // true = also play on PC speakers (via Listen)
  version: '1.0.0',

  // First-run setup
  firstRunComplete: false,     // Has user completed first-run wizard?
  equalizerApoInstalled: false, // Has user installed Equalizer APO?
  detectedRealSpeakers: null,  // List of detected real speakers (HDMI, Realtek, etc.)

  // Trial & License
  usageSeconds: 0,             // Total streaming seconds used
  firstUsedAt: null,           // Timestamp of first use
  lastUsedAt: null,            // Timestamp of last use
  trialExpired: false,         // Trial expiration flag
  licenseKey: null             // Purchased license key
};

let cachedSettings = null;

/**
 * Load settings from file
 */
function loadSettings() {
  try {
    const settingsFile = getSettingsFilePath();
    if (!fs.existsSync(settingsFile)) {
      console.log('[Settings] File not found, using defaults');
      cachedSettings = { ...DEFAULT_SETTINGS };
      return cachedSettings;
    }

    const data = fs.readFileSync(settingsFile, 'utf8');
    const settings = JSON.parse(data);

    // Merge with defaults (in case new settings are added in updates)
    cachedSettings = { ...DEFAULT_SETTINGS, ...settings };

    console.log('[Settings] Loaded from file');
    return cachedSettings;
  } catch (error) {
    console.error('[Settings] Failed to load:', error);
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }
}

/**
 * Save settings to file
 */
function saveSettings(settings) {
  try {
    // Ensure user data directory exists
    const userDataDir = app.getPath('userData');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    // Write settings to file
    const settingsFile = getSettingsFilePath();
    const data = JSON.stringify(settings, null, 2);
    fs.writeFileSync(settingsFile, data, 'utf8');

    // Update cache
    cachedSettings = settings;

    console.log('[Settings] Saved to file');
    return true;
  } catch (error) {
    console.error('[Settings] Failed to save:', error);
    return false;
  }
}

/**
 * Get a setting value
 */
function getSetting(key) {
  if (!cachedSettings) {
    cachedSettings = loadSettings();
  }

  return cachedSettings[key];
}

/**
 * Set a setting value
 */
function setSetting(key, value) {
  if (!cachedSettings) {
    cachedSettings = loadSettings();
  }

  cachedSettings[key] = value;
  saveSettings(cachedSettings);

  console.log(`[Settings] Set ${key}:`, value);
}

/**
 * Get all settings
 */
function getAllSettings() {
  if (!cachedSettings) {
    cachedSettings = loadSettings();
  }

  return { ...cachedSettings };
}

/**
 * Update multiple settings at once
 */
function updateSettings(updates) {
  if (!cachedSettings) {
    cachedSettings = loadSettings();
  }

  Object.assign(cachedSettings, updates);
  saveSettings(cachedSettings);

  console.log('[Settings] Updated:', Object.keys(updates));
}

/**
 * Reset to default settings
 */
function resetSettings() {
  cachedSettings = { ...DEFAULT_SETTINGS };
  saveSettings(cachedSettings);

  console.log('[Settings] Reset to defaults');
  return cachedSettings;
}

/**
 * Save last used speaker
 */
function saveLastSpeaker(speaker) {
  setSetting('lastSpeaker', speaker);
}

/**
 * Get last used speaker
 */
function getLastSpeaker() {
  return getSetting('lastSpeaker');
}

module.exports = {
  loadSettings,
  saveSettings,
  getSetting,
  setSetting,
  getAllSettings,
  updateSettings,
  resetSettings,
  saveLastSpeaker,
  getLastSpeaker
};
