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

## Audio Pipeline

```
+---------------+     +------------------+     +---------------+     +------------+
|  System Audio | --> | VB-CABLE or      | --> |    FFmpeg     | --> | HTTP Server|
|  (All Apps)   |     | Voicemeeter      |     |   Encoder     |     | Port 8000  |
+---------------+     +------------------+     +---------------+     +-----+------+
                                                                           |
                         Wi-Fi Network (same subnet)                       |
                                                                           v
+---------------+     +------------------+     +---------------+     +------------+
| Nest Speaker  | <-- |   Cast Protocol  | <-- | HLS/MP3 URL   | <-- | pychromecast|
| Audio Output  |     |   (mDNS/HTTP)    |     | Streaming     |     |  Library   |
+---------------+     +------------------+     +---------------+     +------------+
```

### Streaming Protocols

| Protocol | Format | Latency | Use Case |
|----------|--------|---------|----------|
| HLS | AAC in .ts segments | ~1.5s | Primary - best network tolerance |
| MP3 | Progressive stream | ~2-3s | Fallback - simpler, more reliable |

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
|   +-- stopStreaming() - Cleanup processes
+-- Chromecast Control
|   +-- discoverSpeakers() - Find Nest devices
|   +-- castToSpeaker() - Start playback
|   +-- stopCasting() - Stop playback
+-- IPC Handlers
    +-- 'activate-license' - Validate & save
    +-- 'start-streaming' - Begin audio cast
    +-- 'stop-streaming' - End audio cast
    +-- 'get-speakers' - List available devices
    +-- 'select-speaker' - Set target device

app.html (Renderer Process)
+-- UI Components
|   +-- Speaker selection dropdown
|   +-- Start/Stop button
|   +-- Volume slider
|   +-- Status indicator
|   +-- Settings panel
|   +-- License card (collapsible)
+-- State Management
|   +-- isStreaming, selectedSpeaker, volume
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

### 3. Audio Dependencies

```
Required Software:
+-- FFmpeg (bundled or PATH)
|   +-- Audio capture from DirectShow device
|   +-- HLS/MP3 encoding
|   +-- Streaming output
+-- VB-CABLE or Voicemeeter
    +-- Virtual audio device
    +-- Routes system audio to FFmpeg
```

---

## Data Flow Diagrams

### Streaming Start Flow

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
- [ ] Initialize Git repository
- [ ] Create package.json with proper metadata
- [ ] Set up .gitignore (node_modules, dist, .env)
- [ ] Create basic Electron app structure
- [ ] Design UI mockup with Warm Neutral colors

### Phase 2: Core Streaming
- [ ] Port Python FFmpeg logic to Node.js
- [ ] Implement HTTP server for HLS/MP3
- [ ] Integrate node-castv2-client for Chromecast
- [ ] Create speaker discovery system
- [ ] Implement start/stop streaming controls
- [ ] Test with actual Nest speakers

### Phase 3: Licensing System
- [ ] Create Stripe account/product
- [ ] Set up Payment Link
- [ ] Create Vercel project
- [ ] Deploy webhook handler
- [ ] Deploy validation API
- [ ] Configure Stripe webhooks
- [ ] Add environment variables to Vercel
- [ ] Implement license UI in app

### Phase 4: Build & Distribution
- [ ] Configure electron-builder
- [ ] Bundle FFmpeg with app (or document requirement)
- [ ] Set up GitHub Actions for CI/CD
- [ ] Create app icons (ico, icns)
- [ ] Test builds on Windows/Mac
- [ ] Create GitHub Release

### Phase 5: Launch
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

**HLS Streaming:**
```bash
ffmpeg -f dshow -i audio="CABLE Output (VB-Audio Virtual Cable)" \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -f hls -hls_time 0.5 -hls_list_size 3 \
  -hls_flags delete_segments+independent_segments \
  hls_out/stream.m3u8
```

**MP3 Streaming:**
```bash
ffmpeg -f dshow -i audio="CABLE Output (VB-Audio Virtual Cable)" \
  -c:a libmp3lame -b:a 192k -ar 48000 -ac 2 \
  -f mp3 pipe:1
```

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
