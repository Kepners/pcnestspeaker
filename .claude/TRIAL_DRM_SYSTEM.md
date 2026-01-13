# PC Nest Speaker - Trial DRM System

## Overview

PC Nest Speaker uses a **tamper-resistant trial system** that tracks streaming usage time to enforce a 10-hour trial limit. The system uses encrypted storage with HMAC signatures to prevent tampering.

**Key Principle:** If tampering is detected, the trial auto-expires immediately as punishment.

---

## Architecture

### Storage Location
```
%APPDATA%/PC Nest Speaker/.usage
```
- Single encrypted binary file
- Shared between installer AND portable versions (same %APPDATA% path)
- No database, no cloud - 100% local

### Data Structure
```javascript
{
  usageSeconds: number,      // Total streaming time in seconds
  firstUsedAt: timestamp,    // When trial started
  lastUsedAt: timestamp,     // Last usage (for clock manipulation detection)
  tampered: boolean,         // If tampering detected
  version: 2                 // Schema version
}
```

---

## Encryption Stack

### Algorithm
- **Encryption:** AES-128-CBC
- **Key Derivation:** scrypt (machine-specific)
- **Integrity:** HMAC-SHA256 (separate key)

### Key Derivation

**Encryption Key:**
```javascript
function deriveKey() {
  const machineId = getMachineId();  // Hardware fingerprint
  const salt = 'PCNestSpeaker2025';
  return crypto.scryptSync(machineId, salt, 16);  // 16 bytes for AES-128
}
```

**HMAC Key (different from encryption key):**
```javascript
function deriveHmacKey() {
  const machineId = getMachineId();
  const salt = 'PNS-HMAC-2025';
  return crypto.scryptSync(machineId, salt, 32);  // 32 bytes for HMAC
}
```

### Machine ID Generation
```javascript
function getMachineId() {
  const os = require('os');
  const raw = `${os.hostname()}-${os.userInfo().username}-${os.cpus()[0]?.model || 'cpu'}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
```

**Why this matters:**
- Keys are derived from machine hardware
- Copying `.usage` file to another machine = decryption fails = tamper detected
- No hardcoded keys in source code

---

## Storage Format

The `.usage` file contains JSON with this structure:
```javascript
{
  encrypted: {
    iv: "hex-encoded-iv",        // Random 16 bytes per save
    data: "hex-encoded-ciphertext"
  },
  signature: "hex-encoded-hmac",  // HMAC of decrypted data
  v: 2                            // Format version
}
```

### Encryption Process
```javascript
function encrypt(data) {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);  // Fresh IV every save
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { iv: iv.toString('hex'), data: encrypted };
}
```

### Decryption Process
```javascript
function decrypt(encryptedObj) {
  const key = deriveKey();
  const iv = Buffer.from(encryptedObj.iv, 'hex');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let decrypted = decipher.update(encryptedObj.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}
```

---

## Integrity Verification

### HMAC Signing
```javascript
function sign(data) {
  const hmacKey = deriveHmacKey();
  const hmac = crypto.createHmac('sha256', hmacKey);
  hmac.update(JSON.stringify(data));
  return hmac.digest('hex');
}
```

### HMAC Verification (timing-safe)
```javascript
function verify(data, signature) {
  try {
    const expectedSig = sign(data);
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch {
    return false;
  }
}
```

**Why timing-safe:** Prevents timing attacks that could reveal valid signatures.

---

## Tamper Detection

### Detection Triggers

1. **File missing/corrupted** - Can't parse JSON
2. **Decryption fails** - Wrong machine or corrupted data
3. **HMAC mismatch** - Data modified after encryption
4. **Invalid format** - Missing `signature` or `encrypted` fields
5. **Clock manipulation** - `lastUsedAt` is in the future (>60s buffer)

### Clock Manipulation Check
```javascript
if (decrypted.lastUsedAt && decrypted.lastUsedAt > Date.now() + 60000) {
  console.log('[UsageTracker] Clock manipulation detected - TAMPERED');
  return markTampered();
}
```

**Attack prevented:** User sets clock forward, uses app, sets clock back to "reset" trial.

### Tamper Response
```javascript
function markTampered() {
  const data = {
    usageSeconds: TRIAL_SECONDS + 1,  // Over 10-hour limit
    firstUsedAt: 0,
    lastUsedAt: Date.now(),
    tampered: true,
    version: 2
  };
  cachedData = data;
  saveSecureData(data);
  console.log('[UsageTracker] TAMPERING DETECTED - Trial expired');
  return data;
}
```

**Result:** Trial expires immediately. No recovery without dev key.

---

## Usage Tracking

### Start Tracking (when streaming begins)
```javascript
function startTracking() {
  if (streamStartTime) return;  // Already tracking

  const data = loadSecureData();
  if (data.tampered || data.usageSeconds >= TRIAL_SECONDS) return;

  streamStartTime = Date.now();

  // Update every 10 seconds while streaming
  trackingInterval = setInterval(() => {
    updateUsage();
  }, 10000);
}
```

### Stop Tracking (when streaming stops)
```javascript
function stopTracking() {
  if (!streamStartTime) return;

  updateUsage();  // Final update
  clearInterval(trackingInterval);
  trackingInterval = null;
  streamStartTime = null;
}
```

### Update Usage
```javascript
function updateUsage() {
  if (!streamStartTime) return;

  const now = Date.now();
  const sessionSeconds = Math.floor((now - streamStartTime) / 1000);

  const data = loadSecureData();
  if (data.tampered) return;

  data.usageSeconds += sessionSeconds;
  streamStartTime = now;  // Reset for next interval

  saveSecureData(data);
}
```

---

## License Bypass

When a valid license is activated, trial limits are bypassed:

```javascript
function getUsage() {
  const data = loadSecureData();
  const licenseKey = settingsManager.getSetting('licenseKey') || null;

  return {
    // ... other fields
    trialExpired: licenseKey ? false : (data.tampered || data.usageSeconds >= TRIAL_SECONDS),
    hasLicense: !!licenseKey,
  };
}
```

**License storage:** `settings.json` (not encrypted, validated against Stripe API)

---

## Dev Reset (Testing Only)

For development/testing, a machine-specific reset key is available:

```javascript
function getDevKey() {
  if (app.isPackaged) return null;  // Hidden in production
  return crypto.createHash('sha256')
    .update('PNS-DEV-RESET-' + getMachineId())
    .digest('hex')
    .slice(0, 16);
}

function resetUsage(devKey) {
  const expectedKey = crypto.createHash('sha256')
    .update('PNS-DEV-RESET-' + getMachineId())
    .digest('hex')
    .slice(0, 16);

  if (devKey !== expectedKey) return false;

  cachedData = null;
  const data = getDefaultData();
  saveSecureData(data);
  return true;
}
```

**Security:** Dev key only works on same machine, hidden in production builds.

---

## Security Considerations

### What This Protects Against
- **File copying** - Machine-specific keys = file useless on other machines
- **Manual editing** - HMAC verification catches modifications
- **Clock manipulation** - Timestamp checks detect forward/back tricks
- **Memory inspection** - Keys derived at runtime, not stored

### What This Does NOT Protect Against
- **Skilled reverse engineering** - Obfuscation helps but isn't bulletproof
- **Kernel-level debugging** - Can intercept crypto calls
- **Binary patching** - Can remove trial checks entirely

### Philosophy
This is **"honest user" DRM** - it prevents casual tampering but won't stop determined crackers. The goal is to make buying easier than cracking, not to create unbreakable protection.

---

## File Reference

**Main implementation:** `src/main/usage-tracker.js`

### Exported Functions
```javascript
module.exports = {
  startTracking,      // Call when streaming starts
  stopTracking,       // Call when streaming stops
  getUsage,           // Get current trial status
  isTrialExpired,     // Boolean check
  resetUsage,         // Dev only
  activateLicense,    // Store license key
  deactivateLicense,  // Remove license key
  formatTime,         // "2h 30m" formatting
  getDevKey,          // Dev only
  clearCache          // Force reload from disk
};
```

---

## Constants

```javascript
const TRIAL_HOURS = 10;
const TRIAL_SECONDS = 36000;  // 10 * 60 * 60
const ALGORITHM = 'aes-128-cbc';
const HMAC_ALGORITHM = 'sha256';
```

---

*Last Updated: January 2026*
