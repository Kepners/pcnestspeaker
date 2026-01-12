# PC Nest Speaker - Boot Sequence

## Entry Point
**File:** `src/main/electron-main.js`
**Start Line:** ~3319 (`app.whenReady()`)

## Boot Timeline

```
0ms     app.whenReady()
        │
        ├─ killLeftoverProcesses()          # Kill zombie MediaMTX/FFmpeg
        ├─ setupFirewall()                  # Ensure port 8000 allowed
        ├─ verifyAndFixAutoStart()          # Fix registry if paths changed
        ├─ createWindow()                   # Show main window
        ├─ createTray(mainWindow)           # System tray icon
        ├─ checkAndInstallDependencies()    # VB-Cable check/prompt
        ├─ autoSyncManager.initialize()     # Sync system setup
        │
        └─ startDaemon()                    # Cast daemon for volume control
              │
1000ms  checkFirstRun()                     # First-run setup (speakers, APO)
              │
1500ms  SEQUENTIAL STARTUP (chained awaits):
        │
        ├─ 1. await autoDiscoverDevices()   # Find speakers (4-8 seconds)
        │       └─ sends 'speakers-discovered' to renderer
        │
        ├─ 2. await preStartWebRTCPipeline()  # MediaMTX + FFmpeg (1-2 seconds)
        │       ├─ saveOriginalDevice()       # Save user's audio device
        │       ├─ setDefaultDevice(VB-Cable) # Switch Windows to VB-Cable Input
        │       ├─ startMediaMTX()            # RTSP/WebRTC server
        │       ├─ startFFmpegWebRTC()        # Captures from VB-Cable Output
        │       └─ sets webrtcPipelineReady = true
        │
        └─ 3. auto-connect event              # Connect to last speaker/stereo
                ├─ If lastMode === 'stereo': sends 'auto-connect-stereo'
                └─ Else: sends 'auto-connect'
```

## Auto-Connect Retry Logic (Renderer)

When renderer receives auto-connect event, it implements retry logic:

```javascript
// renderer.js - lines 593-626 (single) and 629-659 (stereo)
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

for (attempt = 1 to MAX_RETRIES) {
  1. Find speaker in discovered list
  2. If found → startStreamingToSpeaker() → return
  3. If not found AND attempt < MAX_RETRIES:
     - Log "Speaker not found, re-discovering..."
     - await discoverDevices()
     - await sleep(2000ms)
     - Continue to next attempt
  4. After all retries exhausted → log error
}
```

**Why retry?** Speakers may have just turned on during boot - re-discovery catches late-joining devices.

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

### 6. Dependencies Check (0ms)
```javascript
const depsOk = await dependencyInstaller.checkAndInstallDependencies(mainWindow);
// Prompts user to install VB-Cable if missing
```

### 7. Auto-Sync Initialization (0ms)
```javascript
autoSyncManager.initialize({
  audioSync: audioSyncManager,
  sendLog: sendLog,
  onAdjust: (newDelay, oldDelay) => {
    mainWindow.webContents.send('auto-sync-adjusted', { newDelay, oldDelay });
  }
});
```

### 8. Cast Daemon (async)
```javascript
daemonManager.startDaemon();  // Background Python for instant volume
```

### 9. First-Run Check (1000ms)
```javascript
await checkFirstRun();  // Detects real speakers, offers Equalizer APO
```

### 10. Sequential Startup Chain (1500ms)

**IMPORTANT:** These are chained with `await`, not separate timeouts!

```javascript
// Step 1: Discover speakers first
await autoDiscoverDevices();

// Step 2: Start pipeline AFTER discovery
await preStartWebRTCPipeline();

// Step 3: Auto-connect AFTER pipeline ready
const settings = settingsManager.getAllSettings();
if (settings.autoConnect) {
  if (settings.lastMode === 'stereo' && settings.lastStereoSpeakers) {
    // Stereo mode - send L/R pair
    mainWindow.webContents.send('auto-connect-stereo', { left, right });
  } else if (settings.lastSpeaker) {
    // Single speaker mode
    mainWindow.webContents.send('auto-connect', settings.lastSpeaker);
  }
}
```

## Key Files Involved

| File | Purpose |
|------|---------|
| `electron-main.js` | Main process, boot orchestration |
| `preload.js` | IPC bridge to renderer |
| `index.html` | UI layout |
| `renderer.js` | UI logic, auto-connect handlers with retry |
| `settings-manager.js` | Load/save settings.json |
| `auto-start-manager.js` | Windows Registry auto-start |
| `tray-manager.js` | System tray icon |
| `daemon-manager.js` | Cast daemon for volume |
| `audio-device-manager.js` | Virtual audio switching |
| `auto-sync-manager.js` | Network latency monitoring |
| `dependency-installer.js` | VB-Cable check/install |

## Settings Used for Auto-Connect

| Setting | Type | Purpose |
|---------|------|---------|
| `autoConnect` | boolean | Enable auto-connect on startup |
| `lastSpeaker` | object | Last connected single speaker |
| `lastMode` | string | 'single' or 'stereo' |
| `lastStereoSpeakers` | object | `{ left: {...}, right: {...} }` |

## Log Messages During Boot

Expected healthy boot log:
```
[Main] Killed leftover processes
[Main] Firewall rule already exists
[Main] Auto-start registry verified
[Main] Window created
[Main] Tray created
[Main] VB-Cable found
[Main] Auto-sync: enabled (from settings)
[Main] Cast daemon started - volume control will be instant
[Main] First-run check complete
[Main] Discovering speakers...
[Main] Found 5 speakers
[Main] Discovering audio devices...
[Main] Saved original default device: Speakers (Realtek)
[Background] Windows audio switched to: CABLE Input (VB-Audio Virtual Cable)
[Main] Starting WebRTC pipeline in background...
[Main] MediaMTX started on ports 8554, 8889, 8189
[Background] Using audio device: CABLE Output (VB-Audio Virtual Cable)
[Main] FFmpeg publishing to MediaMTX
[Main] WebRTC pipeline ready!
[Main] Auto-connecting stereo mode: L=Office, R=Bedroom
```

## Troubleshooting

### Window doesn't appear
- Check `createWindow()` for errors
- Verify `index.html` path exists
- Check console for preload errors

### Auto-connect fails
- Check `settings.json` has `lastSpeaker` or `lastStereoSpeakers`
- Check logs for "Speaker not found" (triggers re-discovery)
- Verify speaker is online (retry logic runs 3x with 2s delays)
- Check if pipeline is ready

### Pipeline not ready
- Check MediaMTX started (port 8889)
- Check FFmpeg stderr for errors
- Verify virtual-audio-capturer exists

### VB-Cable prompt keeps appearing
- Install VB-Cable from https://vb-audio.com/Cable/
- Restart app after installation
- Check `dependencyInstaller` logs

---

*Last Updated: January 12, 2025*
