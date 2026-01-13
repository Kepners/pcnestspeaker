/**
 * System Tray Manager
 *
 * Manages system tray icon with different states:
 * - Idle: Default icon (gray)
 * - Streaming: Active icon (colored)
 *
 * Context menu actions:
 * - Show/Hide window
 * - Stop streaming (when active)
 * - Exit application
 */

const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

// Get assets path (different in dev vs production)
function getAssetsPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');
}

let tray = null;
let mainWindow = null;
let isStreaming = false;

/**
 * Create a simple colored square icon as fallback
 */
function createFallbackIcon(color) {
  // Create a 16x16 colored square
  const canvas = {
    width: 16,
    height: 16
  };

  // Create a simple bitmap (gray for idle, green for streaming)
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);

  // Fill with color
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  for (let i = 0; i < size * size; i++) {
    const offset = i * 4;
    buffer[offset] = r;     // R
    buffer[offset + 1] = g; // G
    buffer[offset + 2] = b; // B
    buffer[offset + 3] = 255; // A (opaque)
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

/**
 * Load icon from file or create fallback
 */
function loadIcon(filename, fallbackColor) {
  const fs = require('fs');
  const assetsPath = getAssetsPath();

  // Try ICO first (preferred on Windows), then PNG
  const baseName = filename.replace(/\.(png|ico)$/, '');
  const icoPath = path.join(assetsPath, `${baseName}.ico`);
  const pngPath = path.join(assetsPath, `${baseName}.png`);

  if (fs.existsSync(icoPath)) {
    console.log(`[Tray] Loading icon: ${baseName}.ico`);
    return nativeImage.createFromPath(icoPath);
  }

  if (fs.existsSync(pngPath)) {
    console.log(`[Tray] Loading icon: ${baseName}.png`);
    return nativeImage.createFromPath(pngPath);
  }

  // Create fallback icon
  console.log(`[Tray] Icon not found: ${filename}, using fallback`);
  return createFallbackIcon(fallbackColor);
}

/**
 * Create system tray icon
 */
function createTray(window) {
  mainWindow = window;

  // Load tray icon (or use fallback)
  const icon = loadIcon('tray-icon.png', '#808080'); // Gray fallback

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('PC Nest Speaker');

  // Create context menu
  updateContextMenu();

  // Double-click to show/hide window
  tray.on('double-click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  console.log('[Tray] System tray created');
}

/**
 * Update context menu based on streaming state
 */
function updateContextMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: mainWindow && mainWindow.isVisible() ? 'Hide Window' : 'Show Window',
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Stop Streaming',
      enabled: isStreaming,
      click: () => {
        // Send stop streaming event to renderer
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('tray-stop-streaming');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        app.quit();
      }
    }
  ]);

  if (tray) {
    tray.setContextMenu(contextMenu);
  }
}

/**
 * Update tray icon state (idle vs streaming)
 */
function updateTrayState(streaming) {
  isStreaming = streaming;

  if (!tray) return;

  // Use same logo icon for both states
  const icon = loadIcon('tray-icon.png', '#808080');

  tray.setImage(icon.resize({ width: 16, height: 16 }));

  // Update tooltip
  const tooltip = streaming ? 'PC Nest Speaker - Streaming' : 'PC Nest Speaker';
  tray.setToolTip(tooltip);

  // Update context menu (enable/disable Stop Streaming)
  updateContextMenu();

  console.log(`[Tray] State updated: ${streaming ? 'streaming' : 'idle'}`);
}

/**
 * Destroy tray icon
 */
function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
    console.log('[Tray] System tray destroyed');
  }
}

/**
 * Handle window visibility changes (update Show/Hide label)
 */
function onWindowVisibilityChange() {
  updateContextMenu();
}

module.exports = {
  createTray,
  updateTrayState,
  destroyTray,
  onWindowVisibilityChange
};
