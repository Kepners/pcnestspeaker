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

// Keep global references
let mainWindow = null;
let audioStreamer = null;
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
      execSync('taskkill /F /IM mediamtx.exe 2>nul', { stdio: 'ignore' });
      console.log('[Main] Killed leftover mediamtx');
    } catch (e) {
      // Process not running - that's fine
    }

    try {
      // Kill any localtunnel processes
      execSync('taskkill /F /IM lt.exe 2>nul', { stdio: 'ignore' });
    } catch (e) {
      // Process not running - that's fine
    }

    try {
      // Kill any cloudflared processes
      execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: 'ignore' });
    } catch (e) {
      // Process not running - that's fine
    }
  }
}

// Send log to renderer
function sendLog(message, type = 'info') {
  console.log(`[Main] ${message}`);
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('log', message, type);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 400,
    minHeight: 500,
    resizable: true,
    frame: true,
    backgroundColor: '#334E58',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanup();
  });
}

function cleanup() {
  sendLog('Cleaning up all processes...');

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
      execSync('taskkill /F /IM mediamtx.exe', { stdio: 'ignore' });
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
      stdio: ['ignore', 'pipe', 'pipe']
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
    const args = [
      '-f', 'dshow',
      '-i', `audio=${audioDevice}`,
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      'rtsp://localhost:8554/pcaudio'
    ];

    sendLog(`[FFmpeg] ${ffmpegPath} ${args.join(' ')}`);

    ffmpegWebrtcProcess = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    ffmpegWebrtcProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) sendLog(`[FFmpeg] ${msg}`);
    });

    ffmpegWebrtcProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // FFmpeg outputs progress to stderr
      if (msg && !msg.includes('frame=') && !msg.includes('size=')) {
        sendLog(`[FFmpeg] ${msg}`);
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
        execSync('where cloudflared', { stdio: 'ignore' });
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
        stdio: ['ignore', 'pipe', 'pipe']
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
      cwd: path.join(__dirname, '../..')
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
    const python = spawn('python', [scriptPath, ...args]);

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

// Stop streaming
ipcMain.handle('stop-streaming', async (event, speakerName) => {
  try {
    sendLog('Stopping...');

    // Stop Python cast
    if (speakerName) {
      try {
        await runPython(['stop', speakerName]);
      } catch (e) {
        // Ignore stop errors
      }
    }

    // Stop FFmpeg stream
    if (audioStreamer) {
      await audioStreamer.stop();
    }

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
    return { success: true };
  } catch (error) {
    sendLog(`Stop error: ${error.message}`, 'error');
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

    stereoFFmpegProcesses.left = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'dshow',
      '-i', 'audio=virtual-audio-capturer',
      '-af', 'pan=mono|c0=c0',  // Extract left channel
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '1',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      'rtsp://localhost:8554/left'
    ], { stdio: 'pipe' });

    stereoFFmpegProcesses.left.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        sendLog(`FFmpeg LEFT: ${msg}`, 'error');
      }
    });

    await new Promise(r => setTimeout(r, 2000));
    sendLog('LEFT channel streaming', 'success');

    // 3. Start FFmpeg for RIGHT channel
    sendLog('Starting FFmpeg RIGHT channel...');

    stereoFFmpegProcesses.right = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'dshow',
      '-i', 'audio=virtual-audio-capturer',
      '-af', 'pan=mono|c0=c1',  // Extract right channel
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '1',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      'rtsp://localhost:8554/right'
    ], { stdio: 'pipe' });

    stereoFFmpegProcesses.right.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        sendLog(`FFmpeg RIGHT: ${msg}`, 'error');
      }
    });

    await new Promise(r => setTimeout(r, 2000));
    sendLog('RIGHT channel streaming', 'success');

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

    // Stop casting to both speakers
    if (leftSpeaker) {
      await runPython(['stop', leftSpeaker.name]).catch(() => {});
    }
    if (rightSpeaker) {
      await runPython(['stop', rightSpeaker.name]).catch(() => {});
    }

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
    return { success: true };

  } catch (error) {
    sendLog(`Stop failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Volume control
ipcMain.handle('set-volume', async (event, speakerName, volume) => {
  try {
    const result = await runPython(['set-volume', speakerName, String(volume)]);
    if (result.success) {
      sendLog(`Volume set to ${Math.round(volume * 100)}% on "${speakerName}"`, 'success');
    } else {
      sendLog(`Volume set failed: ${result.error}`, 'error');
    }
    return result;
  } catch (error) {
    sendLog(`Volume control error: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-volume', async (event, speakerName) => {
  try {
    const result = await runPython(['get-volume', speakerName]);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// App lifecycle
app.whenReady().then(() => {
  // Kill any leftover processes from previous runs (port conflicts, etc.)
  killLeftoverProcesses();
  createWindow();

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  cleanup();
  // Force kill any leftover processes by name (belt and suspenders)
  killLeftoverProcesses();
});
