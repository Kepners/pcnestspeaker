/**
 * Preload script - Exposes safe IPC to renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Speaker discovery
  discoverSpeakers: () => ipcRenderer.invoke('discover-speakers'),

  // Streaming controls
  startStreaming: (speakerName) => ipcRenderer.invoke('start-streaming', speakerName),
  stopStreaming: () => ipcRenderer.invoke('stop-streaming'),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Utilities
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Events from main process
  onStreamingStatus: (callback) => {
    ipcRenderer.on('streaming-status', (event, status) => callback(status));
  },
  onError: (callback) => {
    ipcRenderer.on('error', (event, error) => callback(error));
  },
});
