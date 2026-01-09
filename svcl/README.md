# SoundVolumeCommandLine (svcl.exe)

## What is this?

SoundVolumeCommandLine (svcl.exe) is a NirSoft tool that allows controlling Windows audio settings from the command line, including the "Listen to this device" feature.

PC Nest Speaker uses this tool to route audio from Virtual Desktop Audio → HDMI speakers when in "PC + Speakers" mode.

## Download

1. Go to: https://www.nirsoft.net/utils/sound_volume_command_line.html
2. Download `SoundVolumeCommandLine.zip` (at the bottom of the page)
3. Extract `svcl.exe` to this folder

## Why is this needed?

For "PC + Speakers" mode to work correctly:
- Windows stays on Virtual Desktop Audio (for clean Cast capture)
- Audio is mirrored to HDMI speakers via "Listen to this device"
- APO delay only affects the HDMI path

This tool enables us to configure "Listen to this device" programmatically without requiring manual Windows Sound settings changes.

## Commands Used

```bash
# Enable listening from Virtual Desktop Audio to HDMI
svcl.exe /SetListenToThisDevice "Virtual Desktop Audio" "HDMI" 1

# Disable listening
svcl.exe /SetListenToThisDevice "Virtual Desktop Audio" "" 0
```

## License

SoundVolumeCommandLine is free for personal and commercial use.
https://www.nirsoft.net/utils/sound_volume_command_line.html
