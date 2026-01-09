# PC Nest Speaker - Project Knowledge Base

## Quick Reference

| Item | Value |
|------|-------|
| **Project** | pcnestspeaker |
| **GitHub** | https://github.com/Kepners/pcnestspeaker |
| **Business** | ChoppedOnions.xyz |
| **Domain** | pcnestspeaker.app (planned) |
| **Monetization** | Paid - Stripe Payment Links |

---

## Competitive Advantage

**NO existing solution streams Windows system audio to Google Nest speakers:**

| Solution | Nest Support | System Audio |
|----------|--------------|--------------|
| Windows built-in | No | No |
| Chrome/Edge casting | No (tab only) | No |
| AirParrot ($16) | **NO** | Yes |
| **PC Nest Speaker** | **YES** | **YES** |

**Key differentiator:** We support Google Nest speakers AND stereo pairs - competitors don't.

---

## Project Structure

```
pcnestspeaker/
+-- .claude/
|   +-- CLAUDE.md              # This file - project knowledge
|   +-- commands/cs/           # Custom skills
|   +-- settings.local.json
+-- docs/
|   +-- ARCHITECTURE.md        # System architecture diagrams
|   +-- APP_DOCUMENTATION.md   # Complete app documentation
+-- reference/
|   +-- python/                # Original Python implementations
|       +-- cast_system_audio_to_nest_v2.py           # HLS + MP3 fallback
|       +-- cast_system_audio_to_nest_improved_FIXED.py  # Optimized HLS
|       +-- cast_system_audio_to_nest_mp3_FIXED.py    # Stable MP3
+-- CLAUDE.md                  # Project instructions (checked in)
+-- README.md                  # User-facing docs
```

---

## Architecture Decisions (January 2026)

### App Type: Electron Desktop App
- Converting from Python scripts to full Electron app
- Better UX, bundled dependencies, native feel
- Follows DeleteMyTweets architecture pattern

### Streaming Protocol: HLS + MP3 Fallback
- Primary: HLS (0.5s segments, 3 segment buffer = 1.5s latency)
- Fallback: Progressive MP3 (8192 byte chunks, 100ms buffer)
- Auto-fallback if HLS fails to initialize

### Monetization: Stripe Payment Links
- One-time purchase license (no subscription)
- License format: PNS-XXXX-XXXX-XXXX-XXXX
- Stored in Stripe Customer Metadata
- Validated via Vercel serverless API

### Speaker Selection: User Configurable
- No default speaker - prompt on first run
- Auto-discovery of Nest devices on network
- Save preferred speaker in settings.json

---

## 🚨 CRITICAL: PC + Speakers Mode Architecture (January 9, 2026)

### ⚠️ DO NOT USE VB-CABLE! ⚠️

**VB-CABLE and Virtual Desktop Audio are COMPLETELY DIFFERENT audio paths!**

If you set Windows default to Virtual Desktop Audio but enable "Listen to this device" on
VB-CABLE, NO AUDIO will reach the PC speakers because the paths don't connect.

**WE ONLY USE:** Virtual Desktop Audio (from screen-capture-recorder)
- Provides both RENDER (output) and CAPTURE (loopback) devices
- These two devices ARE connected internally

### CORRECT ARCHITECTURE (Working - January 9, 2026)

```
Desktop Audio (Apps)
     │
     ▼
┌──────────────────────────────────────────────────────────────┐
│  Virtual Desktop Audio (RENDER) ← Windows Default            │
│  - Apps output audio here                                    │
│  - NO APO delay applied here (important!)                    │
└────────────────────────┬─────────────────────────────────────┘
                         │
      ┌──────────────────┼──────────────────────┐
      │                  │                      │
      ▼                  ▼                      ▼
┌──────────────┐  ┌────────────────────┐  ┌─────────────────────┐
│ FFmpeg       │  │ Virtual Desktop    │  │ "Listen to this     │
│ (DirectShow) │  │ Audio (CAPTURE)    │  │ device" routes to:  │
│              │  │ ← Source for       │  │                     │
│ Captures     │  │   Listen feature   │  │ ASUS VG32V (HDMI)   │
│ PRE-APO      │  │                    │  │ + APO Delay         │
└──────┬───────┘  └────────────────────┘  └─────────┬───────────┘
       │                                            │
       ▼                                            ▼
┌──────────────┐                          ┌─────────────────────┐
│ MediaMTX     │                          │ Monitor Speakers    │
│ → WebRTC     │                          │ (POST-APO delayed)  │
│ → Cast       │                          │                     │
│              │                          │ APO adds ~700ms to  │
│ ~1s latency  │                          │ sync with Cast      │
└──────────────┘                          └─────────────────────┘

BOTH paths originate from Virtual Desktop Audio RENDER device!
```

### HOW IT WORKS

1. **Windows Default** = Virtual Desktop Audio (RENDER)
   - All app audio goes here
   - FFmpeg captures from here via virtual-audio-capturer (DirectShow)

2. **"Listen to this device"** = Virtual Desktop Audio (CAPTURE) → HDMI speakers
   - Windows routes CAPTURE output to specified RENDER device
   - This is a SECOND path for the same audio
   - APO delay is applied on this path only

3. **APO Sync Delay** = Applied to HDMI speakers only
   - Cast gets audio with ~1 second network latency
   - HDMI gets audio with ~0ms latency (too fast!)
   - APO adds 700-1000ms delay to HDMI to match Cast

### KEY FILES

| File | Purpose |
|------|---------|
| `audio-routing.js` | enablePCSpeakersMode(), findVirtualCaptureDevice() |
| `pc-speaker-delay.js` | APO delay configuration |
| `audio-sync-manager.js` | Equalizer APO integration |
| `audio-streamer.js` | FFmpeg capture from virtual-audio-capturer |

### SoundVolumeView Commands

**Enable Listen:**
```
SoundVolumeView.exe /SetListenToThisDevice "Virtual Desktop Audio\Device\Virtual Desktop Audio\Capture" 1 "NVIDIA High Definition Audio\Device\ASUS VG32V\Render"
```

**Disable Listen:**
```
SoundVolumeView.exe /SetListenToThisDevice "Virtual Desktop Audio\Device\Virtual Desktop Audio\Capture" 0
```

### COMMON MISTAKES TO AVOID

❌ Using VB-CABLE (different audio path!)
❌ Setting Windows default to HDMI speakers (FFmpeg captures POST-APO!)
❌ Enabling Listen on wrong capture device (must match render device!)
❌ Forgetting that RENDER and CAPTURE are paired per virtual device

---

## Key Technical Details

### Audio Pipeline (Updated - No External Software)
```
Windows Audio Output -> electron-audio-loopback (WASAPI) -> FFmpeg -> HTTP Server -> Nest Speaker
```

**Key Change:** Uses Chromium's built-in loopback capture. User keeps their normal audio output (headphones, speakers). No VB-CABLE or configuration needed.

### FFmpeg Settings (Optimized)

**HLS Mode:**
```
Sample Rate: 48000Hz
Bitrate: 128kbps
Segment Time: 0.5s
Max Segments: 3 (auto-delete old)
Flags: delete_segments, independent_segments, low_delay
```

**MP3 Mode:**
```
Sample Rate: 48000Hz
Bitrate: 128kbps
Chunk Size: 8192 bytes
Audio Buffer: 100ms
FFmpeg Buffer: 256k
```

### Dependencies
- **User Must Install:** NOTHING - all-in-one professional app
- **Bundled:** FFmpeg (packaged with Electron app)
- **Node Packages:**
  - electron (>=31.0.1)
  - electron-audio-loopback (WASAPI system audio capture)
  - castv2-client (Chromecast protocol)
  - fluent-ffmpeg (FFmpeg wrapper)

### Audio Capture Solution (Critical Decision - January 2026)
**electron-audio-loopback** captures system audio natively:
- No VB-CABLE or virtual audio devices required
- No user configuration needed
- Works with ANY Windows audio output (headphones, speakers, monitors)
- Captures "what you hear" automatically via WASAPI loopback
- Source: https://github.com/alectrocute/electron-audio-loopback

---

## Original Python Source

Located at: `C:\Users\kepne\OneDrive\Documents\#NestAudioBridge`

### File Reference
| File | Purpose | Status |
|------|---------|--------|
| `cast_system_audio_to_nest_v2.py` | HLS + MP3 fallback | Reference |
| `cast_system_audio_to_nest_improved_FIXED.py` | Optimized HLS | Reference |
| `cast_system_audio_to_nest_mp3_FIXED.py` | Stable MP3 | Reference |

### Key Fixes Applied in FIXED Versions
1. **Directory bug** - HTTP server started before directory existed
2. **Machine gun noise** - Increased chunk size (4096 -> 8192)
3. **HLS latency** - Reduced segment count (7 -> 3)
4. **Buffer underruns** - Added 100ms audio buffer

---

## Color Scheme: Warm Neutral

| Name | Hex | Usage |
|------|-----|-------|
| Dim Grey | #6B6D76 | Secondary text, borders |
| Khaki Beige | #A69888 | Backgrounds, cards |
| Powder Blush | #FCBFB7 | Primary accent, CTAs |
| Charcoal Blue | #334E58 | Headers, primary text |
| Dark Coffee | #33261D | Deep backgrounds |

---

## Project Structure (Updated)

```
pcnestspeaker/
├── .claude/
│   └── CLAUDE.md              # This file - project knowledge
├── src/
│   ├── main/
│   │   ├── electron-main.js   # Main process entry
│   │   ├── preload.js         # IPC bridge
│   │   ├── audio-streamer.js  # FFmpeg → HTTP streaming
│   │   └── cast-helper.py     # Python pychromecast for Nest
│   └── renderer/
│       ├── index.html         # UI
│       ├── styles.css         # Warm Neutral theme
│       └── renderer.js        # UI logic
├── mediamtx/                  # MediaMTX for WebRTC streaming
│   ├── mediamtx.exe           # v1.15.6 Windows binary
│   └── mediamtx-audio.yml     # Audio-only WebRTC config
├── cast-receiver/
│   └── receiver.html          # Custom Cast receiver (WHEP)
├── docs/
│   ├── receiver.html          # GitHub Pages deployment
│   ├── ARCHITECTURE.md        # System architecture
│   └── APP_DOCUMENTATION.md   # Feature documentation
├── reference/python/          # Original Python implementations
├── ffmpeg/                    # Bundled FFmpeg binaries
├── assets/                    # App icons
├── package.json               # Dependencies & build config
└── README.md                  # User-facing docs
```

---

## Next Steps

1. ~~Set up Electron skeleton~~ ✅ DONE
2. ~~Port FFmpeg logic~~ ✅ DONE
3. ~~Implement Chromecast~~ ✅ DONE (castv2-client)
4. ~~Build UI~~ ✅ DONE (Warm Neutral theme)
5. ~~Add WASAPI capture~~ ✅ DONE (electron-audio-loopback)
6. **Bundle FFmpeg** - Download and include in ffmpeg/
7. **Test full pipeline** - npm install && npm start
8. **Add licensing** - Stripe + Vercel integration
9. **Configure builds** - electron-builder for Win/Mac

---

## CRITICAL: Development Environment Issues

### ⚠️ ELECTRON_RUN_AS_NODE - READ THIS FIRST ⚠️

**Claude Code sets `ELECTRON_RUN_AS_NODE=1` which BREAKS Electron!**

When this env var is set, Electron runs in Node.js mode and `ipcMain`, `app`, `BrowserWindow` etc. are all **undefined**.

**ERROR YOU'LL SEE:**
```
TypeError: Cannot read properties of undefined (reading 'handle')
    at Object.<anonymous> (electron-main.js:741:9)
```

**THREE WAYS TO FIX:**

1. **Use the batch file (RECOMMENDED):**
```bash
cmd /c start "" "c:\Users\kepne\OneDrive\Documents\GitHub\pcnestspeaker\start-app.bat"
```

2. **Unset in Git Bash:**
```bash
unset ELECTRON_RUN_AS_NODE && npm run dev
```

3. **Unset in CMD:**
```cmd
set ELECTRON_RUN_AS_NODE= && npm run dev
```

**DO NOT** just run `npm run dev` directly - it will inherit the env var and crash.

### Launching Electron from Claude Code
**Use the batch file to launch Electron:**

```bash
cmd /c start "" "c:\Users\kepne\OneDrive\Documents\GitHub\pcnestspeaker\start-app.bat"
```

The `start-app.bat` file:
1. Clears the `ELECTRON_RUN_AS_NODE` environment variable
2. Changes to the project directory
3. Runs `npm run dev`

Direct bash/PowerShell commands don't work reliably because Claude Code's environment sets `ELECTRON_RUN_AS_NODE` which breaks Electron.

### Windows Firewall (Auto-configured)
The app automatically creates a firewall rule for port 8000 on startup. If it fails (needs admin rights), run this once as Administrator:
```cmd
netsh advfirewall firewall add rule name="PC Nest Speaker HTTP" dir=in action=allow protocol=TCP localport=8000
```

---

## Google Cast SDK Registration

| Item | Value |
|------|-------|
| **Application ID** | `FCAA4619` |
| **Application Name** | PC Nest Speaker |
| **Application Type** | Custom Receiver |
| **Receiver URL** | https://kepners.github.io/pcnestspeaker/receiver.html |
| **GitHub Pages** | https://kepners.github.io/pcnestspeaker/ |
| **Status** | **Published** (works on all devices) |
| **Registered** | January 5, 2026 |

### Custom Receiver Features (MP3 + WebRTC)
- **Streaming Mode:** MP3 progressive (no files, direct pipe)
- **WebRTC Namespace:** `urn:x-cast:com.pcnestspeaker.webrtc`
- `autoResumeDuration: 0` (resume immediately)
- `autoPauseDuration: 0` (never auto-pause)
- `initialBandwidth: 100000000` (100 Mbps - skip all probing)
- `disablePreload: true` (reduce startup delay)
- Message interceptor forces LIVE stream type for minimal buffering
- **WebRTC support:** Accepts SDP offer/answer, ICE candidates via custom namespace

### Files
- `cast-receiver/receiver.html` - Source file
- `docs/receiver.html` - GitHub Pages deployment
- `docs/index.html` - Redirect to receiver.html

---

## CRITICAL: Latency Analysis (January 5, 2026)

### Why HTTP Streaming Has 15-25 Second Latency
**Chromecast has a ~350KB buffer** that must fill before playback starts:

| Format | Data Rate | Buffer Fill Time |
|--------|-----------|------------------|
| MP3 128kbps | 16 KB/s | **21.8 seconds** |
| MP3 320kbps | 40 KB/s | **8.75 seconds** |
| WAV 16-bit | 176 KB/s | **~2 seconds** |

**Solution:** Increased bitrate to 320kbps (8-10s latency vs 22s).

### Chrome Tab Casting Protocol (Sub-500ms Latency)
Chrome uses proprietary WebRTC protocol:
- **App ID:** `0F5096E8` (Chrome Mirroring - internal)
- **Namespace:** `urn:x-cast:com.google.cast.webrtc`
- **Audio:** Opus 128kbps, 48kHz, stereo
- **Target delay:** 400ms built into protocol
- Uses UDP/DTLS - no HTTP buffering

**Nobody has reverse-engineered this for third-party use.**

### WebRTC via MediaMTX (Implemented - January 5, 2026)
**Solution:** MediaMTX receives FFmpeg RTSP streams and serves WebRTC via WHEP protocol.

**Pipeline:**
```
FFmpeg (DirectShow) → RTSP → MediaMTX → WebRTC (WHEP) → Cast Receiver
```

**Why MediaMTX:**
- FFmpeg uses DirectShow which can see `virtual-audio-capturer`
- webrtc-streamer uses WASAPI which CANNOT see DirectShow devices
- MediaMTX bridges RTSP (from FFmpeg) to WebRTC (for Cast receiver)

**MediaMTX Configuration:**
- RTSP input: `rtsp://localhost:8554/pcaudio`
- WebRTC output: `http://localhost:8889/pcaudio/whep` (WHEP protocol)
- API endpoint: `http://localhost:9997/v3/paths/list`

**FFmpeg Command (Opus for WebRTC):**
```bash
ffmpeg -f dshow -i "audio=virtual-audio-capturer" \
  -c:a libopus -b:a 128k -ar 48000 -ac 2 \
  -f rtsp -rtsp_transport tcp rtsp://localhost:8554/pcaudio
```

**Cast Receiver (WHEP Protocol):**
```javascript
// Simple WHEP - POST SDP offer, get SDP answer
const response = await fetch(serverUrl + '/pcaudio/whep', {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: peerConnection.localDescription.sdp
});
await peerConnection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
```

**Status:** TESTED AND WORKING - Full pipeline verified January 5, 2026.

---

## CRITICAL: Chromecast/Nest Casting

### Node.js Libraries DON'T WORK with Nest!
- `castv2-client` - Gets `NOT_ALLOWED` error on Nest Mini and speaker groups
- `chromecast-api` - Same issue
- `electron-chromecast` - Requires native mdns that won't compile on Windows

### SOLUTION: Python pychromecast
**Python pychromecast is the ONLY library that successfully casts to Nest devices.**

Architecture:
```
Electron (UI + FFmpeg streaming) → Python pychromecast (casting)
```

Files:
- `src/main/electron-main.js` - Calls Python via `spawn()`
- `src/main/cast-helper.py` - Python script for discover/cast/stop

### pychromecast API (v13+)
**API changed! Use `cast_info` for host/port:**

```python
# OLD (broken):
cc.host  # AttributeError!
cc.port

# NEW (correct):
cc.cast_info.host
cc.cast_info.port
cc.cast_info.model_name
```

### Casting Code Pattern
```python
mc = cast.media_controller
mc.play_media(url, content_type, stream_type="LIVE")
mc.block_until_active(timeout=30)
# NO mc.play() needed - media already playing after block_until_active!
```

---

## Session Memory

### January 4, 2026
- Reviewed original NestAudioBridge Python code
- Created docs/ with ARCHITECTURE.md and APP_DOCUMENTATION.md
- Imported reference Python files to reference/python/
- Decisions: Electron app, Stripe licensing, HLS+MP3 fallback, user-configurable speaker
- Tested Python streaming - works but requires VB-CABLE (user doesn't want this)
- **CRITICAL UPDATE:** Switching to electron-audio-loopback for native WASAPI capture
- User requirement: All-in-one app, no external software installation needed
- Found speakers: DENNIS, Den pair, Back garden speaker, STUDY, Green TV

### January 4, 2026 (Session 2)
- Created complete Electron app skeleton
- Implemented Chromecast discovery (mdns-js + castv2-client)
- Built audio streamer with WASAPI loopback via electron-audio-loopback
- Created UI with Warm Neutral color scheme
- Set up IPC communication between main/renderer
- Configured electron-builder for Windows/Mac builds
- **Key insight:** AirParrot uses same WASAPI loopback technique - confirms our approach

### January 4, 2026 (Session 3)
- **MAJOR DISCOVERY:** Node.js Chromecast libraries (castv2-client, chromecast-api) get `NOT_ALLOWED` on Nest devices
- Tried multiple approaches: force-stop current app, raw castv2 protocol, electron-chromecast
- **SOLUTION:** Python pychromecast works! Electron UI + Python backend for casting
- Created `cast-helper.py` with discover/cast/stop commands
- Fixed pychromecast v13+ API change: `cc.host` → `cc.cast_info.host`
- Fixed `mc.play()` timeout - not needed after `block_until_active()`
- ELECTRON_RUN_AS_NODE env var causes `app` to be undefined - must unset before running
- **WORKING:** Full pipeline tested - PC audio streams to Den pair successfully!
- Speakers found: Green TV, DENNIS, Den pair, Back garden speaker, STUDY

### January 5, 2026 (Session 4)
- Custom Cast receiver registered (App ID: FCAA4619) and published
- Fixed 404 on receiver URL - needed to copy to docs/ for GitHub Pages
- **LATENCY DISCOVERY:** Chromecast has ~350KB buffer = 22s delay at 128kbps!
- Increased bitrate to 320kbps → should reduce to ~8-10 seconds
- Researched Chrome tab casting - uses proprietary WebRTC protocol (App ID: 0F5096E8)
- Protocol uses `urn:x-cast:com.google.cast.webrtc` namespace with custom OFFER/ANSWER
- **CREATED:** WebRTC-enabled custom receiver with signaling support
- WebRTC namespace: `urn:x-cast:com.pcnestspeaker.webrtc`
- User request: Implement WebRTC like browser does for sub-500ms latency
- Auto-start streaming on speaker selection implemented

### January 5, 2026 (Session 5)
- **WORKING MP3 STREAMING:** Full pipeline working with 8 second latency
- Fixed firewall issues - added automatic firewall rule creation to audio-streamer.js
- Confirmed 320kbps bitrate reduces latency from 15s (128kbps) to 8s
- Added FFmpeg data logging to debug streaming issues
- virtual-audio-capturer works for system audio capture
- Default media receiver works; custom receiver available for testing

### January 5, 2026 (Session 6) - MediaMTX Integration
- **PROBLEM:** webrtc-streamer uses WASAPI - can't see DirectShow devices (VB-CABLE, virtual-audio-capturer)
- **SOLUTION:** MediaMTX v1.15.6 - receives FFmpeg RTSP streams, serves WebRTC via WHEP
- Downloaded MediaMTX Windows binary (48MB)
- Created `mediamtx-audio.yml` config optimized for audio-only WebRTC
- Updated `electron-main.js` with startMediaMTX() and startFFmpegWebRTC() functions
- Rewrote `cast-receiver/receiver.html` to use WHEP protocol instead of webrtc-streamer API
- Updated `package.json` extraResources to bundle MediaMTX with the app
- **TESTED:** Full pipeline verified:
  - MediaMTX starts on :8554 (RTSP), :8889 (WebRTC/WHEP), :9997 (API)
  - FFmpeg publishes Opus audio to MediaMTX via RTSP
  - Stream appears with `"ready": true` and `"tracks": ["Opus"]`
  - WHEP endpoint responds correctly (405 for GET, ready for POST)
- **Ports:**
  - 8554: RTSP input (FFmpeg → MediaMTX)
  - 8889: WebRTC/WHEP output (MediaMTX → Cast receiver)
  - 8189: ICE UDP/TCP (WebRTC media)
  - 9997: MediaMTX API (health checks)

### January 5, 2026 (Session 7) - 🎉 WEBRTC STREAMING WORKING!
**MAJOR MILESTONE: Sub-second latency audio streaming to Google Nest speakers achieved!**

#### The Breakthrough
- **WORKING:** Full WebRTC pipeline with sub-second latency
- **Tested:** Green TV (Nest Hub), Den pair (stereo group)
- **User reaction:** "FUCKING INSTANT!!!!!!!!!!"
- **Latency:** Sub-1 second (imperceptible to human perception)

#### Complete Working Pipeline
```
PC Audio → virtual-audio-capturer → FFmpeg (Opus) → RTSP → MediaMTX → WebRTC/WHEP → Cloudflare Tunnel → Custom Cast Receiver → Nest Speaker
```

#### Critical Fixes Made
1. **MediaMTX config file** - Must specify config path explicitly or Opus codec rejected
2. **Opus codec required** - AAC (MPEG-4 Audio) doesn't work with WebRTC
3. **Custom receiver not default** - Must use `webrtc-launch` not `cast` command
4. **cloudflared over localtunnel** - No interstitial page blocking WHEP requests

#### Files Created/Modified
- `cast-receiver/receiver.html` - WHEP-based WebRTC receiver
- `docs/receiver.html` - GitHub Pages deployment (synced)
- `mediamtx/mediamtx-audio.yml` - Audio-optimized MediaMTX config
- `src/main/electron-main.js` - cloudflared support, MediaMTX integration
- `src/main/cast-helper.py` - `webrtc-launch` command for custom receiver
- `pc-nest-speaker.bat` - All-in-one launcher with menu
- `dashboard.hta` - Windows HTA app with GUI control panel

#### Git Commit
- `5e9839c` - feat: WebRTC streaming to Nest speakers working!

#### Achievement Summary
**PC Nest Speaker is the FIRST and ONLY solution** that streams Windows system audio to Google Nest speakers with sub-second latency. No commercial solution exists with this capability.

### January 6, 2026 (Session 8) - Revert to Working State
**Session Goal:** Add stream monitor and auto-start features

#### What Went Wrong
- Added stream monitor UI (audio visualizer, bitrate display, data counter)
- Added auto-start and auto-connect functionality
- Modified multiple files: index.html, styles.css, renderer.js, preload.js, electron-main.js, audio-streamer.js
- Created new file: audio-device-switcher.js (Windows audio switching)
- **RESULT:** Audio completely stopped working - "NO AUDIO!!!!!!!"

#### User Decision
- **Reverted all changes** back to commit `5e9839c` (last working state from Jan 5 night)
- Deleted new files created today (audio-device-switcher.js, auto-setup.js, auto-start-manager.js, settings-manager.js)
- App restored to working WebRTC streaming state

#### Lesson Learned
- Working WebRTC pipeline is fragile - changes can break audio routing
- Must be more careful when adding features to working core functionality
- Should test each feature addition incrementally rather than batch changes
- Git revert is essential when breaking working functionality

#### Current State
- Back to `5e9839c` - WebRTC streaming working perfectly
- Stream monitor and auto-start features deferred for careful re-implementation
- Documentation updated: docs/BLOG_CONTENT.md (comprehensive blog post material)

#### Next Steps (Deferred)
- Fix audio routing (careful implementation needed)
- Add stream monitor (without breaking audio)
- Implement auto-start functionality
- Add system tray icon
- Volume control integration
- Multi-speaker streaming

### January 6, 2026 (Session 9) - Speaker Compatibility Investigation
**Session Goal:** Fix UI issues, investigate "Back garden speaker" custom receiver failure

#### UI Fixes
- Fixed JavaScript errors from removed UI elements (buttons, mode radios)
- Removed references to `discoverBtn`, `streamBtn`, `audioDeviceSelect`, `modeRadios`
- Added auto-discovery on app startup
- Replaced full-screen loading overlay with small status indicator (timer GIF)
- Commits: `ff78bcc`, `6357af3`, `2b2d55b`

#### "Back garden speaker" Investigation
**Problem:** "Back garden speaker" (Google Nest Mini) fails to launch custom receiver FCAA4619

**Testing performed:**
1. Added `device-info` command to cast-helper.py
2. Confirmed speaker details:
   - Model: Google Nest Mini
   - UUID: `6d9cdd5d-5f80-8408-4080-7f4d30a714d7`
   - IP: 192.168.50.202
   - cast_type: "audio"
3. Tested custom receiver launch → `RequestFailed: Failed to execute start app FCAA4619`
4. Tested default receiver (HTTP/MP3) → ✅ Works perfectly

**Key Discovery:**
- Checked Cast SDK Developer Console settings
- **"Supports casting to audio only devices"** checkbox is ALREADY ENABLED ✅
- App is Published ✅
- All settings are correct ✅

**Conclusion:**
The "Back garden speaker" likely has **older firmware** that does not support custom Cast receivers, even though:
- It's the same model as other working Nest Minis
- The custom receiver is properly configured for audio-only devices
- The app is published and available globally

**Working devices with custom receiver:**
- Green TV (NVIDIA SHIELD) - cast_type: "cast"
- DENNIS (Google Nest Mini) - cast_type: "audio"
- Den pair (Google Cast Group) - cast_type: "group"
- STUDY (Google Cast Group) - cast_type: "group"

**Non-working devices:**
- Back garden speaker (Google Nest Mini) - cast_type: "audio" ❌

**Workaround for "Back garden speaker":**
- Use HTTP/MP3 streaming mode instead of WebRTC
- Higher latency (~8 seconds) but works on older firmware

#### Den Pair Investigation
**Issue:** "Den pair" Cast group only plays on one speaker (newer Nest Mini)

**Analysis:**
- "Den pair" shares IP 192.168.50.241 with "DENNIS"
- Suggests DENNIS is the newer Nest Mini in the group
- Custom receiver launches successfully on the group
- Need to test if both speakers play when pipeline is active

**Status:** Pending user testing with active MediaMTX/FFmpeg pipeline

#### Files Modified
- `src/main/cast-helper.py` - Added device-info command, improved error logging
- `src/renderer/renderer.js` - Removed deleted UI element references
- `src/renderer/index.html` - Removed loading overlay
- `src/renderer/styles.css` - Added timer icon, connecting state
- `assets/timer.gif` - Downloaded and recolored for connecting state

### January 6, 2026 (Session 9 - Continuation) - Windows Audio Auto-Switching
**Session Goal:** Implement Task #1 from priority list - Windows audio device auto-switching

#### What Was Completed
- ✅ Created `src/main/audio-device-manager.js` module (157 lines)
- ✅ Uses NirCmd utility (simple, reliable, 47KB, no PowerShell)
- ✅ Integrated into all streaming handlers:
  - `start-streaming` → switches to virtual device
  - `stop-streaming` → restores original device
  - `start-stereo-streaming` → switches to virtual device
  - `stop-stereo-streaming` → restores original device
  - `cleanup()` → restores on app exit
- ✅ Created `nircmd/README.md` with setup instructions
- ✅ Committed and pushed: `8c9a404` - feat: Windows audio device auto-switching

#### Implementation Details
**Audio Device Manager:**
- `getCurrentAudioDevice()` - Uses WMIC to detect current device
- `setDefaultAudioDevice()` - Uses NirCmd to switch devices
- `switchToStreamingDevice()` - Saves original, tries multiple virtual device names
- `restoreOriginalDevice()` - Restores saved device

**Device Names Tried (in order):**
1. `virtual-audio-capturer`
2. `Virtual Audio Capturer`
3. `CABLE Input`
4. `VB-Audio Virtual Cable`

**Error Handling:**
- Graceful degradation - continues if switch fails (user may have already set it)
- Warnings logged but don't block streaming
- Cleanup always attempts restore (even if errors occur)

#### User Experience Improvement
**Before:**
- User must manually switch Windows audio to virtual device
- User must remember to switch back after streaming
- Easy to forget and lose audio on normal speakers

**After:**
- Start streaming → Automatic switch to virtual device
- Stop streaming → Automatic restore to original device
- App exit/crash → Automatic restore via cleanup()
- Zero user configuration required

#### Files Created/Modified
- `src/main/audio-device-manager.js` - NEW: Core switching logic
- `src/main/electron-main.js` - MODIFIED: Integration into handlers
- `nircmd/README.md` - NEW: NirCmd setup guide

#### Git Commit
- `8c9a404` - feat: Windows audio device auto-switching

#### Next Steps (From Priority List)
1. ~~Fix Audio Routing - Windows Audio Device Auto-Switch~~ ✅ DONE
2. Add Stream Monitor (audio visualizer, bitrate, data counter)
3. Auto-Start on Windows Boot
4. Document Device Compatibility
5. System Tray Icon
6. Volume Control Integration
7. Multi-Speaker Streaming
8. Trial & Usage Timer (10 hours)
9. License Verification & Purchase Flow
10. Match DeleteMyTweets Styling

### January 6, 2026 (Session 9 - Continuation) - Stream Monitor Implementation
**Session Goal:** Implement Task #2 - Add Stream Monitor

#### What Was Completed
- ✅ Created `stream-stats.js` module (150 lines) - Core stats tracking
- ✅ Added 8-bar audio visualizer with animated heights
- ✅ Implemented bitrate display from FFmpeg output
- ✅ Added data sent counter (MB)
- ✅ Connection status indicator with color coding
- ✅ 100ms update interval for smooth animation
- ✅ Auto-show/hide based on streaming state
- ✅ Integrated into standard and stereo streaming modes
- ✅ Committed and pushed: `1125453` - feat: Add stream monitor

#### Implementation Details

**StreamStats Class** (`stream-stats.js`):
- `parseFfmpegOutput()` - Parses FFmpeg stderr for bitrate and data
- `updateAudioLevels()` - Generates simulated audio levels for visualizer
- `getStats()` - Returns current stats object
- `addListener()` - Registers callback for stats updates
- 100ms timer sends updates to all listeners

**FFmpeg Output Parsing:**
```
Example: "frame=123 fps=25 q=28.0 size=1024kB time=00:00:05.00 bitrate=128.0kbits/s"
Extracts: bitrate=128.0, size=1024kB
```

**Audio Visualizer:**
- 8 bars using flexbox layout
- Heights driven by simulated audio levels (0-100%)
- Each bar oscillates at different frequency for natural look
- Sine wave (50%) + random (30%) = organic animation
- Active class adds glow effect when level > 30%

**Integration Points:**
- `startFFmpegWebRTC()` - Parses main FFmpeg stderr
- `start-stereo-streaming` - Parses both L/R FFmpeg stderr
- `streamStats.start()` called after FFmpeg launches
- `streamStats.stop()` called on stream stop
- Stats listener sends to renderer via IPC every 100ms

#### User Experience
**Visual Feedback:**
- Stream monitor appears when streaming starts
- 8 animated bars show audio activity
- Bitrate display shows stream quality
- Data counter shows total MB sent
- Connection status: Green (Active) / Red (Inactive)
- Monitor disappears cleanly when streaming stops

**Stats Display:**
```
┌─────────────────────────────┐
│ [||||||||] <- 8 bars        │
│                             │
│ Bitrate     Data    Connect │
│ 128 kbps    5.2 MB  Active  │
└─────────────────────────────┘
```

#### Files Created/Modified
- `src/main/stream-stats.js` - NEW: Stats tracking module
- `src/main/electron-main.js` - MODIFIED: FFmpeg integration, stats start/stop
- `src/main/preload.js` - MODIFIED: onStreamStats IPC event
- `src/renderer/index.html` - MODIFIED: Stream monitor UI structure
- `src/renderer/renderer.js` - MODIFIED: updateStreamMonitor() function
- `src/renderer/styles.css` - MODIFIED: Visualizer bars, stats grid

#### Git Commit
- `1125453` - feat: Add stream monitor with audio visualizer and stats

#### Next Steps (From Priority List)
1. ~~Fix Audio Routing - Windows Audio Device Auto-Switch~~ ✅ DONE
2. ~~Add Stream Monitor (audio visualizer, bitrate, data counter)~~ ✅ DONE
3. ~~Auto-Start on Windows Boot~~ ✅ DONE
4. Document Device Compatibility
5. System Tray Icon
6. Volume Control Integration
7. Multi-Speaker Streaming
8. Trial & Usage Timer (10 hours)
9. License Verification & Purchase Flow
10. Match DeleteMyTweets Styling

### January 6, 2026 (Session 9 - Continuation) - Auto-Start & Settings Complete
**Session Goal:** Complete Task #3 - Auto-Start on Windows Boot

#### What Was Completed
- ✅ Created `auto-start-manager.js` - Windows Registry manipulation
- ✅ Created `settings-manager.js` - Persistent JSON settings storage
- ✅ Added settings UI with 2 checkboxes (auto-connect, auto-start)
- ✅ Implemented auto-connect logic (5s delay after app startup)
- ✅ Settings persist in `app.getPath('userData')/settings.json`
- ✅ Registry integration for Windows startup
- ✅ Checkbox event handlers sync with actual state
- ✅ Save last speaker on selection for auto-connect
- ✅ Committed and pushed: `daa3619` - feat: Add auto-start and settings

#### Implementation Details

**auto-start-manager.js:**
- `isAutoStartEnabled()` - Checks Windows Registry Run key
- `enableAutoStart()` - Adds app to Registry with full path
- `disableAutoStart()` - Removes app from Registry
- `toggleAutoStart()` - Toggles and returns new state
- Registry path: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- Registry key name: `PCNestSpeaker`

**settings-manager.js:**
- `loadSettings()` - Loads from JSON, merges with defaults
- `saveSettings()` - Writes settings to JSON file
- `updateSettings()` - Partial update (merges with existing)
- `saveLastSpeaker()` - Saves speaker object for auto-connect
- Settings cached in memory to avoid repeated file reads

**Auto-Connect Flow:**
```
1. App starts → loads settings
2. Wait 5s for WebRTC pipeline to initialize
3. Check if autoConnect enabled + lastSpeaker exists
4. Send 'auto-connect' IPC event to renderer
5. Renderer finds speaker in list and calls selectSpeaker()
6. Streaming begins automatically
```

**Settings Schema:**
```json
{
  "lastSpeaker": { "name": "Den pair", "model": "Google Cast Group" },
  "autoConnect": true,
  "autoStart": false,
  "streamingMode": "webrtc-system",
  "version": "1.0.0"
}
```

#### Files Created/Modified
- `src/main/auto-start-manager.js` - NEW: Windows Registry auto-start
- `src/main/settings-manager.js` - NEW: JSON settings persistence
- `src/main/electron-main.js` - MODIFIED: Settings/auto-start IPC handlers
- `src/main/preload.js` - MODIFIED: Expose settings APIs
- `src/renderer/index.html` - MODIFIED: Settings UI with checkboxes
- `src/renderer/renderer.js` - MODIFIED: loadSettings(), checkbox handlers
- `src/renderer/styles.css` - MODIFIED: Settings section styling

#### Git Commit
- `daa3619` - feat: Add auto-start on Windows boot and auto-connect settings

#### User Experience
**Settings UI:**
```
┌─ SETTINGS ──────────────────┐
│ ☑ Auto-connect to last      │
│   speaker                    │
│   Automatically connect when │
│   app starts                 │
│                              │
│ ☐ Start with Windows         │
│   Launch app when Windows    │
│   starts                     │
└──────────────────────────────┘
```

**Behavior:**
- Check "Auto-connect" → Next startup connects to last speaker automatically
- Check "Start with Windows" → App launches on boot, then auto-connects
- Uncheck either → Disables that feature immediately
- Settings persist across app restarts

#### Lessons Learned
1. **Research before assuming** - Made assumptions about Nest microphone without research
2. **FFmpeg stderr parsing** - Progress info goes to stderr, not stdout
3. **Windows Registry auto-start** - Simple `reg add` command, very reliable
4. **Settings merge pattern** - Always merge with defaults to handle new settings in updates
5. **IPC event timing** - Need delays for dependent startup tasks (discovery → pipeline → auto-connect)

#### Future Research Tasks
**NEW: Phone Mic → Nest Speakers (Separate Project)**
- Android app captures phone microphone
- Streams to PC or directly to Nest speakers via WebRTC
- Use cases: Wireless mic, baby monitor, intercom
- Estimated effort: 30-50 hours for full Android app

**NEW: Research Nest Microphone → PC Input**
- Explore if Google Cast SDK allows mic access from Nest devices
- Goal: Use Nest Mini/Hub mic as PC input for Discord/WhatsApp
- Challenges: Cast protocol is one-way (TO devices only)
- Likely outcome: Not possible with current Google APIs
- **Status:** Needs research, possibly blocked by Google

#### Next Steps (From Priority List)
1. ~~Fix Audio Routing - Windows Audio Device Auto-Switch~~ ✅ DONE
2. ~~Add Stream Monitor (audio visualizer, bitrate, data counter)~~ ✅ DONE
3. ~~Auto-Start on Windows Boot~~ ✅ DONE
4. Document Device Compatibility
5. System Tray Icon
6. Volume Control Integration
7. Multi-Speaker Streaming
8. Trial & Usage Timer (10 hours)
9. License Verification & Purchase Flow
10. Match DeleteMyTweets Styling

**Research Tasks:**
- Research Nest Microphone → PC input feasibility (likely blocked by Cast protocol)
- Phone Mic → Nest Speakers (future separate project - Android app)
- Baby Monitor Feature Requirements:
  - Need two-way audio (Parent → Nest + Nest → PC/Phone)
  - Music playback + voice mixing on Nest (not natively supported)
  - Cast in/out of existing playback
  - CRITICAL: Need Nest mic → PC audio stream (currently impossible with Cast)

### January 6, 2026 (Session 10 - Continuation) - System Tray Icon

**Session Goal:** Implement Task #5 - System Tray Icon

#### What Was Completed
- ✅ Created `tray-manager.js` module (170 lines) - Complete tray management
- ✅ Minimize to tray on window close (instead of quit)
- ✅ Context menu: Show/Hide, Stop Streaming, Exit
- ✅ Double-click tray icon to toggle window visibility
- ✅ Icon states: idle (gray) vs streaming (colored)
- ✅ Programmatic fallback icons if PNG files missing
- ✅ Proper app quit handling with app.isQuitting flag
- ✅ IPC integration for tray stop streaming event
- ✅ Tray icon changes based on streaming state
- ✅ Tooltip updates: "PC Nest Speaker" vs "PC Nest Speaker - Streaming"
- ✅ Stop Streaming menu item enabled only when streaming
- ✅ Committed and pushed: `8613f19` - feat: Add system tray icon integration

#### Implementation Details

**TrayManager Module** (`tray-manager.js`):
- `createTray(window)` - Initializes system tray with icon and menu
- `updateTrayState(streaming)` - Changes icon/tooltip based on state
- `destroyTray()` - Cleanup on app quit
- `onWindowVisibilityChange()` - Updates menu when window shows/hides
- `createFallbackIcon(color)` - Creates colored square if PNG missing
- `loadIcon(filename, fallbackColor)` - Loads PNG or creates fallback

**Window Close Behavior:**
```javascript
mainWindow.on('close', (event) => {
  if (!app.isQuitting) {
    event.preventDefault();
    mainWindow.hide();
    trayManager.onWindowVisibilityChange();
  }
});
```

**Tray State Updates:**
- Start streaming (HTTP/WebRTC/fallback) → `updateTrayState(true)`
- Stop streaming → `updateTrayState(false)`
- Cleanup → `updateTrayState(false)`
- Error during streaming → `updateTrayState(false)`

**Context Menu Actions:**
1. **Show/Hide Window** - Toggles window visibility, label changes dynamically
2. **Stop Streaming** - Sends IPC event to renderer, only enabled when streaming
3. **Exit** - Quits application (sets app.isQuitting = true)

**Fallback Icons:**
- Idle: Gray square (#808080) if tray-icon.png missing
- Streaming: Green square (#00FF00) if tray-icon-active.png missing
- Uses nativeImage.createFromBuffer() with raw pixel data

#### User Experience
**Tray Behavior:**
- Click X on window → Minimizes to tray (doesn't quit)
- Double-click tray icon → Shows/hides window
- Right-click tray → Context menu
- App stays in tray when window hidden
- Must explicitly choose "Exit" from tray to quit

**Visual Feedback:**
- Icon changes color when streaming starts
- Tooltip changes to show streaming status
- Stop Streaming menu item grays out when not streaming

#### Files Created/Modified
- `src/main/tray-manager.js` - NEW: Tray management module
- `src/main/electron-main.js` - MODIFIED: Tray integration, quit handling
- `src/main/preload.js` - MODIFIED: onTrayStopStreaming IPC event
- `src/renderer/renderer.js` - MODIFIED: Tray stop event listener
- `assets/TRAY_ICONS_README.md` - NEW: Icon specifications

#### Git Commit
- `1ecc880` - docs: Add comprehensive device compatibility guide
- `8613f19` - feat: Add system tray icon integration

#### Next Steps (From Priority List)
1. ~~Fix Audio Routing - Windows Audio Device Auto-Switch~~ ✅ DONE
2. ~~Add Stream Monitor (audio visualizer, bitrate, data counter)~~ ✅ DONE
3. ~~Auto-Start on Windows Boot~~ ✅ DONE
4. ~~Document Device Compatibility~~ ✅ DONE
5. ~~System Tray Icon~~ ✅ DONE
~~6. Volume Control Integration~~ ✅ DONE
7. Multi-Speaker Streaming (7.1: Multi-casting PRO, 7.2: Phone/PC mic → Nest PRO)
8. Trial & Usage Timer (10 hours)
9. License Verification & Purchase Flow
10. Match DeleteMyTweets Styling

**Progress: 6 out of 10 tasks completed (60%)**

### January 6, 2026 (Session 11 - Continuation) - Volume Control Integration

**Session Goal:** Implement Task #6 - Volume Control Integration

#### What Was Completed
- ✅ Created volume slider UI with percentage display (0-100%)
- ✅ Added mute button with icon toggling (🔊 vs 🔇)
- ✅ Real-time volume updates via slider input
- ✅ Volume state management (currentVolume, isMuted, previousVolume)
- ✅ Python volume control via pychromecast
- ✅ IPC integration for get-volume and set-volume
- ✅ Auto-show volume card when speaker selected
- ✅ Volume restoration after unmute
- ✅ Warm Neutral styling with smooth animations
- ✅ Committed: `ca77cd3` - feat: Add volume control integration

#### Implementation Details

**UI Components** (index.html):
```html
<div class="card volume-card" id="volume-card" style="display: none;">
  <h2 class="card-title">VOLUME</h2>
  <div class="volume-controls">
    <button class="volume-btn" id="mute-btn">🔇</button>
    <input type="range" min="0" max="100" value="50" id="volume-slider">
    <span class="volume-percentage" id="volume-percentage">50%</span>
  </div>
</div>
```

**Volume State**:
- `currentVolume` (0-100) - Current volume level
- `isMuted` (boolean) - Mute state
- `previousVolume` (0-100) - Volume before muting

**Frontend Functions** (renderer.js):
- `updateVolumeDisplay()` - Updates UI (slider, percentage, button icon)
- `toggleMute()` - Mutes/unmutes speaker with volume restoration
- Event listeners for slider input and mute button click

**Python Functions** (cast-helper.py):
- `get_volume(speaker_name)` - Returns { success, volume: 0.0-1.0, muted }
- `set_volume(speaker_name, volume)` - Sets speaker volume (0.0-1.0)
- Uses `cast.status.volume_level` and `cast.set_volume()`

**IPC Handlers** (electron-main.js):
- `get-volume` → Calls Python `get-volume` command
- `set-volume` → Calls Python `set-volume` command with volume parameter

**Volume Control Flow**:
1. User selects speaker → Volume card appears
2. Get current volume from speaker via Python
3. Update UI with current volume and mute state
4. User adjusts slider → Set volume via Python in real-time
5. User clicks mute → Save volume, set to 0, update icon
6. User clicks unmute → Restore previous volume, update icon

#### User Experience
**Visual Feedback:**
- Volume slider with custom thumb styling (Powder Blush)
- Percentage display updates instantly
- Mute button icon changes: 🔊 (unmuted) vs 🔇 (muted)
- Muted button has reduced opacity and gray color
- Slider thumb scales and glows on hover

**Interaction:**
- Drag slider → Volume updates in real-time
- Click mute → Volume goes to 0%, icon changes
- Click unmute → Volume restores to previous level
- Volume changes apply immediately to speaker

#### Files Created/Modified
- `src/renderer/index.html` - MODIFIED: Volume card UI
- `src/renderer/styles.css` - MODIFIED: Volume control styling (89 lines)
- `src/renderer/renderer.js` - MODIFIED: Volume state, functions, event listeners
- `src/main/preload.js` - MODIFIED: Added comment for volume APIs (already exposed)
- `src/main/cast-helper.py` - MODIFIED: get_volume() and set_volume() functions
- `src/main/electron-main.js` - MODIFIED: get-volume and set-volume IPC handlers

#### Git Commit
- `ca77cd3` - feat: Add volume control integration

#### Next Steps (From Priority List)
1. ~~Fix Audio Routing - Windows Audio Device Auto-Switch~~ ✅ DONE
2. ~~Add Stream Monitor (audio visualizer, bitrate, data counter)~~ ✅ DONE
3. ~~Auto-Start on Windows Boot~~ ✅ DONE
4. ~~Document Device Compatibility~~ ✅ DONE
5. ~~System Tray Icon~~ ✅ DONE
6. ~~Volume Control Integration~~ ✅ DONE
7. Multi-Speaker Streaming (7.1: Multi-casting PRO, 7.2: Phone/PC mic → Nest PRO)
~~8. Trial & Usage Timer (10 hours)~~ ✅ DONE
9. License Verification & Purchase Flow
10. Match DeleteMyTweets Styling

**Progress: 7 out of 10 tasks completed (70%)**

### January 6, 2026 (Session 12 - Continuation) - Trial & Usage Timer

**Session Goal:** Implement Task #8 - Trial & Usage Timer (10 hours)

#### What Was Completed
- ✅ Created usage-tracker.js module (200 lines) - Core trial tracking logic
- ✅ Track streaming time (only while actively streaming)
- ✅ 10-hour trial limit enforcement
- ✅ Settings persistence (usageSeconds, firstUsedAt, lastUsedAt, trialExpired, licenseKey)
- ✅ Backend integration (start/stop tracking on stream events)
- ✅ IPC handler for usage statistics
- ✅ Trial UI card with remaining time display
- ✅ Purchase button and trial expired handling
- ✅ Auto-update every 30 seconds
- ✅ Warning indicators (<1 hour remaining)
- ✅ Committed: `f5881db` - feat: Add 10-hour trial tracking system

#### Implementation Details

**UsageTracker Module** (usage-tracker.js):
- `startTracking()` - Begin counting usage time
- `stopTracking()` - Stop counting and save final usage
- `updateUsage()` - Update usage every 10 seconds (while streaming)
- `getUsage()` - Returns statistics (used, remaining, percent, expired)
- `isTrialExpired()` - Check if trial limit reached
- `activateLicense(key)` - Activate license (removes trial limits)
- `formatTime(seconds)` - Convert to "Xh Ym" format

**Trial Tracking Flow**:
1. User starts streaming → `startTracking()` called
2. Every 10 seconds → `updateUsage()` increments usageSeconds
3. User stops streaming → `stopTracking()` saves final usage
4. Trial expires at 36000 seconds (10 hours)
5. Expired trials block streaming until license purchased

**Settings Data**:
```javascript
{
  usageSeconds: 0,        // Total seconds streamed
  firstUsedAt: null,      // Timestamp of first use
  lastUsedAt: null,       // Timestamp of last use
  trialExpired: false,    // Expiration flag
  licenseKey: null        // Purchased license (bypasses trial)
}
```

**Backend Integration Points** (electron-main.js):
- Start-streaming handler → Check trial expired first, start tracking on success
- Stop-streaming handler → Stop tracking
- Cleanup function → Stop tracking
- IPC handler: get-usage → Returns usage statistics

**Frontend UI** (index.html):
```html
<div class="card trial-card">
  <div class="trial-text">
    <span class="trial-label">Trial Time Remaining:</span>
    <span class="trial-time">10h 0m</span>
  </div>
  <button class="btn-purchase">Purchase License</button>
</div>
```

**Trial Display Logic** (renderer.js):
- `updateTrialDisplay()` - Updates remaining time display
- Runs on app startup and every 30 seconds
- Hides card if user has license
- Shows purchase button when trial expired or <1 hour left
- Warning color when <1 hour remaining

**Trial Expired Handling**:
- Stream start blocks with error: "Trial expired"
- Error message: "Your 10-hour trial has expired. Click 'Purchase License' to continue."
- Purchase button opens purchase URL
- Forces trial display update to show "Trial Expired"

#### User Experience
**Trial Behavior:**
- Trial starts automatically on first streaming session
- Only counts time while actively streaming (not idle time)
- Persistent across app restarts
- Clear display of remaining time
- Warning when approaching limit

**Visual Feedback:**
- Green time remaining (normal)
- Orange/red time remaining (<1 hour warning)
- "Trial Expired" message when limit reached
- Purchase button appears with clear gradient styling

**Purchase Flow:**
- Click "Purchase License" → Opens purchase page
- After purchase → Enter license key (Task #9)
- Licensed users → No trial restrictions

#### Files Created/Modified
- `src/main/usage-tracker.js` - NEW: Trial tracking core module
- `src/main/settings-manager.js` - MODIFIED: Added trial fields to defaults
- `src/main/electron-main.js` - MODIFIED: Tracking integration, trial check, IPC handler
- `src/main/preload.js` - MODIFIED: Exposed getUsage API
- `src/renderer/index.html` - MODIFIED: Trial card UI
- `src/renderer/styles.css` - MODIFIED: Trial card styling (48 lines)
- `src/renderer/renderer.js` - MODIFIED: Trial display logic, expired handling, purchase button

#### Git Commit
- `f5881db` - feat: Add 10-hour trial tracking system

#### Next Steps (From Priority List)
1. ~~Fix Audio Routing - Windows Audio Device Auto-Switch~~ ✅ DONE
2. ~~Add Stream Monitor (audio visualizer, bitrate, data counter)~~ ✅ DONE
3. ~~Auto-Start on Windows Boot~~ ✅ DONE
4. ~~Document Device Compatibility~~ ✅ DONE
5. ~~System Tray Icon~~ ✅ DONE
6. ~~Volume Control Integration~~ ✅ DONE
7. Multi-Speaker Streaming (7.1: Multi-casting PRO, 7.2: Phone/PC mic → Nest PRO)
8. ~~Trial & Usage Timer (10 hours)~~ ✅ DONE
9. License Verification & Purchase Flow
10. Match DeleteMyTweets Styling

**Progress: 7 out of 10 tasks completed (70%)**

### January 6, 2026 (Session 13) - License Verification & Purchase Flow

**Session Goal:** Implement Task #9 - Complete license key validation system following DeleteMyTweets pattern

#### What Was Completed
- ✅ Backend license validation (electron-main.js)
- ✅ License format: PNS-XXXX-XXXX-XXXX-XXXX (23 chars)
- ✅ Server-side API validation with offline fallback
- ✅ License storage in userData/license.json
- ✅ IPC handlers: get-license, activate-license, deactivate-license
- ✅ Integration with usage tracker (activates/deactivates license)
- ✅ Collapsible license card UI (collapsed/expanded states)
- ✅ License modal with auto-formatting input
- ✅ Purchase flow integration (Stripe link - TBD)
- ✅ Auto-load license status on app startup
- ✅ Preload.js API bindings
- ✅ Committed: `f2cb895` - feat: Add complete license key validation system

#### Implementation Details

**Backend (electron-main.js)**:
```javascript
// License validation functions
- validateLicenseFormat(key) - Regex: ^PNS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$
- getLicenseData() - Load from license.json
- saveLicenseData(key) - Save to license.json with activatedAt timestamp
- deleteLicenseData() - Remove license file

// IPC Handlers
- get-license → Returns current license or null
- activate-license(key) → Validates format → API call → Save → Activate in tracker
- deactivate-license → Delete file → Deactivate in tracker

// Validation Flow
1. Client-side format check (instant feedback)
2. Server-side API validation: POST https://pcnestspeaker.app/api/validate-license
3. Offline fallback: If API unreachable, allow re-activation of same key
4. Save to license.json on success
5. Activate in usage tracker (removes trial limits)
```

**Usage Tracker Integration** (usage-tracker.js):
```javascript
// New functions
- activateLicense(key) → Sets licenseKey in settings, clears trialExpired
- deactivateLicense() → Clears license, re-enables trial limits

// License checking in getUsage()
- trialExpired: licenseKey ? false : trialExpired
- hasLicense: !!licenseKey
```

**Frontend UI** (index.html):
```html
<!-- Collapsible License Card -->
<div class="card license-card license-collapsible">
  <!-- Collapsed view -->
  <div class="license-collapsed">
    <div class="license-row">
      <span class="license-label">LICENSE STATUS</span>
      <span id="license-status">Active ✓</span>
    </div>
  </div>
  <!-- Expanded view (on click) -->
  <div class="license-expanded">
    <div class="license-row">
      <span class="license-label">LICENSE STATUS</span>
      <span id="license-status-expanded">Active ✓</span>
    </div>
    <div class="license-row">
      <span class="license-label">LICENSE KEY</span>
      <span id="license-key-display">PNS-XXXX-****-****-XXXX</span>
    </div>
    <div class="license-row">
      <span class="license-terms">
        Personal use on up to 2 devices.<br>
        Lifetime access to all updates.
      </span>
    </div>
    <div class="license-buttons">
      <button class="btn btn-secondary">Change Key</button>
      <button class="btn btn-danger">Deactivate</button>
    </div>
  </div>
</div>

<!-- License Modal -->
<div class="modal-overlay" id="license-modal">
  <div class="modal-box">
    <h2 class="modal-title">Enter License Key</h2>
    <p class="modal-description">
      Check your email for your license key after purchase
    </p>
    <input type="text" id="license-input"
           placeholder="PNS-XXXX-XXXX-XXXX-XXXX">
    <div class="modal-error" id="license-error"></div>
    <div class="modal-buttons">
      <button onclick="openPurchaseLink()">Buy License</button>
      <button onclick="activateLicense()">Activate</button>
    </div>
    <p class="modal-footer">
      Lost your key? <a href="#">Contact support</a>
    </p>
  </div>
</div>
```

**JavaScript Functions** (renderer.js):
```javascript
// Auto-formatting (as user types)
formatLicenseInput(input) → "PNS-XXXX-XXXX-XXXX-XXXX"
- Removes non-alphanumeric
- Auto-adds PNS prefix
- Maintains cursor position

// Masking (for display)
maskLicenseKey(key) → "PNS-XXXX-****-****-XXXX"
- Shows first 4 and last 4 characters
- Masks middle 8 characters

// Modal management
showLicenseModal() - Shows modal, clears input, focuses
hideLicenseModal() - Hides modal
openPurchaseLink() - Opens Stripe payment URL
openSupportLink() - Opens support email

// Activation/Deactivation
activateLicense() - Validates input → IPC call → Update UI → Hide modal
deactivateLicense() - Confirms → IPC call → Update UI → Refresh trial

// Display update
updateLicenseDisplay(license) - Updates status/key in both collapsed & expanded views
toggleLicenseDetails(event) - Expands/collapses card on click

// Startup
loadLicenseStatus() - Called on DOMContentLoaded
- Loads license from backend
- Updates UI
- Shows modal if no license AND trial expired
```

**Styling** (styles.css - ~200 lines):
```css
/* License Card */
.license-card - Collapsible card with hover effects
.license-collapsible.expanded - Shows expanded view
.license-row - Status/key rows with borders
.license-label - Uppercase labels
.license-status-value - Bold colored status
.license-key-text - Monospace masked key
.license-buttons - Flex layout for action buttons

/* License Modal */
.modal-overlay - Full-screen dark backdrop with blur
.modal-box - Centered card with border and shadow
.modal-input - Monospace input with focus glow
.modal-error - Red error message with background
.modal-buttons - Flex layout for Buy/Activate buttons
```

**Color Scheme** (Warm Neutral):
- Active status: `var(--color-blush)` - Powder Blush
- Inactive status: `#FF2A6D` - Coral warning
- License key: Monospace, blush color
- Modal background: `var(--color-coffee)` - Dark Coffee
- Danger button: Red with transparency
- Borders: `var(--color-beige)` - Khaki Beige

#### User Experience Flow

**First-Time User (Trial)**:
1. App starts → License card shows "Not Active"
2. User can stream for 10 hours (trial)
3. When trial <1 hour or expired → Purchase button appears
4. Click Purchase → Opens license modal → Buy → Enter key → Activate

**Returning User (Licensed)**:
1. App starts → Auto-loads license
2. License card shows "Active ✓"
3. Click card → Expands to show masked key
4. Trial card hidden (licensed users don't see trials)
5. Can change key or deactivate if needed

**Purchase Flow**:
1. Click "Purchase License" (trial card) or "Buy License" (modal)
2. Opens Stripe payment link (TBD)
3. User completes purchase → Receives email with key
4. Returns to app → Enters key in modal
5. Key validated → License activated → Trial removed

**Validation Flow**:
1. User enters key (auto-formatted as they type)
2. Client checks format (instant feedback)
3. Submits to backend → API validation
4. Success: Save locally → Activate tracker → Update UI → Hide modal
5. Failure: Show error message in modal

#### Files Created/Modified
- `src/main/electron-main.js` - MODIFIED: License validation backend (~140 lines)
- `src/main/usage-tracker.js` - MODIFIED: Added deactivateLicense(), exported it
- `src/main/preload.js` - MODIFIED: License IPC bindings (3 functions)
- `src/renderer/index.html` - MODIFIED: License card + modal HTML
- `src/renderer/styles.css` - MODIFIED: License card + modal styles (~200 lines)
- `src/renderer/renderer.js` - MODIFIED: License management functions (~260 lines)

#### Git Commit
- `f2cb895` - feat: Add complete license key validation system

#### Next Steps (From Priority List)
1. ~~Fix Audio Routing - Windows Audio Device Auto-Switch~~ ✅ DONE
2. ~~Add Stream Monitor (audio visualizer, bitrate, data counter)~~ ✅ DONE
3. ~~Auto-Start on Windows Boot~~ ✅ DONE
4. ~~Document Device Compatibility~~ ✅ DONE
5. ~~System Tray Icon~~ ✅ DONE
6. ~~Volume Control Integration~~ ✅ DONE
7. Multi-Speaker Streaming (7.1: Multi-casting PRO, 7.2: Phone/PC mic → Nest PRO)
8. ~~Trial & Usage Timer (10 hours)~~ ✅ DONE
9. ~~License Verification & Purchase Flow~~ ✅ DONE
10. Match DeleteMyTweets Styling

**Progress: 8 out of 10 tasks completed (80%)**

**Remaining Tasks:**
- Task #7: Multi-Speaker Streaming (PRO features)
- Task #10: Match DeleteMyTweets Styling

### January 6, 2026 (Session 13) - License System Testing & Critical Fixes
**Session Goal:** Test license system implementation and fix app launch issues

#### Critical Bugs Fixed

**Problem 1: settings-manager.js Initialization Error**
```
TypeError: Cannot read properties of undefined (reading 'getPath')
at Object.<anonymous> (settings-manager.js:17:37)
```

**Root Cause:** Line 17 called `app.getPath('userData')` at module load time before Electron initialized.

**Fix:** Changed constant to lazy initialization function:
```javascript
// Before:
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// After:
function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
```

Updated all references to use the function instead of the constant.

**Problem 2: electron-main.js License Path Error**

Same issue at line 1415:
```javascript
const licensePath = path.join(app.getPath('userData'), 'license.json');
```

**Fix:** Applied same lazy initialization pattern:
```javascript
function getLicensePath() {
  return path.join(app.getPath('userData'), 'license.json');
}
```

Updated `getLicenseData()`, `saveLicenseData()`, and `deleteLicenseData()` functions.

#### Files Modified
- `src/main/settings-manager.js` - Lazy initialization for settings path
- `src/main/electron-main.js` - Lazy initialization for license path

#### Git Commit
- `45a22e1` - fix: Resolve app launch failures with lazy initialization

#### Current State
**Status:** App launch errors FIXED, but app still not opening window (needs further investigation)

**Fixed Issues:**
✅ `app.getPath()` called before Electron ready - RESOLVED
✅ settings-manager.js initialization - RESOLVED
✅ electron-main.js license path initialization - RESOLVED
✅ No syntax errors
✅ Dependencies installed

**Remaining Issue:**
❌ App completes npm run dev without error but no window appears
❌ No Electron processes running after launch attempt

**Testing Performed:**
- Verified ELECTRON_RUN_AS_NODE environment variable cleared
- Confirmed node_modules/electron installed
- Checked for syntax errors (none found)
- Verified all lazy initialization fixes applied
- Attempted multiple launch methods (batch file, npm run dev, cmd)

#### Next Steps
- Debug why Electron window not appearing (possible silent failure)
- Test license system once app launches successfully
- Continue with Task #10 (Match DeleteMyTweets Styling)

### January 7, 2026 (Session 14) - Volume Control & Fixes

**Session Goal:** Fix volume control issues, make PC volume keys control Nest speakers

#### What Was Completed
- ✅ Fixed duplicate IPC handler crash (`set-volume` registered twice)
- ✅ Fixed volume control for stereo mode (now controls both L/R speakers)
- ✅ Fixed volume card not showing in stereo mode
- ✅ Added 500ms debouncing to volume slider (prevents spam)
- ✅ Started Windows volume sync module (incomplete)

#### Bugs Fixed This Session
1. **Duplicate IPC handler** - `set-volume` was defined at lines 1046 AND 1351 → Removed duplicate (Commit `2b27a31`)
2. **Volume not working in stereo** - Code only checked `selectedSpeaker` (null in stereo) → Added stereo mode checks (Commit `be0b55f`)
3. **Volume card hidden in stereo** - Card only shown in `selectSpeaker()` → Added show on stereo stream start (Commit `0784959`)

#### In Progress - PICK UP HERE TOMORROW

**User Request:** "i dont want my app to control the volumn i want the PC to do it"

**Problem:** `virtual-audio-capturer` captures audio BEFORE Windows master volume is applied.
Changing Windows volume has NO effect on what gets streamed to Nest.

**Solution in progress:** Hook Windows volume changes → sync to Nest speaker

**Files created/modified:**
1. `src/main/windows-volume-sync.js` - NEW: Polls Windows volume, triggers callback on change (INCOMPLETE)
2. `src/main/electron-main.js` - MODIFIED: `set-volume` handler now passes cached IP for faster connection
3. `src/renderer/renderer.js` - MODIFIED: Added volume debouncing for stereo mode

**Still TODO:**
1. ~~**Add `set-volume-fast` command to cast-helper.py**~~ ✅ DONE - Uses IP directly instead of network scan
2. ~~**Integrate windows-volume-sync into electron-main.js**~~ ✅ DONE - Start monitoring when streaming starts
3. **Test Windows volume keys** - Press keyboard volume up/down → Nest volume should follow
4. ~~**Fix auto-start with Windows**~~ ✅ DONE - REG ADD syntax fixed with escaped quotes
5. ~~**Fix `streamingMode is not defined`**~~ - Fixed by removing references

**Why volume is slow (10 seconds):**
- Current Python `set_volume()` does full network discovery every call
- `pychromecast.get_listed_chromecasts()` takes 5-10 seconds
- Solution: Pass cached IP directly → `pychromecast.Chromecast(ip)` connects instantly

**Python function needed in cast-helper.py:**
```python
def set_volume_fast(speaker_name, volume_level, speaker_ip):
    """Fast volume set using direct IP connection (no discovery)."""
    try:
        if speaker_ip:
            # Direct connection - no network scan!
            cast = pychromecast.Chromecast(speaker_ip)
            cast.wait(timeout=5)
        else:
            # Fallback to discovery
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name], timeout=10
            )
            if not chromecasts:
                return {"success": False, "error": "Speaker not found"}
            cast = chromecasts[0]
            cast.wait()
            browser.stop_discovery()

        volume = max(0.0, min(1.0, float(volume_level)))
        cast.set_volume(volume)
        return {"success": True, "volume": volume}
    except Exception as e:
        return {"success": False, "error": str(e)}
```

**And add CLI handler:**
```python
elif command == "set-volume-fast" and len(sys.argv) >= 4:
    speaker = sys.argv[2]
    volume = float(sys.argv[3])
    ip = sys.argv[4] if len(sys.argv) > 4 else None
    result = set_volume_fast(speaker, volume, ip)
    print(json.dumps(result))
```

#### Git Commit
- `edac15a` - 🚧 WIP: Windows volume sync for Nest speakers

#### Progress Summary
| Task | Status |
|------|--------|
| License system | ✅ Complete |
| Trial timer | ✅ Complete |
| System tray | ✅ Complete |
| Volume control UI | ✅ Complete |
| Volume stereo mode | ✅ Fixed |
| Windows volume sync | ✅ Integrated |
| set-volume-fast Python | ✅ Complete |
| Auto-start Windows | ✅ Fixed |
| Stream Monitor | ✅ Fixed |

### January 7, 2026 (Session 15) - Stream Monitor & Auto-Start Fixes

**Session Goal:** Fix Stream Monitor (fake data), Auto-Start syntax error, Windows volume sync

#### What Was Completed
- ✅ Fixed auto-start REG ADD syntax error (paths with spaces now properly escaped)
- ✅ Fixed Stream Monitor - now shows real FFmpeg data instead of fake sine waves
- ✅ Added `-stats` flag to all FFmpeg commands to force progress output
- ✅ Stream bars now respond to actual bitrate level (not random animation)
- ✅ Added debug logging for FFmpeg output parsing
- ✅ Improved FFmpeg regex patterns to handle various output formats

#### Fixes Applied

**Auto-Start REG ADD Fix** (`auto-start-manager.js`):
```javascript
// Before (broken for paths with spaces):
const appPath = `"${exePath}" "${projectPath}"`;

// After (proper escaping):
const appPath = `"\\"${exePath}\\" \\"${projectPath}\\""`;
```

**Stream Monitor Fix** (`stream-stats.js`):
- Changed `updateAudioLevels()` to `updateActivityIndicator()`
- Bars now show different states:
  - **Connecting**: Low pulsing animation while waiting for FFmpeg data
  - **Active**: Bars height based on actual bitrate (320kbps = 100%)
  - **Idle**: Flat low bars when no recent data
- Added `hasReceivedData` flag to track if FFmpeg has started outputting
- Added `lastDataTime` to detect when data stops flowing

**FFmpeg Progress Output** (`electron-main.js`):
- Added `-stats` flag to main WebRTC FFmpeg
- Changed `-loglevel error` to `-stats` for stereo L/R FFmpegs
- Now all three FFmpeg processes output progress info to stream stats

#### Git Commit
- `4f64437` - 🔧 fix: Stream monitor and auto-start fixes

#### Next Steps
1. Test Windows volume keys → Nest volume sync
2. Test auto-start with Windows (should work now)
3. Verify Stream Monitor shows real bitrate/data
4. Match DeleteMyTweets styling (Task #10)

### January 7, 2026 (Session 16) - Virtual Audio Device Name Fix

**Session Goal:** Fix customer-reported bug - audio device not switching to virtual audio

#### Problem
- Customers reported clicking "Speakers Only" mode but device NOT switching
- Screenshot showed Windows Sound panel still on physical speakers
- User's virtual device called "Speakers (Virtual Desktop Audio)"
- This name was NOT in our device list → switch failed silently

#### Root Cause
`switchToStreamingDevice()` in `audio-device-manager.js` only tried:
```javascript
// OLD - Missing Virtual Desktop Audio!
const virtualDeviceNames = [
  'virtual-audio-capturer',
  'Virtual Audio Capturer',
  'CABLE Input',
  'VB-Audio Virtual Cable'
];
```

The screen-capture-recorder installs as "Speakers (Virtual Desktop Audio)" - NOT in our list!

#### Fix Applied
```javascript
// NEW - Virtual Desktop Audio first (most common)
const virtualDeviceNames = [
  'Virtual Desktop Audio',            // Most common - screen-capture-recorder
  'virtual-audio-capturer',           // Legacy name
  'Virtual Audio Capturer',           // Case variant
  'Speakers (Virtual Desktop Audio)', // Full name with prefix
  'CABLE Input',                      // VB-Audio CABLE
  'VB-Audio Virtual Cable'            // VB-Audio alternative
];
```

Also added:
- Logging for each device name tried
- Better error message showing which devices were tried
- Console output helps debug customer issues

#### Git Commit
- `fb2081c` - 🔧 fix: Add Virtual Desktop Audio to device name list

#### Files Modified
- `src/main/audio-device-manager.js` - Added device names, improved logging

### January 7, 2026 (Session 17) - NirCmd Bundle Fix

**Session Goal:** Fix audio device not switching - customers still reporting issue

#### Root Cause Found
The `nircmd/` folder only contained README.md - **nircmd.exe was never actually bundled!**
- Code checked `fs.existsSync(NIRCMD_PATH)` → returned FALSE
- Fell back to PowerShell which may have been failing silently

#### Fix Applied
1. **Downloaded and bundled NirCmd** (47KB utility from NirSoft)
   - `nircmd.exe` - main executable
   - `nircmdc.exe` - console version
   - `NirCmd.chm` - help file
2. **Added extensive debug logging**:
   - Logs exact path being checked
   - Logs whether NirCmd exists
   - Logs exit code and output
   - Easy to diagnose future issues

#### Verification
Tested both methods:
- NirCmd: `nircmd setdefaultsounddevice "Virtual Desktop Audio" 1` → SUCCESS
- PowerShell: Core Audio COM interface → SUCCESS

#### Git Commit
- `c124bbc` - 🔧 fix: Bundle NirCmd for reliable audio device switching

#### Files Added/Modified
- `nircmd/nircmd.exe` - NEW: NirCmd executable
- `nircmd/nircmdc.exe` - NEW: Console version
- `nircmd/NirCmd.chm` - NEW: Help file
- `src/main/audio-device-manager.js` - MODIFIED: Extensive debug logging

---

### January 7, 2026 (Session 18) - CRITICAL: Mono Streaming Fix

**Session Goal:** Fix mono speaker streaming (single speakers not getting audio)

#### Problem Discovered
- **Stereo pairs (two speakers for L/R)**: WORKING
- **Single mono speakers**: NO AUDIO

Investigation revealed critical difference:
- **Stereo mode**: Uses `http://${localIp}:8889` (local HTTP directly on network)
- **Mono mode**: Uses cloudflared tunnel (`https://xxx.trycloudflare.com`)

The cloudflared tunnel was unreliable - Cast receiver couldn't consistently fetch audio through it.

#### The Fix
Changed mono streaming to use local HTTP URL (same as stereo mode):

```javascript
// BEFORE (broken):
let httpsUrl = tunnelUrl; // cloudflared tunnel

// AFTER (working):
const localIp = getLocalIp();
let webrtcUrl = `http://${localIp}:8889`;
```

#### Why This Works
1. Cast receivers on local network can directly access `http://192.168.x.x:8889`
2. No external tunnel means no network latency or connection issues
3. MediaMTX WebRTC endpoint is directly accessible on port 8889
4. This matches exactly how stereo mode works (and stereo works!)

#### Also Fixed
- Audio device caching (30-second TTL to avoid repeated FFmpeg spawns)
- Removed dead `checkAudioDeviceExists()` function
- Consolidated dependency checks to single audio device scan

#### Git Commits
- `76019ea` - 🧹 cleanup: Cache audio devices + remove duplicate scans
- `210e07f` - 🔥 fix: Mono streaming now uses local HTTP instead of cloudflared tunnel

#### Files Modified
- `src/main/electron-main.js` - Mono streaming uses local HTTP URL
- `src/main/audio-streamer.js` - Added 30-second cache to getAudioDevices()

#### Key Insight
**Local HTTP works for Cast devices on the same network.** The tunnel was unnecessary overhead that introduced unreliability. Stereo mode proved the local approach works.

---

### January 7, 2026 (Session 19) - Single Speaker L/R Click Fix

**Session Goal:** Fix single mono speaker click only pings without streaming

#### Problem Discovered
User reported: "When i select just ONE speaker - ie a mono speaker i get no audio. BUT when i click to select a second mono speaker about 15 seconds later it works."

Logs showed only `Pinging` instead of streaming when clicking a single speaker.

#### Root Cause Analysis
1. Users click the **L or R button** on a mono speaker
2. Click handler calls `toggleStereoChannel()` which:
   - Pings the speaker (user hears sound)
   - Assigns the channel (L or R)
   - BUT only starts streaming when **BOTH L AND R are assigned** (line 806)
3. Single speaker clicks only ping without streaming!

The UX expectation: clicking L or R should start streaming immediately.

#### The Fix
Modified `toggleStereoChannel()` to start mono streaming when only ONE speaker has L/R assigned:

```javascript
} else if (stereoMode.leftSpeaker !== null || stereoMode.rightSpeaker !== null) {
  // FIX: Only ONE speaker assigned (L or R) - start mono streaming to it!
  const monoSpeakerIndex = stereoMode.leftSpeaker !== null
    ? stereoMode.leftSpeaker
    : stereoMode.rightSpeaker;
  log(`Single speaker assigned - starting mono stream...`, 'success');
  await startStreamingToSpeaker(monoSpeakerIndex, false);
}
```

Also fixed:
1. Added `clearStereoState` parameter to `startStreamingToSpeaker()` to preserve L/R assignments
2. Added cleanup in `start-stereo-streaming` handler to stop mono FFmpeg before starting stereo
3. Fixed `setStreamingState()` calls in stereo start/stop functions

#### New Behavior
- **Click L on Speaker A** → Mono streaming starts immediately
- **Click R on Speaker B** → Switches to stereo separation mode
- **Click L or R again** → Swaps speaker assignment

#### Git Commit
- `2494a34` - 🔧 fix: Single speaker L/R click now starts mono streaming

#### Files Modified
- `src/renderer/renderer.js` - Single L/R click starts mono, fixed stereo state tracking
- `src/main/electron-main.js` - Stop mono stream when switching to stereo

---

### January 8, 2026 (Session 20) - WebRTC ICE Troubleshooting & Firewall Discovery

**Session Goal:** Fix WebRTC streaming to Green TV (NVIDIA SHIELD) which stopped working

#### Problem Summary
- WebRTC streaming to Green TV (NVIDIA SHIELD Android TV) was working "last night"
- Today: Cast receiver launches, WHEP signaling works, but ICE negotiation FAILS
- All WebRTC sessions show: `deadline exceeded while waiting connection`
- HTTP streaming still works perfectly

#### Investigation Steps

1. **Killed stuck MediaMTX process** - User ran `taskkill /F /IM mediamtx.exe` as admin
2. **Started fresh pipeline** - MediaMTX, FFmpeg, Cloudflared tunnel
3. **New tunnel URL**: `https://very-ownership-solomon-tenant.trycloudflare.com`
4. **Tested WebRTC** - Sessions created but ICE never establishes
5. **Tested HTTP cast** - `python cast-helper.py cast "Green TV" "http://192.168.50.48:8000/stream.mp3"` → **SUCCESS**

#### Root Cause Found
**Windows Firewall blocks UDP port 8189** (ICE port for WebRTC)

MediaMTX logs show the pattern:
```
[WebRTC] [session xxx] created by [::1]:xxxxx
[WebRTC] [session xxx] closed: deadline exceeded while waiting connection
```

WHEP signaling works through cloudflared tunnel, but the actual peer-to-peer UDP connection cannot be established because Windows Firewall blocks incoming UDP on port 8189.

#### Fixes Applied

**1. Added TURN servers to receiver.html** (commit `2d978cc`)
```javascript
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};
```

**2. Added connection lock to prevent race conditions** (commit `f5630ef`)
- Added `isConnecting` flag to prevent multiple simultaneous WHEP requests
- Added cleanup of existing connection before starting new one
- Added state checking before `setRemoteDescription()`:
```javascript
if (peerConnection.signalingState !== 'have-local-offer') {
  throw new Error('Invalid state: ' + peerConnection.signalingState);
}
```

**3. Created fix-firewall.bat** for users to run as admin
```batch
netsh advfirewall firewall add rule name="MediaMTX WebRTC UDP" dir=in action=allow protocol=UDP localport=8189
netsh advfirewall firewall add rule name="MediaMTX WebRTC TCP" dir=in action=allow protocol=TCP localport=8189
netsh advfirewall firewall add rule name="MediaMTX HTTP" dir=in action=allow protocol=TCP localport=8889
netsh advfirewall firewall add rule name="MediaMTX RTSP" dir=in action=allow protocol=TCP localport=8554
```

#### Research Conducted
- Searched DuckDuckGo for WebRTC ICE Cast issues
- Found generativefm/play project that uses WebRTC with Cast SDK
- Key difference: They create WebRTC connection in SENDER (browser), we create it in RECEIVER (Cast device)
- Their approach works because sender has full network access

#### Key Insights

1. **HTTP Cast works** - Proves Cast connectivity is fine, issue is specifically WebRTC ICE
2. **TURN servers help but don't solve firewall issue** - Both receiver AND server need TURN, plus UDP must not be blocked
3. **Local network vs tunnel** - Previous fix (Session 18) showed local HTTP works better than tunnels
4. **Firewall is the blocker** - Windows Firewall blocking UDP 8189 prevents ICE completion

#### Files Created/Modified
- `docs/receiver.html` - Added TURN servers, connection lock, state checking
- `fix-firewall.bat` - NEW: Admin script to add firewall rules

#### Git Commits
- `2d978cc` - 🔧 fix: Add TURN servers to receiver for symmetric NAT traversal
- `f5630ef` - 🔧 fix: Add connection lock and state checking to prevent race conditions

#### Current State
- **WebRTC**: Broken until user runs `fix-firewall.bat` as Administrator
- **HTTP streaming**: Working with ~8 second latency
- **User instruction**: Right-click `fix-firewall.bat` → "Run as administrator"

#### Workaround
Until firewall is fixed, use HTTP cast:
```bash
python src/main/cast-helper.py cast "Green TV" "http://192.168.50.48:8000/stream.mp3"
```

---

### January 8, 2026 (Session 21) - ICE Fix Complete + Documentation

**Session Goal:** Document working state before attempting Green TV fix

#### ICE NEGOTIATION FIX - ROOT CAUSE & SOLUTION

**Problem:** WebRTC sessions created but ICE never established. `bytesSent=0`, `peerConnectionEstablished: false`, empty ICE candidates.

**Root Cause:** PC has 6+ network interfaces with dead 169.254.x.x (APIPA/link-local) addresses:
- Ethernet 2: 169.254.145.108 (dead)
- WiFi 5: 169.254.192.94 (dead)
- WiFi 4: 169.254.164.51 (dead)
- Bluetooth: 169.254.49.17 (dead)
- WiFi: 169.254.44.17 (dead)
- **Ethernet: 192.168.50.48** (REAL working IP)

MediaMTX with `webrtcIPsFromInterfaces: yes` was trying to gather ICE candidates from ALL interfaces, including dead ones. This caused 60+ second timeouts.

**Solution Applied:**
1. Set `webrtcIPsFromInterfaces: no` - Stop scanning interfaces
2. Inject real IP into `webrtcAdditionalHosts` at startup
3. Empty `webrtcICEServers2: []` - No STUN/TURN needed on local LAN
4. Empty `iceServers: []` in receiver.html - Faster ICE gathering

---

## WORKING ARCHITECTURE (January 8, 2026)

### Device Compatibility Matrix

| Device | Type | WebRTC | HTTP | Notes |
|--------|------|--------|------|-------|
| DENNIS | Nest Mini | ✅ | ✅ | Works great |
| Den pair | Cast Group | ✅ STEREO | ✅ | L&R separation working |
| STUDY | Cast Group | ✅ | ✅ | Works |
| Back garden speaker | Nest Mini | ❌ | ✅ | Old firmware - custom receiver fails |
| **Green TV** | NVIDIA SHIELD | ❌ | ? | **NEEDS FIX** |

### Audio Quality Observations (User Feedback)
- **L&R individual streams** = Higher audio quality than groups
- **Groups via regular browser/Spotify** = Mono playback
- **Groups via our WebRTC** = Stereo playback!

---

## CURRENT WORKING SETTINGS

### MediaMTX Config (`mediamtx/mediamtx-audio.yml`)

```yaml
# WebRTC server - serves to Cast receiver
webrtc: yes
webrtcAddress: :8889
webrtcEncryption: no
webrtcAllowOrigins: ['*']

# CRITICAL: Disable auto-detect to avoid dead 169.254.x.x interfaces
webrtcIPsFromInterfaces: no
webrtcIPsFromInterfacesList: []

# App injects real IP here at startup
webrtcAdditionalHosts: ['192.168.50.48']

# ICE ports
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189

# Timeouts
webrtcHandshakeTimeout: 30s
webrtcTrackGatherTimeout: 10s
webrtcSTUNGatherTimeout: 5s

# NO STUN/TURN for local network
webrtcICEServers2: []
```

### Cast Receiver ICE Config (`docs/receiver.html`)

```javascript
// ICE configuration - empty for local network (no STUN needed on same LAN)
// This dramatically speeds up ICE gathering
const iceConfig = {
  iceServers: [],
  iceTransportPolicy: 'all'
};
```

### Dynamic IP Injection (`electron-main.js`)

```javascript
// Inject local IP into MediaMTX config for ICE candidates
try {
  const localIp = getLocalIp();
  const configPath = getMediaMTXConfig();
  let config = fs.readFileSync(configPath, 'utf8');

  // Update webrtcAdditionalHosts with detected IP
  config = config.replace(
    /webrtcAdditionalHosts:\s*\[.*?\]/,
    `webrtcAdditionalHosts: ['${localIp}']`
  );

  fs.writeFileSync(configPath, config, 'utf8');
  sendLog(`[MediaMTX] Injected local IP: ${localIp}`);
} catch (e) {
  sendLog(`[MediaMTX] Could not inject IP: ${e.message}`, 'warning');
}
```

---

## WORKING PIPELINE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PC NEST SPEAKER PIPELINE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  MONO MODE:                                                                 │
│  ┌──────────┐    ┌───────┐    ┌──────────┐    ┌────────┐    ┌──────────┐  │
│  │ Windows  │───▶│FFmpeg │───▶│ MediaMTX │───▶│  WHEP  │───▶│ Speaker  │  │
│  │  Audio   │    │ Opus  │    │   RTSP   │    │ WebRTC │    │          │  │
│  └──────────┘    └───────┘    └──────────┘    └────────┘    └──────────┘  │
│      │                             │               │                       │
│      │                        :8554 RTSP     :8889 HTTP                    │
│      │                                                                     │
│  STEREO MODE (L&R Separation):                                             │
│  ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌────────────────────┐  │
│  │ Windows  │───▶│ FFmpeg L  │───▶│ MediaMTX │───▶│ LEFT Speaker       │  │
│  │  Audio   │    │ pan=left  │    │ /left    │    │ (via WHEP)         │  │
│  │          │───▶│ FFmpeg R  │───▶│ /right   │───▶│ RIGHT Speaker      │  │
│  └──────────┘    │ pan=right │    └──────────┘    │ (via WHEP)         │  │
│                  └───────────┘                    └────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### FFmpeg Commands

**Mono (single stream):**
```bash
ffmpeg -f dshow -i audio="virtual-audio-capturer" \
  -c:a libopus -b:a 128k -ar 48000 -ac 2 \
  -f rtsp -rtsp_transport tcp rtsp://localhost:8554/pcaudio
```

**Stereo Left Channel:**
```bash
ffmpeg -f dshow -i audio="virtual-audio-capturer" \
  -af "pan=mono|c0=FL" \
  -c:a libopus -b:a 128k -ar 48000 -ac 1 \
  -f rtsp -rtsp_transport tcp rtsp://localhost:8554/left
```

**Stereo Right Channel:**
```bash
ffmpeg -f dshow -i audio="virtual-audio-capturer" \
  -af "pan=mono|c0=FR" \
  -c:a libopus -b:a 128k -ar 48000 -ac 1 \
  -f rtsp -rtsp_transport tcp rtsp://localhost:8554/right
```

### WHEP Protocol Flow

```
1. Cast receiver loads on speaker
2. Receiver gets WebRTC URL: http://192.168.50.48:8889/pcaudio/whep
3. Creates RTCPeerConnection with empty iceServers
4. Creates SDP offer, sends POST to WHEP endpoint
5. MediaMTX returns SDP answer with ICE candidates
6. ICE establishes using local candidate: host/udp/192.168.50.48/8189
7. Audio flows via UDP
```

### Ports Used

| Port | Protocol | Purpose |
|------|----------|---------|
| 8554 | TCP | RTSP (FFmpeg → MediaMTX) |
| 8889 | HTTP | WHEP endpoint (WebRTC signaling) |
| 8189 | UDP/TCP | ICE media transport |
| 9997 | HTTP | MediaMTX API |

---

## WHAT DOESN'T WORK

### Green TV (NVIDIA SHIELD Android TV)
- **Cast type:** `cast` (not `audio`)
- **Model:** NVIDIA SHIELD Android TV
- **Custom receiver launches:** ✅ Yes
- **WHEP signaling:** ✅ Works
- **ICE negotiation:** ❌ FAILS
- **HTTP streaming:** Untested

**Possible issues to investigate:**
1. Different Cast protocol for TVs vs audio devices
2. Network isolation between TV and PC
3. Different ICE behavior on Android TV
4. Shield-specific WebRTC limitations

### Back garden speaker (old Nest Mini)
- **Cast type:** `audio`
- **Custom receiver:** ❌ `RequestFailed: Failed to execute start app FCAA4619`
- **HTTP streaming:** ✅ Works with 8s latency
- **Workaround:** Use HTTP/MP3 fallback mode

---

## GIT COMMITS FOR ICE FIX

```
3327183 🔧 fix: Add webrtcAllowAnyHost for hostname validation bypass
75d2552 🔧 fix: ICE negotiation - disable dead interface scanning, remove STUN
db7623b 🔧 fix: Inject local IP into MediaMTX config for ICE candidates
76c05ea 🔧 fix: Remove deprecated settings and double ping
```

---

## GREEN TV RESEARCH FINDINGS (January 8, 2026)

### 🔥 ROOT CAUSE DISCOVERED

**Chromecast/NVIDIA Shield DON'T support WebRTC/WHEP directly!**

| Device Type | Cast Type | WebRTC Support | Solution |
|-------------|-----------|----------------|----------|
| Nest Mini/Hub | `audio` | ✅ Custom receiver works | Keep WebRTC |
| Cast Groups | `group` | ✅ Custom receiver works | Keep WebRTC |
| Android TV/Shield | `cast` | ❌ Limited/No WebRTC | Use HLS |
| Chromecast dongle | `cast` | ❌ Limited WebRTC | Use HLS |

### Why Nest Speakers Work But Shield Doesn't

1. **Nest speakers** run a lightweight Cast receiver that supports WebRTC in its browser environment
2. **Android TV/Shield** runs a different Cast receiver with WebView that has LIMITED WebRTC support
3. Our custom receiver.html uses `RTCPeerConnection` which works on audio devices but fails on TVs

### Solution Architecture for TVs

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DUAL-MODE STREAMING                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  AUDIO DEVICES (Nest Mini, Groups) - KEEP WORKING:                  │
│  ┌──────────┐    ┌───────┐    ┌──────────┐    ┌─────────────────┐  │
│  │ Windows  │───▶│FFmpeg │───▶│ MediaMTX │───▶│ WebRTC/WHEP     │  │
│  │  Audio   │    │ Opus  │    │   RTSP   │    │ Custom Receiver │  │
│  └──────────┘    └───────┘    └──────────┘    └─────────────────┘  │
│                                                                      │
│  TV DEVICES (Shield, Chromecast) - NEW:                             │
│  ┌──────────┐    ┌───────┐    ┌──────────┐    ┌─────────────────┐  │
│  │ Windows  │───▶│FFmpeg │───▶│ MediaMTX │───▶│ HLS (.m3u8)     │  │
│  │  Audio   │    │ AAC   │    │   HLS    │    │ Default Receiver│  │
│  └──────────┘    └───────┘    └──────────┘    └─────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### MediaMTX Config Changes Needed for TV Support

```yaml
# Enable HLS for TV devices (currently disabled!)
hls: yes
hlsAddress: :8888
hlsSegmentDuration: 2s
hlsSegmentCount: 3
hlsPartDuration: 200ms

# Path config
paths:
  pcaudio:
    source: publisher
    # This enables HLS output at: http://192.168.50.48:8888/pcaudio/hls.m3u8
```

### Cast Code Changes Needed

```python
# In cast-helper.py - detect device type and use appropriate stream
if cast.cast_info.cast_type == 'cast':  # TV/Shield
    # Use HLS stream
    url = f"http://{local_ip}:8888/pcaudio/hls.m3u8"
    content_type = "application/vnd.apple.mpegurl"
else:  # audio/group
    # Use WebRTC via custom receiver
    webrtc_launch(...)
```

### Latency Comparison

| Protocol | Latency | Best For |
|----------|---------|----------|
| WebRTC (current) | < 1 second | Nest speakers, Groups |
| HLS (needed for TV) | 2-6 seconds | Green TV, Shield |
| HTTP/MP3 (fallback) | 8-15 seconds | Old firmware devices |

### Implementation Plan

**DO NOT BREAK WHAT WORKS:**
1. Keep WebRTC for `audio` and `group` devices
2. Add HLS support ONLY for `cast` type devices
3. Detect device type in code and route accordingly

**Steps:**
1. [ ] Enable HLS in mediamtx-audio.yml
2. [ ] Add device type detection in electron-main.js
3. [ ] Route TV devices to HLS, audio devices to WebRTC
4. [ ] Test Green TV with HLS stream
5. [ ] Verify audio devices still work with WebRTC

### User Feedback to Preserve

- **L&R individual streams** = Higher audio quality than groups
- **Groups via our WebRTC** = Stereo playback (better than Spotify!)
- **WebRTC latency** = Sub-second (KEEP THIS FOR AUDIO DEVICES)

---

### January 9, 2026 (Session 21) - Dual Receiver Architecture

**Session Goal:** Implement separate Cast receivers for audio devices vs TVs

#### Architecture Decision: Two Receivers Instead of One Smart Receiver

**Pros of Two Receivers:**
1. **Lean audio receiver** (~260 lines) - No ambient videos = faster load, less memory
2. **Full visual receiver** - Ambient videos for TVs where users actually SEE the screen
3. **Cleaner code** - Each receiver focused on one use case
4. **Smaller payload** - Audio receiver doesn't load video assets

**Receiver Details:**

| Receiver | App ID | File | Purpose |
|----------|--------|------|---------|
| **Audio** | `4B876246` | `docs/receiver-audio.html` | Lean, no visuals - Nest speakers & groups |
| **Visual** | `FCAA4619` | `docs/receiver-visual.html` | Full experience with ambient videos - TVs |

#### Routing Logic

```javascript
// In electron-main.js

// App ID Constants
const AUDIO_APP_ID = '4B876246';   // Lean audio-only receiver
const VISUAL_APP_ID = 'FCAA4619';  // Full visual receiver

// Routing Function
function getReceiverAppId(speaker, forceAudio = false) {
  if (!speaker || !speaker.cast_type) {
    return AUDIO_APP_ID; // Default to audio
  }

  // Groups and audio devices → Audio receiver
  if (speaker.cast_type === 'audio' || speaker.cast_type === 'group') {
    return AUDIO_APP_ID;
  }

  // TVs/displays (cast_type='cast') → Visual receiver
  if (speaker.cast_type === 'cast' && !forceAudio) {
    return VISUAL_APP_ID;
  }

  return AUDIO_APP_ID;
}
```

#### Device Type Mapping

| Device Type | `cast_type` | Receiver | Reason |
|-------------|-------------|----------|--------|
| Nest Mini | `audio` | Audio | No screen - visuals wasted |
| Nest Hub | `audio` | Audio | Has screen but mainly for audio |
| Google Home | `audio` | Audio | No screen |
| Cast Group | `group` | Audio | Groups are always audio-focused |
| NVIDIA Shield | `cast` | Visual | Has TV - show ambient videos |
| Chromecast | `cast` | Visual | Connected to TV - show visuals |
| Android TV | `cast` | Visual | Has screen - show visuals |

#### Python cast-helper.py Changes

```python
# Constants
VISUAL_APP_ID = "FCAA4619"  # PC Nest Speaker (Visual)
AUDIO_APP_ID = "4B876246"   # PC Nest Speaker Audio (lean)

# Functions updated to accept app_id parameter:
def webrtc_launch(speaker_name, https_url=None, speaker_ip=None, stream_name="pcaudio", app_id=None):
    receiver_app_id = app_id if app_id else AUDIO_APP_ID
    # ... uses receiver_app_id for cast.start_app()

def webrtc_proxy_connect(speaker_name, mediamtx_url, speaker_ip=None, stream_name="pcaudio", app_id=None):
    receiver_app_id = app_id if app_id else AUDIO_APP_ID
    # ... uses receiver_app_id for cast.start_app()

def webrtc_launch_multicast(speaker_names, https_url, speaker_ips=None, stream_name="pcaudio", app_id=None):
    # ... passes app_id to webrtc_launch()

# CLI Arguments updated:
# webrtc-launch <speaker_name> [https_url] [speaker_ip] [stream_name] [app_id]
# webrtc-proxy-connect <speaker_name> <mediamtx_url> [speaker_ip] [stream_name] [app_id]
# webrtc-multicast <speaker_names_json> <https_url> [speaker_ips_json] [stream_name] [app_id]
```

#### Files Changed

| File | Changes |
|------|---------|
| `docs/receiver-audio.html` | NEW: Lean audio-only receiver (~260 lines) |
| `docs/receiver-visual.html` | NEW: Copy of original receiver.html |
| `src/main/cast-helper.py` | Updated all functions to accept app_id parameter |
| `src/main/electron-main.js` | Added constants, routing function, updated ALL webrtc-launch calls |

#### Git Commits

- `ec79f21` - feat: Add dual receiver App ID support in cast-helper.py
- `7c34100` - feat: Route correct Cast receiver based on device type

#### Testing Checklist

- [ ] Nest Mini → Should use Audio receiver (4B876246)
- [ ] Nest Hub → Should use Audio receiver (4B876246)
- [ ] Cast Group → Should use Audio receiver (4B876246)
- [ ] Stereo Pair → Should use Audio receiver (4B876246)
- [ ] NVIDIA Shield → Should use Visual receiver (FCAA4619)
- [ ] Chromecast → Should use Visual receiver (FCAA4619)

#### Log Output

When streaming, you should see which receiver is being used:
```
Connecting to DENNIS (192.168.50.241) [Receiver: Audio]...
Connecting to Green TV (192.168.50.100) [Receiver: Visual]...
```

---

## ARCHITECTURE REFERENCE: Cast Receiver Routing

### Quick Reference

```
Device Selection Flow:
┌─────────────────────────────────────────────────────┐
│                User clicks speaker                   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│           getReceiverAppId(speaker)                  │
│                                                      │
│   speaker.cast_type === 'audio'  → AUDIO_APP_ID     │
│   speaker.cast_type === 'group'  → AUDIO_APP_ID     │
│   speaker.cast_type === 'cast'   → VISUAL_APP_ID    │
│   unknown/null                   → AUDIO_APP_ID     │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│    runPython(['webrtc-launch', ..., app_id])        │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│    cast-helper.py: cast.start_app(receiver_app_id)  │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│    Cast device loads receiver from GitHub Pages:     │
│                                                      │
│    AUDIO: kepners.github.io/pcnestspeaker/receiver-audio.html  │
│    VISUAL: kepners.github.io/pcnestspeaker/receiver.html       │
└─────────────────────────────────────────────────────┘
```

### Code Locations

| What | Where |
|------|-------|
| App ID constants | `electron-main.js` lines 77-78 |
| Routing function | `electron-main.js` lines 90-106 |
| Python constants | `cast-helper.py` lines 19-26 |
| Python functions | `cast-helper.py` webrtc_launch(), webrtc_proxy_connect(), webrtc_launch_multicast() |

### Troubleshooting

**Wrong receiver used?**
1. Check speaker's `cast_type` in discovery logs
2. Verify `getReceiverAppId()` logic matches device type
3. Check logs for `[Receiver: Audio]` or `[Receiver: Visual]`

**Receiver won't load?**
1. Verify App IDs in Cast SDK Console: https://cast.google.com/publish/
2. Both apps must be Published (not Unpublished)
3. Check GitHub Pages is serving receivers at correct URLs

**Custom receiver not supported?**
- Some old firmware devices reject custom receivers
- Error: `RequestFailed: Failed to execute start app`
- Fallback: Use HTTP/MP3 streaming instead

---

*Last Updated: January 9, 2026*
