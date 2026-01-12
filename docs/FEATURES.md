# PC Nest Speaker - Complete Feature List

## Core Purpose
Stream Windows system audio to Google Nest speakers over Wi-Fi. No Bluetooth required.

---

## 1. STREAMING FEATURES

### 1.1 WebRTC Streaming (Speakers)
**What**: Ultra-low-latency audio streaming to Nest Mini, Nest Audio, and Cast groups.
**Why**: WebRTC delivers near-instant audio (~50-200ms latency) compared to traditional Cast (~2-3 seconds). Users can watch videos on PC while audio plays on speakers without noticeable lip-sync issues.

### 1.2 HLS Streaming (TVs)
**What**: HTTP Live Streaming for Chromecast, TVs, and NVIDIA Shield.
**Why**: TVs and Chromecast don't support custom Cast receivers. HLS uses Google's Default Media Receiver which works universally on all Cast-enabled displays.

### 1.3 Stereo Mode (Two Mono Speakers)
**What**: Assign two separate Nest speakers as Left and Right channels for true stereo separation.
**Why**: A single Nest Mini is mono. Users with two speakers can get stereo sound by assigning one to L and one to R. Creates immersive audio across the room.

### 1.4 Group/Stereo Pair Support
**What**: Stream to Cast groups (multi-room) or factory stereo pairs (two speakers configured as stereo in Google Home).
**Why**: Users who already set up speaker groups in Google Home can stream to all of them simultaneously. No need to reconfigure existing setups.

### 1.5 Parallel Speaker Connection
**What**: When streaming to stereo pair, both L and R speakers connect simultaneously.
**Why**: Sequential connection caused left speaker to start playing before right, creating timing drift. Parallel connection ensures perfect L/R sync.

---

## 2. WALL OF SOUND (PC + NEST SYNC)

### 2.1 Add PC Speaker Mode
**What**: Toggle to play audio on BOTH PC speakers AND Nest speakers simultaneously.
**Why**: Some users want room-filling sound from multiple sources. PC speakers handle nearby listening while Nest fills the rest of the room. Creates immersive "wall of sound" experience.

### 2.2 Audio Sync Delay (Equalizer APO)
**What**: Adds configurable delay (0-2000ms) to PC speakers using Equalizer APO.
**Why**: Network streaming adds latency. Without delay, PC speakers play ahead of Nest speakers. The delay synchronizes them so audio arrives at your ears simultaneously.

### 2.3 Auto-Sync (Network Monitoring)
**What**: Continuously monitors network round-trip time (RTT) to Nest speaker and auto-adjusts PC delay.
**Why**: Network conditions fluctuate (Wi-Fi congestion, other devices). Auto-sync checks RTT every 500ms and adjusts delay if drift exceeds 10ms. Maintains perfect sync without manual intervention.

### 2.4 Baseline Calibration
**What**: User calibrates "perfect sync" once, app saves that baseline.
**Why**: Every setup is different (router, speaker distance, network topology). User finds their perfect delay, then auto-sync maintains that relative timing automatically.

### 2.5 Old Calibration Auto-Correction
**What**: If saved delay > 300ms, auto-corrects to 100ms on boot.
**Why**: WebRTC optimization reduced latency dramatically. Users with old calibration values (700-1200ms from before optimization) would have 10+ second delays. Auto-correction prevents broken UX.

---

## 3. VOLUME CONTROL

### 3.1 Unified Volume Sync
**What**: PC keyboard volume keys control BOTH Nest speakers AND PC speakers.
**Why**: Users expect volume keys to control what they're hearing. When audio plays on multiple devices, all should adjust together. One keypress = all devices change.

### 3.2 Per-Device Volume (SoundVolumeView)
**What**: Uses SoundVolumeView to set individual device volumes.
**Why**: Windows only has "master" volume. SoundVolumeView enables per-device control so PC speakers and Nest can have different base volumes but adjust proportionally.

### 3.3 Fast Volume via Daemon
**What**: Background Python daemon maintains Cast connections for instant volume changes.
**Why**: Normal pychromecast connection takes 2-3 seconds. Daemon keeps connection warm, enabling <100ms volume response. Feels instant when pressing keys.

---

## 4. DEVICE MANAGEMENT

### 4.1 Auto-Discovery
**What**: Scans network for all Cast-enabled devices (speakers, TVs, groups).
**Why**: Users shouldn't need to manually configure IP addresses. mDNS discovery finds everything automatically, just like Google Home app does.

### 4.2 Device Type Detection
**What**: Identifies device type (audio speaker, TV, group, stereo pair) from Cast metadata.
**Why**: Different devices need different handling. Speakers use WebRTC, TVs use HLS, groups need special multicast handling. App chooses correct streaming method automatically.

### 4.3 Auto-Reconnect on Boot
**What**: Remembers last connected speaker(s) and reconnects automatically when app starts.
**Why**: Users don't want to click the same speaker every time they open the app. Saves last selection (including stereo mode) and restores it instantly.

### 4.4 Smart PC Speaker Detection
**What**: On first run, saves the user's current default audio device as their "real speakers."
**Why**: When app switches to VB-Cable for streaming, it needs to know which device to restore on exit. Captures the original device before any changes.

### 4.5 Audio Device Restore on Exit
**What**: Returns Windows audio output to original device when app closes.
**Why**: If app crashes or user quits, Windows shouldn't be stuck on VB-Cable (silence). Always restores to real speakers for working audio.

---

## 5. CAST EXPERIENCE

### 5.1 Connect Chime
**What**: Nest speaker plays the Cast "ding" sound when streaming starts.
**Why**: Professional feedback that connection succeeded. User hears confirmation without looking at screen. Matches behavior of other Cast apps (YouTube, Spotify).

### 5.2 Disconnect Chime
**What**: Nest speaker plays "ding" when streaming stops.
**Why**: Confirms disconnection happened. Without it, user might wonder if audio is still streaming. Clean audible closure to session.

### 5.3 Custom Audio Receiver
**What**: Lean Cast receiver app (ID: 4B876246) for speakers.
**Why**: Default Media Receiver is bloated with video features. Custom receiver is audio-only, reduces memory usage on speaker, enables WebRTC which DMR doesn't support.

### 5.4 Visual Receiver for TVs
**What**: Cast receiver (ID: FCAA4619) with ambient video backgrounds for TV displays.
**Why**: When streaming to TV, a blank screen is ugly. Visual receiver shows calming ambient videos (fireplace, waves, etc.) while audio plays. Premium experience.

---

## 6. AUDIO PIPELINE

### 6.1 VB-Cable Integration
**What**: Routes Windows audio through virtual audio cable for capture.
**Why**: Windows doesn't allow direct system audio capture. VB-Cable creates a loopback: apps output to CABLE Input, FFmpeg captures from CABLE Output. Enables "what you hear" streaming.

### 6.2 "Listen to This Device" for PC Speakers
**What**: Enables Windows audio monitoring so VB-Cable output plays through PC speakers too.
**Why**: When streaming to Nest, user still wants to hear on PC speakers (for Wall of Sound). This Windows feature mirrors VB-Cable output to real speakers.

### 6.3 FFmpeg Low-Latency Encoding
**What**: FFmpeg with optimized flags for minimal delay.
**Why**: Default FFmpeg settings buffer heavily (500ms+). Custom flags reduce to ~50ms: `-audio_buffer_size 50`, `-fflags nobuffer`, `-application lowdelay` for Opus.

### 6.4 MediaMTX Server
**What**: Local RTSP/HLS server that receives FFmpeg output and serves to Cast devices.
**Why**: Single FFmpeg stream can serve multiple outputs (WebRTC for speakers, HLS for TVs). MediaMTX handles protocol conversion and multiple client connections.

### 6.5 Codec Switching (Opus/AAC)
**What**: Opus codec for WebRTC streaming, AAC for HLS streaming.
**Why**: WebRTC requires Opus (optimized for real-time). HLS requires AAC (Apple standard, universal playback). App switches codec when target device changes.

---

## 7. USER INTERFACE

### 7.1 Speaker List with Status
**What**: Visual list of discovered devices showing name, type, and streaming status.
**Why**: Users need to see what's available and what's playing. Clear visual feedback with icons, gradients when streaming, connection indicators.

### 7.2 Stereo "Ears" (L/R Indicators)
**What**: Colored borders on speaker cards showing channel assignment (left border = L, right = R).
**Why**: When setting up stereo, users need to see which speaker is which channel. Visual "ears" on the cards make assignment obvious at a glance.

### 7.3 Right-Aligned Header
**What**: Logo and title positioned on the right side of header.
**Why**: Distinctive design choice that sets app apart from typical left-aligned layouts. Creates visual interest and modern aesthetic.

### 7.4 Gradient Logo
**What**: "PC NEST SPEAKER" text with pink-to-cyan diagonal gradient.
**Why**: Signature branding element. Warm pink brings energy, cool cyan adds tech professionalism. Memorable visual identity.

### 7.5 Tab Navigation
**What**: Bottom tab bar with Speakers, Settings, Info sections.
**Why**: Familiar mobile-style navigation. Keeps interface clean by hiding settings until needed. Easy switching without losing context.

### 7.6 Audio Output Selector
**What**: Clickable pills showing Windows audio output devices.
**Why**: Quick way to see/change Windows audio output without opening Sound settings. Shows current selection, one-click to switch.

### 7.7 Streaming State Gradient
**What**: Active speaker cards show subtle gradient background matching logo colors.
**Why**: Clear visual differentiation between idle and streaming states. Gradient maintains brand consistency while indicating active connection.

---

## 8. SETTINGS & PREFERENCES

### 8.1 Sync Delay Slider
**What**: Manual control for PC speaker delay (0-2000ms).
**Why**: Auto-sync handles most cases, but users can fine-tune manually if needed. Full control for perfectionists or unusual setups.

### 8.2 Persistent Settings
**What**: All preferences saved to disk, restored on next launch.
**Why**: Users shouldn't reconfigure every session. Delay, last speaker, stereo mode, PC audio toggle - all remembered.

### 8.3 Stereo Mode Persistence
**What**: Remembers both speakers and their L/R assignments for stereo mode.
**Why**: Setting up stereo requires selecting two speakers and assigning channels. This is saved so users get their stereo setup instantly on next boot.

---

## 9. TECHNICAL RELIABILITY

### 9.1 Splash Screen with Video
**What**: Animated splash screen while app initializes.
**Why**: Cast discovery and daemon startup takes a few seconds. Splash with video gives professional loading experience instead of blank window.

### 9.2 Graceful Cleanup
**What**: Proper shutdown sequence: stop streams, restore audio, zero APO delay.
**Why**: Prevents orphaned processes, stuck audio settings, or speakers continuing to wait for data. Clean exit every time.

### 9.3 Error Logging
**What**: Detailed logs in Settings panel showing all operations.
**Why**: When something breaks, users and developers can see exactly what happened. Essential for debugging user-reported issues.

---

## 10. WINDOW & APP CONTROLS

### 10.1 Frameless Window
**What**: Custom window chrome with no native title bar.
**Why**: Cleaner, more modern look. Full control over appearance. Matches design aesthetic without Windows chrome interrupting the UI.

### 10.2 Hide to Tray (X Button)
**What**: Clicking X minimizes to system tray instead of quitting.
**Why**: Users want audio to keep streaming when they "close" the window. App runs in background, accessible from tray icon. Common pattern for audio apps.

### 10.3 Quit & Restore Audio (⏻ Button)
**What**: Dedicated quit button that fully exits and restores original audio device.
**Why**: When user truly wants to quit (not just hide), this ensures clean exit with audio restored to original device. No stuck VB-Cable state.

### 10.4 Refresh Button (↻)
**What**: Re-scans network for Cast devices.
**Why**: If speaker turned on after app launch, or network changed, user can manually refresh without restarting app.

### 10.5 System Tray Icon
**What**: App lives in system tray when minimized/hidden.
**Why**: Quick access to streaming status and controls without opening full window. Right-click for menu, left-click to restore.

---

## 11. STREAM MONITORING

### 11.1 Audio Visualizer
**What**: Animated bars showing audio activity while streaming.
**Why**: Visual confirmation that audio is flowing. Without it, users wonder "is it working?" Bars respond to audio levels in real-time.

### 11.2 Bitrate Display
**What**: Shows current streaming bitrate (e.g., "320 kbps").
**Why**: Technical users want to verify audio quality. Confirms Opus/AAC encoding is working at expected quality level.

### 11.3 Data Sent Counter
**What**: Shows total MB sent since stream started.
**Why**: Confirms data is actually flowing to speaker. Useful for debugging and understanding bandwidth usage over time.

### 11.4 Connection Status
**What**: Shows "Active" / "Reconnecting" / "Error" state.
**Why**: Instant awareness of connection health. If network hiccups, user sees status change before audio cuts out.

---

## 12. CALIBRATION TOOLS

### 12.1 Measure Latency Button (📡)
**What**: Pings speaker and measures network round-trip time.
**Why**: Helps user understand their network delay. Shows RTT in milliseconds so they can set appropriate sync delay. Baseline for auto-sync.

### 12.2 Test Sync Button (🔊)
**What**: Plays a test tone on both PC speakers and Nest simultaneously.
**Why**: User can hear if sync is correct without playing their own audio. Quick A/B test: if tone sounds doubled/echoed, adjust delay.

### 12.3 Visual Sync Bars
**What**: 20-bar visual display that responds to scroll wheel for delay adjustment.
**Why**: More intuitive than a slider. Scroll up/down to increase/decrease delay. Visual feedback shows current position. Feels like mixing console.

---

## 13. FIRST-RUN EXPERIENCE

### 13.1 Welcome Wizard Modal
**What**: Full-screen setup flow on first launch.
**Why**: New users need guidance. Walks through audio device detection, explains modes, offers APO installation. Professional onboarding experience.

### 13.2 Device Detection Display
**What**: Shows user's current default audio device with icon.
**Why**: Confirms app correctly identified their speakers. Builds trust that app understands their system before making changes.

### 13.3 Equalizer APO Install Prompt
**What**: One-click option to install Equalizer APO during setup.
**Why**: APO is required for Wall of Sound mode. Offering installation in wizard prevents users from discovering they need it later. Reduces friction.

### 13.4 "Nest Only" Skip Option
**What**: Button to skip APO and use app without PC speaker sync.
**Why**: Not everyone wants Wall of Sound. Users who just want to cast to Nest can skip APO install and use app immediately.

---

## 14. LICENSING SYSTEM

### 14.1 License Activation
**What**: Enter PNS-XXXX-XXXX-XXXX-XXXX format license key.
**Why**: Validates purchase, unlocks full app. Keys validated against Stripe customer metadata. One-time purchase, lifetime license.

### 14.2 License Status Display
**What**: Shows "Active ✓" with masked key (PNS-****-****-****).
**Why**: Reassures user their license is valid. Shows they're paid/legit without exposing full key on screen.

### 14.3 Trial Mode
**What**: Time-limited trial with countdown (e.g., "10h 0m remaining").
**Why**: Lets users try before buying. Countdown creates urgency without hard-blocking features. Fair evaluation period.

### 14.4 Device Deactivation
**What**: "Deactivate" button to remove license from current device.
**Why**: Users get 2 device activations. If they get a new PC, they can deactivate old one and use license on new machine.

### 14.5 Change License Key
**What**: Swap to different license key without reinstall.
**Why**: Users might buy a second key, or get a replacement. Easy swap without data loss.

### 14.6 Purchase Integration
**What**: "Buy License" button links to Stripe payment.
**Why**: Seamless purchase flow. User clicks, goes to Stripe, pays, gets key emailed, enters in app. No friction.

---

## 15. ADDITIONAL SETTINGS

### 15.1 Auto-Connect Toggle
**What**: Automatically connect to last speaker on app launch.
**Why**: "Set and forget" experience. Open app → audio starts streaming. No clicks needed for daily use.

### 15.2 Start with Windows Toggle
**What**: Launch app automatically when Windows starts.
**Why**: Users who always want Nest streaming can have it ready without manual launch. True background utility.

### 15.3 Volume Boost Toggle
**What**: Amplifies audio signal for quiet sources.
**Why**: Some apps output quiet audio. Boost increases FFmpeg gain so Nest volume isn't maxed out. Better dynamic range.

### 15.4 TV Ambient Visuals Toggle
**What**: Enable/disable ambient video backgrounds when casting to TV.
**Why**: Some users prefer black screen, others want calming visuals. Personal preference, easy toggle.

### 15.5 Debug Log Panel
**What**: Hidden log viewer showing all operations (click © to reveal).
**Why**: Power users and support can see exactly what's happening. Essential for troubleshooting without asking user to run CLI tools.

---

## 16. DEPENDENCY MANAGEMENT

### 16.1 VB-Cable Detection & Install
**What**: Checks if VB-Cable is installed, offers installation if missing.
**Why**: VB-Cable is required for audio capture. App guides user through getting it if not present. Reduces "it doesn't work" support tickets.

### 16.2 FFmpeg Bundled
**What**: FFmpeg included in app package, no separate install.
**Why**: FFmpeg is complex to install manually. Bundling it means users don't need to touch PATH or download anything. Just works.

### 16.3 Equalizer APO Status Check
**What**: Detects if APO is installed and which devices it's enabled on.
**Why**: APO must be enabled on specific device. App checks and warns if not configured correctly. Prevents silent failures.

### 16.4 APO Configurator Launcher
**What**: Button to open Equalizer APO's configurator tool.
**Why**: If user needs to change APO device selection, they can do it directly from app. No hunting through Program Files.

---

## Feature Count Summary

| Category | Features |
|----------|----------|
| Streaming | 5 |
| Wall of Sound | 5 |
| Volume Control | 3 |
| Device Management | 5 |
| Cast Experience | 4 |
| Audio Pipeline | 5 |
| User Interface | 7 |
| Settings (Basic) | 3 |
| Technical Reliability | 3 |
| Window & App Controls | 5 |
| Stream Monitoring | 4 |
| Calibration Tools | 3 |
| First-Run Experience | 4 |
| Licensing System | 6 |
| Additional Settings | 5 |
| Dependency Management | 4 |
| **TOTAL** | **71 features** |

---

*Last Updated: January 2025*
