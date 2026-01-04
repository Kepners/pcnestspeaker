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

## Next Steps

1. **Set up Electron skeleton** - Basic window, IPC structure
2. **Port FFmpeg logic** - Node.js child_process wrapper
3. **Implement Chromecast** - Use node-castv2-client or similar
4. **Build UI** - Warm Neutral themed HTML/CSS
5. **Add licensing** - Stripe + Vercel integration
6. **Configure builds** - electron-builder for Win/Mac

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

---

*Last Updated: January 2026*
