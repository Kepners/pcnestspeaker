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
import os
import subprocess
import json
import time
import threading
import pychromecast
from pychromecast.controllers import BaseController

# Custom receivers for WebRTC low-latency streaming
# Visual receiver: Shows ambient videos on TVs/Shields
VISUAL_APP_ID = "FCAA4619"
# Audio receiver: Lean, no visuals - for Nest speakers and groups
AUDIO_APP_ID = "4B876246"
# Default to audio receiver (most common use case)
CUSTOM_APP_ID = AUDIO_APP_ID
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

def discover_speakers(timeout=12):
    """Discover all Chromecast/Nest speakers on the network.

    Default timeout increased to 12s for devices like NVIDIA SHIELD
    that may take longer to respond to mDNS discovery.

    Groups are detected and their member speakers are resolved during discovery,
    so group connections don't need a second discovery phase.
    """
    from pychromecast.controllers.multizone import MultizoneController
    import time

    try:
        print(f"Scanning network (timeout: {timeout}s)...", file=sys.stderr)

        # Use blocking discovery to ensure we get all devices
        chromecasts, browser = pychromecast.get_chromecasts(timeout=timeout)

        print(f"Raw discovery returned {len(chromecasts)} device(s)", file=sys.stderr)

        # First pass: collect all devices and identify groups
        speakers = []
        groups = []  # Cast groups to resolve members for
        cc_by_uuid = {}  # For quick UUID -> device lookup

        for cc in chromecasts:
            info = cc.cast_info
            cc_by_uuid[str(cc.uuid)] = cc
            device_data = {
                "name": cc.name,
                "model": info.model_name or "Chromecast",
                "ip": info.host,
                "port": info.port,
                "cast_type": info.cast_type,  # "audio", "cast", or "group"
                "uuid": str(cc.uuid)
            }
            if info.cast_type == 'group':
                device_data["members"] = []  # Will be populated below
                groups.append((cc, device_data))
            speakers.append(device_data)
            print(f"Found: {cc.name} | Model: {info.model_name} | IP: {info.host} | Type: {info.cast_type}", file=sys.stderr)

        # Second pass: resolve group members (fast - uses cached chromecasts, no re-discovery)
        for group_cc, group_data in groups:
            try:
                print(f"[GroupResolve] Resolving members for '{group_data['name']}'...", file=sys.stderr)
                group_cc.wait(timeout=5)  # Quick connect to group

                mz = MultizoneController(group_cc.uuid)
                group_cc.register_handler(mz)
                mz.update_members()
                time.sleep(0.5)  # Brief wait for response (was 2s)

                # Get member UUIDs
                member_uuids = []
                if hasattr(mz, 'members'):
                    if isinstance(mz.members, dict):
                        member_uuids = list(mz.members.keys())
                    elif isinstance(mz.members, list):
                        member_uuids = mz.members

                # Match to discovered devices (instant - no network calls)
                for uuid in member_uuids:
                    uuid_str = str(uuid)
                    if uuid_str in cc_by_uuid:
                        member_cc = cc_by_uuid[uuid_str]
                        member_info = member_cc.cast_info
                        group_data["members"].append({
                            "name": member_cc.name,
                            "ip": member_info.host,
                            "uuid": uuid_str,
                            "model": member_info.model_name
                        })
                        print(f"[GroupResolve]   Member: {member_cc.name} @ {member_info.host}", file=sys.stderr)

                print(f"[GroupResolve] Group '{group_data['name']}' has {len(group_data['members'])} members", file=sys.stderr)
            except Exception as e:
                print(f"[GroupResolve] Failed to resolve '{group_data['name']}': {e}", file=sys.stderr)
                # Group still added with empty members - will fall back to get-group-members if needed

        browser.stop_discovery()

        # Log summary
        audio_count = len([s for s in speakers if s['cast_type'] == 'audio'])
        cast_count = len([s for s in speakers if s['cast_type'] == 'cast'])
        group_count = len([s for s in speakers if s['cast_type'] == 'group'])
        print(f"Summary: {audio_count} audio, {cast_count} cast, {group_count} group devices", file=sys.stderr)

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


def webrtc_launch(speaker_name, https_url=None, speaker_ip=None, stream_name="pcaudio", app_id=None):
    """Launch custom receiver for WebRTC streaming.

    If https_url is provided, sends it to the receiver via play_media customData.
    The receiver will then connect to the webrtc-streamer via HTTPS.

    If speaker_ip is provided, connects directly without discovery (faster, more reliable).

    stream_name: MediaMTX stream path (default: "pcaudio", or "left"/"right" for stereo split)
    app_id: Which receiver to use (AUDIO_APP_ID or VISUAL_APP_ID). Defaults to AUDIO_APP_ID.
    """
    # Use passed app_id or default to audio receiver
    receiver_app_id = app_id if app_id else AUDIO_APP_ID
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
        print(f"[WebRTC] Launching receiver (App ID: {receiver_app_id})...", file=sys.stderr)
        print(f"[WebRTC] Device UUID: {cast.uuid}", file=sys.stderr)
        print(f"[WebRTC] Device model: {cast.cast_info.model_name}", file=sys.stderr)

        try:
            # ENSURE CONNECT CHIME: Quit any existing app first for fresh session
            # The "ding" only plays when starting a NEW app, not when resuming!
            try:
                cast.quit_app()
                time.sleep(0.5)  # Brief pause before starting new app
            except:
                pass  # Ignore if nothing to quit

            cast.start_app(receiver_app_id)
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
            print(f"[WebRTC]   1. App {receiver_app_id} is UNPUBLISHED", file=sys.stderr)
            print(f"[WebRTC]   2. App {receiver_app_id} does not exist", file=sys.stderr)
            print(f"[WebRTC]   3. Check: https://cast.google.com/publish/", file=sys.stderr)
            return {"success": False, "error": error_msg, "error_code": "UNKNOWN"}

        # If HTTPS URL provided, send it to receiver via custom namespace message
        if https_url:
            print(f"[WebRTC] Sending WebRTC URL to receiver: {https_url}", file=sys.stderr)

            # Wait for receiver to be fully loaded
            for i in range(10):
                cast.socket_client.receiver_controller.update_status()
                time.sleep(0.5)
                if cast.status and cast.status.app_id == receiver_app_id:
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

            # Wait for message to be processed
            time.sleep(2)
            print("[WebRTC] URL sent via custom namespace!", file=sys.stderr)

            # VERIFICATION: Quick check if MediaMTX session exists
            # Reduced from 10s to 2s - fail fast if ICE doesn't work
            import urllib.request
            import urllib.error

            # MediaMTX API is always on localhost
            mediamtx_api = "http://localhost:9997"
            if https_url:
                print(f"[WebRTC] Checking connection...", file=sys.stderr)
                connected = False
                data_flowing = False

                # Quick poll - 4 attempts × 0.5s = 2 seconds max (was 10 seconds!)
                for attempt in range(4):
                    try:
                        api_url = f"{mediamtx_api}/v3/webrtcsessions/list"
                        req = urllib.request.Request(api_url, method='GET')
                        with urllib.request.urlopen(req, timeout=1) as resp:
                            sessions_data = json.loads(resp.read().decode())
                            sessions = sessions_data.get('items', [])

                            # Look for session on our stream
                            for session in sessions:
                                if stream_name in session.get('path', ''):
                                    connected = True
                                    bytes_sent = session.get('bytesSent', 0)
                                    if bytes_sent > 0:
                                        data_flowing = True
                                        print(f"[WebRTC] ✓ Connected! bytesSent={bytes_sent}", file=sys.stderr)
                                        break

                            if data_flowing:
                                break
                            elif connected and attempt >= 2:
                                # Only warn after 2nd attempt if still no data
                                print(f"[WebRTC] Session exists but bytesSent=0 ({attempt+1}/4)", file=sys.stderr)

                    except Exception as api_err:
                        if attempt == 3:  # Only log on last attempt
                            print(f"[WebRTC] API check failed: {api_err}", file=sys.stderr)

                    time.sleep(0.5)

                # Report verification result
                if data_flowing:
                    print(f"[WebRTC] ✓ VERIFIED: Audio streaming to receiver!", file=sys.stderr)
                elif connected:
                    print(f"[WebRTC] ⚠ WARNING: Session exists but NO DATA flowing (bytesSent=0)", file=sys.stderr)
                    print(f"[WebRTC] ⚠ ICE negotiation may have failed - check receiver logs", file=sys.stderr)
                else:
                    print(f"[WebRTC] ✗ WARNING: No WebRTC session found - receiver may not have connected", file=sys.stderr)
                    print(f"[WebRTC] ✗ Possible causes: TV didn't wake up, receiver didn't load, network issue", file=sys.stderr)

                return {
                    "success": True,  # Still return success since we sent the message
                    "mode": "webrtc",
                    "url": https_url or "none",
                    "message": "Receiver launched with WebRTC URL",
                    "verified": data_flowing,
                    "session_connected": connected,
                    "warning": None if data_flowing else ("no_data" if connected else "no_session")
                }

        return {
            "success": True,
            "mode": "webrtc",
            "url": https_url or "none",
            "message": "Receiver launched with WebRTC URL",
            "verified": False,
            "warning": "no_url_provided"
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def webrtc_proxy_connect(speaker_name, mediamtx_url, speaker_ip=None, stream_name="pcaudio", app_id=None):
    """
    Connect to WebRTC using PROXY SIGNALING - avoids mixed content issues!

    Flow:
    1. Launch custom receiver on Cast device
    2. Send request_offer message to receiver
    3. Wait for SDP offer from receiver
    4. POST offer to MediaMTX WHEP endpoint, get SDP answer
    5. Send answer to receiver via custom namespace
    6. WebRTC connects!

    No HTTP fetch from receiver = no mixed content = works everywhere!

    app_id: Which receiver to use (AUDIO_APP_ID or VISUAL_APP_ID). Defaults to AUDIO_APP_ID.
    """
    # Use passed app_id or default to audio receiver
    receiver_app_id = app_id if app_id else AUDIO_APP_ID
    import urllib.request
    import urllib.error

    try:
        browser = None

        # Step 1: Connect to speaker
        if speaker_ip:
            print(f"[WebRTC-Proxy] Connecting directly to {speaker_ip}...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                known_hosts=[speaker_ip],
                timeout=5
            )
            if chromecasts:
                cast = chromecasts[0]
            else:
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
            print(f"[WebRTC-Proxy] Looking for '{speaker_name}'...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                timeout=10
            )
            if not chromecasts:
                browser.stop_discovery()
                return {"success": False, "error": f"Speaker '{speaker_name}' not found"}
            cast = chromecasts[0]

        host = cast.cast_info.host if hasattr(cast, 'cast_info') else speaker_ip or 'unknown'
        print(f"[WebRTC-Proxy] Connected to {host}, waiting for ready...", file=sys.stderr)
        cast.wait(timeout=10)

        # Step 2: Launch custom receiver
        print(f"[WebRTC-Proxy] Launching receiver (App ID: {receiver_app_id})...", file=sys.stderr)
        try:
            # ENSURE CONNECT CHIME: Quit any existing app first for fresh session
            # The "ding" only plays when starting a NEW app, not when resuming!
            try:
                cast.quit_app()
                time.sleep(0.5)
            except:
                pass

            cast.start_app(receiver_app_id)
            time.sleep(3)
            print("[WebRTC-Proxy] Receiver launched!", file=sys.stderr)
        except Exception as app_error:
            error_msg = str(app_error)
            print(f"[WebRTC-Proxy] ERROR launching app: {error_msg}", file=sys.stderr)
            if browser:
                browser.stop_discovery()
            if "RequestFailed" in type(app_error).__name__ or "Failed to execute start app" in error_msg:
                return {
                    "success": False,
                    "error": error_msg,
                    "error_code": "CUSTOM_RECEIVER_NOT_SUPPORTED",
                    "fallback_available": True
                }
            return {"success": False, "error": error_msg}

        # Step 3: Register WebRTC controller and send request_offer
        webrtc = WebRTCController()
        cast.register_handler(webrtc)

        # Wait for receiver to be ready
        for i in range(10):
            cast.socket_client.receiver_controller.update_status()
            time.sleep(0.5)
            if cast.status and cast.status.app_id == receiver_app_id:
                print(f"[WebRTC-Proxy] App ready!", file=sys.stderr)
                break
            print(f"[WebRTC-Proxy] Waiting for app... ({i+1}/10)", file=sys.stderr)

        # Send request_offer message
        print(f"[WebRTC-Proxy] Requesting SDP offer from receiver (stream: {stream_name})...", file=sys.stderr)
        webrtc.send_message({"type": "request_offer", "stream": stream_name})

        # Step 4: Wait for SDP offer from receiver
        print("[WebRTC-Proxy] Waiting for offer from receiver...", file=sys.stderr)
        offer_response = webrtc.wait_for_message(timeout=15)

        if not offer_response:
            if browser:
                browser.stop_discovery()
            return {"success": False, "error": "Timeout waiting for offer from receiver"}

        if offer_response.get('type') != 'offer':
            print(f"[WebRTC-Proxy] Unexpected message: {offer_response.get('type')}", file=sys.stderr)
            if browser:
                browser.stop_discovery()
            return {"success": False, "error": f"Unexpected message type: {offer_response.get('type')}"}

        offer_sdp = offer_response.get('sdp')
        if not offer_sdp:
            if browser:
                browser.stop_discovery()
            return {"success": False, "error": "No SDP in offer"}

        print(f"[WebRTC-Proxy] Got SDP offer ({len(offer_sdp)} bytes)", file=sys.stderr)

        # Step 5: POST offer to MediaMTX WHEP endpoint
        whep_url = f"{mediamtx_url}/{stream_name}/whep"
        print(f"[WebRTC-Proxy] POSTing offer to {whep_url}...", file=sys.stderr)

        req = urllib.request.Request(
            whep_url,
            data=offer_sdp.encode('utf-8'),
            headers={'Content-Type': 'application/sdp'},
            method='POST'
        )

        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                answer_sdp = response.read().decode('utf-8')
                print(f"[WebRTC-Proxy] Got SDP answer ({len(answer_sdp)} bytes)", file=sys.stderr)
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8') if e.fp else str(e)
            if browser:
                browser.stop_discovery()
            return {"success": False, "error": f"WHEP error {e.code}: {error_body}"}
        except urllib.error.URLError as e:
            if browser:
                browser.stop_discovery()
            return {"success": False, "error": f"Cannot reach MediaMTX: {e.reason}"}

        # Step 6: Send answer to receiver
        print("[WebRTC-Proxy] Sending SDP answer to receiver...", file=sys.stderr)
        webrtc.send_message({"type": "answer", "sdp": answer_sdp})

        time.sleep(1)
        print("[WebRTC-Proxy] Proxy signaling complete!", file=sys.stderr)

        if browser:
            browser.stop_discovery()

        return {
            "success": True,
            "mode": "webrtc-proxy",
            "message": "WebRTC connected via proxy signaling"
        }

    except Exception as e:
        import traceback
        print(f"[WebRTC-Proxy] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
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
    """Stop casting to a speaker.

    Plays the Cast "ding" sound on disconnect by briefly launching
    the Default Media Receiver before quitting.
    """
    try:
        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[speaker_name],
            timeout=10
        )

        if chromecasts:
            cast = chromecasts[0]
            cast.wait()
            cast.quit_app()

            # PLAY DISCONNECT CHIME: Launch Default Media Receiver briefly
            # The "ding" sound ONLY plays when start_app() is called!
            try:
                time.sleep(0.3)
                cast.start_app("CC1AD845")  # Triggers the ding!
                time.sleep(1.0)
                cast.quit_app()  # Leave speaker idle
            except Exception as e:
                print(f"[stop] Disconnect chime failed (non-critical): {e}", file=sys.stderr)

        browser.stop_discovery()
        return {"success": True}

    except Exception as e:
        return {"success": False, "error": str(e)}


def stop_cast_fast(speaker_name, speaker_ip):
    """
    Stop casting using cached IP - no network scan needed.
    Much faster than stop_cast() (~1s vs 10s).

    Plays the Cast "ding" sound on disconnect by briefly launching
    the Default Media Receiver before quitting.
    """
    try:
        if not speaker_ip:
            # Fallback to regular stop if no IP provided
            return stop_cast(speaker_name)

        print(f"[stop-fast] Connecting directly to {speaker_name} at {speaker_ip}", file=sys.stderr)

        # Use get_listed_chromecasts with IP for more reliable connection
        # Direct Chromecast(ip) can have issues with internal cast_type lookup
        try:
            chromecasts, browser = pychromecast.get_chromecasts(timeout=3)
            cast = None
            for cc in chromecasts:
                if cc.cast_info.host == speaker_ip:
                    cast = cc
                    break
            browser.stop_discovery()

            if not cast:
                # Fallback to direct IP connection
                cast = pychromecast.Chromecast(speaker_ip)
        except:
            # Last resort fallback
            cast = pychromecast.Chromecast(speaker_ip)

        cast.wait(timeout=5)
        cast.quit_app()

        # PLAY DISCONNECT CHIME: Launch Default Media Receiver briefly
        # The "ding" sound ONLY plays when start_app() is called!
        try:
            time.sleep(0.3)
            cast.start_app("CC1AD845")  # Triggers the ding!
            time.sleep(1.0)
            cast.quit_app()  # Leave speaker idle
        except Exception as e:
            print(f"[stop-fast] Disconnect chime failed (non-critical): {e}", file=sys.stderr)

        return {"success": True}

    except Exception as e:
        # Non-fatal - speaker will be reconnected anyway during resync
        print(f"[stop-fast] Warning (non-fatal): {e}", file=sys.stderr)
        return {"success": True}  # Return success anyway - resync will reconnect

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


def get_group_members(group_name):
    """Get the individual speaker members of a Cast Group.

    Cast Groups don't work with custom receivers properly - only the leader plays.
    This function returns the member speakers so we can multi-cast to each one individually.

    Args:
        group_name: Name of the Cast Group (e.g., "Study group")

    Returns:
        { success: true, members: [{ name, ip, uuid }, ...], group_name, group_uuid }
    """
    from pychromecast.controllers.multizone import MultizoneController
    import time

    try:
        print(f"[GroupMembers] Looking for group '{group_name}'...", file=sys.stderr)

        # Discover all devices first to find individual speakers
        chromecasts, browser = pychromecast.get_chromecasts(timeout=10)

        # Find the group
        group_cast = None
        for cc in chromecasts:
            if cc.name == group_name and cc.cast_info.cast_type == 'group':
                group_cast = cc
                break

        if not group_cast:
            browser.stop_discovery()
            return {"success": False, "error": f"Group '{group_name}' not found"}

        print(f"[GroupMembers] Found group, connecting...", file=sys.stderr)
        group_cast.wait(timeout=10)

        # Get group UUID
        group_uuid = str(group_cast.uuid)
        print(f"[GroupMembers] Group UUID: {group_uuid}", file=sys.stderr)

        # Use MultizoneController to get members
        mz = MultizoneController(group_cast.uuid)
        group_cast.register_handler(mz)

        # Request member list
        mz.update_members()
        time.sleep(2)  # Give time for response

        # Get members - could be dict (UUID -> name) or list depending on pychromecast version
        if hasattr(mz, 'members'):
            if isinstance(mz.members, dict):
                member_uuids = list(mz.members.keys())
            elif isinstance(mz.members, list):
                member_uuids = mz.members
            else:
                member_uuids = []
            print(f"[GroupMembers] Raw members: {mz.members}", file=sys.stderr)
        else:
            member_uuids = []
        print(f"[GroupMembers] Found {len(member_uuids)} member UUIDs: {member_uuids}", file=sys.stderr)

        # Match member UUIDs to discovered devices to get IPs
        members = []
        for cc in chromecasts:
            cc_uuid = str(cc.uuid)
            if cc_uuid in member_uuids or cc_uuid in [str(u) for u in member_uuids]:
                info = cc.cast_info
                member_data = {
                    "name": cc.name,
                    "ip": info.host,
                    "uuid": cc_uuid,
                    "model": info.model_name
                }
                members.append(member_data)
                print(f"[GroupMembers] Member: {cc.name} @ {info.host}", file=sys.stderr)

        # If multizone didn't work, try alternative: find speakers sharing the group IP
        if not members:
            group_ip = group_cast.cast_info.host
            print(f"[GroupMembers] Multizone empty, trying IP match for {group_ip}...", file=sys.stderr)
            for cc in chromecasts:
                info = cc.cast_info
                # Individual speakers that share the group's IP are likely members
                if info.host == group_ip and info.cast_type == 'audio':
                    member_data = {
                        "name": cc.name,
                        "ip": info.host,
                        "uuid": str(cc.uuid),
                        "model": info.model_name
                    }
                    members.append(member_data)
                    print(f"[GroupMembers] Member (IP match): {cc.name} @ {info.host}", file=sys.stderr)

        browser.stop_discovery()

        return {
            "success": True,
            "group_name": group_name,
            "group_uuid": group_uuid,
            "members": members,
            "count": len(members)
        }

    except Exception as e:
        import traceback
        print(f"[GroupMembers] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


def cast_url_to_tv(device_name, url, content_type=None, device_ip=None):
    """Cast ANY URL to a TV device (Chromecast, Shield, etc.).

    This is the simple "send URL, TV plays it" function.
    The TV fetches and plays the URL directly - we're NOT screen sharing.

    Supported content types (auto-detected from URL if not provided):
    - video/mp4: MP4 files
    - application/x-mpegURL: HLS streams (.m3u8)
    - application/dash+xml: DASH streams (.mpd)
    - video/webm: WebM files
    - audio/mpeg: MP3 files

    Args:
        device_name: Name of the TV/Chromecast device
        url: URL to cast (YouTube URLs will be rejected - use YouTube app)
        content_type: MIME type (auto-detected if None)
        device_ip: Optional direct IP for faster connection

    Returns:
        { success: true, state: "PLAYING", url: "..." }
    """
    try:
        browser = None

        # Auto-detect content type from URL extension
        if not content_type:
            url_lower = url.lower()
            if '.m3u8' in url_lower:
                content_type = 'application/x-mpegURL'
            elif '.mpd' in url_lower:
                content_type = 'application/dash+xml'
            elif '.mp4' in url_lower:
                content_type = 'video/mp4'
            elif '.webm' in url_lower:
                content_type = 'video/webm'
            elif '.mp3' in url_lower:
                content_type = 'audio/mpeg'
            elif '.m4a' in url_lower or '.aac' in url_lower:
                content_type = 'audio/mp4'
            elif '.mkv' in url_lower:
                content_type = 'video/x-matroska'
            else:
                # Default to video/mp4 for unknown URLs
                content_type = 'video/mp4'
                print(f"[CastURL] Unknown extension, defaulting to: {content_type}", file=sys.stderr)

        print(f"[CastURL] Casting URL to '{device_name}'...", file=sys.stderr)
        print(f"[CastURL] URL: {url}", file=sys.stderr)
        print(f"[CastURL] Content-Type: {content_type}", file=sys.stderr)

        # Connect to device
        if device_ip:
            print(f"[CastURL] Using direct IP: {device_ip}", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[device_name],
                known_hosts=[device_ip],
                timeout=5
            )
        else:
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[device_name],
                timeout=10
            )

        if not chromecasts:
            if browser:
                browser.stop_discovery()
            return {"success": False, "error": f"Device '{device_name}' not found"}

        cast = chromecasts[0]
        host = cast.cast_info.host if hasattr(cast, 'cast_info') else device_ip or 'unknown'
        print(f"[CastURL] Connected to {host}", file=sys.stderr)
        cast.wait(timeout=10)

        # Use Default Media Receiver for URL casting (most compatible)
        DEFAULT_MEDIA_RECEIVER = 'CC1AD845'
        print(f"[CastURL] Launching Default Media Receiver...", file=sys.stderr)

        try:
            cast.quit_app()  # Ensure chime
            time.sleep(0.5)
            cast.start_app(DEFAULT_MEDIA_RECEIVER)
            time.sleep(2)
        except Exception as e:
            print(f"[CastURL] App launch warning (non-critical): {e}", file=sys.stderr)

        # Send URL to TV
        mc = cast.media_controller
        print(f"[CastURL] Playing URL...", file=sys.stderr)

        mc.play_media(
            url,
            content_type,
            autoplay=True,
            current_time=0
        )
        mc.block_until_active(timeout=30)

        if browser:
            browser.stop_discovery()

        print("[CastURL] Playback started!", file=sys.stderr)
        return {
            "success": True,
            "state": "PLAYING",
            "url": url,
            "content_type": content_type,
            "device": device_name
        }

    except Exception as e:
        import traceback
        print(f"[CastURL] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


def hls_cast_to_tv(speaker_name, hls_url, speaker_ip=None, device_model=None, app_id=None):
    """Cast HLS stream to TV devices (NVIDIA Shield, Chromecast with screen).

    TVs don't support WebRTC, but they DO support HLS. We can use either:
    - Default Media Receiver (CC1AD845): Plain playback, no visuals
    - Visual Receiver (FCAA4619): Ambient videos behind audio

    Args:
        speaker_name: Name of the TV/device
        hls_url: HLS playlist URL (e.g., http://<local-ip>:8888/pcaudio/index.m3u8)
        speaker_ip: Optional direct IP for faster connection
        device_model: Model name from discovery (e.g., "SHIELD Android TV")
        app_id: Receiver app ID. Default is Visual receiver (FCAA4619) for ambient videos.
                Pass 'CC1AD845' for Default Media Receiver.

    Returns:
        { success: true, state: "PLAYING", mode: "hls" }
    """
    # Default to Visual receiver for ambient videos (unless explicitly overridden)
    VISUAL_APP_ID = 'FCAA4619'
    DEFAULT_MEDIA_RECEIVER = 'CC1AD845'
    receiver_id = app_id if app_id else VISUAL_APP_ID
    try:
        browser = None

        if speaker_ip:
            print(f"[HLS-TV] Connecting directly to {speaker_ip}...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                known_hosts=[speaker_ip],
                timeout=5
            )
            if chromecasts:
                cast = chromecasts[0]
            else:
                if browser:
                    browser.stop_discovery()
                chromecasts, browser = pychromecast.get_listed_chromecasts(
                    friendly_names=[speaker_name],
                    timeout=10
                )
                if not chromecasts:
                    browser.stop_discovery()
                    return {"success": False, "error": f"Device '{speaker_name}' not found"}
                cast = chromecasts[0]
        else:
            print(f"[HLS-TV] Looking for '{speaker_name}'...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                timeout=10
            )
            if not chromecasts:
                browser.stop_discovery()
                return {"success": False, "error": f"Device '{speaker_name}' not found"}
            cast = chromecasts[0]

        host = cast.cast_info.host if hasattr(cast, 'cast_info') else speaker_ip or 'unknown'
        # Use passed model from discovery, fall back to querying device
        model = device_model.lower() if device_model else (cast.cast_info.model_name.lower() if cast.cast_info.model_name else '')
        print(f"[HLS-TV] Connecting to {host} (model: {model})...", file=sys.stderr)
        # CRITICAL: Shield needs longer timeout when booting from cold (10s too short)
        cast.wait(timeout=30)

        # Shield: Try Visual Receiver (user confirmed custom receivers CAN work on Shield)
        is_shield = 'shield' in model
        if is_shield:
            print(f"[HLS-TV] Shield detected - attempting Visual Receiver...", file=sys.stderr)

        # Check standby status and launch receiver with threading-based timeout
        print(f"[HLS-TV] Launching receiver {receiver_id}...", file=sys.stderr)

        import threading
        launch_success = [False]
        launch_error = [None]

        def launch_receiver():
            try:
                # ENSURE CHIME: Quit any existing app first for fresh session
                try:
                    cast.quit_app()
                    time.sleep(0.5)
                except:
                    pass
                # CRITICAL: Shield needs 30s timeout for cold boot (default 10s is too short!)
                cast.start_app(receiver_id, timeout=30)
                time.sleep(2)  # Give receiver time to load
                launch_success[0] = True
            except Exception as e:
                launch_error[0] = e

        # Use thread with timeout to prevent indefinite hang
        # Timeout is 35s (5s buffer after start_app's 30s timeout)
        launch_thread = threading.Thread(target=launch_receiver)
        launch_thread.start()
        launch_thread.join(timeout=35)

        # NOTE: pychromecast timeout doesn't mean receiver failed!
        # Visual Receiver shows splash even when pychromecast reports "timeout"
        # DO NOT fall back to DMR - stick with Visual Receiver (user confirmed it works!)
        if launch_thread.is_alive():
            print(f"[HLS-TV] Receiver still launching (35s) - proceeding anyway", file=sys.stderr)
            print(f"[HLS-TV] Visual Receiver splash is likely showing on TV", file=sys.stderr)
        elif launch_error[0]:
            error_msg = str(launch_error[0])
            print(f"[HLS-TV] Receiver reported: {error_msg}", file=sys.stderr)
            # "timed out" from pychromecast doesn't mean receiver failed!
            if 'timed out' in error_msg.lower():
                print(f"[HLS-TV] Timeout is normal - Visual Receiver splash is showing!", file=sys.stderr)
            else:
                print(f"[HLS-TV] Continuing with Visual Receiver despite error", file=sys.stderr)
        else:
            print(f"[HLS-TV] Receiver {receiver_id} launched!", file=sys.stderr)

        # Give receiver extra time to fully load after splash
        print(f"[HLS-TV] Waiting 3s for receiver to be ready for audio...", file=sys.stderr)
        time.sleep(3)

        mc = cast.media_controller

        # Send HLS URL to receiver
        receiver_name = "Visual receiver" if receiver_id == VISUAL_APP_ID else "Default Media Receiver"
        print(f"[HLS-TV] Sending HLS to {receiver_name}...", file=sys.stderr)
        print(f"[HLS-TV] Playing: {hls_url}", file=sys.stderr)

        mc.play_media(
            hls_url,
            "application/x-mpegURL",  # HLS MIME type
            stream_type="LIVE",
            autoplay=True,
            current_time=0
        )

        # Wait for media controller to become active
        try:
            mc.block_until_active(timeout=30)
        except Exception as block_err:
            print(f"[HLS-TV] Warning: block_until_active failed: {block_err}", file=sys.stderr)

        # Check actual media status
        time.sleep(2)  # Give it a moment to update status
        status = mc.status
        print(f"[HLS-TV] Media status after play:", file=sys.stderr)
        if status:
            print(f"[HLS-TV]   player_state: {status.player_state}", file=sys.stderr)
            print(f"[HLS-TV]   content_id: {status.content_id}", file=sys.stderr)
            if hasattr(status, 'idle_reason'):
                print(f"[HLS-TV]   idle_reason: {status.idle_reason}", file=sys.stderr)
        else:
            print(f"[HLS-TV]   status is None!", file=sys.stderr)

        if browser:
            browser.stop_discovery()

        # Verify playback actually started
        if status and status.player_state == "PLAYING":
            print("[HLS-TV] Playback CONFIRMED!", file=sys.stderr)
            return {"success": True, "state": "PLAYING", "mode": "hls"}
        elif status and status.player_state == "BUFFERING":
            print("[HLS-TV] Playback buffering (should start soon)...", file=sys.stderr)
            return {"success": True, "state": "BUFFERING", "mode": "hls"}
        elif status and status.player_state == "IDLE":
            idle_reason = getattr(status, 'idle_reason', 'unknown')
            # CRITICAL: Visual Receiver uses hls.js which bypasses Cast player entirely
            # Cast player will be IDLE because we return null from LOAD interceptor
            # This is SUCCESS - hls.js is handling audio, not Cast player!
            if receiver_id == VISUAL_APP_ID:
                print(f"[HLS-TV] Cast player IDLE (expected - hls.js handles audio)", file=sys.stderr)
                print(f"[HLS-TV] Visual Receiver SUCCESS - audio via hls.js!", file=sys.stderr)
                return {"success": True, "state": "HLS_JS_PLAYING", "mode": "hls"}
            else:
                # Default Media Receiver - IDLE actually means failure
                print(f"[HLS-TV] Playback FAILED - IDLE (reason: {idle_reason})", file=sys.stderr)
                return {"success": False, "error": f"Playback failed: {idle_reason}", "mode": "hls"}
        else:
            state = status.player_state if status else 'unknown'
            print(f"[HLS-TV] Playback state unknown: {state}", file=sys.stderr)
            return {"success": True, "state": state, "mode": "hls"}

    except Exception as e:
        import traceback
        print(f"[HLS-TV] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


def webrtc_launch_multicast(speaker_names, https_url, speaker_ips=None, stream_name="pcaudio", app_id=None):
    """Launch custom receiver on MULTIPLE speakers for true multi-room audio.

    This is the solution for Cast Groups - instead of casting to the group (which only
    plays on the leader), we cast to each member individually.

    Args:
        speaker_names: List of speaker names to cast to
        https_url: WebRTC URL to send to receivers
        speaker_ips: Optional list of IPs (same order as names) for faster connection
        stream_name: MediaMTX stream path
        app_id: Which receiver to use (AUDIO_APP_ID or VISUAL_APP_ID). Defaults to AUDIO_APP_ID.

    Returns:
        { success: true, launched: ["Speaker1", "Speaker2"], failed: [] }
    """
    try:
        print(f"[Multicast] Launching on {len(speaker_names)} speakers: {speaker_names}", file=sys.stderr)

        launched = []
        failed = []

        # Launch receiver on each speaker
        for i, name in enumerate(speaker_names):
            ip = speaker_ips[i] if speaker_ips and i < len(speaker_ips) else None
            print(f"[Multicast] Launching on '{name}' (IP: {ip})...", file=sys.stderr)

            result = webrtc_launch(name, https_url, ip, stream_name, app_id)

            if result.get("success"):
                launched.append(name)
                print(f"[Multicast] SUCCESS: {name}", file=sys.stderr)
            else:
                failed.append({"name": name, "error": result.get("error", "Unknown error")})
                print(f"[Multicast] FAILED: {name} - {result.get('error')}", file=sys.stderr)

            # Small delay between launches to avoid overwhelming network
            time.sleep(0.5)

        return {
            "success": len(launched) > 0,
            "launched": launched,
            "failed": failed,
            "total": len(speaker_names),
            "mode": "multicast"
        }

    except Exception as e:
        import traceback
        print(f"[Multicast] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


# =============================================================================
# AUDIO DEVICE SWITCHING - IPolicyConfig COM Interface for Default Device
# =============================================================================

def get_audio_outputs():
    """Get list of filtered audio output (render) devices.

    Uses pycaw to enumerate Windows audio devices.
    Filters out virtual devices, digital outputs, and duplicates.

    Returns:
        { success: true, devices: [{ name, id, isDefault }, ...] }
    """
    try:
        from pycaw.pycaw import AudioUtilities

        print(f"[AudioOutput] Enumerating audio devices...", file=sys.stderr)

        devices = AudioUtilities.GetAllDevices()

        # Get current default device ID for comparison
        default_id = None
        try:
            default_speaker = AudioUtilities.GetSpeakers()
            if default_speaker:
                # GetSpeakers() returns IMMDevice COM - try GetId() method
                # If that fails, it might be wrapped AudioDevice - use .id property
                try:
                    default_id = default_speaker.GetId()
                except AttributeError:
                    default_id = getattr(default_speaker, 'id', None)
                print(f"[AudioOutput] Current default ID: {default_id}", file=sys.stderr)
        except Exception as e:
            print(f"[AudioOutput] Could not get default ID: {e}", file=sys.stderr)

        # MINIMAL EXCLUSIONS - Only internal routing devices used by this app!
        # Show ALL real hardware to users - don't assume what they have
        exclude_patterns = [
            'virtual desktop audio',  # Our internal routing device
            'cable input',            # VB-Cable render (internal routing)
            'cable output',           # VB-Cable capture (internal routing)
        ]

        output_devices = []
        seen_names = set()  # Track seen device names to avoid duplicates

        for device in devices:
            # Device ID format: {0.0.0.xxxxxxxx}.{guid} for render, {0.0.1.xxxxxxxx}.{guid} for capture
            if device.id and device.id.startswith("{0.0.0."):
                name = device.FriendlyName or "Unknown Device"
                name_lower = name.lower()

                # CRITICAL: Only include ACTIVE devices!
                # State: Active=1, Disabled=2, NotPresent=4, Unplugged=8
                state_str = str(device.state) if device.state else ""
                if "Active" not in state_str:
                    print(f"[AudioOutput] Skipping (not active): {name} [{state_str}]", file=sys.stderr)
                    continue

                # Skip excluded devices
                is_excluded = any(pattern in name_lower for pattern in exclude_patterns)
                if is_excluded:
                    print(f"[AudioOutput] Skipping (virtual/digital): {name}", file=sys.stderr)
                    continue

                # Skip duplicates (keep first occurrence)
                if name in seen_names:
                    print(f"[AudioOutput] Skipping (duplicate): {name}", file=sys.stderr)
                    continue
                seen_names.add(name)

                device_info = {
                    "name": name,
                    "id": device.id,
                    "isDefault": device.id == default_id if default_id else False
                }
                output_devices.append(device_info)
                print(f"[AudioOutput] Found: {device_info['name']} {'(DEFAULT)' if device_info['isDefault'] else ''}", file=sys.stderr)

        print(f"[AudioOutput] Total: {len(output_devices)} usable devices (filtered)", file=sys.stderr)
        return {"success": True, "devices": output_devices}

    except ImportError as ie:
        print(f"[AudioOutput] Missing dependency: {ie}", file=sys.stderr)
        return {"success": False, "error": f"Missing dependency: {str(ie)}. Run: pip install pycaw comtypes"}
    except Exception as e:
        import traceback
        print(f"[AudioOutput] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


def set_default_audio_output(device_name):
    """Set the default Windows audio output device using IPolicyConfig COM.

    Uses Windows IPolicyConfig interface directly - this is reliable and fast.
    Finds device by name and sets it as default for all audio roles.

    Args:
        device_name: Full or partial name of the audio device to set as default

    Returns:
        { success: true, device: "Device Name" } or { success: false, error: "..." }
    """
    try:
        import comtypes
        from comtypes import GUID
        from pycaw.pycaw import AudioUtilities

        print(f"[AudioSwitch] Setting default device to: {device_name}", file=sys.stderr)

        # Get all audio devices
        devices = AudioUtilities.GetAllDevices()
        device_name_lower = device_name.lower()

        # Find matching render device - MUST be ACTIVE!
        target_device = None
        for device in devices:
            # Only render devices (ID starts with {0.0.0.)
            if not device.id or not device.id.startswith("{0.0.0."):
                continue

            # CRITICAL: Only match ACTIVE devices!
            # Multiple devices can have same name but different states (Active, NotPresent, etc.)
            state_str = str(device.state) if device.state else ""
            if "Active" not in state_str:
                continue

            name = device.FriendlyName or ""
            if device_name_lower in name.lower():
                target_device = device
                print(f"[AudioSwitch] Found device: {name}", file=sys.stderr)
                print(f"[AudioSwitch] Device ID: {device.id}", file=sys.stderr)
                print(f"[AudioSwitch] State: {state_str}", file=sys.stderr)
                break

        if not target_device:
            print(f"[AudioSwitch] Device not found: {device_name}", file=sys.stderr)
            return {"success": False, "error": f"Audio device '{device_name}' not found"}

        # IPolicyConfig COM interface for setting default audio device
        CLSID_PolicyConfig = GUID('{870af99c-171d-4f9e-af0d-e63df40c2bc9}')
        IID_IPolicyConfig = GUID('{f8679f50-850a-41cf-9c72-430f290290c8}')

        class IPolicyConfig(comtypes.IUnknown):
            _iid_ = IID_IPolicyConfig
            _methods_ = [
                comtypes.COMMETHOD([], comtypes.HRESULT, 'GetMixFormat', (['in'], comtypes.c_wchar_p)),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'GetDeviceFormat', (['in'], comtypes.c_wchar_p)),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'ResetDeviceFormat', (['in'], comtypes.c_wchar_p)),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'SetDeviceFormat', (['in'], comtypes.c_wchar_p)),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'GetProcessingPeriod'),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'SetProcessingPeriod'),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'GetShareMode'),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'SetShareMode'),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'GetPropertyValue'),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'SetPropertyValue'),
                comtypes.COMMETHOD([], comtypes.HRESULT, 'SetDefaultEndpoint',
                                  (['in'], comtypes.c_wchar_p, 'deviceId'),
                                  (['in'], comtypes.c_uint, 'role')),
            ]

        # Create policy config instance
        policy_config = comtypes.CoCreateInstance(
            CLSID_PolicyConfig,
            IPolicyConfig,
            comtypes.CLSCTX_INPROC_SERVER
        )

        # Set as default for all roles:
        # 0 = eConsole (games, system sounds)
        # 1 = eMultimedia (music, movies)
        # 2 = eCommunications (voice chat)
        for role in [0, 1, 2]:
            policy_config.SetDefaultEndpoint(target_device.id, role)
            print(f"[AudioSwitch] Set role {role} to: {target_device.FriendlyName}", file=sys.stderr)

        print(f"[AudioSwitch] SUCCESS - Default device set to: {target_device.FriendlyName}", file=sys.stderr)
        return {"success": True, "device": target_device.FriendlyName, "id": target_device.id}

    except Exception as e:
        import traceback
        print(f"[AudioSwitch] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


def measure_latency(speaker_name, speaker_ip=None, timeout=15):
    """Request latency measurement from Cast receiver.

    Sends a 'measure-latency' message to the receiver, which measures RTT
    using WebRTC getStats() and sends back a 'latency-result' message.

    Args:
        speaker_name: Name of the speaker
        speaker_ip: Optional IP for faster connection
        timeout: How long to wait for response (default 15s, measurement takes ~10s)

    Returns:
        { success: true, rtt: 42, recommendedDelay: 521, samples: 5 }
    """
    try:
        browser = None

        if speaker_ip:
            print(f"[MeasureLatency] Connecting to {speaker_name} at {speaker_ip}...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                known_hosts=[speaker_ip],
                timeout=5
            )
        else:
            print(f"[MeasureLatency] Looking for '{speaker_name}'...", file=sys.stderr)
            chromecasts, browser = pychromecast.get_listed_chromecasts(
                friendly_names=[speaker_name],
                timeout=10
            )

        if not chromecasts:
            if browser:
                browser.stop_discovery()
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast = chromecasts[0]
        cast.wait(timeout=10)

        # Register WebRTC namespace controller
        webrtc = WebRTCController()
        cast.register_handler(webrtc)

        # Clear any pending messages
        webrtc.messages.clear()
        webrtc.message_event.clear()

        # Send measure-latency request
        print(f"[MeasureLatency] Sending measure-latency request...", file=sys.stderr)
        webrtc.send_message({"type": "measure-latency"})

        # Wait for latency-result response
        print(f"[MeasureLatency] Waiting for response (up to {timeout}s)...", file=sys.stderr)

        # Poll for response
        import time
        start_time = time.time()
        while time.time() - start_time < timeout:
            if webrtc.messages:
                response = webrtc.messages.pop(0)
                if response.get('type') == 'latency-result':
                    print(f"[MeasureLatency] Got result: RTT={response.get('rtt')}ms, Recommended={response.get('recommendedDelay')}ms", file=sys.stderr)
                    if browser:
                        browser.stop_discovery()
                    return {
                        "success": True,
                        "rtt": response.get('rtt'),
                        "recommendedDelay": response.get('recommendedDelay'),
                        "samples": response.get('samples', 0)
                    }
            time.sleep(0.5)

        if browser:
            browser.stop_discovery()
        return {"success": False, "error": "Timeout waiting for latency measurement"}

    except Exception as e:
        import traceback
        print(f"[MeasureLatency] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
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
        # Optional timeout argument: discover [timeout]
        timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 12
        result = discover_speakers(timeout=timeout)
        print(json.dumps(result))

    elif command == "ping" and len(sys.argv) >= 3:
        # Ping - triggers Nest's pairing sound by launching a new Cast session
        # The pairing "ding" only plays when starting a NEW app, not when playing media
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

                # Step 1: Quit any existing app to reset the session
                print(f"Quitting existing app...", file=sys.stderr)
                cast.quit_app()
                time.sleep(1)

                # Step 2: Launch the default media receiver - this triggers the pairing sound!
                # App ID CC1AD845 is the default media receiver
                print(f"Launching default receiver (triggers pairing sound)...", file=sys.stderr)
                cast.start_app("CC1AD845")
                time.sleep(1.5)  # Give it time to play the chime

                # Step 3: Quit the app so speaker returns to idle
                cast.quit_app()

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
        # Args: webrtc-launch <speaker_name> [https_url] [speaker_ip] [stream_name] [app_id]
        speaker = sys.argv[2]
        https_url = sys.argv[3] if len(sys.argv) > 3 else None
        speaker_ip = sys.argv[4] if len(sys.argv) > 4 else None
        stream_name = sys.argv[5] if len(sys.argv) > 5 else "pcaudio"
        app_id = sys.argv[6] if len(sys.argv) > 6 else None
        result = webrtc_launch(speaker, https_url, speaker_ip, stream_name, app_id)
        print(json.dumps(result))

    elif command == "webrtc-proxy-connect" and len(sys.argv) >= 4:
        # NEW: Proxy signaling - PC proxies WHEP requests to avoid mixed content
        # Args: webrtc-proxy-connect <speaker_name> <mediamtx_url> [speaker_ip] [stream_name] [app_id]
        speaker = sys.argv[2]
        mediamtx_url = sys.argv[3]
        speaker_ip = sys.argv[4] if len(sys.argv) > 4 else None
        stream_name = sys.argv[5] if len(sys.argv) > 5 else "pcaudio"
        app_id = sys.argv[6] if len(sys.argv) > 6 else None
        result = webrtc_proxy_connect(speaker, mediamtx_url, speaker_ip, stream_name, app_id)
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

    elif command == "stop-fast" and len(sys.argv) >= 4:
        # Fast stop using cached IP - no network scan
        speaker = sys.argv[2]
        speaker_ip = sys.argv[3]
        result = stop_cast_fast(speaker, speaker_ip)
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

    elif command == "get-group-members" and len(sys.argv) >= 3:
        # Get individual speakers in a Cast Group for multi-casting
        group_name = sys.argv[2]
        result = get_group_members(group_name)
        print(json.dumps(result, indent=2))

    elif command == "webrtc-multicast" and len(sys.argv) >= 4:
        # Launch WebRTC on multiple speakers simultaneously
        # Args: webrtc-multicast <speaker_names_json> <https_url> [speaker_ips_json] [stream_name] [app_id]
        speaker_names = json.loads(sys.argv[2])  # ["Speaker1", "Speaker2"]
        https_url = sys.argv[3]
        speaker_ips = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != "null" else None
        stream_name = sys.argv[5] if len(sys.argv) > 5 else "pcaudio"
        app_id = sys.argv[6] if len(sys.argv) > 6 else None
        result = webrtc_launch_multicast(speaker_names, https_url, speaker_ips, stream_name, app_id)
        print(json.dumps(result))

    elif command == "hls-cast" and len(sys.argv) >= 4:
        # Cast HLS stream to TV devices (NVIDIA Shield, Chromecast with screen)
        # Args: hls-cast <device_name> <hls_url> [device_ip] [model] [app_id]
        device_name = sys.argv[2]
        hls_url = sys.argv[3]
        device_ip = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != '' else None
        device_model = sys.argv[5] if len(sys.argv) > 5 else None
        app_id = sys.argv[6] if len(sys.argv) > 6 else None  # Visual receiver by default
        result = hls_cast_to_tv(device_name, hls_url, device_ip, device_model, app_id)
        print(json.dumps(result))

    elif command == "cast-url" and len(sys.argv) >= 4:
        # Cast ANY URL to TV (generic URL casting - user provides URL, TV plays it)
        # Args: cast-url <device_name> <url> [content_type] [device_ip]
        device_name = sys.argv[2]
        url = sys.argv[3]
        content_type = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != '' else None
        device_ip = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] != '' else None
        result = cast_url_to_tv(device_name, url, content_type, device_ip)
        print(json.dumps(result))

    elif command == "get-audio-outputs":
        # Get list of all audio output devices
        result = get_audio_outputs()
        print(json.dumps(result))

    elif command == "set-audio-output" and len(sys.argv) >= 3:
        # Set default Windows audio output device using IPolicyConfig
        # Args: set-audio-output <device_name>
        device_name = sys.argv[2]
        result = set_default_audio_output(device_name)
        print(json.dumps(result))

    elif command == "measure-latency" and len(sys.argv) >= 3:
        # Request latency measurement from Cast receiver
        # Args: measure-latency <speaker_name> [speaker_ip] [timeout]
        speaker = sys.argv[2]
        speaker_ip = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != '' else None
        timeout = int(sys.argv[4]) if len(sys.argv) > 4 else 15
        result = measure_latency(speaker, speaker_ip, timeout)
        print(json.dumps(result))

    else:
        print(json.dumps({"success": False, "error": "Invalid command. Use: discover, ping, cast, webrtc-launch, set-volume, get-audio-outputs, set-audio-output, or stop"}))
        sys.exit(1)
