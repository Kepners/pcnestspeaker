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
2. Every 60s, ping speaker to measure current RTT
3. If RTT drift > 50ms, adjust delay proportionally
4. newDelay = baselineDelay + (currentRTT - baselineRTT)
```

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

*Last Updated: January 2025*
