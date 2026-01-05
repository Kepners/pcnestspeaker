/**
 * Preload script - Exposes safe IPC to renderer
 * Uses Python pychromecast for reliable Nest casting
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Discover audio devices AND Chromecast speakers
  discoverDevices: () => ipcRenderer.invoke('discover-devices'),

  // Streaming controls
  startStreaming: (speakerName, audioDevice) => ipcRenderer.invoke('start-streaming', speakerName, audioDevice),
  stopStreaming: (speakerName) => ipcRenderer.invoke('stop-streaming', speakerName),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Test ping (plays sound on speaker without streaming)
  pingSpeaker: (speakerName) => ipcRenderer.invoke('ping-speaker', speakerName),

  // Utilities
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Events from main process
  onStreamingStatus: (callback) => {
    ipcRenderer.on('streaming-status', (event, status) => callback(status));
  },
  onError: (callback) => {
    ipcRenderer.on('error', (event, error) => callback(error));
  },
  onLog: (callback) => {
    ipcRenderer.on('log', (event, message, type) => callback(message, type));
  },
});
