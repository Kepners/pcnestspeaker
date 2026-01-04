#!/usr/bin/env python3
"""
Nest Audio Bridge - Fixed Direct MP3 Version
Fixes: Machine gun noise (buffer underrun) with larger, more stable buffers
"""

import socket, subprocess, sys, time, threading
from flask import Flask, Response
import pychromecast

# Configuration
TARGET_SPEAKER = "Den pair"
PORT = 8000
DSHOW_DEVICE = 'audio=CABLE Output (VB-Audio Virtual Cable)'

# FIXED audio settings - larger buffers to prevent "machine gun" noise
AUDIO_RATE = "48000"
AUDIO_BITRATE = "128k"
AUDIO_CHANNELS = "2"
CHUNK_SIZE = 8192  # INCREASED from 4096 - prevents buffer underrun
AUDIO_BUFFER_SIZE = "100"  # INCREASED - more stable capture

app = Flask(__name__)
_ffmpeg_process = None

def get_local_ip():
    """Get the local IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

def start_ffmpeg_mp3():
    """Start FFmpeg with STABLE settings to prevent audio glitches."""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",

        # Input - LARGER buffer to prevent underruns
        "-f", "dshow",
        "-audio_buffer_size", AUDIO_BUFFER_SIZE,  # Increased for stability
        "-i", DSHOW_DEVICE,

        # Audio processing - MORE conservative
        "-af", "aresample=async=1:min_hard_comp=0.100000:first_pts=0",

        # Output settings
        "-ac", AUDIO_CHANNELS,
        "-ar", AUDIO_RATE,
        "-c:a", "libmp3lame",
        "-b:a", AUDIO_BITRATE,
        "-q:a", "2",

        # LESS aggressive latency flags
        "-fflags", "+nobuffer",

        # Add small buffer for stability
        "-bufsize", "256k",

        # Stream to stdout
        "-f", "mp3",
        "-"
    ]

    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=8192  # Match chunk size
    )

@app.route("/live.mp3")
def live_mp3():
    """Stream MP3 audio endpoint with STABLE buffering."""
    global _ffmpeg_process

    # Start or restart FFmpeg if needed
    if _ffmpeg_process is None or _ffmpeg_process.poll() is not None:
        _ffmpeg_process = start_ffmpeg_mp3()
        time.sleep(0.5)  # Give FFmpeg time to start

    def generate():
        """Generate audio chunks for streaming."""
        try:
            while True:
                # Read larger chunks for stability
                chunk = _ffmpeg_process.stdout.read(CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk
        except Exception as e:
            print(f"Stream error: {e}")
            # Try to restart FFmpeg
            global _ffmpeg_process
            _ffmpeg_process = start_ffmpeg_mp3()

    return Response(
        generate(),
        mimetype="audio/mpeg",
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        }
    )

def cast_to_speaker(speaker_name, media_url):
    """Cast audio stream to Chromecast speaker."""
    print(f"Discovering '{speaker_name}'...", end="", flush=True)
    chromecasts, browser = pychromecast.get_listed_chromecasts(
        friendly_names=[speaker_name]
    )

    if not chromecasts:
        browser.stop_discovery()
        print(" [FAIL]")
        raise RuntimeError(f"Speaker '{speaker_name}' not found.")

    print(" [OK]")
    cast = chromecasts[0]
    cast.wait()

    mc = cast.media_controller
    print(f"Casting to {speaker_name}...", end="", flush=True)
    mc.play_media(media_url, "audio/mpeg")
    mc.block_until_active()
    mc.play()
    print(" [OK]")

    browser.stop_discovery()

def main():
    """Main application entry point."""
    print("=" * 60)
    print("Nest Audio Bridge - Fixed Direct MP3 (Stable Buffers)")
    print("=" * 60)
    print()

    # Check FFmpeg
    from shutil import which
    if not which("ffmpeg"):
        print("ERROR: FFmpeg not found")
        sys.exit(1)

    # Get network info
    ip = get_local_ip()
    print(f"Local IP: {ip}")
    print(f"Target Speaker: {TARGET_SPEAKER}")
    print(f"Audio: {AUDIO_RATE}Hz @ {AUDIO_BITRATE}")
    print(f"Buffer: {AUDIO_BUFFER_SIZE}ms (increased for stability)")
    print()

    # Start Flask server
    print("Starting MP3 stream server...")
    flask_thread = threading.Thread(
        target=lambda: app.run(
            host="0.0.0.0",
            port=PORT,
            debug=False,
            use_reloader=False,
            threaded=True
        ),
        daemon=True
    )
    flask_thread.start()
    time.sleep(2)
    print("[OK] Server ready")
    print()

    # Build streaming URL
    url = f"http://{ip}:{PORT}/live.mp3"
    print(f"Stream URL: {url}")
    print()

    # Start streaming and cast
    try:
        # Pre-start FFmpeg
        global _ffmpeg_process
        _ffmpeg_process = start_ffmpeg_mp3()
        time.sleep(1.5)  # Give more time to start

        cast_to_speaker(TARGET_SPEAKER, url)
        print()
        print("=" * 60)
        print("[OK] MP3 Casting Active - Stable Buffer Mode")
        print("=" * 60)
        print()
        print("If you still hear glitches:")
        print("  1. Check 'CABLE Output' is receiving audio")
        print("  2. Set Windows to 48000Hz (Sound Settings)")
        print("  3. Close other audio applications")
        print()
        print("Press Ctrl+C to stop")
        print()

        # Keep running
        while True:
            time.sleep(1)

    except KeyboardInterrupt:
        print("\nStopping...")
    except Exception as e:
        print(f"\nERROR: {e}")
    finally:
        if _ffmpeg_process:
            _ffmpeg_process.terminate()
        print("[OK] Stopped")

if __name__ == "__main__":
    main()
