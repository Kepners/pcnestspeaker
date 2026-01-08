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
const { setupFirewall } = require('./firewall-setup');

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
// NOTE: We use screen-capture-recorder which installs "virtual-audio-capturer" device
// VB-CABLE is legacy fallback only - not needed with screen-capture-recorder
const DEPENDENCY_URLS = {
  'virtual-audio': 'https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases/download/v0.13.3/Setup.Screen.Capturer.Recorder.v0.13.3.exe',
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

// Flag to prevent cleanup when intentionally switching to stereo mode
let switchingToStereoMode = false;

// Background WebRTC pipeline status
let webrtcPipelineReady = false;
let webrtcPipelineError = null;

// Local HTTP works! NO TUNNEL NEEDED (see MISTAKES_LOG.md MISTAKE #1)
// Cast receivers CAN fetch from local network HTTP - tested and confirmed
const DISABLE_CLOUDFLARE = true;

// Helper: Get local IP address
function getLocalIp() {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();

  // Check for any private IP range (not just 192.168.x.x)
  const isPrivateIP = (ip) => {
    return ip.startsWith('192.168.') ||  // 192.168.0.0/16
           ip.startsWith('10.') ||        // 10.0.0.0/8
           ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) // 172.16.0.0/12
  };

  for (const interfaceName in networkInterfaces) {
    for (const iface of networkInterfaces[interfaceName]) {
      if (iface.family === 'IPv4' && !iface.internal && isPrivateIP(iface.address)) {
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
    height: 1080,
    minWidth: 420,
    minHeight: 900,
    resizable: true,
    frame: false,
    backgroundColor: '#FFFFFF',
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

// Check all dependencies
async function checkAllDependencies() {
  const deps = {
    virtualAudio: false,      // virtual-audio-capturer OR Virtual Desktop Audio
    vbcableFallback: false,   // VB-CABLE (legacy fallback only)
    mediamtx: false,
    ffmpeg: true // Assume bundled FFmpeg is always available
  };

  // Get audio devices ONCE and check what we have
  try {
    if (!audioStreamer) audioStreamer = new AudioStreamer();
    const devices = await audioStreamer.getAudioDevices();

    // Check for virtual-audio-capturer (preferred) or Virtual Desktop Audio
    deps.virtualAudio = devices.some(d =>
      d.toLowerCase().includes('virtual-audio-capturer') ||
      d.toLowerCase().includes('virtual desktop audio')
    );

    // VB-CABLE is legacy fallback only
    deps.vbcableFallback = devices.some(d => d.toLowerCase().includes('cable output'));
  } catch (e) {
    console.error('[Main] Error checking audio devices:', e.message);
  }

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

  // Inject local IP into MediaMTX config for ICE candidates
  try {
    const localIp = getLocalIp();
    const configPath = getMediaMTXConfig();
    let config = fs.readFileSync(configPath, 'utf8');

    // Update webrtcAdditionalHosts with detected IP
    config = config.replace(
      /webrtcAdditionalHosts:\s*\[.*?\]/,
      `webrtcAdditionalHosts: ['${localIp}']`
    );

    fs.writeFileSync(configPath, config, 'utf8');
    sendLog(`[MediaMTX] Injected local IP: ${localIp}`);
  } catch (e) {
    sendLog(`[MediaMTX] Could not inject IP: ${e.message}`, 'warning');
  }

  sendLog('Starting MediaMTX server...');

  return new Promise((resolve, reject) => {
    // Launch MediaMTX with our custom config
    const mtxPath = getMediaMTXPath();
    const mtxConfig = getMediaMTXConfig();

    mediamtxProcess = spawn(mtxPath, [mtxConfig], {
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
      windowsHide: true
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
        // Check for critical errors
        if (msg.includes('Could not find audio device') || msg.includes('audio device not found') ||
            msg.includes('No such device') || msg.includes('Invalid data found')) {
          sendLog(`[FFmpeg ERROR] Audio device not found: ${audioDevice}`, 'error');
          sendLog(`[FFmpeg] Make sure screen-capture-recorder is installed and virtual-audio-capturer is available`, 'error');
        }
        // Check if this is stats output we should be parsing
        else if (msg.includes('size=') || msg.includes('time=') || msg.includes('bitrate=')) {
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

// Start cloudflared tunnel for HTTPS
// Uses a shared promise to prevent race conditions when called concurrently
let tunnelPromise = null;

async function startLocalTunnel(port = 8443) {
  // Already have URL - return immediately
  if (tunnelUrl) {
    sendLog(`Tunnel already running at ${tunnelUrl}`);
    return tunnelUrl;
  }

  // Tunnel is starting - wait for the existing promise instead of spawning another
  if (tunnelPromise) {
    sendLog('Waiting for tunnel in progress...');
    return tunnelPromise;
  }

  const cloudflaredPath = findCloudflared();
  if (!cloudflaredPath) {
    throw new Error('cloudflared not installed. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/');
  }

  sendLog('Starting cloudflared tunnel...');

  tunnelPromise = new Promise((resolve, reject) => {
    localTunnelProcess = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    localTunnelProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      const urlMatch = msg.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i);
      if (urlMatch && !tunnelUrl) {
        tunnelUrl = urlMatch[1];
        sendLog(`Tunnel URL: ${tunnelUrl}`, 'success');
        resolve(tunnelUrl);
      }
    });

    localTunnelProcess.on('error', (err) => {
      sendLog(`cloudflared error: ${err.message}`, 'error');
      localTunnelProcess = null;
      tunnelPromise = null;
      reject(err);
    });

    localTunnelProcess.on('close', (code) => {
      sendLog(`cloudflared exited with code ${code}`);
      localTunnelProcess = null;
      tunnelUrl = null;
      tunnelPromise = null;
    });

    setTimeout(() => {
      if (!tunnelUrl) {
        if (localTunnelProcess) {
          localTunnelProcess.kill();
          localTunnelProcess = null;
        }
        tunnelPromise = null;
        reject(new Error('Tunnel startup timed out'));
      }
    }, 30000);
  });

  return tunnelPromise;
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
      const localIP = getLocalIp();
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
    // Use python (not pythonw!) - pythonw breaks mDNS/multicast sockets on Windows
    // windowsHide: true still hides the console window
    const pythonCmd = 'python';
    const python = spawn(pythonCmd, [scriptPath, ...args], {
      windowsHide: true
    });

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

      // Use local HTTP URL (like stereo mode) - tunnel was causing audio issues!
      const localIp = getLocalIp();
      let webrtcUrl = `http://${localIp}:8889`;

      // Check if pipeline was pre-started in background
      if (webrtcPipelineReady && mediamtxProcess && ffmpegWebrtcProcess) {
        sendLog('Using pre-started WebRTC pipeline', 'success');

        // CRITICAL FIX: Restart FFmpeg AFTER audio device switch!
        // The pre-started FFmpeg was capturing from the OLD default output.
        // Now that we've switched to Virtual Desktop Audio, we need to restart FFmpeg
        // so it captures from the NEW default output via WASAPI loopback.
        sendLog('Restarting FFmpeg to capture from new audio device...');

        // Kill old FFmpeg process
        if (ffmpegWebrtcProcess) {
          try {
            ffmpegWebrtcProcess.kill('SIGTERM');
          } catch (e) {}
          ffmpegWebrtcProcess = null;
        }

        // Wait a moment for WASAPI to recognize the new default device
        await new Promise(r => setTimeout(r, 500));

        // Determine audio device name for FFmpeg
        let audioDeviceName = 'virtual-audio-capturer';
        if (streamingMode === 'webrtc-vbcable') {
          audioDeviceName = 'CABLE Output (VB-Audio Virtual Cable)';
        } else {
          if (!audioStreamer) {
            audioStreamer = new AudioStreamer();
          }
          const devices = await audioStreamer.getAudioDevices();
          sendLog(`Available DirectShow audio devices: ${devices.join(', ')}`);

          const vacDevice = devices.find(d =>
            d.toLowerCase().includes('virtual-audio-capturer')
          );
          if (vacDevice) {
            audioDeviceName = vacDevice;
            sendLog(`Found virtual-audio-capturer: "${audioDeviceName}"`);
          } else {
            sendLog('[WARNING] virtual-audio-capturer not found! Checking for alternatives...', 'warning');
            // Try to find any virtual audio device
            const virtualDevice = devices.find(d =>
              d.toLowerCase().includes('virtual') ||
              d.toLowerCase().includes('cable') ||
              d.toLowerCase().includes('stereo mix')
            );
            if (virtualDevice) {
              audioDeviceName = virtualDevice;
              sendLog(`Using alternative device: "${audioDeviceName}"`, 'warning');
            } else {
              sendLog('[ERROR] No virtual audio capture device found!', 'error');
              sendLog('[ERROR] Please install screen-capture-recorder from: https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases', 'error');
            }
          }
        }

        sendLog(`Using audio device: ${audioDeviceName}`);

        // Start new FFmpeg process
        await startFFmpegWebRTC(audioDeviceName);
        sendLog('FFmpeg restarted - now capturing from Virtual Desktop Audio!', 'success');

        // Start stream stats monitoring
        if (streamStats) {
          streamStats.start();
        }

        // Use local HTTP URL directly (like stereo mode) - NO cloudflared needed!
        sendLog(`Using local HTTP URL: ${webrtcUrl}`, 'success');
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
          sendLog(`Available DirectShow audio devices: ${devices.join(', ')}`);

          const vacDevice = devices.find(d =>
            d.toLowerCase().includes('virtual-audio-capturer')
          );
          if (vacDevice) {
            audioDeviceName = vacDevice;
            sendLog(`Found virtual-audio-capturer: "${audioDeviceName}"`);
          } else {
            sendLog('[WARNING] virtual-audio-capturer not found! Checking for alternatives...', 'warning');
            // Try to find any virtual audio device
            const virtualDevice = devices.find(d =>
              d.toLowerCase().includes('virtual') ||
              d.toLowerCase().includes('cable') ||
              d.toLowerCase().includes('stereo mix')
            );
            if (virtualDevice) {
              audioDeviceName = virtualDevice;
              sendLog(`Using alternative device: "${audioDeviceName}"`, 'warning');
            } else {
              sendLog('[ERROR] No virtual audio capture device found!', 'error');
              sendLog('[ERROR] Please install screen-capture-recorder from: https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases', 'error');
            }
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

        // Use local HTTP URL directly (like stereo mode) - NO cloudflared needed!
        sendLog(`Using local HTTP URL: ${webrtcUrl}`, 'success');
      }

      // Step 4: Launch custom receiver - send URL directly (NO PROXY!)
      // Receiver fetches from MediaMTX directly using local HTTP URL
      sendLog(`[DEBUG] Looking for speaker "${speakerName}" in ${discoveredSpeakers.length} discovered speakers`);
      const speaker = discoveredSpeakers.find(s => s.name === speakerName);
      sendLog(`[DEBUG] Found speaker: ${speaker ? JSON.stringify({name: speaker.name, cast_type: speaker.cast_type}) : 'NOT FOUND'}`);
      const speakerIp = speaker ? speaker.ip : null;
      const isGroup = speaker && speaker.cast_type === 'group';
      sendLog(`[DEBUG] isGroup=${isGroup}, speakerIp=${speakerIp}`);

      let result;

      if (isGroup) {
        // Cast Groups don't work with custom receivers - only leader plays!
        // Solution: Get group members and use STEREO for 2-member groups, multicast for 3+
        sendLog(`Detected Cast Group: "${speakerName}"...`);

        // Get group members
        const membersResult = await runPython(['get-group-members', speakerName]);
        if (!membersResult.success || !membersResult.members || membersResult.members.length === 0) {
          sendLog(`Could not get group members: ${membersResult.error || 'No members found'}`, 'warning');
          sendLog('Falling back to single cast (will only play on leader)...', 'warning');
          // Fall back to regular launch
          const args = ['webrtc-launch', speakerName, webrtcUrl];
          if (speakerIp) args.push(speakerIp);
          args.push('pcaudio');
          result = await runPython(args);
        } else if (membersResult.count === 2) {
          // 2-member group = STEREO PAIR! Left channel → speaker 1, Right channel → speaker 2
          sendLog(`🎯 2-member group detected - using STEREO SEPARATION!`, 'success');
          const leftMember = membersResult.members[0];
          const rightMember = membersResult.members[1];
          sendLog(`  LEFT: ${leftMember.name} (${leftMember.ip})`);
          sendLog(`  RIGHT: ${rightMember.name} (${rightMember.ip})`);

          // Stop mono FFmpeg if running (switching to stereo mode)
          if (ffmpegWebrtcProcess) {
            sendLog('Stopping mono stream for stereo mode...');
            switchingToStereoMode = true;
            try { ffmpegWebrtcProcess.kill('SIGTERM'); } catch (e) {}
            ffmpegWebrtcProcess = null;
          }

          // Get FFmpeg path and volume settings
          const ffmpegPath = getFFmpegPath();
          const volumeBoostEnabled = settingsManager.getSetting('volumeBoost');
          const boostLevel = volumeBoostEnabled ? 1.25 : 1.03;

          // CRITICAL: DirectShow devices can only be opened ONCE!
          // Use SINGLE FFmpeg with filter_complex for L/R split + dual RTSP output
          sendLog('Starting FFmpeg stereo split (single capture, dual output)...');
          stereoFFmpegProcesses.left = spawn(ffmpegPath, [
            '-hide_banner', '-stats',
            '-f', 'dshow',
            '-i', 'audio=virtual-audio-capturer',
            '-filter_complex', `[0:a]pan=mono|c0=c0,volume=${boostLevel}[left];[0:a]pan=mono|c0=c1,volume=${boostLevel}[right]`,
            '-map', '[left]', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
            '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://localhost:8554/left',
            '-map', '[right]', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
            '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://localhost:8554/right'
          ], { stdio: 'pipe', windowsHide: true });

          // Note: stereoFFmpegProcesses.right is not used - single process handles both
          stereoFFmpegProcesses.right = null;

          stereoFFmpegProcesses.left.stderr.on('data', (data) => {
            const msg = data.toString();
            if (streamStats) streamStats.parseFfmpegOutput(msg);
            if (msg.includes('Error') || msg.includes('error')) {
              sendLog(`FFmpeg STEREO: ${msg}`, 'error');
            }
          });

          await new Promise(r => setTimeout(r, 4000));  // Wait longer for both RTSP outputs to publish to MediaMTX
          sendLog('LEFT + RIGHT channels streaming (single FFmpeg)', 'success');

          // Start stream stats
          if (streamStats) streamStats.start();

          // STEREO MODE: Use LOCAL HTTP - NOT cloudflared tunnel!
          // This matches test-stereo-split.bat which works reliably
          const localIp = getLocalIp();
          const stereoUrl = `http://${localIp}:8889`;
          sendLog(`Stereo URL: ${stereoUrl} (local HTTP - no tunnel)`);

          // Connect speakers directly (no retry needed with local HTTP)
          sendLog(`Connecting LEFT speaker: "${leftMember.name}"...`);
          const leftResult = await runPython([
            'webrtc-launch',
            leftMember.name,
            stereoUrl,
            leftMember.ip || '',
            'left'
          ]);
          if (!leftResult.success) {
            throw new Error(`Left speaker failed: ${leftResult.error}`);
          }
          sendLog(`LEFT speaker connected`, 'success');

          sendLog(`Connecting RIGHT speaker: "${rightMember.name}"...`);
          const rightResult = await runPython([
            'webrtc-launch',
            rightMember.name,
            stereoUrl,
            rightMember.ip || '',
            'right'
          ]);
          if (!rightResult.success) {
            throw new Error(`Right speaker failed: ${rightResult.error}`);
          }
          sendLog(`RIGHT speaker connected`, 'success');

          switchingToStereoMode = false;

          // Return success with launched speakers for volume sync
          result = {
            success: true,
            stereoMode: true,
            launched: [leftMember.name, rightMember.name],
            leftSpeaker: leftMember,
            rightSpeaker: rightMember
          };
        } else {
          // 3+ member group = Multicast (same audio to all)
          const memberNames = membersResult.members.map(m => m.name);
          const memberIps = membersResult.members.map(m => m.ip);
          sendLog(`Group has ${membersResult.count} members - using multicast: ${memberNames.join(', ')}`);

          const multicastArgs = [
            'webrtc-multicast',
            JSON.stringify(memberNames),
            webrtcUrl,
            JSON.stringify(memberIps),
            'pcaudio'
          ];
          result = await runPython(multicastArgs);

          if (result.success) {
            sendLog(`Multicast launched on ${result.launched.length} speakers: ${result.launched.join(', ')}`, 'success');
            if (result.failed && result.failed.length > 0) {
              sendLog(`Failed on ${result.failed.length} speakers: ${result.failed.map(f => f.name).join(', ')}`, 'warning');
            }
          }
        }
      } else {
        // Single speaker - use regular launch
        sendLog(`Connecting to ${speakerName}${speakerIp ? ` (${speakerIp})` : ''}...`);
        const args = ['webrtc-launch', speakerName, webrtcUrl];
        if (speakerIp) args.push(speakerIp);
        args.push('pcaudio'); // stream name
        result = await runPython(args);
      }

      if (result.success) {
        // Check verification status from Python
        if (result.verified) {
          sendLog('✓ WebRTC streaming verified - audio is playing!', 'success');
        } else if (result.warning === 'no_data') {
          sendLog('⚠ Connected but NO AUDIO FLOWING (bytesSent=0)', 'warning');
          sendLog('⚠ ICE negotiation may have failed - check if device turned on', 'warning');
        } else if (result.warning === 'no_session') {
          sendLog('⚠ No WebRTC session found - device may not have connected', 'warning');
          sendLog('⚠ Try: 1) Turn on TV manually, 2) Check network, 3) Restart app', 'warning');
        } else {
          sendLog('WebRTC message sent (verification skipped)', 'success');
        }

        trayManager.updateTrayState(true); // Update tray to streaming state
        usageTracker.startTracking(); // Start tracking usage time

        // Start Windows volume sync - PC volume keys will control Nest
        // For groups, sync volume to all member speakers
        const speakersToSync = isGroup && result.launched
          ? result.launched.map(name => {
              // Find member info from discovery
              const member = discoveredSpeakers.find(s => s.name === name);
              return member ? { name: member.name, ip: member.ip } : { name, ip: null };
            })
          : speaker ? [{ name: speaker.name, ip: speaker.ip }] : [];

        if (speakersToSync.length > 0) {
          volumeSync.startMonitoring(
            speakersToSync,
            (volume) => {
              // If boost is enabled, don't sync - speaker stays at 100%
              if (settingsManager.getSetting('volumeBoost')) {
                return; // Skip sync when boost is on
              }
              sendLog(`[VolumeSync] Windows volume: ${volume}%`);
              // Set volume on all speakers
              speakersToSync.forEach(spk => {
                if (daemonManager.isDaemonRunning()) {
                  daemonManager.setVolumeFast(spk.name, volume / 100, spk.ip || null).catch(() => {});
                } else {
                  runPython(['set-volume-fast', spk.name, (volume / 100).toString(), spk.ip || '']).catch(() => {});
                }
              });
            }
          );

          // INITIAL SYNC: Set speakers to current Windows volume immediately (unless boost is ON)
          if (!settingsManager.getSetting('volumeBoost')) {
            volumeSync.getWindowsVolume().then((volume) => {
              sendLog(`[VolumeSync] Initial sync: Setting ${speakersToSync.length} speaker(s) to ${volume}%`);
              speakersToSync.forEach(spk => {
                if (daemonManager.isDaemonRunning()) {
                  daemonManager.setVolumeFast(spk.name, volume / 100, spk.ip || null).catch(() => {});
                } else {
                  runPython(['set-volume-fast', spk.name, (volume / 100).toString(), spk.ip || '']).catch(() => {});
                }
              });
            }).catch(() => {});
          }
        }

        return {
          success: true,
          url: webrtcUrl,
          mode: streamingMode,
          multicast: isGroup,
          stereoMode: result.stereoMode || false,
          launched: result.launched || []
        };
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
      } else if (result.error && (result.error.includes('Timeout') || result.error.includes('offer'))) {
        // Proxy signaling failed (likely Android TV doesn't support receiver->sender messaging)
        // Fall back to cloudflared tunnel which provides HTTPS URL
        sendLog('Proxy signaling timed out - trying cloudflared tunnel...', 'warning');

        try {
          // Start cloudflared tunnel for HTTPS access to MediaMTX
          const httpsUrl = await startLocalTunnel(8889);
          sendLog(`Tunnel URL: ${httpsUrl}`, 'success');

          // Use webrtc-launch with the HTTPS URL (receiver fetches directly)
          sendLog(`Connecting via tunnel to ${speakerName}...`);
          const tunnelArgs = ['webrtc-launch', speakerName, httpsUrl];
          if (speakerIp) tunnelArgs.push(speakerIp);
          tunnelArgs.push('pcaudio'); // stream name
          const tunnelResult = await runPython(tunnelArgs);

          if (tunnelResult.success) {
            // Check verification status from Python
            if (tunnelResult.verified) {
              sendLog('✓ WebRTC streaming verified (via tunnel) - audio is playing!', 'success');
            } else if (tunnelResult.warning === 'no_data') {
              sendLog('⚠ Connected but NO AUDIO FLOWING (bytesSent=0)', 'warning');
            } else if (tunnelResult.warning === 'no_session') {
              sendLog('⚠ No WebRTC session found - device may not have connected', 'warning');
            } else {
              sendLog('WebRTC message sent via tunnel (verification skipped)', 'success');
            }

            trayManager.updateTrayState(true);
            usageTracker.startTracking();

            // Volume sync
            if (speaker) {
              volumeSync.startMonitoring(
                [{ name: speaker.name, ip: speaker.ip }],
                (volume) => {
                  if (settingsManager.getSetting('volumeBoost')) return;
                  if (daemonManager.isDaemonRunning()) {
                    daemonManager.setVolumeFast(speaker.name, volume / 100, speaker.ip || null).catch(() => {});
                  } else {
                    runPython(['set-volume-fast', speaker.name, (volume / 100).toString(), speaker.ip || '']).catch(() => {});
                  }
                }
              );
            }

            return { success: true, url: httpsUrl, mode: streamingMode, tunnelFallback: true };
          } else {
            throw new Error(`Tunnel fallback failed: ${tunnelResult.error}`);
          }
        } catch (tunnelError) {
          cleanup();
          throw new Error(`Proxy signaling failed and tunnel fallback failed: ${tunnelError.message}`);
        }
      } else {
        // Other errors - no fallback available
        cleanup();
        throw new Error(result.error);
      }

    } else {
      throw new Error(`Unknown streaming mode: ${streamingMode}`);
    }

  } catch (error) {
    sendLog(`Stream failed: ${error.message}`, 'error');
    // Don't cleanup if we're intentionally switching to stereo mode
    // (mono FFmpeg was killed on purpose, not a failure)
    if (!switchingToStereoMode) {
      cleanup();
    } else {
      sendLog('(Skipping cleanup - switching to stereo mode)', 'info');
    }
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

// Window controls (frameless window)
ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  if (mainWindow) mainWindow.hide();
});

// Check dependencies
ipcMain.handle('check-dependencies', async () => {
  try {
    sendLog('Checking dependencies...');
    const deps = await checkAllDependencies();

    // Log Virtual Audio (from screen-capture-recorder) - this is what we actually use
    if (deps.virtualAudio) {
      sendLog('Virtual Audio: OK', 'success');
    } else if (deps.vbcableFallback) {
      sendLog('Virtual Audio: Missing (using VB-CABLE fallback)', 'warning');
    } else {
      sendLog('Virtual Audio: Missing - install screen-capture-recorder', 'error');
    }

    sendLog(`MediaMTX: ${deps.mediamtx ? 'OK' : 'Missing'}`);
    return deps;
  } catch (error) {
    sendLog(`Dependency check failed: ${error.message}`, 'error');
    return {
      virtualAudio: false,
      vbcableFallback: false,
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

    // Stop any existing mono streaming (ffmpegWebrtcProcess) before starting stereo
    // Set flag to prevent cleanup() being called by any pending timeout/error handler
    // This flag stays true until stereo is fully set up (reset at end of this handler)
    if (ffmpegWebrtcProcess) {
      sendLog('Stopping existing mono stream for stereo mode...');
      switchingToStereoMode = true;  // Prevent cleanup from killing MediaMTX
      try {
        ffmpegWebrtcProcess.kill('SIGTERM');
      } catch (e) {}
      ffmpegWebrtcProcess = null;
    }

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

    // 2. Start SINGLE FFmpeg process for BOTH channels
    // CRITICAL: DirectShow devices can only be opened ONCE!
    // We use filter_complex to split audio into L/R and output to two RTSP streams
    sendLog('Starting FFmpeg stereo split (single capture, dual output)...');
    const ffmpegPath = getFFmpegPath();

    // Check if volume boost is enabled (same values as main stream)
    const volumeBoostEnabled = settingsManager.getSetting('volumeBoost');
    const boostLevel = volumeBoostEnabled ? 1.25 : 1.03; // 3% hidden, 25% with boost

    // Single FFmpeg process with filter_complex for L/R split + dual RTSP output
    stereoFFmpegProcesses.left = spawn(ffmpegPath, [
      '-hide_banner', '-stats',
      '-f', 'dshow',
      '-i', 'audio=virtual-audio-capturer',
      '-filter_complex', `[0:a]pan=mono|c0=c0,volume=${boostLevel}[left];[0:a]pan=mono|c0=c1,volume=${boostLevel}[right]`,
      '-map', '[left]', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://localhost:8554/left',
      '-map', '[right]', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://localhost:8554/right'
    ], { stdio: 'pipe', windowsHide: true });

    // Note: stereoFFmpegProcesses.right is not used - single process handles both
    stereoFFmpegProcesses.right = null;

    stereoFFmpegProcesses.left.stderr.on('data', (data) => {
      const msg = data.toString();
      // Parse for stream stats
      if (streamStats) {
        streamStats.parseFfmpegOutput(msg);
      }
      if (msg.includes('Error') || msg.includes('error')) {
        sendLog(`FFmpeg STEREO: ${msg}`, 'error');
      }
    });

    await new Promise(r => setTimeout(r, 4000));  // Wait longer for both RTSP outputs to publish to MediaMTX
    sendLog('LEFT + RIGHT channels streaming (single FFmpeg)', 'success');

    // Start stream stats monitoring (for stereo mode)
    if (streamStats) {
      streamStats.start();
    }

    // 4. Get local IP
    const localIp = getLocalIp();
    const webrtcUrl = `http://${localIp}:8889`;

    // 5. Cast to LEFT speaker (NO PROXY - direct WebRTC)
    sendLog(`Connecting to LEFT speaker: "${leftSpeaker.name}"...`);
    const leftResult = await runPython([
      'webrtc-launch',
      leftSpeaker.name,
      webrtcUrl,
      leftSpeaker.ip || '', // Use cached IP if available
      'left' // Stream name
    ]);

    if (!leftResult.success) {
      throw new Error(`Left speaker cast failed: ${leftResult.error}`);
    }
    // Show verification status for LEFT
    if (leftResult.verified) {
      sendLog(`✓ LEFT speaker verified - audio playing!`, 'success');
    } else if (leftResult.warning === 'no_data') {
      sendLog(`⚠ LEFT: Connected but NO AUDIO (bytesSent=0)`, 'warning');
    } else if (leftResult.warning === 'no_session') {
      sendLog(`⚠ LEFT: No WebRTC session - speaker may not have turned on`, 'warning');
    } else {
      sendLog(`LEFT speaker connected (unverified)`, 'success');
    }

    // 6. Cast to RIGHT speaker (NO PROXY - direct WebRTC)
    sendLog(`Connecting to RIGHT speaker: "${rightSpeaker.name}"...`);
    const rightResult = await runPython([
      'webrtc-launch',
      rightSpeaker.name,
      webrtcUrl,
      rightSpeaker.ip || '', // Use cached IP if available
      'right' // Stream name
    ]);

    if (!rightResult.success) {
      throw new Error(`Right speaker cast failed: ${rightResult.error}`);
    }
    // Show verification status for RIGHT
    if (rightResult.verified) {
      sendLog(`✓ RIGHT speaker verified - audio playing!`, 'success');
    } else if (rightResult.warning === 'no_data') {
      sendLog(`⚠ RIGHT: Connected but NO AUDIO (bytesSent=0)`, 'warning');
    } else if (rightResult.warning === 'no_session') {
      sendLog(`⚠ RIGHT: No WebRTC session - speaker may not have turned on`, 'warning');
    } else {
      sendLog(`RIGHT speaker connected (unverified)`, 'success');
    }

    // Final status based on both speakers
    const bothVerified = leftResult.verified && rightResult.verified;
    if (bothVerified) {
      sendLog('✓ Stereo separation verified - both speakers playing!', 'success');
    } else {
      sendLog('Stereo mode started - verify audio on both speakers', 'success');
    }
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

    // Reset the switching flag - stereo is now fully set up
    switchingToStereoMode = false;
    return { success: true };

  } catch (error) {
    sendLog(`Stereo streaming failed: ${error.message}`, 'error');
    // Reset the switching flag
    switchingToStereoMode = false;
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

// Cast Mode handler - DEPRECATED: Volume muting removed because virtual-audio-capturer
// captures AFTER Windows volume is applied. Device switching already handles PC silence.
// Keeping handler for backwards compatibility but it's now a no-op.
ipcMain.handle('set-cast-mode', async (event, mode) => {
  console.log(`[Main] Cast mode set to: ${mode} (no volume change - handled by device switch)`);
  // No volume muting needed - the device switch in start-streaming handles PC silence
  // "Speakers Only" = default behavior (virtual-audio-capturer has no physical output)
  // "PC + Speakers" = future feature (would need loopback from real speakers + sync delay)
  return { success: true, mode };
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

// Single instance lock - prevent multiple app instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running - quit this one
  console.log('[Main] Another instance is already running, quitting...');
  app.quit();
}

// Handle second instance launch - focus existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// App lifecycle - only proceeds if we got the lock (app.quit above prevents this)
app.whenReady().then(async () => {
  // Kill any leftover processes from previous runs (port conflicts, etc.)
  killLeftoverProcesses();

  // Setup firewall rules for streaming (prompts admin on first run)
  await setupFirewall();

  // Verify and fix auto-start registry entry if outdated
  await autoStartManager.verifyAndFixAutoStart();

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
