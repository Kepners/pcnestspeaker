# PC Nest Speaker - Build & Release Guide

## Quick Build Command
```bash
npm run build
```

This creates both installer and portable in `dist/`:
- `PC Nest Speaker Setup 1.0.0.exe` - NSIS installer
- `PC Nest Speaker 1.0.0.exe` - Portable (single EXE)

---

## No CMD Windows (Already Configured)

All subprocess calls use `windowsHide: true` to prevent console windows from flashing.

**Verified locations:**
- `electron-main.js` - All spawn/exec calls
- `audio-streamer.js` - FFmpeg processes
- `chromecast.js` - Python cast-helper calls
- `daemon-manager.js` - Python daemon
- `audio-device-manager.js` - Audio control utilities

---

## Code Obfuscation Options

### Option 1: JavaScript Obfuscator (Recommended - Free)

Install:
```bash
npm install --save-dev javascript-obfuscator
```

Add to `package.json` scripts:
```json
"obfuscate": "javascript-obfuscator src/main --output src/main-obf --config obfuscator.json",
"build:protected": "npm run obfuscate && electron-builder"
```

Create `obfuscator.json`:
```json
{
  "compact": true,
  "controlFlowFlattening": true,
  "controlFlowFlatteningThreshold": 0.75,
  "deadCodeInjection": true,
  "deadCodeInjectionThreshold": 0.4,
  "debugProtection": false,
  "disableConsoleOutput": false,
  "identifierNamesGenerator": "hexadecimal",
  "log": false,
  "numbersToExpressions": true,
  "renameGlobals": false,
  "selfDefending": true,
  "simplify": true,
  "splitStrings": true,
  "splitStringsChunkLength": 10,
  "stringArray": true,
  "stringArrayCallsTransform": true,
  "stringArrayEncoding": ["base64"],
  "stringArrayIndexShift": true,
  "stringArrayRotate": true,
  "stringArrayShuffle": true,
  "stringArrayWrappersCount": 2,
  "stringArrayWrappersChainedCalls": true,
  "stringArrayWrappersParametersMaxCount": 4,
  "stringArrayWrappersType": "function",
  "stringArrayThreshold": 0.75,
  "transformObjectKeys": true,
  "unicodeEscapeSequence": false
}
```

### Option 2: Bytenode (Compile to V8 Bytecode)

This compiles JS to V8 bytecode - much harder to reverse engineer:

```bash
npm install --save-dev bytenode
```

Create `compile.js`:
```javascript
const bytenode = require('bytenode');
const fs = require('fs');
const path = require('path');

// Compile main files to .jsc bytecode
const files = [
  'src/main/electron-main.js',
  'src/main/audio-streamer.js',
  'src/main/chromecast.js'
  // Add other sensitive files
];

files.forEach(file => {
  bytenode.compileFile(file, file.replace('.js', '.jsc'));
});
```

Then update `electron-main.js` to load `.jsc` files.

### Option 3: ASAR Encryption (Basic)

Electron-builder already packs into `.asar` archive. For extra protection:

```json
// In package.json build config
"asar": true,
"asarUnpack": [
  "**/*.node",
  "**/ffmpeg/*",
  "**/mediamtx/*"
]
```

### What To Protect

**High Priority (obfuscate these):**
- `electron-main.js` - Core logic
- `audio-streamer.js` - Streaming pipeline
- `auto-sync-manager.js` - Sync algorithm
- `chromecast.js` - Cast protocol handling

**Lower Priority:**
- `renderer.js` - UI logic (less sensitive)
- `preload.js` - Just IPC bridge

---

## Performance Optimizations

### 1. Lazy Load Non-Critical Modules
```javascript
// Instead of:
const heavyModule = require('./heavy-module');

// Do:
let heavyModule;
function getHeavyModule() {
  if (!heavyModule) heavyModule = require('./heavy-module');
  return heavyModule;
}
```

### 2. Startup Optimization
The app already does these well:
- MediaMTX starts on-demand (not at launch)
- FFmpeg only starts when streaming
- Python daemon is lazy-loaded

### 3. Reduce Bundle Size
```bash
# Check what's being bundled
npx electron-builder --dir
# Look at dist/win-unpacked/resources/app.asar size
```

### 4. V8 Snapshot (Advanced)
Pre-compile frequently used code into V8 snapshot for faster startup.
Only worth it if startup time is a problem.

---

## Pre-Build Checklist

1. **Version bump** - Update `package.json` version
2. **Test in dev mode** - `npm run dev`
3. **Check all dependencies bundled**:
   - `ffmpeg/` folder exists with ffmpeg.exe
   - `mediamtx/` folder exists with mediamtx.exe
   - `audioctl/`, `svcl/`, `nircmd/` folders exist
   - `dependencies/vbcable/` folder exists
4. **Icon exists** - `assets/icon.ico`
5. **No console.log spam** - Clean up debug logs

---

## Build Commands

```bash
# Full build (installer + portable)
npm run build

# Windows only
npm run build:win

# Just create unpacked folder (faster for testing)
npx electron-builder --dir

# Build with specific config
npx electron-builder --config electron-builder.yml
```

---

## Post-Build Testing

1. **Test Installer**
   - Run `PC Nest Speaker Setup 1.0.0.exe`
   - Check Start Menu shortcut works
   - Check uninstall works

2. **Test Portable**
   - Run `PC Nest Speaker 1.0.0.exe` from any folder
   - Verify it doesn't need installation
   - Check settings persist between runs

3. **Verify No CMD Windows**
   - Start streaming
   - Watch for any console flashes
   - Check Task Manager for orphan cmd.exe

---

## Signing (Optional but Recommended)

Without code signing, Windows SmartScreen will warn users.

**Options:**
1. **Self-signed** - Still triggers warnings but less scary
2. **Comodo/Sectigo** - ~$80/year
3. **DigiCert** - ~$400/year (best reputation)

```bash
# Sign with signtool (if you have a certificate)
signtool sign /f certificate.pfx /p password /tr http://timestamp.digicert.com /td sha256 "dist/PC Nest Speaker Setup 1.0.0.exe"
```

---

*Last Updated: January 2025*
