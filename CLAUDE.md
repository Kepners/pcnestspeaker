# PC Nest Speaker

## Project Overview

**PC Nest Speaker** streams Windows system audio to Google Nest speakers over Wi-Fi. No Bluetooth required.

| Item | Value |
|------|-------|
| Type | Electron Desktop App |
| Monetization | Paid (Stripe) |
| License Format | XXXX-XXXX-XXXX-XXXX (16 hex chars from HMAC) |
| Streaming | WebRTC (speakers), HLS (TVs) |
| Latency | ~instant (WebRTC optimized) |

---

## Key Documentation

| Doc | Purpose |
|-----|---------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagrams & component details |
| [docs/APP_DOCUMENTATION.md](docs/APP_DOCUMENTATION.md) | Complete feature documentation |
| [.claude/CLAUDE.md](.claude/CLAUDE.md) | Session memory & architecture quick-ref |
| [.claude/LESSONS_LEARNED.md](.claude/LESSONS_LEARNED.md) | FFmpeg, Cast, audio gotchas |
| [.claude/TRIAL_DRM_SYSTEM.md](.claude/TRIAL_DRM_SYSTEM.md) | Trial encryption & DRM system |

---

## Design System: Warm Neutral

| Name | Hex | Usage |
|------|-----|-------|
| Dim Grey | `#6B6D76` | Secondary text, borders |
| Khaki Beige | `#A69888` | Backgrounds, cards |
| Powder Blush | `#FCBFB7` | Primary accent, CTAs |
| Charcoal Blue | `#334E58` | Headers, primary text |
| Dark Coffee | `#33261D` | Deep backgrounds |

```css
:root {
  --color-grey: #6B6D76;
  --color-beige: #A69888;
  --color-blush: #FCBFB7;
  --color-blue: #334E58;
  --color-coffee: #33261D;
}
```

---

## Trial System Quick Reference

| Component | Value |
|-----------|-------|
| Trial Duration | 10 hours of streaming |
| Storage | `%APPDATA%/PC Nest Speaker/.usage` |
| Encryption | AES-128-CBC |
| Integrity | HMAC-SHA256 |
| Key Derivation | scrypt (machine-specific) |

**Full docs:** [.claude/TRIAL_DRM_SYSTEM.md](.claude/TRIAL_DRM_SYSTEM.md)

---

## Audio Pipeline

```
Windows Audio → VB-CABLE Input → VB-CABLE Output → FFmpeg → Nest Speaker
```

### Requirements
- **User installs:** VB-CABLE or Voicemeeter (virtual audio device)
- **App bundles:** FFmpeg
- **Network:** PC and Nest on same Wi-Fi subnet

---

## Reference Code

Original Python implementations in `reference/python/`:
- `cast_system_audio_to_nest_v2.py` - HLS + MP3 fallback logic
- `cast_system_audio_to_nest_improved_FIXED.py` - Optimized HLS
- `cast_system_audio_to_nest_mp3_FIXED.py` - Stable MP3 streaming

---

*Last Updated: January 2026*
