/**
 * Preload script - Exposes safe IPC to renderer
 * Uses Python pychromecast for reliable Nest casting
 * Supports both HTTP streaming (8s latency) and WebRTC (sub-1s latency)
 */

const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Discover audio devices AND Chromecast speakers
  discoverDevices: () => ipcRenderer.invoke('discover-devices'),

  // HTTP Streaming controls (8 second latency)
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

// Expose WebRTC-specific APIs separately (for low-latency streaming)
contextBridge.exposeInMainWorld('electronAPI', {
  // Get desktop sources for audio capture
  getDesktopSources: async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    });
    return sources.map(s => ({ id: s.id, name: s.name }));
  },

  // WebRTC signaling via Python pychromecast
  webrtcLaunch: (speakerName) => ipcRenderer.invoke('webrtc-launch', speakerName),
  webrtcSignal: (speakerName, message) => ipcRenderer.invoke('webrtc-signal', speakerName, message),
});
