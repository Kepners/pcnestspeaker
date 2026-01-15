# PC Nest Speaker - Lessons Learned

Project-specific knowledge extracted from development sessions.

---

## FFmpeg Low-Latency on Windows

### DirectShow Audio Buffer is HUGE by Default
```javascript
'-audio_buffer_size', '50',  // DirectShow default is ~500ms! Set to 50ms.
```
**This is the FIRST thing to check for audio latency on Windows.**

### Required Low-Latency Flags
```javascript
// Input flags
'-fflags', 'nobuffer',
'-flags', 'low_delay',
'-probesize', '32',
'-analyzeduration', '0',
'-rtbufsize', '64k',

// Output flags
'-flush_packets', '1',
'-max_delay', '0',
'-muxdelay', '0',

// Opus encoder
'-application', 'lowdelay',
'-frame_duration', '20',
```

### CPU Load Causes Timestamp Issues
Under high CPU load, DirectShow audio capture becomes irregular:
```
[libopus] Queue input is backward in time
```
**Fix**: Add `-async 1` to FFmpeg - resamples audio to maintain monotonic timestamps.

### Flags Must Be Applied EVERYWHERE
When refactoring, it's easy to create new FFmpeg spawn points that don't inherit flags. Check ALL locations where FFmpeg is launched.

---

## WebRTC Optimization

### Receiver-Side Buffer Control
```javascript
event.receiver.jitterBufferTarget = 50; // 50ms buffer (balanced)
```
The `RTCRtpReceiver.jitterBufferTarget` API controls receiver-side buffering.

### MediaMTX Queue Size
```yaml
writeQueueSize: 64  # Reduced from 512 for lower latency
```

---

## Cast Protocol Quirks

### Chime Behavior
- Cast "ding" **ONLY plays on `start_app()`**, NOT on `quit_app()`
- **Connect chime**: Call `quit_app()` BEFORE `start_app()` for consistent chime
- **Disconnect chime**: Start Default Media Receiver (`CC1AD845`) briefly, then quit

### Audio-Only HLS Doesn't Work
Cast SDK's built-in `cast-media-player` CANNOT play audio-only HLS streams.
**Solution**: Use hls.js library in custom receiver.

### Group Members Must Be Cached
Discovery already happens at boot. Querying group members on click = redundant 10s delay.
**Solution**: Resolve group members during initial discovery, cache for instant access.

---

## Parallel Operations Fix Sync Issues

### Stereo Speaker Connection
Sequential `await` calls for L/R speakers caused timing drift:
```javascript
// BAD - sequential
await connectLeft();
await connectRight();  // Starts later!

// GOOD - parallel
await Promise.all([connectLeft(), connectRight()]);
```

---

## State Management Pitfalls

### Multiple Managers Must Stay Synced
When multiple modules track the same state (e.g., delay), ALL must be updated:
```javascript
await pcSpeakerDelay.setDelay(actualDelay);
await audioSyncManager.setDelay(actualDelay);  // CRITICAL - don't forget!
```

### Old Calibration Values Become Invalid
After optimization, old saved values (e.g., 950ms delay) cause problems.
**Solution**: Auto-correct on startup and notify UI.

### Manager Start Must Include Baseline
```javascript
autoSyncManager.start(speaker);
await autoSyncManager.setBaseline();  // ALWAYS follow start() with setBaseline()
```

---

## Windows Audio Routing

### VB-Cable Flow
```
Windows Apps → VB-Cable Input (render) → VB-Cable Output (capture) → FFmpeg
```
- Windows must render TO "CABLE Input"
- FFmpeg captures FROM "CABLE Output"
- Forgetting to switch Windows default = no audio!

### Save/Restore Original Device
Always save original audio device BEFORE switching, restore on exit.

---

## Firewall Gotchas

When adding new ports, the app must re-check rules even if "completed" flag is set.
Force re-check on startup to catch new rules.

---

*Last Updated: January 2026*
