/**
 * Preload script - Exposes safe IPC to renderer
 * Uses Python pychromecast for reliable Nest casting
 * Supports both HTTP streaming (8s latency) and WebRTC (sub-1s latency)
 */

const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Discover audio devices AND Chromecast speakers
  discoverDevices: () => ipcRenderer.invoke('discover-devices'),

  // Streaming controls (supports 3 modes: http, webrtc-system, webrtc-vbcable)
  startStreaming: (speakerName, audioDevice, streamingMode = 'http') =>
    ipcRenderer.invoke('start-streaming', speakerName, audioDevice, streamingMode),
  stopStreaming: (speakerName) => ipcRenderer.invoke('stop-streaming', speakerName),
  getStatus: () => ipcRenderer.invoke('get-status'),
  restartFfmpeg: () => ipcRenderer.invoke('restart-ffmpeg'),

  // Test ping (plays sound on speaker without streaming)
  pingSpeaker: (speakerName) => ipcRenderer.invoke('ping-speaker', speakerName),

  // Stereo separation streaming
  startStereoStreaming: (leftSpeaker, rightSpeaker) =>
    ipcRenderer.invoke('start-stereo-streaming', leftSpeaker, rightSpeaker),
  stopStereoStreaming: (leftSpeaker, rightSpeaker) =>
    ipcRenderer.invoke('stop-stereo-streaming', leftSpeaker, rightSpeaker),

  // TV streaming (HLS for NVIDIA Shield, Chromecast with screen)
  startTvStreaming: (deviceName, deviceIp = null) =>
    ipcRenderer.invoke('start-tv-streaming', deviceName, deviceIp),
  stopTvStreaming: () => ipcRenderer.invoke('stop-tv-streaming'),
  getTvStreamingStatus: () => ipcRenderer.invoke('get-tv-streaming-status'),

  // Volume control (0.0 - 1.0 for pychromecast)
  setVolume: (speakerName, volume) =>
    ipcRenderer.invoke('set-volume', speakerName, volume),
  getVolume: (speakerName) =>
    ipcRenderer.invoke('get-volume', speakerName),

  // Settings management
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates) => ipcRenderer.invoke('update-settings', updates),
  saveLastSpeaker: (speaker) => ipcRenderer.invoke('save-last-speaker', speaker),

  // Cast Mode - controls audio routing (speakers only vs PC + speakers)
  setCastMode: (mode) => ipcRenderer.invoke('set-cast-mode', mode),

  // Auto-start on Windows boot
  isAutoStartEnabled: () => ipcRenderer.invoke('is-auto-start-enabled'),
  toggleAutoStart: () => ipcRenderer.invoke('toggle-auto-start'),

  // Dependency management
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  installDependency: (dep) => ipcRenderer.invoke('install-dependency', dep),

  // Trial & Usage
  getUsage: () => ipcRenderer.invoke('get-usage'),

  // License Management
  getLicense: () => ipcRenderer.invoke('get-license'),
  activateLicense: (licenseKey) => ipcRenderer.invoke('activate-license', licenseKey),
  deactivateLicense: () => ipcRenderer.invoke('deactivate-license'),

  // Audio Sync (PC speaker delay to match Nest)
  initAudioSync: () => ipcRenderer.invoke('init-audio-sync'),
  setSyncDelay: (delayMs) => ipcRenderer.invoke('set-sync-delay', delayMs),
  getSyncDelay: () => ipcRenderer.invoke('get-sync-delay'),
  checkEqualizerApo: () => ipcRenderer.invoke('check-equalizer-apo'),
  installEqualizerApo: () => ipcRenderer.invoke('install-equalizer-apo'),
  getApoDevices: () => ipcRenderer.invoke('get-apo-devices'),
  launchApoConfigurator: () => ipcRenderer.invoke('launch-apo-configurator'),
  checkApoStatus: () => ipcRenderer.invoke('check-apo-status'),

  // Quick Audio Output Switcher
  getAudioOutputs: () => ipcRenderer.invoke('get-audio-outputs'),
  switchAudioOutput: (deviceName) => ipcRenderer.invoke('switch-audio-output', deviceName),

  // First-Run Setup
  getFirstRunStatus: () => ipcRenderer.invoke('get-first-run-status'),
  completeFirstRun: (options) => ipcRenderer.invoke('complete-first-run', options),

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
  onStreamStats: (callback) => {
    ipcRenderer.on('stream-stats', (event, stats) => callback(stats));
  },
  onAutoConnect: (callback) => {
    ipcRenderer.on('auto-connect', (event, speaker) => callback(speaker));
  },

  // Auto-discovery events (fired on app startup)
  onSpeakersDiscovered: (callback) => {
    ipcRenderer.on('speakers-discovered', (event, speakers) => callback(speakers));
  },
  onAudioDevicesDiscovered: (callback) => {
    ipcRenderer.on('audio-devices-discovered', (event, devices) => callback(devices));
  },

  // Tray events
  onTrayStopStreaming: (callback) => {
    ipcRenderer.on('tray-stop-streaming', () => callback());
  },

  // First-run setup event (triggered when app detects first run with real speakers)
  onFirstRunSetup: (callback) => {
    ipcRenderer.on('first-run-setup', (event, data) => callback(data));
  },

  // Window controls (frameless window)
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
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
