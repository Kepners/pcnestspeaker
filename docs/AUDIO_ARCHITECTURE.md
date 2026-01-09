# PC Nest Speaker - Audio Architecture

## The Problem: PC + Speakers Mode

For PC + Speakers mode to work correctly, we need **TWO SEPARATE audio paths**:

1. **PC Speakers**: Delayed to sync with Nest (using APO)
2. **Nest Speakers**: NOT delayed (just network latency)

## Current Architecture (BROKEN)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CURRENT FLOW (BROKEN!)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   App plays audio                                                            │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────┐                                                       │
│   │  Windows Mixer  │                                                       │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐     ┌─────────────────────────────┐                   │
│   │    APO Delay    │────▶│   ASUS VG32V (PC Speakers)  │ = DELAYED         │
│   │   (700ms)       │     └─────────────────────────────┘                   │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            │ (WASAPI Loopback captures POST-APO!)                           │
│            ▼                                                                 │
│   ┌─────────────────────┐                                                   │
│   │ virtual-audio-      │                                                   │
│   │ capturer            │                                                   │
│   └─────────┬───────────┘                                                   │
│             │                                                                │
│             ▼                                                                │
│   ┌─────────────────┐     ┌─────────────────────────────┐                   │
│   │     FFmpeg      │────▶│   Nest Speakers (Cast)      │ = DELAYED + LATENCY│
│   └─────────────────┘     └─────────────────────────────┘                   │
│                                                                              │
│   RESULT: Both outputs are delayed! No way to sync them!                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why This Doesn't Work

1. **APO (Equalizer APO)** applies delay at the audio endpoint level
2. **virtual-audio-capturer** uses WASAPI loopback which captures POST-APO audio
3. Both PC speakers AND Nest speakers receive the APO-delayed audio
4. Changing the delay affects BOTH outputs equally - can't sync them!

## Required Architecture (CORRECT)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CORRECT FLOW (NEEDED)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   App plays audio                                                            │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────┐                                                       │
│   │  Windows Mixer  │                                                       │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            ├────────────────────────────────────────┐                       │
│            │                                        │                       │
│            ▼                                        ▼                       │
│   ┌─────────────────┐                    ┌─────────────────────┐            │
│   │ Virtual Device  │                    │   APO Delay (700ms) │            │
│   │ (No APO)        │                    │                     │            │
│   └────────┬────────┘                    └─────────┬───────────┘            │
│            │                                       │                        │
│            ▼                                       ▼                        │
│   ┌─────────────────┐                    ┌─────────────────────┐            │
│   │ virtual-audio-  │                    │ ASUS VG32V          │            │
│   │ capturer        │                    │ (PC Speakers)       │            │
│   └────────┬────────┘                    └─────────────────────┘            │
│            │                                       │                        │
│            ▼                                       │                        │
│   ┌─────────────────┐                              │                        │
│   │     FFmpeg      │                              │                        │
│   └────────┬────────┘                              │                        │
│            │                                       │                        │
│            ▼                                       │                        │
│   ┌─────────────────────┐              ┌───────────┴───────────┐            │
│   │ Nest Speakers       │              │ PC Speakers           │            │
│   │ (no APO delay)      │              │ (APO delayed)         │            │
│   │ + network latency   │              │                       │            │
│   └─────────────────────┘              └───────────────────────┘            │
│                                                                              │
│   RESULT: Can adjust APO delay to sync PC with Nest!                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Solution Options

### Option 1: Voicemeeter (Complex but Powerful)

```
App → Voicemeeter → Split to:
  ├── Virtual Output (captured by FFmpeg → Cast, no delay)
  └── Hardware Out A1 (ASUS VG32V with APO delay)
```

- Pros: Full control, professional solution
- Cons: User needs to install Voicemeeter, complex setup

### Option 2: VB-CABLE + Windows Audio Router

```
App → VB-CABLE (default device) → Split using Windows "Listen" feature:
  ├── Captured by FFmpeg → Cast (no delay)
  └── Monitored to ASUS VG32V (with APO delay)
```

- Pros: Free tools
- Cons: "Listen" feature adds latency, may not work with APO

### Option 3: Application-Specific Audio Routing (Best UX)

```
Our App → Detects playing audio source
       → FFmpeg captures from SOURCE app directly (not system audio)
       → Separately routes to PC speakers with delay
```

- Pros: Best user experience, no extra software needed
- Cons: Complex implementation, needs per-app audio capture

### Option 4: Custom Virtual Audio Driver

Build our own virtual audio driver that:
1. Receives all system audio
2. Outputs to Cast (no delay)
3. Mirrors to selected device with APO delay

- Pros: Perfect control
- Cons: Major development effort, driver signing issues

## Recommended Implementation

**For v1.0, use Option 2 with clear setup wizard:**

1. Install VB-CABLE as the virtual audio device
2. Set Windows default to VB-CABLE
3. Configure VB-CABLE to "Listen" to ASUS VG32V
4. APO delay only affects ASUS VG32V
5. FFmpeg captures from VB-CABLE (pre-delay)

**Setup Wizard Steps:**
1. Detect if VB-CABLE installed → Download/install if not
2. Detect user's real speakers (HDMI/Monitor)
3. Check if APO installed on real speakers
4. Configure Windows audio routing
5. Test with ping to verify sync capability

## File Responsibilities

- `audio-routing.js` - Windows audio device switching
- `audio-sync-manager.js` - APO delay configuration
- `audio-device-manager.js` - Device detection and NirCmd control
- `audio-streamer.js` - FFmpeg capture and streaming

## Key Insight

**virtual-audio-capturer MUST capture PRE-APO audio** for sync calibration to work!

The current architecture where:
- Default device = Real speakers (ASUS VG32V)
- APO delay on real speakers
- Capture from real speakers

Will NOT work because capture happens POST-APO.

We need:
- Default device = Virtual device (no APO)
- Capture from virtual device (no delay)
- Mirror/route to real speakers (with APO delay)
