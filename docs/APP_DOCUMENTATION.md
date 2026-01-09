# PC Nest Speaker - Complete Documentation

## Overview

**PC Nest Speaker** is a desktop application that streams Windows system audio to Google Nest speakers over Wi-Fi with sub-second latency using WebRTC technology.

| Item | Value |
|------|-------|
| **Version** | 1.0.0 |
| **Developer** | ChoppedOnions.xyz |
| **Platform** | Windows (macOS planned) |
| **Cast App ID** | FCAA4619 |
| **License Format** | PNS-XXXX-XXXX-XXXX-XXXX |

---

## Features

### Core Streaming

| Feature | Description |
|---------|-------------|
| **WebRTC Streaming** | Sub-second latency via MediaMTX + custom Cast receiver |
| **HTTP/MP3 Fallback** | ~8 second latency for older devices |
| **System Audio Capture** | Captures all PC audio via virtual-audio-capturer |
| **Stereo Mode** | Split L/R channels to separate speakers |
| **Volume Boost** | +25% signal boost toggle (3% always-on hidden boost) |

### Speaker Management

| Feature | Description |
|---------|-------------|
| **Auto-Discovery** | Finds all Nest/Cast devices on network via mDNS |
| **Stereo Pairs** | Full support for Cast speaker groups |
| **Volume Control** | Adjust speaker volume from app (syncs with Windows) |
| **Speaker Memory** | Remembers last selected speaker |

### Windows Integration

| Feature | Description |
|---------|-------------|
| **Auto Audio Switch** | Automatically switches to virtual audio device when streaming |
| **Auto Restore** | Restores original audio device when stopping |
| **Windows Volume Sync** | PC volume keys control Nest speaker volume |
| **Auto-Start** | Launch with Windows boot |
| **Auto-Connect** | Connect to last speaker on startup |
| **System Tray** | Minimize to tray, tray menu controls |

### Stream Monitor

| Feature | Description |
|---------|-------------|
| **Audio Visualizer** | 8-bar animated visualizer showing stream activity |
| **Bitrate Display** | Real-time bitrate from FFmpeg |
| **Data Counter** | Total MB streamed |
| **Connection Status** | Active/Inactive indicator |

### Licensing

| Feature | Description |
|---------|-------------|
| **10-Hour Trial** | Free trial tracks streaming time only |
| **One-Time Purchase** | Lifetime license, no subscription |
| **2 Device Limit** | License works on 2 computers |
| **Stripe Integration** | Payment Links, Customer Metadata storage |
| **Offline Mode** | Works offline after initial activation |

---

## Technical Architecture

### Audio Pipeline (WebRTC Mode)

```
Windows Audio Output
        |
        v
virtual-audio-capturer (DirectShow device)
        |
        v
FFmpeg (Opus encoding, RTSP output)
        |
        v
MediaMTX (RTSP to WebRTC bridge)
        |
        v
Local HTTP (port 8889)
        |
        v
Custom Cast Receiver (WHEP protocol)
        |
        v
Google Nest Speaker
```

### Audio Pipeline (HTTP/MP3 Mode)

```
Windows Audio Output
        |
        v
virtual-audio-capturer
        |
        v
FFmpeg (MP3 encoding, 320kbps)
        |
        v
HTTP Server (port 8000)
        |
        v
pychromecast (Default Media Receiver)
        |
        v
Google Nest Speaker
```

### Key Components

| Component | Purpose | Port |
|-----------|---------|------|
| MediaMTX | RTSP to WebRTC bridge | 8554 (RTSP), 8889 (WHEP), 9997 (API) |
| FFmpeg | Audio capture & encoding | N/A |
| Local HTTP | WebRTC WHEP endpoint | 8889 |
| HTTP Server | MP3 streaming fallback | 8000 |
| Python cast-helper | Chromecast control | N/A |

---

## File Structure

```
pcnestspeaker/
├── src/
│   ├── main/
│   │   ├── electron-main.js      # Main Electron process
│   │   ├── preload.js            # IPC bridge
│   │   ├── audio-streamer.js     # FFmpeg + HTTP streaming
│   │   ├── cast-helper.py        # Python pychromecast control
│   │   ├── stream-stats.js       # Stream monitor stats
│   │   ├── settings-manager.js   # JSON settings persistence
│   │   ├── usage-tracker.js      # Trial time tracking
│   │   ├── tray-manager.js       # System tray icon
│   │   ├── auto-start-manager.js # Windows startup
│   │   ├── audio-device-manager.js # Audio device switching
│   │   ├── windows-volume-sync.js  # Volume key sync
│   │   ├── firewall-setup.js     # Auto firewall rules
│   │   ├── daemon-manager.js     # Python daemon for fast volume
│   │   └── chromecast.js         # Node.js Cast client
│   └── renderer/
│       ├── index.html            # UI
│       ├── styles.css            # DMT-style theme
│       ├── renderer.js           # UI logic
│       └── webrtc-client.js      # WebRTC signaling
├── mediamtx/
│   ├── mediamtx.exe              # MediaMTX v1.15.6
│   └── mediamtx-audio.yml        # Audio-optimized config
├── cast-receiver/
│   └── receiver.html             # Custom Cast receiver (WHEP)
├── docs/
│   ├── receiver.html             # GitHub Pages deployment
│   ├── ARCHITECTURE.md           # System architecture
│   └── APP_DOCUMENTATION.md      # This file
├── ffmpeg/
│   └── ffmpeg.exe                # Bundled FFmpeg
├── audioctl/
│   └── audioctl.exe              # WindowsAudioControl-CLI (Listen to device)
├── svcl/
│   └── svcl.exe                  # NirSoft SoundVolumeCommandLine (device switching)
├── nircmd/
│   └── nircmd.exe                # NirCmd (audio commands)
├── assets/
│   ├── icon.ico                  # Windows icon
│   ├── icon.icns                 # macOS icon
│   ├── splash.mp4                # Splash video
│   └── tray-icon.png             # Tray icon
├── reference/python/             # Original Python implementations
├── package.json                  # Dependencies & build config
├── start-app.bat                 # Launch script
└── README.md                     # Quick start guide
```

---

## Configuration

### Settings (settings.json)

Stored in `%APPDATA%/pc-nest-speaker/settings.json`:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `lastSpeaker` | object | null | Last selected speaker |
| `autoConnect` | boolean | false | Auto-connect on startup |
| `autoStart` | boolean | false | Start with Windows |
| `volumeBoost` | boolean | false | +25% volume boost |
| `usageSeconds` | number | 0 | Trial time used |
| `trialExpired` | boolean | false | Trial limit reached |
| `licenseKey` | string | null | Activated license |

### License (license.json)

Stored in `%APPDATA%/pc-nest-speaker/license.json`:

```json
{
  "licenseKey": "PNS-XXXX-XXXX-XXXX-XXXX",
  "activatedAt": "2026-01-07T..."
}
```

### MediaMTX Config (mediamtx-audio.yml)

```yaml
rtsp: yes
rtspAddress: :8554
webrtc: yes
webrtcAddress: :8889
api: yes
apiAddress: :9997
paths:
  pcaudio:
    source: publisher
  left:
    source: publisher
  right:
    source: publisher
```

---

## IPC Communication

### Main -> Renderer

| Channel | Data | Description |
|---------|------|-------------|
| `speakers-found` | `[{name, model, ip}]` | Discovered speakers |
| `stream-started` | `{mode, url}` | Stream active |
| `stream-stopped` | - | Stream ended |
| `stream-error` | `{message}` | Error occurred |
| `stream-stats` | `{bitrate, data, levels}` | Monitor stats |
| `settings-loaded` | `{settings}` | Initial settings |
| `license-status` | `{key, valid}` | License state |
| `usage-update` | `{used, remaining}` | Trial time |
| `volume-synced` | `{volume}` | Windows volume changed |
| `auto-connect` | `{speaker}` | Trigger auto-connect |
| `tray-stop` | - | Tray menu stop clicked |

### Renderer -> Main

| Channel | Data | Description |
|---------|------|-------------|
| `discover-speakers` | - | Scan network |
| `start-streaming` | `{speaker}` | Begin WebRTC stream |
| `stop-streaming` | - | End stream |
| `start-stereo-streaming` | `{left, right}` | Stereo mode |
| `stop-stereo-streaming` | - | End stereo |
| `get-volume` | `{speaker}` | Get speaker volume |
| `set-volume` | `{speaker, volume}` | Set speaker volume |
| `activate-license` | `{key}` | Activate license |
| `deactivate-license` | - | Remove license |
| `get-license` | - | Get current license |
| `get-usage` | - | Get trial stats |
| `update-settings` | `{settings}` | Save settings |
| `get-settings` | - | Load settings |
| `toggle-auto-start` | - | Toggle Windows startup |

---

## Streaming Modes

### WebRTC Mode (Default)

- **Latency**: Sub-1 second
- **Codec**: Opus 128kbps
- **Transport**: WebRTC via WHEP protocol (local HTTP)
- **Devices**: Requires custom Cast receiver support
- **Endpoint**: `http://<local-ip>:8889/pcaudio/whep`

### HTTP/MP3 Mode (Fallback)

- **Latency**: ~8 seconds (due to Cast buffer)
- **Codec**: MP3 320kbps
- **Transport**: Progressive HTTP streaming
- **Devices**: Works on ALL Cast devices
- **Server**: Local HTTP on port 8000

### Stereo Mode

- **Left Channel**: `rtsp://localhost:8554/left`
- **Right Channel**: `rtsp://localhost:8554/right`
- **FFmpeg Filter**: `pan=mono|c0=c0` (left), `pan=mono|c0=c1` (right)
- **Speakers**: Two separate Cast devices

---

## Device Compatibility

### WebRTC Mode (Custom Receiver)

| Device | Status | Notes |
|--------|--------|-------|
| Google Nest Hub | Working | cast_type: "cast" |
| NVIDIA SHIELD | Working | cast_type: "cast" |
| Google Nest Mini | Working* | Firmware dependent |
| Cast Groups | Working | cast_type: "group" |
| Chromecast | Working | cast_type: "cast" |

*Some older Nest Mini units may not support custom receivers.

### HTTP/MP3 Mode (All Devices)

Works on ALL Google Cast devices including:
- All Nest speakers (Mini, Audio, Hub, Max)
- Chromecast (all generations)
- Cast-enabled TVs
- Speaker groups
- Older firmware devices

---

## Troubleshooting

### "No speakers found"

1. Ensure PC and Nest on same Wi-Fi network
2. Check firewall allows app (ports 8000, 8554, 8889, 9997)
3. Restart the app
4. Try restarting Nest speaker

### "No audio on speaker"

1. Verify audio is playing on PC
2. Check virtual-audio-capturer is installed
3. Check Windows audio output isn't muted
4. Try HTTP/MP3 mode (click speaker multiple times)

### "WebRTC not working on specific speaker"

- Speaker may have old firmware
- Use HTTP/MP3 fallback (multiple clicks selects fallback)
- Speaker groups work better than individual Nest Minis

### "Trial expired"

- Purchase license at pcnestspeaker.app
- Enter license key in app
- License unlocks unlimited streaming

### "CMD window flashes"

- All processes should be hidden with `windowsHide: true`
- Update to latest version
- File a bug report if persists

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Volume Up/Down | Adjusts Nest speaker volume (when streaming) |
| Mute | Mutes Nest speaker |

---

## Requirements

### System

- Windows 10/11 (64-bit)
- 4GB RAM minimum
- Wi-Fi network connection

### Dependencies (Bundled)

| Tool | Version | Purpose | Source |
|------|---------|---------|--------|
| **FFmpeg** | 6.x | Audio capture & Opus/MP3 encoding | ffmpeg.org |
| **MediaMTX** | 1.15.6 | RTSP to WebRTC (WHEP) bridge | github.com/bluenviron/mediamtx |
| **audioctl.exe** | 1.4.3.2 | "Listen to this device" control | [WindowsAudioControl-CLI](https://github.com/Mr5niper/WindowsAudioControl-CLI-wGUI) |
| **svcl.exe** | 1.x | Audio device switching | [NirSoft SoundVolumeCommandLine](https://www.nirsoft.net/utils/sound_volume_command_line.html) |
| **nircmd.exe** | 2.x | Additional audio commands | [NirSoft NirCmd](https://www.nirsoft.net/utils/nircmd.html) |
| **Python** | 3.x | pychromecast for Cast control | python.org |

### Audio Control Utilities

| Utility | Command Example | Purpose |
|---------|-----------------|---------|
| **audioctl** | `audioctl listen --name "Virtual Desktop Audio" --enable` | Enable/disable "Listen to this device" |
| **svcl** | `svcl /SetDefault "Speakers" all` | Switch Windows default audio device |
| **nircmd** | `nircmd setdefaultsounddevice "Speakers" 1` | Alternative device switching |

### Dependencies (Auto-installed)

- virtual-audio-capturer (screen-capture-recorder)

---

## Version History

### v1.0.0 (January 2026)

**Core Features:**
- WebRTC streaming with sub-second latency
- HTTP/MP3 fallback for compatibility
- Custom Cast receiver (App ID: FCAA4619)
- MediaMTX for RTSP-to-WebRTC bridge
- Stereo mode (split L/R channels)

**Windows Integration:**
- Auto audio device switching
- Windows volume keys sync to Nest
- Auto-start on Windows boot
- Auto-connect to last speaker
- System tray icon with controls

**UI/UX:**
- DMT-style design (Coolors palette)
- 8-bar audio visualizer
- Stream stats (bitrate, data, connection)
- Collapsible license section
- Splash screen

**Licensing:**
- 10-hour free trial (streaming time only)
- Stripe Payment Links
- License validation API
- Offline mode after activation

---

## Credits

- **FFmpeg**: Audio capture & encoding
- **MediaMTX**: WebRTC streaming server (bluenviron)
- **pychromecast**: Google Cast control
- **Electron**: Desktop framework
- **audioctl**: WindowsAudioControl-CLI for "Listen to this device" (Mr5niper)
- **svcl**: SoundVolumeCommandLine (NirSoft)
- **nircmd**: NirCmd utility (NirSoft)

---

## Support

- **GitHub Issues**: https://github.com/Kepners/pcnestspeaker/issues
- **Website**: https://pcnestspeaker.app
- **Email**: support@choppedonions.xyz

---

*Last Updated: January 9, 2026*
