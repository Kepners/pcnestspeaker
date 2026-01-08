# 🔴 MISTAKES LOG - PC Nest Speaker Development

**Created:** January 8, 2026
**Purpose:** Document all the back-and-forth mistakes so they don't happen again

---

## MISTAKE #1: Cloudflared Tunnel Flip-Flopping (7+ times)

| Commit | Action | Reasoning (at the time) |
|--------|--------|------------------------|
| `1b232dc` | ADD cloudflared | "Cast receiver is HTTPS, can't fetch HTTP" |
| `89c63f8` | REVERT cloudflared | "Trying without tunnel" |
| `43e977f` | ADD cloudflared fallback | "Proxy failed, need tunnel" |
| `ae2e223` | ADD cloudflared for mono | "HTTPS receiver can't fetch HTTP" |
| `bb2a122` | ADD tunnel to both paths | "Missed a code path" |
| `b532c90` | RE-ENABLE cloudflared | "HTTPS receiver needs HTTPS URLs" |
| `fe409e9` | USE LOCAL HTTP | "Simplify stereo mode" |
| `e5ad1a8` | REMOVE cloudflared | "Tunnel causing issues" |

**ROOT CAUSE:** Never actually tested whether local HTTP works. Kept assuming HTTPS→HTTP mixed content would fail, but Cast receivers CAN fetch local HTTP!

**LESSON:** Test assumptions before implementing "fixes"

---

## MISTAKE #2: TURN/STUN Server Flip-Flopping (5+ times)

| Commit | Action |
|--------|--------|
| `48271b6` | Add TURN servers for Android TV |
| `ef38442` | Simplify to STUN only |
| `2d978cc` | Add TURN servers back |
| `137bfd5` | Add TURN servers for ICE |
| Various | Keep adding/removing TURN configs |

**ROOT CAUSE:** Didn't understand the actual ICE negotiation failure. Adding/removing TURN servers was random guessing, not systematic debugging.

**LESSON:** Understand the actual problem before trying random fixes

---

## MISTAKE #3: Cast Groups Approach Changes (4+ times)

| Commit | Approach |
|--------|----------|
| `0c46290` | Cast Groups play on ALL speakers (multicast) |
| `fb8c09e` | Revert - custom namespace for groups |
| `381e903` | REVERT cast-helper entirely |
| `268b6d2` | Add multicast support |
| `9bd6d09` | 2-member groups use STEREO separation |

**ROOT CAUSE:** Tried multicast (all speakers same audio), then stereo separation (L/R split), then reverted, without committing to ONE approach and making it work.

**LESSON:** Pick ONE approach and make it work before trying alternatives

---

## MISTAKE #4: Proxy Signaling (added then removed)

| Commit | Action |
|--------|--------|
| `2530dac` | Add proxy signaling |
| `43e977f` | Add fallback when proxy fails |
| `4bb316c` | Revert receiver to pre-proxy |
| `4b7abf5` | Restore WebRTC - NO PROXY |

**ROOT CAUSE:** Over-engineered solution that wasn't needed.

**LESSON:** KISS - Keep It Simple, Stupid

---

## MISTAKE #5: receiver.html Constant Rewrites

Multiple commits touching receiver.html with different ICE configs, signaling methods, and error handling. Should have gotten ONE version working and stopped.

**LESSON:** Stop touching working code

---

## MISTAKE #6: Race Condition in Tunnel Code

| Commit | Issue |
|--------|-------|
| `abd6007` | Fix race condition in startLocalTunnel |

**ROOT CAUSE:** Added tunnel code without considering concurrent calls. Auto-connect triggered streaming before background tunnel finished, causing second cloudflared spawn, causing promise to never resolve.

**LESSON:** Consider async race conditions when writing code

---

## 📝 LESSONS LEARNED - MUST FOLLOW

1. **TEST before committing** - Actually verify the fix works before pushing
2. **ONE approach at a time** - Don't flip-flop between solutions
3. **Understand the actual problem** - Random changes != debugging
4. **Local HTTP WORKS** - Cast receivers can fetch from local network HTTP
5. **Stop over-engineering** - Proxy signaling, tunnels, etc. weren't needed
6. **Commit less frequently** - Wait until something actually works
7. **Don't assume** - Test whether HTTPS→HTTP actually fails before "fixing" it
8. **Consider race conditions** - Async code can be called concurrently

---

## CURRENT STATE (January 8, 2026)

**What should work:**
- Mono streaming: Local HTTP (`http://192.168.x.x:8889/pcaudio`)
- Stereo streaming: Local HTTP (`http://192.168.x.x:8889/left` and `/right`)
- NO cloudflared tunnel needed
- STUN + TURN servers configured in MediaMTX

**What's currently broken:**
- WebRTC ICE negotiation timing out for stereo mode
- Sessions created but "deadline exceeded while waiting connection"

**Next step:** Figure out WHY ICE negotiation fails, don't just randomly change configs

---

## GIT COMMIT HISTORY (for reference)

```
e5ad1a8 🔧 fix: Remove cloudflared from mono streaming + increase WebRTC timeouts
abd6007 🔧 fix: Race condition in startLocalTunnel causing app to hang
6431196 🔧 fix: Support all private IP ranges (10.x, 172.16-31.x, 192.168.x)
1468124 🔧 fix: Auto-detect local IP in MediaMTX config
fe409e9 🔧 fix: Simplify stereo mode - use LOCAL HTTP instead of cloudflared
fe6fc47 🔧 fix: Improve stereo WebRTC connection reliability
68a5375 🔍 debug: Add logging to trace stereo mode activation
b532c90 🔧 fix: Re-enable cloudflared tunnel - HTTPS receiver needs HTTPS URLs
9bd6d09 🔥 feat: 2-member Cast Groups now use STEREO separation automatically
a10d945 🔥 feat: Integrate multicast for Cast Groups into Electron app
268b6d2 🔥 feat: Add multicast support for Cast Groups
bb2a122 🔧 fix: Add tunnel to BOTH code paths (pre-started and fresh start)
ae2e223 🔧 fix: Use cloudflared tunnel for mono streaming (HTTPS receiver can't fetch HTTP)
381e903 🔥 REVERT: Back to working cast-helper.py from 137bfd5
fb8c09e 🔧 fix: Revert to custom namespace for groups (play_media approach broken)
0c46290 🔧 fix: Cast Groups now play audio on ALL speakers
137bfd5 🔧 fix: Add TURN servers to receiver for ICE connectivity
4b7abf5 🔥 fix: Restore working WebRTC streaming - NO PROXY
```

---

*This document exists to prevent repeating these mistakes. READ IT before making changes.*
