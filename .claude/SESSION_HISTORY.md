# PC Nest Speaker - Session History

Archived development session notes. Reference for debugging similar issues.

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
**Fix**: Use `Promise.all()` to connect both speakers simultaneously.

### PC Speaker Sync Auto-Correction
Old saved delays (700-1200ms from slow streaming) were causing 10+ second delays with optimized WebRTC.
**Solution**: Auto-correct delays > 300ms down to 100ms and notify UI.

### Results
- **Before**: ~1 second delay
- **After**: "INSTANT" (user confirmed)
- **Stereo sync**: Fixed - L/R now perfectly aligned

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

**Fix** (electron-main.js ~line 2773):
```javascript
await pcSpeakerDelay.setDelay(actualDelay);
// CRITICAL: Also update audioSyncManager's internal state!
await audioSyncManager.setDelay(actualDelay);
```

#### 3. Missing setBaseline() Calls
Found 3 places where `autoSyncManager.start()` was called WITHOUT `setBaseline()`.
**Fix**: Added `await autoSyncManager.setBaseline()` after each `start()` call.

### Stereo Auto-Connect
- `lastStereoSpeakers` setting saves L/R pair
- `lastMode` setting tracks 'single' vs 'stereo'
- `auto-connect-stereo` IPC event restores stereo mode on restart

---

## Session: January 12, 2025 - Audio Restore & Documentation

### Problem 1: Audio Output Device Not Restored on Exit
`originalDefaultDevice` variable in `audio-routing.js` was declared but NEVER USED.

### Fix Applied
Added `saveOriginalDevice()`, `restoreOriginalDevice()`, `getOriginalDevice()` functions.
- `preStartWebRTCPipeline()` → calls `saveOriginalDevice()` BEFORE switching to VB-Cable
- `cleanup()` → calls `restoreOriginalDevice()` on app exit

### Problem 2: Audio Output Grid Missing from UI
The CSS and JS existed, but HTML element was missing from `index.html`.

### Fix Applied
Added `<div class="section" id="audio-output-section">` to index.html.

---

## Session: January 12, 2025 (Continued) - Boot Audio Switch Fix

### Problem
App boots, discovers speakers, connects to Nest (ping heard!), UI shows streaming... but no actual audio streams.

### Root Cause
`preStartWebRTCPipeline()` NEVER switched Windows default audio to VB-Cable Input!
FFmpeg captures from "CABLE Output", but Windows was still sending audio to real speakers.

### Fix Applied
Added VB-Cable switch in `preStartWebRTCPipeline()` (electron-main.js ~line 1027-1040).

### Audio Flow (Now Correct)
```
Windows Apps → VB-Cable Input (render) → VB-Cable Output (capture) → FFmpeg → Nest Speaker
```

---

## Session: January 12, 2025 (Continued) - Auto-Sync & Audio Pill Fixes

### Problem 1: Auto-Sync Not Running
`autoSyncEnabled` and `pcAudioEnabled` were separate flags. User clarified: **"PC speaker and sync are the same function... both need each other"**

### Fix Applied
Coupled PC speaker mode with auto-sync in `toggle-pc-audio` handler.

### Problem 2: Audio Output Pill Not Updating
When streaming started and Windows switched to VB-Cable, the audio output pill didn't refresh.

### Fix Applied
Added IPC event `audio-device-changed` + handler in renderer.js to refresh audio outputs.

### Problem 3: PC Speaker Mode Not Restored on Boot
`loadSettings()` sets `pcAudioEnabled = true` but doesn't call `togglePCAudio(true)`.

### Fix Applied
Added PC speaker mode restore in auto-connect handlers (after streaming starts).

---

## Session: January 12, 2025 (Continued) - Cast Ping/Chime Consistency Fix

### Problem
Cast "ding" sound was hit-and-miss on connections and disconnections.

### Root Cause Discovery
Cast "ding" sound **ONLY plays when `start_app()` is called**, NOT when `quit_app()` is called!

### Fix Applied
1. **Disconnect Chime**: After `quit_app()`, briefly launch Default Media Receiver (CC1AD845) to trigger ding, then quit again.
2. **Connect Chime Consistency**: Added `quit_app()` BEFORE `start_app()` to ensure fresh session.

---

## Session: January 12, 2025 (Continued) - Audio Visualizer & Shield Fix

### Visualizer Styling Updates
Grey tops on audio bars with rounded ends, color changing to green when streaming.

### NVIDIA Shield Streaming Fix
**Problem**: Shield was excluded from TV path with `if (isTv && !isShield)`.
**Fix**: Removed `&& !isShield` so Shield flows through TV path with HLS fallback.

---

## Session: January 12, 2025 (Continued) - LibOpus Timing Fix

### Problem
"any load on the PC is pushing the audio out of sync!" - FFmpeg logs showed `[libopus] Queue input is backward in time`

### Root Cause
Under high CPU load, Windows DirectShow audio capture becomes irregular with non-monotonic timestamps.

### Solution
Added `-async 1` to FFmpeg - resamples audio to maintain monotonic timestamps.

---

## Session: January 12, 2025 (Continued) - TV Streaming Firewall Fix

### Problem
TV streaming (HLS) not working - port 8890 blocked by Windows Firewall.

### Fix Applied
Added port 8890 rule to `firewall-setup.js`.

---

## Session: January 12, 2025 (Continued) - hls.js TV Audio Fix

### Problem
TV/Shield streaming showed visuals but NO audio. Cast SDK's `cast-media-player` fails on audio-only HLS.

### Solution
Added hls.js library to Visual Receiver to handle HLS playback directly.

---

## Session: January 12, 2025 (Continued) - Cast Group Speed Optimization

### Problem
Cast Groups took **12-22 seconds** to connect vs **3-5 seconds** for manual stereo.

### Root Cause
`get-group-members` did full re-discovery (10s) even though discovery already happened at boot.

### Solution
Cache group members during boot discovery. Click → use cached members → connect immediately.

### Results
- **Before**: 12-22 seconds
- **After**: 3-5 seconds

---

*Archived: January 2026*
