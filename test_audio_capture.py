#!/usr/bin/env python3
"""
PC Nest Speaker - Audio Capture Test Script
Tests available audio capture devices and speaker discovery.

Run: python test_audio_capture.py
"""

import subprocess
import socket
import sys
import re
from shutil import which

# Audio device priority (first found = used)
AUDIO_DEVICES = [
    "virtual-audio-capturer",  # Preferred: WASAPI loopback
    "CABLE Output (VB-Audio Virtual Cable)",  # Fallback: VB-CABLE
]


def check_ffmpeg():
    """Check if FFmpeg is installed."""
    print("Checking FFmpeg...", end=" ")
    if which("ffmpeg"):
        print("[OK]")
        return True
    print("[NOT FOUND]")
    print("  Install FFmpeg: https://ffmpeg.org/download.html")
    return False


def list_audio_devices():
    """List available DirectShow audio devices."""
    print("\nScanning audio devices...")
    try:
        result = subprocess.run(
            ["ffmpeg", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True,
            text=True,
            timeout=10
        )
        # FFmpeg outputs device list to stderr
        output = result.stderr

        # Parse audio devices
        audio_devices = []
        lines = output.split('\n')
        capture_next = False

        for line in lines:
            if '(audio)' in line:
                # Extract device name between quotes
                match = re.search(r'"([^"]+)"', line)
                if match:
                    audio_devices.append(match.group(1))

        return audio_devices
    except Exception as e:
        print(f"  Error: {e}")
        return []


def find_capture_device(available_devices):
    """Find the best available audio capture device."""
    print("\nLooking for audio capture device...")

    for preferred in AUDIO_DEVICES:
        for available in available_devices:
            if preferred.lower() in available.lower():
                print(f"  [OK] Found: {available}")
                return available

    print("  [NOT FOUND] No supported audio capture device found")
    print("\n  Options:")
    print("    1. Install Virtual Audio Capturer:")
    print("       https://sourceforge.net/projects/screencapturer/files/")
    print("    2. Install VB-CABLE:")
    print("       https://vb-audio.com/Cable/")
    return None


def check_pychromecast():
    """Check if pychromecast is installed."""
    print("\nChecking pychromecast...", end=" ")
    try:
        import pychromecast
        print("[OK]")
        return True
    except ImportError:
        print("[NOT INSTALLED]")
        print("  Run: pip install pychromecast")
        return False


def discover_speakers():
    """Discover Chromecast/Nest speakers on network."""
    print("\nDiscovering speakers (this may take 10-15 seconds)...")
    try:
        import pychromecast

        chromecasts, browser = pychromecast.get_chromecasts()
        browser.stop_discovery()

        if not chromecasts:
            print("  [NOT FOUND] No speakers found on network")
            print("\n  Troubleshooting:")
            print("    1. Ensure PC and Nest are on same Wi-Fi")
            print("    2. Check firewall allows Python through")
            print("    3. Try restarting the Nest speaker")
            return []

        speakers = []
        for cc in chromecasts:
            speakers.append({
                "name": cc.name,
                "model": cc.model_name,
                "ip": cc.host
            })
            print(f"  [OK] {cc.name} ({cc.model_name}) @ {cc.host}")

        return speakers
    except Exception as e:
        print(f"  Error: {e}")
        return []


def get_local_ip():
    """Get local IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def test_ffmpeg_capture(device_name, duration=3):
    """Test FFmpeg audio capture for a few seconds."""
    print(f"\nTesting audio capture ({duration}s)...")
    print(f"  Device: {device_name}")
    print("  (Play some audio on your PC to test)")

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-f", "dshow",
        "-i", f"audio={device_name}",
        "-t", str(duration),
        "-f", "null",
        "-"
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=duration + 5)
        if result.returncode == 0:
            print("  [OK] Audio capture working")
            return True
        else:
            print(f"  [FAILED] {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        print("  [TIMEOUT] FFmpeg didn't complete")
        return False
    except Exception as e:
        print(f"  [ERROR] {e}")
        return False


def main():
    """Run all tests."""
    print("=" * 60)
    print("PC Nest Speaker - System Test")
    print("=" * 60)

    ip = get_local_ip()
    print(f"\nLocal IP: {ip}")

    # Check FFmpeg
    if not check_ffmpeg():
        sys.exit(1)

    # List and find audio devices
    available = list_audio_devices()
    if available:
        print(f"  Found {len(available)} audio device(s):")
        for dev in available:
            print(f"    - {dev}")

    capture_device = find_capture_device(available)

    # Check pychromecast
    has_pychromecast = check_pychromecast()

    # Discover speakers
    speakers = []
    if has_pychromecast:
        speakers = discover_speakers()

    # Test audio capture
    if capture_device:
        test_ffmpeg_capture(capture_device)

    # Summary
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"  FFmpeg:         {'[OK]' if check_ffmpeg else '[MISSING]'}")
    print(f"  Audio Device:   {capture_device or '[NONE]'}")
    print(f"  pychromecast:   {'[OK]' if has_pychromecast else '[MISSING]'}")
    print(f"  Speakers Found: {len(speakers)}")

    if capture_device and has_pychromecast and speakers:
        print("\n  [READY] All systems ready for streaming!")
    else:
        print("\n  [INCOMPLETE] Some components missing - see above")


if __name__ == "__main__":
    main()
