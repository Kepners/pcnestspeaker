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
│   │   ├── audio-streamer.js  # WASAPI → FFmpeg → HLS
│   │   └── chromecast.js      # Speaker discovery & casting
│   └── renderer/
│       ├── index.html         # UI
│       ├── styles.css         # Warm Neutral theme
│       └── renderer.js        # UI logic
├── docs/
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

### ELECTRON_RUN_AS_NODE Environment Variable
**MUST unset this before running Electron or `app` will be undefined!**

```bash
# In Git Bash:
unset ELECTRON_RUN_AS_NODE && node_modules/.bin/electron . --dev

# In CMD:
set ELECTRON_RUN_AS_NODE= && npm run dev

# In PowerShell:
$env:ELECTRON_RUN_AS_NODE = $null; npm run dev
```

**Symptom:** `TypeError: Cannot read properties of undefined (reading 'commandLine')` or `ipcMain.handle is not a function`

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

### WebRTC Custom Receiver Approach
Our receiver supports WebRTC via custom namespace:
1. Electron captures system audio via desktopCapturer (Windows loopback)
2. Creates RTCPeerConnection, adds audio track
3. Sends SDP offer to receiver via Cast messaging
4. Receiver creates answer, establishes connection
5. Audio streams over UDP/DTLS directly - no HTTP buffering

**Status:** Receiver ready, sender implementation pending.

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

---

*Last Updated: January 5, 2026*
