# PC Nest Speaker

## Project Overview

**PC Nest Speaker** streams Windows system audio to Google Nest speakers over Wi-Fi. No Bluetooth required.

| Item | Value |
|------|-------|
| Type | Electron Desktop App |
| Monetization | Paid (Stripe) |
| License Format | XXXX-XXXX-XXXX-XXXX (16 hex chars from HMAC) |
| Streaming | HLS primary, MP3 fallback |
| Latency | ~1.5-3 seconds |

### Key Documentation
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - System diagrams & component details
- [docs/APP_DOCUMENTATION.md](docs/APP_DOCUMENTATION.md) - Complete feature documentation
- [.claude/CLAUDE.md](.claude/CLAUDE.md) - Session memory & development notes
- [.claude/TRIAL_DRM_SYSTEM.md](.claude/TRIAL_DRM_SYSTEM.md) - Trial encryption & DRM system

## Available Skills

- `/cs:linkedin` - Post to LinkedIn
- `/cs:substack` - Create Substack drafts
- `/cs:x` - Post tweets/threads to X
- `/sc:*` - SuperClaude commands (pm, implement, analyze, etc.)

## MCP Servers Available

- GitHub - Repository management
- Supabase - Database operations
- Vercel - Deployment
- Stripe - Payments
- Playwright - Browser automation

## Design System: Warm Neutral

### Colors

| Name | Hex | Usage |
|------|-----|-------|
| Dim Grey | `#6B6D76` | Secondary text, borders, muted elements |
| Khaki Beige | `#A69888` | Backgrounds, cards, neutral surfaces |
| Powder Blush | `#FCBFB7` | Primary accent, CTAs, highlights |
| Charcoal Blue | `#334E58` | Headers, primary text, dark backgrounds |
| Dark Coffee | `#33261D` | Deep backgrounds, footer, dark accents |

### CSS Variables

```css
:root {
  --color-grey: #6B6D76;
  --color-beige: #A69888;
  --color-blush: #FCBFB7;
  --color-blue: #334E58;
  --color-coffee: #33261D;
}
```

### Tailwind Config

```js
colors: {
  grey: '#6B6D76',
  beige: '#A69888',
  blush: '#FCBFB7',
  blue: '#334E58',
  coffee: '#33261D',
}
```

### Usage Guidelines

- **Primary Background**: Charcoal Blue (`#334E58`) or Dark Coffee (`#33261D`)
- **Cards/Surfaces**: Khaki Beige (`#A69888`) with transparency
- **Accent/CTAs**: Powder Blush (`#FCBFB7`)
- **Text on Dark**: Powder Blush or white
- **Text on Light**: Charcoal Blue or Dark Coffee
- **Borders/Dividers**: Dim Grey (`#6B6D76`)

---

## Development Standards

- Use consistent code formatting
- Run tests before committing when applicable
- Follow existing project conventions
- Write clear commit messages

---

## Trial & DRM System

**Full documentation:** [.claude/TRIAL_DRM_SYSTEM.md](.claude/TRIAL_DRM_SYSTEM.md)

### Quick Reference

| Component | Value |
|-----------|-------|
| Trial Duration | 10 hours of streaming |
| Storage | `%APPDATA%/PC Nest Speaker/.usage` |
| Encryption | AES-128-CBC |
| Integrity | HMAC-SHA256 |
| Key Derivation | scrypt (machine-specific) |

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    Trial Data Flow                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  App Start                                                  │
│     │                                                       │
│     ▼                                                       │
│  Load .usage ──► Decrypt ──► Verify HMAC ──► Check Time    │
│     │              │             │              │           │
│     │         [FAIL]        [FAIL]         [EXPIRED]        │
│     │              │             │              │           │
│     │              └─────────────┴──────────────┘           │
│     │                            │                          │
│     │                            ▼                          │
│     │                    TAMPER DETECTED                    │
│     │                    Trial Expires!                     │
│     │                                                       │
│     ▼                                                       │
│  Streaming ──► Update every 10s ──► Encrypt ──► Save       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Tamper Detection Triggers

1. **File corrupted/missing** - Can't parse
2. **Decryption fails** - Wrong machine
3. **HMAC mismatch** - Data modified
4. **Clock manipulation** - Future timestamp detected

### Key Files

| File | Purpose |
|------|---------|
| `src/main/usage-tracker.js` | Trial tracking & encryption |
| `src/main/settings-manager.js` | License key storage |
| `.usage` | Encrypted trial data |

### Machine-Specific Keys

Keys are derived from hardware fingerprint:
```javascript
const raw = `${hostname}-${username}-${cpu_model}`;
const machineId = sha256(raw).slice(0, 32);
const encryptionKey = scrypt(machineId, 'PCNestSpeaker2025', 16);
const hmacKey = scrypt(machineId, 'PNS-HMAC-2025', 32);
```

**Why:** Copying `.usage` to another machine = decryption fails = tampered.

### Dev Reset (Testing Only)

In dev mode only, reset trial with machine-specific key:
```javascript
const devKey = usageTracker.getDevKey();  // Returns null in production
usageTracker.resetUsage(devKey);
```

---

## Project-Specific Notes

### Audio Pipeline
```
Windows Audio -> VB-CABLE -> FFmpeg -> HTTP Server -> Nest Speaker
```

### Requirements
- **User installs:** VB-CABLE or Voicemeeter (virtual audio device)
- **App bundles:** FFmpeg (or requires PATH install)
- **Network:** PC and Nest on same Wi-Fi subnet

### Reference Code
Original Python implementations in `reference/python/`:
- `cast_system_audio_to_nest_v2.py` - HLS + MP3 fallback logic
- `cast_system_audio_to_nest_improved_FIXED.py` - Optimized HLS
- `cast_system_audio_to_nest_mp3_FIXED.py` - Stable MP3 streaming

### Key Fixes from Original
1. Create HLS output directory before starting HTTP server
2. Use 8192 byte chunks (not 4096) to prevent buffer underruns
3. Keep only 3 HLS segments for lower latency
4. Add 100ms audio buffer for stability

---

*Last Updated: January 2026*
