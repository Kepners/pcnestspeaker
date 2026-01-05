/**
 * PC Nest Speaker - Main Process
 * Nice Electron UI + Python pychromecast for actual casting (it works with Nest!)
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { AudioStreamer } = require('./audio-streamer');

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

// Bundled webrtc-streamer path
const WEBRTC_STREAMER_PATH = path.join(__dirname, '../../webrtc-streamer-v0.8.14-dirty-Windows-AMD64-Release/bin/webrtc-streamer.exe');

// Kill any leftover processes from previous runs (called on startup)
function killLeftoverProcesses() {
  console.log('[Main] Killing any leftover processes...');

  if (process.platform === 'win32') {
    try {
      // Kill any existing webrtc-streamer processes
      execSync('taskkill /F /IM webrtc-streamer.exe 2>nul', { stdio: 'ignore' });
      console.log('[Main] Killed leftover webrtc-streamer');
    } catch (e) {
      // Process not running - that's fine
    }

    try {
      // Kill any localtunnel processes
      execSync('taskkill /F /IM lt.exe 2>nul', { stdio: 'ignore' });
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

  // Stop webrtc-streamer (WebRTC mode)
  if (webrtcStreamerProcess) {
    sendLog('Stopping webrtc-streamer...');
    try {
      // Kill the process tree on Windows
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${webrtcStreamerProcess.pid} /F /T`, { stdio: 'ignore' });
      } else {
        webrtcStreamerProcess.kill('SIGTERM');
      }
    } catch (e) {
      // Process may already be dead
    }
    webrtcStreamerProcess = null;
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
    webrtcStreamer: false,
    ffmpeg: true // Assume bundled FFmpeg is always available
  };

  // Check VB-CABLE
  deps.vbcable = await checkAudioDeviceExists('cable output');

  // Check screen-capture-recorder (virtual-audio-capturer)
  deps.screenCapture = await checkAudioDeviceExists('virtual-audio-capturer');

  // Check webrtc-streamer (bundled)
  deps.webrtcStreamer = fs.existsSync(WEBRTC_STREAMER_PATH);

  return deps;
}

// Start webrtc-streamer process
async function startWebRTCStreamer(audioDeviceIndex = 1) {
  if (webrtcStreamerProcess) {
    sendLog('webrtc-streamer already running');
    return true;
  }

  if (!fs.existsSync(WEBRTC_STREAMER_PATH)) {
    throw new Error('webrtc-streamer not found. Please reinstall the app.');
  }

  sendLog(`Starting webrtc-streamer with audio device ${audioDeviceIndex}...`);

  return new Promise((resolve, reject) => {
    // Spawn through shell to ensure proper Windows audio API access
    webrtcStreamerProcess = spawn(WEBRTC_STREAMER_PATH, [
      '-v',
      '-n', 'pcaudio',
      '-U', `audiocap://${audioDeviceIndex}`,
      '-a',  // Enable audio capture layer
      '-H', '0.0.0.0:8443'
    ], {
      cwd: path.dirname(WEBRTC_STREAMER_PATH),
      shell: true,
      env: { ...process.env }  // Explicitly inherit environment
    });

    let started = false;

    webrtcStreamerProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      sendLog(`[webrtc-streamer] ${msg.trim()}`);
      if (msg.includes('HTTP Listen')) {
        started = true;
        resolve(true);
      }
    });

    webrtcStreamerProcess.stderr.on('data', (data) => {
      sendLog(`[webrtc-streamer] ${data.toString().trim()}`);
    });

    webrtcStreamerProcess.on('error', (err) => {
      sendLog(`webrtc-streamer error: ${err.message}`, 'error');
      webrtcStreamerProcess = null;
      if (!started) reject(err);
    });

    webrtcStreamerProcess.on('close', (code) => {
      sendLog(`webrtc-streamer exited with code ${code}`);
      webrtcStreamerProcess = null;
      if (!started) reject(new Error(`webrtc-streamer exited with code ${code}`));
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!started && webrtcStreamerProcess) {
        resolve(true); // Assume started even without message
      }
    }, 10000);
  });
}

// Start localtunnel for HTTPS
async function startLocalTunnel(port = 8443) {
  if (localTunnelProcess && tunnelUrl) {
    sendLog(`Tunnel already running at ${tunnelUrl}`);
    return tunnelUrl;
  }

  sendLog('Starting localtunnel for HTTPS...');

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
      // WebRTC streaming modes

      // Determine audio device index
      let audioDeviceIndex = 1; // Default: virtual-audio-capturer

      if (streamingMode === 'webrtc-vbcable') {
        audioDeviceIndex = 3; // VB-CABLE Output
      } else if (audioDevice) {
        // Try to find the device index from FFmpeg
        if (!audioStreamer) {
          audioStreamer = new AudioStreamer();
        }
        const devices = await audioStreamer.getAudioDevices();
        const idx = devices.findIndex(d =>
          d.toLowerCase().includes('virtual-audio-capturer')
        );
        if (idx >= 0) audioDeviceIndex = idx;
      }

      // Start webrtc-streamer
      await startWebRTCStreamer(audioDeviceIndex);
      sendLog('webrtc-streamer started', 'success');

      // Start localtunnel for HTTPS
      const httpsUrl = await startLocalTunnel(8443);
      sendLog(`HTTPS tunnel ready: ${httpsUrl}`, 'success');

      // Launch custom receiver on Cast device with WebRTC URL
      // Look up speaker IP from cached discovery results for direct connection
      const speaker = discoveredSpeakers.find(s => s.name === speakerName);
      const speakerIp = speaker ? speaker.ip : null;

      sendLog(`Launching WebRTC receiver on ${speakerName}${speakerIp ? ` (${speakerIp})` : ''}...`);
      const args = ['webrtc-launch', speakerName, httpsUrl];
      if (speakerIp) args.push(speakerIp);
      const result = await runPython(args);

      if (result.success) {
        sendLog('WebRTC streaming started!', 'success');
        return { success: true, url: httpsUrl, mode: streamingMode };
      } else {
        // Stop services if casting failed
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
    sendLog(`webrtc-streamer: ${deps.webrtcStreamer ? 'OK' : 'Missing'}`);
    return deps;
  } catch (error) {
    sendLog(`Dependency check failed: ${error.message}`, 'error');
    return {
      vbcable: false,
      screenCapture: false,
      webrtcStreamer: false,
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

// App lifecycle
app.whenReady().then(() => {
  // Kill any leftover processes from previous runs (port conflicts, etc.)
  killLeftoverProcesses();
  createWindow();

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
