# PC Nest Speaker - Boot Sequence

## Entry Point
**File:** `src/main/electron-main.js`
**Start Line:** 2483

## Boot Timeline

```
0ms     app.whenReady()
        │
        ├─ killLeftoverProcesses()     # Kill zombie MediaMTX/FFmpeg
        ├─ setupFirewall()             # Ensure port 8000 allowed
        ├─ verifyAndFixAutoStart()     # Fix registry if paths changed
        ├─ createWindow()              # Show main window
        ├─ createTray(mainWindow)      # System tray icon
        │
        └─ startDaemon()               # Cast daemon for volume control
              │
1500ms  autoDiscoverDevices()          # Find speakers + audio devices
              │
3000ms  preStartWebRTCPipeline()       # MediaMTX + FFmpeg warm-up
              │
5000ms  auto-connect                   # Connect to last speaker (if enabled)
```

## Detailed Boot Steps

### 1. Process Cleanup (0ms)
```javascript
killLeftoverProcesses();  // Kills: mediamtx.exe, ffmpeg.exe
```

### 2. Firewall Setup (0ms)
```javascript
await setupFirewall();  // Adds rule for port 8000 if missing
```

### 3. Auto-Start Verification (0ms)
```javascript
await autoStartManager.verifyAndFixAutoStart();  // Registry key check
```

### 4. Window Creation (0ms)
```javascript
createWindow();  // Shows src/renderer/index.html
```

### 5. System Tray (0ms)
```javascript
trayManager.createTray(mainWindow);  // Tray icon + context menu
```

### 6. Cast Daemon (async)
```javascript
daemonManager.startDaemon();  // Background Python for instant volume
```

### 7. Auto-Discovery (1500ms delay)
```javascript
autoDiscoverDevices();  // Finds Cast speakers + DirectShow audio devices
```

### 8. WebRTC Pipeline Pre-start (3000ms delay)
```javascript
preStartWebRTCPipeline();  // Starts MediaMTX + FFmpeg in background
```
**Sub-steps:**
- Injects local IP into MediaMTX config
- Starts MediaMTX (ports 8554, 8889, 8189)
- Starts FFmpeg (RTSP to MediaMTX)
- Sets `webrtcPipelineReady = true`

### 9. Auto-Connect (5000ms delay)
```javascript
if (settings.autoConnect && settings.lastSpeaker) {
  mainWindow.webContents.send('auto-connect', settings.lastSpeaker);
}
```

## Key Files Involved

| File | Purpose |
|------|---------|
| `electron-main.js` | Main process, boot orchestration |
| `preload.js` | IPC bridge to renderer |
| `index.html` | UI layout |
| `renderer.js` | UI logic, receives auto-connect |
| `settings-manager.js` | Load/save settings.json |
| `auto-start-manager.js` | Windows Registry auto-start |
| `tray-manager.js` | System tray icon |
| `daemon-manager.js` | Cast daemon for volume |
| `audio-device-manager.js` | Virtual audio switching |

## Log Messages During Boot

Expected healthy boot log:
```
[Main] Killed leftover processes
[Main] Firewall rule already exists
[Main] Auto-start registry verified
[Main] Window created
[Main] Tray created
[Main] Cast daemon started
[Main] Discovering speakers...
[Main] Found 5 speakers
[Main] Discovering audio devices...
[Main] Starting WebRTC pipeline in background...
[Main] MediaMTX started on ports 8554, 8889, 8189
[Main] FFmpeg publishing to MediaMTX
[Main] WebRTC pipeline ready!
[Main] Auto-connecting to Den pair...
```

## Troubleshooting

### Window doesn't appear
- Check `createWindow()` for errors
- Verify `index.html` path exists
- Check console for preload errors

### Auto-connect fails
- Check `settings.json` has `lastSpeaker`
- Verify speaker was discovered
- Check if pipeline is ready (5s delay)

### Pipeline not ready
- Check MediaMTX started (port 8889)
- Check FFmpeg stderr for errors
- Verify virtual-audio-capturer exists
