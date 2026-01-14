# Complete License System Guide for Indie Apps

*Last Updated: January 2026*

This guide documents the complete license key system used in PC Nest Speaker and Delete My Tweets. It covers the full flow, code implementation, configuration, and all known pitfalls.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [License Key Format](#license-key-format)
3. [Purchase Flow](#purchase-flow)
4. [Verification Flow](#verification-flow)
5. [Validation Flow](#validation-flow)
6. [Code Implementation](#code-implementation)
7. [Environment Variables](#environment-variables)
8. [Domain Configuration](#domain-configuration)
9. [Email Setup (Resend)](#email-setup-resend)
10. [Electron App Integration](#electron-app-integration)
11. [Common Pitfalls & Solutions](#common-pitfalls--solutions)
12. [Testing Checklist](#testing-checklist)
13. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         LICENSE SYSTEM ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PURCHASE FLOW:                                                             │
│  ──────────────                                                             │
│  User clicks "Buy" → Stripe Payment Link → Stripe Checkout                  │
│       ↓                                                                     │
│  Payment successful                                                         │
│       ↓                                                                     │
│  Stripe redirects to: https://www.yoursite.com/download?session_id={ID}    │
│       ↓                                                                     │
│  /api/verify-session endpoint:                                              │
│       1. Retrieves session from Stripe                                      │
│       2. Checks payment_status === 'paid'                                   │
│       3. Gets or CREATES customer (Apple Pay fix!)                          │
│       4. Generates license key (HMAC-SHA256)                                │
│       5. Stores license in customer metadata                                │
│       6. Sends email via Resend                                             │
│       7. Returns license to frontend                                        │
│       ↓                                                                     │
│  User sees license key + download links                                     │
│                                                                             │
│  VALIDATION FLOW (App startup):                                             │
│  ──────────────────────────────                                             │
│  Electron App → /api/validate-license (POST)                                │
│       ↓                                                                     │
│  API searches Stripe customers by metadata['license_key']                   │
│       ↓                                                                     │
│  Returns { valid: true/false }                                              │
│       ↓                                                                     │
│  App enables/disables features based on result                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

| Decision | Reason |
|----------|--------|
| Stripe Payment Links | No backend checkout code, always PCI compliant |
| License in Stripe metadata | No database needed, survives redeploys |
| HMAC license generation | Deterministic - same session = same key |
| Resend for email | Simple API, generous free tier (100/day) |
| POST for validation | More secure than GET with key in URL |

---

## License Key Format

### PC Nest Speaker
```
Format: XXXX-XXXX-XXXX-XXXX
Example: 91C1-CD8C-4FCC-97BD
Length: 19 characters (16 hex + 3 dashes)
Regex: /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
```

### Delete My Tweets
```
Format: DMT-XXXX-XXXX-XXXX-XXXX
Example: DMT-A1B2-C3D4-E5F6-7890
Length: 23 characters (prefix + 16 hex + 4 dashes)
Regex: /^DMT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
```

### Generation Algorithm (HMAC-SHA256)

```typescript
import crypto from 'crypto'

function generateLicenseKey(sessionId: string, prefix?: string): string {
  const secret = process.env.LICENSE_KEY_SECRET!
  const hash = crypto.createHmac('sha256', secret)
    .update(sessionId)
    .digest('hex')

  // Take first 16 chars and format
  const key = hash.substring(0, 16).toUpperCase()
  const formatted = `${key.slice(0,4)}-${key.slice(4,8)}-${key.slice(8,12)}-${key.slice(12,16)}`

  return prefix ? `${prefix}-${formatted}` : formatted
}

// PC Nest Speaker: generateLicenseKey(sessionId)
// Delete My Tweets: generateLicenseKey(sessionId, 'DMT') - but uses different format
```

**Why HMAC?**
- **Deterministic**: Same session ID always generates same key
- **Secure**: Can't reverse-engineer without secret
- **Idempotent**: Multiple verification requests return same key

---

## Purchase Flow

### Step 1: Payment Link Setup (Stripe Dashboard)

1. **Products** → Create product with name, description, image
2. **Payment Links** → Create link for product
3. **After payment** settings:
   ```
   ✅ Don't show confirmation page
   ✅ Redirect to your website
   URL: https://www.yoursite.com/download?session_id={CHECKOUT_SESSION_ID}
   ```

⚠️ **CRITICAL: Use `www.` if your site redirects to www!**

### Step 2: Download Page (Frontend)

```typescript
// download/page.tsx
'use client'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'

export default function DownloadPage() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('session_id')
  const [license, setLicense] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (sessionId) {
      fetch(`/api/verify-session?session_id=${sessionId}`)
        .then(res => res.json())
        .then(data => {
          if (data.success && data.licenseKey) {
            setLicense(data.licenseKey)
          } else {
            setError(data.error || 'Verification failed')
          }
        })
        .catch(() => setError('Network error'))
    }
  }, [sessionId])

  // Render license key and download links...
}
```

### Step 3: Verify Session API

See [Code Implementation](#code-implementation) for full code.

---

## Verification Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    /api/verify-session                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Input: session_id (from URL query param)                        │
│                                                                  │
│  1. Retrieve session from Stripe                                 │
│     └─ stripe.checkout.sessions.retrieve(sessionId)              │
│                                                                  │
│  2. Check payment status                                         │
│     └─ if (session.payment_status !== 'paid') → error            │
│                                                                  │
│  3. Get customer ID (HANDLE ALL CASES!)                          │
│     ├─ String ID: session.customer (most common)                 │
│     ├─ Expanded object: session.customer.id                      │
│     └─ NULL: Apple Pay/Google Pay/Link! → CREATE CUSTOMER        │
│                                                                  │
│  4. Generate license key                                         │
│     └─ HMAC-SHA256(sessionId, LICENSE_KEY_SECRET)                │
│                                                                  │
│  5. Store in customer metadata (if not exists)                   │
│     └─ stripe.customers.update(customerId, { metadata: {...} })  │
│                                                                  │
│  6. Send email via Resend (background, don't block)              │
│     └─ sendLicenseEmail({ to, licenseKey, customerName })        │
│                                                                  │
│  7. Return response                                              │
│     └─ { success: true, licenseKey, email, customerName }        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Validation Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                   /api/validate-license                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Input: License key (POST body or GET query param)               │
│                                                                  │
│  POST body formats accepted:                                     │
│  ├─ { key: "XXXX-..." }                                          │
│  ├─ { license_key: "XXXX-..." }                                  │
│  └─ { licenseKey: "XXXX-..." }    ← Electron apps use this!      │
│                                                                  │
│  1. Normalize key (uppercase, trim)                              │
│                                                                  │
│  2. Validate format (regex check)                                │
│     └─ Quick rejection of invalid formats                        │
│                                                                  │
│  3. Search Stripe customers by metadata                          │
│     └─ stripe.customers.search({                                 │
│          query: `metadata['license_key']:'${key}'`               │
│        })                                                        │
│                                                                  │
│  4. Return result                                                │
│     ├─ Found: { valid: true, email: customer.email }             │
│     └─ Not found: { valid: false }                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Code Implementation

### verify-session/route.ts (Complete)

```typescript
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

// Lazy initialization to avoid build-time errors
let stripeInstance: Stripe | null = null

function getStripe(): Stripe {
  if (!stripeInstance) {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-02-24.acacia',  // Use latest stable
    })
  }
  return stripeInstance
}

// Generate deterministic license key from session ID
function generateLicenseKey(sessionId: string): string {
  const crypto = require('crypto')
  const secret = process.env.LICENSE_KEY_SECRET!
  const hash = crypto.createHmac('sha256', secret)
    .update(sessionId)
    .digest('hex')

  const key = hash.substring(0, 16).toUpperCase()
  return `${key.slice(0,4)}-${key.slice(4,8)}-${key.slice(8,12)}-${key.slice(12,16)}`
  // For prefixed keys: return `DMT-${key.slice(0,4)}-...`
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session_id')

  if (!sessionId) {
    return NextResponse.json(
      { success: false, error: 'Session ID required' },
      { status: 400 }
    )
  }

  try {
    const stripe = getStripe()
    const session = await stripe.checkout.sessions.retrieve(sessionId)

    // Check payment status
    if (session.payment_status !== 'paid') {
      return NextResponse.json(
        { success: false, error: 'Payment not completed' },
        { status: 400 }
      )
    }

    const licenseKey = generateLicenseKey(sessionId)
    const customerEmail = session.customer_details?.email || null
    const customerName = session.customer_details?.name || null

    // ═══════════════════════════════════════════════════════════════
    // CRITICAL: Handle all customer ID cases!
    // ═══════════════════════════════════════════════════════════════

    // Case 1: String ID (most common)
    // Case 2: Expanded customer object
    let customerId = typeof session.customer === 'string'
      ? session.customer
      : (session.customer as Stripe.Customer)?.id

    // Case 3: NULL - Apple Pay/Google Pay/Link don't create customers!
    if (!customerId && customerEmail) {
      console.log('No customer ID - creating customer from session details')
      try {
        const newCustomer = await stripe.customers.create({
          email: customerEmail,
          name: customerName || undefined,
          metadata: {
            created_from: 'payment_link_verification',
            original_session_id: sessionId,
          },
        })
        customerId = newCustomer.id
        console.log(`Created customer: ${customerId}`)
      } catch (err) {
        console.error('Failed to create customer:', err)
      }
    }

    // Store license in customer metadata
    if (customerId) {
      try {
        const customer = await stripe.customers.retrieve(customerId)
        if (customer && !customer.deleted && !customer.metadata?.license_key) {
          await stripe.customers.update(customerId, {
            metadata: {
              license_key: licenseKey,
              purchase_date: new Date().toISOString(),
              session_id: sessionId,
            },
          })
          console.log(`Stored license ${licenseKey} for customer ${customerId}`)
        }
      } catch (err) {
        console.error('Failed to store license:', err)
      }
    } else {
      console.error('WARNING: No customer ID - license not stored!')
    }

    // Send email (don't await - background)
    if (customerEmail) {
      sendLicenseEmail({
        to: customerEmail,
        customerName,
        licenseKey,
      }).catch(err => console.error('Email send failed:', err))
    }

    return NextResponse.json({
      success: true,
      email: customerEmail,
      customerName,
      licenseKey,
    })

  } catch (error) {
    console.error('verify-session error:', error)
    return NextResponse.json(
      { success: false, error: 'Verification failed' },
      { status: 500 }
    )
  }
}
```

### validate-license/route.ts (Complete)

```typescript
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

function getStripe(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-02-24.acacia',
  })
}

// GET: /api/validate-license?key=XXXX-XXXX-XXXX-XXXX
export async function GET(request: NextRequest) {
  const licenseKey = request.nextUrl.searchParams.get('key')

  if (!licenseKey) {
    return NextResponse.json(
      { valid: false, error: 'License key required' },
      { status: 400 }
    )
  }

  return validateAndRespond(licenseKey)
}

// POST: { key: "...", license_key: "...", or licenseKey: "..." }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // ═══════════════════════════════════════════════════════════════
    // CRITICAL: Accept ALL common key formats!
    // Electron apps often send "licenseKey" (camelCase)
    // ═══════════════════════════════════════════════════════════════
    const licenseKey = body.key || body.license_key || body.licenseKey

    if (!licenseKey) {
      return NextResponse.json(
        { valid: false, error: 'License key required' },
        { status: 400 }
      )
    }

    return validateAndRespond(licenseKey)

  } catch {
    return NextResponse.json(
      { valid: false, error: 'Invalid request' },
      { status: 400 }
    )
  }
}

async function validateAndRespond(licenseKey: string) {
  const stripe = getStripe()

  // Normalize: uppercase, trim, format if needed
  const normalizedKey = licenseKey.trim().toUpperCase()

  // Quick format validation (adjust regex for your format)
  // PC Nest Speaker: /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
  // Delete My Tweets: /^DMT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/

  try {
    // Search Stripe customers by metadata
    const customers = await stripe.customers.search({
      query: `metadata['license_key']:'${normalizedKey}'`,
      limit: 1,
    })

    if (customers.data.length > 0) {
      return NextResponse.json({
        valid: true,
        email: customers.data[0].email || undefined,
        purchase_date: customers.data[0].metadata?.purchase_date,
      })
    }

    return NextResponse.json({ valid: false })

  } catch (err) {
    console.error('License validation error:', err)
    return NextResponse.json(
      { valid: false, error: 'Validation failed' },
      { status: 500 }
    )
  }
}
```

### lib/stripe.ts (Shared Functions)

```typescript
import Stripe from 'stripe'
import crypto from 'crypto'

let stripeInstance: Stripe | null = null

export function getStripe(): Stripe {
  if (!stripeInstance) {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-02-24.acacia',
    })
  }
  return stripeInstance
}

export function generateLicenseKey(sessionId: string, prefix?: string): string {
  const secret = process.env.LICENSE_KEY_SECRET || 'fallback-secret-change-me'
  const hash = crypto.createHmac('sha256', secret)
    .update(sessionId)
    .digest('hex')

  const key = hash.substring(0, 16).toUpperCase()
  const formatted = `${key.slice(0,4)}-${key.slice(4,8)}-${key.slice(8,12)}-${key.slice(12,16)}`

  return prefix ? `${prefix}-${formatted}` : formatted
}

export async function validateLicenseKey(
  licenseKey: string
): Promise<{ valid: boolean; email?: string }> {
  const stripe = getStripe()
  const normalizedKey = licenseKey.trim().toUpperCase()

  try {
    const customers = await stripe.customers.search({
      query: `metadata['license_key']:'${normalizedKey}'`,
      limit: 1,
    })

    if (customers.data.length > 0) {
      return {
        valid: true,
        email: customers.data[0].email || undefined,
      }
    }

    return { valid: false }
  } catch (err) {
    console.error('License validation error:', err)
    return { valid: false }
  }
}
```

---

## Environment Variables

### Required Variables (Vercel)

```env
# Stripe API Key (secret, starts with sk_live_ or sk_test_)
# Get from: https://dashboard.stripe.com/apikeys
STRIPE_SECRET_KEY=sk_live_...

# License Key Secret (for HMAC generation)
# Generate: openssl rand -hex 16
# CRITICAL: Keep this secret! Anyone with it can generate valid keys.
LICENSE_KEY_SECRET=your_32_char_random_secret

# Resend API Key (for sending license emails)
# Get from: https://resend.com/api-keys
RESEND_API_KEY=re_...

# Optional: Notification email for sales alerts
NOTIFICATION_EMAIL=your@email.com
```

### Generating LICENSE_KEY_SECRET

```bash
# Mac/Linux:
openssl rand -hex 16

# Windows PowerShell:
-join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })

# Or just make up 32 random hex characters
```

⚠️ **CRITICAL**: Once set, NEVER change LICENSE_KEY_SECRET!
Changing it invalidates ALL existing license keys.

---

## Domain Configuration

### The www Problem

If your site redirects `yoursite.com` → `www.yoursite.com`:

| Configuration | URL to Use |
|---------------|------------|
| Payment Link redirect | `https://www.yoursite.com/download?session_id={CHECKOUT_SESSION_ID}` |
| Webhook endpoint | `https://www.yoursite.com/api/webhook` |
| Electron app API URL | `https://www.yoursite.com/api/validate-license` |

⚠️ **Using the wrong one causes:**
- 308 redirects that strip query parameters
- Webhook delivery failures
- API validation failures

### How to Check Your Redirect

```bash
curl -I https://yoursite.com
# Look for: location: https://www.yoursite.com/
```

### Vercel Domain Setup

1. **Settings** → **Domains**
2. Add both `yoursite.com` and `www.yoursite.com`
3. Set primary domain (the one without redirect)
4. Use primary domain in ALL Stripe configurations

---

## Email Setup (Resend)

### Step 1: Create Resend Account

1. Sign up at https://resend.com
2. Create API key
3. Add to Vercel as `RESEND_API_KEY`

### Step 2: Verify Domain

1. **Domains** → **Add Domain**
2. Add your domain (e.g., `yoursite.com`)
3. Add DNS records to your registrar:

```
Type  Name                      Value
TXT   resend._domainkey         p=MIGfMA0GCSq... (from Resend)
TXT   @                         v=spf1 include:resend.com ~all
```

4. Wait for verification (usually < 5 minutes)

### Step 3: Email Sending Code

```typescript
// lib/email.ts
interface LicenseEmailParams {
  to: string
  customerName: string | null
  licenseKey: string
}

export async function sendLicenseEmail({
  to,
  customerName,
  licenseKey,
}: LicenseEmailParams) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Your App <noreply@yoursite.com>',  // Must use verified domain!
      to: [to],
      subject: 'Your License Key - Your App',
      html: `
        <h1>Thank you for your purchase!</h1>
        <p>Hi ${customerName || 'there'},</p>
        <p>Your license key:</p>
        <div style="background: #f5f5f5; padding: 20px; font-family: monospace; font-size: 24px;">
          ${licenseKey}
        </div>
        <p>Keep this email safe - you'll need this key to activate the app.</p>
      `,
      text: `Your license key: ${licenseKey}`,  // Always include plain text!
    }),
  })

  if (!response.ok) {
    throw new Error(`Resend error: ${response.status}`)
  }

  return response.json()
}
```

### Email Troubleshooting

| Symptom | Cause | Solution |
|---------|-------|----------|
| 403 error | Domain not verified | Check DNS records in Resend |
| 403 error | Wrong "from" domain | Use verified domain in "from" |
| Email not received | Check spam folder | Add plain text version |
| Delayed delivery | Resend queue | Check Resend dashboard |

---

## Electron App Integration

### Required Dependency

```bash
# MUST use v2 for CommonJS compatibility
npm install node-fetch@2 --save
```

### License Validation Code

```javascript
// electron-main.js

const LICENSE_API_URL = 'https://www.yoursite.com/api/validate-license'

// Validate license key format
function validateLicenseFormat(key) {
  if (!key) return false
  // Adjust regex for your format
  const pattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
  return pattern.test(key.toUpperCase())
}

// Activate license (called from renderer)
ipcMain.on('activate-license', async (event, licenseKey) => {
  if (!licenseKey) {
    event.reply('license-result', { success: false, error: 'Please enter a license key' })
    return
  }

  const cleanKey = licenseKey.toUpperCase().trim()

  // Quick format check
  if (!validateLicenseFormat(cleanKey)) {
    event.reply('license-result', {
      success: false,
      error: 'Invalid license key format'
    })
    return
  }

  // Validate against server
  try {
    const fetch = require('node-fetch')
    const response = await fetch(LICENSE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: cleanKey })  // API accepts this format
    })

    const result = await response.json()

    if (result.valid) {
      // Save locally
      saveLicenseData(cleanKey)
      event.reply('license-result', { success: true })
    } else {
      event.reply('license-result', {
        success: false,
        error: result.error || 'Invalid license key'
      })
    }
  } catch (err) {
    console.error('License validation error:', err)
    event.reply('license-result', {
      success: false,
      error: 'Unable to verify license. Check your internet connection.'
    })
  }
})
```

### Local License Storage

```javascript
const fs = require('fs')
const path = require('path')

const licensePath = path.join(app.getPath('userData'), 'license.json')

function saveLicenseData(licenseKey) {
  const data = {
    licenseKey: licenseKey.toUpperCase(),
    activatedAt: new Date().toISOString()
  }
  fs.writeFileSync(licensePath, JSON.stringify(data, null, 2))
  return data
}

function getLicenseData() {
  try {
    if (fs.existsSync(licensePath)) {
      return JSON.parse(fs.readFileSync(licensePath, 'utf8'))
    }
  } catch (err) {
    console.error('Error loading license:', err)
  }
  return null
}

function deleteLicenseData() {
  try {
    if (fs.existsSync(licensePath)) {
      fs.unlinkSync(licensePath)
      return true
    }
  } catch (err) {
    console.error('Error deleting license:', err)
  }
  return false
}
```

---

## Common Pitfalls & Solutions

### 1. Apple Pay/Google Pay/Link Create NO Customer!

**Symptom**: `verify-session` returns "Missing customer information"

**Cause**: When users pay with Apple Pay, Google Pay, or Stripe Link, Stripe often does NOT create a customer object. `session.customer` is `null`!

**Solution**: Always check and create customer if missing:

```typescript
let customerId = typeof session.customer === 'string'
  ? session.customer
  : (session.customer as Stripe.Customer)?.id

// CRITICAL: Create customer if missing!
if (!customerId && customerEmail) {
  const newCustomer = await stripe.customers.create({
    email: customerEmail,
    name: customerName || undefined,
    metadata: { created_from: 'payment_link_verification' },
  })
  customerId = newCustomer.id
}
```

### 2. Expanded Customer Object

**Symptom**: `customerId` is `[object Object]` in logs

**Cause**: Stripe sometimes returns expanded customer object instead of string ID

**Solution**: Handle both cases:

```typescript
let customerId = typeof session.customer === 'string'
  ? session.customer
  : (session.customer as Stripe.Customer)?.id
```

### 3. Electron App Sends Wrong Key Format

**Symptom**: API returns "Missing license key" but app sent one

**Cause**: Electron sends `{ licenseKey: "..." }` but API only accepts `{ key: "..." }`

**Solution**: Accept ALL formats:

```typescript
const licenseKey = body.key || body.license_key || body.licenseKey
```

### 4. node-fetch Not Installed

**Symptom**: "Unable to verify license. Check your internet connection."

**Cause**: Electron app tries to `require('node-fetch')` but it's not installed

**Solution**:
```bash
npm install node-fetch@2 --save  # v2 for CommonJS!
```

### 5. 308 Redirect Strips session_id

**Symptom**: User lands on download page but `session_id` is empty

**Cause**: Redirect from non-www to www (or vice versa) strips query params

**Solution**: Use exact domain in Payment Link redirect URL

### 6. Webhook Returns 308

**Symptom**: Webhook deliveries fail with 308 status

**Cause**: Webhook URL doesn't match primary domain

**Solution**: Update webhook URL to exact primary domain

### 7. Email Not Sending (403)

**Symptom**: Resend API returns 403

**Causes**:
- Domain not verified
- "From" email doesn't match verified domain
- API key incorrect

**Solution**: Verify domain in Resend, use matching "from" address

### 8. License Key Not in Stripe

**Symptom**: User has key but validation fails

**Cause**: Customer metadata wasn't saved (check logs for errors)

**Solution**:
1. Check Stripe Dashboard → Customer → Metadata
2. If missing, manually add `license_key` to metadata
3. Fix code to ensure metadata is always saved

---

## Testing Checklist

### Before Launch

- [ ] Create test product in Stripe
- [ ] Create Payment Link with correct redirect URL (with www if needed)
- [ ] Set all environment variables in Vercel
- [ ] Redeploy after adding env vars
- [ ] Verify Resend domain is verified
- [ ] Test full purchase with real card
- [ ] Verify license appears in customer metadata
- [ ] Verify email received
- [ ] Test license validation API with curl
- [ ] Test Electron app activation
- [ ] Refund test purchase

### API Testing Commands

```bash
# Test validate-license GET
curl "https://www.yoursite.com/api/validate-license?key=XXXX-XXXX-XXXX-XXXX"

# Test validate-license POST
curl -X POST "https://www.yoursite.com/api/validate-license" \
  -H "Content-Type: application/json" \
  -d '{"licenseKey": "XXXX-XXXX-XXXX-XXXX"}'

# Test with different key formats
curl -X POST "https://www.yoursite.com/api/validate-license" \
  -H "Content-Type: application/json" \
  -d '{"key": "XXXX-XXXX-XXXX-XXXX"}'
```

---

## Troubleshooting

### Debug Flow

1. **Check Vercel Function Logs**
   - Vercel Dashboard → Your project → Logs
   - Filter by function name

2. **Check Stripe Dashboard**
   - Payments → Find the payment
   - Customer → Check metadata
   - Developers → Logs for API errors

3. **Check Resend Dashboard**
   - Emails → Check delivery status
   - Domains → Verify DNS records

### Manual License Fix

If a customer's license wasn't saved to Stripe:

1. **Find the session ID** (from success URL or Stripe payment)
2. **Generate the key locally**:
   ```javascript
   const crypto = require('crypto')
   const sessionId = 'cs_live_...'
   const secret = 'your-license-key-secret'
   const hash = crypto.createHmac('sha256', secret).update(sessionId).digest('hex')
   const key = hash.substring(0, 16).toUpperCase()
   console.log(`${key.slice(0,4)}-${key.slice(4,8)}-${key.slice(8,12)}-${key.slice(12,16)}`)
   ```
3. **Add to Stripe**:
   - Customers → Find customer
   - Metadata → Add `license_key`, `purchase_date`, `session_id`

---

## Quick Reference

### URLs Pattern
```
Payment Link: https://buy.stripe.com/xxx
Success URL:  https://www.yoursite.com/download?session_id={CHECKOUT_SESSION_ID}
Webhook:      https://www.yoursite.com/api/webhook
Validate API: https://www.yoursite.com/api/validate-license
```

### Stripe Customer Metadata
```json
{
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "purchase_date": "2026-01-14T12:00:00.000Z",
  "session_id": "cs_live_..."
}
```

### Electron License Storage
```
Windows: %APPDATA%/Your App/license.json
Mac: ~/Library/Application Support/Your App/license.json
```

---

*This guide is maintained at: `~/.claude/docs/LICENSE_SYSTEM_GUIDE.md`*

*Related: `~/.claude/docs/STRIPE_COMPLETE_GUIDE.md`*

*Last Updated: January 2026*
