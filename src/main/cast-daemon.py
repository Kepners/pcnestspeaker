#!/usr/bin/env python3
"""
Cast Daemon - Persistent pychromecast connection manager

Runs as a long-lived subprocess, maintaining persistent connections to Cast devices.
This eliminates the 3-5 second mDNS discovery delay on each command.

Communication is via JSON lines on stdin/stdout:
  Input:  {"cmd": "set-volume", "speaker": "Living Room", "volume": 0.5, "ip": "192.168.x.x"}
  Output: {"success": true, "volume": 0.5}

Supported commands:
  - set-volume: Set speaker volume (0.0-1.0) - INSTANT with cached connection
  - get-volume: Get current volume
  - ping: Play test sound
  - connect: Establish connection to speaker
  - disconnect: Close connection to speaker
  - status: Get daemon status
  - quit: Shutdown daemon
"""

import sys
import json
import time
import threading
import pychromecast
from collections import defaultdict

# Connection cache: speaker_name -> { cast, browser, connected_at, ip }
connections = {}
connections_lock = threading.Lock()

# Keep connections alive by refreshing status periodically
KEEPALIVE_INTERVAL = 30  # seconds


def log(msg):
    """Log to stderr (won't interfere with JSON output on stdout)."""
    print(f"[Daemon] {msg}", file=sys.stderr, flush=True)


def get_or_create_connection(speaker_name, speaker_ip=None):
    """Get existing connection or create new one.

    With cached connection: ~0ms
    With IP hint: ~500ms
    Without IP: ~3-5s (full mDNS scan)
    """
    with connections_lock:
        # Check for existing valid connection
        if speaker_name in connections:
            conn = connections[speaker_name]
            cast = conn['cast']

            # Verify connection is still alive
            try:
                # Quick status check - if this fails, connection is dead
                _ = cast.status
                log(f"Reusing cached connection to '{speaker_name}'")
                return cast, None  # None browser = don't need to stop discovery
            except Exception as e:
                log(f"Cached connection dead: {e}")
                # Clean up dead connection
                try:
                    if conn.get('browser'):
                        conn['browser'].stop_discovery()
                except:
                    pass
                del connections[speaker_name]

        # Create new connection
        log(f"Creating new connection to '{speaker_name}'...")

        try:
            if speaker_ip:
                # Fast path: use known_hosts hint
                log(f"Using known host: {speaker_ip}")
                chromecasts, browser = pychromecast.get_listed_chromecasts(
                    friendly_names=[speaker_name],
                    known_hosts=[speaker_ip],
                    timeout=3
                )
            else:
                # Slow path: full mDNS discovery
                log(f"Full mDNS discovery (slow)...")
                chromecasts, browser = pychromecast.get_listed_chromecasts(
                    friendly_names=[speaker_name],
                    timeout=10
                )

            if not chromecasts:
                log(f"Speaker '{speaker_name}' not found")
                browser.stop_discovery()
                return None, None

            cast = chromecasts[0]
            cast.wait(timeout=5)

            # Cache the connection
            connections[speaker_name] = {
                'cast': cast,
                'browser': browser,
                'connected_at': time.time(),
                'ip': cast.cast_info.host
            }

            log(f"Connected to '{speaker_name}' at {cast.cast_info.host}")
            return cast, browser

        except Exception as e:
            log(f"Connection failed: {e}")
            return None, None


def set_volume(speaker_name, volume, speaker_ip=None):
    """Set volume on speaker using cached connection."""
    try:
        volume = max(0.0, min(1.0, float(volume)))

        cast, _ = get_or_create_connection(speaker_name, speaker_ip)
        if not cast:
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        cast.set_volume(volume)
        log(f"Volume set to {int(volume * 100)}%")

        return {"success": True, "volume": volume}

    except Exception as e:
        log(f"set_volume error: {e}")
        return {"success": False, "error": str(e)}


def get_volume(speaker_name, speaker_ip=None):
    """Get current volume from speaker."""
    try:
        cast, _ = get_or_create_connection(speaker_name, speaker_ip)
        if not cast:
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        volume = cast.status.volume_level if cast.status else 0.5
        muted = cast.status.volume_muted if cast.status else False

        return {"success": True, "volume": volume, "muted": muted}

    except Exception as e:
        return {"success": False, "error": str(e)}


def ping_speaker(speaker_name, speaker_ip=None):
    """Verify connection to speaker (no sound - just connection test)."""
    try:
        cast, _ = get_or_create_connection(speaker_name, speaker_ip)
        if not cast:
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        # Just verify connection is working - no sound
        volume = cast.status.volume_level if cast.status else None
        log(f"Connection verified! Volume: {int(volume * 100) if volume else 'N/A'}%")

        return {
            "success": True,
            "ip": cast.cast_info.host,
            "volume": volume
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def connect_speaker(speaker_name, speaker_ip=None):
    """Explicitly establish connection to speaker."""
    try:
        cast, _ = get_or_create_connection(speaker_name, speaker_ip)
        if not cast:
            return {"success": False, "error": f"Speaker '{speaker_name}' not found"}

        return {
            "success": True,
            "speaker": speaker_name,
            "ip": cast.cast_info.host,
            "model": cast.cast_info.model_name
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def disconnect_speaker(speaker_name):
    """Close connection to speaker and quit the Cast app.

    Plays the Cast "ding" sound on disconnect by briefly launching
    the Default Media Receiver before quitting.
    """
    try:
        with connections_lock:
            if speaker_name in connections:
                conn = connections[speaker_name]
                cast = conn['cast']

                # CRITICAL: quit_app() stops the Cast receiver - this actually stops audio!
                try:
                    cast.quit_app()
                    log(f"Quit Cast app on '{speaker_name}'")
                except Exception as e:
                    log(f"quit_app failed: {e}")

                # PLAY DISCONNECT CHIME: Launch Default Media Receiver briefly
                # The "ding" sound ONLY plays when start_app() is called!
                try:
                    time.sleep(0.3)  # Brief pause after quit
                    cast.start_app("CC1AD845")  # Default Media Receiver - triggers ding!
                    log(f"Playing disconnect chime on '{speaker_name}'")
                    time.sleep(1.0)  # Let the chime play
                    cast.quit_app()  # Clean up - leave speaker idle
                except Exception as e:
                    log(f"Disconnect chime failed (non-critical): {e}")

                # Then disconnect the socket
                try:
                    cast.disconnect()
                except:
                    pass
                try:
                    if conn.get('browser'):
                        conn['browser'].stop_discovery()
                except:
                    pass
                del connections[speaker_name]
                log(f"Disconnected from '{speaker_name}'")
                return {"success": True}
            else:
                return {"success": True, "message": "Not connected"}

    except Exception as e:
        return {"success": False, "error": str(e)}


def get_status():
    """Get daemon status including active connections."""
    with connections_lock:
        active = []
        for name, conn in connections.items():
            active.append({
                "name": name,
                "ip": conn.get('ip'),
                "connected_at": conn.get('connected_at'),
                "age_seconds": int(time.time() - conn.get('connected_at', 0))
            })

        return {
            "success": True,
            "running": True,
            "connections": active,
            "connection_count": len(active)
        }


def cleanup_all():
    """Clean up all connections."""
    log("Cleaning up all connections...")
    with connections_lock:
        for name, conn in list(connections.items()):
            try:
                conn['cast'].disconnect()
            except:
                pass
            try:
                if conn.get('browser'):
                    conn['browser'].stop_discovery()
            except:
                pass
        connections.clear()
    log("All connections closed")


def process_command(cmd_data):
    """Process a single command and return result."""
    cmd = cmd_data.get('cmd', '')
    speaker = cmd_data.get('speaker', '')
    speaker_ip = cmd_data.get('ip', None)

    if cmd == 'set-volume':
        volume = cmd_data.get('volume', 0.5)
        return set_volume(speaker, volume, speaker_ip)

    elif cmd == 'get-volume':
        return get_volume(speaker, speaker_ip)

    elif cmd == 'ping':
        return ping_speaker(speaker, speaker_ip)

    elif cmd == 'connect':
        return connect_speaker(speaker, speaker_ip)

    elif cmd == 'disconnect':
        return disconnect_speaker(speaker)

    elif cmd == 'status':
        return get_status()

    elif cmd == 'quit':
        cleanup_all()
        return {"success": True, "message": "Daemon shutting down"}

    else:
        return {"success": False, "error": f"Unknown command: {cmd}"}


def main():
    """Main daemon loop - read JSON commands from stdin, write results to stdout."""
    log("Cast Daemon starting...")
    log("Reading JSON commands from stdin...")

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                cmd_data = json.loads(line)
                log(f"Received: {cmd_data.get('cmd', 'unknown')}")

                result = process_command(cmd_data)

                # Output result as JSON line
                print(json.dumps(result), flush=True)

                # Handle quit command
                if cmd_data.get('cmd') == 'quit':
                    break

            except json.JSONDecodeError as e:
                error_result = {"success": False, "error": f"Invalid JSON: {e}"}
                print(json.dumps(error_result), flush=True)
            except Exception as e:
                error_result = {"success": False, "error": str(e)}
                print(json.dumps(error_result), flush=True)

    except KeyboardInterrupt:
        log("Interrupted")
    finally:
        cleanup_all()
        log("Daemon stopped")


if __name__ == "__main__":
    main()
