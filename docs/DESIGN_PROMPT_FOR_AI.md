# AI Prompt: PC Nest Speaker Website Design System

Copy everything below this line and paste it to the AI building your website:

---

## DESIGN SYSTEM INSTRUCTIONS

You are building a website for PC Nest Speaker, a Windows desktop app that streams system audio to Google Nest speakers. Follow this design system EXACTLY.

---

## COLOR PALETTE

Use these EXACT hex colors:

### Primary Colors
- **Background**: `#FFFFFF` (pure white)
- **Text**: `#1A1A1A` (near black)
- **Pink Accent**: `#EF476F` (vibrant coral-pink)
- **Cyan Accent**: `#55828B` (muted teal-cyan)
- **Green Success**: `#29BF12` (bright green)

### Neutral Colors
- **Grey (muted text)**: `#6B6D76`
- **Beige (borders)**: `#A69888`
- **Blush (soft accent)**: `#FCBFB7`
- **Charcoal Blue**: `#334E58`
- **Dark Coffee**: `#33261D`

### UI Colors
- **Borders**: `#E5E5E5`
- **Surface/Cards**: `#F8F8F8`
- **Disabled**: `#999999`
- **Secondary text**: `#666666`

---

## THE LOGO GRADIENT (CRITICAL - READ CAREFULLY)

The "PC NEST SPEAKER" logo text uses a **diagonal gradient from PINK to CYAN**.

### EXACT CSS:
```css
.logo {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 4rem;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 0.9;
  background: linear-gradient(135deg, #EF476F, #55828B);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

### Key Details:
- **Angle**: `135deg` (diagonal top-left → bottom-right)
- **Start**: `#EF476F` (Pink) at top-left
- **End**: `#55828B` (Cyan) at bottom-right
- **Text fill**: Transparent (so gradient shows through)
- **Line break**: Logo is on TWO lines: "PC NEST" then "SPEAKER"

### HTML:
```html
<h1 class="logo">PC NEST<br>SPEAKER</h1>
```

---

## TYPOGRAPHY

### Fonts to Load
```html
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### Font Usage
| Element | Font | Size | Weight | Notes |
|---------|------|------|--------|-------|
| Logo | Bebas Neue | 4rem (64px) | 700 | Gradient text, line-height: 0.9 |
| Section headers | Bebas Neue | 0.95rem | 400 | letter-spacing: 2px, uppercase |
| Small labels | Inter | 0.65rem | 600 | letter-spacing: 3px, uppercase |
| Body text | Inter | 14-16px | 400 | Standard paragraphs |
| Buttons | Inter | 13px | 500 | letter-spacing: 0.5px |

---

## LAYOUT: RIGHT-ALIGNED HEADER

The header is **RIGHT-ALIGNED**. This is intentional and distinctive.

```
                              AUDIO STREAMING TOOL  ← small grey label
                                          PC NEST  ← logo line 1 (gradient)
                                          SPEAKER  ← logo line 2 (gradient)
              Stream system audio to your Nest     ← tagline
```

### CSS:
```css
.header {
  text-align: right;
  padding: 16px 24px 28px 0;
}
```

---

## PRIMARY BUTTON (GRADIENT)

Primary buttons use the SAME gradient as the logo:

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
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}
```

---

## SECONDARY BUTTON (OUTLINE)

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

---

## CARD STYLING

```css
.card {
  background: white;
  border: 1px solid #E5E5E5;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.card:hover {
  border-color: #DDDDDD;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
```

---

## TOGGLE SWITCHES (iOS-STYLE)

Pill-shaped toggles with sliding circle:

```css
.toggle {
  width: 44px;
  height: 24px;
  background: #CCCCCC;  /* OFF */
  border-radius: 12px;
  position: relative;
}

.toggle.active {
  background: #55828B;  /* ON - Cyan */
}

.toggle::after {
  content: '';
  width: 20px;
  height: 20px;
  background: white;
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
  transition: transform 0.3s ease;
}

.toggle.active::after {
  transform: translateX(20px);
}
```

---

## TAGLINE WITH HIGHLIGHT

In the tagline "Stream system audio to your Nest", the word "Nest" is highlighted in cyan:

```html
<p class="tagline">Stream system audio to your <span class="highlight">Nest</span></p>
```

```css
.tagline {
  font-family: 'Inter', sans-serif;
  font-size: 0.85rem;
  color: #666666;
  letter-spacing: 0.5px;
}

.tagline .highlight {
  color: #55828B;
  font-weight: 600;
}
```

---

## SECTION LABELS

```css
.section-label {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 0.95rem;
  letter-spacing: 2px;
  color: #999999;
  text-transform: uppercase;
  margin-bottom: 12px;
}
```

---

## DESIGN PRINCIPLES TO FOLLOW

1. **Light & Airy**: White background, subtle borders, lots of whitespace
2. **Gradient Consistency**: Logo, primary buttons, and slider thumbs all use the same pink→cyan gradient
3. **Right-Aligned Header**: Logo and header text align to the right
4. **Warm + Tech**: Pink brings warmth, cyan adds professionalism
5. **iOS-Style Controls**: Rounded toggles, smooth transitions
6. **Two Font Families Only**: Bebas Neue for display, Inter for everything else

---

## CSS VARIABLES (USE THESE)

```css
:root {
  --pink: #EF476F;
  --cyan: #55828B;
  --green: #29BF12;
  --background: #FFFFFF;
  --text: #1A1A1A;
  --text-secondary: #666666;
  --text-muted: #999999;
  --border: #E5E5E5;
  --surface: #F8F8F8;

  --gradient: linear-gradient(135deg, var(--pink), var(--cyan));

  --font-display: 'Bebas Neue', sans-serif;
  --font-body: 'Inter', sans-serif;

  --radius: 12px;
  --radius-sm: 8px;
}
```

---

## QUICK REFERENCE CHECKLIST

When building, verify:
- [ ] Logo uses gradient text (pink→cyan at 135deg)
- [ ] Logo is on TWO lines: "PC NEST" / "SPEAKER"
- [ ] Header is RIGHT-ALIGNED
- [ ] Primary buttons use same gradient as logo
- [ ] Font: Bebas Neue for logo/headers, Inter for body
- [ ] Background is pure white (#FFFFFF)
- [ ] Border radius is 12px for cards, 8px for buttons
- [ ] "Nest" in tagline is highlighted cyan (#55828B)
- [ ] Toggles are pill-shaped with cyan (#55828B) when ON

---

## EXAMPLE COMPLETE HEADER HTML

```html
<header class="header">
  <span class="header-label">AUDIO STREAMING TOOL</span>
  <h1 class="logo">PC NEST<br>SPEAKER</h1>
  <p class="tagline">Stream system audio to your <span class="highlight">Nest</span></p>
</header>
```

With CSS:

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
  text-transform: uppercase;
  margin-bottom: 4px;
}

.logo {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 4rem;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 0.9;
  margin: 0;
  background: linear-gradient(135deg, #EF476F, #55828B);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.tagline {
  font-family: 'Inter', sans-serif;
  font-size: 0.85rem;
  color: #666666;
  margin-top: 4px;
  letter-spacing: 0.5px;
}

.tagline .highlight {
  color: #55828B;
  font-weight: 600;
}
```

---

END OF DESIGN SYSTEM. Follow these specifications exactly.
