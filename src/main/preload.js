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

  // URL casting (user provides URL, TV plays it directly)
  castUrl: (deviceName, url, contentType = null, deviceIp = null) =>
    ipcRenderer.invoke('cast-url', deviceName, url, contentType, deviceIp),

  // Volume control (0.0 - 1.0 for pychromecast)
  setVolume: (speakerName, volume) =>
    ipcRenderer.invoke('set-volume', speakerName, volume),
  getVolume: (speakerName) =>
    ipcRenderer.invoke('get-volume', speakerName),

  // Settings management
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates) => ipcRenderer.invoke('update-settings', updates),
  saveLastSpeaker: (speaker) => ipcRenderer.invoke('save-last-speaker', speaker),

  // PC Audio toggle - enable/disable "Listen to this device" on VB-Cable
  togglePCAudio: (enabled) => ipcRenderer.invoke('toggle-pc-audio', enabled),

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
  measureLatency: (speakerName, speakerIp) => ipcRenderer.invoke('measure-latency', speakerName, speakerIp),
  calibrateSmartDefault: () => ipcRenderer.invoke('calibrate-smart-default'),
  checkEqualizerApo: () => ipcRenderer.invoke('check-equalizer-apo'),
  installEqualizerApo: () => ipcRenderer.invoke('install-equalizer-apo'),
  getApoDevices: () => ipcRenderer.invoke('get-apo-devices'),
  launchApoConfigurator: () => ipcRenderer.invoke('launch-apo-configurator'),
  checkApoStatus: () => ipcRenderer.invoke('check-apo-status'),

  // Auto-Sync (automatically adjusts sync delay based on network latency)
  enableAutoSync: (speaker) => ipcRenderer.invoke('enable-auto-sync', speaker),
  disableAutoSync: () => ipcRenderer.invoke('disable-auto-sync'),
  getAutoSyncStatus: () => ipcRenderer.invoke('get-auto-sync-status'),

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
  onAutoConnectStereo: (callback) => {
    ipcRenderer.on('auto-connect-stereo', (event, data) => callback(data));
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

  // Auto-sync adjustment event (when network latency changes and delay is auto-adjusted)
  onAutoSyncAdjusted: (callback) => {
    ipcRenderer.on('auto-sync-adjusted', (event, data) => callback(data));
  },

  // Sync delay auto-correction event (when old high delay is corrected for optimized WebRTC)
  onSyncDelayCorrected: (callback) => {
    ipcRenderer.on('sync-delay-corrected', (event, newDelayMs) => callback(newDelayMs));
  },

  // Audio device changed event (when Windows audio output switches, refresh UI)
  onAudioDeviceChanged: (callback) => {
    ipcRenderer.on('audio-device-changed', (event, deviceName) => callback(deviceName));
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
