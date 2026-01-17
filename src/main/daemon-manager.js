/**
 * Daemon Manager
 *
 * Manages the persistent Python cast-daemon.py subprocess.
 * The daemon maintains Cast connections in memory, making volume changes INSTANT.
 *
 * Instead of spawning a new Python process for each command (3-5 seconds),
 * we send JSON commands to a persistent daemon (~50ms response time).
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { app } = require('electron');

// Get correct path for Python script (dev vs production)
function getCastDaemonPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'cast-daemon.py')
    : path.join(__dirname, 'cast-daemon.py');
}

let daemonProcess = null;
let pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
let requestCounter = 0;
let isReady = false;
let isIntentionalShutdown = false; // STABILITY: Track if shutdown is intentional vs crash
let restartAttempts = 0; // Track restart attempts to prevent infinite loops
const MAX_RESTART_ATTEMPTS = 3;

// Response line buffer
let rl = null;

/**
 * Start the Cast daemon subprocess
 */
function startDaemon() {
  return new Promise((resolve, reject) => {
    if (daemonProcess) {
      console.log('[Daemon] Already running');
      resolve(true);
      return;
    }

    // Use pythonw on Windows (no console window), fallback to python
    const pythonPath = process.platform === 'win32' ? 'pythonw' : 'python';
    const scriptPath = getCastDaemonPath();

    console.log('[Daemon] Starting daemon...');

    daemonProcess = spawn(pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    // Read JSON responses from stdout
    rl = readline.createInterface({
      input: daemonProcess.stdout,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      try {
        const response = JSON.parse(line);

        // STABILITY: Match response to request by requestId (stereo mode reliability)
        // If response has requestId, use it. Otherwise fall back to FIFO (legacy).
        const responseId = response.requestId;

        if (responseId && pendingRequests.has(responseId)) {
          // Direct match by requestId - most reliable for stereo mode
          const { resolve, timeout } = pendingRequests.get(responseId);
          clearTimeout(timeout);
          pendingRequests.delete(responseId);
          resolve(response);
        } else {
          // Fallback: FIFO order (legacy daemon without requestId support)
          const entries = Array.from(pendingRequests.entries());
          if (entries.length > 0) {
            const [requestId, { resolve, timeout }] = entries[0];
            clearTimeout(timeout);
            pendingRequests.delete(requestId);
            resolve(response);
          }
        }
      } catch (e) {
        console.error('[Daemon] Invalid JSON response:', line);
      }
    });

    // Log stderr (daemon logs)
    daemonProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log('[Daemon]', msg);
      }
    });

    daemonProcess.on('error', (err) => {
      console.error('[Daemon] Process error:', err.message);
      daemonProcess = null;
      isReady = false;
      reject(err);
    });

    daemonProcess.on('exit', (code, signal) => {
      console.log(`[Daemon] Process exited with code ${code}, signal ${signal}`);
      daemonProcess = null;
      isReady = false;

      // Reject all pending requests
      for (const [, { reject, timeout }] of pendingRequests) {
        clearTimeout(timeout);
        reject(new Error('Daemon exited'));
      }
      pendingRequests.clear();

      // STABILITY: Auto-restart on unexpected exit (not intentional shutdown)
      if (!isIntentionalShutdown && code !== 0 && restartAttempts < MAX_RESTART_ATTEMPTS) {
        restartAttempts++;
        console.log(`[Daemon] Unexpected exit, auto-restarting (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
        setTimeout(() => {
          startDaemon().catch(err => {
            console.error('[Daemon] Auto-restart failed:', err.message);
          });
        }, 1000 * restartAttempts); // Exponential backoff: 1s, 2s, 3s
      } else if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        console.error('[Daemon] Max restart attempts reached, giving up');
      }
    });

    // Wait a moment for daemon to start
    setTimeout(() => {
      if (daemonProcess) {
        isReady = true;
        isIntentionalShutdown = false; // Reset for new daemon instance
        restartAttempts = 0; // Reset restart counter on successful start
        console.log('[Daemon] Ready for commands');
        resolve(true);
      }
    }, 500);
  });
}

/**
 * Stop the Cast daemon
 */
function stopDaemon() {
  return new Promise((resolve) => {
    isIntentionalShutdown = true; // STABILITY: Mark as intentional to prevent auto-restart

    if (!daemonProcess) {
      resolve(true);
      return;
    }

    console.log('[Daemon] Stopping...');

    // Send quit command
    sendCommand({ cmd: 'quit' })
      .catch(() => {})
      .finally(() => {
        // Force kill if still running after 2 seconds
        setTimeout(() => {
          if (daemonProcess) {
            daemonProcess.kill();
            daemonProcess = null;
          }
          isReady = false;
          resolve(true);
        }, 2000);
      });
  });
}

/**
 * Send a command to the daemon
 */
function sendCommand(cmd, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!daemonProcess || !isReady) {
      reject(new Error('Daemon not running'));
      return;
    }

    const requestId = ++requestCounter;

    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Daemon request timeout'));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timeout });

    // STABILITY: Include requestId for response correlation (stereo mode reliability)
    const cmdWithId = { ...cmd, requestId };

    // Send command as JSON line
    daemonProcess.stdin.write(JSON.stringify(cmdWithId) + '\n');
  });
}


/**
 * Set volume on speaker (FAST - uses cached connection)
 */
async function setVolumeFast(speakerName, volume, speakerIp = null) {
  if (!isReady) {
    await startDaemon();
  }

  return sendCommand({
    cmd: 'set-volume',
    speaker: speakerName,
    volume: volume,
    ip: speakerIp
  }, 3000); // 3 second timeout
}

/**
 * Get volume from speaker
 */
async function getVolumeFast(speakerName, speakerIp = null) {
  if (!isReady) {
    await startDaemon();
  }

  return sendCommand({
    cmd: 'get-volume',
    speaker: speakerName,
    ip: speakerIp
  }, 3000);
}

/**
 * Ping speaker (play test sound)
 */
async function pingSpeaker(speakerName, speakerIp = null) {
  if (!isReady) {
    await startDaemon();
  }

  return sendCommand({
    cmd: 'ping',
    speaker: speakerName,
    ip: speakerIp
  }, 10000); // 10 second timeout for ping (includes audio playback)
}

/**
 * Pre-connect to speaker (warms up the connection)
 */
async function connectSpeaker(speakerName, speakerIp = null) {
  if (!isReady) {
    await startDaemon();
  }

  return sendCommand({
    cmd: 'connect',
    speaker: speakerName,
    ip: speakerIp
  }, 10000);
}

/**
 * Disconnect from speaker
 */
async function disconnectSpeaker(speakerName) {
  if (!isReady) {
    return { success: true };
  }

  return sendCommand({
    cmd: 'disconnect',
    speaker: speakerName
  }, 3000);
}

/**
 * Get daemon status
 */
async function getDaemonStatus() {
  if (!isReady) {
    return { success: true, running: false, connections: [] };
  }

  return sendCommand({ cmd: 'status' }, 2000);
}

/**
 * Check if daemon is running
 */
function isDaemonRunning() {
  return daemonProcess !== null && isReady;
}

module.exports = {
  startDaemon,
  stopDaemon,
  setVolumeFast,
  getVolumeFast,
  pingSpeaker,
  connectSpeaker,
  disconnectSpeaker,
  getDaemonStatus,
  isDaemonRunning
};
