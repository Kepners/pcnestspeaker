# WindowsAudioControl-CLI (audioctl.exe)

This folder should contain `audioctl.exe` - a Windows audio control CLI tool that manages "Listen to this device" functionality.

## Download

1. Go to: https://github.com/Mr5niper/WindowsAudioControl-CLI-wGUI/releases
2. Download `audioctl.exe` (15 MB) from the latest release
3. Place it in this folder: `audioctl/audioctl.exe`

## Direct Download Links (v1.4.3.2)

- **audioctl.exe**: https://github.com/Mr5niper/WindowsAudioControl-CLI-wGUI/releases/download/Audioctl_v1.4.3.2/audioctl.exe
- **ZIP archive**: https://github.com/Mr5niper/WindowsAudioControl-CLI-wGUI/releases/download/Audioctl_v1.4.3.2/Audioctl.exe_v1.4.3.2.zip

## Why This Tool?

The Windows "Listen to this device" feature doesn't have a public API. This tool uses pycaw (Python Core Audio Windows library) to properly enable/disable Listen just like the Windows Sound UI does.

## Commands Used by PC Nest Speaker

```bash
# Enable Listen on a capture device (route to default output)
audioctl listen --name "Virtual Desktop Audio" --flow Capture --enable --playback-target-id ""

# Disable Listen on a capture device
audioctl listen --name "Virtual Desktop Audio" --flow Capture --disable
```

## Troubleshooting

- **Permission errors**: Some operations may require Administrator privileges
- **Device not found**: Use `audioctl list --json` to see available devices
- **Multiple devices with same name**: Use `--index N` (0-based) to disambiguate

## Version

Tested with: v1.4.3.2 (December 2024)
