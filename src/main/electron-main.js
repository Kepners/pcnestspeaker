/**
 * PC Nest Speaker - Main Process
 * Nice Electron UI + Python pychromecast for actual casting (it works with Nest!)
 */

// Wrap console methods to catch EPIPE errors (Cursor/VSCode pipe issue)
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
console.log = (...args) => { try { originalLog(...args); } catch (e) { if (e.code !== 'EPIPE') throw e; } };
console.error = (...args) => { try { originalError(...args); } catch (e) { if (e.code !== 'EPIPE') throw e; } };
console.warn = (...args) => { try { originalWarn(...args); } catch (e) { if (e.code !== 'EPIPE') throw e; } };

// Also catch any uncaught EPIPE
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  require('fs').writeFileSync('crash.log', `${new Date().toISOString()}: ${err.stack}\n`, { flag: 'a' });
  process.exit(1);
});

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
const autoSyncManager = require('./auto-sync-manager');
const { setupFirewall } = require('./firewall-setup');
const dependencyInstaller = require('./dependency-installer');
const audioRouting = require('./audio-routing');  // Universal audio device control (SoundVolumeView)
const pcSpeakerDelay = require('./pc-speaker-delay');  // APO delay config writer
const hlsDirectServer = require('./hls-direct-server');  // Direct HLS bypass for TVs (avoids MediaMTX LL-HLS 7-segment requirement)

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
let currentConnectedSpeakers = []; // Track currently connected speakers for proper cleanup
let pcAudioEnabled = false; // true = also play on PC speakers (via Listen)
let virtualCaptureCmdId = null; // Cached Virtual Desktop Audio CAPTURE device ID for Listen
let autoSyncEnabled = false; // true = auto-adjust sync delay based on network conditions
let tvStreamingInProgress = false; // Prevent duplicate TV streaming operations

// Dependency download URLs
// NOTE: We use VB-CABLE which provides:
// - CABLE Input (RENDER) - where apps output to, Windows default
// - CABLE Output (CAPTURE) - what FFmpeg captures from, visible to Windows WASAPI
// VB-CABLE is REQUIRED for PC+Speakers mode (Listen to this device needs WASAPI-visible capture)
const DEPENDENCY_URLS = {
  'vb-cable': 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip',
  'virtual-audio': 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip',
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
let ffmpegWebrtcProcess = null;  // For mono speaker streaming (WebRTC/Opus)
let ffmpegTvProcess = null;       // For TV streaming (HLS/AAC) - SEPARATE to prevent collisions

// Flag to prevent cleanup when intentionally switching to stereo mode
let switchingToStereoMode = false;

// Background WebRTC pipeline status
let webrtcPipelineReady = false;
let webrtcPipelineError = null;

// Local HTTP works! NO TUNNEL NEEDED (see MISTAKES_LOG.md MISTAKE #1)
// Cast receivers CAN fetch from local network HTTP - tested and confirmed
const DISABLE_CLOUDFLARE = true;

// ===================
// Cast Receiver App IDs
// ===================
// Two receivers registered in Cast SDK Console (cast.google.com/publish):
// - AUDIO_APP_ID: Lean audio-only receiver for Nest speakers and groups (~260 lines)
// - VISUAL_APP_ID: Full receiver with ambient videos for TVs
// Both MUST be published for all Cast devices to work!
const AUDIO_APP_ID = '4B876246';   // PC Nest Speaker Audio (lean, no visuals)
const VISUAL_APP_ID = 'FCAA4619';  // PC Nest Speaker Visual (ambient videos)

/**
 * Determine which Cast receiver App ID to use based on device type.
 * - Audio devices (cast_type='audio'): Always use audio receiver
 * - Groups (cast_type='group'): Always use audio receiver
 * - TVs/displays (cast_type='cast'): Use visual receiver (with ambient videos)
 *
 * @param {Object} speaker - Speaker object from discovery
 * @param {boolean} forceAudio - Force audio receiver even for TVs
 * @returns {string} App ID to use
 */
function getReceiverAppId(speaker, forceAudio = false) {
  if (!speaker || !speaker.cast_type) {
    return AUDIO_APP_ID; // Default to audio receiver
  }

  // Groups and audio devices always use the lean audio receiver
  if (speaker.cast_type === 'audio' || speaker.cast_type === 'group') {
    return AUDIO_APP_ID;
  }

  // TVs/displays (cast_type='cast') use visual receiver unless forced
  if (speaker.cast_type === 'cast' && !forceAudio) {
    return VISUAL_APP_ID;
  }

  return AUDIO_APP_ID;
}

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

/**
 * Detect Windows playback devices (speakers) to identify real vs virtual audio
 * Returns list of devices with 'isVirtual' flag
 */
async function detectPlaybackDevices() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');

    // PowerShell script to list playback devices using Windows Core Audio API
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, int activationParams, out IntPtr ptr);
    int OpenPropertyStore(int access, out IPropertyStore props);
    int GetId(out IntPtr id);
    int GetState(out int state);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT propvar);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT propvar);
    int Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT {
    public short vt;
    public short r1, r2, r3;
    public IntPtr val1, val2;
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}

public static class AudioDeviceList {
    public static List<string> GetPlaybackDevices() {
        var devices = new List<string>();
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDeviceCollection collection;
        enumerator.EnumAudioEndpoints(0, 1, out collection); // 0=render, 1=active

        int count;
        collection.GetCount(out count);

        PROPERTYKEY nameKey = new PROPERTYKEY();
        nameKey.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        nameKey.pid = 14;

        for (int i = 0; i < count; i++) {
            IMMDevice device;
            collection.Item(i, out device);

            IPropertyStore props;
            device.OpenPropertyStore(0, out props);

            PROPVARIANT value;
            props.GetValue(ref nameKey, out value);
            string name = Marshal.PtrToStringUni(value.val1);
            if (!string.IsNullOrEmpty(name)) {
                devices.Add(name);
            }
        }
        return devices;
    }
}
"@
$devices = [AudioDeviceList]::GetPlaybackDevices()
$devices | ForEach-Object { Write-Output $_ }
`;

    const os = require('os');
    const scriptPath = path.join(os.tmpdir(), 'list-playback-devices.ps1');

    try {
      fs.writeFileSync(scriptPath, psScript, 'utf8');
    } catch (e) {
      console.error('[Main] Failed to write PowerShell script:', e.message);
      resolve([]);
      return;
    }

    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 10000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[Main] PowerShell error:', stderr || error.message);
          resolve([]);
          return;
        }

        const deviceNames = stdout.trim().split('\n').filter(d => d.trim());
        const virtualPatterns = [
          'virtual', 'cable', 'vb-audio', 'voicemeeter', 'screen capture'
        ];

        const devices = deviceNames.map(name => {
          const nameLower = name.toLowerCase();
          const isVirtual = virtualPatterns.some(p => nameLower.includes(p));
          return { name: name.trim(), isVirtual };
        });

        console.log('[Main] Detected playback devices:', devices);
        resolve(devices);
      }
    );
  });
}

/**
 * Check if user has real speakers (not just virtual audio)
 * Real speakers = HDMI, Realtek, speakers, headphones
 */
async function hasRealSpeakers() {
  const devices = await detectPlaybackDevices();
  const realDevices = devices.filter(d => !d.isVirtual);
  return {
    hasReal: realDevices.length > 0,
    realDevices: realDevices.map(d => d.name),
    allDevices: devices
  };
}

/**
 * First-run setup check
 * - If first run, detect the DEFAULT audio device (the one they actually hear from)
 * - Prompt for Equalizer APO with personalized instructions
 */
async function checkFirstRun() {
  const settings = settingsManager.getAllSettings();

  if (settings.firstRunComplete) {
    console.log('[Main] First run already complete, skipping setup');
    return false; // Not first run
  }

  console.log('[Main] First run detected - detecting DEFAULT audio device...');

  try {
    // Get the user's DEFAULT audio device (what they actually hear from)
    const defaultDevice = await audioDeviceManager.getCurrentAudioDevice();
    console.log('[Main] Default audio device:', defaultDevice);

    // Check if it's a virtual device (they wouldn't need APO)
    const virtualPatterns = ['virtual', 'cable', 'vb-audio', 'voicemeeter', 'screen capture'];
    const isVirtual = virtualPatterns.some(p => defaultDevice.toLowerCase().includes(p));

    // Save detected device to settings
    settingsManager.setSetting('detectedRealSpeakers', isVirtual ? [] : [defaultDevice]);

    if (!isVirtual) {
      console.log('[Main] Real audio device detected:', defaultDevice);
      // Send first-run event to renderer with device info
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('first-run-setup', {
          hasRealSpeakers: true,
          realSpeakers: [defaultDevice]
        });
      }
      return true; // First run with real speaker
    } else {
      console.log('[Main] Virtual device is default - skipping APO prompt');
      settingsManager.setSetting('firstRunComplete', true);
      return false;
    }
  } catch (err) {
    console.error('[Main] Failed to detect audio device:', err.message);
    // Still complete first-run, just without device detection
    settingsManager.setSetting('firstRunComplete', true);
    return false;
  }
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
    width: 600,
    height: 1080,
    minWidth: 560,
    minHeight: 900,
    resizable: true,
    frame: false,
    backgroundColor: '#FFFFFF',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged, // Disable DevTools in production builds
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Block DevTools keyboard shortcuts in production
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      // Block Ctrl+Shift+I, Ctrl+Shift+J, F12
      if (input.control && input.shift && (input.key.toLowerCase() === 'i' || input.key.toLowerCase() === 'j')) {
        event.preventDefault();
      }
      if (input.key === 'F12') {
        event.preventDefault();
      }
    });
  }

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

  // Reset PC audio mode
  if (pcAudioEnabled) {
    pcAudioEnabled = false;
    volumeSync.setPCSpeakerDevice(null);
    // Disable "Listen to this device" to restore normal audio routing
    audioRouting.disablePCSpeakersMode().catch(() => {});
  }

  // Restore original Windows audio output device (SYNC to ensure it completes before exit)
  try {
    const result = audioRouting.restoreOriginalDeviceSync();
    if (result.success) {
      sendLog(`Restored original audio output device: ${result.device}`);
    } else {
      sendLog(`Could not restore audio device: ${result.error}`, 'warning');
    }
  } catch (e) {
    sendLog(`Audio restore failed: ${e.message}`, 'warning');
  }

  // Reset APO sync delay to 0 (so PC speakers have no delay when app is closed)
  try {
    audioSyncManager.cleanup(); // This sets delay to 0
    sendLog('APO sync delay reset to 0');
  } catch (e) {
    // Silent fail - best effort cleanup
  }

  // CRITICAL: Disconnect Cast devices FIRST (before killing processes)
  // This ensures all Cast devices (TVs, speakers) properly stop playing
  // MUST use sync call - async daemon calls won't complete before app exits!
  if (currentConnectedSpeakers.length > 0) {
    sendLog(`Disconnecting ${currentConnectedSpeakers.length} speaker(s)...`);
    for (const speaker of currentConnectedSpeakers) {
      try {
        sendLog(`Disconnecting "${speaker.name}"...`);
        // ALWAYS use sync Python call for cleanup - daemon async won't complete before exit!
        const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
        const scriptPath = path.join(__dirname, 'cast-helper.py');
        // Use stop-fast if we have IP (faster), otherwise stop (slower but works)
        const stopCmd = speaker.ip
          ? `${pythonPath} "${scriptPath}" stop-fast "${speaker.name}" "${speaker.ip}"`
          : `${pythonPath} "${scriptPath}" stop "${speaker.name}"`;
        execSync(stopCmd, {
          timeout: 5000,
          windowsHide: true,
          stdio: 'ignore'
        });
        sendLog(`Disconnected "${speaker.name}"`);
      } catch (e) {
        sendLog(`Failed to disconnect "${speaker.name}": ${e.message}`, 'warning');
      }
    }
    currentConnectedSpeakers = [];
  }

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

  // Stop FFmpeg WebRTC publishing process (mono speakers)
  if (ffmpegWebrtcProcess) {
    sendLog('Stopping FFmpeg WebRTC stream...');
    try {
      ffmpegWebrtcProcess.kill();
    } catch (e) {
      // Process may already be dead
    }
    ffmpegWebrtcProcess = null;
  }

  // Stop FFmpeg TV/HLS process (separate from WebRTC)
  if (ffmpegTvProcess) {
    sendLog('Stopping FFmpeg TV/HLS stream...');
    try {
      ffmpegTvProcess.kill();
    } catch (e) {
      // Process may already be dead
    }
    ffmpegTvProcess = null;
  }

  // Also force kill ALL FFmpeg processes to ensure cleanup
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM ffmpeg.exe', { stdio: 'ignore', windowsHide: true });
    }
  } catch (e) {
    // Process may already be dead
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

  // Stop direct HLS server (used for TV streaming bypass)
  if (hlsDirectServer.isRunning()) {
    sendLog('Stopping direct HLS server...');
    hlsDirectServer.stop();
  }

  // Reset TV streaming flag
  tvStreamingInProgress = false;

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

  // Note: audioRouting.restoreOriginalDeviceSync() already called earlier in cleanup
  // audioDeviceManager is legacy - don't call its restore to avoid conflicts

  // CRITICAL: Disable "Listen to this device" to prevent audio routing issues
  // This ensures PC audio returns to normal when app closes
  try {
    audioRouting.disablePCSpeakersMode().catch(() => {
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
    vbcable: false,           // VB-CABLE (REQUIRED for PC+Speakers mode)
    virtualAudio: false,      // Legacy: virtual-audio-capturer (fallback)
    mediamtx: false,
    ffmpeg: true // Assume bundled FFmpeg is always available
  };

  // Get audio devices ONCE and check what we have
  try {
    if (!audioStreamer) audioStreamer = new AudioStreamer();
    const devices = await audioStreamer.getAudioDevices();

    // VB-CABLE is REQUIRED - check for VB-Audio specifically (not VoiceMeeter's CABLE 16, etc.)
    deps.vbcable = devices.some(d =>
      d.toLowerCase().includes('vb-audio virtual cable')
    );

    // Legacy fallback: virtual-audio-capturer from screen-capture-recorder
    deps.virtualAudio = devices.some(d =>
      d.toLowerCase().includes('virtual-audio-capturer') ||
      d.toLowerCase().includes('virtual desktop audio')
    );
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
      // BALANCED TIMING: Clock stability + Low latency
      // -thread_queue_size 512: Queue absorbs jitter without adding delay
      // -use_wallclock_as_timestamps: Stable clock prevents drift under CPU load
      // -aresample async=1: Handles timestamp irregularities
      '-thread_queue_size', '512',
      '-use_wallclock_as_timestamps', '1',
      '-fflags', '+genpts+discardcorrupt',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-rtbufsize', '64k',  // LOW LATENCY: Back to 64k
      // Input from DirectShow - 50ms for low latency
      '-f', 'dshow',
      '-audio_buffer_size', '50',  // LOW LATENCY: 50ms (not 100!)
      '-i', `audio=${audioDevice}`,
      // Audio processing - aresample ensures clean output timing
      '-af', `aresample=async=1:first_pts=0,volume=${boostLevel}`
    ];

    if (volumeBoostEnabled) {
      sendLog('[FFmpeg] Volume boost enabled (2.15x signal)');
    }

    // Add output settings with low-latency flags
    args.push(
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      // Opus low-latency settings (20ms frames for stability)
      '-application', 'lowdelay',
      '-frame_duration', '20',
      // Low-latency output flags
      '-flush_packets', '1',
      '-max_delay', '0',
      '-muxdelay', '0',
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
    // Save the user's current default audio device BEFORE we do anything
    // This will be restored when the app exits
    await audioRouting.saveOriginalDevice();

    // CRITICAL: Switch Windows audio to VB-Cable Input so audio flows through the virtual cable
    // FFmpeg captures from CABLE Output, so Windows must render to CABLE Input
    const vbCableInput = await audioRouting.findVirtualDevice();
    if (vbCableInput) {
      const deviceName = vbCableInput.name || vbCableInput;
      const switchResult = await audioRouting.setDefaultDevice(deviceName);
      if (switchResult.success) {
        sendLog(`[Background] Windows audio switched to: ${deviceName}`);
        // Notify renderer to refresh audio output list (pill should show VB-Cable as active)
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('audio-device-changed', deviceName);
        }
      } else {
        sendLog(`[Background] WARNING: Failed to switch to VB-Cable: ${switchResult.error}`, 'warning');
      }
    } else {
      sendLog('[Background] WARNING: VB-Cable Input not found - audio may not stream!', 'warning');
    }

    // Find the best audio device
    if (!audioStreamer) {
      audioStreamer = new AudioStreamer();
    }

    const devices = await audioStreamer.getAudioDevices();
    let audioDevice = 'CABLE Output (VB-Audio Virtual Cable)';

    // Prefer standard VB-CABLE (not 16ch variant or VoiceMeeter's CABLE 16)
    // First try non-16ch, then fallback to any VB-Audio output
    const vbDevice = devices.find(d => {
      const lower = d.toLowerCase();
      return lower.includes('vb-audio') && lower.includes('output') && !lower.includes('16');
    }) || devices.find(d => d.toLowerCase().includes('vb-audio') && d.toLowerCase().includes('output'));
    if (vbDevice) {
      audioDevice = vbDevice;
    } else {
      // Fallback to virtual-audio-capturer (won't work for PC+Speakers mode)
      const vacDevice = devices.find(d => d.toLowerCase().includes('virtual-audio-capturer'));
      if (vacDevice) {
        audioDevice = vacDevice;
        sendLog('[WARNING] Using virtual-audio-capturer - PC+Speakers mode will NOT work!', 'warning');
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
    // Check if trial has expired (bypass in dev mode)
    if (app.isPackaged && usageTracker.isTrialExpired()) {
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

    // Stop direct HLS server if running (from previous TV streaming)
    // This prevents TV from auto-picking up HLS stream when we're streaming to speakers
    if (hlsDirectServer.isRunning()) {
      sendLog('Stopping previous HLS server (switching from TV to speaker)...');
      hlsDirectServer.stop();
    }

    // Debug: Log discovered speakers and currently connected
    const targetSpeaker = discoveredSpeakers.find(s => s.name === speakerName);
    sendLog(`Target speaker: ${speakerName}, IP: ${targetSpeaker?.ip || 'NOT FOUND in cache'}`);
    sendLog(`Currently connected speakers: ${JSON.stringify(currentConnectedSpeakers)}`);
    sendLog(`Discovered speakers IPs: ${discoveredSpeakers.map(s => `${s.name}:${s.ip}`).join(', ')}`);

    // DISCONNECT any currently connected speakers BEFORE connecting to new one
    if (currentConnectedSpeakers.length > 0) {
      // FIX: Stop HLS server if running (switching FROM TV to speaker)
      if (hlsDirectServer.isRunning()) {
        sendLog('Stopping HLS server (switching away from TV)...');
        hlsDirectServer.stop();
        tvStreamingInProgress = false;
      }

      sendLog(`Disconnecting ${currentConnectedSpeakers.length} previous speaker(s)...`);
      for (const speaker of currentConnectedSpeakers) {
        try {
          sendLog(`Disconnecting "${speaker.name}" (IP: ${speaker.ip || 'unknown'})...`);
          let stopResult;
          let usedDaemon = false;

          if (daemonManager.isDaemonRunning()) {
            stopResult = await daemonManager.disconnectSpeaker(speaker.name);
            sendLog(`Daemon disconnect result: ${JSON.stringify(stopResult)}`);
            usedDaemon = true;

            // FIX: If daemon returns "Not connected", it means the device wasn't connected via daemon
            // (e.g., TV connected via HLS). Use stop-fast if IP available, else slow stop.
            if (stopResult && stopResult.message === 'Not connected') {
              if (speaker.ip) {
                sendLog(`Daemon has no connection - using stop-fast for actual disconnect...`);
                stopResult = await runPython(['stop-fast', speaker.name, speaker.ip]);
                sendLog(`Stop-fast result: ${JSON.stringify(stopResult)}`);
              } else {
                // No IP cached - fall back to slow stop (required for proper TV disconnect!)
                sendLog(`Daemon has no connection and no IP - using slow stop for actual disconnect...`);
                stopResult = await runPython(['stop', speaker.name]);
                sendLog(`Stop result: ${JSON.stringify(stopResult)}`);
              }
            }
          } else if (speaker.ip) {
            // Use fast stop with cached IP (no network scan needed)
            sendLog(`Using stop-fast with IP ${speaker.ip}...`);
            stopResult = await runPython(['stop-fast', speaker.name, speaker.ip]);
            sendLog(`Stop-fast result: ${JSON.stringify(stopResult)}`);
          } else {
            // Fallback to slow stop if no IP cached
            sendLog(`No IP cached, using slow stop...`);
            stopResult = await runPython(['stop', speaker.name]);
            sendLog(`Stop result: ${JSON.stringify(stopResult)}`);
          }
          if (stopResult && stopResult.success) {
            sendLog(`Disconnected "${speaker.name}" successfully`, 'success');
          } else {
            sendLog(`Disconnect "${speaker.name}" failed: ${stopResult?.error || 'unknown error'}`, 'warning');
          }
        } catch (e) {
          sendLog(`Failed to disconnect "${speaker.name}": ${e.message}`, 'warning');
        }
      }
      currentConnectedSpeakers = [];
    }

    // NOTE: Device switching is now SEPARATE from streaming!
    // Use cast-mode toggle to control PC speaker output independently.
    // Streaming always captures from virtual-audio-capturer.

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

        // Track connected speaker for proper cleanup
        const speaker = discoveredSpeakers.find(s => s.name === speakerName);
        currentConnectedSpeakers = [{ name: speakerName, ip: speaker?.ip }];

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
              // Also set PC speaker volume if PC audio mode is on
              if (pcAudioEnabled) {
                volumeSync.setPCSpeakerVolume(volume).catch(() => {});
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

          // Start auto-sync if PC speaker mode is ON (they're coupled)
          if ((autoSyncEnabled || pcAudioEnabled) && speaker?.ip) {
            autoSyncEnabled = true; // Ensure flag is set
            autoSyncManager.start({ name: speaker.name, ip: speaker.ip });
            // Set baseline from current delay - CRITICAL for auto-sync to work!
            await autoSyncManager.setBaseline();
            sendLog(`Auto-sync monitoring "${speaker.name}" for sync drift`);
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

      // CRITICAL: Get speaker info FIRST to determine mode BEFORE using pre-started pipeline
      // This prevents the "double audio" bug where mono starts, then switches to stereo
      sendLog(`[DEBUG] Looking for speaker "${speakerName}" in ${discoveredSpeakers.length} discovered speakers`);
      const speaker = discoveredSpeakers.find(s => s.name === speakerName);
      sendLog(`[DEBUG] Found speaker: ${speaker ? JSON.stringify({name: speaker.name, cast_type: speaker.cast_type}) : 'NOT FOUND'}`);
      const speakerIp = speaker ? speaker.ip : null;
      const isGroup = speaker && speaker.cast_type === 'group';
      const isTv = speaker && speaker.cast_type === 'cast';  // TVs, Shields, displays use cast_type='cast'
      const speakerModel = speaker ? speaker.model : '';
      const isShield = speakerModel.toLowerCase().includes('shield');
      sendLog(`[DEBUG] isGroup=${isGroup}, isTv=${isTv}, isShield=${isShield}, speakerIp=${speakerIp}`);

      // For GROUPS: Skip mono pipeline entirely - go straight to stereo mode
      // This prevents the audio glitch where mono plays then cuts to stereo
      if (isGroup) {
        sendLog(`🎵 Cast Group detected - skipping mono pipeline, going direct to stereo...`);
        // Jump straight to group handling (which will set up stereo FFmpeg)
        // MediaMTX still needed for stereo streams
        if (!mediamtxProcess) {
          await startMediaMTX();
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      // For MONO speakers: Check if pipeline was pre-started in background
      else if (webrtcPipelineReady && mediamtxProcess && ffmpegWebrtcProcess) {
        sendLog('Using pre-started WebRTC pipeline', 'success');

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
        // VB-CABLE is REQUIRED for PC+Speakers mode (Listen to this device needs WASAPI-visible capture)
        let audioDeviceName = 'CABLE Output (VB-Audio Virtual Cable)'; // Default to VB-CABLE

        if (!audioStreamer) {
          audioStreamer = new AudioStreamer();
        }
        const devices = await audioStreamer.getAudioDevices();
        sendLog(`Available DirectShow audio devices: ${devices.join(', ')}`);

        // Prefer standard VB-CABLE (not 16ch variant or VoiceMeeter's CABLE 16)
        const vbDevice = devices.find(d => {
          const lower = d.toLowerCase();
          return lower.includes('vb-audio') && lower.includes('output') && !lower.includes('16');
        }) || devices.find(d => d.toLowerCase().includes('vb-audio') && d.toLowerCase().includes('output'));
        if (vbDevice) {
          audioDeviceName = vbDevice;
          sendLog(`Found VB-CABLE: "${audioDeviceName}"`);
        } else {
          sendLog('[WARNING] VB-CABLE (VB-Audio Virtual Cable) not found! PC+Speakers mode will NOT work.', 'warning');
          // Fallback to virtual-audio-capturer (Cast Only mode will work)
          const vacDevice = devices.find(d =>
            d.toLowerCase().includes('virtual-audio-capturer') ||
            d.toLowerCase().includes('virtual desktop audio')
          );
          if (vacDevice) {
            audioDeviceName = vacDevice;
            sendLog(`Using fallback device: "${audioDeviceName}" - PC+Speakers mode disabled`, 'warning');
          } else {
            sendLog('[ERROR] No virtual audio capture device found!', 'error');
            sendLog('[ERROR] Please install VB-CABLE from: https://vb-audio.com/Cable/', 'error');
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
      // NOTE: speaker, isGroup, isTv, isShield already determined above (early detection)

      let result;

      // TVs (including NVIDIA Shield): Use HLS with Visual receiver (WebRTC doesn't work on TVs)
      // ChromeCast/TVs don't support WebRTC in receivers - only HLS/DASH/MP4
      // BYPASS: Use direct FFmpeg HLS output to avoid MediaMTX's LL-HLS 7-segment requirement
      if (isTv) {
        // PREVENT DUPLICATE: Check if TV streaming is already in progress
        if (tvStreamingInProgress) {
          sendLog(`📺 TV streaming already in progress, skipping duplicate request`, 'warning');
          return { success: true, mode: 'hls', duplicate: true };
        }
        tvStreamingInProgress = true;

        const tvVisualsEnabled = settingsManager.getSetting('tvVisualsEnabled') !== false; // Default ON
        const deviceIcon = isShield ? '🎮' : '📺';
        const deviceType = isShield ? 'NVIDIA Shield' : 'TV';
        sendLog(`${deviceIcon} Detected ${deviceType}: "${speakerName}" (${speakerModel})`, 'info');

        // TVs don't support WebRTC in Cast receivers - use HLS
        // Visual receiver now supports HLS with ambient videos!
        const useVisualReceiver = tvVisualsEnabled;
        const receiverMode = useVisualReceiver ? 'Visual receiver (ambient videos)' : 'Default Media Receiver';
        sendLog(`${deviceIcon} Using direct HLS with ${receiverMode} (bypassing MediaMTX LL-HLS)...`);

        // Kill any existing FFmpeg processes (mono speaker OR previous TV)
        if (ffmpegWebrtcProcess) {
          sendLog('📺 Stopping previous mono FFmpeg...');
          try {
            ffmpegWebrtcProcess.kill('SIGTERM');
          } catch (e) {}
          ffmpegWebrtcProcess = null;
        }
        if (ffmpegTvProcess) {
          sendLog('📺 Stopping previous TV FFmpeg...');
          try {
            ffmpegTvProcess.kill('SIGTERM');
          } catch (e) {}
          ffmpegTvProcess = null;
        }
        await new Promise(r => setTimeout(r, 500));

        // Start direct HLS server (bypasses MediaMTX's LL-HLS segment requirements)
        const hlsServer = hlsDirectServer.start();
        const hlsOutputDir = hlsDirectServer.getOutputDir();
        sendLog(`📺 Direct HLS server started on port ${hlsServer.port}`);

        // Start FFmpeg with DIRECT HLS output (not via RTSP→MediaMTX)
        // This completely bypasses MediaMTX for TV streaming
        const ffmpegPath = getFFmpegPath();
        const volumeBoostEnabled = settingsManager.getSetting('volumeBoost');
        const boostLevel = volumeBoostEnabled ? 1.25 : 1.03;

        // CRITICAL: Save original device and switch Windows audio to VB-Cable
        // This routes Windows audio through VB-Cable so FFmpeg can capture it
        await audioRouting.saveOriginalDevice();
        const vbCableInput = await audioRouting.findVirtualDevice();
        if (vbCableInput) {
          const deviceName = vbCableInput.name || vbCableInput;
          const switchResult = await audioRouting.setDefaultDevice(deviceName);
          if (switchResult.success) {
            sendLog(`📺 Windows audio switched to: ${deviceName}`);
            // Notify renderer to refresh audio output UI
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('audio-device-changed', deviceName);
            }

            // WALL OF SOUND: Enable PC speakers IMMEDIATELY after VB-Cable switch
            // This ensures user hears audio while TV is connecting (can take 30+ seconds!)
            if (pcAudioEnabled) {
              sendLog(`📺 Enabling Wall of Sound early (PC speakers)...`);
              const earlyWosResult = await audioRouting.enablePCSpeakersMode();
              if (earlyWosResult.success) {
                sendLog(`📺 Wall of Sound active: ${earlyWosResult.device}`, 'success');
              }
            }
          } else {
            sendLog(`📺 WARNING: Failed to switch to VB-Cable: ${switchResult.error}`, 'warning');
          }
        } else {
          sendLog('📺 WARNING: VB-Cable Input not found - audio may not stream!', 'warning');
        }

        // Get audio device for FFmpeg capture - prefer standard VB-Audio (not 16ch or VoiceMeeter)
        if (!audioStreamer) audioStreamer = new AudioStreamer();
        const tvDevices = await audioStreamer.getAudioDevices();
        const tvVbDevice = tvDevices.find(d => {
          const lower = d.toLowerCase();
          return lower.includes('vb-audio') && lower.includes('output') && !lower.includes('16');
        }) || tvDevices.find(d => d.toLowerCase().includes('vb-audio') && d.toLowerCase().includes('output'));
        const tvAudioDevice = tvVbDevice || 'CABLE Output (VB-Audio Virtual Cable)';
        sendLog(`📺 FFmpeg capture device: ${tvAudioDevice}`);

        const hlsOutputPath = path.join(hlsOutputDir, 'stream.m3u8');

        // FFmpeg direct HLS output - bypasses MediaMTX entirely for TVs
        // Settings tuned for TV playback (not ultra-low-latency like speakers)
        const ffmpegArgs = [
          '-hide_banner', '-stats',
          // Input: DirectShow audio capture with proper buffer settings
          // CRITICAL: -audio_buffer_size prevents capture issues (default 500ms is too high)
          '-f', 'dshow',
          '-audio_buffer_size', '100',  // 100ms buffer for stability (TV doesn't need ultra-low)
          '-i', `audio=${tvAudioDevice}`,
          // Ensure monotonic timestamps under CPU load
          '-async', '1',
          // Audio processing
          '-af', `volume=${boostLevel}`,
          // AAC codec for HLS compatibility
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '48000',
          '-ac', '2',
          // HLS output settings (NOT going through MediaMTX)
          '-f', 'hls',
          '-hls_time', '2',           // 2 second segments
          '-hls_list_size', '5',      // Keep 5 segments in playlist
          '-hls_flags', 'delete_segments+append_list',  // Clean up old segments
          '-hls_segment_filename', path.join(hlsOutputDir, 'segment%03d.ts'),
          hlsOutputPath
        ];

        // Log FULL command for debugging
        sendLog(`📺 FFmpeg HLS command: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);

        ffmpegTvProcess = spawn(ffmpegPath, ffmpegArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });

        // CRITICAL: Handle spawn errors (missing ffmpeg, permissions, etc.)
        ffmpegTvProcess.on('error', (err) => {
          sendLog(`📺 FFmpeg SPAWN ERROR: ${err.message}`, 'error');
          tvStreamingInProgress = false;
          ffmpegTvProcess = null;
        });

        // CRITICAL: Handle unexpected exits
        ffmpegTvProcess.on('close', (code) => {
          if (code !== 0 && code !== null) {
            sendLog(`📺 FFmpeg exited unexpectedly with code ${code}`, 'warning');
          }
          ffmpegTvProcess = null;
        });

        // IMPROVED: Log ALL FFmpeg HLS output for debugging
        let hlsSegmentCreated = false;
        let ffmpegStartupLineCount = 0;
        ffmpegTvProcess.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (streamStats) streamStats.parseFfmpegOutput(msg);

          // Log FIRST 10 lines to see FFmpeg startup info
          ffmpegStartupLineCount++;
          if (ffmpegStartupLineCount <= 10) {
            sendLog(`[FFmpeg HLS] ${msg.substring(0, 200)}`);
          }

          // Log all HLS-related messages
          if (msg.includes('segment') || msg.includes('.ts') || msg.includes('.m3u8')) {
            sendLog(`[FFmpeg HLS] ${msg}`);
            hlsSegmentCreated = true;
          }
          if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid') || msg.includes('not found')) {
            sendLog(`[FFmpeg HLS ERROR] ${msg}`, 'error');
          }
          // Log input/output info
          if (msg.includes('Input #') || msg.includes('Output #') || msg.includes('Stream mapping')) {
            sendLog(`[FFmpeg HLS] ${msg}`);
          }
        });

        // Wait for FFmpeg to create initial HLS segments
        sendLog('📺 Waiting for HLS segments to be created...');
        await new Promise(r => setTimeout(r, 4000)); // HLS needs time to create segments

        // VERIFY: Check that HLS files actually exist before casting
        const fs = require('fs');
        if (fs.existsSync(hlsOutputPath)) {
          const m3u8Content = fs.readFileSync(hlsOutputPath, 'utf8');
          sendLog(`📺 HLS playlist exists (${m3u8Content.length} bytes)`);
          if (m3u8Content.includes('.ts')) {
            sendLog(`📺 HLS segments found in playlist`);
          } else {
            sendLog(`📺 WARNING: No .ts segments in playlist yet`, 'warning');
          }
        } else {
          sendLog(`📺 WARNING: HLS playlist not found at ${hlsOutputPath}`, 'warning');
          sendLog(`📺 Waiting additional 3 seconds...`);
          await new Promise(r => setTimeout(r, 3000));
        }

        const localIp = getLocalIp();
        const hlsUrl = hlsDirectServer.getHlsUrl(localIp);
        sendLog(`📺 Direct HLS URL: ${hlsUrl}`);

        // Cast HLS to TV - use Visual Receiver for branding/splash
        // Visual Receiver hosted at: https://kepners.github.io/pcnestspeaker/receiver-visual.html
        // Args: hls-cast <name> <url> <ip|''> <model> <app_id>
        // Python handles timeout fallback to Default Media Receiver if Visual hangs
        const hlsReceiverAppId = VISUAL_APP_ID;
        sendLog(`${deviceIcon} Using Visual Receiver (${VISUAL_APP_ID}) - splash + ambient photos`);
        const args = ['hls-cast', speakerName, hlsUrl, speakerIp || '', speakerModel || 'unknown', hlsReceiverAppId];
        result = await runPython(args);

        // Log detailed result from Python (helps debug TV streaming issues)
        sendLog(`📺 HLS cast result: success=${result.success}, state=${result.state || 'N/A'}, mode=${result.mode || 'N/A'}`);
        if (result.error) {
          sendLog(`📺 HLS cast error: ${result.error}`, 'warning');
        }

        if (result.success) {
          const modeDesc = `HLS (${result.state || 'started'})`;
          sendLog(`${deviceIcon} Streaming to ${deviceType} started! (${modeDesc})`, 'success');
          trayManager.updateTrayState(true);
          usageTracker.startTracking();

          // Start Windows volume sync for TV
          if (speaker) {
            volumeSync.startMonitoring(
              [{ name: speaker.name, ip: speaker.ip }],
              (volume) => {
                if (settingsManager.getSetting('volumeBoost')) return;
                sendLog(`[VolumeSync] Windows volume: ${volume}%`);
                if (daemonManager.isDaemonRunning()) {
                  daemonManager.setVolumeFast(speaker.name, volume / 100, speaker.ip || null).catch(() => {});
                } else {
                  runPython(['set-volume-fast', speaker.name, (volume / 100).toString(), speaker.ip || '']).catch(() => {});
                }
                // Also set PC speaker volume if PC audio mode is on
                if (pcAudioEnabled) {
                  volumeSync.setPCSpeakerVolume(volume).catch(() => {});
                }
              }
            );
          }

          // CRITICAL: Add TV to connected speakers so it gets disconnected when switching!
          currentConnectedSpeakers = [{ name: speakerName, ip: speakerIp }];
          sendLog(`📺 TV added to connected speakers: ${speakerName} (IP: ${speakerIp || 'MISSING - will use slow stop'})`);
          if (!speakerIp) {
            sendLog(`📺 WARNING: TV IP not cached - disconnect will be slower`, 'warning');
          }

          // WALL OF SOUND FIX: Re-enable PC speakers if they were on
          // Switching devices can disrupt "Listen to this device" - ensure it's restored
          if (pcAudioEnabled) {
            sendLog(`📺 Restoring Wall of Sound (PC speakers)...`);
            const wosResult = await audioRouting.enablePCSpeakersMode();
            if (wosResult.success) {
              sendLog(`📺 Wall of Sound restored: ${wosResult.device} (verified: ${wosResult.verified || false})`, 'success');
            } else {
              sendLog(`📺 Wall of Sound FAILED: ${wosResult.error}`, 'error');
            }

            // Start auto-sync for TV too - PC speaker delay still needs network monitoring
            if (speaker?.ip) {
              autoSyncEnabled = true;
              autoSyncManager.start({ name: speaker.name, ip: speaker.ip });
              await autoSyncManager.setBaseline();
              sendLog(`📺 Auto-sync monitoring "${speaker.name}" for sync drift (TV mode)`);
            }
          } else {
            sendLog(`📺 Wall of Sound not active (pcAudioEnabled=false)`);
          }

          return { success: true, mode: 'hls', url: hlsUrl };
        } else {
          tvStreamingInProgress = false; // Reset on failure
          throw new Error(result.error || 'Failed to start HLS streaming to TV');
        }
      }

      // SHIELD: Now handled above with TVs - uses HLS fallback when Visual receiver fails

      if (isGroup) {
        // Cast Groups don't work with custom receivers - only leader plays!
        // Solution: Get group members and use STEREO for 2-member groups, multicast for 3+
        sendLog(`Detected Cast Group: "${speakerName}"...`);

        // Get group members
        const membersResult = await runPython(['get-group-members', speakerName]);
        if (!membersResult.success || !membersResult.members || membersResult.members.length === 0) {
          sendLog(`Could not get group members: ${membersResult.error || 'No members found'}`, 'warning');
          sendLog('Falling back to single cast (will only play on leader)...', 'warning');
          // Fall back to regular launch - use audio receiver for groups
          const appId = getReceiverAppId(speaker);
          const args = ['webrtc-launch', speakerName, webrtcUrl];
          if (speakerIp) args.push(speakerIp);
          args.push('pcaudio');
          args.push(appId);
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

          // Determine audio device - prefer standard VB-Audio (not 16ch or VoiceMeeter)
          if (!audioStreamer) audioStreamer = new AudioStreamer();
          const availableDevices = await audioStreamer.getAudioDevices();
          const vbDevice = availableDevices.find(d => {
            const lower = d.toLowerCase();
            return lower.includes('vb-audio') && lower.includes('output') && !lower.includes('16');
          }) || availableDevices.find(d => d.toLowerCase().includes('vb-audio') && d.toLowerCase().includes('output'));
          const stereoAudioDevice = vbDevice || 'CABLE Output (VB-Audio Virtual Cable)';
          sendLog(`Stereo audio device: ${stereoAudioDevice}`);

          // CRITICAL: DirectShow devices can only be opened ONCE!
          // Use SINGLE FFmpeg with filter_complex for L/R split + dual RTSP output
          sendLog('Starting FFmpeg stereo split (single capture, dual output)...');
          stereoFFmpegProcesses.left = spawn(ffmpegPath, [
            '-hide_banner', '-stats',
            // BALANCED: Clock stability WITHOUT sacrificing latency
            '-thread_queue_size', '512',
            '-use_wallclock_as_timestamps', '1',
            '-fflags', '+genpts+discardcorrupt',
            '-flags', 'low_delay',
            '-probesize', '32',
            '-analyzeduration', '0',
            '-rtbufsize', '64k',  // LOW LATENCY
            '-f', 'dshow',
            '-audio_buffer_size', '50',  // LOW LATENCY: 50ms
            '-i', `audio=${stereoAudioDevice}`,
            // Stereo split with aresample for clean timing
            '-filter_complex', `[0:a]aresample=async=1:first_pts=0[resampled];[resampled]pan=mono|c0=c0,volume=${boostLevel}[left];[resampled]pan=mono|c0=c1,volume=${boostLevel}[right]`,
            // Left output with low-latency flags
            '-map', '[left]', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
            '-application', 'lowdelay', '-frame_duration', '20',
            '-flush_packets', '1', '-max_delay', '0', '-muxdelay', '0',
            '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://localhost:8554/left',
            // Right output with low-latency flags
            '-map', '[right]', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
            '-application', 'lowdelay', '-frame_duration', '20',
            '-flush_packets', '1', '-max_delay', '0', '-muxdelay', '0',
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

          // Connect BOTH speakers in PARALLEL for better L/R sync
          // Sequential connection causes LEFT to start playing before RIGHT
          sendLog(`Connecting LEFT + RIGHT speakers in parallel...`);
          const [leftResult, rightResult] = await Promise.all([
            runPython([
              'webrtc-launch',
              leftMember.name,
              stereoUrl,
              leftMember.ip || '',
              'left',
              AUDIO_APP_ID
            ]),
            runPython([
              'webrtc-launch',
              rightMember.name,
              stereoUrl,
              rightMember.ip || '',
              'right',
              AUDIO_APP_ID
            ])
          ]);

          if (!leftResult.success) {
            throw new Error(`Left speaker failed: ${leftResult.error}`);
          }
          if (!rightResult.success) {
            throw new Error(`Right speaker failed: ${rightResult.error}`);
          }
          sendLog(`LEFT + RIGHT speakers connected in sync`, 'success');

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

          // Multicast to groups always uses audio receiver
          const multicastArgs = [
            'webrtc-multicast',
            JSON.stringify(memberNames),
            webrtcUrl,
            JSON.stringify(memberIps),
            'pcaudio',
            AUDIO_APP_ID  // Groups always use audio receiver
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
        // Determine which receiver to use based on device type
        const appId = getReceiverAppId(speaker);
        sendLog(`Connecting to ${speakerName}${speakerIp ? ` (${speakerIp})` : ''} [Receiver: ${appId === VISUAL_APP_ID ? 'Visual' : 'Audio'}]...`);
        const args = ['webrtc-launch', speakerName, webrtcUrl];
        if (speakerIp) args.push(speakerIp);
        args.push('pcaudio'); // stream name
        args.push(appId);     // receiver app id
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

        // Track connected speaker(s) for proper cleanup
        currentConnectedSpeakers = speakersToSync.length > 0
          ? speakersToSync
          : [{ name: speakerName, ip: speaker?.ip }];

        if (speakersToSync.length > 0) {
          volumeSync.startMonitoring(
            speakersToSync,
            (volume) => {
              // If boost is enabled, don't sync - speaker stays at 100%
              if (settingsManager.getSetting('volumeBoost')) {
                return; // Skip sync when boost is on
              }
              sendLog(`[VolumeSync] Windows volume: ${volume}%`);
              // Set volume on all Nest speakers
              speakersToSync.forEach(spk => {
                if (daemonManager.isDaemonRunning()) {
                  daemonManager.setVolumeFast(spk.name, volume / 100, spk.ip || null).catch(() => {});
                } else {
                  runPython(['set-volume-fast', spk.name, (volume / 100).toString(), spk.ip || '']).catch(() => {});
                }
              });
              // Also set PC speaker volume if PC audio mode is on
              if (pcAudioEnabled) {
                volumeSync.setPCSpeakerVolume(volume).catch(() => {});
              }
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

          // Start auto-sync if PC speaker mode is ON (they're coupled)
          // Use first speaker with IP for monitoring
          const speakerForSync = speakersToSync.find(s => s.ip) || speaker;
          if ((autoSyncEnabled || pcAudioEnabled) && speakerForSync?.ip) {
            autoSyncEnabled = true;
            autoSyncManager.start({ name: speakerForSync.name, ip: speakerForSync.ip });
            await autoSyncManager.setBaseline();
            sendLog(`Auto-sync monitoring "${speakerForSync.name}" for sync drift`);
          }
        }

        // WALL OF SOUND FIX: Re-enable PC speakers if they were on
        // Switching devices can disrupt "Listen to this device" - ensure it's restored
        if (pcAudioEnabled) {
          sendLog(`Restoring Wall of Sound (PC speakers)...`);
          await audioRouting.enablePCSpeakersMode();
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

        // Determine audio device - prefer standard VB-Audio (not 16ch or VoiceMeeter)
        let fallbackAudioDevice = 'CABLE Output (VB-Audio Virtual Cable)';
        const fbDevices = await audioStreamer.getAudioDevices();
        const fbVbDevice = fbDevices.find(d => {
          const lower = d.toLowerCase();
          return lower.includes('vb-audio') && lower.includes('output') && !lower.includes('16');
        }) || fbDevices.find(d => d.toLowerCase().includes('vb-audio') && d.toLowerCase().includes('output'));
        if (fbVbDevice) fallbackAudioDevice = fbVbDevice;

        sendLog(`Audio source: ${fallbackAudioDevice}`);
        const streamUrl = await audioStreamer.start(fallbackAudioDevice, 'mp3');
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
                // Also set PC speaker volume if PC audio mode is on
                if (pcAudioEnabled) {
                  volumeSync.setPCSpeakerVolume(volume).catch(() => {});
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
          // Determine which receiver to use based on device type
          const appId = getReceiverAppId(speaker);
          sendLog(`Connecting via tunnel to ${speakerName} [Receiver: ${appId === VISUAL_APP_ID ? 'Visual' : 'Audio'}]...`);
          const tunnelArgs = ['webrtc-launch', speakerName, httpsUrl];
          if (speakerIp) tunnelArgs.push(speakerIp);
          tunnelArgs.push('pcaudio'); // stream name
          tunnelArgs.push(appId);     // receiver app id
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
                  // Also set PC speaker volume if PC audio mode is on
                  if (pcAudioEnabled) {
                    volumeSync.setPCSpeakerVolume(volume).catch(() => {});
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

    // Disconnect all connected speakers (not just the one passed in)
    // This ensures Cast devices properly stop playing
    const speakersToDisconnect = currentConnectedSpeakers.length > 0
      ? currentConnectedSpeakers
      : (speakerName ? [{ name: speakerName }] : []);

    for (const speaker of speakersToDisconnect) {
      try {
        sendLog(`Disconnecting "${speaker.name}"...`);
        if (daemonManager.isDaemonRunning()) {
          await daemonManager.disconnectSpeaker(speaker.name);
        } else if (speaker.ip) {
          // Use stop-fast with cached IP for quick disconnection
          await runPython(['stop-fast', speaker.name, speaker.ip]);
        } else {
          // Fallback to slow stop if no IP cached
          await runPython(['stop', speaker.name]);
        }
      } catch (e) {
        sendLog(`Disconnect error for ${speaker.name}: ${e.message}`, 'warning');
      }
    }

    // Clear connected speakers tracking
    currentConnectedSpeakers = [];

    // Stop FFmpeg stream (audioStreamer is for WebRTC via MediaMTX)
    if (audioStreamer) {
      await audioStreamer.stop();
    }

    // CRITICAL: Also kill direct FFmpeg process (used for HLS TV streaming)
    if (ffmpegWebrtcProcess) {
      sendLog('Stopping FFmpeg HLS process...');
      try {
        ffmpegWebrtcProcess.kill('SIGTERM');
      } catch (e) {
        sendLog(`FFmpeg kill error: ${e.message}`, 'warning');
      }
      ffmpegWebrtcProcess = null;
    }

    // Stop stream stats
    if (streamStats) {
      streamStats.stop();
    }

    // Stop Windows volume sync
    volumeSync.stopMonitoring();

    // NOTE: Device switching is now SEPARATE from streaming!
    // Audio device state is managed by cast-mode toggle, not streaming start/stop.

    sendLog('Stopped', 'success');
    trayManager.updateTrayState(false); // Update tray to idle state
    usageTracker.stopTracking(); // Stop tracking usage time

    // Stop auto-sync monitoring (no longer streaming to any speaker)
    autoSyncManager.stop();

    // Stop direct HLS server if running (used for TV streaming)
    if (hlsDirectServer.isRunning()) {
      sendLog('Stopping direct HLS server...');
      hlsDirectServer.stop();
    }

    // Reset TV streaming flag
    tvStreamingInProgress = false;

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

    // Determine audio device - prefer standard VB-Audio (not 16ch or VoiceMeeter)
    if (!audioStreamer) audioStreamer = new AudioStreamer();
    const restartDevices = await audioStreamer.getAudioDevices();
    const restartVbDevice = restartDevices.find(d => {
      const lower = d.toLowerCase();
      return lower.includes('vb-audio') && lower.includes('output') && !lower.includes('16');
    }) || restartDevices.find(d => d.toLowerCase().includes('vb-audio') && d.toLowerCase().includes('output'));
    const audioDevice = restartVbDevice || 'CABLE Output (VB-Audio Virtual Cable)';
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

ipcMain.handle('quit-app', () => {
  sendLog('Quit requested - restoring audio and exiting...');
  app.isQuitting = true;
  cleanup();
  trayManager.destroyTray();
  app.quit();
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
    // Look up speaker to determine which receiver to use
    const speaker = discoveredSpeakers.find(s => s.name === speakerName);
    const appId = getReceiverAppId(speaker);
    sendLog(`[WebRTC] Launching receiver on "${speakerName}" [Receiver: ${appId === VISUAL_APP_ID ? 'Visual' : 'Audio'}]...`);

    const args = ['webrtc-launch', speakerName];
    args.push('');  // https_url (empty)
    args.push('');  // speaker_ip (empty)
    args.push('pcaudio');  // stream_name
    args.push(appId);  // app_id

    const result = await runPython(args);

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

    // Save stereo speakers for auto-connect on next startup
    settingsManager.setSetting('lastStereoSpeakers', {
      left: leftSpeaker,
      right: rightSpeaker
    });
    settingsManager.setSetting('lastMode', 'stereo');

    // DISCONNECT any currently connected speakers BEFORE connecting new L/R pair
    if (currentConnectedSpeakers.length > 0) {
      sendLog(`Disconnecting ${currentConnectedSpeakers.length} previous speaker(s)...`);
      for (const speaker of currentConnectedSpeakers) {
        try {
          sendLog(`Disconnecting "${speaker.name}" (IP: ${speaker.ip || 'unknown'})...`);
          let stopResult;
          if (daemonManager.isDaemonRunning()) {
            stopResult = await daemonManager.disconnectSpeaker(speaker.name);
            sendLog(`Daemon disconnect result: ${JSON.stringify(stopResult)}`);
          } else if (speaker.ip) {
            // Use fast stop with cached IP (no network scan needed)
            sendLog(`Using stop-fast with IP ${speaker.ip}...`);
            stopResult = await runPython(['stop-fast', speaker.name, speaker.ip]);
            sendLog(`Stop-fast result: ${JSON.stringify(stopResult)}`);
          } else {
            // Fallback to slow stop if no IP cached
            sendLog(`No IP cached, using slow stop...`);
            stopResult = await runPython(['stop', speaker.name]);
            sendLog(`Stop result: ${JSON.stringify(stopResult)}`);
          }
          if (stopResult && stopResult.success) {
            sendLog(`Disconnected "${speaker.name}" successfully`, 'success');
          } else {
            sendLog(`Disconnect "${speaker.name}" failed: ${stopResult?.error || 'unknown error'}`, 'warning');
          }
        } catch (e) {
          sendLog(`Failed to disconnect "${speaker.name}": ${e.message}`, 'warning');
        }
      }
      currentConnectedSpeakers = [];
    }

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

    // NOTE: Device switching is now SEPARATE from streaming!
    // Cast-mode toggle controls PC speaker output independently.

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

    // Determine audio device - prefer standard VB-Audio (not 16ch or VoiceMeeter)
    if (!audioStreamer) audioStreamer = new AudioStreamer();
    const stereoDevices2 = await audioStreamer.getAudioDevices();
    const stereoVbDevice2 = stereoDevices2.find(d => {
      const lower = d.toLowerCase();
      return lower.includes('vb-audio') && lower.includes('output') && !lower.includes('16');
    }) || stereoDevices2.find(d => d.toLowerCase().includes('vb-audio') && d.toLowerCase().includes('output'));
    const stereoDevice2 = stereoVbDevice2 || 'CABLE Output (VB-Audio Virtual Cable)';
    sendLog(`Stereo audio device: ${stereoDevice2}`);

    // Single FFmpeg process with filter_complex for L/R split + dual RTSP output
    stereoFFmpegProcesses.left = spawn(ffmpegPath, [
      '-hide_banner', '-stats',
      // BALANCED: Clock stability WITHOUT sacrificing latency
      '-thread_queue_size', '512',
      '-use_wallclock_as_timestamps', '1',
      '-fflags', '+genpts+discardcorrupt',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-rtbufsize', '64k',  // LOW LATENCY
      '-f', 'dshow',
      '-audio_buffer_size', '50',  // LOW LATENCY: 50ms
      '-i', `audio=${stereoDevice2}`,
      // Stereo split with aresample for clean timing
      '-filter_complex', `[0:a]aresample=async=1:first_pts=0[resampled];[resampled]pan=mono|c0=c0,volume=${boostLevel}[left];[resampled]pan=mono|c0=c1,volume=${boostLevel}[right]`,
      // Left output with low-latency flags
      '-map', '[left]', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
      '-application', 'lowdelay', '-frame_duration', '20',
      '-flush_packets', '1', '-max_delay', '0', '-muxdelay', '0',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://localhost:8554/left',
      // Right output with low-latency flags
      '-map', '[right]', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '1',
      '-application', 'lowdelay', '-frame_duration', '20',
      '-flush_packets', '1', '-max_delay', '0', '-muxdelay', '0',
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

    // 5+6. Cast to BOTH speakers in PARALLEL for better L/R sync
    // Sequential connection causes LEFT to start playing before RIGHT
    sendLog(`Connecting LEFT + RIGHT speakers in parallel...`);
    const [leftResult, rightResult] = await Promise.all([
      runPython([
        'webrtc-launch',
        leftSpeaker.name,
        webrtcUrl,
        leftSpeaker.ip || '',
        'left',
        AUDIO_APP_ID
      ]),
      runPython([
        'webrtc-launch',
        rightSpeaker.name,
        webrtcUrl,
        rightSpeaker.ip || '',
        'right',
        AUDIO_APP_ID
      ])
    ]);

    if (!leftResult.success) {
      throw new Error(`Left speaker cast failed: ${leftResult.error}`);
    }
    if (!rightResult.success) {
      throw new Error(`Right speaker cast failed: ${rightResult.error}`);
    }

    // Show verification status for both
    const leftStatus = leftResult.verified ? '✓ verified' :
      leftResult.warning === 'no_data' ? '⚠ no audio' :
      leftResult.warning === 'no_session' ? '⚠ no session' : 'connected';
    const rightStatus = rightResult.verified ? '✓ verified' :
      rightResult.warning === 'no_data' ? '⚠ no audio' :
      rightResult.warning === 'no_session' ? '⚠ no session' : 'connected';
    sendLog(`LEFT: ${leftStatus} | RIGHT: ${rightStatus}`, 'success');

    // Final status based on both speakers
    const bothVerified = leftResult.verified && rightResult.verified;
    if (bothVerified) {
      sendLog('✓ Stereo separation verified - both speakers playing!', 'success');
    } else {
      sendLog('Stereo mode started - verify audio on both speakers', 'success');
    }
    trayManager.updateTrayState(true); // Update tray to streaming state
    usageTracker.startTracking(); // Start tracking usage time

    // Track connected speakers for proper cleanup
    currentConnectedSpeakers = [
      { name: leftSpeaker.name, ip: leftSpeaker.ip },
      { name: rightSpeaker.name, ip: rightSpeaker.ip }
    ];

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
        // Also set PC speaker volume if PC audio mode is on
        if (pcAudioEnabled) {
          volumeSync.setPCSpeakerVolume(volume).catch(() => {});
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

    // Start auto-sync if PC speaker mode is ON (they're coupled)
    // Use left speaker for latency monitoring
    if ((autoSyncEnabled || pcAudioEnabled) && leftSpeaker?.ip) {
      autoSyncEnabled = true;
      autoSyncManager.start({ name: leftSpeaker.name, ip: leftSpeaker.ip });
      await autoSyncManager.setBaseline();
      sendLog(`Auto-sync monitoring "${leftSpeaker.name}" for sync drift (stereo mode)`);
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

    // Disconnect all connected speakers (use tracked speakers or passed-in)
    const speakersToDisconnect = currentConnectedSpeakers.length > 0
      ? currentConnectedSpeakers
      : [leftSpeaker, rightSpeaker].filter(Boolean);

    for (const speaker of speakersToDisconnect) {
      if (!speaker) continue;
      try {
        sendLog(`Disconnecting "${speaker.name}"...`);
        if (daemonManager.isDaemonRunning()) {
          await daemonManager.disconnectSpeaker(speaker.name).catch(() => {});
        } else if (speaker.ip) {
          // Use stop-fast with cached IP for quick disconnection
          await runPython(['stop-fast', speaker.name, speaker.ip]).catch(() => {});
        } else {
          await runPython(['stop', speaker.name]).catch(() => {});
        }
      } catch (e) {
        sendLog(`Disconnect error for ${speaker.name}: ${e.message}`, 'warning');
      }
    }

    // Clear connected speakers tracking
    currentConnectedSpeakers = [];

    // Stop stream stats
    if (streamStats) {
      streamStats.stop();
    }

    // Stop Windows volume sync
    volumeSync.stopMonitoring();

    // NOTE: Device switching is now SEPARATE from streaming!
    // Audio device state is managed by cast-mode toggle, not streaming start/stop.

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

// ========================================
// TV HLS Streaming (for NVIDIA Shield, Chromecast with screen)
// ========================================

// Track TV streaming state
let tvStreamingActive = false;
let tvStreamDevice = null;

ipcMain.handle('start-tv-streaming', async (event, deviceName, deviceIp = null) => {
  try {
    // Check if trial has expired (bypass in dev mode)
    if (app.isPackaged && usageTracker.isTrialExpired()) {
      const usage = usageTracker.getUsage();
      return {
        success: false,
        error: 'Trial expired',
        trialExpired: true,
        usageInfo: usage
      };
    }

    sendLog(`Starting TV streaming to "${deviceName}" via HLS...`);

    // NOTE: Device switching is now SEPARATE from streaming!
    // Cast-mode toggle controls PC speaker output independently.

    // 1. Start MediaMTX (if not already running) - HLS is enabled in config
    if (!mediamtxProcess) {
      await startMediaMTX();
      await new Promise(r => setTimeout(r, 3000)); // Wait for MediaMTX to be ready
    }

    // 2. Start FFmpeg to publish to RTSP (MediaMTX will create HLS from this)
    // Use SEPARATE ffmpegTvProcess to avoid collision with speaker streaming
    if (!ffmpegTvProcess) {
      sendLog('Starting FFmpeg for HLS stream (MediaMTX mode)...');
      const ffmpegPath = getFFmpegPath();
      const volumeBoostEnabled = settingsManager.getSetting('volumeBoost');
      const boostLevel = volumeBoostEnabled ? 1.25 : 1.03;

      // Determine audio device - prefer standard VB-Audio (not 16ch or VoiceMeeter)
      if (!audioStreamer) audioStreamer = new AudioStreamer();
      const hlsDevices = await audioStreamer.getAudioDevices();
      const hlsVbDevice = hlsDevices.find(d => {
        const lower = d.toLowerCase();
        return lower.includes('vb-audio') && lower.includes('output') && !lower.includes('16');
      }) || hlsDevices.find(d => d.toLowerCase().includes('vb-audio') && d.toLowerCase().includes('output'));
      const hlsAudioDevice = hlsVbDevice || 'CABLE Output (VB-Audio Virtual Cable)';
      sendLog(`HLS audio device: ${hlsAudioDevice}`);

      ffmpegTvProcess = spawn(ffmpegPath, [
        '-hide_banner', '-stats',
        '-f', 'dshow',
        '-i', `audio=${hlsAudioDevice}`,
        '-af', `volume=${boostLevel}`,
        '-c:a', 'aac', // HLS works better with AAC than Opus
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-f', 'rtsp',
        '-rtsp_transport', 'tcp',
        'rtsp://localhost:8554/pcaudio'
      ], { stdio: 'pipe', windowsHide: true });

      // Error handling for spawn
      ffmpegTvProcess.on('error', (err) => {
        sendLog(`FFmpeg HLS SPAWN ERROR: ${err.message}`, 'error');
        ffmpegTvProcess = null;
      });

      ffmpegTvProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          sendLog(`FFmpeg HLS exited unexpectedly with code ${code}`, 'warning');
        }
        ffmpegTvProcess = null;
      });

      ffmpegTvProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (streamStats) {
          streamStats.parseFfmpegOutput(msg);
        }
        if (msg.includes('Error') || msg.includes('error')) {
          sendLog(`FFmpeg HLS: ${msg}`, 'error');
        }
      });

      await new Promise(r => setTimeout(r, 2000));
    }

    // 3. Build HLS URL
    const localIp = getLocalIp();
    const hlsUrl = `http://${localIp}:8888/pcaudio/index.m3u8`;
    sendLog(`HLS URL: ${hlsUrl}`);

    // 4. Cast HLS to TV using Python
    sendLog(`Casting to TV: ${deviceName}...`);
    const result = await runPython([
      'hls-cast',
      deviceName,
      hlsUrl,
      deviceIp || ''
    ]);

    if (result.success) {
      sendLog('TV streaming started!', 'success');
      tvStreamingActive = true;
      tvStreamDevice = { name: deviceName, ip: deviceIp };
      trayManager.updateTrayState(true);
      usageTracker.startTracking();

      // Start stream stats
      if (streamStats) {
        streamStats.start();
      }

      return {
        success: true,
        url: hlsUrl,
        mode: 'hls',
        device: deviceName
      };
    } else {
      throw new Error(result.error);
    }

  } catch (error) {
    sendLog(`TV streaming failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-tv-streaming', async (event) => {
  try {
    sendLog('Stopping TV streaming...');

    // Stop casting on TV
    if (tvStreamDevice) {
      await runPython(['stop', tvStreamDevice.name]).catch(() => {});
      tvStreamDevice = null;
    }

    // Stop FFmpeg TV process (but keep MediaMTX running for potential speaker streaming)
    if (ffmpegTvProcess) {
      ffmpegTvProcess.kill('SIGTERM');
      ffmpegTvProcess = null;
    }

    // Stop stream stats
    if (streamStats) {
      streamStats.stop();
    }

    // NOTE: Device switching is now SEPARATE from streaming!
    // Audio device state is managed by cast-mode toggle, not streaming start/stop.

    tvStreamingActive = false;
    trayManager.updateTrayState(false);
    usageTracker.stopTracking();

    sendLog('TV streaming stopped', 'success');
    return { success: true };

  } catch (error) {
    sendLog(`Stop TV streaming failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-tv-streaming-status', () => {
  return {
    active: tvStreamingActive,
    device: tvStreamDevice
  };
});

// ========================================
// URL Casting (user provides URL, TV plays it directly)
// ========================================
ipcMain.handle('cast-url', async (event, deviceName, url, contentType = null, deviceIp = null) => {
  try {
    sendLog(`Casting URL to ${deviceName}...`);
    sendLog(`URL: ${url}`);

    // Validate URL format
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      sendLog('Invalid URL - must start with http:// or https://', 'error');
      return { success: false, error: 'Invalid URL format. Must start with http:// or https://' };
    }

    // Call Python cast-url command
    const args = ['cast-url', deviceName, url];
    if (contentType) args.push(contentType);
    else args.push('');  // Empty string for auto-detect
    if (deviceIp) args.push(deviceIp);

    const result = await runPython(args);

    if (result.success) {
      sendLog(`URL casting started on ${deviceName}!`, 'success');
      sendLog(`Content-Type: ${result.content_type}`);
    } else {
      sendLog(`URL casting failed: ${result.error}`, 'error');
    }

    return result;

  } catch (error) {
    sendLog(`Cast URL failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// ========================================
// Settings management
// ========================================
ipcMain.handle('get-settings', () => {
  return settingsManager.getAllSettings();
});

ipcMain.handle('update-settings', (event, updates) => {
  settingsManager.updateSettings(updates);
  return { success: true };
});

// Cast Mode handler - Switches Windows audio device when toggling while streaming
// "Speakers Only" = Audio only to Cast, no local playback
// "PC + Speakers" = Audio to Cast + local HDMI speakers (with APO delay for sync)
//
// ARCHITECTURE NOTE (January 2026):
// Cast capture and local playback are now FULLY SEPARATE:
// - Cast: Always captures from Virtual Desktop Audio (clean, no APO delay)
// - Local: Uses Windows audio routing (Stereo Mix or Voicemeeter) to HDMI with APO delay
//
// In "PC + Speakers" mode:
// - Windows stays on Virtual Desktop Audio for clean capture
// - Audio is MIRRORED to HDMI via Windows "Stereo Mix" → "Listen to this device"
// PC + Speakers mode:
// 1. Switches Windows default output to PC speakers (e.g., monitor HDMI, Realtek)
// 2. virtual-audio-capturer captures system audio (plays on PC speakers)
// 3. FFmpeg sends to Cast
// PC Audio toggle - simple on/off for "Listen to this device" feature
// ON: Enable Listen on VB-Cable Output -> PC speakers (with APO delay for sync)
// OFF: Disable Listen, audio only goes to Nest speakers
ipcMain.handle('toggle-pc-audio', async (event, enabled) => {
  console.log(`[Main] PC Audio toggle: ${enabled ? 'ON' : 'OFF'}`);

  try {
    if (enabled) {
      // Enable PC speakers (Listen to this device + APO delay)
      const result = await audioRouting.enablePCSpeakersMode();
      if (result.success) {
        pcAudioEnabled = true;  // Track that PC audio is on
        sendLog(`PC audio enabled: ${result.device || 'PC Speakers'}`, 'success');

        // Set PC speaker device for volume control
        if (result.device) {
          volumeSync.setPCSpeakerDevice(result.device);
          // Set PC speaker to current Windows volume immediately
          volumeSync.getWindowsVolume().then((volume) => {
            volumeSync.setPCSpeakerVolume(volume).catch(() => {});
          }).catch(() => {});
        }

        // AUTO-CALIBRATE: Measure RTT and calculate optimal delay automatically
        // No more manual slider adjustment needed!
        if (currentConnectedSpeakers.length > 0) {
          const speakerForSync = currentConnectedSpeakers[0];
          if (speakerForSync?.ip) {
            // Start auto-sync first so calibration can work
            autoSyncEnabled = true;
            settingsManager.setSetting('autoSyncEnabled', true);
            autoSyncManager.start(speakerForSync);

            // Auto-calibrate: measure RTT + add pipeline delays = optimal sync
            const calibration = await autoSyncManager.calibrateSmartDefault();
            if (calibration.success) {
              const delay = calibration.delay;
              sendLog(`[Sync] Auto-calibrated: ${delay}ms (RTT: ${calibration.rtt}ms + pipeline: ${calibration.pipelineDelay}ms)`);

              // Apply the calibrated delay
              await pcSpeakerDelay.setDelay(delay);
              await audioSyncManager.setDelay(delay);
              settingsManager.setSetting('syncDelayMs', delay);

              // Update UI slider
              if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send('sync-delay-corrected', delay);
              }
            } else {
              // Fallback to safe default if calibration fails
              const fallbackDelay = 100;
              sendLog(`[Sync] Calibration failed, using ${fallbackDelay}ms default`, 'warning');
              await pcSpeakerDelay.setDelay(fallbackDelay);
              await audioSyncManager.setDelay(fallbackDelay);
            }

            sendLog(`Auto-sync monitoring "${speakerForSync.name}"`);
          }
        } else {
          // No speaker connected - use saved delay as fallback
          const settings = await settingsManager.loadSettings();
          if (settings.syncDelayMs > 0) {
            await pcSpeakerDelay.setDelay(settings.syncDelayMs);
            await audioSyncManager.setDelay(settings.syncDelayMs);
          }
        }
      }
      return { success: result.success, device: result.device, error: result.error };
    } else {
      // Disable PC speakers (turn off Listen, clear APO delay)
      pcAudioEnabled = false;  // Track that PC audio is off
      volumeSync.setPCSpeakerDevice(null);  // Clear PC speaker volume control
      const result = await audioRouting.disablePCSpeakersMode();
      await pcSpeakerDelay.clearDelay().catch(() => {});
      // Also clear audioSyncManager state
      await audioSyncManager.setDelay(0).catch(() => {});

      // AUTO-SYNC: Stop when PC speaker is disabled (they're coupled)
      if (autoSyncEnabled) {
        autoSyncEnabled = false;
        settingsManager.setSetting('autoSyncEnabled', false);
        autoSyncManager.stop();
        sendLog(`Auto-sync stopped (PC speaker mode disabled)`);
      }

      if (result.success) {
        sendLog(`PC audio disabled`, 'success');
      }
      return { success: result.success, error: result.error };
    }
  } catch (error) {
    console.error(`[Main] PC audio toggle error:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-last-speaker', (event, speaker) => {
  settingsManager.saveLastSpeaker(speaker);
  settingsManager.setSetting('lastMode', 'single');
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
    console.log(`[Main] Setting sync delay to ${delayMs}ms...`);
    const result = await audioSyncManager.setDelay(delayMs);
    if (result) {
      sendLog(`Sync delay set to ${delayMs}ms`, 'success');
      // Save to settings
      settingsManager.setSetting('syncDelayMs', delayMs);

      // CRITICAL: Update auto-sync baseline to prevent it from "correcting" manual changes
      // This ensures auto-sync adjusts relative to user's new chosen delay
      if (autoSyncEnabled) {
        await autoSyncManager.updateBaseline(delayMs);
        console.log(`[Main] Auto-sync baseline updated to ${delayMs}ms`);
      }

      // Verify the file was written correctly
      const fs = require('fs');
      const apoConfigPath = 'C:\\Program Files\\EqualizerAPO\\config\\pcnestspeaker-sync.txt';
      if (fs.existsSync(apoConfigPath)) {
        const content = fs.readFileSync(apoConfigPath, 'utf8');
        console.log(`[Main] APO config file content: ${content.replace(/\r?\n/g, ' | ')}`);
      }
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

// Calibrate smart default sync delay using ping measurement
// Returns: { success, delay, rtt, pipelineDelay } or { success: false, error }
ipcMain.handle('calibrate-smart-default', async () => {
  try {
    const result = await autoSyncManager.calibrateSmartDefault();
    if (result.success) {
      sendLog(`Smart default: ${result.delay}ms (ping: ${result.rtt}ms + processing: ${result.pipelineDelay}ms)`, 'success');
      // Save the calibrated delay
      settingsManager.setSetting('syncDelayMs', result.delay);
    }
    return result;
  } catch (error) {
    sendLog(`Smart calibration failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Measure latency from Cast receiver
ipcMain.handle('measure-latency', async (event, speakerName, speakerIp) => {
  try {
    sendLog(`Measuring latency to ${speakerName}...`, 'info');

    const result = await runPython(['measure-latency', speakerName, speakerIp || '', '15']);

    if (result.success) {
      sendLog(`Latency: RTT=${result.rtt}ms, Recommended delay=${result.recommendedDelay}ms`, 'success');
      return {
        success: true,
        rtt: result.rtt,
        recommendedDelay: result.recommendedDelay,
        samples: result.samples
      };
    } else {
      sendLog(`Latency measurement failed: ${result.error}`, 'error');
      return { success: false, error: result.error };
    }
  } catch (error) {
    sendLog(`Latency measurement error: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
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

// Get list of devices that have APO installed
ipcMain.handle('get-apo-devices', () => {
  const devices = audioSyncManager.getAPOInstalledDevices();
  sendLog(`APO installed on ${devices.length} device(s): ${devices.join(', ') || 'none'}`, 'info');
  return { devices };
});

// Launch APO Configurator
ipcMain.handle('launch-apo-configurator', async () => {
  try {
    const launched = await audioSyncManager.launchAPOConfigurator();
    if (launched) {
      sendLog('Launched APO Configurator - add your PC speakers and restart Windows', 'info');
    }
    return { success: launched };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════
// AUTO-SYNC HANDLERS - Automatic sync delay adjustment
// ═══════════════════════════════════════════════════════════

// Enable auto-sync for a speaker
ipcMain.handle('enable-auto-sync', async (event, speaker) => {
  try {
    autoSyncEnabled = true;
    settingsManager.setSetting('autoSyncEnabled', true);

    // Start monitoring if we have a speaker
    if (speaker && speaker.ip) {
      autoSyncManager.start(speaker);
      // Set baseline from current "perfect" delay
      await autoSyncManager.setBaseline();
      sendLog(`Auto-sync enabled for "${speaker.name}"`, 'success');
    } else {
      sendLog('Auto-sync enabled (will start when streaming)', 'info');
    }

    return { success: true, enabled: true };
  } catch (error) {
    sendLog(`Auto-sync failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Disable auto-sync
ipcMain.handle('disable-auto-sync', () => {
  autoSyncEnabled = false;
  settingsManager.setSetting('autoSyncEnabled', false);
  autoSyncManager.stop();
  sendLog('Auto-sync disabled', 'info');
  return { success: true, enabled: false };
});

// Get auto-sync status
ipcMain.handle('get-auto-sync-status', () => {
  const status = autoSyncManager.getStatus();
  return {
    enabled: autoSyncEnabled,
    ...status
  };
});

// Manually trigger sync check
ipcMain.handle('check-sync-now', async () => {
  try {
    await autoSyncManager.checkNow();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Check APO status for current default audio device
ipcMain.handle('check-apo-status', async () => {
  try {
    const status = await audioSyncManager.checkAPOStatusForCurrentDevice();
    sendLog(`APO Status: ${status.message}`, status.canUseDelay ? 'info' : 'warning');
    return status;
  } catch (error) {
    sendLog(`APO status check failed: ${error.message}`, 'error');
    return {
      currentDevice: null,
      apoInstalled: false,
      apoOnDevice: false,
      canUseDelay: false,
      message: error.message
    };
  }
});

// ═══════════════════════════════════════════════════════════
// QUICK AUDIO OUTPUT SWITCHER (via SoundVolumeView for universal support)
// ═══════════════════════════════════════════════════════════

// Get list of all audio output devices using SoundVolumeView (same source as switching)
// This ensures device names match exactly between listing and switching
ipcMain.handle('get-audio-outputs', async () => {
  try {
    sendLog('Getting audio output devices...', 'info');
    const devices = await audioRouting.getRenderDevices();

    // Transform to UI format: { name, isDefault }
    const uiDevices = devices.map(d => ({
      name: d.name,  // Use 'name' field for matching (same as setDefaultDevice uses)
      isDefault: d.isDefault
    }));

    return { success: true, devices: uiDevices };
  } catch (error) {
    sendLog(`Failed to list audio outputs: ${error.message}`, 'error');
    return { success: false, error: error.message, devices: [] };
  }
});

// Switch to a specific audio output device
// Uses audio-routing.js (SoundVolumeView) for universal Windows support
// In PC + Speakers mode: Changes the Listen TARGET (keeps Windows default on VB-Cable)
// In Speakers Only mode: Changes the Windows default device
ipcMain.handle('switch-audio-output', async (event, deviceName) => {
  try {
    if (pcAudioEnabled && virtualCaptureCmdId) {
      // PC Audio enabled: Change Listen TARGET, not Windows default
      // Windows default stays on VB-Cable (for FFmpeg capture)
      // Listen routes audio from CABLE Output → user-selected speaker
      sendLog(`PC + Speakers: Routing Listen to ${deviceName}`, 'info');
      const result = await audioRouting.enableListenToDeviceWithCmdId(virtualCaptureCmdId, deviceName);
      if (result.success) {
        sendLog(`Listen routed to: ${deviceName}`, 'success');
        return { success: true, device: deviceName, mode: 'listen' };
      } else {
        sendLog(`Failed to route Listen: ${result.error}`, 'error');
        return { success: false, error: result.error };
      }
    } else {
      // Speakers Only mode: Change Windows default device using SoundVolumeView
      // This works universally across all Windows setups
      sendLog(`Switching Windows audio output to: ${deviceName}`, 'info');
      const result = await audioRouting.setDefaultDevice(deviceName);
      if (result.success) {
        sendLog(`Audio output switched to: ${result.device}`, 'success');
        return { success: true, device: result.device, mode: 'default' };
      } else {
        sendLog(`Failed to switch audio: ${result.error}`, 'error');
        return { success: false, error: result.error };
      }
    }
  } catch (error) {
    sendLog(`Failed to switch audio: ${error.message}`, 'error');
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
  // Dev mode bypass - always licensed during development
  if (!app.isPackaged) {
    return { licenseKey: 'DEV-MODE-LICENSE', activatedAt: new Date().toISOString() };
  }
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

// ===================
// First-Run Setup IPC Handlers
// ===================

// Complete first-run setup (called after user finishes wizard)
ipcMain.handle('complete-first-run', async (event, options) => {
  console.log('[Main] First-run setup complete:', options);

  // Save Equalizer APO installation status
  if (options.installedApo) {
    settingsManager.setSetting('equalizerApoInstalled', true);
  }

  // Mark first-run as complete
  settingsManager.setSetting('firstRunComplete', true);

  return { success: true };
});

// Get first-run status
ipcMain.handle('get-first-run-status', async () => {
  const settings = settingsManager.getAllSettings();
  return {
    firstRunComplete: settings.firstRunComplete,
    equalizerApoInstalled: settings.equalizerApoInstalled,
    detectedRealSpeakers: settings.detectedRealSpeakers
  };
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

  // Check and install dependencies (VB-Cable required!)
  // This will prompt user to install VB-Cable if missing
  const depsOk = await dependencyInstaller.checkAndInstallDependencies(mainWindow);
  if (!depsOk) {
    sendLog('VB-Cable not installed - audio streaming will not work!', 'warning');
  }

  // Initialize auto-sync manager (monitors network latency and adjusts sync delay)
  autoSyncManager.initialize({
    audioSync: audioSyncManager,
    sendLog: sendLog,
    onAdjust: (newDelay, oldDelay) => {
      // Notify renderer when auto-sync adjusts the delay
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auto-sync-adjusted', { newDelay, oldDelay });
      }
    }
  });

  // Restore auto-sync enabled state from settings
  autoSyncEnabled = settingsManager.getSetting('autoSyncEnabled') || false;
  console.log(`[Main] Auto-sync: ${autoSyncEnabled ? 'enabled' : 'disabled'} (from settings)`);

  // Start Cast daemon for instant volume control
  daemonManager.startDaemon().then(() => {
    console.log('[Main] Cast daemon started - volume control will be instant');
  }).catch(err => {
    console.log('[Main] Cast daemon failed to start:', err.message);
    console.log('[Main] Falling back to spawning Python per command (slower)');
  });

  // Check for first-run setup (detects real speakers, offers Equalizer APO)
  setTimeout(async () => {
    try {
      await checkFirstRun();
    } catch (err) {
      console.log('[Main] First-run check failed:', err.message);
    }
  }, 1000); // Wait 1s for window to load

  // Auto-discover speakers and audio devices in background
  // Chain: discover → pipeline → auto-connect (proper sequencing, no race conditions)
  setTimeout(async () => {
    try {
      // Step 1: Discover speakers (can take 4-8 seconds)
      await autoDiscoverDevices();

      // Step 2: Start pipeline AFTER discovery completes
      await preStartWebRTCPipeline().catch(err => {
        console.log('[Main] Background pipeline failed:', err.message);
      });

      // Step 3: Auto-connect AFTER pipeline is ready
      const settings = settingsManager.getAllSettings();
      if (settings.autoConnect) {
        // Check if stereo mode was last used
        if (settings.lastMode === 'stereo' && settings.lastStereoSpeakers) {
          const { left, right } = settings.lastStereoSpeakers;
          console.log('[Main] Auto-connecting stereo mode: L=' + left.name + ', R=' + right.name);
          sendLog(`Auto-connecting stereo: L="${left.name}", R="${right.name}"...`, 'info');

          // Send stereo auto-connect event to renderer
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('auto-connect-stereo', { left, right });
          }
        } else if (settings.lastSpeaker) {
          // Single speaker mode
          console.log('[Main] Auto-connecting to last speaker:', settings.lastSpeaker.name);
          sendLog(`Auto-connecting to ${settings.lastSpeaker.name}...`, 'info');

          // Send to renderer to trigger streaming
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('auto-connect', settings.lastSpeaker);
          }
        }
      }
    } catch (err) {
      console.log('[Main] Startup sequence failed:', err.message);
    }
  }, 1500); // Wait 1.5s for window to load, then run sequence

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
