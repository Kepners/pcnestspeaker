#!/usr/bin/env python3
"""
Cast helper - uses pychromecast which actually works with Nest devices
Called by the Electron app for speaker discovery and casting

Supports:
- discover: Find Chromecast/Nest speakers
- cast: HTTP streaming (MP3/HLS)
- webrtc: Launch custom receiver and relay signaling messages
- stop: Stop casting
"""
import sys
import json
import time
import threading
import pychromecast
from pychromecast.controllers import BaseController

# Custom receiver for WebRTC low-latency streaming
CUSTOM_APP_ID = "FCAA4619"
WEBRTC_NAMESPACE = "urn:x-cast:com.pcnestspeaker.webrtc"


class WebRTCController(BaseController):
    """Controller for WebRTC signaling messages."""

    def __init__(self):
        super().__init__(WEBRTC_NAMESPACE, "pcnestspeaker.webrtc")
        self.messages = []
        self.message_event = threading.Event()

    def receive_message(self, _message, data):
        """Called when we receive a message from the Cast device."""
        print(f"[WebRTC] Received: {json.dumps(data)}", file=sys.stderr)
        self.messages.append(data)
        self.message_event.set()
        return True

    def send_message(self, data):
        """Send a message to the Cast device."""
        print(f"[WebRTC] Sending: {json.dumps(data)}", file=sys.stderr)
        self.send_message_nocheck(data)

    def wait_for_message(self, timeout=10):
        """Wait for a message from the Cast device."""
        self.message_event.clear()
        if self.message_event.wait(timeout):
            if self.messages:
                return self.messages.pop(0)
        return None

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


def device_info(speaker_name):
    """Get detailed device information including supported receivers."""
    try:
        print(f"Looking for '{speaker_name}'...", file=sys.stderr)

        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )

        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        info = cast.cast_info
        print(f"Connected to {info.host}, waiting...", file=sys.stderr)
        cast.wait(timeout=10)

        # Get detailed status
        device_info = {
            "name": cast.name,
            "model": info.model_name,
            "manufacturer": info.manufacturer,
            "uuid": str(cast.uuid),
            "ip": info.host,
            "port": info.port,
            "cast_type": info.cast_type,
            "status": {}
        }

        if cast.status:
            device_info["status"] = {
                "is_active_input": cast.status.is_active_input,
                "is_stand_by": cast.status.is_stand_by,
                "volume_level": cast.status.volume_level,
                "volume_muted": cast.status.volume_muted,
                "app_id": cast.status.app_id,
                "display_name": cast.status.display_name,
                "status_text": cast.status.status_text,
                "icon_url": cast.status.icon_url
            }

        browser.stop_discovery()
        print(f"Device info retrieved successfully", file=sys.stderr)
        return {"success": True, "device": device_info}

    except Exception as e:
        return {"success": False, "error": str(e)}

def cast_to_speaker(speaker_name, media_url, content_type="application/x-mpegURL"):
    """Cast media to a speaker using pychromecast (HTTP streaming mode)."""
    try:
        print(f"Looking for '{speaker_name}'...", file=sys.stderr)

        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )

        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        host = cast.cast_info.host if hasattr(cast, 'cast_info') else 'unknown'
        print(f"Connecting to {host}...", file=sys.stderr)
        cast.wait()

        mc = cast.media_controller

        # Use default media receiver for HTTP streaming (more reliable)
        print("Using default media receiver for HTTP streaming...", file=sys.stderr)

        print(f"Playing stream: {media_url}", file=sys.stderr)
        mc.play_media(
            media_url,
            content_type,
            stream_type="LIVE",
            autoplay=True,
            current_time=0
        )
        mc.block_until_active(timeout=30)

        browser.stop_discovery()
        print("Playback started!", file=sys.stderr)

        return {"success": True, "state": "PLAYING", "mode": "http"}

    except Exception as e:
        return {"success": False, "error": str(e)}


def get_local_ip():
    """Get the local IP address that can reach the network."""
    import socket
    try:
        # Connect to a public DNS to determine local IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def webrtc_stream(speaker_name, webrtc_server_port=8080):
    """Start WebRTC streaming via play_media with customData.

    Uses standard media controller to pass webrtc-streamer URL to receiver.
    """
    try:
        print(f"[WebRTC] Looking for '{speaker_name}'...", file=sys.stderr)

        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )

        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        host = cast.cast_info.host if hasattr(cast, 'cast_info') else 'unknown'
        print(f"[WebRTC] Connecting to {host}...", file=sys.stderr)
        cast.wait()

        # Launch custom receiver
        print(f"[WebRTC] Launching receiver (App ID: {CUSTOM_APP_ID})...", file=sys.stderr)
        cast.start_app(CUSTOM_APP_ID)
        time.sleep(4)  # Wait for receiver to load
        print("[WebRTC] Receiver launched!", file=sys.stderr)

        # Get local IP for webrtc-streamer URL
        local_ip = get_local_ip()
        webrtc_url = f"http://{local_ip}:{webrtc_server_port}"
        print(f"[WebRTC] WebRTC streamer URL: {webrtc_url}", file=sys.stderr)

        # Use play_media to send the webrtc URL via media_info/customData
        mc = cast.media_controller
        print(f"[WebRTC] Sending play_media with media_info...", file=sys.stderr)

        # Send a dummy media URL with media_info containing customData
        # The receiver will intercept this and use WebRTC instead
        mc.play_media(
            "https://placeholder.webrtc/audio.mp3",  # Placeholder - receiver ignores this
            "audio/mpeg",
            stream_type="LIVE",
            autoplay=True,
            media_info={
                "customData": {
                    "webrtcUrl": webrtc_url,
                    "stream": "pcaudio",
                    "mode": "webrtc"
                }
            }
        )

        # Wait for connection
        time.sleep(3)

        browser.stop_discovery()
        return {
            "success": True,
            "mode": "webrtc",
            "url": webrtc_url,
            "message": "WebRTC stream initiated via customData"
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def webrtc_connect(speaker_name, webrtc_server_port=8080):
    """Launch custom receiver and tell it to connect to webrtc-streamer.

    Uses custom namespace messaging (may not work on all devices).
    """
    try:
        print(f"[WebRTC] Looking for '{speaker_name}'...", file=sys.stderr)

        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )

        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        host = cast.cast_info.host if hasattr(cast, 'cast_info') else 'unknown'
        print(f"[WebRTC] Connecting to {host}...", file=sys.stderr)
        cast.wait()

        # Launch custom receiver first
        print(f"[WebRTC] Launching receiver (App ID: {CUSTOM_APP_ID})...", file=sys.stderr)
        cast.start_app(CUSTOM_APP_ID)
        time.sleep(5)  # Wait for receiver to load
        print("[WebRTC] Receiver launched!", file=sys.stderr)

        # Disconnect and reconnect to pick up new namespace
        print("[WebRTC] Reconnecting to pick up namespace...", file=sys.stderr)
        cast.disconnect()
        time.sleep(1)

        # Get a fresh connection
        chromecasts2, browser2 = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )
        if not chromecasts2:
            browser.stop_discovery()
            browser2.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found on reconnect"}

        cast2 = chromecasts2[0]
        cast2.wait()

        # Register WebRTC controller on new connection
        webrtc = WebRTCController()
        cast2.register_handler(webrtc)
        time.sleep(2)  # Wait for handler registration

        # Get local IP for webrtc-streamer URL
        local_ip = get_local_ip()
        webrtc_url = f"http://{local_ip}:{webrtc_server_port}"
        print(f"[WebRTC] Sending connect message: {webrtc_url}", file=sys.stderr)

        # Send connect message to receiver with retry
        for attempt in range(3):
            try:
                webrtc.send_message({
                    "type": "connect",
                    "url": webrtc_url,
                    "stream": "pcaudio"
                })
                print(f"[WebRTC] Message sent (attempt {attempt + 1})", file=sys.stderr)
                break
            except Exception as e:
                print(f"[WebRTC] Send failed (attempt {attempt + 1}): {e}", file=sys.stderr)
                if attempt < 2:
                    time.sleep(2)

        # Wait a moment for the connection to establish
        time.sleep(3)

        browser.stop_discovery()
        browser2.stop_discovery()
        return {
            "success": True,
            "mode": "webrtc",
            "url": webrtc_url,
            "message": "Connect message sent to receiver"
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def set_volume(speaker_name, volume_level):
    """Set volume on a Cast device.

    Args:
        speaker_name: Name of the speaker
        volume_level: Volume level (0.0 to 1.0)
    """
    try:
        browser = pychromecast.discovery.CastBrowser(
            pychromecast.SimpleCastListener(),
            None
        )
        browser.start_discovery()
        time.sleep(2)

        chromecasts, browser = pychromecast.get_listed_chromecasts(friendly_names=[speaker_name])
        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        cast.wait()

        # Clamp volume to 0.0-1.0 range
        volume = max(0.0, min(1.0, float(volume_level)))
        cast.set_volume(volume)

        browser.stop_discovery()
        return {
            "success": True,
            "speaker": speaker_name,
            "volume": volume
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_volume(speaker_name):
    """Get current volume from a Cast device.

    Args:
        speaker_name: Name of the speaker
    """
    try:
        browser = pychromecast.discovery.CastBrowser(
            pychromecast.SimpleCastListener(),
            None
        )
        browser.start_discovery()
        time.sleep(2)

        chromecasts, browser = pychromecast.get_listed_chromecasts(friendly_names=[speaker_name])
        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        cast.wait()

        # Get current volume level
        volume = cast.status.volume_level if cast.status else 0.5

        browser.stop_discovery()
        return {
            "success": True,
            "speaker": speaker_name,
            "volume": volume,
            "muted": cast.status.volume_muted if cast.status else False
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def webrtc_launch(speaker_name, https_url=None, speaker_ip=None, stream_name="pcaudio"):
    """Launch custom receiver for WebRTC streaming.

    If https_url is provided, sends it to the receiver via play_media customData.
    The receiver will then connect to the webrtc-streamer via HTTPS.

    If speaker_ip is provided, connects directly without discovery (faster, more reliable).

    stream_name: MediaMTX stream path (default: "pcaudio", or "left"/"right" for stereo split)
    """
    try:
        browser = None

        if speaker_ip:
            # Connect directly to IP - much faster and more reliable for groups
            print(f"[WebRTC] Connecting directly to {speaker_ip}...", file=sys.stderr)
            # Use get_listed_chromecasts with known_hosts for direct IP connection
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                known_hosts=[speaker_ip],
                timeout=5
            )
            if chromecasts:
                cast = chromecasts[0]
            else:
                # Fallback: try discovery without IP hint
                print(f"[WebRTC] Direct connection failed, trying discovery...", file=sys.stderr)
                if browser:
                    browser.stop_discovery()
                chromecasts, browser = pychromecast.get_listed_chromecasts(
                    friendly_names=[speaker_name],
                    timeout=10
                )
                if not chromecasts:
                    browser.stop_discovery()
                    return {"success": False, "error": f"Speaker '{speaker_name}' not found"}
                cast = chromecasts[0]
        else:
            # Fall back to discovery if no IP provided
            print(f"[WebRTC] Looking for '{speaker_name}'...", file=sys.stderr)

            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                timeout=10
            )

            if not chromecasts:
                browser.stop_discovery()
                return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

            cast = chromecasts[0]

        host = cast.cast_info.host if hasattr(cast, 'cast_info') else speaker_ip or 'unknown'
        print(f"[WebRTC] Connected to {host}, waiting for ready...", file=sys.stderr)
        cast.wait(timeout=10)

        # Stop discovery AFTER wait() completes - zeroconf must stay running until then
        if browser:
            browser.stop_discovery()

        # Launch custom receiver
        print(f"[WebRTC] Launching receiver (App ID: {CUSTOM_APP_ID})...", file=sys.stderr)
        print(f"[WebRTC] Device UUID: {cast.uuid}", file=sys.stderr)
        print(f"[WebRTC] Device model: {cast.cast_info.model_name}", file=sys.stderr)

        try:
            cast.start_app(CUSTOM_APP_ID)
            time.sleep(3)  # Wait for receiver to load
            print("[WebRTC] Receiver launched!", file=sys.stderr)
        except Exception as app_error:
            error_type = type(app_error).__name__
            error_msg = str(app_error)
            print(f"[WebRTC] ERROR: {error_type}: {error_msg}", file=sys.stderr)

            # Return specific error code for custom receiver failures
            # This allows automatic fallback to HTTP streaming
            if "RequestFailed" in error_type or "Failed to execute start app" in error_msg:
                print(f"[WebRTC] Device doesn't support custom receiver - will use HTTP fallback", file=sys.stderr)
                return {
                    "success": False,
                    "error": error_msg,
                    "error_code": "CUSTOM_RECEIVER_NOT_SUPPORTED",
                    "fallback_available": True
                }

            # Other errors
            print(f"[WebRTC] Possible causes:", file=sys.stderr)
            print(f"[WebRTC]   1. App {CUSTOM_APP_ID} is UNPUBLISHED", file=sys.stderr)
            print(f"[WebRTC]   2. App {CUSTOM_APP_ID} does not exist", file=sys.stderr)
            print(f"[WebRTC]   3. Check: https://cast.google.com/publish/", file=sys.stderr)
            return {"success": False, "error": error_msg, "error_code": "UNKNOWN"}

        # If HTTPS URL provided, send it to receiver via custom namespace message
        if https_url:
            print(f"[WebRTC] Sending WebRTC URL to receiver: {https_url}", file=sys.stderr)

            # Wait for receiver to be fully loaded
            for i in range(10):
                cast.socket_client.receiver_controller.update_status()
                time.sleep(0.5)
                if cast.status and cast.status.app_id == CUSTOM_APP_ID:
                    print(f"[WebRTC] App ready, transport_id: {cast.status.transport_id}", file=sys.stderr)
                    break
                print(f"[WebRTC] Waiting for app... ({i+1}/10)", file=sys.stderr)

            # Send URL via custom namespace message
            # The receiver listens on 'urn:x-cast:com.pcnestspeaker.webrtc'
            WEBRTC_NAMESPACE = "urn:x-cast:com.pcnestspeaker.webrtc"

            # Create and register a simple message controller
            from pychromecast.controllers import BaseController

            class WebRTCController(BaseController):
                def __init__(self):
                    super().__init__(WEBRTC_NAMESPACE)

                def receive_message(self, message, data):
                    print(f"[WebRTC] Received: {data}", file=sys.stderr)
                    return True

            webrtc_controller = WebRTCController()
            cast.register_handler(webrtc_controller)

            # Send connect message with URL and custom stream name
            message = {
                "type": "connect",
                "url": https_url,
                "stream": stream_name
            }
            print(f"[WebRTC] Sending message: {message}", file=sys.stderr)
            webrtc_controller.send_message(message)

            time.sleep(2)
            print("[WebRTC] URL sent via custom namespace!", file=sys.stderr)

        return {
            "success": True,
            "mode": "webrtc",
            "url": https_url or "none",
            "message": "Receiver launched with WebRTC URL"
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def webrtc_signal(speaker_name, message_json):
    """Send a signaling message to the Cast receiver and wait for response."""
    try:
        message = json.loads(message_json)
        print(f"[WebRTC] Signaling to '{speaker_name}': {message.get('type')}", file=sys.stderr)

        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )

        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        cast.wait()

        # Register WebRTC controller
        webrtc = WebRTCController()
        cast.register_handler(webrtc)

        # Ensure custom app is running
        if cast.app_id != CUSTOM_APP_ID:
            print(f"[WebRTC] Launching receiver...", file=sys.stderr)
            cast.start_app(CUSTOM_APP_ID)
            time.sleep(2)

        # Send the signaling message
        webrtc.send_message(message)

        # Wait for response (for offer, expect answer)
        if message.get('type') == 'offer':
            print("[WebRTC] Waiting for answer...", file=sys.stderr)
            response = webrtc.wait_for_message(timeout=15)
            if response:
                browser.stop_discovery()
                return {"success": True, "response": response}
            else:
                browser.stop_discovery()
                return {"success": False, "error": "Timeout waiting for answer"}

        # ICE candidates don't need response
        browser.stop_discovery()
        return {"success": True}

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

def get_volume(speaker_name):
    """
    Get current volume and mute state from speaker
    Returns: { success: true, volume: 0.0-1.0, muted: bool }
    """
    try:
        chromecasts, browser = pychromecast.get_listed_chromecasts(friendly_names=[speaker_name])

        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        cast.wait()

        # Get volume status
        volume_level = cast.status.volume_level  # 0.0 - 1.0
        is_muted = cast.status.volume_muted

        browser.stop_discovery()
        return {
            "success": True,
            "volume": volume_level,
            "muted": is_muted
        }

    except Exception as e:
        return {"success": False, "error": str(e)}

def set_volume(speaker_name, volume):
    """
    Set speaker volume
    Args: speaker_name (str), volume (float 0.0-1.0)
    """
    try:
        chromecasts, browser = pychromecast.get_listed_chromecasts(friendly_names=[speaker_name])

        if not chromecasts:
            browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        cast.wait()

        # Set volume (0.0 - 1.0)
        cast.set_volume(volume)

        browser.stop_discovery()
        return {"success": True, "volume": volume}

    except Exception as e:
        return {"success": False, "error": str(e)}


def set_volume_fast(speaker_name, volume_level, speaker_ip=None):
    """Fast volume set using direct IP connection (no discovery).

    This is 10x faster than set_volume() because it uses known_hosts hint.
    Use when you have the speaker IP cached.

    Args:
        speaker_name: Name of the speaker (used for logging/fallback)
        volume_level: Volume level (0.0 to 1.0)
        speaker_ip: Direct IP address of the speaker (speeds up discovery if provided)
    """
    try:
        volume = max(0.0, min(1.0, float(volume_level)))
        browser = None

        if speaker_ip:
            # Use known_hosts for faster discovery (< 2 seconds vs 10 seconds)
            print(f"Fast volume: using known host {speaker_ip}...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                known_hosts=[speaker_ip],
                timeout=3
            )
        else:
            # Fallback to full discovery (5-10 seconds)
            print(f"Fast volume: no IP, using discovery...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                timeout=10
            )

        if not chromecasts:
            if browser:
                browser.stop_discovery()
            print(f"Fast volume: FAILED - speaker not found", file=sys.stderr)
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        cast.wait(timeout=3)
        print(f"Fast volume: connected, setting to {int(volume * 100)}%", file=sys.stderr)

        cast.set_volume(volume)

        if browser:
            browser.stop_discovery()

        print(f"Fast volume: SUCCESS", file=sys.stderr)
        return {"success": True, "volume": volume}

    except Exception as e:
        print(f"Fast volume: FAILED - {str(e)}", file=sys.stderr)
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
        # Ping - triggers Nest's pairing sound by casting silent audio
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

                # Cast silent audio to trigger the Nest's pairing/ready sound
                mc = cast.media_controller
                # 1-second silent MP3 (triggers pairing sound without audible content)
                silent_mp3 = "https://github.com/anars/blank-audio/raw/master/250-milliseconds-of-silence.mp3"
                print(f"Triggering pairing sound...", file=sys.stderr)
                mc.play_media(silent_mp3, "audio/mp3")
                mc.block_until_active(timeout=10)
                time.sleep(0.5)
                mc.stop()

                volume = cast.status.volume_level if cast.status else None
                browser.stop_discovery()
                print("Ping successful!", file=sys.stderr)
                print(json.dumps({"success": True, "ip": host, "volume": volume}))
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

    elif command == "webrtc-stream" and len(sys.argv) >= 3:
        # Start WebRTC streaming using play_media with customData
        speaker = sys.argv[2]
        port = int(sys.argv[3]) if len(sys.argv) > 3 else 8080
        result = webrtc_stream(speaker, port)
        print(json.dumps(result))

    elif command == "webrtc-connect" and len(sys.argv) >= 3:
        # Launch receiver and send webrtc-streamer URL (new simpler approach)
        speaker = sys.argv[2]
        port = int(sys.argv[3]) if len(sys.argv) > 3 else 8080
        result = webrtc_connect(speaker, port)
        print(json.dumps(result))

    elif command == "webrtc-launch" and len(sys.argv) >= 3:
        # Launch custom receiver for WebRTC streaming with HTTPS tunnel URL
        # Args: webrtc-launch <speaker_name> [https_url] [speaker_ip] [stream_name]
        speaker = sys.argv[2]
        https_url = sys.argv[3] if len(sys.argv) > 3 else None
        speaker_ip = sys.argv[4] if len(sys.argv) > 4 else None
        stream_name = sys.argv[5] if len(sys.argv) > 5 else "pcaudio"
        result = webrtc_launch(speaker, https_url, speaker_ip, stream_name)
        print(json.dumps(result))

    elif command == "webrtc-signal" and len(sys.argv) >= 4:
        # Send signaling message (SDP offer, ICE candidate, etc.)
        speaker = sys.argv[2]
        message_json = sys.argv[3]
        result = webrtc_signal(speaker, message_json)
        print(json.dumps(result))

    elif command == "stop" and len(sys.argv) >= 3:
        speaker = sys.argv[2]
        result = stop_cast(speaker)
        print(json.dumps(result))

    elif command == "get-volume" and len(sys.argv) >= 3:
        speaker = sys.argv[2]
        result = get_volume(speaker)
        print(json.dumps(result))

    elif command == "set-volume" and len(sys.argv) >= 4:
        speaker = sys.argv[2]
        volume = float(sys.argv[3])  # 0.0 - 1.0
        result = set_volume(speaker, volume)
        print(json.dumps(result))

    elif command == "set-volume-fast" and len(sys.argv) >= 4:
        # Fast volume set using direct IP (skips discovery)
        # Args: set-volume-fast <speaker_name> <volume_level> [speaker_ip]
        speaker = sys.argv[2]
        volume = float(sys.argv[3])  # 0.0 - 1.0
        speaker_ip = sys.argv[4] if len(sys.argv) > 4 else None
        result = set_volume_fast(speaker, volume, speaker_ip)
        print(json.dumps(result))

    elif command == "device-info" and len(sys.argv) >= 3:
        speaker = sys.argv[2]
        result = device_info(speaker)
        print(json.dumps(result, indent=2))

    else:
        print(json.dumps({"success": False, "error": "Invalid command. Use: discover, ping, cast, webrtc-launch, set-volume, set-volume-fast, get-volume, device-info, or stop"}))
        sys.exit(1)
