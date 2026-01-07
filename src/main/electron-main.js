/**
 * PC Nest Speaker - Main Process
 * Nice Electron UI + Python pychromecast for actual casting (it works with Nest!)
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { AudioStreamer } = require('./audio-streamer');
const audioDeviceManager = require('./audio-device-manager');
const { StreamStats } = require('./stream-stats');
const settingsManager = require('./settings-manager');
const autoStartManager = require('./auto-start-manager');
const trayManager = require('./tray-manager');
const usageTracker = require('./usage-tracker');
const volumeSync = require('./windows-volume-sync');
const daemonManager = require('./daemon-manager');
const audioSyncManager = require('./audio-sync-manager');

// Keep global references
let mainWindow = null;
let audioStreamer = null;
let streamStats = null;
let pythonCastProcess = null;
let webrtcStreamerProcess = null;
let localTunnelProcess = null;
let currentStreamingMode = null;
let tunnelUrl = null;
let discoveredSpeakers = []; // Cache speakers with IPs from discovery

// Dependency download URLs
const DEPENDENCY_URLS = {
  'VB-CABLE': 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip',
  'screen-capture-recorder': 'https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases/download/v0.13.3/Setup.Screen.Capturer.Recorder.v0.13.3.exe'
};

// Bundled MediaMTX path (replaces webrtc-streamer for WebRTC streaming)
// In dev: mediamtx/ folder in project root
// In production: resources/mediamtx/ in the app package
// NOTE: These are functions to defer app.isPackaged check until app is ready
function getMediaMTXPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mediamtx', 'mediamtx.exe')
    : path.join(__dirname, '../../mediamtx/mediamtx.exe');
}
function getMediaMTXConfig() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mediamtx', 'mediamtx-audio.yml')
    : path.join(__dirname, '../../mediamtx/mediamtx-audio.yml');
}

// MediaMTX process reference
let mediamtxProcess = null;
let ffmpegWebrtcProcess = null;

// Background WebRTC pipeline status
let webrtcPipelineReady = false;
let webrtcPipelineError = null;

// TEST: Disable CloudFlare to see if local IP works
const DISABLE_CLOUDFLARE = true;

// Helper: Get local IP address
function getLocalIp() {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();

  for (const interfaceName in networkInterfaces) {
    for (const iface of networkInterfaces[interfaceName]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.')) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Helper: Get FFmpeg path from AudioStreamer
function getFFmpegPath() {
  if (!audioStreamer) {
    audioStreamer = new AudioStreamer();
  }
  return audioStreamer.getFFmpegPath();
}

// Kill any leftover processes from previous runs (called on startup)
function killLeftoverProcesses() {
  console.log('[Main] Killing any leftover processes...');

  if (process.platform === 'win32') {
    try {
      // Kill any existing MediaMTX processes
      execSync('taskkill /F /IM mediamtx.exe 2>nul', { stdio: 'ignore', windowsHide: true });
      console.log('[Main] Killed leftover mediamtx');
    } catch (e) {
      // Process not running - that's fine
    }

    try {
      // Kill any localtunnel processes
      execSync('taskkill /F /IM lt.exe 2>nul', { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      // Process not running - that's fine
    }

    try {
      // Kill any cloudflared processes
      execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      // Process not running - that's fine
    }
  }
}

// Send log to renderer (with error handling for EPIPE)
function sendLog(message, type = 'info') {
  console.log(`[Main] ${message}`);
  try {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('log', message, type);
    }
  } catch (err) {
    // Ignore EPIPE errors when renderer is disconnected
    if (err.code !== 'EPIPE') {
      console.error('[Main] sendLog error:', err.message);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 780,
    minWidth: 420,
    minHeight: 650,
    resizable: true,
    frame: true,
    backgroundColor: '#0A0908',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Initialize stream stats
  streamStats = new StreamStats();

  // Send stats updates to renderer every 100ms
  streamStats.addListener((stats) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('stream-stats', stats);
    }
  });

  // Minimize to tray instead of close (unless quitting)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      trayManager.onWindowVisibilityChange();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanup();
  });

  // Update tray menu when window visibility changes
  mainWindow.on('show', () => {
    trayManager.onWindowVisibilityChange();
  });

  mainWindow.on('hide', () => {
    trayManager.onWindowVisibilityChange();
  });
}

function cleanup() {
  sendLog('Cleaning up all processes...');
  trayManager.updateTrayState(false); // Update tray to idle state
  usageTracker.stopTracking(); // Stop tracking usage time
  volumeSync.stopMonitoring(); // Stop Windows volume sync

  // Stop audio streamer (HTTP mode)
  if (audioStreamer) {
    audioStreamer.stop();
    audioStreamer = null;
  }

  // Stop Python cast process
  if (pythonCastProcess) {
    pythonCastProcess.kill();
    pythonCastProcess = null;
  }

  // Stop FFmpeg WebRTC publishing process
  if (ffmpegWebrtcProcess) {
    sendLog('Stopping FFmpeg WebRTC stream...');
    try {
      ffmpegWebrtcProcess.kill();
    } catch (e) {
      // Process may already be dead
    }
    ffmpegWebrtcProcess = null;
  }

  // Stop MediaMTX (WebRTC mode)
  sendLog('Stopping MediaMTX...');
  if (mediamtxProcess) {
    try {
      mediamtxProcess.kill();
    } catch (e) {
      // Process may already be dead
    }
    mediamtxProcess = null;
  }
  // Also force kill by name in case process handle is lost
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM mediamtx.exe', { stdio: 'ignore', windowsHide: true });
    }
  } catch (e) {
    // Process may already be dead
  }

  // Stop localtunnel
  if (localTunnelProcess) {
    sendLog('Stopping localtunnel...');
    try {
      localTunnelProcess.kill();
    } catch (e) {
      // Process may already be dead
    }
    localTunnelProcess = null;
    tunnelUrl = null;
  }

  // Restore original Windows audio device
  try {
    audioDeviceManager.restoreOriginalDevice().catch(() => {
      // Ignore errors on cleanup
    });
  } catch (e) {
    // Ignore errors on cleanup
  }

  currentStreamingMode = null;
  sendLog('Cleanup complete');
}

// Check if an audio device exists (VB-CABLE, virtual-audio-capturer)
async function checkAudioDeviceExists(deviceKeyword) {
  try {
    if (!audioStreamer) {
      audioStreamer = new AudioStreamer();
    }
    const devices = await audioStreamer.getAudioDevices();
    return devices.some(d => d.toLowerCase().includes(deviceKeyword.toLowerCase()));
  } catch (e) {
    return false;
  }
}

// Check all dependencies
async function checkAllDependencies() {
  const deps = {
    vbcable: false,
    screenCapture: false,
    mediamtx: false,
    ffmpeg: true // Assume bundled FFmpeg is always available
  };

  // Check VB-CABLE
  deps.vbcable = await checkAudioDeviceExists('cable output');

  // Check screen-capture-recorder (virtual-audio-capturer)
  deps.screenCapture = await checkAudioDeviceExists('virtual-audio-capturer');

  // Check MediaMTX (bundled - replaces webrtc-streamer)
  deps.mediamtx = fs.existsSync(getMediaMTXPath());

  return deps;
}

// Start MediaMTX server (replaces webrtc-streamer)
async function startMediaMTX() {
  if (mediamtxProcess) {
    sendLog('MediaMTX already running');
    return true;
  }

  if (!fs.existsSync(getMediaMTXPath())) {
    throw new Error('MediaMTX not found. Please reinstall the app.');
  }

  sendLog('Starting MediaMTX server...');

  return new Promise((resolve, reject) => {
    // Launch MediaMTX with our custom config
    const mtxPath = getMediaMTXPath();
    mediamtxProcess = spawn(mtxPath, [getMediaMTXConfig()], {
      cwd: path.dirname(mtxPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    mediamtxProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) sendLog(`[MediaMTX] ${msg}`);
    });

    mediamtxProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) sendLog(`[MediaMTX] ${msg}`);
    });

    mediamtxProcess.on('error', (err) => {
      sendLog(`MediaMTX launch error: ${err.message}`, 'error');
      mediamtxProcess = null;
      reject(err);
    });

    mediamtxProcess.on('close', (code) => {
      sendLog(`MediaMTX exited with code ${code}`);
      mediamtxProcess = null;
    });

    // Poll the API to check if server is ready
    let attempts = 0;
    const maxAttempts = 20;

    const checkServer = () => {
      attempts++;
      const http = require('http');

      const req = http.get('http://localhost:9997/v3/paths/list', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            sendLog('[MediaMTX] Server ready!', 'success');
            resolve(true);
          } else if (attempts < maxAttempts) {
            setTimeout(checkServer, 500);
          }
        });
      });

      req.on('error', (e) => {
        if (attempts < maxAttempts) {
          setTimeout(checkServer, 500);
        } else {
          sendLog(`MediaMTX failed to start after ${maxAttempts} attempts`, 'error');
          reject(new Error('MediaMTX failed to start'));
        }
      });

      req.setTimeout(2000, () => {
        req.destroy();
        if (attempts < maxAttempts) {
          setTimeout(checkServer, 500);
        }
      });
    };

    // Start polling after a short delay
    setTimeout(checkServer, 1000);
  });
}

// Start FFmpeg to publish audio to MediaMTX via RTSP
async function startFFmpegWebRTC(audioDevice) {
  if (ffmpegWebrtcProcess) {
    sendLog('FFmpeg WebRTC stream already running');
    return true;
  }

  if (!audioStreamer) {
    audioStreamer = new AudioStreamer();
  }

  sendLog(`Starting FFmpeg RTSP stream with device: ${audioDevice}...`);

  return new Promise((resolve, reject) => {
    // FFmpeg command to capture audio via DirectShow and publish to MediaMTX RTSP
    // Using Opus codec for WebRTC compatibility
    const ffmpegPath = audioStreamer.getFFmpegPath();

    // Check if volume boost is enabled
    const volumeBoostEnabled = settingsManager.getSetting('volumeBoost');

    // Secret sauce: Always boost by 3% (Windows doesn't know)
    // Boost toggle: 25% increase
    const boostLevel = volumeBoostEnabled ? 1.25 : 1.03;

    const args = [
      '-hide_banner',
      '-stats',  // Force progress output for stream monitor
      '-f', 'dshow',
      '-i', `audio=${audioDevice}`,
      '-af', `volume=${boostLevel}`  // Always apply volume filter
    ];

    if (volumeBoostEnabled) {
      sendLog('[FFmpeg] Volume boost enabled (2.15x signal)');
    }

    // Add output settings
    args.push(
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      'rtsp://localhost:8554/pcaudio'
    );

    sendLog(`[FFmpeg] ${ffmpegPath} ${args.join(' ')}`);

    ffmpegWebrtcProcess = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      shell: false
    });

    ffmpegWebrtcProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) sendLog(`[FFmpeg] ${msg}`);
    });

    ffmpegWebrtcProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // FFmpeg outputs progress to stderr
      // Parse for stream stats
      if (streamStats) {
        streamStats.parseFfmpegOutput(msg);
      }
      // Log ALL FFmpeg output for debugging stream monitor
      if (msg) {
        // Check if this is stats output we should be parsing
        if (msg.includes('size=') || msg.includes('time=') || msg.includes('bitrate=')) {
          sendLog(`[FFmpeg STATS] ${msg}`);
        } else if (!msg.includes('frame=')) {
          sendLog(`[FFmpeg] ${msg}`);
        }
      }
    });

    ffmpegWebrtcProcess.on('error', (err) => {
      sendLog(`FFmpeg launch error: ${err.message}`, 'error');
      ffmpegWebrtcProcess = null;
      reject(err);
    });

    ffmpegWebrtcProcess.on('close', (code) => {
      sendLog(`FFmpeg exited with code ${code}`);
      ffmpegWebrtcProcess = null;
    });

    // Give FFmpeg a moment to start publishing
    setTimeout(() => {
      if (ffmpegWebrtcProcess) {
        sendLog('[FFmpeg] Audio stream publishing to MediaMTX', 'success');
        resolve(true);
      } else {
        reject(new Error('FFmpeg failed to start'));
      }
    }, 2000);
  });
}

// Find cloudflared executable
function findCloudflared() {
  const possiblePaths = [
    'cloudflared', // If in PATH
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cloudflared', 'cloudflared.exe'),
  ];

  for (const p of possiblePaths) {
    try {
      if (p === 'cloudflared') {
        // Check if in PATH
        execSync('where cloudflared', { stdio: 'ignore', windowsHide: true });
        return 'cloudflared';
      } else if (fs.existsSync(p)) {
        return p;
      }
    } catch (e) {
      // Not found, continue
    }
  }
  return null;
}

// Start cloudflared tunnel for HTTPS (replaces localtunnel - no interstitial page)
async function startLocalTunnel(port = 8443) {
  if (localTunnelProcess && tunnelUrl) {
    sendLog(`Tunnel already running at ${tunnelUrl}`);
    return tunnelUrl;
  }

  // First try cloudflared (more reliable, no interstitial)
  const cloudflaredPath = findCloudflared();

  if (cloudflaredPath) {
    sendLog('Starting cloudflared tunnel (no interstitial)...');

    return new Promise((resolve, reject) => {
      localTunnelProcess = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      // Cloudflared outputs to stderr
      localTunnelProcess.stderr.on('data', (data) => {
        const msg = data.toString();

        // Parse URL from cloudflared output
        // Format: "https://xxx-xxx-xxx.trycloudflare.com"
        const urlMatch = msg.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i);
        if (urlMatch && !tunnelUrl) {
          tunnelUrl = urlMatch[1];
          sendLog(`Cloudflare tunnel URL: ${tunnelUrl}`, 'success');
          resolve(tunnelUrl);
        }

        // Log important messages
        if (msg.includes('Your quick Tunnel') || msg.includes('trycloudflare.com') || msg.includes('ERR')) {
          sendLog(`[cloudflared] ${msg.trim()}`);
        }
      });

      localTunnelProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) sendLog(`[cloudflared] ${msg}`);
      });

      localTunnelProcess.on('error', (err) => {
        sendLog(`cloudflared error: ${err.message}`, 'error');
        localTunnelProcess = null;
        // Fallback to localtunnel
        startLocalTunnelFallback(port).then(resolve).catch(reject);
      });

      localTunnelProcess.on('close', (code) => {
        sendLog(`cloudflared exited with code ${code}`);
        localTunnelProcess = null;
        tunnelUrl = null;
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!tunnelUrl) {
          // Fallback to localtunnel
          sendLog('cloudflared timed out, trying localtunnel...', 'warn');
          if (localTunnelProcess) {
            localTunnelProcess.kill();
            localTunnelProcess = null;
          }
          startLocalTunnelFallback(port).then(resolve).catch(reject);
        }
      }, 30000);
    });
  } else {
    sendLog('cloudflared not found, using localtunnel...', 'warn');
    return startLocalTunnelFallback(port);
  }
}

// Fallback to localtunnel if cloudflared is not available
async function startLocalTunnelFallback(port = 8443) {
  sendLog('Starting localtunnel for HTTPS (may have interstitial)...');

  return new Promise((resolve, reject) => {
    localTunnelProcess = spawn('npx', ['localtunnel', '--port', port.toString()], {
      shell: true,
      cwd: path.join(__dirname, '../..'),
      windowsHide: true
    });

    localTunnelProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      sendLog(`[localtunnel] ${msg.trim()}`);

      // Parse URL from output
      const urlMatch = msg.match(/your url is: (https:\/\/[^\s]+)/i);
      if (urlMatch) {
        tunnelUrl = urlMatch[1];
        sendLog(`Tunnel URL: ${tunnelUrl}`, 'success');
        resolve(tunnelUrl);
      }
    });

    localTunnelProcess.stderr.on('data', (data) => {
      sendLog(`[localtunnel] ${data.toString().trim()}`);
    });

    localTunnelProcess.on('error', (err) => {
      sendLog(`localtunnel error: ${err.message}`, 'error');
      localTunnelProcess = null;
      reject(err);
    });

    localTunnelProcess.on('close', (code) => {
      sendLog(`localtunnel exited with code ${code}`);
      localTunnelProcess = null;
      tunnelUrl = null;
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!tunnelUrl) {
        reject(new Error('Tunnel startup timed out'));
      }
    }, 30000);
  });
}

// Auto-discover speakers on startup
async function autoDiscoverDevices() {
  sendLog('Auto-discovering speakers and audio devices...');

  try {
    // Initialize audio streamer
    if (!audioStreamer) {
      audioStreamer = new AudioStreamer();
    }

    // Discover speakers in background
    sendLog('Scanning for Chromecast/Nest speakers...');
    const speakerResult = await runPython(['discover']);
    if (speakerResult.success && speakerResult.speakers) {
      discoveredSpeakers = speakerResult.speakers;
      sendLog(`Found ${speakerResult.speakers.length} speakers`, 'success');

      // Send to renderer
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('speakers-discovered', speakerResult.speakers);
      }
    }

    // Discover audio devices
    const audioDevices = await audioStreamer.getAudioDevices();
    sendLog(`Found ${audioDevices.length} audio devices`);

    // Send to renderer
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('audio-devices-discovered', audioDevices);
    }

  } catch (error) {
    sendLog(`Auto-discovery failed: ${error.message}`, 'error');
  }
}

// Pre-start WebRTC pipeline in background (runs on app startup)
// This starts MediaMTX, FFmpeg, and localtunnel so streaming starts instantly
async function preStartWebRTCPipeline() {
  sendLog('Pre-starting WebRTC pipeline in background...');

  try {
    // Find the best audio device
    if (!audioStreamer) {
      audioStreamer = new AudioStreamer();
    }

    const devices = await audioStreamer.getAudioDevices();
    let audioDevice = 'virtual-audio-capturer';

    // Prefer virtual-audio-capturer, fallback to VB-CABLE
    const vacDevice = devices.find(d => d.toLowerCase().includes('virtual-audio-capturer'));
    if (vacDevice) {
      audioDevice = vacDevice;
    } else {
      const vbDevice = devices.find(d => d.toLowerCase().includes('cable output'));
      if (vbDevice) {
        audioDevice = vbDevice;
      }
    }

    sendLog(`[Background] Using audio device: ${audioDevice}`);

    // Step 1: Start MediaMTX
    await startMediaMTX();
    sendLog('[Background] MediaMTX ready', 'success');

    // Step 2: Start FFmpeg
    await startFFmpegWebRTC(audioDevice);
    sendLog('[Background] FFmpeg publishing', 'success');

    // Step 3: Start tunnel (or use local IP if disabled)
    let url;
    if (DISABLE_CLOUDFLARE) {
      // Get local IP address
      const os = require('os');
      const networkInterfaces = os.networkInterfaces();
      let localIP = 'localhost';

      for (const interfaceName in networkInterfaces) {
        for (const iface of networkInterfaces[interfaceName]) {
          if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.')) {
            localIP = iface.address;
            break;
          }
        }
      }

      url = `http://${localIP}:8889`;
      sendLog(`[Background] Using local IP: ${url} (CloudFlare disabled)`, 'success');
    } else {
      url = await startLocalTunnel(8889);
      sendLog(`[Background] Tunnel ready: ${url}`, 'success');
    }

    webrtcPipelineReady = true;
    webrtcPipelineError = null;
    tunnelUrl = url;
    sendLog('WebRTC pipeline ready! Select a speaker and click "Start".', 'success');

  } catch (error) {
    webrtcPipelineReady = false;
    webrtcPipelineError = error.message;
    sendLog(`[Background] Pipeline failed: ${error.message}`, 'error');
  }
}

// Run Python cast-helper script
function runPython(args) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'cast-helper.py');
    const python = spawn('python', [scriptPath, ...args], { windowsHide: true });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log Python's progress messages
      const msg = data.toString().trim();
      if (msg) sendLog(`[Python] ${msg}`);
    });

    python.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${stdout}`));
        }
      } else {
        reject(new Error(stderr || `Python exited with code ${code}`));
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Python not found: ${err.message}`));
    });
  });
}

// IPC Handlers

// Discover both audio devices AND Chromecast speakers
ipcMain.handle('discover-devices', async () => {
  try {
    sendLog('Starting discovery...');

    if (!audioStreamer) {
      audioStreamer = new AudioStreamer();
    }

    // Get audio devices from FFmpeg
    sendLog('Finding audio devices...');
    const audioDevices = await audioStreamer.getAudioDevices();
    sendLog(`Found ${audioDevices.length} audio devices`, 'success');

    // Get speakers from Python pychromecast
    sendLog('Scanning for Chromecast/Nest speakers...');
    const result = await runPython(['discover']);

    if (result.success) {
      sendLog(`Found ${result.speakers.length} speakers`, 'success');
      // Cache speakers with their IPs for later use
      discoveredSpeakers = result.speakers;
      return {
        success: true,
        audioDevices,
        speakers: result.speakers
      };
    } else {
      sendLog(`Speaker discovery failed: ${result.error}`, 'error');
      return {
        success: true,
        audioDevices,
        speakers: [],
        warning: result.error
      };
    }
  } catch (error) {
    sendLog(`Discovery failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Start streaming to a speaker
ipcMain.handle('start-streaming', async (event, speakerName, audioDevice, streamingMode = 'http') => {
  try {
    // Check if trial has expired
    if (usageTracker.isTrialExpired()) {
      const usage = usageTracker.getUsage();
      return {
        success: false,
        error: 'Trial expired',
        trialExpired: true,
        usageInfo: usage
      };
    }

    sendLog(`Starting ${streamingMode} stream to "${speakerName}"...`);
    currentStreamingMode = streamingMode;

    // Switch Windows default audio to virtual device
    try {
      sendLog('Switching Windows audio to virtual device...');
      await audioDeviceManager.switchToStreamingDevice();
      sendLog('Audio device switched', 'success');
    } catch (err) {
      sendLog(`Audio switch failed: ${err.message}`, 'warning');
      // Continue anyway - user may have already set it manually
    }

    if (streamingMode === 'http') {
      // HTTP MP3 streaming mode
      if (!audioStreamer) {
        audioStreamer = new AudioStreamer();
      }

      sendLog(`Audio source: ${audioDevice}`);
      const streamUrl = await audioStreamer.start(audioDevice, 'mp3');
      sendLog(`Stream URL: ${streamUrl}`, 'success');

      // Cast to speaker using Python
      sendLog(`Casting to ${speakerName}...`);
      const result = await runPython(['cast', speakerName, streamUrl, 'audio/mpeg']);

      if (result.success) {
        sendLog('HTTP streaming started!', 'success');
        trayManager.updateTrayState(true); // Update tray to streaming state
        usageTracker.startTracking(); // Start tracking usage time

        // Start Windows volume sync - PC volume keys will control Nest
        const speaker = discoveredSpeakers.find(s => s.name === speakerName);
        if (speaker) {
          volumeSync.startMonitoring(
            [{ name: speaker.name, ip: speaker.ip }],
            (volume) => {
              // If boost is enabled, don't sync - speaker stays at 100%
              if (settingsManager.getSetting('volumeBoost')) {
                return; // Skip sync when boost is on
              }
              sendLog(`[VolumeSync] Windows volume: ${volume}%`);
              // Use daemon for instant volume control
              if (daemonManager.isDaemonRunning()) {
                daemonManager.setVolumeFast(speaker.name, volume / 100, speaker.ip || null).catch(() => {});
              } else {
                runPython(['set-volume-fast', speaker.name, (volume / 100).toString(), speaker.ip || '']).catch(() => {});
              }
            }
          );

          // INITIAL SYNC: Set speaker to current Windows volume immediately (unless boost is ON)
          if (!settingsManager.getSetting('volumeBoost')) {
            volumeSync.getWindowsVolume().then((volume) => {
              sendLog(`[VolumeSync] Initial sync: Setting speaker to ${volume}%`);
              if (daemonManager.isDaemonRunning()) {
                daemonManager.setVolumeFast(speaker.name, volume / 100, speaker.ip || null).catch(() => {});
              } else {
                runPython(['set-volume-fast', speaker.name, (volume / 100).toString(), speaker.ip || '']).catch(() => {});
              }
            }).catch(() => {});
          }
        }

        return { success: true, url: streamUrl };
      } else {
        await audioStreamer.stop();
        throw new Error(result.error);
      }

    } else if (streamingMode === 'webrtc-system' || streamingMode === 'webrtc-vbcable') {
      // WebRTC streaming modes using MediaMTX
      // Pipeline: FFmpeg (DirectShow) -> RTSP -> MediaMTX -> WebRTC -> Cast Receiver

      let httpsUrl = tunnelUrl; // Use pre-started tunnel if available

      // Check if pipeline was pre-started in background
      if (webrtcPipelineReady && mediamtxProcess && ffmpegWebrtcProcess && tunnelUrl) {
        sendLog('Using pre-started WebRTC pipeline (instant start!)', 'success');
        httpsUrl = tunnelUrl;
        // Start stream stats monitoring (even for pre-started pipeline)
        if (streamStats) {
          streamStats.start();
        }
      } else {
        // Pipeline not ready - start it now
        sendLog('Starting WebRTC pipeline...');

        // Determine audio device name for FFmpeg
        let audioDeviceName = 'virtual-audio-capturer'; // Default for system audio

        if (streamingMode === 'webrtc-vbcable') {
          audioDeviceName = 'CABLE Output (VB-Audio Virtual Cable)';
        } else {
          // For system audio mode, use virtual-audio-capturer from screen-capture-recorder
          if (!audioStreamer) {
            audioStreamer = new AudioStreamer();
          }
          const devices = await audioStreamer.getAudioDevices();
          const vacDevice = devices.find(d =>
            d.toLowerCase().includes('virtual-audio-capturer')
          );
          if (vacDevice) {
            audioDeviceName = vacDevice;
          }
        }

        sendLog(`Using audio device: ${audioDeviceName}`);

        // Step 1: Start MediaMTX server
        await startMediaMTX();
        sendLog('MediaMTX server started', 'success');

        // Step 2: Start FFmpeg to publish audio to MediaMTX via RTSP
        await startFFmpegWebRTC(audioDeviceName);
        sendLog('FFmpeg publishing to MediaMTX', 'success');

        // Start stream stats monitoring
        if (streamStats) {
          streamStats.start();
        }

        // Step 3: Start localtunnel for HTTPS (Cast requires HTTPS)
        // MediaMTX WebRTC endpoint is on port 8889
        httpsUrl = await startLocalTunnel(8889);
        sendLog(`HTTPS tunnel ready: ${httpsUrl}`, 'success');
      }

      // Step 4: Launch custom receiver on Cast device
      // The receiver will connect to MediaMTX WebRTC endpoint via WHEP
      const speaker = discoveredSpeakers.find(s => s.name === speakerName);
      const speakerIp = speaker ? speaker.ip : null;

      sendLog(`Launching WebRTC receiver on ${speakerName}${speakerIp ? ` (${speakerIp})` : ''}...`);
      const args = ['webrtc-launch', speakerName, httpsUrl];
      if (speakerIp) args.push(speakerIp);
      const result = await runPython(args);

      if (result.success) {
        sendLog('WebRTC streaming started! (via MediaMTX)', 'success');
        trayManager.updateTrayState(true); // Update tray to streaming state
        usageTracker.startTracking(); // Start tracking usage time

        // Start Windows volume sync - PC volume keys will control Nest
        if (speaker) {
          volumeSync.startMonitoring(
            [{ name: speaker.name, ip: speaker.ip }],
            (volume) => {
              // If boost is enabled, don't sync - speaker stays at 100%
              if (settingsManager.getSetting('volumeBoost')) {
                return; // Skip sync when boost is on
              }
              sendLog(`[VolumeSync] Windows volume: ${volume}%`);
              // Use daemon for instant volume control
              if (daemonManager.isDaemonRunning()) {
                daemonManager.setVolumeFast(speaker.name, volume / 100, speaker.ip || null).catch(() => {});
              } else {
                runPython(['set-volume-fast', speaker.name, (volume / 100).toString(), speaker.ip || '']).catch(() => {});
              }
            }
          );

          // INITIAL SYNC: Set speaker to current Windows volume immediately (unless boost is ON)
          if (!settingsManager.getSetting('volumeBoost')) {
            volumeSync.getWindowsVolume().then((volume) => {
              sendLog(`[VolumeSync] Initial sync: Setting speaker to ${volume}%`);
              if (daemonManager.isDaemonRunning()) {
                daemonManager.setVolumeFast(speaker.name, volume / 100, speaker.ip || null).catch(() => {});
              } else {
                runPython(['set-volume-fast', speaker.name, (volume / 100).toString(), speaker.ip || '']).catch(() => {});
              }
            }).catch(() => {});
          }
        }

        return { success: true, url: httpsUrl, mode: streamingMode };
      } else if (result.error_code === 'CUSTOM_RECEIVER_NOT_SUPPORTED') {
        // Custom receiver not supported - automatically fallback to HTTP streaming
        sendLog('Custom receiver not supported on this device', 'warning');
        sendLog('Automatically falling back to HTTP streaming...', 'info');

        // Stop WebRTC services
        if (ffmpegWebrtcProcess) {
          try { ffmpegWebrtcProcess.kill(); } catch (e) {}
          ffmpegWebrtcProcess = null;
        }

        // Start HTTP streaming instead
        if (!audioStreamer) {
          audioStreamer = new AudioStreamer();
        }

        sendLog(`Audio source: ${audioDevice || 'virtual-audio-capturer'}`);
        const streamUrl = await audioStreamer.start(audioDevice || 'virtual-audio-capturer', 'mp3');
        sendLog(`Stream URL: ${streamUrl}`, 'success');

        // Cast to speaker using default receiver
        sendLog(`Casting via HTTP (fallback) to ${speakerName}...`);
        const httpResult = await runPython(['cast', speakerName, streamUrl, 'audio/mpeg']);

        if (httpResult.success) {
          sendLog('HTTP streaming started! (automatic fallback)', 'success');
          currentStreamingMode = 'http';
          trayManager.updateTrayState(true); // Update tray to streaming state
          usageTracker.startTracking(); // Start tracking usage time

          // Start Windows volume sync - PC volume keys will control Nest
          if (speaker) {
            volumeSync.startMonitoring(
              [{ name: speaker.name, ip: speaker.ip }],
              (volume) => {
                // If boost is enabled, don't sync - speaker stays at 100%
                if (settingsManager.getSetting('volumeBoost')) {
                  return; // Skip sync when boost is on
                }
                sendLog(`[VolumeSync] Windows volume: ${volume}%`);
                // Use daemon for instant volume control
                if (daemonManager.isDaemonRunning()) {
                  daemonManager.setVolumeFast(speaker.name, volume / 100, speaker.ip || null).catch(() => {});
                } else {
                  runPython(['set-volume-fast', speaker.name, (volume / 100).toString(), speaker.ip || '']).catch(() => {});
                }
              }
            );
          }

          return { success: true, url: streamUrl, mode: 'http', fallback: true };
        } else {
          cleanup();
          throw new Error(`Fallback failed: ${httpResult.error}`);
        }
      } else {
        // Other errors
        cleanup();
        throw new Error(result.error);
      }

    } else {
      throw new Error(`Unknown streaming mode: ${streamingMode}`);
    }

  } catch (error) {
    sendLog(`Stream failed: ${error.message}`, 'error');
    cleanup();
    return { success: false, error: error.message };
  }
});

// Stop streaming - uses daemon for INSTANT disconnect
ipcMain.handle('stop-streaming', async (event, speakerName) => {
  try {
    sendLog('Stopping...');

    // Disconnect speaker (daemon is instant, fallback spawns Python)
    if (speakerName) {
      try {
        if (daemonManager.isDaemonRunning()) {
          await daemonManager.disconnectSpeaker(speakerName);
        } else {
          await runPython(['stop', speakerName]);
        }
      } catch (e) {
        // Ignore stop errors
      }
    }

    // Stop FFmpeg stream
    if (audioStreamer) {
      await audioStreamer.stop();
    }

    // Stop stream stats
    if (streamStats) {
      streamStats.stop();
    }

    // Stop Windows volume sync
    volumeSync.stopMonitoring();

    // Restore original Windows audio device
    try {
      sendLog('Restoring original audio device...');
      await audioDeviceManager.restoreOriginalDevice();
      sendLog('Audio device restored', 'success');
    } catch (err) {
      sendLog(`Audio restore failed: ${err.message}`, 'warning');
      // Continue anyway
    }

    sendLog('Stopped', 'success');
    trayManager.updateTrayState(false); // Update tray to idle state
    usageTracker.stopTracking(); // Stop tracking usage time
    return { success: true };
  } catch (error) {
    sendLog(`Stop error: ${error.message}`, 'error');
    trayManager.updateTrayState(false); // Update tray to idle state
    usageTracker.stopTracking(); // Stop tracking usage time
    return { success: false, error: error.message };
  }
});

// Get status
ipcMain.handle('get-status', () => {
  return {
    isStreaming: audioStreamer?.isStreaming || false,
    streamUrl: audioStreamer?.streamUrl || null,
  };
});

// Restart FFmpeg with new settings (for volume boost toggle)
ipcMain.handle('restart-ffmpeg', async () => {
  try {
    if (!ffmpegWebrtcProcess) {
      sendLog('FFmpeg not running, nothing to restart');
      return { success: false, error: 'Not streaming' };
    }

    const audioDevice = 'virtual-audio-capturer';
    sendLog('Restarting FFmpeg with new settings...');

    // Stop current FFmpeg (on Windows, SIGTERM doesn't work - just kill it)
    if (ffmpegWebrtcProcess) {
      try {
        ffmpegWebrtcProcess.kill();
      } catch (e) {
        // Process might already be dead
      }
      ffmpegWebrtcProcess = null;
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait for clean shutdown
    }

    // Start FFmpeg again (will pick up new volumeBoost setting)
    await startFFmpegWebRTC(audioDevice);
    sendLog('FFmpeg restarted', 'success');
    return { success: true };
  } catch (error) {
    sendLog(`FFmpeg restart failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Test ping to speaker (isolated test - no streaming)
ipcMain.handle('ping-speaker', async (event, speakerName) => {
  try {
    sendLog(`Pinging "${speakerName}"...`);
    const result = await runPython(['ping', speakerName]);

    if (result.success) {
      sendLog('Ping sent!', 'success');
      return { success: true };
    } else {
      sendLog(`Ping failed: ${result.error}`, 'error');
      return { success: false, error: result.error };
    }
  } catch (error) {
    sendLog(`Ping failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Get speaker volume - uses daemon for INSTANT response
ipcMain.handle('get-volume', async (event, speakerName) => {
  try {
    // Get speaker IP for faster daemon connection
    const speaker = discoveredSpeakers.find(s => s.name === speakerName);
    const speakerIp = speaker?.ip || null;

    // Use daemon for instant response (cached connection)
    if (daemonManager.isDaemonRunning()) {
      const result = await daemonManager.getVolumeFast(speakerName, speakerIp);
      if (result.success) {
        return {
          success: true,
          volume: result.volume,
          muted: result.muted
        };
      } else {
        return { success: false, error: result.error };
      }
    } else {
      // Fallback to spawning Python
      const result = await runPython(['get-volume', speakerName]);
      if (result.success) {
        return {
          success: true,
          volume: result.volume,
          muted: result.muted
        };
      } else {
        return { success: false, error: result.error };
      }
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Set speaker volume (0.0 - 1.0) - uses daemon for INSTANT response
ipcMain.handle('set-volume', async (event, speakerName, volume) => {
  try {
    // Find cached IP for this speaker
    const speaker = discoveredSpeakers.find(s => s.name === speakerName);
    const speakerIp = speaker ? speaker.ip : null;

    // Try daemon first (instant), fall back to spawning Python (slow)
    if (daemonManager.isDaemonRunning()) {
      const result = await daemonManager.setVolumeFast(speakerName, volume, speakerIp);
      if (result.success) {
        return { success: true, volume: result.volume };
      } else {
        return { success: false, error: result.error };
      }
    } else {
      // Fallback to spawning Python process
      const result = await runPython(['set-volume-fast', speakerName, volume.toString(), speakerIp || '']);
      if (result.success) {
        return { success: true, volume: result.volume };
      } else {
        return { success: false, error: result.error };
      }
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get usage statistics (trial tracking)
ipcMain.handle('get-usage', () => {
  return usageTracker.getUsage();
});

// Open external link
ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
});

// Check dependencies
ipcMain.handle('check-dependencies', async () => {
  try {
    sendLog('Checking dependencies...');
    const deps = await checkAllDependencies();
    sendLog(`VB-CABLE: ${deps.vbcable ? 'OK' : 'Missing'}`);
    sendLog(`screen-capture-recorder: ${deps.screenCapture ? 'OK' : 'Missing'}`);
    sendLog(`MediaMTX: ${deps.mediamtx ? 'OK' : 'Missing'}`);
    return deps;
  } catch (error) {
    sendLog(`Dependency check failed: ${error.message}`, 'error');
    return {
      vbcable: false,
      screenCapture: false,
      mediamtx: false,
      ffmpeg: true
    };
  }
});

// Install a dependency
ipcMain.handle('install-dependency', async (event, dep) => {
  try {
    sendLog(`Installing ${dep}...`);

    const url = DEPENDENCY_URLS[dep];
    if (!url) {
      throw new Error(`Unknown dependency: ${dep}`);
    }

    // Open download page in browser
    await shell.openExternal(url);
    sendLog(`Opened ${dep} download page. Please complete the installation.`, 'success');

    return { success: true, message: 'Download page opened. Please install manually.' };
  } catch (error) {
    sendLog(`Install failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// ===================
// WebRTC Low-Latency Mode
// ===================

// Launch custom receiver for WebRTC
ipcMain.handle('webrtc-launch', async (event, speakerName) => {
  try {
    sendLog(`[WebRTC] Launching receiver on "${speakerName}"...`);
    const result = await runPython(['webrtc-launch', speakerName]);

    if (result.success) {
      sendLog('[WebRTC] Custom receiver launched', 'success');
    } else {
      sendLog(`[WebRTC] Launch failed: ${result.error}`, 'error');
    }
    return result;
  } catch (error) {
    sendLog(`[WebRTC] Launch error: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Send WebRTC signaling message (SDP offer/answer, ICE candidates)
ipcMain.handle('webrtc-signal', async (event, speakerName, message) => {
  try {
    const messageType = message.type || 'unknown';
    sendLog(`[WebRTC] Signaling: ${messageType}`);

    // Pass message as JSON string to Python
    const messageJson = JSON.stringify(message);
    const result = await runPython(['webrtc-signal', speakerName, messageJson]);

    if (result.success) {
      if (result.response) {
        sendLog(`[WebRTC] Got response: ${result.response.type || 'data'}`, 'success');
      }
    } else {
      sendLog(`[WebRTC] Signal failed: ${result.error}`, 'error');
    }
    return result;
  } catch (error) {
    sendLog(`[WebRTC] Signal error: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Stereo separation streaming
let stereoFFmpegProcesses = { left: null, right: null };
let stereoCloudflared = null;

ipcMain.handle('start-stereo-streaming', async (event, leftSpeaker, rightSpeaker) => {
  try {
    sendLog(`Starting stereo separation: L="${leftSpeaker.name}", R="${rightSpeaker.name}"`);

    // Switch Windows default audio to virtual device
    try {
      sendLog('Switching Windows audio to virtual device...');
      await audioDeviceManager.switchToStreamingDevice();
      sendLog('Audio device switched', 'success');
    } catch (err) {
      sendLog(`Audio switch failed: ${err.message}`, 'warning');
      // Continue anyway - user may have already set it manually
    }

    // 1. Start MediaMTX (if not already running)
    if (!mediamtxProcess) {
      await startMediaMTX();
      await new Promise(r => setTimeout(r, 3000)); // Wait for MediaMTX to be ready
    }

    // 2. Start FFmpeg for LEFT channel
    sendLog('Starting FFmpeg LEFT channel...');
    const ffmpegPath = getFFmpegPath();

    // Check if volume boost is enabled (same values as main stream)
    const volumeBoostEnabled = settingsManager.getSetting('volumeBoost');
    const boostLevel = volumeBoostEnabled ? 1.25 : 1.03; // 3% hidden, 25% with boost

    stereoFFmpegProcesses.left = spawn(ffmpegPath, [
      '-hide_banner', '-stats',  // Force progress output for stream monitor
      '-f', 'dshow',
      '-i', 'audio=virtual-audio-capturer',
      '-af', `pan=mono|c0=c0,volume=${boostLevel}`,  // Extract left channel + boost
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '1',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      'rtsp://localhost:8554/left'
    ], { stdio: 'pipe', windowsHide: true });

    stereoFFmpegProcesses.left.stderr.on('data', (data) => {
      const msg = data.toString();
      // Parse for stream stats
      if (streamStats) {
        streamStats.parseFfmpegOutput(msg);
      }
      if (msg.includes('Error') || msg.includes('error')) {
        sendLog(`FFmpeg LEFT: ${msg}`, 'error');
      }
    });

    await new Promise(r => setTimeout(r, 1000));  // Reduced from 2s to 1s
    sendLog('LEFT channel streaming', 'success');

    // 3. Start FFmpeg for RIGHT channel
    sendLog('Starting FFmpeg RIGHT channel...');

    stereoFFmpegProcesses.right = spawn(ffmpegPath, [
      '-hide_banner', '-stats',  // Force progress output for stream monitor
      '-f', 'dshow',
      '-i', 'audio=virtual-audio-capturer',
      '-af', `pan=mono|c0=c1,volume=${boostLevel}`,  // Extract right channel + boost
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '1',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      'rtsp://localhost:8554/right'
    ], { stdio: 'pipe', windowsHide: true });

    stereoFFmpegProcesses.right.stderr.on('data', (data) => {
      const msg = data.toString();
      // Parse for stream stats (right channel contributes to total)
      if (streamStats) {
        streamStats.parseFfmpegOutput(msg);
      }
      if (msg.includes('Error') || msg.includes('error')) {
        sendLog(`FFmpeg RIGHT: ${msg}`, 'error');
      }
    });

    await new Promise(r => setTimeout(r, 1000));  // Reduced from 2s to 1s
    sendLog('RIGHT channel streaming', 'success');

    // Start stream stats monitoring (for stereo mode)
    if (streamStats) {
      streamStats.start();
    }

    // 4. Get local IP
    const localIp = getLocalIp();
    const webrtcUrl = `http://${localIp}:8889`;

    // 5. Cast to LEFT speaker
    sendLog(`Casting to LEFT speaker: "${leftSpeaker.name}"`);
    const leftResult = await runPython([
      'webrtc-launch',
      leftSpeaker.name,
      webrtcUrl,
      '', // No speaker_ip (use discovery)
      'left' // Stream name
    ]);

    if (!leftResult.success) {
      throw new Error(`Left speaker cast failed: ${leftResult.error}`);
    }
    sendLog(`LEFT speaker connected`, 'success');

    // 6. Cast to RIGHT speaker
    sendLog(`Casting to RIGHT speaker: "${rightSpeaker.name}"`);
    const rightResult = await runPython([
      'webrtc-launch',
      rightSpeaker.name,
      webrtcUrl,
      '', // No speaker_ip (use discovery)
      'right' // Stream name
    ]);

    if (!rightResult.success) {
      throw new Error(`Right speaker cast failed: ${rightResult.error}`);
    }
    sendLog(`RIGHT speaker connected`, 'success');

    sendLog('Stereo separation streaming active!', 'success');
    trayManager.updateTrayState(true); // Update tray to streaming state
    usageTracker.startTracking(); // Start tracking usage time

    // Start Windows volume sync - PC volume keys will control BOTH Nest speakers
    volumeSync.startMonitoring(
      [
        { name: leftSpeaker.name, ip: leftSpeaker.ip },
        { name: rightSpeaker.name, ip: rightSpeaker.ip }
      ],
      (volume) => {
        // If boost is enabled, don't sync - speakers stay at 100%
        if (settingsManager.getSetting('volumeBoost')) {
          return; // Skip sync when boost is on
        }
        sendLog(`[VolumeSync] Windows volume: ${volume}%`);
        // Set volume on both speakers in parallel using daemon for instant response
        const volumeLevel = volume / 100;
        if (daemonManager.isDaemonRunning()) {
          daemonManager.setVolumeFast(leftSpeaker.name, volumeLevel, leftSpeaker.ip || null).catch(() => {});
          daemonManager.setVolumeFast(rightSpeaker.name, volumeLevel, rightSpeaker.ip || null).catch(() => {});
        } else {
          const volumeStr = volumeLevel.toString();
          runPython(['set-volume-fast', leftSpeaker.name, volumeStr, leftSpeaker.ip || '']).catch(() => {});
          runPython(['set-volume-fast', rightSpeaker.name, volumeStr, rightSpeaker.ip || '']).catch(() => {});
        }
      }
    );

    // INITIAL SYNC: Set both speakers to current Windows volume immediately (unless boost is ON)
    if (!settingsManager.getSetting('volumeBoost')) {
      volumeSync.getWindowsVolume().then((volume) => {
        sendLog(`[VolumeSync] Initial sync: Setting both speakers to ${volume}%`);
        const volumeLevel = volume / 100;
        if (daemonManager.isDaemonRunning()) {
          daemonManager.setVolumeFast(leftSpeaker.name, volumeLevel, leftSpeaker.ip || null).catch(() => {});
          daemonManager.setVolumeFast(rightSpeaker.name, volumeLevel, rightSpeaker.ip || null).catch(() => {});
        } else {
          const volumeStr = volumeLevel.toString();
          runPython(['set-volume-fast', leftSpeaker.name, volumeStr, leftSpeaker.ip || '']).catch(() => {});
          runPython(['set-volume-fast', rightSpeaker.name, volumeStr, rightSpeaker.ip || '']).catch(() => {});
        }
      }).catch(() => {});
    }

    return { success: true };

  } catch (error) {
    sendLog(`Stereo streaming failed: ${error.message}`, 'error');
    // Clean up on error
    if (stereoFFmpegProcesses.left) {
      stereoFFmpegProcesses.left.kill();
      stereoFFmpegProcesses.left = null;
    }
    if (stereoFFmpegProcesses.right) {
      stereoFFmpegProcesses.right.kill();
      stereoFFmpegProcesses.right = null;
    }
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-stereo-streaming', async (event, leftSpeaker, rightSpeaker) => {
  try {
    sendLog('Stopping stereo streaming...');

    // Stop FFmpeg processes
    if (stereoFFmpegProcesses.left) {
      stereoFFmpegProcesses.left.kill();
      stereoFFmpegProcesses.left = null;
      sendLog('LEFT channel stopped');
    }

    if (stereoFFmpegProcesses.right) {
      stereoFFmpegProcesses.right.kill();
      stereoFFmpegProcesses.right = null;
      sendLog('RIGHT channel stopped');
    }

    // Disconnect both speakers (daemon is instant)
    if (daemonManager.isDaemonRunning()) {
      if (leftSpeaker) {
        await daemonManager.disconnectSpeaker(leftSpeaker.name).catch(() => {});
      }
      if (rightSpeaker) {
        await daemonManager.disconnectSpeaker(rightSpeaker.name).catch(() => {});
      }
    } else {
      if (leftSpeaker) {
        await runPython(['stop', leftSpeaker.name]).catch(() => {});
      }
      if (rightSpeaker) {
        await runPython(['stop', rightSpeaker.name]).catch(() => {});
      }
    }

    // Stop stream stats
    if (streamStats) {
      streamStats.stop();
    }

    // Stop Windows volume sync
    volumeSync.stopMonitoring();

    // Restore original Windows audio device
    try {
      sendLog('Restoring original audio device...');
      await audioDeviceManager.restoreOriginalDevice();
      sendLog('Audio device restored', 'success');
    } catch (err) {
      sendLog(`Audio restore failed: ${err.message}`, 'warning');
      // Continue anyway
    }

    sendLog('Stereo streaming stopped', 'success');
    trayManager.updateTrayState(false); // Update tray to idle state
    usageTracker.stopTracking(); // Stop tracking usage time
    return { success: true };

  } catch (error) {
    sendLog(`Stop failed: ${error.message}`, 'error');
    trayManager.updateTrayState(false); // Update tray to idle state
    usageTracker.stopTracking(); // Stop tracking usage time
    return { success: false, error: error.message };
  }
});

// Settings management
ipcMain.handle('get-settings', () => {
  return settingsManager.getAllSettings();
});

ipcMain.handle('update-settings', (event, updates) => {
  settingsManager.updateSettings(updates);
  return { success: true };
});

ipcMain.handle('save-last-speaker', (event, speaker) => {
  settingsManager.saveLastSpeaker(speaker);
  return { success: true };
});

// Auto-start on Windows boot
ipcMain.handle('is-auto-start-enabled', async () => {
  try {
    const enabled = await autoStartManager.isAutoStartEnabled();
    return { success: true, enabled };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('toggle-auto-start', async () => {
  try {
    const enabled = await autoStartManager.toggleAutoStart();
    // Update settings
    settingsManager.setSetting('autoStart', enabled);
    return { success: true, enabled };
  } catch (error) {
    sendLog(`Auto-start toggle failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════
// AUDIO SYNC (PC SPEAKER DELAY)
// ═══════════════════════════════════════════════════════════

// Initialize audio sync on app startup
ipcMain.handle('init-audio-sync', async () => {
  try {
    const result = await audioSyncManager.initialize();
    sendLog(`Audio sync: method=${result.method || 'none'}, supported=${result.supported}`, 'info');
    return result;
  } catch (error) {
    sendLog(`Audio sync init failed: ${error.message}`, 'error');
    return { method: null, supported: false, error: error.message };
  }
});

// Set PC speaker delay in milliseconds
ipcMain.handle('set-sync-delay', async (event, delayMs) => {
  try {
    const result = await audioSyncManager.setDelay(delayMs);
    if (result) {
      sendLog(`Sync delay set to ${delayMs}ms`, 'success');
      // Save to settings
      settingsManager.setSetting('syncDelayMs', delayMs);
    }
    return { success: result, delayMs };
  } catch (error) {
    sendLog(`Sync delay failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Get current sync delay
ipcMain.handle('get-sync-delay', () => {
  return {
    delayMs: audioSyncManager.getDelay(),
    method: audioSyncManager.getMethod(),
    available: audioSyncManager.isAvailable()
  };
});

// Check if Equalizer APO is installed (for showing install prompt)
ipcMain.handle('check-equalizer-apo', () => {
  return {
    installed: audioSyncManager.isEqualizerAPOInstalled()
  };
});

// Prompt user to install Equalizer APO
ipcMain.handle('install-equalizer-apo', async () => {
  try {
    await audioSyncManager.promptInstallEqualizerAPO();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════
// LICENSE KEY VALIDATION
// ═══════════════════════════════════════════════════════════
function getLicensePath() {
  return path.join(app.getPath('userData'), 'license.json');
}

// License validation API URL (will be set up later)
const LICENSE_API_URL = 'https://pcnestspeaker.app/api/validate-license';

// Validate license key format: PNS-XXXX-XXXX-XXXX-XXXX
function validateLicenseFormat(key) {
  if (!key || key.length !== 23) return false;
  const pattern = /^PNS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  return pattern.test(key.toUpperCase());
}

function getLicenseData() {
  try {
    const licensePath = getLicensePath();
    if (fs.existsSync(licensePath)) {
      return JSON.parse(fs.readFileSync(licensePath, 'utf8'));
    }
  } catch (err) {
    console.error('[License] Error loading license:', err);
  }
  return null;
}

function saveLicenseData(licenseKey) {
  const data = {
    licenseKey: licenseKey.toUpperCase(),
    activatedAt: new Date().toISOString()
  };
  try {
    const licensePath = getLicensePath();
    fs.writeFileSync(licensePath, JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    console.error('[License] Error saving license:', err);
    return null;
  }
}

function deleteLicenseData() {
  try {
    const licensePath = getLicensePath();
    if (fs.existsSync(licensePath)) {
      fs.unlinkSync(licensePath);
      return true;
    }
  } catch (err) {
    console.error('[License] Error deleting license:', err);
  }
  return false;
}

// Get current license status
ipcMain.handle('get-license', async () => {
  const license = getLicenseData();
  return license;
});

// Validate and save a new license key
ipcMain.handle('activate-license', async (event, licenseKey) => {
  if (!licenseKey) {
    return { success: false, error: 'Please enter a license key' };
  }

  const cleanKey = licenseKey.toUpperCase().trim();

  // Check format first (quick client-side validation)
  if (!validateLicenseFormat(cleanKey)) {
    return {
      success: false,
      error: 'Invalid license key format. Please check and try again.'
    };
  }

  // Validate against server
  try {
    const fetch = require('node-fetch');
    const response = await fetch(LICENSE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: cleanKey })
    });

    const result = await response.json();

    if (!result.valid) {
      return {
        success: false,
        error: result.error || 'Invalid license key. Please check and try again.'
      };
    }

    // License is valid - save it locally
    const saved = saveLicenseData(cleanKey);
    if (saved) {
      // Activate license in usage tracker (removes trial limit)
      usageTracker.activateLicense(cleanKey);

      return { success: true, license: saved };
    } else {
      return { success: false, error: 'Failed to save license' };
    }
  } catch (err) {
    console.error('[License] Validation API error:', err);
    // If API is unreachable, fall back to format-only validation (offline mode)
    // This allows the app to work offline after initial activation
    const existingLicense = getLicenseData();
    if (existingLicense && existingLicense.licenseKey === cleanKey) {
      // Re-activating same key - allow it
      usageTracker.activateLicense(cleanKey);
      return { success: true, license: existingLicense };
    } else {
      return {
        success: false,
        error: 'Unable to verify license. Please check your internet connection.'
      };
    }
  }
});

// Deactivate (delete) the current license
ipcMain.handle('deactivate-license', async () => {
  deleteLicenseData();
  usageTracker.deactivateLicense();
  return { success: true };
});

// App lifecycle
app.whenReady().then(() => {
  // Kill any leftover processes from previous runs (port conflicts, etc.)
  killLeftoverProcesses();
  createWindow();

  // Create system tray
  trayManager.createTray(mainWindow);

  // Start Cast daemon for instant volume control
  daemonManager.startDaemon().then(() => {
    console.log('[Main] Cast daemon started - volume control will be instant');
  }).catch(err => {
    console.log('[Main] Cast daemon failed to start:', err.message);
    console.log('[Main] Falling back to spawning Python per command (slower)');
  });

  // Auto-discover speakers and audio devices in background
  // This populates the UI without user having to click "Discover"
  setTimeout(() => {
    autoDiscoverDevices().catch(err => {
      console.log('[Main] Auto-discovery failed:', err.message);
    });
  }, 1500); // Wait 1.5s for window to load

  // Start WebRTC pipeline in background after discovery completes
  // This makes streaming near-instant when user clicks "Start"
  setTimeout(() => {
    preStartWebRTCPipeline().catch(err => {
      console.log('[Main] Background pipeline failed:', err.message);
    });
  }, 3000); // Wait 3s (after discovery)

  // Auto-connect to last speaker if enabled (wait for pipeline to be ready)
  setTimeout(() => {
    const settings = settingsManager.getAllSettings();
    if (settings.autoConnect && settings.lastSpeaker) {
      console.log('[Main] Auto-connecting to last speaker:', settings.lastSpeaker.name);
      sendLog(`Auto-connecting to ${settings.lastSpeaker.name}...`, 'info');

      // Auto-start streaming to last speaker
      // We'll send a message to the renderer to trigger this
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('auto-connect', settings.lastSpeaker);
      }
    }
  }, 5000); // Wait 5s (after pipeline is ready)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit on window close - we have a system tray
  // User must explicitly choose "Exit" from tray menu
});

app.on('before-quit', () => {
  app.isQuitting = true;
  cleanup();
  trayManager.destroyTray();
  daemonManager.stopDaemon(); // Stop the Cast daemon
  // Force kill any leftover processes by name (belt and suspenders)
  killLeftoverProcesses();
});
