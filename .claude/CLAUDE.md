# PCNestSpeaker App

## Project Overview
Desktop app that streams Windows system audio to Google Nest speakers.

## Session Memory
Claude will remember context from previous sessions in this project.

## Development Notes
- Workspace color: Teal (#00897B)
- Related website: ../pcnestspeaker-website
- Monetization: Stripe payments with license keys

---

## Architecture: Streaming Modes

### Device Types (`cast_type`)
| Type | Devices | Streaming Method | Receiver |
|------|---------|------------------|----------|
| `audio` | Nest Mini, Nest Audio | WebRTC (Opus) | Custom Audio Receiver |
| `group` | Cast Groups, Stereo Pairs | WebRTC multicast | Custom Audio Receiver |
| `cast` | TVs, Chromecast, Shield | HLS (AAC) | Default Media Receiver |

### Receivers (Cast App IDs)
- **AUDIO_APP_ID** (`4B876246`): Lean audio-only receiver for speakers
- **VISUAL_APP_ID** (`FCAA4619`): Full receiver with ambient videos for TVs
- **Default Media Receiver** (`CC1AD845`): Google's built-in receiver for HLS

### Flow: Speaker Streaming (Nest Mini, Audio, Groups)
```
1. User clicks speaker → startStreamingToSpeaker()
2. Renderer calls window.api.startStreaming()
3. electron-main: startMediaMTX() → startFFmpegWebRTC() [Opus codec]
4. cast-helper.py: webrtc_launch() → starts custom receiver
5. Receiver connects to MediaMTX via WebRTC
```

### Flow: TV Streaming (Chromecast, TVs)
```
1. User clicks TV → startStreamingToSpeaker()
2. Renderer calls window.api.startStreaming()
3. electron-main detects isTv (cast_type === 'cast')
4. FFmpeg restarts with AAC codec (HLS compatible)
5. cast-helper.py: hls_cast_to_tv() → Default Media Receiver
6. TV plays HLS stream: http://<local-ip>:8888/pcaudio/index.m3u8
```

---

## Key Files

### Main Process
| File | Purpose |
|------|---------|
| `electron-main.js` | IPC handlers, streaming orchestration |
| `cast-helper.py` | pychromecast wrapper, Cast protocols |
| `audio-sync-manager.js` | Equalizer APO delay configuration |
| `auto-sync-manager.js` | Network latency monitoring |
| `audio-routing.js` | VB-Cable, "Listen to this device" |
| `audio-device-manager.js` | Windows audio device detection |

### Renderer
| File | Purpose |
|------|---------|
| `renderer.js` | UI logic, speaker list, controls |
| `index.html` | App UI structure |
| `styles.css` | Visual styling |

### Infrastructure
| File | Purpose |
|------|---------|
| `preload.js` | IPC bridge to renderer |
| `daemon-manager.js` | Python daemon for fast volume |
| `mediamtx.yml` | MediaMTX config (RTSP/HLS server) |

---

## TV Streaming: Technical Details

### Why TVs Need Different Handling
1. **Custom receivers don't work on TVs** - Only NVIDIA Shield supports them
2. **TVs use Default Media Receiver** - Google's CC1AD845 app
3. **HLS requires AAC codec** - Opus (used for WebRTC) won't play

### HLS URL Structure
```
http://<local-ip>:8888/pcaudio/index.m3u8
                │      │        └── HLS playlist
                │      └── Stream name (from RTSP)
                └── MediaMTX HLS port
```

### MediaMTX Pipeline
```
FFmpeg → RTSP (8554) → MediaMTX → HLS (8888)
         └── Opus or AAC          └── Always AAC segments
```

### Codec Requirements
| Target | Codec | Format |
|--------|-------|--------|
| Speakers (WebRTC) | Opus | RTSP → WebRTC |
| TVs (HLS) | AAC | RTSP → HLS |

**IMPORTANT**: MediaMTX transcodes RTSP to HLS, but codec compatibility matters!

---

## Audio Sync System

### Components
1. **Equalizer APO** - Adds delay to PC speakers
2. **audio-sync-manager.js** - Writes delay config
3. **auto-sync-manager.js** - Monitors network, auto-adjusts

### Config Files
```
C:\Program Files\EqualizerAPO\config\
├── config.txt              # Main APO config
└── pcnestspeaker-sync.txt  # Our delay settings (included by config.txt)
```

### Auto-Sync Algorithm
```
1. User calibrates "perfect" sync → baseline (delay + RTT)
2. Every 500ms (0.5s), ping speaker to measure current RTT
3. If RTT drift > 10ms, adjust delay proportionally
4. newDelay = baselineDelay + (currentRTT - baselineRTT)
```

**Note**: Auto-sync checks twice per second for ultra-responsive sync adjustment!

---

## Known Issues & Fixes

### Issue: TV Streaming Broken (Jan 2025)
**Symptom**: Clicking TV device does nothing or errors
**Root Cause**: FFmpeg starts with Opus codec, but HLS needs AAC
**Fix**: Restart FFmpeg with AAC when TV detected

### Issue: APO Warning on Wrong Device
**Symptom**: Warning says "APO not on CABLE Input"
**Root Cause**: checkAPOStatusForCurrentDevice() checked Windows default
**Fix**: Use audioRouting.findRealSpeakers() to check PC speakers

### Issue: Sync Delay Resets on App Exit
**Symptom**: PC speakers delayed even after app closes
**Fix**: cleanup() writes 0ms to APO config synchronously on exit

---

## Ambient Videos (TV Feature)

### Location
Hosted on Cast receiver (VISUAL_APP_ID)

### Requirements
- TV must be connected via HLS
- tvVisualsToggle must be enabled
- Receiver must support video overlay

### Implementation
The VISUAL receiver (`FCAA4619`) loads ambient videos from CDN when streaming starts.

---

## Commands Reference

### Python Cast Commands (cast-helper.py)
```bash
# Discovery
python cast-helper.py discover

# WebRTC streaming (speakers)
python cast-helper.py webrtc-launch <name> <url> [ip] [stream] [app_id]

# HLS streaming (TVs)
python cast-helper.py hls-cast <name> <url> [ip] [model]

# Stop
python cast-helper.py stop <name>
python cast-helper.py stop-fast <name> <ip>

# Volume
python cast-helper.py set-volume <name> <0.0-1.0>
python cast-helper.py set-volume-fast <name> <0.0-1.0> [ip]

# Groups
python cast-helper.py get-group-members <name>
```

### IPC Handlers
```javascript
// Streaming
'start-streaming'      // Main streaming (auto-detects TV vs speaker)
'stop-streaming'       // Stop current stream
'start-tv-streaming'   // Explicit TV/HLS streaming (unused now)
'stop-tv-streaming'    // Stop TV streaming

// Audio Sync
'set-sync-delay'       // Set APO delay (ms)
'get-sync-delay'       // Get current delay
'enable-auto-sync'     // Start network monitoring
'disable-auto-sync'    // Stop monitoring

// Discovery
'discover-devices'     // Find all speakers/TVs
```

---

## Build & Release

### Commands
```bash
npm run build          # Build installer + portable
npm run dev            # Dev mode with hot reload
```

### Outputs
```
dist/
├── PC Nest Speaker Setup 1.0.0.exe  # NSIS installer
├── PC Nest Speaker 1.0.0.exe        # Portable
└── win-unpacked/                    # Unpacked build
```

---

## Session: January 10, 2025 - UI/UX Improvements

### CSS Variables Added
Added warm neutral color palette to `:root` in `styles.css`:
```css
--color-grey: #6B6D76;
--color-beige: #A69888;
--color-blush: #FCBFB7;
--color-blue: #334E58;
--color-coffee: #33261D;
```

### Speaker List "Ears" (Colored Borders)
Visual indicators showing stereo channel assignment:

| Device Type | Behavior |
|-------------|----------|
| **Stereo devices** (TVs, Groups) | Both ears show when streaming (left + right borders) |
| **Mono speakers with L selected** | Only left ear (left border) |
| **Mono speakers with R selected** | Only right ear (right border) |

**CSS Classes**: `.speaker-left` (left border), `.speaker-right` (right border)
**Color**: `var(--color-beige)` (#A69888)

### Wall of Sound Section
Renamed "OPTIONS" → "WALL OF SOUND" with these features:
- **"Add PC speaker"** toggle - Enables PC speaker in sync with Nest
- **Ⓦ button** - Click to jump to Settings > Sync section
- **Auto-sync auto-start** - When PC speaker enabled, auto-sync starts immediately

### Section Label Spacing
Added `margin-top: 20px` to `.section-label` for better visual separation between "CAST TO" and "WALL OF SOUND" sections.

### Stereo Badge Alignment
Fixed vertical alignment of ⓘ info icons by setting `.stereo-badge` to fixed `width: 68px` (matches L+R button width of 32+32+4gap).

### Smart PC Speaker Detection
On first run, the app captures the user's default audio device and saves it to `settings.detectedRealSpeakers`. This prevents needing to configure which device is the "PC speaker" - it remembers what they had before we installed.

**File**: `audio-routing.js` - `findRealSpeakers()` checks saved device first, falls back to pattern matching.

### Files Modified
| File | Changes |
|------|---------|
| `src/renderer/styles.css` | CSS variables, ear colors, badge width, section spacing, info-icon styling |
| `src/renderer/index.html` | Wall of Sound section, Ⓦ button, sync settings restructure |
| `src/renderer/renderer.js` | Ear class logic for stereo devices, Ⓦ click handler, auto-sync on PC enable |
| `src/main/audio-routing.js` | Smart first-run speaker detection |

---

## Session: January 11, 2025 - WebRTC Latency Optimization (MAJOR)

### Problem
Streaming delay increased from "instantaneous" to ~1 second over 3 days of development.

### Root Cause
`startFFmpegWebRTC()` function was missing ALL low-latency FFmpeg flags that existed in `audio-streamer.js`.

### Fixes Applied

#### 1. FFmpeg Input Flags (electron-main.js ~line 770)
```javascript
'-fflags', 'nobuffer',      // Don't buffer input
'-flags', 'low_delay',       // Low delay mode
'-probesize', '32',          // Minimal probing
'-analyzeduration', '0',     // No analysis delay
'-rtbufsize', '64k',         // Small real-time buffer
'-audio_buffer_size', '50',  // DirectShow: 50ms (was 500ms default!)
```

#### 2. FFmpeg Output Flags
```javascript
'-flush_packets', '1',       // Flush immediately
'-max_delay', '0',           // No muxer delay
'-muxdelay', '0',            // No mux delay
```

#### 3. Opus Encoder Low-Latency
```javascript
'-application', 'lowdelay',  // Opus low-delay mode
'-frame_duration', '20',     // 20ms frames (balanced)
```

#### 4. MediaMTX Config (mediamtx-audio.yml)
```yaml
writeQueueSize: 64  # Reduced from 512 for lower latency
```

#### 5. Cast Receiver (receiver.html - pushed to GitHub Pages)
```javascript
event.receiver.jitterBufferTarget = 50; // 50ms buffer (balanced)
```

#### 6. Stereo FFmpeg Commands
Fixed TWO locations (~line 1560, ~line 2311) where stereo mode FFmpeg was launched WITHOUT low-latency flags.

#### 7. Parallel Speaker Connection for Stereo (CRITICAL FIX)
**Problem**: L/R speakers were connecting SEQUENTIALLY causing left to play before right.
**Fix**: Use `Promise.all()` to connect both speakers simultaneously:
```javascript
const [leftResult, rightResult] = await Promise.all([
  runPython(['webrtc-launch', leftMember.name, ...]),
  runPython(['webrtc-launch', rightMember.name, ...])
]);
```

### PC Speaker Sync Auto-Correction

Old saved delays (700-1200ms from slow streaming) were causing 10+ second delays with optimized WebRTC.

**Solution**: Auto-correct delays > 300ms down to 100ms and notify UI:
```javascript
// electron-main.js
if (settings.syncDelayMs > OLD_STREAMING_THRESHOLD) {  // > 300ms
  actualDelay = CORRECTED_DELAY;  // 100ms
  mainWindow.webContents.send('sync-delay-corrected', actualDelay);
}
```

**New IPC Event**: `sync-delay-corrected` → updates slider in renderer

### Files Modified
| File | Changes |
|------|---------|
| `src/main/electron-main.js` | FFmpeg flags, parallel stereo, sync auto-correction |
| `src/main/preload.js` | Added `onSyncDelayCorrected` event |
| `src/renderer/renderer.js` | Listener for sync correction, updates slider |
| `src/renderer/index.html` | Updated sync hint text (~50-200ms typical) |
| `mediamtx/mediamtx-audio.yml` | writeQueueSize: 64 |
| `cast-receiver/receiver.html` | jitterBufferTarget: 50ms |

### Results
- **Before**: ~1 second delay
- **After**: "INSTANT" (user confirmed)
- **Stereo sync**: Fixed - L/R now perfectly aligned

### TODO for Next Session
1. **TV Streaming (HLS) - NOT TESTED**
   - TV streaming uses different code path (HLS, not WebRTC)
   - May need AAC codec switch verification
   - Test with "green tv" device
   - Check `hls-cast` command in cast-helper.py
   - Verify FFmpeg restarts with AAC when TV detected

### Lessons Learned

#### 1. DirectShow `-audio_buffer_size` is a MASSIVE latency source
Default is ~500ms. Setting to 50ms cut latency dramatically. This is the FIRST thing to check for audio latency on Windows.

#### 2. FFmpeg flags must be applied EVERYWHERE
When refactoring code, it's easy to create new FFmpeg spawn points that don't inherit flags from the original. Found THREE places (main, stereo left, stereo right) all missing flags.

#### 3. Parallel async operations fix sync issues
Sequential `await` calls for L/R speakers caused timing drift. `Promise.all()` ensures both start simultaneously.

#### 4. Old calibration values become invalid after optimization
Users who calibrated sync delay at 950ms for OLD latency now have wrong values. Auto-correction on startup is essential UX.

#### 5. WebRTC jitterBufferTarget API exists
`RTCRtpReceiver.jitterBufferTarget` lets you control receiver-side buffering. 50ms is a good balance between latency and stability.

#### 6. Prove before changing
User asked for research/proof before making changes. Git history (`git log --oneline -p -- filename`) reveals when/where bugs were introduced.

---

## Session: January 11, 2025 (Continued) - Auto-Sync & Stereo Fixes

### Problem
PC speakers and Nest were "out of time" - auto-sync wasn't keeping them in sync.

### Root Causes Found

#### 1. MIN_DELAY_MS Too High
`auto-sync-manager.js` had `MIN_DELAY_MS = 200` which prevented low delays.
**Fix**: Changed to `MIN_DELAY_MS = 0` for full 0-2000ms range.

#### 2. Delay Manager State Desync
Two delay managers weren't communicating:
- `pc-speaker-delay.js` - Writes APO config
- `audio-sync-manager.js` - Tracks `currentDelayMs` for auto-sync

When `toggle-pc-audio` called `pcSpeakerDelay.setDelay()`, `audioSyncManager.currentDelayMs` stayed 0.
Auto-sync baseline was set to 0ms, so it never adjusted correctly.

**Fix** (electron-main.js ~line 2773):
```javascript
await pcSpeakerDelay.setDelay(actualDelay);
// CRITICAL: Also update audioSyncManager's internal state!
await audioSyncManager.setDelay(actualDelay);
```

#### 3. Missing setBaseline() Calls
Found 3 places where `autoSyncManager.start()` was called WITHOUT `setBaseline()`:
- Line 1261 (HTTP streaming)
- Line 1403 (TV visual streaming)
- Line 1755 (WebRTC stereo streaming)

**Fix**: Added `await autoSyncManager.setBaseline()` after each `start()` call.

### Stereo Auto-Connect
Also added in this session (before continuation):
- `lastStereoSpeakers` setting saves L/R pair
- `lastMode` setting tracks 'single' vs 'stereo'
- `auto-connect-stereo` IPC event restores stereo mode on restart
- Fixed race condition with async chaining in startup sequence

### Files Modified
| File | Changes |
|------|---------|
| `src/main/auto-sync-manager.js` | MIN_DELAY_MS: 200 → 0 |
| `src/main/electron-main.js` | State sync, baseline calls, stereo persistence |
| `src/main/settings-manager.js` | lastStereoSpeakers, lastMode defaults |
| `src/main/preload.js` | onAutoConnectStereo, onSyncDelayCorrected events |
| `src/renderer/renderer.js` | Stereo auto-connect handler |

---

## Session: January 12, 2025 - Audio Restore & Documentation

### Problem 1: Audio Output Device Not Restored on Exit
User showed Windows Sound Output settings screenshot proving original device wasn't restored when app closed.

### Root Cause
`originalDefaultDevice` variable in `audio-routing.js` was declared but NEVER USED. No code ever saved or restored it.

### Fix Applied
Added three new functions to `audio-routing.js`:
```javascript
let originalDefaultDevice = null;

async function saveOriginalDevice() {
  if (originalDefaultDevice) return originalDefaultDevice;  // Already saved
  const current = await getCurrentDefaultDevice();
  if (current) {
    originalDefaultDevice = current;
    console.log(`[AudioRouting] Saved original device: ${originalDefaultDevice}`);
  }
  return originalDefaultDevice;
}

async function restoreOriginalDevice() {
  if (!originalDefaultDevice) return { success: false };
  const result = await setDefaultDevice(originalDefaultDevice);
  if (result.success) originalDefaultDevice = null;
  return result;
}

function getOriginalDevice() {
  return originalDefaultDevice;
}
```

**Integration Points**:
- `preStartWebRTCPipeline()` → calls `saveOriginalDevice()` BEFORE switching to VB-Cable
- `cleanup()` → calls `restoreOriginalDevice()` on app exit

### Problem 2: Audio Output Grid Missing from UI
The CSS and JS for audio output device switching existed, but the HTML element was completely missing from `index.html`.

### Fix Applied
Added to `index.html`:
```html
<div class="section" id="audio-output-section">
  <h2 class="section-label">PC AUDIO OUTPUT</h2>
  <p class="option-hint">Click to switch Windows audio output device</p>
  <div class="audio-output-grid" id="audio-output-list">
    <div class="audio-output-loading">Loading devices...</div>
  </div>
</div>
```

Changed `styles.css`:
```css
.audio-output-grid {
  display: flex; /* Was: display: none; */
}
```

Added `loadAudioOutputs()` call in `renderer.js` DOMContentLoaded.

### Volume Sync Working
Confirmed volume sync (PC keyboard → Nest + PC speakers) was already working from previous session:
- `setDeviceVolume()` - Uses SoundVolumeView for per-device control
- `setPCSpeakerDevice()` / `setPCSpeakerVolume()` - PC speaker volume control
- All 7 volume callbacks in `electron-main.js` include PC speaker volume

### Files Modified
| File | Changes |
|------|---------|
| `src/main/audio-routing.js` | Added save/restore device functions |
| `src/main/electron-main.js` | Save in preStart, restore in cleanup |
| `src/renderer/index.html` | Added audio-output-section HTML |
| `src/renderer/styles.css` | Changed audio-output-grid to display: flex |
| `src/renderer/renderer.js` | Added loadAudioOutputs() on startup |

---

## Complete Sync System Documentation

### Architecture Overview

The sync system has THREE layers that work together:

```
Layer 1: APO Delay (pc-speaker-delay.js / audio-sync-manager.js)
  └─> Writes delay config to: C:\Program Files\EqualizerAPO\config\pcnestspeaker-sync.txt
  └─> Format: "Delay: 150 ms" (or 0 when streaming stops)

Layer 2: Auto-Sync Monitoring (auto-sync-manager.js)
  └─> Polls network RTT every 500ms via ping
  └─> Adjusts delay if drift > 10ms from baseline
  └─> Formula: newDelay = baselineDelay + (currentRTT - baselineRTT)

Layer 3: Volume Sync (windows-volume-sync.js)
  └─> Polls Windows master volume every 500ms via PowerShell Core Audio API
  └─> On change: sets Nest volume + PC speaker volume (via SoundVolumeView)
```

### Key Parameters

| Parameter | Value | File | Purpose |
|-----------|-------|------|---------|
| `CHECK_INTERVAL_MS` | 500 | auto-sync-manager.js | RTT check frequency |
| `ADJUSTMENT_THRESHOLD_MS` | 10 | auto-sync-manager.js | Min drift to trigger adjustment |
| `MIN_DELAY_MS` | 0 | auto-sync-manager.js | Allows zero delay (WebRTC is fast!) |
| `MAX_DELAY_MS` | 2000 | auto-sync-manager.js | Maximum delay cap |
| `DEBOUNCE_MS` | 200 | windows-volume-sync.js | Volume change debounce |
| `jitterBufferTarget` | 50ms | receiver.html | WebRTC receiver buffer |

### Module Responsibilities

| Module | Purpose | State |
|--------|---------|-------|
| `pc-speaker-delay.js` | Direct APO config writer | `currentDelayMs` |
| `audio-sync-manager.js` | Main sync manager with APO | `currentDelayMs` |
| `auto-sync-manager.js` | Network monitoring | `baselineRtt`, `baselineDelay` |
| `windows-volume-sync.js` | Windows → Nest volume | `lastVolume`, `targetSpeakers` |

### CRITICAL: State Synchronization

When `toggle-pc-audio` sets delay, BOTH managers must be updated:
```javascript
await pcSpeakerDelay.setDelay(actualDelay);
await audioSyncManager.setDelay(actualDelay);  // CRITICAL!
```

When `autoSyncManager.start()` is called, ALWAYS follow with:
```javascript
await autoSyncManager.setBaseline();
```

### Flow: User Enables "PC + Speakers" Mode

```
1. User toggles "Add PC speaker" in Wall of Sound
2. renderer.js → IPC 'toggle-pc-audio' → electron-main.js
3. Load saved syncDelayMs from settings (or default 100ms)
4. If delay > 300ms (old calibration), auto-correct to 100ms
5. pcSpeakerDelay.setDelay() → writes APO config
6. audioSyncManager.setDelay() → updates internal state
7. Enable "Listen to this device" on VB-Cable Output
8. autoSyncManager.start(speaker)
9. autoSyncManager.setBaseline() → captures RTT + delay baseline
10. Every 500ms: check RTT, adjust delay if drifted > 10ms
```

### Tools Used

| Tool | Location | Purpose |
|------|----------|---------|
| **Equalizer APO** | `C:\Program Files\EqualizerAPO` | Audio processing with delay |
| **SoundVolumeView** | `soundvolumeview/SoundVolumeView.exe` | Per-device volume control |
| **audioctl.exe** | `audioctl/WindowsAudioControl-CLI.exe` | "Listen to this device" toggle |

---

## Session: January 12, 2025 (Continued) - Boot Audio Switch Fix

### Problem
App boots, discovers speakers, connects to Nest (ping heard!), UI shows streaming... but no actual audio streams. Windows audio was NOT switching to VB-Cable on boot.

### Root Cause
`preStartWebRTCPipeline()` did:
1. Save original device ✅
2. Find VB-Cable Output for FFmpeg ✅
3. Start MediaMTX ✅
4. Start FFmpeg ✅

**But NEVER switched Windows default audio to VB-Cable Input!**

FFmpeg captures from "CABLE Output", but Windows was still sending audio to real speakers. No audio flowed through VB-Cable to FFmpeg.

### Fix Applied
Added VB-Cable switch in `preStartWebRTCPipeline()` (electron-main.js ~line 1027-1040):

```javascript
// CRITICAL: Switch Windows audio to VB-Cable Input so audio flows through the virtual cable
// FFmpeg captures from CABLE Output, so Windows must render to CABLE Input
const vbCableInput = await audioRouting.findVirtualDevice();
if (vbCableInput) {
  const deviceName = vbCableInput.name || vbCableInput;
  const switchResult = await audioRouting.setDefaultDevice(deviceName);
  if (switchResult.success) {
    sendLog(`[Background] Windows audio switched to: ${deviceName}`);
  } else {
    sendLog(`[Background] WARNING: Failed to switch to VB-Cable: ${switchResult.error}`, 'warning');
  }
} else {
  sendLog('[Background] WARNING: VB-Cable Input not found - audio may not stream!', 'warning');
}
```

### Audio Flow (Now Correct)
```
Windows Apps → VB-Cable Input (render) → VB-Cable Output (capture) → FFmpeg → Nest Speaker
```

### Files Modified
| File | Changes |
|------|---------|
| `src/main/electron-main.js` | Added setDefaultDevice() call in preStartWebRTCPipeline() |
| `.claude/CLAUDE.md` | Documented this fix |

---

## Session: January 12, 2025 (Continued) - Auto-Sync & Audio Pill Fixes

### Problem 1: Auto-Sync Not Running
User enabled "Add PC speaker" toggle but logs showed NO auto-sync messages ("no monitoring" in logs).

### Root Cause
`autoSyncEnabled` and `pcAudioEnabled` were separate flags. The `toggle-pc-audio` handler set `pcAudioEnabled` but never enabled auto-sync. User clarified: **"PC speaker and sync are the same function... both need each other"**

### Fix Applied
Modified `toggle-pc-audio` handler (electron-main.js) to couple PC speaker mode with auto-sync:

**When enabled:**
```javascript
// AUTO-SYNC: PC speaker and sync are coupled - when PC speaker is ON, auto-sync starts
if (currentConnectedSpeakers.length > 0) {
  const speakerForSync = currentConnectedSpeakers[0];
  if (speakerForSync?.ip) {
    autoSyncEnabled = true;
    settingsManager.setSetting('autoSyncEnabled', true);
    autoSyncManager.start(speakerForSync);
    await autoSyncManager.setBaseline();
    sendLog(`Auto-sync started for "${speakerForSync.name}" (coupled with PC speaker mode)`);
  }
}
```

**When disabled:**
```javascript
if (autoSyncEnabled) {
  autoSyncEnabled = false;
  settingsManager.setSetting('autoSyncEnabled', false);
  autoSyncManager.stop();
  sendLog(`Auto-sync stopped (PC speaker mode disabled)`);
}
```

Also updated 4 streaming code paths to check `(autoSyncEnabled || pcAudioEnabled)`:
- Line 1299 (HTTP streaming)
- Line 1447 (TV visual streaming)
- Line 1810 (WebRTC mono)
- Line 2538 (stereo streaming - NEW addition)

### Problem 2: Audio Output Pill Not Updating
When streaming started and Windows switched to VB-Cable, the audio output pill didn't refresh to show VB-Cable as active.

### Fix Applied
1. Added IPC event `audio-device-changed` sent from main when setDefaultDevice() succeeds
2. Added handler in renderer.js to refresh audio outputs on device change

**electron-main.js** (~line 1032-1035):
```javascript
// Notify renderer to refresh audio output list
if (mainWindow && mainWindow.webContents) {
  mainWindow.webContents.send('audio-device-changed', deviceName);
}
```

**preload.js** (new event):
```javascript
onAudioDeviceChanged: (callback) => {
  ipcRenderer.on('audio-device-changed', (event, deviceName) => callback(deviceName));
},
```

**renderer.js** (new handler):
```javascript
window.api.onAudioDeviceChanged((deviceName) => {
  console.log(`[Renderer] Audio device changed to: ${deviceName}`);
  loadAudioOutputs();  // Refresh the pill UI
});
```

### Files Modified
| File | Changes |
|------|---------|
| `src/main/electron-main.js` | Auto-sync coupling with PC toggle, 4 streaming paths updated, audio-device-changed event |
| `src/main/preload.js` | Added `onAudioDeviceChanged` event |
| `src/renderer/renderer.js` | Added audio device change listener |
| `.claude/CLAUDE.md` | Documented fixes |

### Problem 3: PC Speaker Mode Not Restored on Boot
User reported having to toggle PC speaker setting every boot even though it was saved as ON.

### Root Cause
`loadSettings()` in renderer sets `pcAudioEnabled = true` from settings but doesn't call `togglePCAudio(true)` to actually enable PC speaker mode in main process.

### Fix Applied
Added PC speaker mode restore in auto-connect handlers (after streaming starts):

**renderer.js** (both single and stereo handlers):
```javascript
// RESTORE PC SPEAKER MODE: If setting was saved as ON, enable it now that streaming is active
if (pcAudioEnabled && pcAudioToggle && pcAudioToggle.checked) {
  log('Restoring PC speaker mode from saved settings...', 'info');
  await togglePCAudio(true);
}
```

This runs AFTER `startStreamingToSpeaker()` / `startStereoStreaming()` succeeds, ensuring:
1. Streaming is active (speaker connected)
2. PC speaker mode is enabled (Listen to this device + APO delay)
3. Auto-sync starts automatically (speaker IP available)

### Key Insight
**PC speaker mode and auto-sync are now unified AND persist across restarts.** When user toggles "Add PC speaker" ON:
1. PC speakers enabled via "Listen to this device"
2. APO delay applied
3. Auto-sync monitoring starts automatically
4. Network RTT monitored every 500ms
5. Delay auto-adjusted if drift > 10ms
6. Setting saved → restored on next boot

---

## Session: January 12, 2025 (Continued) - Cast Ping/Chime Consistency Fix

### Problem
User reported: "I want the ping noise it looks more professional. it seems very hit and miss getting the noise on connections and disconnection. now sure why?!"

### Root Cause Discovery
The Cast "ding" sound on Nest speakers **ONLY plays when `start_app()` is called**, NOT when `quit_app()` is called!

This means:
- **Connect ping**: Worked inconsistently because if Cast app was already running, `start_app()` just resumes it (no ding)
- **Disconnect ping**: NEVER existed - `quit_app()` has no chime by default!

### Fix Applied

#### 1. Disconnect Chime - cast-daemon.py
Added in `disconnect_speaker()`: After `quit_app()`, briefly launch Default Media Receiver (CC1AD845) to trigger the ding, then quit again:
```python
# After quit_app() stops audio...
time.sleep(0.3)
cast.start_app("CC1AD845")  # Default Media Receiver - triggers ding!
time.sleep(1.0)  # Let the chime play
cast.quit_app()  # Clean up - leave speaker idle
```

#### 2. Disconnect Chime - cast-helper.py
Same pattern added to:
- `stop_cast()` (regular stop via discovery)
- `stop_cast_fast()` (fast stop via cached IP)

#### 3. Connect Chime Consistency
Added `quit_app()` BEFORE `start_app()` to ensure fresh session:
- `webrtc_launch()` - main WebRTC connection path
- `webrtc_proxy_connect()` - proxy signaling path
- `hls_cast_to_tv()` - TV HLS streaming path

```python
# ENSURE CONNECT CHIME: Quit any existing app first for fresh session
try:
    cast.quit_app()
    time.sleep(0.5)
except:
    pass  # Ignore if nothing to quit
```

### Files Modified
| File | Changes |
|------|---------|
| `src/main/cast-daemon.py` | `disconnect_speaker()` - added disconnect chime |
| `src/main/cast-helper.py` | `stop_cast()`, `stop_cast_fast()` - added disconnect chime |
| `src/main/cast-helper.py` | `webrtc_launch()`, `webrtc_proxy_connect()`, `hls_cast_to_tv()` - added quit before start for consistent connect chime |

### Technical Note
The Default Media Receiver app ID `CC1AD845` is Google's built-in receiver. Starting it triggers the Cast "ding" sound. We briefly start it (just long enough for the chime ~1 second) then quit to leave the speaker idle.

---

## Session: January 12, 2025 (Continued) - Audio Visualizer & Shield Fix

### Visualizer Styling Updates
User requested grey tops on audio bars with rounded ends, color changing to green when streaming.

**CSS Changes (styles.css)**:
```css
.visualizer-bar {
  border-radius: 3px 3px 0 0;  /* Rounded top caps */
  min-height: 8px;  /* Increased visibility */
  opacity: 0.7;
  /* Gradient: grey at top fading to pink at bottom (idle) */
  background: linear-gradient(to bottom, #CCCCCC 0%, #EF476F 100%);
}

.visualizer-bar.active {
  opacity: 1;
  /* Gradient: grey at top fading to green at bottom (streaming) */
  background: linear-gradient(to bottom, #CCCCCC 0%, var(--green) 100%);
}
```

Also added missing `<h2 class="section-label">STREAM MONITOR</h2>` to index.html.

### NVIDIA Shield Streaming Fix

**Problem**: Shield was failing with `RequestTimeout: Execution of start app FCAA4619 timed out after 10.0 s`

**Root Cause**: Line 1410 had `if (isTv && !isShield)` which EXCLUDED Shield from the TV path. Shield was falling through to regular WebRTC handling which tries Visual receiver without HLS fallback.

**Fix**: Removed `&& !isShield` from the condition so Shield flows through TV path with automatic HLS fallback:
```javascript
// Before: if (isTv && !isShield) {
// After:  if (isTv) {
```

**Flow after fix**:
1. Shield detected as TV device (🎮 icon)
2. Tries Visual receiver first (will timeout ~10s)
3. Falls back to HLS streaming (works!)
4. Uses Default Media Receiver (`CC1AD845`) for HLS

### Files Modified
| File | Changes |
|------|---------|
| `src/main/electron-main.js` | Removed `!isShield` exclusion, added Shield-specific logging |
| `src/renderer/styles.css` | Visualizer bar styling with gradients and rounded tops |
| `src/renderer/index.html` | Added STREAM MONITOR section header |

---

## Session: January 12, 2025 (Continued) - LibOpus Timing Fix

### Problem
User reported: "any load on the PC is pushing the audio out of sync!"

FFmpeg logs showed:
```
[libopus @ 000001A2B3C4D5E6] Queue input is backward in time
```

### Root Cause
Under high CPU load, Windows DirectShow audio capture becomes irregular:
- Audio frames delayed or dropped
- Timestamps become non-monotonic
- libopus encoder rejects frames arriving "backward in time"

### Solution: Add `-async 1` to FFmpeg
The `-async 1` flag tells FFmpeg to resample audio to maintain monotonic timestamps.
- Inserts silence for gaps
- Drops samples for overlaps
- Keeps stream synchronized regardless of CPU load

### Implementation
Added `-async 1` to THREE locations in `electron-main.js`:

1. **Line ~807** - Main `startFFmpegWebRTC()` (mono Opus):
```javascript
'-i', `audio=${audioDevice}`,
// CRITICAL: -async 1 fixes "[libopus] Queue input is backward in time" under CPU load
'-async', '1',
'-af', `volume=${boostLevel}`
```

2. **Line ~1682** - Stereo in Cast Group handler (dual Opus)
3. **Line ~2475** - Second stereo location (dual Opus)

**Note**: AAC/HLS locations (for TVs) use a different codec and don't need this fix.

### Files Modified
| File | Changes |
|------|---------|
| `src/main/electron-main.js` | Added `-async 1` flag to 3 libopus FFmpeg locations |
| `docs/TV_CASTING_FIX_PLAN.md` | Documented the fix |
| `.claude/CLAUDE.md` | Session documentation |

---

## Session: January 12, 2025 (Continued) - TV Streaming Firewall Fix

### Problem
TV streaming (HLS) not working - when trying to access `http://192.168.50.48:8890/stream.m3u8`, browser shows "ERR_CONNECTION_REFUSED".

### Root Cause
Windows Firewall was blocking port 8890 (HLS server). The `firewall-setup.js` module existed and was called on startup, but **port 8890 was NOT in the rules list**!

Existing rules:
- 8000-8010 (HTTP)
- 8889 (WebRTC)
- 8189 (ICE UDP + TCP)

**Missing**: 8890 (HLS server for TV/Chromecast streaming)

### Fix Applied

1. **Added HLS port to firewall rules** (`src/main/firewall-setup.js`):
```javascript
const RULES = [
  { name: 'PC Nest Speaker HTTP', ports: '8000-8010', protocol: 'TCP' },
  { name: 'PC Nest Speaker WebRTC', ports: '8889', protocol: 'TCP' },
  { name: 'PC Nest Speaker ICE UDP', ports: '8189', protocol: 'UDP' },
  { name: 'PC Nest Speaker ICE TCP', ports: '8189', protocol: 'TCP' },
  { name: 'PC Nest Speaker HLS TV', ports: '8890', protocol: 'TCP' }  // NEW!
];
```

2. **Force re-check for new rules** - Removed early-exit when setup was "completed" so app always checks for missing rules on startup.

### Behavior After Fix
On next app startup:
1. App checks for all 5 firewall rules
2. Detects "PC Nest Speaker HLS TV" is missing
3. Shows Windows UAC prompt for admin permission
4. Adds the rule automatically
5. TV streaming should work!

### Files Modified
| File | Changes |
|------|---------|
| `src/main/firewall-setup.js` | Added port 8890 rule, force re-check for updates |
| `.claude/CLAUDE.md` | Session documentation |

---

*Last Updated: January 12, 2025*
