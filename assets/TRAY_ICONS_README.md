# System Tray Icons

The app uses two system tray icons to indicate streaming status:

## Required Icons

1. **tray-icon.png** - Idle state (gray)
   - Size: 16x16 pixels (for 1x display) + 32x32 pixels (for 2x display)
   - Color: Gray (#6B6D76 - Dim Grey)
   - Style: Simple speaker or audio wave icon
   - Purpose: Shows when app is idle (not streaming)

2. **tray-icon-active.png** - Streaming state (colored)
   - Size: 16x16 pixels (for 1x display) + 32x32 pixels (for 2x display)
   - Color: Powder Blush (#FCBFB7) or Khaki Beige (#A69888)
   - Style: Same speaker/audio icon but colored
   - Purpose: Shows when actively streaming audio

## Icon Guidelines

- **Format**: PNG with transparency
- **Resolution**: Provide both 16x16 and 32x32 for retina displays
- **Naming**: Use @2x suffix for high-DPI versions (e.g., tray-icon@2x.png)
- **Style**: Keep it simple - Windows tray icons are small and should be clear
- **Colors**: Use the Warm Neutral color palette from the app

## Fallback Behavior

If icons are missing, the app will create simple colored squares:
- Gray (#808080) for idle state
- Green (#00FF00) for streaming state

## Creating Icons

You can create simple tray icons using:
1. **Online tools**: favicon.io, favicon-generator.org
2. **Design software**: Figma, Photoshop, GIMP
3. **Icon fonts**: Font Awesome speaker icons

Example SVG for simple speaker icon:
```svg
<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path d="M3 6v4h3l4 3V3L6 6H3z" fill="#6B6D76"/>
  <path d="M12 8c0-1-0.5-1.8-1.2-2.4v4.8C11.5 9.8 12 9 12 8z" fill="#6B6D76"/>
</svg>
```

---

*Part of PC Nest Speaker - System Tray Integration*
