/**
 * PC Nest Speaker - Main Process
 * Handles window creation, IPC, and system integration
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { initMain } = require('electron-audio-loopback');
const { ChromecastManager } = require('./chromecast');
const { AudioStreamer } = require('./audio-streamer');

// IMPORTANT: Initialize audio loopback BEFORE app is ready
initMain();

// Keep global references
let mainWindow = null;
let chromecastManager = null;
let audioStreamer = null;

// Settings
const settings = {
  selectedSpeaker: null,
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 400,
    minHeight: 500,
    resizable: true,
    frame: true,
    backgroundColor: '#334E58', // Charcoal Blue
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Open DevTools in dev mode
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
  if (chromecastManager) {
    chromecastManager.stopDiscovery();
    chromecastManager = null;
  }
}

// IPC Handlers

// Discover speakers
ipcMain.handle('discover-speakers', async () => {
  try {
    if (!chromecastManager) {
      chromecastManager = new ChromecastManager();
    }
    const speakers = await chromecastManager.discoverSpeakers();
    return { success: true, speakers };
  } catch (error) {
    console.error('Discovery error:', error);
    return { success: false, error: error.message };
  }
});

// Prepare streaming (start HTTP server and FFmpeg, return URL)
ipcMain.handle('prepare-streaming', async () => {
  try {
    // Initialize audio streamer
    if (!audioStreamer) {
      audioStreamer = new AudioStreamer();
    }

    // Start the HTTP server and FFmpeg
    const streamUrl = await audioStreamer.start();

    return { success: true, url: streamUrl };
  } catch (error) {
    console.error('Prepare streaming error:', error);
    return { success: false, error: error.message };
  }
});

// Receive audio data from renderer process
ipcMain.on('audio-data', (event, buffer) => {
  if (audioStreamer) {
    audioStreamer.writeAudioData(buffer);
  }
});

// Cast to speaker
ipcMain.handle('cast-to-speaker', async (event, speakerName, streamUrl) => {
  try {
    if (!chromecastManager) {
      return { success: false, error: 'No speakers discovered' };
    }

    // Cast to speaker
    await chromecastManager.castToSpeaker(speakerName, streamUrl);
    settings.selectedSpeaker = speakerName;

    return { success: true };
  } catch (error) {
    console.error('Cast error:', error);
    return { success: false, error: error.message };
  }
});

// Stop streaming
ipcMain.handle('stop-streaming', async () => {
  try {
    if (audioStreamer) {
      await audioStreamer.stop();
    }
    if (chromecastManager && settings.selectedSpeaker) {
      await chromecastManager.stopCasting(settings.selectedSpeaker);
    }
    return { success: true };
  } catch (error) {
    console.error('Stop error:', error);
    return { success: false, error: error.message };
  }
});

// Get streaming status
ipcMain.handle('get-status', () => {
  return {
    isStreaming: audioStreamer?.isStreaming || false,
    selectedSpeaker: settings.selectedSpeaker,
  };
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
