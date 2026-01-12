# PC Nest Speaker - System Architecture

A desktop application that streams Windows system audio to Google Nest speakers over Wi-Fi using WebRTC technology.

---

## System Overview

```
+------------------------------------------------------------------------------+
|                              USER'S COMPUTER                                  |
+------------------------------------------------------------------------------+
|                                                                              |
|  +----------------------------------------------------------------------+   |
|  |                     ELECTRON APPLICATION                              |   |
|  |                                                                       |   |
|  |  +--------------------+         +----------------------------------+  |   |
|  |  |   Main Process     |  IPC    |        Renderer Process         |  |   |
|  |  |                    |<------->|                                  |  |   |
|  |  |  * License mgmt    |         |  * UI (index.html)              |  |   |
|  |  |  * FFmpeg control  |         |  * Speaker selection             |  |   |
|  |  |  * MediaMTX        |         |  * Volume controls               |  |   |
|  |  |  * cloudflared     |         |  * Stream monitor                |  |   |
|  |  |  * Python bridge   |         |  * Settings panel                |  |   |
|  |  |  * Audio device    |         |  * License card                  |  |   |
|  |  |  * Windows volume  |         |  * Trial display                 |  |   |
|  |  +--------+-----------+         +----------------------------------+  |   |
|  |           |                                                            |   |
|  +-----------+------------------------------------------------------------+   |
|              |                                                               |
|              v                                                               |
|  +-------------------+  +-------------------+  +-------------------+         |
|  |  MediaMTX         |  |  cloudflared      |  |  Python           |         |
|  |  RTSP->WebRTC     |  |  HTTPS Tunnel     |  |  pychromecast     |         |
|  |  Ports: 8554,     |  |  Dynamic URL      |  |  Cast control     |         |
|  |  8889, 9997       |  |                   |  |                   |         |
|  +-------------------+  +-------------------+  +-------------------+         |
|                                                                              |
+-------------------------------------------------------------------+----------+
                |                                                    |
                | HTTPS                                              | Wi-Fi
                v                                                    v
+-----------------------------------+    +----------------------------------+
|         CLOUD SERVICES            |    |        LOCAL NETWORK             |
+-----------------------------------+    +----------------------------------+
|                                   |    |                                  |
|  +-----------------------------+  |    |  +--------------------------+   |
|  |   VERCEL (Serverless)       |  |    |  |   Google Nest Speakers    |  |
|  |   https://pcnestspeaker.app |  |    |  |                          |   |
|  |                             |  |    |  |  * Custom Cast Receiver  |   |
|  |  /api/validate-license      |  |    |  |  * WebRTC/WHEP playback  |   |
|  |  /api/verify-session        |  |    |  |  * Stereo pair support   |   |
|  +-----------------------------+  |    |  |  * MP3 fallback          |   |
|              |                    |    |  +--------------------------+   |
|              v                    |    |                                  |
|  +-----------------------------+  |    +----------------------------------+
|  |           STRIPE            |  |
|  |                             |  |    +----------------------------------+
|  |  * Payment Links            |  |    |  CLOUDFLARE TUNNEL               |
|  |  * Customer Metadata        |  |    |  *.trycloudflare.com             |
|  |  * License Storage          |  |    |  HTTPS for Cast receiver         |
|  +-----------------------------+  |    +----------------------------------+
|                                   |
+-----------------------------------+
```

---

## Audio Pipeline - WebRTC Mode (Primary)

**Latency:** Sub-1 second (imperceptible)

```
+---------------+     +----------------------+     +---------------+
|  Windows      | --> | virtual-audio-       | --> |    FFmpeg     |
|  System Audio |     | capturer (DirectShow)|     |  Opus Encode  |
|  (All Apps)   |     +----------------------+     +-------+-------+
+---------------+                                          |
                                                          | RTSP
                                                          v
+---------------+     +------------------+     +-------------------+
|  Nest Speaker | <-- |  Custom Cast     | <-- |     MediaMTX      |
|  Audio Output |     |  Receiver (WHEP) |     |   RTSP->WebRTC    |
+---------------+     +--------+---------+     +-------------------+
                               ^
                               | HTTPS
                               |
                      +--------+--------+
                      |   cloudflared   |
                      | HTTPS Tunnel    |
                      +-----------------+
```

### Pipeline Details

| Step | Component | Protocol | Purpose |
|------|-----------|----------|---------|
| 1 | Windows Audio | N/A | Source audio from any app |
| 2 | virtual-audio-capturer | DirectShow | Capture system audio |
| 3 | FFmpeg | Opus 128kbps | Encode audio to Opus |
| 4 | RTSP Stream | TCP :8554 | Send to MediaMTX |
| 5 | MediaMTX | RTSP/WebRTC | Convert RTSP to WebRTC |
| 6 | cloudflared | HTTPS | Secure tunnel for Cast |
| 7 | Cast Receiver | WHEP | Receive WebRTC audio |
| 8 | Nest Speaker | Cast Protocol | Play audio |

---

## Audio Pipeline - HTTP/MP3 Mode (Fallback)

**Latency:** ~8 seconds (Cast buffer limitation)

```
+---------------+     +----------------------+     +---------------+
|  Windows      | --> | virtual-audio-       | --> |    FFmpeg     |
|  System Audio |     | capturer             |     |  MP3 320kbps  |
+---------------+     +----------------------+     +-------+-------+
                                                          |
                                                          | HTTP Pipe
                                                          v
+---------------+     +------------------+     +-------------------+
|  Nest Speaker | <-- |  Default Media   | <-- |   HTTP Server     |
|  Audio Output |     |  Receiver        |     |   Port 8000       |
+---------------+     +------------------+     +-------------------+
```

---

## Stereo Mode Pipeline

Splits audio into two mono channels for separate speakers.

```
                                    +-> FFmpeg (pan=mono|c0=c0) -> RTSP /left  -> MediaMTX -> Left Speaker
                                   /
virtual-audio-capturer -> FFmpeg -+
                                   \
                                    +-> FFmpeg (pan=mono|c0=c1) -> RTSP /right -> MediaMTX -> Right Speaker
```

---

## Component Architecture

### Main Process Modules

```
src/main/
├── electron-main.js        # Main entry point, IPC handlers, process management
├── preload.js              # IPC bridge for renderer
├── audio-streamer.js       # FFmpeg + HTTP server for MP3 fallback
├── chromecast.js           # Node.js Cast discovery (legacy)
├── cast-helper.py          # Python pychromecast control (primary)
├── stream-stats.js         # Real-time streaming statistics
├── settings-manager.js     # JSON settings persistence
├── usage-tracker.js        # Trial time tracking (10 hours)
├── tray-manager.js         # System tray icon and menu
├── auto-start-manager.js   # Windows startup registration
├── audio-device-manager.js # Windows audio device switching
├── audio-routing.js        # VB-Cable, device save/restore, "Listen to this device"
├── audio-sync-manager.js   # APO delay manager (writes pcnestspeaker-sync.txt)
├── auto-sync-manager.js    # Network RTT monitoring, auto-adjusts delay
├── pc-speaker-delay.js     # Direct APO config writer
├── windows-volume-sync.js  # PC volume keys -> Nest + PC speaker sync
├── daemon-manager.js       # Python daemon for fast volume
└── firewall-setup.js       # Windows firewall rules
```

### Renderer Process

```
src/renderer/
├── index.html            # Main UI structure
├── styles.css            # DMT-style CSS (Coolors palette)
├── renderer.js           # UI logic and IPC communication
└── webrtc-client.js      # WebRTC signaling (testing)
```

### External Dependencies

```
mediamtx/
├── mediamtx.exe          # MediaMTX v1.15.6 Windows binary
└── mediamtx-audio.yml    # Audio-optimized WebRTC config

ffmpeg/
└── ffmpeg.exe            # FFmpeg binary (bundled)

cast-receiver/
└── receiver.html         # Custom Cast receiver (WHEP)

docs/
└── receiver.html         # GitHub Pages deployment
```

---

## IPC Communication Flow

### Main -> Renderer Events

| Event | Data | Purpose |
|-------|------|---------|
| `speakers-found` | `[{name, model, ip}]` | Discovery results |
| `stream-started` | `{mode, tunnelUrl}` | Streaming active |
| `stream-stopped` | - | Streaming ended |
| `stream-error` | `{message}` | Error occurred |
| `stream-stats` | `{bitrate, data, levels}` | Monitor updates |
| `settings-loaded` | `{settings}` | Initial settings |
| `license-status` | `{key, valid}` | License state |
| `usage-update` | `{used, remaining}` | Trial time |
| `volume-synced` | `{volume}` | Windows volume changed |
| `auto-connect` | `{speaker}` | Trigger auto-connect |
| `tray-stop` | - | Tray menu stop clicked |

### Renderer -> Main Requests

| Request | Data | Purpose |
|---------|------|---------|
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

## Port Usage

| Port | Service | Protocol | Purpose |
|------|---------|----------|---------|
| 8000 | HTTP Server | TCP | MP3 fallback streaming |
| 8554 | MediaMTX RTSP | TCP | FFmpeg input |
| 8889 | MediaMTX WebRTC | TCP | WHEP output |
| 9997 | MediaMTX API | HTTP | Health/status |
| Dynamic | cloudflared | HTTPS | Cast receiver tunnel |

---

## Data Storage

### Settings (`%APPDATA%/pc-nest-speaker/settings.json`)

```json
{
  "lastSpeaker": { "name": "Den pair", "model": "Google Cast Group" },
  "autoConnect": true,
  "autoStart": false,
  "volumeBoost": false,
  "usageSeconds": 12345,
  "trialExpired": false,
  "licenseKey": null
}
```

### License (`%APPDATA%/pc-nest-speaker/license.json`)

```json
{
  "licenseKey": "PNS-XXXX-XXXX-XXXX-XXXX",
  "activatedAt": "2026-01-07T12:00:00.000Z"
}
```

---

## Startup Sequence

```
App Start
    |
    v
+---------------------------+
| 1. Load settings          |
|    - Read settings.json   |
|    - Read license.json    |
+---------------------------+
    |
    v
+---------------------------+
| 2. Initialize tray icon   |
|    - Create system tray   |
|    - Set idle state       |
+---------------------------+
    |
    v
+---------------------------+
| 3. Create main window     |
|    - Load index.html      |
|    - Send settings        |
+---------------------------+
    |
    v
+---------------------------+
| 4. Start MediaMTX         |
|    - Spawn process        |
|    - Wait for ready       |
+---------------------------+
    |
    v
+---------------------------+
| 5. Start cloudflared      |
|    - Create HTTPS tunnel  |
|    - Get tunnel URL       |
+---------------------------+
    |
    v
+---------------------------+
| 6. Discover speakers      |
|    - Python pychromecast  |
|    - Send to renderer     |
+---------------------------+
    |
    v
+---------------------------+
| 7. Auto-connect (if set)  |
|    - Wait 5 seconds       |
|    - Connect to last      |
+---------------------------+
```

---

## Shutdown Sequence

```
App Close / Window Close
         |
         v
+---------------------------+
| 1. Stop streaming         |
|    - Stop FFmpeg          |
|    - Stop Cast playback   |
+---------------------------+
         |
         v
+---------------------------+
| 2. Restore audio device   |
|    - Switch back to       |
|      original output      |
+---------------------------+
         |
         v
+---------------------------+
| 3. Stop MediaMTX          |
|    - Kill process         |
|    - Release ports        |
+---------------------------+
         |
         v
+---------------------------+
| 4. Stop cloudflared       |
|    - Kill tunnel process  |
+---------------------------+
         |
         v
+---------------------------+
| 5. Stop HTTP server       |
|    - Release port 8000    |
+---------------------------+
         |
         v
+---------------------------+
| 6. Save settings          |
|    - Usage time           |
|    - Last speaker         |
+---------------------------+
         |
         v
       Exit
```

---

## Cast Receiver Architecture

### Custom Receiver (FCAA4619)

Hosted at: `https://kepners.github.io/pcnestspeaker/receiver.html`

```javascript
// WHEP Protocol Implementation
1. Create RTCPeerConnection
2. Add audio track
3. Create SDP offer
4. POST offer to MediaMTX /pcaudio/whep
5. Receive SDP answer
6. Set remote description
7. Audio streams to speaker

// Message Handling
- Namespace: urn:x-cast:com.pcnestspeaker.webrtc
- Receives: { type: 'OFFER', tunnelUrl: 'https://...' }
- Responds: { type: 'CONNECTED' } or { type: 'ERROR' }
```

---

## License Validation Flow

```
User Enters Key
       |
       v
+-------------------+
| Format Check      |
| ^PNS-[A-Z0-9]{4}- |
| [A-Z0-9]{4}-...   |
+-------------------+
       |
       v
+-------------------+
| API Validation    |
| POST /api/        |
| validate-license  |
+-------------------+
       |
       v
+-------------------+
| Stripe Search     |
| metadata[license] |
+-------------------+
       |
       +-> Valid: Save locally, activate
       |
       +-> Invalid: Show error
       |
       +-> Offline: Check local cache
```

---

## Windows Integration

### Auto Audio Device Switching

```
Stream Start:
1. Get current audio device (WMIC)
2. Save to memory
3. Switch to virtual-audio-capturer (NirCmd)
4. Start streaming

Stream Stop:
1. Stop streaming
2. Restore original device (NirCmd)
```

### Windows Volume Sync

```
PC Volume Keys Pressed:
1. PowerShell polls Windows volume (500ms interval via Core Audio API)
2. Volume change detected (with 200ms debounce)
3. Set Nest speaker volume (via Python pychromecast)
4. Set PC speaker volume (via SoundVolumeView)
```

**Implementation** (`windows-volume-sync.js`):
- Uses PowerShell with embedded C# to access IAudioEndpointVolume
- Polls every 500ms (CHECK_INTERVAL not 1s)
- `DEBOUNCE_MS = 200` prevents spam during rapid changes
- `setDeviceVolume()` uses NirSoft SoundVolumeView for per-device control
- `setPCSpeakerVolume()` sets the same volume on PC speakers when "PC + Speakers" mode active

### Auto-Start with Windows

```
Registry Key:
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
Name: PCNestSpeaker
Value: "path\to\electron.exe" "path\to\app"
```

---

## Audio Sync System ("PC + Speakers" Mode)

Allows PC speakers and Nest to play in sync by delaying PC audio to match Nest latency.

### Architecture

```
                                  +------------------+
                                  |  Equalizer APO   |
                                  |  (Windows VST)   |
        +------------+            +--------+---------+
        | PC Speakers| <-- Delay --|       |
        +------------+            |  pcnestspeaker-sync.txt
                                  |  "Delay: 150 ms"
                                  +------------------+
                                            ^
                                            |
+------------------+  +------------------+  |  +------------------+
|  auto-sync-      |->|  audio-sync-     |--+  |  pc-speaker-     |
|  manager.js      |  |  manager.js      |     |  delay.js        |
|                  |  |                  |     |                  |
|  * Ping RTT      |  |  * Main manager  |     |  * APO writer    |
|  * Every 500ms   |  |  * currentDelayMs|     |  * Config format |
|  * Baseline adj  |  |  * setDelay()    |     +------------------+
+------------------+  +------------------+
```

### Config File Location

```
C:\Program Files\EqualizerAPO\config\
├── config.txt                # Main APO config (includes our file)
└── pcnestspeaker-sync.txt    # Our delay: "Delay: 150 ms" or "Delay: 0 ms"
```

### Auto-Sync Algorithm

```
1. User calibrates "perfect" sync → saves baseline (delay + RTT)
2. Every 500ms, ping speaker to measure current RTT
3. If RTT drift > 10ms threshold:
   newDelay = baselineDelay + (currentRTT - baselineRTT)
4. Write new delay to APO config
```

### Key Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `CHECK_INTERVAL_MS` | 500 | Ping frequency (0.5s) |
| `ADJUSTMENT_THRESHOLD_MS` | 10 | Min drift to adjust |
| `MIN_DELAY_MS` | 0 | Allows zero delay |
| `MAX_DELAY_MS` | 2000 | 2 second cap |

### VB-Cable Routing for PC + Speakers

```
Windows Default → VB-CABLE Input (render) → FFmpeg captures
                        ↓
                  VB-CABLE Output (capture)
                        ↓
               "Listen to this device" enabled
                        ↓
                  PC Speakers (with APO delay)
```

**Tool**: `audioctl.exe` (WindowsAudioControl-CLI) toggles "Listen to this device"

---

## Low-Latency FFmpeg Configuration

Critical flags for sub-1-second latency:

### Input Flags (DirectShow)
```
-fflags nobuffer          # Don't buffer input
-flags low_delay          # Low delay mode
-probesize 32             # Minimal probing
-analyzeduration 0        # No analysis delay
-rtbufsize 64k            # Small real-time buffer
-audio_buffer_size 50     # DirectShow: 50ms (DEFAULT IS 500ms!)
```

### Output Flags
```
-flush_packets 1          # Flush immediately
-max_delay 0              # No muxer delay
-muxdelay 0               # No mux delay
```

### Opus Encoder
```
-application lowdelay     # Opus low-delay mode
-frame_duration 20        # 20ms frames (balanced)
```

### MediaMTX Config (`mediamtx-audio.yml`)
```yaml
writeQueueSize: 64        # Reduced from 512
```

### Cast Receiver (`receiver.html`)
```javascript
event.receiver.jitterBufferTarget = 50; // 50ms buffer
```

**CRITICAL**: `-audio_buffer_size 50` is THE biggest latency win. Default is ~500ms!

---

## Security Considerations

- License validated server-side via Stripe
- Stripe webhook signatures verified
- No secrets in client-side code
- Environment variables for credentials
- Local HTTP server on 0.0.0.0 (firewall protected)
- HTTPS tunnel for Cast receiver communication

---

## Design System

### DMT-Style Colors (Coolors Palette)

| Name | Hex | Usage |
|------|-----|-------|
| Jet | #2E2E2E | Primary background |
| Dim Grey | #6B6D76 | Secondary text, borders |
| Powder Blush | #FCBFB7 | Accent, CTAs |
| Buff | #D9A566 | Highlights |
| Deep Taupe | #7A6062 | Cards, sections |
| Gunmetal | #263238 | Dark backgrounds |

---

*Last Updated: January 12, 2025*
