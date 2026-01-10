# PC Nest Speaker - Audio Architecture

## The Two Pipelines

For PC + Speakers mode to work correctly, we need **TWO SEPARATE audio paths**:

1. **Cast Pipeline**: PRE-APO audio → FFmpeg → MediaMTX → WebRTC → Nest speakers
2. **HDMI Pipeline**: PRE-APO audio → "Listen to this device" → HDMI speakers → APO delay

## VB-Cable Architecture (Updated January 10, 2026)

**Why VB-Cable instead of Virtual Desktop Audio (VDA)?**

VDA's CAPTURE device is only visible to DirectShow applications (like FFmpeg), NOT to Windows
WASAPI. The "Listen to this device" feature requires a WASAPI-visible CAPTURE device. VB-Cable
provides both RENDER (CABLE Input) and CAPTURE (CABLE Output) devices visible to Windows WASAPI.

**VB-Cable Device Names:**
- **CABLE Input** (RENDER) - Windows default playback device, apps output audio here
- **CABLE Output** (CAPTURE) - Visible to WASAPI, used for "Listen to this device"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PC + SPEAKERS MODE (VB-Cable)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   App plays audio                                                            │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────┐                               │
│   │  Windows Default: CABLE Input           │  ◀── NO APO on this device   │
│   │  (VB-Audio Virtual Cable RENDER)        │                               │
│   │  (SINGLE SOURCE - both pipelines here)  │                               │
│   └────────────────────┬────────────────────┘                               │
│                        │                                                     │
│        ┌───────────────┴───────────────┐                                    │
│        │                               │                                     │
│        ▼                               ▼                                     │
│   ┌─────────────┐             ┌─────────────────────┐                       │
│   │ CAST        │             │ HDMI PIPELINE       │                       │
│   │ PIPELINE    │             │ (Listen to device)  │                       │
│   │             │             │                     │                       │
│   │ FFmpeg      │             │ "Listen to this     │                       │
│   │ captures    │             │ device" enabled on  │                       │
│   │ from:       │             │ CABLE Output,       │                       │
│   │ "CABLE      │             │ outputs to:         │                       │
│   │  Output"    │             │                     │                       │
│   │     │       │             │  ASUS VG32V (HDMI)  │                       │
│   │     ▼       │             │  with APO:          │                       │
│   │  Opus       │             │    → Delay 700ms    │                       │
│   │  Encode     │             │    → Then speakers  │                       │
│   │     │       │             │                     │                       │
│   │     ▼       │             │                     │                       │
│   │  MediaMTX   │             │                     │                       │
│   └──────┬──────┘             └──────────┬──────────┘                       │
│          │                               │                                   │
│          ▼                               ▼                                   │
│   ┌─────────────┐             ┌─────────────────────┐                       │
│   │ Nest        │             │ HDMI Speakers       │                       │
│   │ (no delay)  │             │ (700ms delayed)     │                       │
│   │ +500ms net  │             │ = synced with Nest  │                       │
│   └─────────────┘             └─────────────────────┘                       │
│                                                                              │
│   BOTH PIPELINES ORIGINATE FROM: CABLE Input (VB-Cable RENDER)              │
│   APO delay ONLY on HDMI endpoint, NOT on VB-Cable                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## How It Works

### Cast Pipeline (Nest Speakers)
1. Windows default device = **CABLE Input** (VB-Cable RENDER, NO APO installed)
2. FFmpeg captures from **CABLE Output** (VB-Cable CAPTURE) = **PRE-APO audio**
3. FFmpeg encodes to Opus → MediaMTX → WebRTC → Nest speakers
4. Nest hears audio with only network latency (~0.5-1s)

### HDMI Pipeline (PC Speakers)
1. Windows default device = **CABLE Input** (same source)
2. "Listen to this device" enabled on **CABLE Output** (VB-Cable CAPTURE)
3. Listen target = **HDMI speakers** (e.g., ASUS VG32V)
4. APO is installed on HDMI speakers → applies delay (e.g., 700ms)
5. HDMI speakers hear audio delayed to sync with Nest

### Key Insight
**APO delay is ONLY on the HDMI speakers endpoint, NOT on VB-Cable!**

- Cast gets: PRE-APO audio (no delay)
- HDMI gets: POST-APO audio (delayed)
- User adjusts APO delay to match Nest latency = PERFECT SYNC

### Why VB-Cable Works (and VDA Doesn't)

| Feature | VB-Cable | Virtual Desktop Audio |
|---------|----------|----------------------|
| RENDER device | CABLE Input ✅ | Virtual Desktop Audio ✅ |
| CAPTURE device | CABLE Output ✅ | NOT visible to WASAPI ❌ |
| FFmpeg capture | Works (DirectShow) | Works (DirectShow) |
| "Listen to device" | Works (WASAPI visible) | FAILS (not WASAPI visible) |
| PC+Speakers mode | **WORKS** | **BROKEN** |

## Speakers Only Mode

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SPEAKERS ONLY MODE (VB-Cable)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   App plays audio                                                            │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────┐                               │
│   │  Windows Default: CABLE Input           │                               │
│   │  (Listen to this device = DISABLED)     │                               │
│   └────────────────────┬────────────────────┘                               │
│                        │                                                     │
│                        ▼                                                     │
│   ┌───────────────────────────────────────────┐                             │
│   │ CAST PIPELINE ONLY                        │                             │
│   │                                           │                             │
│   │ FFmpeg (CABLE Output) → Opus → MediaMTX   │                             │
│   │                                           │                             │
│   └───────────────────┬───────────────────────┘                             │
│                       │                                                      │
│                       ▼                                                      │
│   ┌───────────────────────────────────────────┐                             │
│   │  Nest Speakers ONLY                       │                             │
│   │  (No HDMI audio - Listen disabled)        │                             │
│   └───────────────────────────────────────────┘                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## OLD Broken Architectures (DO NOT USE)

### Problem 1: Direct HDMI Capture (APO in wrong place)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        OLD BROKEN FLOW #1                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Windows Default = HDMI Speakers (WITH APO!)                               │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────┐                                                       │
│   │    APO Delay    │  ◀── APO applied BEFORE capture!                      │
│   │   (700ms)       │                                                       │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            │ (WASAPI Loopback captures POST-APO!)                           │
│            ▼                                                                 │
│   ┌─────────────────────┐                                                   │
│   │ FFmpeg captures     │                                                   │
│   │ DELAYED audio!      │ ◀── Captures POST-APO = BROKEN                    │
│   └─────────┬───────────┘                                                   │
│             │                                                                │
│   BOTH PIPELINES GET DELAYED AUDIO = CANNOT SYNC!                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Problem 2: Virtual Desktop Audio (CAPTURE not visible to WASAPI)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        OLD BROKEN FLOW #2 (VDA)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Windows Default = Virtual Desktop Audio                                   │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────────────────┐                   │
│   │  FFmpeg captures via DirectShow ✓                   │                   │
│   │  (virtual-audio-capturer sees VDA via DirectShow)   │                   │
│   └─────────────────────────────────────────────────────┘                   │
│                                                                              │
│   BUT "Listen to this device" on VDA CAPTURE ❌ FAILS!                      │
│   VDA's CAPTURE device is NOT visible to Windows WASAPI!                    │
│   Windows cannot find a CAPTURE device to enable listening!                 │
│                                                                              │
│   Result: Cast works, but PC speakers mode BROKEN                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why VDA Failed for PC+Speakers Mode

1. VDA's CAPTURE device is **DirectShow-only** - NOT visible to Windows WASAPI
2. "Listen to this device" requires a **WASAPI-visible CAPTURE device**
3. FFmpeg works because it uses DirectShow (not WASAPI)
4. **Speakers Only mode worked** (FFmpeg captures via DirectShow)
5. **PC+Speakers mode FAILED** ("Listen to this device" couldn't find VDA CAPTURE)

## Implementation Details

### File Responsibilities

| File | Purpose |
|------|---------|
| `audio-routing.js` | Windows audio device switching, "Listen to this device" control |
| `audio-sync-manager.js` | APO delay configuration |
| `audio-streamer.js` | FFmpeg capture and streaming |
| `electron-main.js` | Pipeline orchestration, FFmpeg process management |

### Key Functions in audio-routing.js

```javascript
// PC + Speakers mode - TWO PIPELINES
enablePCSpeakersMode()
  1. Keep Windows default on CABLE Input (PRE-APO capture)
  2. Enable "Listen to this device" on CABLE Output → HDMI speakers (POST-APO output)

// Speakers Only mode - ONE PIPELINE
disablePCSpeakersMode()
  1. Disable "Listen to this device" (HDMI goes silent)
  2. Keep Windows default on CABLE Input (Cast only)

// Low-level functions (using audioctl CLI)
enableListenToDevice(source, target)  // audioctl listen --enable
disableListenToDevice(source)         // audioctl listen --disable

// Device detection (prefers VB-Cable)
findVirtualDevice()         // Finds CABLE Input or VDA as fallback
findVirtualCaptureDevice()  // Finds CABLE Output or VDA as fallback
```

### Requirements

1. **VB-Cable** - Must be installed (provides CABLE Input + CABLE Output)
   - Download: https://vb-audio.com/Cable/
2. **Equalizer APO** - Must be installed on HDMI speakers (NOT on VB-Cable)
3. **svcl.exe** - NirSoft SoundVolumeCommandLine for device switching
4. **audioctl.exe** - WindowsAudioControl-CLI for "Listen to this device" control
   - Download: https://github.com/Mr5niper/WindowsAudioControl-CLI-wGUI/releases

### The Golden Rule

**APO delay must ONLY be on the HDMI speakers endpoint, NEVER on VB-Cable!**

- CABLE Input (VB-Cable RENDER) = NO APO = Windows default playback
- CABLE Output (VB-Cable CAPTURE) = NO APO = FFmpeg capture source
- HDMI Speakers = APO installed = POST-APO playback (delayed to sync with Nest)

### VB-Cable Device Names in Code

```javascript
// Device name patterns to match (in order of preference)
const virtualRenderPatterns = [
  'VB-Audio Virtual Cable',    // VB-Cable device name (preferred)
  'CABLE Input',               // VB-Cable render device display name
  'Virtual Desktop Audio'      // Fallback to VDA if VB-Cable not installed
];

const virtualCapturePatterns = [
  'VB-Audio Virtual Cable',    // VB-Cable device name (preferred)
  'CABLE Output',              // VB-Cable capture device display name
  'Virtual Desktop Audio'      // Fallback (won't work for Listen, but try anyway)
];

// FFmpeg audio device (DirectShow)
const ffmpegDevice = 'CABLE Output (VB-Audio Virtual Cable)';
```
