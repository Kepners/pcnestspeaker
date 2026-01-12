# PC Nest Speaker - Complete Design System

## Overview

**Design Philosophy**: Clean, modern light-mode desktop app with gradient accents. The aesthetic is inspired by professional utility apps with a warm, approachable feel.

**Theme**: Light mode with white background, dark text, and colorful gradient accents.

---

## Color Palette

### Primary Colors

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Background White** | `#FFFFFF` | rgb(255, 255, 255) | Main app background |
| **Text Black** | `#1A1A1A` | rgb(26, 26, 26) | Primary text, headings |
| **Pink (Primary Accent)** | `#EF476F` | rgb(239, 71, 111) | CTAs, buttons, gradient start |
| **Cyan (Secondary Accent)** | `#55828B` | rgb(85, 130, 139) | Gradient end, toggle ON state |
| **Green (Success)** | `#29BF12` | rgb(41, 191, 18) | Active indicators, streaming state |

### Neutral Colors (Warm Palette)

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Dim Grey** | `#6B6D76` | rgb(107, 109, 118) | Muted text, borders, disabled |
| **Khaki Beige** | `#A69888` | rgb(166, 152, 136) | Subtle borders, "ear" indicators |
| **Powder Blush** | `#FCBFB7` | rgb(252, 191, 183) | Soft highlights |
| **Charcoal Blue** | `#334E58` | rgb(51, 78, 88) | Dark accents |
| **Dark Coffee** | `#33261D` | rgb(51, 38, 29) | Deep shadows |

### UI State Colors

| State | Color | Usage |
|-------|-------|-------|
| Active/Streaming | `#29BF12` (Green) | Streaming indicator dot |
| Toggle ON | `#55828B` (Cyan) | Active toggle background |
| Toggle OFF | `#CCCCCC` (Light Grey) | Inactive toggle background |
| Error/Alert | `#EF476F` (Pink) | Error messages |
| Disabled | `#999999` | Disabled buttons/text |

---

## Typography

### Font Stack

```css
/* Display/Headings */
font-family: 'Bebas Neue', Impact, sans-serif;

/* Body/UI */
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

### Font Loading

```html
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### Typography Hierarchy

| Element | Font | Size | Weight | Letter-Spacing | Line-Height |
|---------|------|------|--------|----------------|-------------|
| **Logo "PC NEST SPEAKER"** | Bebas Neue | 4rem (64px) | 700 | -1px | 0.9 |
| **Section Labels** | Bebas Neue | 0.95rem (15.2px) | 400 | 2px | normal |
| **Header Label** | Inter | 0.65rem (10.4px) | 600 | 3px | normal |
| **Tagline** | Inter | 0.85rem (13.6px) | 400 | 0.5px | normal |
| **Body Text** | Inter | 14px | 400 | normal | 1.5 |
| **Small/Hint Text** | Inter | 11px-12px | 400 | normal | 1.4 |
| **Button Text** | Inter | 13px | 500 | 0.5px | normal |

---

## The Logo Gradient (CRITICAL)

This is the signature visual element. The "PC NEST SPEAKER" text uses a diagonal gradient from pink to cyan.

### CSS Implementation

```css
.logo {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 4rem;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 0.9;

  /* THE GRADIENT - This is the key part */
  background: linear-gradient(135deg, #EF476F, #55828B);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

### Gradient Details

| Property | Value | Explanation |
|----------|-------|-------------|
| **Angle** | `135deg` | Diagonal from top-left to bottom-right |
| **Start Color** | `#EF476F` (Pink) | Top-left corner |
| **End Color** | `#55828B` (Cyan/Teal) | Bottom-right corner |
| **Transition** | Linear | Smooth blend, no color stops |

### Visual Result
```
P ← Pink (#EF476F)
C   ↘
     N
 N    E
  E    S ← Gradient midpoint (blend)
   S    T
    T
         S
          P
           E
            A
             K
              E
               R ← Cyan (#55828B)
```

### Logo Text Layout

The logo is split across TWO LINES:
```
PC NEST
SPEAKER
```

HTML:
```html
<h1 class="logo">PC NEST<br>SPEAKER</h1>
```

---

## Layout Structure

### Header (RIGHT-ALIGNED)

The header is **right-aligned**, not centered or left-aligned. This is a distinctive design choice.

```
┌─────────────────────────────────────────────────────────┐
│                          AUDIO STREAMING TOOL           │ ← Small label
│                                           PC NEST       │ ← Logo line 1
│                                           SPEAKER       │ ← Logo line 2
│               Stream system audio to your Nest          │ ← Tagline
└─────────────────────────────────────────────────────────┘
```

### CSS for Header

```css
.header {
  text-align: right;
  padding: 16px 24px 28px 0;
}

.header-label {
  display: block;
  font-family: 'Inter', sans-serif;
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 3px;
  color: #999999;
  margin-bottom: 4px;
  text-transform: uppercase;
}

.tagline {
  font-family: 'Inter', sans-serif;
  font-size: 0.85rem;
  color: #666666;
  margin-top: 4px;
  letter-spacing: 0.5px;
}

/* "Nest" is highlighted in cyan */
.tagline .highlight {
  color: #55828B;
  font-weight: 600;
}
```

### Main Content Area

```
┌─────────────────────────────────────────────────────────┐
│ [Header - right aligned]                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  CAST TO                          ← Section label       │
│  ┌─────────────────────────────┐                       │
│  │ 🔊 Speaker Name          ⓘ │  ← Speaker cards      │
│  └─────────────────────────────┘                       │
│  ┌─────────────────────────────┐                       │
│  │ 🔊 Another Speaker       ⓘ │                       │
│  └─────────────────────────────┘                       │
│                                                         │
│  WALL OF SOUND                    ← Section label       │
│  ┌─────────────────────────────┐                       │
│  │ Add PC speaker    [toggle] Ⓦ│                       │
│  └─────────────────────────────┘                       │
│                                                         │
├─────────────────────────────────────────────────────────┤
│            [Speakers] [Settings] [Info]                 │ ← Tab bar
└─────────────────────────────────────────────────────────┘
```

---

## Component Styling

### Speaker Cards

```css
.speaker-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  background: white;
  border: 1px solid #E5E5E5;
  border-radius: 12px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.speaker-item:hover {
  background: #F8F8F8;
  border-color: #DDDDDD;
}

.speaker-item.streaming {
  background: linear-gradient(135deg,
    rgba(239, 71, 111, 0.08),   /* Pink tint */
    rgba(85, 130, 139, 0.08)    /* Cyan tint */
  );
  border-color: #55828B;
}
```

### "Ears" (Stereo Channel Indicators)

When speakers are assigned to left/right channels, they show colored border "ears":

```css
.speaker-item.speaker-left {
  border-left: 4px solid #A69888;  /* Beige - Left channel */
}

.speaker-item.speaker-right {
  border-right: 4px solid #A69888; /* Beige - Right channel */
}

/* Stereo devices (TVs, Groups) show both ears */
.speaker-item.speaker-left.speaker-right {
  border-left: 4px solid #A69888;
  border-right: 4px solid #A69888;
}
```

### Toggle Switches (iOS-style)

```css
.toggle-switch {
  width: 44px;
  height: 24px;
  background: #CCCCCC;           /* OFF state */
  border-radius: 12px;           /* Pill shape */
  position: relative;
  cursor: pointer;
  transition: background 0.3s ease;
}

.toggle-switch.active {
  background: #55828B;           /* ON state - Cyan */
}

.toggle-switch::after {
  content: '';
  position: absolute;
  width: 20px;
  height: 20px;
  background: white;
  border-radius: 50%;            /* Circle knob */
  top: 2px;
  left: 2px;
  transition: transform 0.3s ease;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

.toggle-switch.active::after {
  transform: translateX(20px);   /* Slide right when ON */
}
```

### Primary Button (Gradient)

```css
.btn-primary {
  background: linear-gradient(135deg, #EF476F, #55828B);
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 8px;
  font-family: 'Inter', sans-serif;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.2s;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}
```

### Secondary Button (Outline)

```css
.btn-secondary {
  background: transparent;
  color: #55828B;
  border: 1.5px solid #55828B;
  padding: 10px 20px;
  border-radius: 8px;
  font-family: 'Inter', sans-serif;
  font-size: 13px;
  font-weight: 500;
}

.btn-secondary:hover {
  background: rgba(85, 130, 139, 0.1);
}
```

### Tab Bar (Bottom Navigation)

```css
.tab-bar {
  display: flex;
  justify-content: center;
  padding: 12px 16px;
  background: #F5F5F5;
  border-top: 1px solid #E5E5E5;
}

.tab-bar-inner {
  display: flex;
  gap: 4px;
  background: #EEEEEE;
  padding: 4px;
  border-radius: 10px;           /* Pill container */
}

.tab-btn {
  padding: 8px 20px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-family: 'Inter', sans-serif;
  font-size: 13px;
  font-weight: 500;
  color: #666666;
  cursor: pointer;
  transition: all 0.2s ease;
}

.tab-btn.active {
  background: white;
  color: #1A1A1A;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
```

### Section Labels

```css
.section-label {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 0.95rem;
  letter-spacing: 2px;
  color: #999999;
  margin-bottom: 12px;
  margin-top: 20px;
  text-transform: uppercase;
}
```

### Slider (Volume/Sync)

```css
.slider {
  -webkit-appearance: none;
  width: 100%;
  height: 6px;
  background: #E5E5E5;
  border-radius: 3px;
  outline: none;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  background: linear-gradient(135deg, #EF476F, #55828B);
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0,0,0,0.2);
}
```

---

## Spacing System

| Name | Value | Usage |
|------|-------|-------|
| **xs** | 4px | Tight spacing, inline elements |
| **sm** | 8px | Between related items |
| **md** | 12px | Standard component padding |
| **lg** | 16px | Section padding |
| **xl** | 24px | Major section gaps |
| **2xl** | 32px | Page margins |

---

## Border Radius

| Element | Radius |
|---------|--------|
| Cards/Containers | 12px |
| Buttons | 8px |
| Toggle switches | 12px (pill) |
| Input fields | 8px |
| Tab bar container | 10px |
| Circular elements | 50% |

---

## Shadows

```css
/* Card shadow */
box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);

/* Elevated card (hover) */
box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);

/* Button shadow */
box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);

/* Toggle knob */
box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
```

---

## Transitions

Standard transition for all interactive elements:

```css
transition: all 0.2s ease;
```

Specific transitions:
- Toggles: `0.3s ease` (slower for smoother slide)
- Hover effects: `0.2s ease`
- Tab changes: `0.2s ease`

---

## Design Principles

### 1. Light & Airy
- White background creates spacious feel
- Subtle borders (not harsh lines)
- Plenty of whitespace between elements

### 2. Warm Accents on Cool Base
- Pink (#EF476F) brings energy
- Cyan (#55828B) adds calm professionalism
- The gradient blends warmth with tech-forward feel

### 3. Right-Aligned Header
- Distinctive choice that sets app apart
- Logo stacks vertically for impact
- Creates visual interest in header space

### 4. Consistent Gradient Usage
- Logo uses pink→cyan gradient
- Primary buttons use same gradient
- Slider thumbs use same gradient
- Streaming state backgrounds use subtle gradient tint

### 5. iOS-Inspired Controls
- Pill-shaped toggles
- Smooth animations
- Familiar interaction patterns

### 6. Clear Visual Hierarchy
- Bebas Neue for display/labels (attention-grabbing)
- Inter for body/UI (readable, professional)
- Size + weight + color work together

---

## Full CSS Variables Block

```css
:root {
  /* Core Colors */
  --background: #FFFFFF;
  --text-primary: #1A1A1A;
  --text-secondary: #666666;
  --text-muted: #999999;

  /* Accent Colors */
  --pink: #EF476F;
  --cyan: #55828B;
  --green: #29BF12;

  /* Neutral Palette */
  --color-grey: #6B6D76;
  --color-beige: #A69888;
  --color-blush: #FCBFB7;
  --color-blue: #334E58;
  --color-coffee: #33261D;

  /* UI Colors */
  --border: #E5E5E5;
  --border-hover: #DDDDDD;
  --surface: #F8F8F8;
  --surface-alt: #F5F5F5;
  --toggle-off: #CCCCCC;
  --disabled: #999999;

  /* Gradient */
  --gradient-primary: linear-gradient(135deg, var(--pink), var(--cyan));

  /* Typography */
  --font-display: 'Bebas Neue', Impact, sans-serif;
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --space-2xl: 32px;

  /* Border Radius */
  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-full: 9999px;
}
```

---

*Last Updated: January 2025*
