# cast_system_audio_to_nest_v2.py
# Windows 11: Stream system audio to Google Nest / stereo pair over Wi-Fi.
# Adds: better logging, device listing, fallback to progressive MP3 if HLS doesn't play.
#
# Requirements: FFmpeg in PATH, VB-CABLE installed, Python packages: pychromecast, Flask

import os, sys, time, socket, subprocess, threading, pathlib
from typing import Optional, List
import http.server, socketserver
import pychromecast
from flask import Flask, Response

# -------- SET THIS --------
TARGET_SPEAKER = "Den pair"  # e.g. "Study Pair"
# --------------------------

PORT = 8000
OUTDIR = pathlib.Path("out_v2")
HLS_DIR = OUTDIR / "hls"
HLS_PLAYLIST = HLS_DIR / "stream.m3u8"

DSHOW_DEVICE = 'audio=CABLE Output (VB-Audio Virtual Cable)'
AUDIO_RATE = "44100"
AUDIO_BITRATE = "192k"

def which(name:str)->Optional[str]:
    from shutil import which as _which
    return _which(name)

def local_ip()->str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

def list_cast_devices()->List[str]:
    chromecasts, browser = pychromecast.get_chromecasts()
    names = [cc.name for cc in chromecasts]
    browser.stop_discovery()
    return names

def cast_url(speaker_name:str, url:str, content_type:str)->None:
    chromecasts, browser = pychromecast.get_listed_chromecasts(friendly_names=[speaker_name])
    if not chromecasts:
        all_names = list_cast_devices()
        browser.stop_discovery()
        raise RuntimeError(f"Speaker '{speaker_name}' not found. Available: {all_names}")
    cast = chromecasts[0]
    cast.wait()
    mc = cast.media_controller
    mc.play_media(url, content_type)
    mc.block_until_active()
    mc.play()
    browser.stop_discovery()

def start_http_static(dirpath:pathlib.Path, port:int):
    handler = http.server.SimpleHTTPRequestHandler
    httpd = socketserver.TCPServer(("", port), handler)
    os.chdir(dirpath)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd

def start_ffmpeg_hls(outdir:pathlib.Path):
    outdir.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg","-hide_banner",
        "-f","dshow","-i", DSHOW_DEVICE,
        "-ac","2","-ar",AUDIO_RATE,
        "-c:a","aac","-b:a",AUDIO_BITRATE,
        "-f","hls",
        "-hls_time","2",
        "-hls_list_size","7",
        "-hls_flags","delete_segments+append_list+program_date_time",
        "stream.m3u8"
    ]
    return subprocess.Popen(cmd, cwd=str(outdir))

def wait_for(path:pathlib.Path, timeout:float)->bool:
    t0 = time.time()
    while time.time()-t0 < timeout:
        if path.exists() and path.stat().st_size>0:
            time.sleep(1.5)
            return True
        time.sleep(0.2)
    return False

# Progressive MP3 fallback using Flask + FFmpeg pipe
app = Flask(__name__)
_ffmpeg_proc = None

def start_ffmpeg_mp3()->subprocess.Popen:
    OUTDIR.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg","-hide_banner",
        "-f","dshow","-i", DSHOW_DEVICE,
        "-ac","2","-ar",AUDIO_RATE,
        "-c:a","libmp3lame","-b:a",AUDIO_BITRATE,
        "-f","mp3","-"
    ]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)

@app.route("/live.mp3")
def live_mp3():
    def generate():
        global _ffmpeg_proc
        if _ffmpeg_proc is None or _ffmpeg_proc.poll() is not None:
            _ffmpeg_proc = start_ffmpeg_mp3()
        while True:
            chunk = _ffmpeg_proc.stdout.read(4096)
            if not chunk:
                break
            yield chunk
    return Response(generate(), mimetype="audio/mpeg")

def start_flask_in_thread(port:int):
    thread = threading.Thread(target=lambda: app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False), daemon=True)
    thread.start()
    return thread

def main():
    if not which("ffmpeg"):
        print("FFmpeg not found. Install it and add to PATH.")
        sys.exit(1)
    if TARGET_SPEAKER == "YOUR STEREO PAIR NAME":
        print("Edit TARGET_SPEAKER to your exact stereo pair name from Google Home.")
        sys.exit(1)

    ip = local_ip()
    print(f"Local IP: {ip}")
    print("1) Serving static files from ./out_v2 on port", PORT)
    httpd = start_http_static(OUTDIR, PORT)

    print("2) Starting HLS encoder...")
    hls_proc = start_ffmpeg_hls(HLS_DIR)
    if not wait_for(HLS_PLAYLIST, 20):
        print("HLS playlist did not appear. Check your Windows output is 'CABLE Input'.")
    else:
        hls_url = f"http://{ip}:{PORT}/hls/stream.m3u8"
        print("HLS URL:", hls_url)
        try:
            print(f"Casting HLS to '{TARGET_SPEAKER}'...")
            cast_url(TARGET_SPEAKER, hls_url, "application/x-mpegURL")
            print("Casting started with HLS. If you still hear nothing after 10 seconds, press Ctrl+C to stop and run again.")
            while True:
                time.sleep(1)
        except Exception as e:
            print("HLS cast failed:", e)

    print("3) Falling back to progressive MP3 stream at /live.mp3")
    start_flask_in_thread(PORT)
    mp3_url = f"http://{ip}:{PORT}/live.mp3"
    print("MP3 URL:", mp3_url)
    try:
        print(f"Casting MP3 to '{TARGET_SPEAKER}'...")
        cast_url(TARGET_SPEAKER, mp3_url, "audio/mpeg")
        print("Casting started with MP3. Leave this window open. Press Ctrl+C to stop.")
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print("MP3 cast failed:", e)
    finally:
        try:
            hls_proc.terminate()
        except Exception:
            pass

if __name__ == "__main__":
    main()
