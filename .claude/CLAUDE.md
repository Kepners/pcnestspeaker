# PC Nest Speaker - Session Memory

## Quick Reference
- **Related website**: `../pcnestspeaker-website`
- **Monetization**: Stripe payments with license keys
- **Workspace color**: Teal (#00897B)

---

## Project Documentation

| Doc | Purpose |
|-----|---------|
| [LESSONS_LEARNED.md](LESSONS_LEARNED.md) | FFmpeg, Cast, audio routing gotchas |
| [SESSION_HISTORY.md](SESSION_HISTORY.md) | Archived dev session notes |
| [TRIAL_DRM_SYSTEM.md](TRIAL_DRM_SYSTEM.md) | Trial encryption & DRM system |

---

## Architecture: Streaming Modes

### Device Types (`cast_type`)
| Type | Devices | Method | Receiver |
|------|---------|--------|----------|
| `audio` | Nest Mini, Nest Audio | WebRTC (Opus) | Audio (4B876246) |
| `group` | Cast Groups, Stereo Pairs | WebRTC L/R split | Audio (4B876246) |
| `cast` | TVs, Chromecast, Shield | HLS (AAC) | Visual (FCAA4619) |

### Receivers (Cast App IDs)
- **AUDIO_APP_ID** (`4B876246`): Lean audio-only receiver (WebRTC)
- **VISUAL_APP_ID** (`FCAA4619`): Splash + ambient photos + hls.js audio
- **Default Media Receiver** (`CC1AD845`): Google's built-in - NOT USED (can't play audio-only HLS)

### Flow: Speaker Streaming
```
Windows Audio → VB-Cable Input → VB-Cable Output → FFmpeg (Opus)
                                                        ↓
                                              RTSP → MediaMTX → WebRTC
                                                                   ↓
                                              Nest Speaker ← Audio Receiver
```

### Flow: TV/Shield Streaming
```
Windows Audio → VB-Cable → FFmpeg (AAC) → Direct HLS Server (8890)
                                                    ↓
                                          TV ← Visual Receiver → hls.js
```

**CRITICAL**: Cast SDK's `cast-media-player` CANNOT play audio-only HLS! We use hls.js.

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

## Audio Sync System

### Three Layers
```
Layer 1: APO Delay (pc-speaker-delay.js / audio-sync-manager.js)
  └─> Writes to: C:\Program Files\EqualizerAPO\config\pcnestspeaker-sync.txt

Layer 2: Auto-Sync Monitoring (auto-sync-manager.js)
  └─> Polls RTT every 500ms, adjusts delay if drift > 10ms

Layer 3: Volume Sync (windows-volume-sync.js)
  └─> Windows master → Nest + PC speaker volume
```

### Key Parameters
| Parameter | Value | Purpose |
|-----------|-------|---------|
| `CHECK_INTERVAL_MS` | 500 | RTT check frequency |
| `ADJUSTMENT_THRESHOLD_MS` | 10 | Min drift to trigger adjustment |
| `jitterBufferTarget` | 50ms | WebRTC receiver buffer |

---

## Commands Reference

### Python Cast Commands
```bash
python cast-helper.py discover
python cast-helper.py webrtc-launch <name> <url> [ip] [stream] [app_id]
python cast-helper.py hls-cast <name> <url> [ip] [model]
python cast-helper.py stop <name>
python cast-helper.py set-volume <name> <0.0-1.0>
python cast-helper.py get-group-members <name>
```

### IPC Handlers
```javascript
'start-streaming'      // Auto-detects TV vs speaker
'stop-streaming'
'set-sync-delay'       // Set APO delay (ms)
'enable-auto-sync'     // Start network monitoring
'discover-devices'     // Find all speakers/TVs
```

---

## Build & Release

```bash
npm run build          # Build installer + portable
npm run dev            # Dev mode with hot reload
```

### Outputs
```
dist/
├── PC Nest Speaker Setup X.X.X.exe  # NSIS installer
├── PC Nest Speaker X.X.X.exe        # Portable
└── win-unpacked/                    # Unpacked build
```

---

## Known Issues Quick Reference

| Issue | Cause | Fix |
|-------|-------|-----|
| No audio streaming | Windows not on VB-Cable | `setDefaultDevice()` in preStart |
| L/R out of sync | Sequential speaker connection | `Promise.all()` for parallel |
| High CPU = desync | DirectShow timestamp drift | Add `-async 1` to FFmpeg |
| TV no audio | Cast SDK can't play audio HLS | Use hls.js in receiver |
| Group slow (12-22s) | Re-discovery on click | Cache members at boot |

---

*Last Updated: January 2026*
