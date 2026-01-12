# Audio Sync System Documentation

*Last Updated: January 12, 2025*

---

## Overview

When streaming to Nest speakers while also playing on PC speakers ("Wall of Sound" mode), the audio arrives at different times:

- **PC speakers**: Instant (direct from Windows)
- **Nest speakers**: ~160ms delayed (network + processing)

**Solution**: Delay the PC speakers using Equalizer APO so both play at the same time.

---

## The Problem

```
                ┌─────────────────────────────────────────────┐
Windows Audio   │                                             │
      │         │  Problem: Nest is ~160ms behind PC speakers │
      │         │                                             │
      ├─→ PC Speakers ──────────────→ You hear this FIRST    │
      │                                                       │
      └─→ VB-Cable → FFmpeg → WebRTC → Nest ─→ THEN this     │
                │                                             │
                └─────────────────────────────────────────────┘
```

Without sync, you hear an echo - PC first, then Nest ~160ms later.

---

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Equalizer APO** | `C:\Program Files\EqualizerAPO\` | Third-party Windows audio processor |
| **pcnestspeaker-sync.txt** | `...EqualizerAPO\config\` | Our config file with delay value |
| **config.txt** | `...EqualizerAPO\config\` | Main APO config (includes our file) |
| **audio-sync-manager.js** | `src/main/` | Detects APO, writes config, tracks state |
| **pc-speaker-delay.js** | `src/main/` | Simple APO config writer |
| **auto-sync-manager.js** | `src/main/` | Monitors RTT, auto-adjusts delay |

---

## APO Config File Format

**Location**: `C:\Program Files\EqualizerAPO\config\pcnestspeaker-sync.txt`

```
# PC Nest Speaker Audio Sync
# Auto-generated - do not edit manually

# Delay PC speakers to sync with Nest speakers
Delay: 160 ms
```

**Main config** (`config.txt`) includes our file:
```
# PC Nest Speaker sync delay
Include: pcnestspeaker-sync.txt
```

---

## The Complete Flow

### 1. User Enables "Add PC Speaker" Toggle

**UI**: renderer.js → `togglePCAudio(true)`
**IPC**: `'toggle-pc-audio'` event sent to main process

### 2. Main Process Handles Toggle

**File**: `electron-main.js`

```javascript
ipcMain.handle('toggle-pc-audio', async (event, enabled) => {
  if (enabled) {
    // Load saved delay from settings (or default 100ms)
    let actualDelay = settings.syncDelayMs || 100;

    // Auto-correct old high values (from before WebRTC optimization)
    if (actualDelay > 300) {
      actualDelay = 100;  // Reset to sensible default
    }

    // Write delay to BOTH managers (keep state in sync!)
    await pcSpeakerDelay.setDelay(actualDelay);
    await audioSyncManager.setDelay(actualDelay);

    // Enable "Listen to this device" on VB-Cable Output
    await audioRouting.enableListen(vbCableOutput, pcSpeaker);

    // Start auto-sync monitoring
    autoSyncManager.start(currentConnectedSpeaker);
    await autoSyncManager.setBaseline();
  }
});
```

### 3. APO Config File is Written

**File**: `pc-speaker-delay.js` → `setDelay()`

```javascript
const configContent = [
  '# PC Nest Speaker Audio Sync',
  '# Auto-generated - do not edit manually',
  '',
  '# Delay PC speakers to sync with Nest speakers',
  `Delay: ${delay} ms`,
  ''
].join('\r\n');

fs.writeFileSync(SYNC_CONFIG_PATH, configContent);
```

### 4. APO Applies the Delay

Equalizer APO:
1. Reads `config.txt`
2. Sees `Include: pcnestspeaker-sync.txt`
3. Reads our file
4. Applies `Delay: 160 ms` to all audio going to PC speakers

### 5. Auto-Sync Monitoring Starts

**File**: `auto-sync-manager.js`

```javascript
// Start checking every 500ms
checkInterval = setInterval(async () => {
  await checkAndAdjust();
}, CHECK_INTERVAL_MS);  // 500ms
```

### 6. Auto-Sync Checks Network

Every 500ms, `checkAndAdjust()` runs:

```javascript
// 1. Ping speaker to measure RTT
const currentRtt = await measureLatencyQuick(speaker.ip);
// Uses: ping -n 3 -w 1000 <ip>

// 2. Calculate drift from baseline
const rttDrift = currentRtt - baselineRtt;
const targetDelay = baselineDelay + rttDrift;
const delayDrift = Math.abs(targetDelay - currentDelay);

// 3. Only adjust if drift > 10ms (prevents hunting)
if (delayDrift > ADJUSTMENT_THRESHOLD_MS) {
  const newDelay = Math.round(targetDelay / 50) * 50;  // Round to 50ms
  await audioSyncManager.setDelay(newDelay);
}
```

### 7. User Manual Adjustment (Slider)

When user moves sync delay slider:

**renderer.js** → `setSyncDelay(value)` → IPC `'set-sync-delay'`

**electron-main.js**:
```javascript
ipcMain.handle('set-sync-delay', async (event, delayMs) => {
  await audioSyncManager.setDelay(delayMs);

  // Tell auto-sync this is the new baseline
  await autoSyncManager.updateBaseline(delayMs);

  // Save to settings
  settingsManager.setSetting('syncDelayMs', delayMs);
});
```

**auto-sync-manager.js** → `updateBaseline()`:
```javascript
// PAUSE auto-sync for 5 seconds so user can hear adjustment
manualAdjustmentPause = true;

// Set new baseline
baselineDelay = newDelay;
baselineRtt = await measureLatencyQuick(speaker.ip);

// Resume after 5 seconds
setTimeout(() => {
  manualAdjustmentPause = false;
}, 5000);
```

### 8. App Cleanup on Exit

**electron-main.js** → `cleanup()`:
```javascript
audioSyncManager.cleanup();
```

**audio-sync-manager.js** → `cleanup()`:
```javascript
// SYNC write to ensure completion before app quits
fs.writeFileSync(SYNC_CONFIG_PATH, 'Delay: 0 ms');
```

---

## The Math

```
Total Latency to Nest = RTT/2 + Pipeline Delay

Pipeline Delay (BUFFER_OFFSET_MS = 160ms):
├── FFmpeg capture:       50ms  (audio_buffer_size)
├── Opus encoding:        20ms  (frame_duration)
├── WebRTC jitter:        50ms  (jitterBufferTarget)
├── Opus decoding:        10ms
└── Speaker processing:   30ms
                        ─────
                         160ms

Example:
  RTT = 20ms (ping to Nest speaker)
  One-way latency = 20/2 = 10ms
  Total = 10 + 160 = 170ms

  PC speaker delay = 170ms → IN SYNC!
```

---

## MEASURE Button Flow

1. **renderer.js** → click "MEASURE"
2. **IPC** → `'measure-latency'`
3. **electron-main.js** → calls `cast-helper.py measure-latency`
4. **Python** → sends `{type: "measure-latency"}` to Cast receiver
5. **receiver.html** (on Nest) → uses WebRTC `getStats()` to measure RTT:
   ```javascript
   const stats = await peerConnection.getStats();
   // Gets currentRoundTripTime from ICE candidate pair
   ```
6. **receiver.html** → calculates recommended delay:
   ```javascript
   const recommendedDelay = (avgRTT / 2) + BUFFER_OFFSET_MS;  // 160ms
   ```
7. **receiver.html** → sends `{type: "latency-result", rtt, recommendedDelay}`
8. **Python** → returns result to Node
9. **renderer.js** → sets slider to recommended value

---

## CALIBRATE Button Flow

1. Click "CALIBRATE" → `startCalibration()`
2. Enable PC audio if not already
3. Play dual ping (PC + Nest simultaneously)
4. User scrolls mouse wheel to adjust delay
5. When user hears ONE ping (merged), sync is correct
6. Click "Done" to save

---

## Auto-Sync Configuration

**File**: `auto-sync-manager.js`

```javascript
const CHECK_INTERVAL_MS = 500;        // Check every 0.5 seconds
const ADJUSTMENT_THRESHOLD_MS = 10;   // Only adjust if drift > 10ms
const MIN_DELAY_MS = 0;               // Allow zero delay
const MAX_DELAY_MS = 2000;            // Maximum 2 seconds

const PIPELINE_DELAYS = {
  FFMPEG_CAPTURE: 50,        // audio_buffer_size
  OPUS_ENCODING: 20,         // frame_duration
  WEBRTC_JITTER_BUFFER: 50,  // jitterBufferTarget
  OPUS_DECODING: 10,         // Decoder latency
  SPEAKER_PROCESSING: 30,    // Nest internal
};
const TOTAL_PIPELINE_DELAY = 160;  // Sum of above
```

---

## Troubleshooting

### "Equalizer APO not installed"
- Download from: https://sourceforge.net/projects/equalizerapo/
- Run Configurator.exe and enable APO on your PC speaker device

### "APO not enabled for device"
1. Open `C:\Program Files\EqualizerAPO\Configurator.exe`
2. Check the box next to your PC speaker (HDMI, Realtek, etc.)
3. Click OK and reboot

### "Delay not applied"
- Check `C:\Program Files\EqualizerAPO\config\pcnestspeaker-sync.txt` exists
- Check `config.txt` contains `Include: pcnestspeaker-sync.txt`
- Restart any playing audio

### "Audio still out of sync after calibration"
- Network conditions changed - try MEASURE again
- Auto-sync may be adjusting - wait 5 seconds
- Check if PC speaker toggle is actually ON

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/main/audio-sync-manager.js` | Main APO management, delay writing |
| `src/main/pc-speaker-delay.js` | Simple APO config writer |
| `src/main/auto-sync-manager.js` | Network monitoring, auto-adjustment |
| `src/renderer/renderer.js` | UI handlers for sync controls |
| `docs/receiver.html` | Cast receiver RTT measurement |
| `docs/receiver-audio.html` | Audio-only receiver RTT measurement |

---

*End of Sync System Documentation*
