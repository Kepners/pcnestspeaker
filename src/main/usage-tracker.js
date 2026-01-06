/**
 * Usage Tracker - Trial Time Management
 *
 * Tracks streaming usage time to enforce 10-hour trial limit.
 * Only counts time while actively streaming.
 *
 * Usage data stored in settings.json:
 * - usageSeconds: Total seconds used
 * - firstUsedAt: Timestamp of first use
 * - lastUsedAt: Timestamp of last use
 * - trialExpired: Boolean flag
 */

const settingsManager = require('./settings-manager');

// Constants
const TRIAL_HOURS = 10;
const TRIAL_SECONDS = TRIAL_HOURS * 60 * 60; // 36000 seconds = 10 hours

// Tracking state
let streamStartTime = null; // Timestamp when streaming started
let trackingInterval = null; // Interval for updating usage

/**
 * Start tracking usage (called when streaming starts)
 */
function startTracking() {
  if (streamStartTime) {
    console.log('[UsageTracker] Already tracking');
    return;
  }

  const usage = getUsage();

  // Check if trial has expired
  if (usage.usageSeconds >= TRIAL_SECONDS) {
    console.log('[UsageTracker] Trial expired - not tracking');
    return;
  }

  streamStartTime = Date.now();
  console.log('[UsageTracker] Started tracking usage');

  // Update first used timestamp if not set
  if (!settingsManager.getSetting('firstUsedAt')) {
    settingsManager.setSetting('firstUsedAt', streamStartTime);
  }

  // Update usage every 10 seconds while streaming
  trackingInterval = setInterval(() => {
    updateUsage();
  }, 10000); // Update every 10 seconds
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
 * Update usage seconds in settings
 */
function updateUsage() {
  if (!streamStartTime) return;

  const now = Date.now();
  const sessionSeconds = Math.floor((now - streamStartTime) / 1000);

  // Get current usage
  const currentUsage = settingsManager.getSetting('usageSeconds') || 0;
  const newUsage = currentUsage + sessionSeconds;

  // Save updated usage
  settingsManager.setSetting('usageSeconds', newUsage);
  settingsManager.setSetting('lastUsedAt', now);

  // Reset stream start time for next interval
  streamStartTime = now;

  // Check if trial expired
  if (newUsage >= TRIAL_SECONDS) {
    settingsManager.setSetting('trialExpired', true);
    console.log('[UsageTracker] Trial expired!');
  }

  console.log(`[UsageTracker] Usage: ${newUsage}s / ${TRIAL_SECONDS}s (${formatTime(newUsage)} / ${TRIAL_HOURS} hours)`);
}

/**
 * Get current usage statistics
 */
function getUsage() {
  const usageSeconds = settingsManager.getSetting('usageSeconds') || 0;
  const firstUsedAt = settingsManager.getSetting('firstUsedAt') || null;
  const lastUsedAt = settingsManager.getSetting('lastUsedAt') || null;
  const trialExpired = settingsManager.getSetting('trialExpired') || false;
  const licenseKey = settingsManager.getSetting('licenseKey') || null;

  const remainingSeconds = Math.max(0, TRIAL_SECONDS - usageSeconds);
  const percentUsed = Math.min(100, (usageSeconds / TRIAL_SECONDS) * 100);

  return {
    usageSeconds,
    remainingSeconds,
    percentUsed,
    trialExpired: licenseKey ? false : trialExpired, // Licensed users don't have trial limits
    hasLicense: !!licenseKey,
    firstUsedAt,
    lastUsedAt,
    trialHours: TRIAL_HOURS,
    trialSeconds: TRIAL_SECONDS,
    formattedUsage: formatTime(usageSeconds),
    formattedRemaining: formatTime(remainingSeconds)
  };
}

/**
 * Check if trial has expired (blocks streaming if true)
 */
function isTrialExpired() {
  const usage = getUsage();
  return usage.trialExpired && !usage.hasLicense;
}

/**
 * Reset usage (for testing or after purchase)
 */
function resetUsage() {
  settingsManager.setSetting('usageSeconds', 0);
  settingsManager.setSetting('trialExpired', false);
  settingsManager.setSetting('firstUsedAt', null);
  settingsManager.setSetting('lastUsedAt', null);
  console.log('[UsageTracker] Usage reset');
}

/**
 * Activate license (removes trial limits)
 */
function activateLicense(licenseKey) {
  settingsManager.setSetting('licenseKey', licenseKey);
  settingsManager.setSetting('trialExpired', false);
  console.log('[UsageTracker] License activated');
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

module.exports = {
  startTracking,
  stopTracking,
  getUsage,
  isTrialExpired,
  resetUsage,
  activateLicense,
  formatTime
};
