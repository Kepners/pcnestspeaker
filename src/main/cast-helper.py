#!/usr/bin/env python3
"""
Cast helper - uses pychromecast which actually works with Nest devices
Called by the Electron app for speaker discovery and casting
"""
import sys
import json
import pychromecast

# Custom Cast receiver App ID (registered with Google Cast SDK)
# Receiver URL: https://kepners.github.io/pcnestspeaker/receiver.html
CUSTOM_APP_ID = "FCAA4619"

def discover_speakers(timeout=8):
    """Discover all Chromecast/Nest speakers on the network."""
    try:
        print("Scanning network...", file=sys.stderr)
        chromecasts, browser = pychromecast.get_chromecasts(timeout=timeout)

        speakers = []
        for cc in chromecasts:
            # pychromecast 13+ uses cast_info for host/port
            info = cc.cast_info
            speakers.append({
                "name": cc.name,
                "model": info.model_name or "Chromecast",
                "ip": info.host,
                "port": info.port
            })
            print(f"Found: {cc.name} ({info.host})", file=sys.stderr)

        browser.stop_discovery()
        return {"success": True, "speakers": speakers}

    except Exception as e:
        return {"success": False, "error": str(e)}

def cast_to_speaker(speaker_name, media_url, content_type="application/x-mpegURL"):
    """Cast media to a speaker using pychromecast with custom low-latency receiver."""
    try:
        print(f"Looking for '{speaker_name}'...", file=sys.stderr)

        # Discover the specific speaker (timeout=10 to ensure we find it)
        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )

        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        # Use cast_info for host (pychromecast 13+)
        host = cast.cast_info.host if hasattr(cast, 'cast_info') else 'unknown'
        print(f"Connecting to {host}...", file=sys.stderr)
        cast.wait()

        # Set volume to 50% and play connection notification sound
        print("Setting volume to 50%...", file=sys.stderr)
        cast.set_volume(0.5)

        import time
        mc = cast.media_controller

        # Play ping sound (same as direct test that worked)
        print("Playing ping sound...", file=sys.stderr)
        mc.play_media("http://commondatastorage.googleapis.com/codeskulptor-assets/Collision8-Bit.ogg", "audio/ogg")
        mc.block_until_active(timeout=10)
        print("Ping played!", file=sys.stderr)

        # Wait for ping to finish
        time.sleep(2)

        # Try custom low-latency receiver, fallback to default if fails
        try:
            print(f"Launching custom receiver (App ID: {CUSTOM_APP_ID})...", file=sys.stderr)
            cast.start_app(CUSTOM_APP_ID)
            time.sleep(3)
            print("Custom receiver loaded!", file=sys.stderr)
        except Exception as e:
            print(f"Custom receiver failed ({e}), using default...", file=sys.stderr)

        print(f"Playing stream: {media_url}", file=sys.stderr)
        mc.play_media(media_url, content_type, stream_type="LIVE")
        mc.block_until_active(timeout=30)

        browser.stop_discovery()
        print("Playback started with low-latency receiver!", file=sys.stderr)

        return {"success": True, "state": "PLAYING", "app_id": CUSTOM_APP_ID}

    except Exception as e:
        return {"success": False, "error": str(e)}

def stop_cast(speaker_name):
    """Stop casting to a speaker."""
    try:
        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )

        if chromecasts:
            cast = chromecasts[0]
            cast.wait()
            cast.quit_app()

        browser.stop_discovery()
        return {"success": True}

    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No command specified"}))
        sys.exit(1)

    command = sys.argv[1]

    if command == "discover":
        result = discover_speakers()
        print(json.dumps(result))

    elif command == "ping" and len(sys.argv) >= 3:
        # Simple ping test - based on official pychromecast media_example.py
        speaker = sys.argv[2]
        try:
            import time
            print(f"Pinging '{speaker}'...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(friendly_names=[speaker])
            if chromecasts:
                cast = chromecasts[0]
                host = cast.cast_info.host if hasattr(cast, 'cast_info') else 'unknown'
                print(f"Connecting to {host}...", file=sys.stderr)
                cast.wait()
                print(f"Cast type: {cast.cast_type}, Model: {cast.model_name}", file=sys.stderr)

                cast.set_volume(0.4)
                print("Playing ping sound...", file=sys.stderr)
                cast.media_controller.play_media(
                    "http://commondatastorage.googleapis.com/codeskulptor-assets/Collision8-Bit.ogg",
                    "audio/ogg"
                )

                # Poll for state change (official example pattern)
                for i in range(50):  # 5 seconds max
                    time.sleep(0.1)
                    state = cast.media_controller.status.player_state
                    if state == "PLAYING":
                        print(f"Player state: PLAYING", file=sys.stderr)
                        break
                    if i == 49:
                        print(f"Final state: {state}", file=sys.stderr)

                # Wait for sound to finish
                time.sleep(2)
                browser.stop_discovery()
                print("Ping sent!", file=sys.stderr)
                print(json.dumps({"success": True}))
            else:
                browser.stop_discovery()
                print(json.dumps({"success": False, "error": "Speaker not found"}))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))

    elif command == "cast" and len(sys.argv) >= 4:
        speaker = sys.argv[2]
        url = sys.argv[3]
        content_type = sys.argv[4] if len(sys.argv) > 4 else "audio/mpeg"
        result = cast_to_speaker(speaker, url, content_type)
        print(json.dumps(result))

    elif command == "stop" and len(sys.argv) >= 3:
        speaker = sys.argv[2]
        result = stop_cast(speaker)
        print(json.dumps(result))

    else:
        print(json.dumps({"success": False, "error": "Invalid command"}))
        sys.exit(1)
