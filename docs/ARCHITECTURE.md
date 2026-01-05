# PC Nest Speaker - Architecture

A desktop application that streams Windows system audio to Google Nest speakers over Wi-Fi.

---

## System Overview Diagram

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
|  |  |  * License mgmt    |         |  * UI (app.html)                 |  |   |
|  |  |  * FFmpeg control  |         |  * Speaker selection             |  |   |
|  |  |  * Chromecast API  |         |  * Volume controls               |  |   |
|  |  |  * Stream server   |         |  * Status display                |  |   |
|  |  |  * IPC handlers    |         |  * Settings panel                |  |   |
|  |  +--------+-----------+         +----------------------------------+  |   |
|  |           |                                                            |   |
|  +-----------+------------------------------------------------------------+   |
|              |                                                               |
|              v                                                               |
|  +----------------------+    +----------------------+    +----------------+ |
|  |  license.json        |    |  settings.json       |    |  HTTP Server   | |
|  |  (AppData)           |    |  (preferences)       |    |  (Port 8000)   | |
|  +----------------------+    +----------------------+    +--------+-------+ |
|                                                                   |         |
+-------------------------------------------------------------------+---------+
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
|  |                             |  |    |  |  * Cast protocol         |   |
|  |  /api/validate-license      |  |    |  |  * HLS/MP3 playback      |   |
|  |  /api/stripe-webhook        |  |    |  |  * Stereo pair support   |   |
|  |                             |  |    |  |                          |   |
|  +-------------+---------------+  |    |  +--------------------------+   |
|                |                  |    |                                  |
|                v                  |    +----------------------------------+
|  +-----------------------------+  |
|  |           STRIPE            |  |
|  |                             |  |
|  |  * Payment Links            |  |
|  |  * Customer Metadata        |  |
|  |  * Webhooks                 |  |
|  +-----------------------------+  |
|                                   |
+-----------------------------------+
```

---

## Audio Pipeline - Three Streaming Modes

The app supports **three streaming modes** to accommodate different setups and latency requirements:

### Mode 1: HTTP MP3 Streaming (Most Reliable)

```
+---------------+     +------------------+     +---------------+     +------------+
|  System Audio | --> |    VB-CABLE      | --> |    FFmpeg     | --> | HTTP Server|
|  (All Apps)   |     | (Virtual Audio)  |     |   MP3 Encode  |     | Port 8000  |
+---------------+     +------------------+     +---------------+     +-----+------+
                                                                          |
                        Wi-Fi Network (same subnet)                       |
                                                                          v
+---------------+     +------------------+     +---------------+     +------------+
| Nest Speaker  | <-- |   Cast Protocol  | <-- | MP3 URL       | <-- | pychromecast|
| Audio Output  |     |   (mDNS/HTTP)    |     | Streaming     |     |  Library   |
+---------------+     +------------------+     +---------------+     +------------+
```

**Latency:** ~8 seconds | **Reliability:** Excellent | **Setup:** Medium (requires VB-CABLE as audio output)

---

### Mode 2: WebRTC with System Audio Capture (Low Latency)

```
+---------------+     +----------------------+     +------------------+
|  System Audio | --> | screen-capture-      | --> | webrtc-streamer  |
|  (All Apps)   |     | recorder             |     | (audiocap://1)   |
+---------------+     | (virtual-audio-      |     +--------+---------+
                      |  capturer)           |              |
                      +----------------------+              | WebRTC
                                                           v
+---------------+     +------------------+     +------------------------+
| Nest Speaker  | <-- |   Cast Protocol  | <-- | Custom Cast Receiver   |
| Audio Output  |     |   (mDNS/HTTP)    |     | (WebRTC → Audio)       |
+---------------+     +------------------+     +------------------------+
```

**Latency:** <1 second | **Reliability:** Good | **Setup:** Auto (dependencies installed automatically)

---

### Mode 3: WebRTC with VB-CABLE (Low Latency, Manual Routing)

```
+---------------+     +------------------+     +------------------+
|  System Audio | --> |    VB-CABLE      | --> | webrtc-streamer  |
| (User routes  |     | (User sets as    |     | (audiocap://3)   |
|  audio here)  |     |  output device)  |     +--------+---------+
+---------------+     +------------------+              |
                                                       | WebRTC
                                                       v
+---------------+     +------------------+     +------------------------+
| Nest Speaker  | <-- |   Cast Protocol  | <-- | Custom Cast Receiver   |
| Audio Output  |     |   (mDNS/HTTP)    |     | (WebRTC → Audio)       |
+---------------+     +------------------+     +------------------------+
```

**Latency:** <1 second | **Reliability:** Excellent | **Setup:** Manual (user must configure audio output)

---

### Streaming Mode Comparison

| Mode | Latency | Setup | Audio Routing | Dependencies |
|------|---------|-------|---------------|--------------|
| **HTTP MP3** | ~8 sec | Auto | Requires VB-CABLE as output | VB-CABLE, FFmpeg |
| **WebRTC System** | <1 sec | Auto | Captures any audio output | screen-capture-recorder, webrtc-streamer |
| **WebRTC VB-CABLE** | <1 sec | Manual | User sets VB-CABLE as output | VB-CABLE, webrtc-streamer |

---

## Dependency Management

### Dependencies by Mode

| Dependency | HTTP MP3 | WebRTC System | WebRTC VB-CABLE |
|------------|----------|---------------|-----------------|
| FFmpeg | Required | - | - |
| VB-CABLE | Required | - | Required |
| screen-capture-recorder | - | Required | - |
| webrtc-streamer | - | Required | Required |
| localtunnel (HTTPS) | - | Required | Required |

### Automatic Installation (First Run)

```
App First Launch
       |
       v
+-------------------+
| Check Dependencies|
+-------------------+
       |
       +---> FFmpeg bundled? -----> NO ---> Extract bundled FFmpeg
       |
       +---> VB-CABLE installed? -> NO ---> Prompt: "Install VB-CABLE for HTTP mode?"
       |                                          |
       |                                          v
       |                                    Download & Run Installer
       |
       +---> screen-capture-recorder? -> NO ---> Prompt: "Install for WebRTC mode?"
       |                                              |
       |                                              v
       |                                    Download & Run Installer
       |
       +---> webrtc-streamer bundled? -> NO ---> Extract bundled webrtc-streamer
       |
       v
+-------------------+
| Dependencies Ready|
+-------------------+
```

### Startup Lifecycle

```
App Start
    |
    v
+-------------------------+
| 1. Check all deps exist |
+-------------------------+
    |
    v
+-------------------------+
| 2. Verify audio devices |
|    - List DirectShow    |
|    - Check VB-CABLE     |
|    - Check virtual-     |
|      audio-capturer     |
+-------------------------+
    |
    v
+-------------------------+
| 3. Start webrtc-streamer|
|    (if WebRTC mode)     |
|    Port 8443            |
+-------------------------+
    |
    v
+-------------------------+
| 4. Start localtunnel    |
|    (for HTTPS to Cast)  |
+-------------------------+
    |
    v
+-------------------------+
| 5. Verify connectivity  |
|    - Ping server APIs   |
|    - Test tunnel        |
+-------------------------+
    |
    v
+-------------------------+
| 6. UI Ready - Show Mode |
+-------------------------+
```

### Shutdown Lifecycle

```
App Close / Window Close
         |
         v
+---------------------------+
| 1. Stop active Cast       |
|    - pychromecast stop    |
+---------------------------+
         |
         v
+---------------------------+
| 2. Stop webrtc-streamer   |
|    - Kill process         |
|    - Release port 8443    |
+---------------------------+
         |
         v
+---------------------------+
| 3. Stop localtunnel       |
|    - Kill tunnel process  |
+---------------------------+
         |
         v
+---------------------------+
| 4. Stop FFmpeg            |
|    (if HTTP mode active)  |
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
|    - Last used mode       |
|    - Last speaker         |
+---------------------------+
         |
         v
       Exit
```

---

## Component Details

### 1. Desktop Application (Electron)

```
electron-main.js (Main Process)
+-- Window Management
|   +-- createWindow() - BrowserWindow setup
+-- License Management
|   +-- getLicenseData() - Read from license.json
|   +-- saveLicenseData() - Write to license.json
|   +-- validateLicenseFormat() - PNS-XXXX-XXXX-XXXX-XXXX
+-- Audio Streaming
|   +-- startFFmpeg() - Launch FFmpeg capture
|   +-- startHTTPServer() - Serve HLS/MP3 streams
|   +-- startWebRTCStreamer() - Launch webrtc-streamer
|   +-- startLocalTunnel() - Create HTTPS tunnel
|   +-- stopStreaming() - Cleanup all processes
+-- Chromecast Control
|   +-- discoverSpeakers() - Find Nest devices
|   +-- castToSpeaker() - Start playback
|   +-- stopCasting() - Stop playback
+-- Dependency Management
|   +-- checkDependencies() - Verify all deps exist
|   +-- installVBCable() - Download and install
|   +-- installScreenCaptureRecorder() - Download and install
|   +-- extractBundledDeps() - Unpack FFmpeg, webrtc-streamer
+-- IPC Handlers
    +-- 'activate-license' - Validate & save
    +-- 'start-streaming' - Begin audio cast
    +-- 'stop-streaming' - End audio cast
    +-- 'get-speakers' - List available devices
    +-- 'select-speaker' - Set target device
    +-- 'get-streaming-mode' - Current mode
    +-- 'set-streaming-mode' - Change mode
    +-- 'check-dependencies' - Verify deps

app.html (Renderer Process)
+-- UI Components
|   +-- Streaming mode selector (3 options)
|   +-- Speaker selection dropdown
|   +-- Start/Stop button
|   +-- Volume slider
|   +-- Status indicator
|   +-- Settings panel
|   +-- License card (collapsible)
|   +-- Dependency status indicators
+-- State Management
|   +-- isStreaming, selectedSpeaker, volume
|   +-- streamingMode, dependencies
+-- IPC Communication
    +-- ipcRenderer.send() / .on()
```

### 2. Serverless API (Vercel)

```
api/
+-- validate-license.js
|   +-- Input: POST { licenseKey: "PNS-XXXX-..." }
|   +-- Process: Search Stripe customers for metadata match
|   +-- Output: { valid: true/false, email: "...", error: "..." }
|
+-- stripe-webhook.js
    +-- Verify webhook signature
    +-- Handle checkout.session.completed
    |   +-- Generate license: PNS-XXXX-XXXX-XXXX-XXXX
    |   +-- Update customer metadata
    +-- Handle charge.refunded
        +-- Set license_status: "revoked"
```

### 3. External Dependencies

```
Bundled with App:
+-- FFmpeg
|   +-- Audio capture from DirectShow device
|   +-- MP3 encoding for HTTP mode
|   +-- Streaming output
+-- webrtc-streamer (mpromonet)
|   +-- WebRTC server for low-latency streaming
|   +-- Captures audio via DirectShow/audiocap
|   +-- Serves WebRTC offers/answers via HTTP API

Installed During Setup:
+-- VB-CABLE (optional)
|   +-- Virtual audio device
|   +-- Routes system audio for capture
|   +-- Download: https://vb-audio.com/Cable/
+-- screen-capture-recorder (optional)
    +-- Provides virtual-audio-capturer device
    +-- Captures any system audio output
    +-- Download: https://github.com/rdp/screen-capture-recorder-to-video-windows-free
```

---

## Data Flow Diagrams

### Streaming Start Flow (WebRTC Mode)

```
User                App (Renderer)    App (Main)         webrtc-streamer    Cast Receiver    Nest Speaker
 |                   |                 |                    |                   |               |
 |  Click "Start"    |                 |                    |                   |               |
 |------------------>|                 |                    |                   |               |
 |                   |  IPC: start     |                    |                   |               |
 |                   |---------------->|                    |                   |               |
 |                   |                 |                    |                   |               |
 |                   |                 |  Start webrtc-     |                   |               |
 |                   |                 |  streamer if not   |                   |               |
 |                   |                 |  running           |                   |               |
 |                   |                 |------------------->|                   |               |
 |                   |                 |                    |                   |               |
 |                   |                 |  Start localtunnel |                   |               |
 |                   |                 |  (HTTPS proxy)     |                   |               |
 |                   |                 |                    |                   |               |
 |                   |                 |  Cast to speaker   |                   |               |
 |                   |                 |  with receiver URL |                   |               |
 |                   |                 |------------------------------------------->|           |
 |                   |                 |                    |                   |               |
 |                   |                 |                    |  Receiver loads   |               |
 |                   |                 |                    |<------------------|               |
 |                   |                 |                    |                   |               |
 |                   |                 |                    |  WebRTC signaling |               |
 |                   |                 |                    |<----------------->|               |
 |                   |                 |                    |                   |               |
 |                   |                 |                    |  Audio stream     |               |
 |                   |                 |                    |------------------>|  Play audio   |
 |                   |                 |                    |                   |-------------->|
 |                   |                 |                    |                   |               |
 |                   |  IPC: status    |                    |                   |               |
 |                   |<----------------|                    |                   |               |
 |                   |                 |                    |                   |               |
 |  UI Updated       |                 |                    |                   |               |
 |<------------------|                 |                    |                   |               |
```

### Streaming Start Flow (HTTP MP3 Mode)

```
User                App (Renderer)    App (Main)         Nest Speaker
 |                   |                 |                    |
 |  Click "Start"    |                 |                    |
 |------------------>|                 |                    |
 |                   |  IPC: start     |                    |
 |                   |---------------->|                    |
 |                   |                 |                    |
 |                   |                 |  Start FFmpeg      |
 |                   |                 |  Start HTTP Server |
 |                   |                 |                    |
 |                   |                 |  Get Local IP      |
 |                   |                 |  Build URL         |
 |                   |                 |                    |
 |                   |                 |  Cast URL          |
 |                   |                 |------------------->|
 |                   |                 |                    |
 |                   |                 |  Playback Started  |
 |                   |                 |<-------------------|
 |                   |                 |                    |
 |                   |  IPC: status    |                    |
 |                   |<----------------|                    |
 |                   |                 |                    |
 |  UI Updated       |                 |                    |
 |<------------------|                 |                    |
```

### License Purchase Flow

```
User                App              Stripe           Vercel/Webhook
 |                   |                 |                    |
 |  Click "Buy"      |                 |                    |
 |------------------>|                 |                    |
 |                   |  Open Payment   |                    |
 |                   |  Link URL       |                    |
 |<------------------|                 |                    |
 |                   |                 |                    |
 |  Complete Payment |                 |                    |
 |---------------------------------->|                    |
 |                   |                 |                    |
 |                   |                 |  Webhook Event     |
 |                   |                 |------------------->|
 |                   |                 |                    |
 |                   |                 |  Generate License  |
 |                   |                 |  Store in Metadata |
 |                   |                 |<-------------------|
 |                   |                 |                    |
 |  Receipt + Key    |                 |                    |
 |<----------------------------------|                    |
```

---

## Project Setup Checklist

### Phase 1: Foundation
- [x] Initialize Git repository
- [x] Create package.json with proper metadata
- [x] Set up .gitignore (node_modules, dist, .env)
- [x] Create basic Electron app structure
- [x] Design UI mockup with Warm Neutral colors

### Phase 2: Core Streaming
- [x] Port Python FFmpeg logic to Node.js
- [x] Implement HTTP server for HLS/MP3
- [x] Integrate pychromecast for Chromecast
- [x] Create speaker discovery system
- [x] Implement start/stop streaming controls
- [x] Test with actual Nest speakers
- [ ] Add WebRTC streaming mode
- [ ] Bundle webrtc-streamer
- [ ] Add streaming mode selector UI

### Phase 3: Dependency Management
- [ ] Create dependency checker module
- [ ] Add VB-CABLE auto-installer
- [ ] Add screen-capture-recorder auto-installer
- [ ] Bundle FFmpeg and webrtc-streamer
- [ ] Add startup verification flow
- [ ] Add clean shutdown handlers

### Phase 4: Licensing System
- [ ] Create Stripe account/product
- [ ] Set up Payment Link
- [ ] Create Vercel project
- [ ] Deploy webhook handler
- [ ] Deploy validation API
- [ ] Configure Stripe webhooks
- [ ] Add environment variables to Vercel
- [ ] Implement license UI in app

### Phase 5: Build & Distribution
- [ ] Configure electron-builder
- [ ] Bundle all dependencies with app
- [ ] Set up GitHub Actions for CI/CD
- [ ] Create app icons (ico, icns)
- [ ] Test builds on Windows/Mac
- [ ] Create GitHub Release

### Phase 6: Launch
- [ ] Set up pcnestspeaker.app domain
- [ ] Test complete purchase flow
- [ ] Test streaming on multiple networks
- [ ] Write user documentation
- [ ] Publish release

---

## Key Files Template

### vercel.json
```json
{
  "version": 2,
  "builds": [
    { "src": "api/*.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/$1" }
  ]
}
```

### License Key Format
```
Pattern: PNS-XXXX-XXXX-XXXX-XXXX
Example: PNS-A1B2-C3D4-E5F6-G7H8

Generation:
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const segment = () => Array(4).fill(0).map(() =>
  chars[Math.floor(Math.random() * chars.length)]
).join('');
const key = `PNS-${segment()}-${segment()}-${segment()}-${segment()}`;
```

### FFmpeg Commands (Reference)

**MP3 Streaming (HTTP Mode):**
```bash
ffmpeg -f dshow -i audio="CABLE Output (VB-Audio Virtual Cable)" \
  -c:a libmp3lame -b:a 192k -ar 48000 -ac 2 \
  -f mp3 pipe:1
```

### webrtc-streamer Commands (Reference)

**Start with system audio capture:**
```bash
webrtc-streamer.exe -v -n "pcaudio" -U "audiocap://1" -H 0.0.0.0:8443
```

**Audio device indices:**
- `audiocap://0` - Default microphone
- `audiocap://1` - virtual-audio-capturer (screen-capture-recorder)
- `audiocap://3` - VB-CABLE Output

---

## Environment Variables Reference

### Vercel (Production)
```
STRIPE_API_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

### Local Development
```
STRIPE_API_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_... (from Stripe CLI)
```

---

## Security Checklist

- [ ] License validated server-side (not just client)
- [ ] Stripe webhook signatures verified
- [ ] No secrets in client-side code
- [ ] No secrets committed to Git
- [ ] Environment variables for all credentials
- [ ] API endpoints validate input format
- [ ] Error messages don't leak internal details
- [ ] Local HTTP server bound to localhost only when possible

---

## Design System Reference

See [CLAUDE.md](../CLAUDE.md) for color scheme:

| Name | Hex | Usage |
|------|-----|-------|
| Dim Grey | #6B6D76 | Secondary text, borders |
| Khaki Beige | #A69888 | Backgrounds, cards |
| Powder Blush | #FCBFB7 | Primary accent, CTAs |
| Charcoal Blue | #334E58 | Headers, primary text |
| Dark Coffee | #33261D | Deep backgrounds |
