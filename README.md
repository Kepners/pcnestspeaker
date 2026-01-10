# PC Nest Speaker

Stream Windows system audio to Google Nest speakers over Wi-Fi with sub-second latency.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-Proprietary-red)

## Features

- **Sub-second latency** - WebRTC streaming via custom Cast receiver
- **All system audio** - Captures audio from any Windows application
- **Auto device switching** - Automatically switches Windows audio output when streaming
- **Windows volume sync** - PC volume keys control Nest speaker volume
- **Stereo mode** - Split L/R channels to separate speakers
- **System tray** - Runs minimized, quick access controls
- **Auto-start** - Launch with Windows boot
- **10-hour free trial** - Then one-time purchase for lifetime access

## Quick Start

### Requirements

- Windows 10/11 (64-bit)
- Google Nest speaker(s) on same Wi-Fi network

### Optional (for PC + Speakers mode)

- **[Equalizer APO](https://sourceforge.net/projects/equalizerapo/)** - Audio delay for syncing PC speakers with Nest

### Installation

1. **Download PC Nest Speaker** from [releases](https://github.com/Kepners/pcnestspeaker/releases)
2. Run the installer or portable exe
3. **On first launch** - The app will automatically install VB-Cable (requires admin + restart)
4. Done! Start streaming to your Nest speakers

### Usage

1. Launch PC Nest Speaker
2. Wait for speakers to be discovered
3. Click a speaker to start streaming
4. Your PC audio now plays on the Nest speaker!

## How It Works

```
PC Audio → VB-Cable Input → FFmpeg (captures from CABLE Output) → MediaMTX → WebRTC → Nest Speaker
```

The app uses WebRTC for sub-second latency streaming:
1. **VB-Cable** routes your PC audio through a virtual audio cable
2. **FFmpeg** captures from "CABLE Output" and encodes to Opus
3. **MediaMTX** bridges the RTSP stream to WebRTC
4. **Custom Cast receiver** on Nest speaker connects via WHEP protocol

For older devices that don't support custom receivers, the app falls back to HTTP/MP3 streaming (~8 second latency).

### PC + Speakers Mode (Optional)

Want audio on BOTH your Nest speakers AND your PC speakers simultaneously?

1. Install [Equalizer APO](https://sourceforge.net/projects/equalizerapo/) on your PC speakers
2. Enable "PC + Speakers" mode in the app
3. The app enables "Listen to this device" on VB-Cable → your PC speakers
4. Equalizer APO adds a delay (~500-700ms) to sync PC speakers with Nest

This lets you hear your music on both at the same time, perfectly synced!

## Controls

| Control | Action |
|---------|--------|
| Click speaker | Start/stop streaming to that speaker |
| Volume slider | Adjust speaker volume |
| Volume keys | PC volume keys control Nest (when streaming) |
| Tray icon | Double-click to show, right-click for menu |

### Window Controls

| Button | Symbol | Action |
|--------|--------|--------|
| Refresh | ↻ | Rediscover speakers on network |
| Minimize | − | Minimize window |
| Close | × | Hide to system tray (app keeps running) |
| Quit | ⏻ | Full exit - stops streaming, restores audio settings |

## Settings

| Setting | Description |
|---------|-------------|
| Auto-connect | Connect to last speaker on startup |
| Start with Windows | Launch app when Windows boots |
| Volume Boost | +25% signal boost (for quiet sources) |

## Stereo Mode

Click a speaker, then Ctrl+click another speaker to create a stereo pair:
- First speaker = Left channel
- Second speaker = Right channel

## Troubleshooting

### No speakers found
- Ensure PC and Nest are on the same Wi-Fi network
- Check Windows Firewall allows the app
- Restart the app

### No audio playing
- **Restart your PC** if you just installed VB-Cable (required for driver to work)
- Verify VB-Cable is installed - Check Sound settings for "CABLE Input" and "CABLE Output"
- Verify Windows audio is playing (test with YouTube)
- Check that the app set Windows default to "CABLE Input"
- Try the HTTP/MP3 fallback mode

### VB-Cable not showing up
- The app should auto-install VB-Cable on first launch
- If it didn't, re-run the app and accept the VB-Cable installation prompt
- Make sure you restart your PC after VB-Cable installs
- Manual install: [vb-audio.com/Cable](https://vb-audio.com/Cable/)

### PC + Speakers mode not working
- VB-Cable must be installed (not Virtual Desktop Audio)
- Install [Equalizer APO](https://sourceforge.net/projects/equalizerapo/) on your PC speakers
- Open APO Configurator and check your speakers are enabled

### High latency
- WebRTC mode provides sub-second latency
- Some older Nest devices may use HTTP fallback (~8 sec)
- Speaker groups may have additional sync delay

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

### Project Structure

```
pcnestspeaker/
├── src/
│   ├── main/          # Electron main process
│   └── renderer/      # UI (HTML/CSS/JS)
├── mediamtx/          # WebRTC server
├── ffmpeg/            # Audio encoding (download separately)
├── cast-receiver/     # Custom Cast receiver
└── docs/              # Documentation
```

## License

PC Nest Speaker is proprietary software. 10-hour free trial, then one-time purchase required.

- **Trial**: 10 hours of streaming time (not calendar time)
- **License**: PNS-XXXX-XXXX-XXXX-XXXX format
- **Devices**: Works on up to 2 computers per license

## Credits

- [FFmpeg](https://ffmpeg.org/) - Audio encoding
- [MediaMTX](https://github.com/bluenviron/mediamtx) - WebRTC streaming
- [pychromecast](https://github.com/home-assistant-libs/pychromecast) - Cast control
- [Electron](https://www.electronjs.org/) - Desktop framework
- [audioctl](https://github.com/Mr5niper/WindowsAudioControl-CLI-wGUI) - Windows audio control
- [NirSoft utilities](https://www.nirsoft.net/) - svcl.exe, nircmd.exe

## Support

- **Issues**: [GitHub Issues](https://github.com/Kepners/pcnestspeaker/issues)
- **Email**: support@choppedonions.xyz

---

Made by [ChoppedOnions.xyz](https://choppedonions.xyz)
