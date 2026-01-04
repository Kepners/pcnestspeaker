#!/usr/bin/env python3
"""
PC Nest Speaker - Full Streaming Test
Streams system audio to a selected Nest speaker using HLS with MP3 fallback.

Run: python stream_to_nest.py
"""

import os
import socket
import subprocess
import sys
import time
import threading
import pathlib
import re
from shutil import which

import pychromecast
from flask import Flask, Response

# Configuration
PORT = 8000
OUTDIR = pathlib.Path("hls_out")
PLAYLIST = OUTDIR / "stream.m3u8"

# Audio settings (optimized from reference code)
AUDIO_RATE = "48000"
AUDIO_CHANNELS = "2"
AUDIO_BITRATE = "128k"
HLS_SEGMENT_TIME = "0.5"
HLS_LIST_SIZE = "3"
CHUNK_SIZE = 8192
AUDIO_BUFFER_SIZE = "100"

# Audio device priority
AUDIO_DEVICES = [
    "virtual-audio-capturer",
    "CABLE Output (VB-Audio Virtual Cable)",
]

# Flask app for MP3 fallback
app = Flask(__name__)
_ffmpeg_mp3_process = None


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


def list_audio_devices():
    """List available DirectShow audio devices."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True,
            text=True,
            timeout=10
        )
        audio_devices = []
        for line in result.stderr.split('\n'):
            if '(audio)' in line:
                match = re.search(r'"([^"]+)"', line)
                if match:
                    audio_devices.append(match.group(1))
        return audio_devices
    except Exception:
        return []


def find_capture_device():
    """Find the best available audio capture device."""
    available = list_audio_devices()
    for preferred in AUDIO_DEVICES:
        for avail in available:
            if preferred.lower() in avail.lower():
                return avail
    return None


def discover_speakers():
    """Discover Chromecast/Nest speakers on network."""
    print("Discovering speakers...")
    chromecasts, browser = pychromecast.get_chromecasts()
    speakers = []
    for cc in chromecasts:
        info = cc.cast_info
        speakers.append({
            "name": info.friendly_name,
            "model": info.model_name,
            "ip": info.host,
            "type": info.cast_type,
            "chromecast": cc
        })
    browser.stop_discovery()
    return speakers


def select_speaker(speakers):
    """Let user select a speaker from the list."""
    print("\nAvailable speakers:")
    for i, sp in enumerate(speakers):
        print(f"  {i + 1}. {sp['name']} ({sp['model']}) [{sp['type']}]")

    while True:
        try:
            choice = input("\nSelect speaker (number): ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(speakers):
                return speakers[idx]
        except ValueError:
            pass
        print("Invalid choice. Try again.")


def start_http_server(dirpath, port):
    """Start HTTP server for HLS streaming."""
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
    """Start FFmpeg with HLS output."""
    outdir.mkdir(parents=True, exist_ok=True)

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
        "-hls_time", HLS_SEGMENT_TIME,
        "-hls_list_size", HLS_LIST_SIZE,
        "-hls_flags", "delete_segments+independent_segments",
        "-hls_segment_type", "mpegts",
        "-hls_segment_filename", str(outdir / "seg%d.ts"),
        "-fflags", "+genpts+nobuffer",
        "-flags", "low_delay",
        str(outdir / "stream.m3u8")
    ]

    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def start_ffmpeg_mp3(device):
    """Start FFmpeg with MP3 output for Flask streaming."""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-f", "dshow",
        "-audio_buffer_size", AUDIO_BUFFER_SIZE,
        "-i", f"audio={device}",
        "-af", "aresample=async=1:min_hard_comp=0.100000:first_pts=0",
        "-ac", AUDIO_CHANNELS,
        "-ar", AUDIO_RATE,
        "-c:a", "libmp3lame",
        "-b:a", AUDIO_BITRATE,
        "-q:a", "2",
        "-fflags", "+nobuffer",
        "-bufsize", "256k",
        "-f", "mp3",
        "-"
    ]

    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=CHUNK_SIZE)


@app.route("/live.mp3")
def live_mp3():
    """MP3 streaming endpoint."""
    global _ffmpeg_mp3_process

    def generate():
        global _ffmpeg_mp3_process
        while True:
            if _ffmpeg_mp3_process is None or _ffmpeg_mp3_process.poll() is not None:
                break
            chunk = _ffmpeg_mp3_process.stdout.read(CHUNK_SIZE)
            if not chunk:
                break
            yield chunk

    return Response(
        generate(),
        mimetype="audio/mpeg",
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        }
    )


def start_flask_server(port):
    """Start Flask server for MP3 streaming."""
    thread = threading.Thread(
        target=lambda: app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False, threaded=True),
        daemon=True
    )
    thread.start()
    return thread


def wait_for_playlist(pl, timeout=20):
    """Wait for HLS playlist to be created."""
    print("Waiting for stream to start", end="", flush=True)
    start = time.time()
    while time.time() - start < timeout:
        if pl.exists() and pl.stat().st_size > 0:
            time.sleep(1)
            print(" [OK]")
            return True
        time.sleep(0.3)
        print(".", end="", flush=True)
    print(" [TIMEOUT]")
    return False


def cast_to_speaker(speaker, url, content_type):
    """Cast audio to speaker."""
    print(f"Connecting to {speaker['name']}...", end=" ", flush=True)

    cast = speaker['chromecast']
    cast.wait()

    mc = cast.media_controller
    mc.play_media(url, content_type)
    mc.block_until_active()
    mc.play()
    print("[OK]")


def main():
    """Main entry point."""
    print("=" * 60)
    print("PC Nest Speaker - Streaming Test")
    print("=" * 60)
    print()

    # Check FFmpeg
    if not which("ffmpeg"):
        print("ERROR: FFmpeg not found")
        sys.exit(1)

    # Find audio device
    device = find_capture_device()
    if not device:
        print("ERROR: No audio capture device found")
        print("Install VB-CABLE or virtual-audio-capturer")
        sys.exit(1)

    print(f"Audio Device: {device}")

    # Get IP
    ip = get_local_ip()
    print(f"Local IP: {ip}")

    # Discover speakers
    speakers = discover_speakers()
    if not speakers:
        print("ERROR: No speakers found")
        sys.exit(1)

    # Select speaker
    speaker = select_speaker(speakers)
    print(f"\nSelected: {speaker['name']}")

    # Start HTTP server
    print("\nStarting HTTP server...")
    httpd = start_http_server(OUTDIR, PORT)

    # Try HLS first
    print("Starting HLS stream...")
    hls_process = start_ffmpeg_hls(device, OUTDIR)

    hls_success = False
    if wait_for_playlist(PLAYLIST):
        hls_url = f"http://{ip}:{PORT}/stream.m3u8"
        print(f"HLS URL: {hls_url}")

        try:
            cast_to_speaker(speaker, hls_url, "application/x-mpegURL")
            hls_success = True
            print("\n" + "=" * 60)
            print("[OK] HLS Streaming Active")
            print("=" * 60)
            print("\nPress Ctrl+C to stop")

            while True:
                if hls_process.poll() is not None:
                    print("WARNING: FFmpeg stopped")
                    break
                time.sleep(1)

        except KeyboardInterrupt:
            print("\nStopping...")
        except Exception as e:
            print(f"HLS casting failed: {e}")

    # Fallback to MP3
    if not hls_success:
        print("\nFalling back to MP3 stream...")
        hls_process.terminate()

        global _ffmpeg_mp3_process
        _ffmpeg_mp3_process = start_ffmpeg_mp3(device)
        start_flask_server(PORT)
        time.sleep(2)

        mp3_url = f"http://{ip}:{PORT}/live.mp3"
        print(f"MP3 URL: {mp3_url}")

        try:
            cast_to_speaker(speaker, mp3_url, "audio/mpeg")
            print("\n" + "=" * 60)
            print("[OK] MP3 Streaming Active")
            print("=" * 60)
            print("\nPress Ctrl+C to stop")

            while True:
                time.sleep(1)

        except KeyboardInterrupt:
            print("\nStopping...")
        except Exception as e:
            print(f"MP3 casting failed: {e}")
        finally:
            if _ffmpeg_mp3_process:
                _ffmpeg_mp3_process.terminate()

    # Cleanup
    try:
        hls_process.terminate()
    except Exception:
        pass

    print("[OK] Stopped")


if __name__ == "__main__":
    main()
