# Code Review - January 9, 2026 Evening Session

## Summary

WebRTC streaming was working this morning after ICE negotiation fixes. This evening, switching to Green TV resulted in no audio despite FFmpeg running and volume sync working.

---

## Issue #1: MediaMTX Not Running

### Symptoms
- FFmpeg stats showing in logs (`time=00:00:43.79`)
- Volume sync working (daemon connected to Green TV)
- **NO `[MediaMTX]` logs at all**
- No audio on Green TV

### Root Cause Analysis

**Location:** `electron-main.js` lines 1202-1211

```javascript
// Check if pipeline was pre-started in background
if (webrtcPipelineReady && mediamtxProcess && ffmpegWebrtcProcess) {
  sendLog('Using pre-started WebRTC pipeline', 'success');
  // SKIPS starting MediaMTX - assumes it's running!
} else {
  // Only runs if condition is FALSE
  await startMediaMTX();
}
```

**The Problem:** This check only verifies if the `mediamtxProcess` VARIABLE exists, not if MediaMTX is actually running and healthy.

**Scenario that breaks:**
1. MediaMTX starts successfully
2. MediaMTX crashes (or gets killed)
3. `mediamtxProcess.on('close')` SHOULD set `mediamtxProcess = null`
4. But if the close event doesn't fire (zombie process), the variable still holds a reference
5. Next stream start sees `mediamtxProcess` exists → skips starting MediaMTX
6. FFmpeg publishes to RTSP → nothing receives it → no audio

### Suggested Fix Areas
1. **Line 585-588** - `startMediaMTX()` check should verify process is alive
2. **Line 641-644** - Close handler should always fire
3. **Line 1202** - Add health check before assuming pipeline is ready

---

## Issue #2: Sync Delay Slider Was Hidden

### Status: FIXED

**Before:** `<input type="hidden" id="sync-delay-slider">`
**After:** Visible range slider (0-2000ms, 50ms steps)

**Files changed:**
- `src/renderer/index.html` - Line 161
- `src/renderer/styles.css` - Lines 764-807
- `src/renderer/renderer.js` - Lines 502-508 (event listener)

### How It Works Now
1. User adjusts slider → `handleSyncDelayChange(delayMs)` called
2. Display updates immediately
3. After 500ms debounce → Writes to Equalizer APO config
4. APO applies delay to HDMI output

**Default value:** 0ms (no delay)
**Typical range:** 700-1200ms for WebRTC

---

## Issue #3: Audio Boost Analysis

### Current Implementation

**Cast/Nest speakers (FFmpeg):**
```javascript
// electron-main.js lines 710-712
const boostLevel = volumeBoostEnabled ? 1.25 : 1.03;
// FFmpeg filter: -af volume=1.03 (or 1.25)
```

- **Always:** 3% boost (1.03x) - "secret sauce"
- **With toggle:** 25% boost (1.25x)

**HDMI speakers:**
- **NO boost applied**
- Audio goes through Windows normally

### Question to Resolve
Does the 3% boost cause sync issues? Cast gets boosted audio, HDMI gets normal audio. Could affect perceived timing?

---

## Issue #4: AudioDeviceState Discovery (Fixed Today)

### What Was Fixed
Windows shows multiple devices with the SAME NAME but different `AudioDeviceState` values:
- Active (1) - Working
- NotPresent (4) - Phantom/ghost device

**IPolicyConfig.SetDefaultEndpoint()** returns SUCCESS even on NotPresent devices but silently ignores the switch.

### Files Changed
- `src/main/cast-helper.py` - Filter by Active state in both:
  - `get_audio_outputs()`
  - `set_default_audio_output()`

---

## Issue #5: Sync Delay NOT Dynamic (Analysis Requested)

### The Problem
Cast speakers are BEHIND HDMI speakers. The sync delay slider exists but doesn't work "dynamically" - it requires manual adjustment every time.

### Why It's Not Dynamic

**1. Default Value is 0ms (No Delay)**
```javascript
// settings-manager.js default
syncDelayMs: 0  // No delay by default!
```
On first use, HDMI plays in perfect sync with desktop audio while Cast is ~1 second behind.

**2. No Automatic Latency Measurement**
The code does NOT:
- Measure actual Cast speaker latency
- Send test signals and measure round-trip time
- Calculate optimal delay value automatically

**3. Uses Static Saved Value Only**
```javascript
// electron-main.js lines 2561-2566
const savedDelay = settings.syncDelayMs || 0;
if (savedDelay > 0) {
  await pcSpeakerDelay.setDelay(savedDelay);  // Only if manually set!
} else {
  sendLog('Adjust sync delay slider to match Cast latency', 'info');
}
```
The app only applies a delay if the user has previously set one.

**4. Slider Writes Static Config File**
```javascript
// audio-sync-manager.js setEqualizerAPODelay()
const configLines = [
  '# PC Nest Speaker Audio Sync',
  `Delay: ${delayMs} ms`  // Static value written to file
];
fs.writeFileSync(syncConfigPath, configLines.join('\r\n'));
```
Equalizer APO reads this config file once and applies a fixed delay.

**5. No Feedback Loop**
The system has no way to:
- Know if the delay is correct
- Detect when latency changes (network congestion, speaker distance)
- Self-correct over time

### The Current Flow

```
User adjusts slider (0-2000ms)
        │
        ▼
handleSyncDelayChange(delayMs)
        │
        ▼
500ms debounce
        │
        ▼
window.api.setSyncDelay(delayMs)
        │
        ▼
audioSyncManager.setDelay(delayMs)
        │
        ▼
Writes to: C:\Program Files\EqualizerAPO\config\pcnestspeaker-sync.txt
        │
        ▼
Equalizer APO applies delay to HDMI output
```

### Why Dynamic Measurement is Difficult

**Cast latency varies by:**
- Network congestion (WiFi interference)
- Speaker type (Nest Mini vs Hub vs Group)
- Stream protocol (WebRTC ~500ms, HTTP ~8000ms)
- Processing overhead on the speaker itself

**Would require:**
- Sending calibration tone through both paths
- Receiving confirmation signal from Cast (not possible via Cast SDK)
- Cross-correlation of audio signals (complex)

### Code Locations

| Component | File | Lines |
|-----------|------|-------|
| Default value | settings-manager.js | Default: 0 |
| Load saved delay | electron-main.js | 2561-2566 |
| Slider handler | renderer.js | 2291-2329 |
| APO config write | audio-sync-manager.js | 83-191 |
| APO config write (alt) | pc-speaker-delay.js | 52-83 |

### Current Workaround

**Manual calibration steps:**
1. Enable "PC + Speakers" mode
2. Play music with clear beat (drums work well)
3. Adjust slider until HDMI and Cast sound synchronized
4. Typical values: 700-1200ms for WebRTC
5. Value is saved and reused

**Ping mode (built-in):**
- Toggle ping mode ON
- Slider sends test tone to BOTH outputs
- User listens for when they align
- Toggle ping mode OFF when calibrated

### Possible Future Improvements

1. **Measure latency at stream start** - Send test packet, measure round-trip
2. **Auto-calibrate button** - Play sync tone, ask user to confirm when aligned
3. **Per-speaker presets** - Save different delays for different speakers
4. **Dynamic adjustment** - Monitor for drift and auto-correct (complex)

---

## Tomorrow's Review Starting Points

### Priority 1: MediaMTX Reliability

**File:** `src/main/electron-main.js`

1. **Line 584-688** - `startMediaMTX()` function
   - Check if process health verification is sufficient
   - Look at close/error handlers

2. **Line 1202-1211** - Pipeline ready check
   - Add actual health check (HTTP to :9997)
   - Don't trust variable alone

3. **Search for:** `mediamtxProcess = null`
   - Verify all exit paths clear the variable

### Priority 2: Sync Delay Testing

1. **Enable PC + Speakers mode**
2. **Adjust slider** - Verify delay applies to HDMI
3. **Check APO config** - `C:\Program Files\EqualizerAPO\config\pcnestspeaker-sync.txt`

### Priority 3: Stream Pipeline Tracing

When clicking a speaker, these logs SHOULD appear in order:
1. `[Main] Starting WebRTC pipeline...`
2. `[MediaMTX] Injected local IP: x.x.x.x`
3. `[MediaMTX] Starting MediaMTX server...`
4. `[MediaMTX] Server ready!`
5. `[FFmpeg] Starting...`
6. `MediaMTX server started`
7. `FFmpeg publishing to MediaMTX`

If any are missing, the pipeline broke at that point.

---

## Key Code Locations

| Component | File | Lines |
|-----------|------|-------|
| MediaMTX start | electron-main.js | 584-688 |
| Pipeline ready check | electron-main.js | 1202-1211 |
| FFmpeg WebRTC start | electron-main.js | 700-780 |
| Stop streaming | electron-main.js | 1695-1751 |
| Load saved delay | electron-main.js | 2561-2566 |
| IPC set-sync-delay | electron-main.js | 2626-2635 |
| Sync delay handler | renderer.js | 2291-2329 |
| APO sync manager | audio-sync-manager.js | 251-262 |
| APO delay write (alt) | pc-speaker-delay.js | 52-83 |
| Audio device switch | cast-helper.py | set_default_audio_output() |

---

## Variables to Watch

```javascript
// electron-main.js globals
let mediamtxProcess = null;        // Should be null when not running
let ffmpegWebrtcProcess = null;    // FFmpeg process for WebRTC
let webrtcPipelineReady = false;   // Set true after successful startup
let webrtcPipelineError = null;    // Error message if startup failed
```

---

## Test Scenarios

### Scenario A: Fresh Start
1. Close app completely
2. Start app
3. Wait for "WebRTC pipeline ready"
4. Click Green TV
5. Expected: Audio plays

### Scenario B: Speaker Switch
1. Stream to Den pair (working)
2. Click Green TV to switch
3. Expected: Stop Den pair, start Green TV
4. Check for MediaMTX logs

### Scenario C: PC + Speakers Mode
1. Enable "PC + Speakers"
2. Stream to speaker
3. Adjust sync delay slider
4. Expected: HDMI delay matches Cast latency

---

*Document generated: January 9, 2026 Evening*
*Updated: January 10, 2026 - Added Issue #5 (Sync Delay Dynamic Analysis)*
