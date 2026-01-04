#!/usr/bin/env python3
"""Quick test - Stream to DENNIS"""

import socket
import subprocess
import sys
import time
import threading
import pathlib
import re
from shutil import which

import pychromecast

# Target speaker
TARGET_SPEAKER = "DENNIS"

# Configuration
PORT = 8000
OUTDIR = pathlib.Path("hls_out")

# Audio settings
AUDIO_RATE = "48000"
AUDIO_CHANNELS = "2"
AUDIO_BITRATE = "128k"


def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def find_audio_device():
    result = subprocess.run(
        ["ffmpeg", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        capture_output=True, text=True, timeout=10
    )
    for line in result.stderr.split('\n'):
        if 'CABLE Output' in line or 'virtual-audio-capturer' in line:
            match = re.search(r'"([^"]+)"', line)
            if match:
                return match.group(1)
    return None


def start_http_server(dirpath, port):
    import http.server
    import socketserver

    dirpath.mkdir(parents=True, exist_ok=True)

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(dirpath), **kwargs)

    httpd = socketserver.TCPServer(("", port), QuietHandler)
    httpd.allow_reuse_address = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def start_ffmpeg_hls(device, outdir):
    outdir.mkdir(parents=True, exist_ok=True)

    # Clean old files
    for f in outdir.glob("*.ts"):
        f.unlink()
    for f in outdir.glob("*.m3u8"):
        f.unlink()

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-f", "dshow",
        "-audio_buffer_size", "50",
        "-i", f"audio={device}",
        "-af", "aresample=async=1:first_pts=0",
        "-ac", AUDIO_CHANNELS,
        "-ar", AUDIO_RATE,
        "-c:a", "aac",
        "-b:a", AUDIO_BITRATE,
        "-profile:a", "aac_low",
        "-f", "hls",
        "-hls_time", "0.5",
        "-hls_list_size", "3",
        "-hls_flags", "delete_segments+independent_segments",
        "-hls_segment_type", "mpegts",
        "-hls_segment_filename", str(outdir / "seg%d.ts"),
        "-fflags", "+genpts+nobuffer",
        "-flags", "low_delay",
        str(outdir / "stream.m3u8")
    ]

    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def main():
    print("=" * 50)
    print(f"Streaming to {TARGET_SPEAKER}")
    print("=" * 50)
    print()

    # Find audio device
    device = find_audio_device()
    if not device:
        print("ERROR: No audio device found")
        sys.exit(1)
    print(f"Audio: {device}")

    ip = get_local_ip()
    print(f"IP: {ip}")

    # Find speaker
    print(f"\nFinding {TARGET_SPEAKER}...")
    chromecasts, browser = pychromecast.get_listed_chromecasts(
        friendly_names=[TARGET_SPEAKER]
    )

    if not chromecasts:
        print(f"ERROR: {TARGET_SPEAKER} not found")
        browser.stop_discovery()
        sys.exit(1)

    cast = chromecasts[0]
    print(f"Found: {cast.cast_info.friendly_name} @ {cast.cast_info.host}")

    # Start HTTP server
    print("\nStarting server...")
    httpd = start_http_server(OUTDIR, PORT)

    # Start FFmpeg
    print("Starting FFmpeg...")
    ff_process = start_ffmpeg_hls(device, OUTDIR)

    # Wait for playlist
    playlist = OUTDIR / "stream.m3u8"
    print("Waiting for stream", end="", flush=True)
    for _ in range(40):
        if playlist.exists() and playlist.stat().st_size > 0:
            time.sleep(1)
            print(" [OK]")
            break
        time.sleep(0.5)
        print(".", end="", flush=True)
    else:
        print(" [TIMEOUT]")
        ff_process.terminate()
        browser.stop_discovery()
        sys.exit(1)

    # Cast
    url = f"http://{ip}:{PORT}/stream.m3u8"
    print(f"\nCasting: {url}")

    cast.wait()
    mc = cast.media_controller
    mc.play_media(url, "application/x-mpegURL")
    mc.block_until_active()
    mc.play()

    print("\n" + "=" * 50)
    print("STREAMING ACTIVE")
    print("=" * 50)
    print("\nPlay some audio on your PC to hear it on the speaker.")
    print("Press Ctrl+C to stop.\n")

    browser.stop_discovery()

    try:
        while True:
            if ff_process.poll() is not None:
                stderr = ff_process.stderr.read().decode('utf-8', errors='ignore')
                print(f"FFmpeg stopped: {stderr}")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping...")

    ff_process.terminate()
    print("Stopped.")


if __name__ == "__main__":
    main()
