/**
 * Preload script - Exposes safe IPC to renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Speaker discovery
  discoverSpeakers: () => ipcRenderer.invoke('discover-speakers'),

  // Streaming controls
  prepareStreaming: () => ipcRenderer.invoke('prepare-streaming'),
  castToSpeaker: (speakerName, streamUrl) => ipcRenderer.invoke('cast-to-speaker', speakerName, streamUrl),
  stopStreaming: () => ipcRenderer.invoke('stop-streaming'),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Send audio data to main process for FFmpeg
  sendAudioData: (buffer) => ipcRenderer.send('audio-data', buffer),

  // Audio loopback control (handled by electron-audio-loopback)
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),

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
