# PC Nest Speaker

## Project Overview

**PC Nest Speaker** streams Windows system audio to Google Nest speakers over Wi-Fi. No Bluetooth required.

| Item | Value |
|------|-------|
| Type | Electron Desktop App |
| Monetization | Paid (Stripe) |
| License Format | PNS-XXXX-XXXX-XXXX-XXXX |
| Streaming | HLS primary, MP3 fallback |
| Latency | ~1.5-3 seconds |

### Key Documentation
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - System diagrams & component details
- [docs/APP_DOCUMENTATION.md](docs/APP_DOCUMENTATION.md) - Complete feature documentation
- [.claude/CLAUDE.md](.claude/CLAUDE.md) - Session memory & development notes

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
