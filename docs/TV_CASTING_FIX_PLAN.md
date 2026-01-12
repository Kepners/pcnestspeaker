# TV Casting Fix Plan

*Investigation Started: January 12, 2025*

---

## REPORTED ISSUES

| # | Issue | Symptom |
|---|-------|---------|
| 1 | No Splash Screen | TV shows blue Cast logo on dark grey - no branded splash |
| 2 | No Audio | PC audio not playing on TV via HLS |
| 3 | Screen Flashing | TV flashed a few times during connection |
| 4 | No Disconnect | Switching to Nest speaker didn't stop TV cast |
| 5 | No Volume Sync | Changing volume didn't affect TV |

---

## INVESTIGATION PLAN

### Phase 1: Code Research
1. Trace TV streaming flow from click → cast
2. Identify where splash/receiver is launched
3. Check HLS stream URL construction
4. Verify disconnect logic for TV devices
5. Check volume sync handlers for TV support

### Phase 2: Root Cause Analysis
Document exactly WHY each issue occurs

### Phase 3: Solution Design
Design fixes that won't break existing speaker functionality

### Phase 4: Implementation
Apply fixes, test each issue individually

---

## PHASE 1: CODE RESEARCH

### 1.1 TV Streaming Entry Point

**File**: `src/renderer/renderer.js`
**Function**: `startStreamingToSpeaker()`

When user clicks a TV device, this function is called. Need to verify:
- Does it detect `cast_type === 'cast'` correctly?
- Does it call the right IPC handler?

### 1.2 Main Process TV Handler

**File**: `src/main/electron-main.js`
**IPC Handler**: `start-streaming` or `start-tv-streaming`

Need to trace:
- Which handler is called for TVs?
- Does it start FFmpeg with AAC (not Opus)?
- Does it call `hls-cast` in cast-helper.py?
- What app_id is passed (Visual receiver FCAA4619)?

### 1.3 Python Cast Logic

**File**: `src/main/cast-helper.py`
**Function**: `hls_cast_to_tv()`

Need to verify:
- Is Visual receiver being launched?
- Is HLS URL correct?
- Is cast message being sent to receiver?

### 1.4 Visual Receiver

**File**: `docs/receiver-visual.html`
**Hosted at**: GitHub Pages

Need to verify:
- Is receiver getting the HLS URL?
- Is splash sequence starting?
- Are player event listeners firing?

### 1.5 Disconnect Logic

**File**: `src/main/electron-main.js`

Need to verify:
- Is TV added to `currentConnectedSpeakers`?
- Does `disconnectAllSpeakers()` handle TVs?
- Is `stop-fast` or `stop` being called?

### 1.6 Volume Sync

**File**: `src/main/electron-main.js`
**Function**: Volume IPC handlers

Need to verify:
- Do volume handlers check for TV devices?
- Is `set-volume` or `set-volume-fast` called for TVs?

---

## FINDINGS FROM LOGS

### Finding 1: Visual Receiver TIMEOUT (CRITICAL)
```
[HLS-TV] Receiver launch failed: Execution of start app FCAA4619 timed out after 10.0 s.
[HLS-TV] Falling back to Default Media Receiver...
```

The Visual Receiver (App ID: FCAA4619) is NOT LOADING on the Shield.
- Could be: App ID not registered in Cast Developer Console
- Could be: Receiver URL on GitHub Pages not accessible
- Could be: Shield connectivity issue to receiver host

### Finding 2: Falls Back to Default Media Receiver
After Visual Receiver fails, it falls back to CC1AD845 (Default Media Receiver).
- Default Media Receiver = blue Cast logo on grey background
- NO splash screen, NO ambient videos
- This explains "blue Cast logo on dark grey screen"

### Finding 3: HLS URL Correct
```
[HLS-TV] Playing: http://192.168.50.48:8890/stream.m3u8
[HLS-TV] Playback started!
```
HLS URL is correct and "Playback started!" returns success.

### Finding 4: No Audio Despite "Success"
- mc.play_media() returns success
- mc.block_until_active() completes
- But no audio plays on TV

Possible causes:
- HLS segments not being created (FFmpeg HLS issue)
- Shield can't reach PC (firewall)
- Codec compatibility issue

### Finding 5: Duplicate Operations
The TV streaming code runs TWICE:
1. Once from preStartWebRTCPipeline background start
2. Once from auto-connect

This causes:
- Receiver launch attempted twice
- FFmpeg restarted unnecessarily
- Potential race conditions

### Finding 6: Volume Sync IS Starting
```
[VolumeSync] Target speakers: Green TV
[VolumeSync] Starting Windows volume monitoring...
```
Volume sync starts, but it may not work with Default Media Receiver.

---

## ROOT CAUSES

| Issue | Root Cause |
|-------|------------|
| No Splash | Visual Receiver FCAA4619 fails to launch (timeout), falls back to Default Media Receiver which has no custom UI |
| No Audio | Unknown - HLS reports success but no audio. Need to verify FFmpeg HLS segments are being created |
| Flashing | Duplicate operations - code runs twice (background + auto-connect), receiver launched twice |
| No Disconnect | Code adds TV to currentConnectedSpeakers, but disconnect may not work for Default Media Receiver |
| No Volume Sync | Volume sync starts but Default Media Receiver may handle volume differently |

---

## SOLUTIONS

### Solution 1: Fix Visual Receiver Registration
- Verify FCAA4619 is registered in Google Cast Developer Console
- Verify receiver URL points to accessible GitHub Pages URL
- Add timeout handling and better error messages

### Solution 2: Add FFmpeg HLS Output Monitoring
- Capture and log FFmpeg HLS stderr output
- Verify segments are being created before casting
- Add file existence check for stream.m3u8

### Solution 3: Fix Duplicate Operations
- Add flag to prevent TV streaming from running twice
- Check if already streaming to same device before starting

### Solution 4: Improve Disconnect for Default Media Receiver
- Verify quit_app() works with Default Media Receiver
- Add mc.stop() before quit_app()

### Solution 5: Volume Sync for TV
- Use media_controller.set_volume() for TVs
- Handle case where daemon isn't connected to TV

---

## IMPLEMENTATION LOG

### Step 1: Add FFmpeg HLS stderr logging ✅
**File**: `src/main/electron-main.js` (lines 1498-1516)
- Log ALL HLS-related FFmpeg messages (segment, .ts, .m3u8)
- Log input/output stream mapping
- Flag `hlsSegmentCreated` when segment messages appear

### Step 2: Check segment file existence ✅
**File**: `src/main/electron-main.js` (lines 1522-1536)
- Check if `stream.m3u8` file exists before casting
- Read and log file size
- Check if `.ts` segments are listed in playlist
- Add 3 second additional wait if file not found

### Step 3: Fix duplicate TV streaming ✅
**File**: `src/main/electron-main.js`
- Added `tvStreamingInProgress` flag (line 56)
- Check flag at start of TV streaming (lines 1426-1431)
- Reset flag on failure (line 1588)
- Reset flag in `stop-streaming` handler (line 2072)
- Reset flag in `cleanup()` (line 596)

### Step 4: Fix TV disconnect when switching to speaker ✅
**File**: `src/main/electron-main.js` (lines 1224-1265)
- If daemon returns "Not connected", fall through to `stop-fast`
- Stop HLS server when switching away from TV (lines 1226-1231)
- This fixes TV staying connected when user switches to Nest speaker

### Remaining Issue: Visual Receiver Timeout
The Visual Receiver (FCAA4619) is timing out on Shield:
```
[HLS-TV] Receiver launch failed: Execution of start app FCAA4619 timed out after 10.0 s.
```
This could be:
1. App ID not registered in Google Cast Developer Console
2. Receiver URL on GitHub Pages not accessible
3. Shield can't reach the receiver host

**User action needed**: Verify FCAA4619 is registered and pointing to valid receiver URL.

### Remaining Issue: No Audio Despite HLS Success
Even after "Playback started!", no audio plays. Possible causes:
1. HLS segments not being created (need to verify with new logging)
2. Shield can't reach PC on port 8890 (firewall)
3. FFmpeg codec compatibility issue with Shield

**Next test**: Run app with TV and check new debug logs to see if segments exist.

---

## ADDITIONAL FIX: Audio Sync Under CPU Load

### Problem
User reported: "any load on the PC is pushing the audio out of sync!" and "it slowly gets worse and worse out of time!"

Log showed:
```
[libopus @ ...] Queue input is backward in time
```

### Root Cause
Under high CPU load, Windows DirectShow audio capture becomes irregular:
- Audio frames may be delayed or dropped
- Timestamps become non-monotonic (clock drift)
- libopus encoder sees frames arriving "backward in time"

### Solution: BALANCED Timing (Clock Stability + Low Latency)

**Key insight**: The `-async 1` fix alone wasn't sufficient - it could actually CAUSE drift by resampling.

The BALANCED solution uses:
1. **`-use_wallclock_as_timestamps 1`** - Use stable system clock, not device timestamps
2. **`-thread_queue_size 512`** - Queue absorbs jitter WITHOUT adding latency (only buffers when needed)
3. **`-fflags +genpts+discardcorrupt`** - Generate clean PTS, discard corrupt frames
4. **`aresample=async=1:first_pts=0`** - Handle irregularities in audio filter

**LOW LATENCY preserved:**
- `audio_buffer_size: 50` (not 100ms!)
- `rtbufsize: 64k` (not 512k!)

### Implementation
Applied to THREE FFmpeg locations in `electron-main.js`:

1. **Line ~795** - Main `startFFmpegWebRTC()` (mono Opus)
2. **Line ~1678** - Stereo in Cast Group handler (dual Opus)
3. **Line ~2472** - Second stereo location (dual Opus)

```javascript
// BALANCED TIMING: Clock stability + Low latency
'-thread_queue_size', '512',
'-use_wallclock_as_timestamps', '1',
'-fflags', '+genpts+discardcorrupt',
'-flags', 'low_delay',
'-probesize', '32',
'-analyzeduration', '0',
'-rtbufsize', '64k',  // LOW LATENCY
'-f', 'dshow',
'-audio_buffer_size', '50',  // LOW LATENCY: 50ms
'-i', `audio=${audioDevice}`,
'-af', `aresample=async=1:first_pts=0,volume=${boostLevel}`
```

### Auto-Sync
Ping runs silently every 500ms. Only logs to console (not UI) to avoid spam.

---

*Last Updated: January 12, 2025*
