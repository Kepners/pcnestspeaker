/**
 * Auto-Sync Manager - Automatically monitors and adjusts sync delay
 *
 * Periodically measures latency to Cast devices and adjusts the APO delay
 * if it has drifted due to PC load or network conditions.
 */

const { exec } = require('child_process');
const path = require('path');

// Configuration
const CHECK_INTERVAL_MS = 60000; // Check every 60 seconds
const ADJUSTMENT_THRESHOLD_MS = 50; // Only adjust if drift > 50ms
const MIN_DELAY_MS = 200; // Minimum reasonable delay
const MAX_DELAY_MS = 2000; // Maximum delay

// State
let isEnabled = false;
let checkInterval = null;
let currentSpeaker = null; // { name, ip }
let baselineRtt = null; // RTT when user set their "perfect" delay
let baselineDelay = null; // The delay that was "perfect" for the user
let onDelayAdjusted = null; // Callback when delay is auto-adjusted
let audioSyncManager = null;
let sendLogFn = null;

/**
 * Initialize the auto-sync manager
 * @param {object} options - Configuration options
 * @param {object} options.audioSync - Reference to audioSyncManager
 * @param {function} options.sendLog - Function to send log messages to UI
 * @param {function} options.onAdjust - Callback when delay is auto-adjusted (newDelay, oldDelay)
 */
function initialize(options = {}) {
  audioSyncManager = options.audioSync;
  sendLogFn = options.sendLog || console.log;
  onDelayAdjusted = options.onAdjust;

  console.log('[AutoSync] Initialized');
}

/**
 * Start auto-sync monitoring for a specific speaker
 * @param {object} speaker - Speaker info { name, ip }
 */
function start(speaker) {
  if (!speaker || !speaker.name) {
    console.log('[AutoSync] Cannot start - no speaker provided');
    return false;
  }

  currentSpeaker = speaker;
  isEnabled = true;

  // Clear any existing interval
  if (checkInterval) {
    clearInterval(checkInterval);
  }

  // Start periodic checks
  checkInterval = setInterval(async () => {
    if (isEnabled && currentSpeaker) {
      await checkAndAdjust();
    }
  }, CHECK_INTERVAL_MS);

  log(`Auto-sync started for "${speaker.name}" (checking every ${CHECK_INTERVAL_MS / 1000}s)`);
  return true;
}

/**
 * Stop auto-sync monitoring
 */
function stop() {
  isEnabled = false;
  currentSpeaker = null;

  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }

  log('Auto-sync stopped');
}

/**
 * Set the baseline - the "perfect" sync point the user calibrated
 * Auto-sync will adjust relative to this baseline based on network changes
 */
function setBaseline() {
  return new Promise(async (resolve) => {
    if (!currentSpeaker || !audioSyncManager) {
      resolve(false);
      return;
    }

    // Get current delay (user's calibrated "perfect" delay)
    baselineDelay = audioSyncManager.getDelay();

    // Measure current RTT as baseline
    baselineRtt = await measureLatencyQuick(currentSpeaker.ip);

    if (baselineRtt !== null && baselineDelay > 0) {
      log(`Baseline set: ${baselineDelay}ms delay at ${baselineRtt}ms RTT`);
      resolve(true);
    } else {
      log('Could not establish baseline', 'warning');
      resolve(false);
    }
  });
}

/**
 * Check current latency and adjust if needed
 *
 * SMART APPROACH: Instead of guessing the ideal delay, we use the user's
 * calibrated delay as a baseline and only adjust for NETWORK CHANGES.
 *
 * If baseline RTT was 10ms when user set 950ms delay, and now RTT is 60ms,
 * we know network added 50ms latency, so new delay should be 1000ms.
 */
async function checkAndAdjust() {
  if (!currentSpeaker || !audioSyncManager) {
    return;
  }

  try {
    console.log(`[AutoSync] Checking latency to "${currentSpeaker.name}"...`);

    // Measure current latency
    const currentRtt = await measureLatencyQuick(currentSpeaker.ip);

    if (currentRtt === null) {
      console.log('[AutoSync] Could not measure latency');
      return;
    }

    // Get current delay setting
    const currentDelay = audioSyncManager.getDelay();

    // If no baseline, establish one now
    if (baselineRtt === null || baselineDelay === null) {
      baselineRtt = currentRtt;
      baselineDelay = currentDelay;
      console.log(`[AutoSync] Established baseline: ${baselineDelay}ms at ${baselineRtt}ms RTT`);
      return;
    }

    // Calculate network drift from baseline
    const rttDrift = currentRtt - baselineRtt;

    // Calculate what the delay SHOULD be based on network change
    const targetDelay = baselineDelay + rttDrift;

    // Calculate how far off we are
    const delayDrift = Math.abs(targetDelay - currentDelay);

    console.log(`[AutoSync] RTT: ${currentRtt}ms (baseline: ${baselineRtt}ms, drift: ${rttDrift > 0 ? '+' : ''}${rttDrift}ms)`);
    console.log(`[AutoSync] Delay: ${currentDelay}ms (target: ${targetDelay}ms, drift: ${delayDrift}ms)`);

    // Only adjust if drift exceeds threshold
    if (delayDrift > ADJUSTMENT_THRESHOLD_MS) {
      // Clamp to valid range
      const newDelay = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, targetDelay));

      // Round to nearest 50ms for cleaner values
      const roundedDelay = Math.round(newDelay / 50) * 50;

      log(`Auto-adjusting sync: ${currentDelay}ms → ${roundedDelay}ms (network ${rttDrift > 0 ? 'slower' : 'faster'} by ${Math.abs(rttDrift)}ms)`);

      // Apply the new delay
      const result = await audioSyncManager.setDelay(roundedDelay);

      if (result) {
        // Notify callback
        if (onDelayAdjusted) {
          onDelayAdjusted(roundedDelay, currentDelay);
        }
      }
    } else {
      console.log(`[AutoSync] Drift (${delayDrift}ms) within threshold, no adjustment needed`);
    }
  } catch (err) {
    console.error('[AutoSync] Check failed:', err.message);
  }
}

/**
 * Quick latency measurement using ping (faster than full Cast ping)
 * @param {string} ip - IP address to ping
 * @returns {Promise<number|null>} RTT in ms or null if failed
 */
function measureLatencyQuick(ip) {
  return new Promise((resolve) => {
    if (!ip) {
      resolve(null);
      return;
    }

    // Windows ping: -n 3 = 3 pings, -w 1000 = 1 second timeout
    const cmd = `ping -n 3 -w 1000 ${ip}`;

    exec(cmd, { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) {
        console.log('[AutoSync] Ping failed:', error.message);
        resolve(null);
        return;
      }

      // Parse average RTT from ping output
      // Windows format: "Average = 5ms" or "Average = 5 ms"
      const avgMatch = stdout.match(/Average\s*=\s*(\d+)\s*ms/i);
      if (avgMatch) {
        const rtt = parseInt(avgMatch[1], 10);
        console.log(`[AutoSync] Ping RTT: ${rtt}ms`);
        resolve(rtt);
      } else {
        // Try to get any RTT value
        const timeMatch = stdout.match(/time[=<](\d+)ms/i);
        if (timeMatch) {
          resolve(parseInt(timeMatch[1], 10));
        } else {
          resolve(null);
        }
      }
    });
  });
}

/**
 * Force an immediate sync check
 */
async function checkNow() {
  if (!currentSpeaker) {
    log('No active speaker to check', 'warning');
    return null;
  }

  return await checkAndAdjust();
}

/**
 * Set the check interval (in seconds)
 * @param {number} seconds - Interval between checks
 */
function setCheckInterval(seconds) {
  const ms = Math.max(30, seconds) * 1000; // Minimum 30 seconds

  if (checkInterval && isEnabled) {
    clearInterval(checkInterval);
    checkInterval = setInterval(async () => {
      if (isEnabled && currentSpeaker) {
        await checkAndAdjust();
      }
    }, ms);
  }

  console.log(`[AutoSync] Check interval set to ${seconds}s`);
}

/**
 * Get current status
 */
function getStatus() {
  return {
    enabled: isEnabled,
    speaker: currentSpeaker,
    baselineDelay,
    baselineRtt,
    intervalMs: CHECK_INTERVAL_MS
  };
}

/**
 * Log helper
 */
function log(message, level = 'info') {
  if (sendLogFn) {
    sendLogFn(`[AutoSync] ${message}`, level);
  }
  console.log(`[AutoSync] ${message}`);
}

module.exports = {
  initialize,
  start,
  stop,
  checkNow,
  setBaseline,
  setCheckInterval,
  getStatus
};
