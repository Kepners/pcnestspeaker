/**
 * Usage Tracker - Tamper-Resistant Trial System
 *
 * Tracks streaming usage time to enforce 10-hour trial limit.
 * Uses encrypted storage with HMAC signatures to prevent tampering.
 *
 * If tampering is detected (file modified, decryption fails, HMAC mismatch),
 * the trial auto-expires as punishment.
 *
 * Storage: %APPDATA%/PC Nest Speaker/.usage (encrypted binary)
 */

// ============== OWNER MODE ==============
// Set to true to bypass all DRM/trial checks (for developer's personal use)
const OWNER_MODE = false;
// ========================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const settingsManager = require('./settings-manager');

// Constants
const TRIAL_HOURS = 10;
const TRIAL_SECONDS = TRIAL_HOURS * 60 * 60; // 36000 seconds = 10 hours

// Encryption settings
const ALGORITHM = 'aes-128-cbc';
const HMAC_ALGORITHM = 'sha256';

// Tracking state
let streamStartTime = null; // Timestamp when streaming started
let trackingInterval = null; // Interval for updating usage
let cachedData = null; // In-memory cache to reduce disk reads

// ============== TAMPER-RESISTANT STORAGE ==============

/**
 * Get machine-specific ID (makes copying between machines harder)
 */
function getMachineId() {
  const os = require('os');
  const raw = `${os.hostname()}-${os.userInfo().username}-${os.cpus()[0]?.model || 'cpu'}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Derive encryption key from machine ID + app salt
 */
function deriveKey() {
  const machineId = getMachineId();
  const salt = 'PCNestSpeaker2025';
  return crypto.scryptSync(machineId, salt, 16);
}

/**
 * Derive HMAC key (different from encryption key)
 */
function deriveHmacKey() {
  const machineId = getMachineId();
  const salt = 'PNS-HMAC-2025';
  return crypto.scryptSync(machineId, salt, 32);
}

/**
 * Get encrypted storage file path
 */
function getSecureStoragePath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, '.usage');
}

/**
 * Encrypt data object
 */
function encrypt(data) {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { iv: iv.toString('hex'), data: encrypted };
}

/**
 * Decrypt data object
 */
function decrypt(encryptedObj) {
  const key = deriveKey();
  const iv = Buffer.from(encryptedObj.iv, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encryptedObj.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

/**
 * Generate HMAC signature
 */
function sign(data) {
  const hmacKey = deriveHmacKey();
  const hmac = crypto.createHmac(HMAC_ALGORITHM, hmacKey);
  hmac.update(JSON.stringify(data));
  return hmac.digest('hex');
}

/**
 * Verify HMAC signature
 */
function verify(data, signature) {
  try {
    const expectedSig = sign(data);
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Get default trial data
 */
function getDefaultData() {
  return {
    usageSeconds: 0,
    firstUsedAt: null,
    lastUsedAt: null,
    tampered: false,
    version: 2
  };
}

/**
 * Load secure trial data (with tamper detection)
 */
function loadSecureData() {
  if (cachedData) return cachedData;

  const filePath = getSecureStoragePath();

  try {
    if (!fs.existsSync(filePath)) {
      // First run - create new encrypted storage
      console.log('[UsageTracker] First run - creating secure storage');
      cachedData = getDefaultData();
      saveSecureData(cachedData);
      return cachedData;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const stored = JSON.parse(raw);

    // Verify format
    if (!stored.signature || !stored.encrypted) {
      console.log('[UsageTracker] Invalid storage format - TAMPERED');
      return markTampered();
    }

    // Decrypt
    const decrypted = decrypt(stored.encrypted);

    // Verify HMAC signature
    if (!verify(decrypted, stored.signature)) {
      console.log('[UsageTracker] HMAC mismatch - TAMPERED');
      return markTampered();
    }

    // Check for clock manipulation (clock set way into the future then back)
    if (decrypted.lastUsedAt && decrypted.lastUsedAt > Date.now() + 60000) {
      console.log('[UsageTracker] Clock manipulation detected - TAMPERED');
      return markTampered();
    }

    cachedData = decrypted;
    return decrypted;

  } catch (err) {
    console.log('[UsageTracker] Load error (tampering?):', err.message);
    return markTampered();
  }
}

/**
 * Save secure trial data (encrypted + signed)
 */
function saveSecureData(data) {
  const filePath = getSecureStoragePath();

  try {
    data.lastUsedAt = Date.now();
    cachedData = data;

    const encrypted = encrypt(data);
    const signature = sign(data);

    const stored = {
      encrypted,
      signature,
      v: 2 // Format version
    };

    fs.writeFileSync(filePath, JSON.stringify(stored), 'utf8');
    return true;

  } catch (err) {
    console.error('[UsageTracker] Save error:', err.message);
    return false;
  }
}

/**
 * Mark as tampered - trial expires immediately as punishment
 */
function markTampered() {
  const data = {
    usageSeconds: TRIAL_SECONDS + 1, // Over limit
    firstUsedAt: 0,
    lastUsedAt: Date.now(),
    tampered: true,
    version: 2
  };
  cachedData = data;
  saveSecureData(data);
  console.log('[UsageTracker] ⚠️ TAMPERING DETECTED - Trial expired');
  return data;
}

// ============== TRACKING FUNCTIONS ==============

/**
 * Start tracking usage (called when streaming starts)
 */
function startTracking() {
  if (streamStartTime) {
    console.log('[UsageTracker] Already tracking');
    return;
  }

  const data = loadSecureData();

  // Check if trial has expired or tampered
  if (data.tampered || data.usageSeconds >= TRIAL_SECONDS) {
    console.log('[UsageTracker] Trial expired - not tracking');
    return;
  }

  streamStartTime = Date.now();
  console.log('[UsageTracker] Started tracking usage');

  // Update first used timestamp if not set
  if (!data.firstUsedAt) {
    data.firstUsedAt = streamStartTime;
    saveSecureData(data);
  }

  // Update usage every 10 seconds while streaming
  trackingInterval = setInterval(() => {
    updateUsage();
  }, 10000);
}

/**
 * Stop tracking usage (called when streaming stops)
 */
function stopTracking() {
  if (!streamStartTime) {
    console.log('[UsageTracker] Not tracking');
    return;
  }

  // Final usage update
  updateUsage();

  // Clear tracking state
  clearInterval(trackingInterval);
  trackingInterval = null;
  streamStartTime = null;

  console.log('[UsageTracker] Stopped tracking usage');
}

/**
 * Update usage seconds (internal - uses secure storage)
 */
function updateUsage() {
  if (!streamStartTime) return;

  const now = Date.now();
  const sessionSeconds = Math.floor((now - streamStartTime) / 1000);

  // Get current secure data
  const data = loadSecureData();
  if (data.tampered) return; // Don't track if tampered

  data.usageSeconds += sessionSeconds;

  // Reset stream start time for next interval
  streamStartTime = now;

  // Check if trial expired
  if (data.usageSeconds >= TRIAL_SECONDS) {
    console.log('[UsageTracker] Trial expired!');
  }

  saveSecureData(data);
  console.log(`[UsageTracker] Usage: ${data.usageSeconds}s / ${TRIAL_SECONDS}s (${formatTime(data.usageSeconds)} / ${TRIAL_HOURS} hours)`);
}

/**
 * Get current usage statistics
 */
function getUsage() {
  // OWNER MODE: Skip all DRM checks
  if (OWNER_MODE) {
    return {
      usageSeconds: 0,
      remainingSeconds: TRIAL_SECONDS,
      percentUsed: 0,
      trialExpired: false,
      hasLicense: true,  // Always licensed in owner mode
      firstUsedAt: Date.now(),
      lastUsedAt: Date.now(),
      ownerMode: true
    };
  }

  const data = loadSecureData();
  const licenseKey = settingsManager.getSetting('licenseKey') || null;

  const remainingSeconds = Math.max(0, TRIAL_SECONDS - data.usageSeconds);
  const percentUsed = Math.min(100, (data.usageSeconds / TRIAL_SECONDS) * 100);
  const trialExpired = data.tampered || data.usageSeconds >= TRIAL_SECONDS;

  return {
    usageSeconds: data.usageSeconds,
    remainingSeconds,
    percentUsed,
    trialExpired: licenseKey ? false : trialExpired,
    hasLicense: !!licenseKey,
    firstUsedAt: data.firstUsedAt,
    lastUsedAt: data.lastUsedAt,
    trialHours: TRIAL_HOURS,
    trialSeconds: TRIAL_SECONDS,
    formattedUsage: formatTime(data.usageSeconds),
    formattedRemaining: formatTime(remainingSeconds),
    tampered: data.tampered || false
  };
}

/**
 * Check if trial has expired (blocks streaming if true)
 */
function isTrialExpired() {
  // OWNER MODE: Never expired
  if (OWNER_MODE) return false;

  const usage = getUsage();
  return usage.trialExpired && !usage.hasLicense;
}

/**
 * Reset usage (DEV ONLY - requires special key)
 * @param {string} devKey - Developer reset key (machine-specific)
 */
function resetUsage(devKey) {
  // Generate expected key from machine ID
  const expectedKey = crypto.createHash('sha256')
    .update('PNS-DEV-RESET-' + getMachineId())
    .digest('hex')
    .slice(0, 16);

  if (devKey !== expectedKey) {
    console.log('[UsageTracker] Invalid dev key - reset denied');
    return false;
  }

  // Reset to clean state
  cachedData = null;
  const data = getDefaultData();
  saveSecureData(data);
  console.log('[UsageTracker] DEV RESET successful');
  return true;
}

/**
 * Get dev reset key (only in dev mode)
 */
function getDevKey() {
  if (app.isPackaged) return null; // Hidden in production
  return crypto.createHash('sha256')
    .update('PNS-DEV-RESET-' + getMachineId())
    .digest('hex')
    .slice(0, 16);
}

/**
 * Activate license (removes trial limits)
 * License key still stored in settings.json (validated against Stripe)
 */
function activateLicense(licenseKey) {
  settingsManager.setSetting('licenseKey', licenseKey);
  console.log('[UsageTracker] License activated');
}

/**
 * Deactivate license (re-enables trial limits)
 */
function deactivateLicense() {
  settingsManager.setSetting('licenseKey', null);
  console.log('[UsageTracker] License deactivated');
}

/**
 * Format seconds to human-readable time (e.g., "2h 30m")
 */
function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

/**
 * Clear cache (force reload from disk)
 */
function clearCache() {
  cachedData = null;
}

module.exports = {
  startTracking,
  stopTracking,
  getUsage,
  isTrialExpired,
  resetUsage,
  activateLicense,
  deactivateLicense,
  formatTime,
  getDevKey,
  clearCache
};
