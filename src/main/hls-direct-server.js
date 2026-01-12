/**
 * Direct HLS Server for TV Streaming
 *
 * Bypasses MediaMTX's Low-Latency HLS (which requires 7 segments)
 * FFmpeg outputs HLS directly to temp folder, this server serves it.
 *
 * Used ONLY for TV/Chromecast streaming - speakers use WebRTC through MediaMTX.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// HLS output directory
const HLS_DIR = path.join(os.tmpdir(), 'pcnestspeaker-hls');
const DEFAULT_PORT = 8890;

let server = null;
let currentPort = DEFAULT_PORT;

/**
 * Initialize the HLS output directory
 */
function initHlsDir() {
  if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
  }
  // Clean any old files
  try {
    const files = fs.readdirSync(HLS_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(HLS_DIR, file));
    }
  } catch (e) {
    // Ignore cleanup errors
  }
  return HLS_DIR;
}

/**
 * Start the HLS HTTP server
 */
function start(port = DEFAULT_PORT) {
  if (server) {
    console.log('[HLS-Direct] Server already running');
    return { success: true, port: currentPort, dir: HLS_DIR };
  }

  initHlsDir();
  currentPort = port;

  server = http.createServer((req, res) => {
    // CORS headers for Cast receiver
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Parse requested file
    let filePath = req.url.replace(/^\//, '').split('?')[0];
    if (!filePath || filePath === '') filePath = 'stream.m3u8';

    const fullPath = path.join(HLS_DIR, filePath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(HLS_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Determine content type
    let contentType = 'application/octet-stream';
    if (filePath.endsWith('.m3u8')) {
      contentType = 'application/vnd.apple.mpegurl';
    } else if (filePath.endsWith('.ts')) {
      contentType = 'video/mp2t';
    } else if (filePath.endsWith('.m4s') || filePath.endsWith('.mp4')) {
      contentType = 'video/mp4';
    }

    // Serve file
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(500);
          res.end('Server error');
        }
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store',
      });
      res.end(data);
    });
  });

  server.on('error', (err) => {
    console.error('[HLS-Direct] Server error:', err.message);
    if (err.code === 'EADDRINUSE') {
      // Port in use, try next port
      currentPort++;
      server = null;
      start(currentPort);
    }
  });

  server.listen(currentPort, '0.0.0.0', () => {
    console.log(`[HLS-Direct] Server started on port ${currentPort}, serving from ${HLS_DIR}`);
  });

  return { success: true, port: currentPort, dir: HLS_DIR };
}

/**
 * Stop the HLS server and clean up
 */
function stop() {
  if (server) {
    server.close();
    server = null;
    console.log('[HLS-Direct] Server stopped');
  }

  // Clean up HLS files
  try {
    if (fs.existsSync(HLS_DIR)) {
      const files = fs.readdirSync(HLS_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(HLS_DIR, file));
      }
    }
  } catch (e) {
    // Ignore cleanup errors
  }
}

/**
 * Get the HLS URL for streaming
 */
function getHlsUrl(localIp) {
  return `http://${localIp}:${currentPort}/stream.m3u8`;
}

/**
 * Get the output directory for FFmpeg
 */
function getOutputDir() {
  return HLS_DIR;
}

/**
 * Get current server status
 */
function isRunning() {
  return server !== null;
}

module.exports = {
  start,
  stop,
  getHlsUrl,
  getOutputDir,
  isRunning,
  initHlsDir,
  DEFAULT_PORT
};
