# TV Video Casting Research

*Compiled: January 2025*

---

## Overview

This document contains all research needed to implement video/URL casting to TVs via Google Cast.

**KEY INSIGHT:** We're sending URLs to TVs, NOT screen sharing. The TV fetches and plays the URL directly.

---

## CRITICAL FINDINGS (Confirmed)

### WebRTC Video on Cast: **NOT POSSIBLE**
- Cast Receiver runtime ≠ full Chrome
- **No `RTCPeerConnection` in Cast receivers**
- Even on Shield, Cast apps are sandboxed
- WebRTC only works in: Android apps, Chrome browser, WebView apps

### HLS Latency: **Can't go below 6 seconds**
- Standard HLS: 10-30s typical
- LL-HLS: Maybe 2-5s but **Chromecast support is inconsistent**
- Chromecast prioritizes **stability over latency**
- **Stop chasing sub-second latency on Cast - it's impossible**

### GPU Encoding (NVENC): **YES, DO IT**
- 5-10x faster than CPU encoding
- Very low CPU usage
- Removes encoding as bottleneck

---

## 1. Cast Branding - Two Layers

### Layer A: Cast UI (Phone/Chrome Picker)
- **NOT coded in receiver** - configured in Google Cast Developer Console
- Set **Application Name** (shows as "Now Casting: YourAppName")
- Upload **icons/branding assets**
- Our App ID: `FCAA4619` (Visual Receiver)

### Layer B: TV Display (Receiver UI)
- Controlled via `<cast-media-player>` CSS variables
- Or custom HTML/CSS if not using default player

---

## 2. Receiver Branding CSS Variables

For `<cast-media-player>` element:

```css
cast-media-player {
  --background-image: url("https://yourcdn.com/brand/bg.jpg");
  --splash-image: url("https://yourcdn.com/brand/splash.png");
  --logo-image: url("https://yourcdn.com/brand/logo.png");
  --font-family: "Inter, system-ui, sans-serif";
}
```

**Note:** We can host these on GitHub Pages alongside the receiver.

---

## 3. Application State Text

Set what shows in "Now Casting" UI:

```js
const context = cast.framework.CastReceiverContext.getInstance();
context.setApplicationState("PC Nest Speaker");
context.start();
```

---

## 4. Sender → Receiver Flow (The Core Pattern)

### Steps:
1. Initialize Cast
2. Request session
3. Create `MediaInfo(contentId, contentType)`
4. Create `LoadRequest(mediaInfo)`
5. `castSession.loadMedia(loadRequest)`

### Minimal Web Sender Code:

```js
async function castUrlToTv(url, contentType) {
  const context = cast.framework.CastContext.getInstance();
  const session = context.getCurrentSession() || await context.requestSession();

  const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);

  // Optional metadata (title, images) shown in controls
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = "PC Nest Speaker";
  mediaInfo.metadata.subtitle = "Casting from desktop";
  mediaInfo.metadata.images = [
    new chrome.cast.Image("https://yourcdn.com/brand/thumb.png")
  ];

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.autoplay = true;
  request.currentTime = 0;

  // Custom data for receiver to read
  request.customData = {
    showAmbient: true,
    brandColor: "#334E58"
  };

  await session.loadMedia(request);
}
```

### For pychromecast (our current approach):

```python
# Already using this pattern in cast-helper.py
mc = cast.media_controller
mc.play_media(url, content_type, ...)
```

---

## 5. Content-Type Reference

| Format | Content-Type |
|--------|--------------|
| MP4 | `video/mp4` |
| HLS | `application/x-mpegURL` or `application/vnd.apple.mpegurl` |
| DASH | `application/dash+xml` |
| WebM | `video/webm` |
| MKV | `video/x-matroska` |

**CRITICAL:** Must use correct MIME type or Cast will reject!

---

## 6. Custom Data (Dynamic Branding Per-Cast)

### Sender Side:
```js
request.customData = {
  showAmbient: true,
  brandColor: "#334E58",
  streamType: "video"  // vs "audio"
};
```

### Receiver Side (read on LOAD):
```js
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  request => {
    if (request.customData) {
      if (request.customData.showAmbient) {
        startAmbientVideos();
      }
      if (request.customData.streamType === 'video') {
        showVideoPlayer();
      }
    }
    return request;
  }
);
```

---

## 7. Common Failure Reasons

| Issue | Cause | Solution |
|-------|-------|----------|
| Cast can't reach URL | `localhost` or private LAN | Use PC's LAN IP (e.g., `192.168.x.x`) |
| HTTPS/cert errors | Self-signed or HTTP | Use HTTP for local, or valid HTTPS |
| Codec not supported | MP4 with wrong codec | Use H.264 + AAC |
| Wrong content-type | Mismatched MIME | Match exactly to format |

---

## 8. Video Codec Support (Chromecast/Shield)

### Supported Video Codecs:
- **H.264** (most compatible)
- **VP8** (WebM)
- **VP9** (4K capable)
- **HEVC/H.265** (Chromecast Ultra, Shield only)
- **AV1** (newest devices)

### Supported Audio Codecs:
- **AAC** (most compatible)
- **MP3**
- **Opus** (WebM)
- **Vorbis**
- **FLAC**

### Recommended for Maximum Compatibility:
- **Container:** MP4 or HLS
- **Video:** H.264 Baseline/Main/High profile
- **Audio:** AAC-LC

---

## 9. FFmpeg Screen Capture for Video

### Windows Desktop Capture:

```bash
ffmpeg -f gdigrab -framerate 30 -i desktop \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -c:a aac -b:a 128k \
  -f hls -hls_time 2 -hls_list_size 3 \
  output/stream.m3u8
```

### Low-Latency Options:
- `-preset ultrafast` - Fastest encoding
- `-tune zerolatency` - Minimize latency
- `-g 60` - Keyframe every 2 seconds at 30fps
- `-sc_threshold 0` - No scene change detection

### With Audio (from VB-Cable):

```bash
ffmpeg -f gdigrab -framerate 30 -i desktop \
  -f dshow -i audio="CABLE Output (VB-Audio Virtual Cable)" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -c:a aac -b:a 128k \
  -f hls -hls_time 2 -hls_list_size 3 \
  output/stream.m3u8
```

---

## 10. MediaMTX Video Support

MediaMTX can handle video streams via:
- **RTSP input** (from FFmpeg)
- **WebRTC output** (to receivers)
- **HLS output** (already configured)

### Current Config (audio-only):
```yaml
paths:
  pcaudio:
    source: publisher
```

### For Video:
```yaml
paths:
  pcvideo:
    source: publisher
  pcaudio:
    source: publisher
```

FFmpeg would publish video to `rtsp://localhost:8554/pcvideo`

---

## 11. Implementation Plan

### Phase 1: Audio-Only TV Streaming (Current)
- [x] HLS audio streaming to TVs
- [x] Visual receiver with ambient videos
- [ ] Test on Shield

### Phase 2: Video Streaming
1. Add FFmpeg screen capture command
2. Create new MediaMTX path for video
3. Update receiver to handle video vs audio mode
4. Add UI toggle for "Cast Screen" vs "Cast Audio"

### Phase 3: Optimization
1. Tune encoding for lowest latency
2. Add quality presets (720p, 1080p)
3. Handle aspect ratios

---

## 12. Key Files to Modify

| File | Changes Needed |
|------|----------------|
| `electron-main.js` | Add video FFmpeg command, video streaming functions |
| `cast-helper.py` | Update `hls_cast_to_tv()` for video content-type |
| `receiver-visual.html` | Handle video mode, show video player instead of ambient |
| `mediamtx-audio.yml` | Add video path (or create `mediamtx-video.yml`) |
| `renderer.js` | Add "Cast Screen" button/toggle |
| `index.html` | UI for video casting options |

---

## 13. References

- [Cast Registration](https://developers.google.com/cast/docs/registration)
- [CastReceiverContext](https://developers.google.com/cast/docs/reference/web_receiver/cast.framework.CastReceiverContext)
- [Style the Player](https://developers.google.com/cast/docs/web_receiver/customize_ui)
- [Web Sender Integration](https://developers.google.com/cast/docs/web_sender/integrate)
- [Core Features](https://developers.google.com/cast/docs/web_receiver/core_features)

---

*Ready for implementation!*
