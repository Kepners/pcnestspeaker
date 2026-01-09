# PC Nest Speaker - Audio Architecture

## The Two Pipelines

For PC + Speakers mode to work correctly, we need **TWO SEPARATE audio paths**:

1. **Cast Pipeline**: PRE-APO audio → FFmpeg → MediaMTX → WebRTC → Nest speakers
2. **HDMI Pipeline**: PRE-APO audio → "Listen to this device" → HDMI speakers → APO delay

## FIXED Architecture (Implemented January 9, 2026)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PC + SPEAKERS MODE (FIXED!)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   App plays audio                                                            │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────┐                               │
│   │  Windows Default: Virtual Desktop Audio │  ◀── NO APO on this device   │
│   │  (The capture source - PRE-APO)         │                               │
│   └────────────────────┬────────────────────┘                               │
│                        │                                                     │
│           ┌────────────┴────────────┐                                       │
│           │                         │                                        │
│           ▼                         ▼                                        │
│   ┌───────────────────┐   ┌───────────────────────────────────┐             │
│   │ CAST PIPELINE     │   │ HDMI PIPELINE                     │             │
│   │                   │   │ ("Listen to this device")         │             │
│   │ virtual-audio-    │   │                                   │             │
│   │ capturer captures │   │ Virtual Desktop Audio             │             │
│   │ PRE-APO audio     │   │       │                           │             │
│   │       │           │   │       ▼                           │             │
│   │       ▼           │   │ Windows routes via                │             │
│   │   FFmpeg          │   │ "Listen to this device"           │             │
│   │   (Opus encode)   │   │       │                           │             │
│   │       │           │   │       ▼                           │             │
│   │       ▼           │   │ ASUS VG32V (HDMI speakers)        │             │
│   │   MediaMTX        │   │       │                           │             │
│   │   (WebRTC)        │   │       ▼                           │             │
│   │       │           │   │   APO Delay (e.g., 700ms)         │             │
│   │       ▼           │   │   Applied ONLY here!              │             │
│   └───────────────────┘   └───────────────────────────────────┘             │
│           │                         │                                        │
│           ▼                         ▼                                        │
│   ┌───────────────────┐   ┌───────────────────┐                             │
│   │  Nest Speakers    │   │  HDMI Speakers    │                             │
│   │  (PRE-APO audio)  │   │  (POST-APO audio) │                             │
│   │  + network latency│   │  Delayed to sync  │                             │
│   └───────────────────┘   └───────────────────┘                             │
│                                                                              │
│   RESULT: Adjust APO delay to sync HDMI with Nest latency!                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## How It Works

### Cast Pipeline (Nest Speakers)
1. Windows default device = **Virtual Desktop Audio** (NO APO installed)
2. virtual-audio-capturer captures from default device = **PRE-APO audio**
3. FFmpeg encodes to Opus → MediaMTX → WebRTC → Nest speakers
4. Nest hears audio with only network latency (~0.5-1s)

### HDMI Pipeline (PC Speakers)
1. Windows default device = **Virtual Desktop Audio** (same source)
2. "Listen to this device" enabled on Virtual Desktop Audio
3. Listen target = **HDMI speakers** (e.g., ASUS VG32V)
4. APO is installed on HDMI speakers → applies delay (e.g., 700ms)
5. HDMI speakers hear audio delayed to sync with Nest

### Key Insight
**APO delay is ONLY on the HDMI speakers endpoint, NOT on the capture source!**

- Cast gets: PRE-APO audio (no delay)
- HDMI gets: POST-APO audio (delayed)
- User adjusts APO delay to match Nest latency = PERFECT SYNC

## Speakers Only Mode

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SPEAKERS ONLY MODE                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   App plays audio                                                            │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────┐                               │
│   │  Windows Default: Virtual Desktop Audio │                               │
│   │  (Listen to this device = DISABLED)     │                               │
│   └────────────────────┬────────────────────┘                               │
│                        │                                                     │
│                        ▼                                                     │
│   ┌───────────────────────────────────────────┐                             │
│   │ CAST PIPELINE ONLY                        │                             │
│   │                                           │                             │
│   │ virtual-audio-capturer → FFmpeg → MediaMTX│                             │
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

## OLD Broken Architecture (DO NOT USE)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        OLD BROKEN FLOW                                       │
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
│   │ virtual-audio-      │                                                   │
│   │ capturer            │ ◀── Captures DELAYED audio!                       │
│   └─────────┬───────────┘                                                   │
│             │                                                                │
│   BOTH PIPELINES GET DELAYED AUDIO = CANNOT SYNC!                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why The Old Architecture Was Broken

1. Windows default was set to HDMI speakers (which had APO installed)
2. APO applied delay at the endpoint level
3. virtual-audio-capturer uses WASAPI loopback = captures POST-APO audio
4. **Both Cast AND HDMI got the same delayed audio**
5. Changing APO delay affected BOTH outputs equally - impossible to sync!

## Implementation Details

### File Responsibilities

| File | Purpose |
|------|---------|
| `audio-routing.js` | Windows audio device switching, "Listen to this device" control |
| `audio-sync-manager.js` | APO delay configuration |
| `audio-streamer.js` | FFmpeg capture and streaming |

### Key Functions in audio-routing.js

```javascript
// PC + Speakers mode - TWO PIPELINES
enablePCSpeakersMode()
  1. Keep Windows default on Virtual Desktop Audio (PRE-APO capture)
  2. Enable "Listen to this device" → HDMI speakers (POST-APO output)

// Speakers Only mode - ONE PIPELINE
disablePCSpeakersMode()
  1. Disable "Listen to this device" (HDMI goes silent)
  2. Keep Windows default on Virtual Desktop Audio (Cast only)

// Low-level functions
enableListenToDevice(source, target)  // svcl /SetListenToThisDevice
disableListenToDevice(source)         // svcl /SetListenToThisDevice off
```

### Requirements

1. **Virtual Desktop Audio** - Must be installed as Windows audio device
2. **Equalizer APO** - Must be installed on HDMI speakers (NOT on virtual device)
3. **svcl.exe** - NirSoft SoundVolumeCommandLine bundled with app

### The Golden Rule

**APO delay must ONLY be on the HDMI speakers endpoint, NEVER on the capture source!**

- Virtual Desktop Audio = NO APO = PRE-APO capture
- HDMI Speakers = APO installed = POST-APO playback
