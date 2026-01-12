# TV Casting System Documentation

*Last Updated: January 12, 2025*

---

## Overview

PC Nest Speaker supports streaming to TVs, NVIDIA Shields, and Chromecast devices with displays. Unlike Nest speakers (which use WebRTC), these devices use **HLS (HTTP Live Streaming)** because Cast receivers on TVs don't support WebRTC.

---

## The Key Difference: Speakers vs TVs

```
Speakers (Nest Mini, Nest Audio):
├── Protocol: WebRTC (ultra-low latency)
├── Codec: Opus (voice-optimized)
├── Receiver: Custom Audio Receiver (4B876246)
└── Latency: ~160ms

TVs (Chromecast, Shield, Smart TVs):
├── Protocol: HLS (HTTP Live Streaming)
├── Codec: AAC (widely compatible)
├── Receiver: Visual Receiver (FCAA4619) or Default Media Receiver (CC1AD845)
└── Latency: ~3-5 seconds
```

---

## Device Detection

When a device is discovered, its `cast_type` determines the streaming method:

| cast_type | Devices | Streaming |
|-----------|---------|-----------|
| `audio` | Nest Mini, Nest Audio, Nest Hub (speakers only) | WebRTC |
| `group` | Cast Groups, Stereo Pairs | WebRTC multicast |
| `cast` | Chromecast, NVIDIA Shield, Smart TVs | HLS |

**Code** (electron-main.js):
```javascript
const isTv = speaker && speaker.cast_type === 'cast';
```

---

## Cast Receivers

### Visual Receiver (FCAA4619)
- **Purpose**: Displays ambient videos behind the audio visualizer
- **Features**: George Lucas wipe transitions, multiple video themes
- **Use when**: User wants visual experience on TV
- **Hosted**: GitHub Pages (`docs/receiver.html`)

### Default Media Receiver (CC1AD845)
- **Purpose**: Google's built-in receiver for basic HLS playback
- **Features**: None (just plays audio)
- **Use when**: Visual receiver fails or user disables TV visuals

### Audio Receiver (4B876246)
- **Purpose**: Lean audio-only receiver for speakers
- **NOT used for TVs** - WebRTC doesn't work on TV Cast apps

---

## Architecture: HLS Streaming Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           TV STREAMING FLOW                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Windows Audio                                                           │
│       │                                                                  │
│       ▼                                                                  │
│  ┌──────────────────┐                                                   │
│  │  VB-Cable Input  │  (Windows default output)                        │
│  └────────┬─────────┘                                                   │
│           │                                                              │
│           ▼                                                              │
│  ┌──────────────────┐    DirectShow capture                             │
│  │  VB-Cable Output │────────────────────────┐                          │
│  └──────────────────┘                        │                          │
│                                               │                          │
│                                               ▼                          │
│                             ┌─────────────────────────────────────┐     │
│                             │              FFmpeg                  │     │
│                             │  - Input: VB-Cable Output (dshow)   │     │
│                             │  - Codec: AAC 128kbps               │     │
│                             │  - Output: HLS direct to disk       │     │
│                             │  - Segments: 2s, keep 5             │     │
│                             └────────────────┬────────────────────┘     │
│                                               │                          │
│                                               ▼                          │
│                             ┌─────────────────────────────────────┐     │
│                             │      %TEMP%/pcnestspeaker-hls/      │     │
│                             │  ├── stream.m3u8 (playlist)         │     │
│                             │  ├── segment000.ts                  │     │
│                             │  ├── segment001.ts                  │     │
│                             │  └── segment002.ts ...              │     │
│                             └────────────────┬────────────────────┘     │
│                                               │                          │
│                                               ▼                          │
│                             ┌─────────────────────────────────────┐     │
│                             │     HLS Direct Server (port 8890)   │     │
│                             │     Serves files over HTTP          │     │
│                             └────────────────┬────────────────────┘     │
│                                               │                          │
│                                               ▼                          │
│       ┌───────────────────────────────────────────────────────┐         │
│       │               http://<local-ip>:8890/stream.m3u8       │         │
│       └───────────────────────────────┬───────────────────────┘         │
│                                        │                                 │
│                     ┌──────────────────┴──────────────────┐             │
│                     │        cast-helper.py hls-cast       │             │
│                     │   Launches Visual/Default receiver   │             │
│                     │   Passes HLS URL to media controller │             │
│                     └──────────────────┬──────────────────┘             │
│                                        │                                 │
│                                        ▼                                 │
│                              ┌─────────────────┐                        │
│                              │   📺 TV/Shield   │                        │
│                              │  (plays audio)  │                        │
│                              └─────────────────┘                        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Why Direct HLS (Bypassing MediaMTX)?

MediaMTX's Low-Latency HLS requires **7 segments** before playback starts. This causes:
- 14+ seconds initial delay
- Complex segment management

**Our Solution**: FFmpeg writes HLS directly to a temp folder, served by our own HTTP server.

| Component | MediaMTX LL-HLS | Direct HLS |
|-----------|-----------------|------------|
| Initial delay | ~14 seconds | ~4 seconds |
| Segments required | 7 | 2-3 |
| Server | MediaMTX (port 8888) | Our server (port 8890) |
| Complexity | Higher | Lower |

---

## Key Components

### 1. HLS Direct Server (`hls-direct-server.js`)

Simple HTTP server that serves HLS files from a temp directory.

**Location**: `src/main/hls-direct-server.js`

```javascript
const HLS_DIR = path.join(os.tmpdir(), 'pcnestspeaker-hls');
const DEFAULT_PORT = 8890;
```

**Functions**:
- `start()` - Start server on port 8890
- `stop()` - Stop server and clean up files
- `getHlsUrl(localIp)` - Get URL for TV to play

### 2. FFmpeg HLS Output

FFmpeg encodes audio to HLS directly (not via RTSP→MediaMTX).

**Key flags**:
```
-c:a aac -b:a 128k          # AAC codec, 128kbps
-f hls                       # HLS muxer
-hls_time 2                  # 2-second segments
-hls_list_size 5             # Keep 5 segments in playlist
-hls_flags delete_segments   # Auto-delete old segments
```

### 3. Cast Helper (`cast-helper.py`)

Python script that handles pychromecast communication.

**Command**: `hls-cast <name> <url> [ip] [model] [app_id]`

**Flow**:
1. Connect to TV (by name or IP)
2. Quit any existing app (ensures chime plays)
3. Launch receiver (Visual or Default)
4. Send HLS URL to media controller
5. Wait for playback to start

### 4. Firewall Setup (`firewall-setup.js`)

Automatically opens port 8890 for HLS streaming.

```javascript
{ name: 'PC Nest Speaker HLS TV', ports: '8890', protocol: 'TCP' }
```

---

## The Complete Flow

### 1. User Clicks TV Device

**renderer.js** → `startStreamingToSpeaker()` → IPC `'start-streaming'`

### 2. Main Process Detects TV

**electron-main.js**:
```javascript
const isTv = speaker && speaker.cast_type === 'cast';

if (isTv) {
  // TV streaming path
}
```

### 3. Start HLS Direct Server

```javascript
const hlsServer = hlsDirectServer.start();
// Returns: { success: true, port: 8890, dir: "C:\...\pcnestspeaker-hls" }
```

### 4. Start FFmpeg Direct HLS

FFmpeg captures VB-Cable and outputs HLS to temp directory:

```javascript
const ffmpegArgs = [
  '-f', 'dshow',
  '-i', `audio=${vbCableDevice}`,
  '-c:a', 'aac', '-b:a', '128k',
  '-f', 'hls',
  '-hls_time', '2',
  '-hls_list_size', '5',
  hlsOutputPath  // C:\...\pcnestspeaker-hls\stream.m3u8
];
```

### 5. Wait for Segments

HLS needs time to create initial segments:
```javascript
await new Promise(r => setTimeout(r, 4000)); // 4 seconds
```

### 6. Cast to TV

```javascript
// Choose receiver based on TV visuals setting
const useVisualReceiver = settingsManager.getSetting('tvVisualsEnabled') !== false;
const hlsReceiverAppId = useVisualReceiver ? VISUAL_APP_ID : 'CC1AD845';

// Cast via Python
const args = ['hls-cast', speakerName, hlsUrl, speakerIp, speakerModel, hlsReceiverAppId];
result = await runPython(args);
```

### 7. Python Handles Cast Protocol

**cast-helper.py** → `hls_cast_to_tv()`:
```python
# Quit existing app (plays chime on fresh connect)
cast.quit_app()
time.sleep(0.5)

# Launch receiver
cast.start_app(receiver_id)  # FCAA4619 or CC1AD845
time.sleep(3)

# Send HLS URL
mc = cast.media_controller
mc.play_media(
    hls_url,
    "application/x-mpegURL",  # HLS MIME type
    stream_type="LIVE",
    autoplay=True
)
mc.block_until_active(timeout=30)
```

### 8. TV Plays Audio

TV's Cast receiver fetches HLS playlist, downloads segments, and plays audio.

---

## Visual Receiver Features

When `tvVisualsEnabled` is ON (default), the Visual Receiver provides:

### Ambient Videos
- Multiple video themes (nature, abstract, space)
- George Lucas wipe transition between videos
- Crossfade effects

### Splash Screen
- Shows app logo on connect
- Fallback if video fails to load
- Professional appearance

### Audio Visualizer
- Waveform display
- Responds to audio levels

**Receiver location**: `docs/receiver.html` (hosted on GitHub Pages)

---

## TV Visuals Toggle

**UI**: Settings → "Show visuals on TV"

**Setting**: `tvVisualsEnabled` (default: true)

**Effect**:
- ON: Uses Visual Receiver (FCAA4619) with ambient videos
- OFF: Uses Default Media Receiver (CC1AD845), black screen

---

## Troubleshooting

### "Port 8890 blocked"
1. App should auto-open port on first run (UAC prompt)
2. Manual: Windows Firewall → Allow port 8890 TCP inbound

### "TV not playing audio"
1. Check HLS segments exist: `%TEMP%\pcnestspeaker-hls\`
2. Check TV logs in Chrome cast debug
3. Try Default Media Receiver (disable TV visuals)

### "14+ second delay"
This means it's using MediaMTX instead of direct HLS:
1. Check logs for "Direct HLS server started on port 8890"
2. Ensure `hlsDirectServer.start()` is called

### "Visual receiver fails"
Falls back to Default Media Receiver automatically:
```python
if receiver_id != DEFAULT_MEDIA_RECEIVER:
    cast.start_app(DEFAULT_MEDIA_RECEIVER)
```

### "No chime on connect"
We now ensure chime by quitting app before starting:
```python
cast.quit_app()
time.sleep(0.5)
cast.start_app(receiver_id)
```

---

## Device Comparison: Speakers vs TVs

| Feature | Speakers (WebRTC) | TVs (HLS) |
|---------|-------------------|-----------|
| Latency | ~160ms | ~3-5 seconds |
| Codec | Opus | AAC |
| Protocol | WebRTC | HLS |
| Server | MediaMTX | Direct HLS |
| Port | 8889 | 8890 |
| PC Speaker Sync | Yes (APO delay) | Not needed (too much latency) |
| Volume Sync | Yes | Yes |
| Visual Receiver | Audio-only | Ambient videos |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/main/hls-direct-server.js` | HTTP server for HLS files |
| `src/main/electron-main.js` | TV detection, FFmpeg launch, Cast coordination |
| `src/main/cast-helper.py` | pychromecast wrapper, `hls_cast_to_tv()` |
| `src/main/firewall-setup.js` | Auto-opens port 8890 |
| `docs/receiver.html` | Visual receiver with ambient videos |
| `src/renderer/renderer.js` | UI, TV visuals toggle |

---

## Latency Breakdown (TV Streaming)

```
Total TV Latency ≈ 3-5 seconds

├── FFmpeg capture + encode:   ~50ms
├── HLS segment creation:      2000ms  (hls_time = 2)
├── HTTP transfer:             ~100ms
├── TV buffering:              1-2 segments (2-4 seconds)
└── Decode + playback:         ~100ms
```

**Note**: TV latency is much higher than speakers. PC speaker sync is not practical for TVs.

---

*End of TV Casting System Documentation*
