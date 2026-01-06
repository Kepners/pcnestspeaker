# NirCmd - Windows Audio Device Switching

PC Nest Speaker uses **NirCmd** to automatically switch your Windows default audio device when streaming starts and restore it when streaming stops.

## What is NirCmd?

NirCmd is a tiny (47KB) command-line utility from NirSoft that allows you to perform various Windows operations without any UI.

**Official Website:** https://www.nirsoft.net/utils/nircmd.html

## Installation

### Option 1: Download Manually

1. Visit https://www.nirsoft.net/utils/nircmd.html
2. Download the 64-bit version: `nircmd-x64.zip`
3. Extract `nircmd.exe` from the zip file
4. Place `nircmd.exe` in this directory: `pcnestspeaker/nircmd/`

### Option 2: Direct Download Link

Download: https://www.nirsoft.net/utils/nircmd-x64.zip

After downloading, extract and place `nircmd.exe` here:
```
pcnestspeaker/
├── nircmd/
│   ├── nircmd.exe    <--- Place here
│   └── README.md     <--- You are here
```

## What PC Nest Speaker Uses NirCmd For

When you start streaming:
- **Saves** your current default audio device
- **Switches** to the virtual audio device (virtual-audio-capturer or VB-CABLE)

When you stop streaming:
- **Restores** your original audio device

This ensures your audio automatically routes through the app when streaming, and goes back to your normal speakers/headphones when you stop.

## Commands Used

```bash
# Get current audio device
wmic soundconfig get defaultsoundplayback /value

# Set default audio device
nircmd.exe setdefaultsounddevice "Device Name" 1
```

## Troubleshooting

**App says "NirCmd not found":**
- Make sure `nircmd.exe` is in the `nircmd/` folder
- Check that the filename is exactly `nircmd.exe` (not `nircmd-x64.exe`)

**Audio device not switching:**
- Check that virtual-audio-capturer or VB-CABLE is installed
- Try setting the device manually once in Windows Sound settings
- Restart the app

## License

NirCmd is **freeware** for personal and commercial use.

**Copyright:** Nir Sofer (NirSoft)
**License:** https://www.nirsoft.net/utils/nircmd.html
