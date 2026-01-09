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
- [screen-capture-recorder](https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases) (for virtual-audio-capturer)

### Installation

1. Install [screen-capture-recorder](https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases) - provides the virtual audio capture device
2. Download PC Nest Speaker from [releases](https://github.com/Kepners/pcnestspeaker/releases)
3. Run the installer or portable exe
4. Done!

### Usage

1. Launch PC Nest Speaker
2. Wait for speakers to be discovered
3. Click a speaker to start streaming
4. Your PC audio now plays on the Nest speaker!

## How It Works

```
PC Audio -> virtual-audio-capturer -> FFmpeg (Opus) -> MediaMTX -> WebRTC -> Cast Receiver -> Nest Speaker
```

The app uses WebRTC for sub-second latency streaming. A custom Cast receiver running on your Nest speaker connects to your local MediaMTX server (port 8889) via WHEP protocol to receive the WebRTC stream.

For older devices that don't support custom receivers, the app falls back to HTTP/MP3 streaming (~8 second latency).

## Controls

| Control | Action |
|---------|--------|
| Click speaker | Start/stop streaming to that speaker |
| Volume slider | Adjust speaker volume |
| Volume keys | PC volume keys control Nest (when streaming) |
| X button | Minimize to system tray |
| Tray icon | Double-click to show, right-click for menu |

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
- Verify Windows audio is playing (test with YouTube)
- Check virtual-audio-capturer is installed
- Try the HTTP/MP3 fallback mode

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
