/**
 * PC Nest Speaker - Main Process
 * Nice Electron UI + Python pychromecast for actual casting (it works with Nest!)
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { AudioStreamer } = require('./audio-streamer');

// Keep global references
let mainWindow = null;
let audioStreamer = null;
let pythonCastProcess = null;

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
  if (audioStreamer) {
    audioStreamer.stop();
    audioStreamer = null;
  }
  if (pythonCastProcess) {
    pythonCastProcess.kill();
    pythonCastProcess = null;
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
ipcMain.handle('start-streaming', async (event, speakerName, audioDevice) => {
  try {
    sendLog(`Starting stream to "${speakerName}"...`);

    if (!audioStreamer) {
      audioStreamer = new AudioStreamer();
    }

    // Start FFmpeg HTTP stream (MP3 with custom low-latency receiver)
    sendLog(`Audio source: ${audioDevice}`);
    const streamUrl = await audioStreamer.start(audioDevice, 'mp3');
    sendLog(`Stream URL: ${streamUrl}`, 'success');

    // Determine content type based on stream URL
    const contentType = streamUrl.endsWith('.m3u8')
      ? 'application/x-mpegURL'
      : 'audio/mpeg';

    // Cast to speaker using Python
    sendLog(`Casting to ${speakerName}...`);
    const result = await runPython(['cast', speakerName, streamUrl, contentType]);

    if (result.success) {
      sendLog('Streaming started!', 'success');
      return { success: true, url: streamUrl };
    } else {
      // Stop the stream if casting failed
      await audioStreamer.stop();
      throw new Error(result.error);
    }
  } catch (error) {
    sendLog(`Stream failed: ${error.message}`, 'error');
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

// App lifecycle
app.whenReady().then(() => {
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
});
