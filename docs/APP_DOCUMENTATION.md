# PC Nest Speaker - Complete Documentation

## Overview

**PC Nest Speaker** is a desktop application that streams all Windows system audio to Google Nest speakers and stereo pairs over Wi-Fi, without requiring Bluetooth.

**Version:** 1.0.0 (Development)
**Developer:** ChoppedOnions.xyz
**Platforms:** Windows, macOS (planned)

---

## Features

### Core Functionality
- **System Audio Streaming**: Capture all PC audio (games, music, videos)
- **Google Nest Support**: Stream to any Nest speaker or stereo pair
- **Dual Protocol**: HLS primary streaming with MP3 fallback
- **Low Latency**: ~1.5-3 second delay depending on protocol
- **Wi-Fi Only**: No Bluetooth pairing required

### Streaming Protocols
| Protocol | Latency | Reliability | Best For |
|----------|---------|-------------|----------|
| HLS (Primary) | ~1.5s | Good | Music, videos |
| MP3 (Fallback) | ~2-3s | Excellent | General use |

### Speaker Management
- **Auto-Discovery**: Find all Nest speakers on network
- **Stereo Pair Support**: Cast to grouped speakers
- **Volume Control**: Adjust speaker volume from app
- **Quick Selection**: Save preferred speaker

### License System
- One-time purchase, lifetime access
- 2 device activation limit
- Server-validated via Stripe

---

## Technical Stack

### Desktop App
- **Framework**: Electron 28.x
- **Audio Capture**: FFmpeg (DirectShow on Windows)
- **Casting**: node-castv2-client / pychromecast
- **UI**: Custom HTML/CSS (Warm Neutral design)

### Backend (Vercel Serverless)
- **License Validation API**: `/api/validate-license`
- **Stripe Webhook**: `/api/stripe-webhook`

### Payment Processing
- **Provider**: Stripe
- **Method**: Payment Links
- **License Storage**: Stripe Customer Metadata

### Audio Requirements
- **Virtual Audio Device**: VB-CABLE or Voicemeeter
- **Encoder**: FFmpeg (bundled or user-installed)

---

## File Structure

```
pcnestspeaker/
+-- electron-main.js      # Main Electron process
+-- app.html              # UI (renderer process)
+-- package.json          # Dependencies & build config
+-- icon.ico              # Windows icon
+-- icon.icns             # macOS icon
+-- vercel.json           # Vercel deployment config
+-- api/
|   +-- validate-license.js   # License validation endpoint
|   +-- stripe-webhook.js     # Stripe webhook handler
+-- lib/
|   +-- ffmpeg.js             # FFmpeg control module
|   +-- streaming.js          # HLS/MP3 server module
|   +-- chromecast.js         # Speaker discovery & control
+-- assets/
|   +-- ffmpeg/               # Bundled FFmpeg (optional)
+-- .github/
|   +-- workflows/
|       +-- build.yml     # GitHub Actions CI/CD
+-- docs/
|   +-- ARCHITECTURE.md   # System architecture
|   +-- APP_DOCUMENTATION.md  # This file
+-- dist/                 # Build output
```

---

## Configuration

### Environment Variables (Vercel)

| Variable | Description |
|----------|-------------|
| `STRIPE_API_KEY` | Stripe Secret Key (sk_live_...) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (whsec_...) |

### User Settings (settings.json)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `speaker` | string | null | Selected Nest speaker name |
| `protocol` | string | "hls" | Streaming protocol (hls/mp3) |
| `audioDevice` | string | "CABLE Output" | Virtual audio device |
| `port` | number | 8000 | HTTP server port |
| `autoStart` | boolean | false | Stream on app launch |

### Build Configuration (package.json)

```json
{
  "build": {
    "appId": "com.choppedonions.pcnestspeaker",
    "productName": "PC Nest Speaker",
    "win": {
      "target": ["portable", "nsis"],
      "icon": "icon.ico"
    },
    "mac": {
      "target": ["dmg", "zip"],
      "icon": "icon.icns",
      "category": "public.app-category.utilities"
    },
    "extraResources": [
      { "from": "assets/ffmpeg", "to": "ffmpeg" }
    ]
  }
}
```

---

## License System Flow

### Purchase Flow
```
1. User clicks "Buy License" in app
   |
   v
2. Opens Stripe Payment Link
   |
   v
3. User completes payment
   |
   v
4. Stripe webhook fires (checkout.session.completed)
   |
   v
5. Webhook generates license key: PNS-XXXX-XXXX-XXXX-XXXX
   |
   v
6. License stored in Stripe customer metadata
   |
   v
7. User receives license key (via receipt/email)
```

### Activation Flow
```
1. User enters license key in app
   |
   v
2. App validates format locally (PNS-XXXX-XXXX-XXXX-XXXX)
   |
   v
3. App calls API: POST /api/validate-license
   |
   v
4. API searches Stripe customers for matching license_key metadata
   |
   v
5. If valid: Returns { valid: true, email: "..." }
   |
   v
6. App saves license locally to: %APPDATA%/pcnestspeaker/license.json
   |
   v
7. UI unlocks, streaming features enabled
```

### Offline Support
- License validated once, then cached locally
- App works offline after initial activation
- Re-validation only on license change

---

## IPC Communication

### Main Process -> Renderer
| Channel | Data | Description |
|---------|------|-------------|
| `license-status` | `{licenseKey, email}` | License state on startup |
| `speakers-found` | `[{name, address}]` | Available Nest speakers |
| `streaming-status` | `{active, protocol, url}` | Stream state |
| `streaming-error` | `{message}` | Error notification |
| `volume-changed` | `{level}` | Speaker volume update |

### Renderer -> Main Process
| Channel | Data | Description |
|---------|------|-------------|
| `start-streaming` | `{speaker, protocol}` | Begin audio cast |
| `stop-streaming` | - | End audio cast |
| `discover-speakers` | - | Scan for Nest devices |
| `set-volume` | `{level}` | Adjust speaker volume |
| `activate-license` | `licenseKey` | Validate & save license |
| `deactivate-license` | - | Remove local license |
| `open-external` | `url` | Open URL in browser |

---

## Streaming Technical Details

### HLS Mode (Primary)

```
Audio Flow:
Windows Audio -> VB-CABLE Input -> CABLE Output -> FFmpeg -> HLS Segments

FFmpeg Settings:
- Codec: AAC (aac)
- Bitrate: 192kbps
- Sample Rate: 48000 Hz
- Channels: 2 (Stereo)
- Segment Duration: 0.5 seconds
- Playlist Size: 3 segments (1.5s buffer)
- Flags: delete_segments (truly live)

Output: http://{local_ip}:8000/stream.m3u8
```

### MP3 Mode (Fallback)

```
Audio Flow:
Windows Audio -> VB-CABLE Input -> CABLE Output -> FFmpeg -> HTTP Stream

FFmpeg Settings:
- Codec: libmp3lame
- Bitrate: 192kbps
- Sample Rate: 48000 Hz
- Channels: 2 (Stereo)
- Chunk Size: 8192 bytes
- Buffer: 100ms

Output: http://{local_ip}:8000/live.mp3
```

### Chromecast Integration

```
Discovery:
- mDNS scan for _googlecast._tcp
- Filter for Google Nest devices
- Parse device friendly names

Casting:
- Connect via Cast protocol
- Send media URL with content type
- Monitor playback state
- Handle disconnections
```

---

## Security Measures

### License Protection
- Server-side validation (can't be bypassed locally)
- License key format validation
- Stripe metadata as source of truth
- UI disabled without valid license

### Network Safety
- HTTP server binds to local IP only
- No external ports exposed
- Audio never leaves local network
- No cloud streaming

---

## Build & Deployment

### Local Development
```bash
npm install
npm start          # Run in development
npm run build      # Build Windows executables
```

### Production Build (GitHub Actions)
```bash
git tag v1.0.0
git push origin v1.0.0
# Triggers build for Windows + Mac
# Creates draft release with artifacts
```

### Vercel Deployment
- Auto-deploys on push to main
- API endpoints at: https://pcnestspeaker.app/api/*

---

## URLs & Endpoints

| Purpose | URL |
|---------|-----|
| Website | https://pcnestspeaker.app |
| Buy License | TBD (Stripe Payment Link) |
| Validate License | https://pcnestspeaker.app/api/validate-license |
| Stripe Webhook | https://pcnestspeaker.app/api/stripe-webhook |
| GitHub Repo | https://github.com/Kepners/pcnestspeaker |

---

## Troubleshooting

### "No speakers found"
1. Ensure PC and Nest are on same Wi-Fi network
2. Check firewall allows app through (both TCP/UDP)
3. Verify Nest speaker is powered on
4. Try restarting the app

### "No audio captured"
1. Verify VB-CABLE is installed
2. Set Windows output to "CABLE Input"
3. Check audio is playing from some source
4. Try Voicemeeter as alternative

### "Stream stutters or drops"
1. Reduce Wi-Fi interference
2. Try MP3 protocol instead of HLS
3. Check network bandwidth
4. Ensure no VPN is active

### "License not valid"
1. Check internet connection
2. Verify license key format (PNS-XXXX-XXXX-XXXX-XXXX)
3. Ensure Stripe customer has `license_key` in metadata

### Build Issues (Windows)
- Add `dist/` folder to Windows Defender exclusions
- PowerShell (Admin): `Add-MpPreference -ExclusionPath "path\to\dist"`

---

## Version History

### v1.0.0 (Development)
- Initial Electron app structure
- HLS streaming with MP3 fallback
- Speaker discovery and selection
- Stripe license integration
- Warm Neutral UI design

---

## Original Python Reference

This Electron app is a port of the original Python implementation found at:
`C:\Users\kepne\OneDrive\Documents\#NestAudioBridge`

Key files from original:
- `cast_system_audio_to_nest_improved_FIXED.py` - HLS implementation
- `cast_system_audio_to_nest_mp3_FIXED.py` - MP3 implementation
- `cast_system_audio_to_nest_v2.py` - Dual protocol with fallback
