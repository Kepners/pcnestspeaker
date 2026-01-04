#!/usr/bin/env python3
"""
Nest Audio Bridge - Fixed HLS Version
Fixes: Directory error, truly live streaming with minimal clip storage
"""

import os, socket, subprocess, sys, time, pathlib, threading
import http.server, socketserver
import pychromecast

# Configuration
TARGET_SPEAKER = "Den pair"
PORT = 8000
OUTDIR = pathlib.Path("hls_out_improved")
PLAYLIST = OUTDIR / "stream.m3u8"
DSHOW_DEVICE = 'audio=CABLE Output (VB-Audio Virtual Cable)'

# Optimized audio settings
AUDIO_RATE = "48000"
AUDIO_CHANNELS = "2"
AUDIO_BITRATE = "128k"
HLS_SEGMENT_TIME = "0.5"
HLS_LIST_SIZE = "3"  # Reduced from 10 - only keep 3 clips (1.5s of history)

def which_ffmpeg():
    """Check if ffmpeg is available."""
    from shutil import which
    return which("ffmpeg")

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

def start_http_server(dirpath, port):
    """Start HTTP server for HLS streaming."""
    # CREATE DIRECTORY FIRST - this was the bug!
    dirpath.mkdir(parents=True, exist_ok=True)

    class QuietHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass  # Suppress HTTP logs

        def __init__(self, *args, **kwargs):
            # Serve files from the dirpath
            super().__init__(*args, directory=str(dirpath), **kwargs)

    # Don't change directory - serve from dirpath directly
    httpd = socketserver.TCPServer(("", port), QuietHTTPRequestHandler)
    httpd.allow_reuse_address = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(f"[OK] HTTP server started on port {port}")
    return httpd

def start_ffmpeg_capture(outdir):
    """Start FFmpeg with optimized settings for truly live streaming."""
    outdir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",

        # Input - Windows audio capture
        "-f", "dshow",
        "-audio_buffer_size", "50",
        "-i", DSHOW_DEVICE,

        # Audio processing
        "-af", "aresample=async=1:first_pts=0,aformat=sample_rates=48000:channel_layouts=stereo",

        # Output format
        "-ac", AUDIO_CHANNELS,
        "-ar", AUDIO_RATE,
        "-c:a", "aac",
        "-b:a", AUDIO_BITRATE,
        "-profile:a", "aac_low",

        # LIVE streaming HLS - minimal clip storage
        "-f", "hls",
        "-hls_time", HLS_SEGMENT_TIME,
        "-hls_list_size", HLS_LIST_SIZE,  # Only 3 clips max
        "-hls_flags", "delete_segments+independent_segments",  # Auto-delete old clips
        "-hls_segment_type", "mpegts",
        "-hls_segment_filename", str(outdir / "seg%d.ts"),
        "-start_number", "0",

        # Low latency flags
        "-fflags", "+genpts+nobuffer",
        "-flags", "low_delay",
        "-tune", "zerolatency",

        # Output
        str(outdir / "stream.m3u8")
    ]

    print("Starting FFmpeg with live streaming (minimal clip storage)...")
    print(f"  Sample Rate: {AUDIO_RATE}Hz")
    print(f"  Bitrate: {AUDIO_BITRATE}")
    print(f"  Segment Time: {HLS_SEGMENT_TIME}s")
    print(f"  Max Clips Stored: {HLS_LIST_SIZE} (auto-deleted)")

    return subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE
    )

def wait_for_playlist(pl, timeout=20):
    """Wait for HLS playlist to be created."""
    print("Waiting for audio stream to start...", end="", flush=True)
    start = time.time()
    while time.time() - start < timeout:
        if pl.exists() and pl.stat().st_size > 0:
            time.sleep(1)
            print(" [OK]")
            return True
        time.sleep(0.3)
        print(".", end="", flush=True)
    print(" [FAIL]")
    return False

def cast_to_speaker(speaker_name, media_url):
    """Cast audio stream to Chromecast speaker."""
    print(f"Discovering '{speaker_name}'...", end="", flush=True)
    chromecasts, browser = pychromecast.get_listed_chromecasts(
        friendly_names=[speaker_name]
    )

    if not chromecasts:
        browser.stop_discovery()
        print(" [FAIL]")
        raise RuntimeError(f"Speaker '{speaker_name}' not found on network.")

    print(" [OK]")
    cast = chromecasts[0]
    cast.wait()

    mc = cast.media_controller
    print(f"Casting to {speaker_name}...", end="", flush=True)
    mc.play_media(media_url, "application/x-mpegURL")
    mc.block_until_active()
    mc.play()
    print(" [OK]")

    browser.stop_discovery()

def main():
    """Main application entry point."""
    print("=" * 60)
    print("Nest Audio Bridge - Fixed HLS Version")
    print("Live Streaming (Minimal Clip Storage)")
    print("=" * 60)
    print()

    # Check dependencies
    if not which_ffmpeg():
        print("ERROR: FFmpeg not found in PATH")
        print("Install from: https://ffmpeg.org/download.html")
        sys.exit(1)

    # Get network info
    ip = get_local_ip()
    print(f"Local IP: {ip}")
    print(f"Target Speaker: {TARGET_SPEAKER}")
    print()

    # Start HTTP server (creates directory inside now)
    httpd = start_http_server(OUTDIR, PORT)

    # Start FFmpeg capture
    ff_process = start_ffmpeg_capture(OUTDIR)

    # Wait for playlist
    if not wait_for_playlist(PLAYLIST, 20):
        ff_process.terminate()
        print()
        print("ERROR: No audio stream detected.")
        print("Please check:")
        print("  1. VB-Cable is installed")
        print("  2. Windows output is set to 'CABLE Input'")
        print("  3. Audio is playing (YouTube, Spotify, etc.)")
        print("  4. 'CABLE Output' recording meter is active")
        sys.exit(1)

    # Build streaming URL
    url = f"http://{ip}:{PORT}/stream.m3u8"
    print()
    print(f"Stream URL: {url}")
    print()

    # Cast to speaker
    try:
        cast_to_speaker(TARGET_SPEAKER, url)
        print()
        print("=" * 60)
        print("[OK] LIVE Casting Active - Only 3 clips stored at a time")
        print("=" * 60)
        print()
        print("Press Ctrl+C to stop")
        print()

        # Monitor FFmpeg
        while True:
            if ff_process.poll() is not None:
                print("WARNING: FFmpeg stopped unexpectedly")
                stderr = ff_process.stderr.read().decode('utf-8', errors='ignore')
                if stderr:
                    print(f"Error: {stderr}")
                break
            time.sleep(1)

    except KeyboardInterrupt:
        print("\nStopping...")
    except Exception as e:
        print(f"\nERROR: {e}")
    finally:
        try:
            ff_process.terminate()
            ff_process.wait(timeout=5)
        except Exception:
            ff_process.kill()
        print("[OK] Stopped")

if __name__ == "__main__":
    main()
