# Device Compatibility Guide

PC Nest Speaker has been tested with various Google Cast devices. This document outlines what works, what doesn't, and troubleshooting tips.

---

## ✅ Fully Compatible Devices

### Google Nest Hub
- **Model:** NVIDIA SHIELD / Google Nest Hub
- **Cast Type:** `cast` (video devices with screen)
- **WebRTC Support:** ✅ Yes
- **HTTP/MP3 Support:** ✅ Yes
- **Latency:** Sub-1 second (WebRTC)
- **Notes:** Works perfectly with custom receiver

**Tested Devices:**
- Green TV (NVIDIA SHIELD)

### Google Nest Mini (Newer Firmware)
- **Model:** Google Nest Mini
- **Cast Type:** `audio`
- **WebRTC Support:** ✅ Yes
- **HTTP/MP3 Support:** ✅ Yes
- **Latency:** Sub-1 second (WebRTC)
- **Notes:** Most Nest Minis work great with custom receiver

**Tested Devices:**
- DENNIS (Google Nest Mini)

### Google Cast Groups
- **Model:** Speaker Group
- **Cast Type:** `group`
- **WebRTC Support:** ✅ Yes
- **HTTP/MP3 Support:** ✅ Yes
- **Latency:** Sub-1 second (WebRTC)
- **Stereo Separation Support:** ✅ Yes
- **Notes:** Groups work perfectly, supports stereo channel separation

**Tested Devices:**
- Den pair (stereo speaker group)
- STUDY (speaker group)

---

## ⚠️ Partially Compatible Devices

### Google Nest Mini (Older Firmware)
- **Model:** Google Nest Mini
- **Cast Type:** `audio`
- **WebRTC Support:** ❌ No (custom receiver fails)
- **HTTP/MP3 Support:** ✅ Yes
- **Latency:** ~8 seconds (HTTP/MP3 mode)
- **Error:** `RequestFailed: Failed to execute start app FCAA4619`

**Why it fails:**
- Older firmware doesn't support custom Cast receivers
- Even though Cast SDK is configured for audio-only devices
- Same model as working Nest Minis, just older firmware

**Workaround:**
1. Use HTTP/MP3 streaming mode (app will auto-fallback)
2. Higher latency (~8 seconds) but fully functional
3. Consider updating speaker firmware via Google Home app

**Tested Devices:**
- Back garden speaker (Google Nest Mini - older firmware)

---

## Device Detection

### How to Check Your Device

The app automatically discovers devices on your network and displays:
- **Device Name** (e.g., "Den pair")
- **Model** (e.g., "Google Cast Group")
- **IP Address** (e.g., 192.168.50.241)
- **Cast Type** (audio, cast, or group)

### Device Info Command

For advanced troubleshooting, the app can show detailed device info:
```
Model: Google Nest Mini
UUID: 6d9cdd5d-5f80-8408-4080-7f4d30a714d7
IP: 192.168.50.202
Cast Type: audio
Firmware: [varies by device]
```

---

## Streaming Modes

PC Nest Speaker supports two streaming modes:

### WebRTC Mode (Recommended)
- **Latency:** Sub-1 second (imperceptible)
- **Compatibility:** Newer devices, groups, Nest Hubs
- **Requirements:** Custom receiver support (App ID: FCAA4619)
- **Fallback:** Auto-switches to HTTP if custom receiver fails

### HTTP/MP3 Mode (Fallback)
- **Latency:** ~8 seconds
- **Compatibility:** All Google Cast devices
- **Requirements:** None (uses default Cast receiver)
- **When Used:** Older Nest speakers, manual fallback

---

## Troubleshooting

### "Speaker not found on network"

**Possible Causes:**
1. PC and speaker on different Wi-Fi networks
2. Router blocking mDNS/Chromecast discovery
3. Speaker offline or in setup mode

**Solutions:**
1. Ensure PC and speaker on same Wi-Fi network
2. Check router firewall settings (allow mDNS port 5353)
3. Restart speaker and try discovery again
4. Check if speaker appears in Google Home app

### "Failed to execute start app FCAA4619"

**Possible Causes:**
1. Older speaker firmware (doesn't support custom receivers)
2. Network blocking HTTPS tunnel access

**Solutions:**
1. App will automatically fallback to HTTP/MP3 mode
2. Update speaker firmware via Google Home app
3. Use HTTP/MP3 mode manually (8 second latency)

### "No audio" or "Audio cutting out"

**Possible Causes:**
1. FFmpeg not capturing audio
2. Virtual audio device not selected in Windows
3. Network congestion

**Solutions:**
1. Check that `virtual-audio-capturer` is installed
2. Windows should auto-switch audio device (check debug log)
3. Restart streaming
4. Check Windows audio settings (virtual device should be default)

### "High latency" (>5 seconds)

**Possible Causes:**
1. Using HTTP/MP3 mode instead of WebRTC
2. Network congestion
3. Older device firmware

**Solutions:**
1. Check debug log - should say "(WebRTC)" not "(HTTP fallback)"
2. Ensure device supports custom receiver
3. Reduce network traffic (pause downloads, close streaming apps)

### Stereo Separation Not Working

**Possible Causes:**
1. Both speakers not in a speaker group
2. Speakers on different networks
3. One speaker doesn't support custom receiver

**Requirements:**
- Both speakers must support WebRTC mode
- Speakers must be discoverable on network
- Use "L" and "R" toggles to assign channels

---

## Device Recommendations

### Best Experience
- **Google Nest Hub** - Full WebRTC support, visual feedback
- **Newer Google Nest Mini** - Sub-second latency
- **Speaker Groups** - Stereo separation support

### Works But Higher Latency
- **Older Google Nest Mini** - HTTP fallback, ~8 sec latency
- **Chromecast Audio** - Not tested, likely HTTP mode only

### Not Tested
- Google Home (original)
- Google Home Max
- Chromecast with Google TV
- Third-party Cast speakers

---

## Network Requirements

### Required Ports
- **5353/UDP** - mDNS discovery
- **8009/TCP** - Cast protocol
- **8554/TCP** - RTSP streaming (local)
- **8889/TCP** - WebRTC/WHEP endpoint (local)

### Firewall Rules

PC Nest Speaker automatically creates Windows Firewall rules for:
- Port 8000/TCP - HTTP server (MP3 mode)

If automatic setup fails, run as Administrator:
```cmd
netsh advfirewall firewall add rule name="PC Nest Speaker HTTP" dir=in action=allow protocol=TCP localport=8000
```

### Network Topology

**Supported:**
- PC and speakers on same Wi-Fi network
- PC wired (Ethernet), speakers on Wi-Fi (same subnet)
- PC on Wi-Fi, speakers on same Wi-Fi

**Not Supported:**
- PC and speakers on different subnets
- VPN connections (blocks local discovery)
- Guest Wi-Fi networks (isolation enabled)

---

## Known Issues

### Den Pair (Speaker Groups)

**Issue:** When streaming to "Den pair", only plays on one speaker (DENNIS)

**Analysis:**
- Den pair shares IP 192.168.50.241 with DENNIS
- Suggests DENNIS is the primary speaker in the group
- Custom receiver launches successfully
- May be a Google Cast group limitation

**Status:** Under investigation

**Workaround:** Use stereo separation mode to explicitly assign L/R channels

### Back Garden Speaker Firmware

**Issue:** Older Nest Mini firmware doesn't support custom receivers

**Status:** No fix available (Google firmware issue)

**Workaround:** Use HTTP/MP3 mode (automatic fallback)

---

## Reporting Issues

If you encounter device compatibility issues:

1. Check the debug log in the app
2. Note your device model and firmware version
3. Record any error messages
4. Try both WebRTC and HTTP modes
5. Report at: https://github.com/Kepners/pcnestspeaker/issues

---

*Last Updated: January 6, 2026*
