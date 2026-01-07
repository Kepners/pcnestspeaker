/**
 * Audio Streamer - Handles FFmpeg audio capture and HTTP streaming
 *
 * Supports two modes:
 * 1. HLS (default) - Lower latency with Cast devices, uses 0.5s segments
 * 2. MP3 - Fallback progressive streaming
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const net = require('net');

// Ensure Windows Firewall allows our HTTP server
function ensureFirewallRule(port) {
  if (process.platform !== 'win32') return Promise.resolve();

  return new Promise((resolve) => {
    // Check if rule exists
    exec(`netsh advfirewall firewall show rule name="PC Nest Speaker HTTP" >nul 2>&1`, { windowsHide: true }, (err) => {
      if (!err) {
        console.log('Firewall rule already exists');
        resolve();
        return;
      }

      // Create rule (will prompt for admin if needed)
      console.log('Creating firewall rule for port', port);
      exec(`netsh advfirewall firewall add rule name="PC Nest Speaker HTTP" dir=in action=allow protocol=TCP localport=${port}`, { windowsHide: true }, (err2) => {
        if (err2) {
          console.log('Could not create firewall rule (may need admin rights):', err2.message);
        } else {
          console.log('Firewall rule created successfully');
        }
        resolve(); // Continue even if rule creation fails
      });
    });
  });
}

// Configuration
const CONFIG = {
  port: 8000,
  sampleRate: 48000,
  channels: 2,
  bitrate: '320k',  // Higher bitrate = faster buffer fill = lower latency
  hlsSegmentTime: 0.5,  // 0.5 second segments for low latency
  hlsListSize: 3,       // Keep only 3 segments in playlist
};

// Audio devices to try in priority order
const AUDIO_DEVICES = [
  'Stereo Mix',
  'What U Hear',
  'Wave Out Mix',
  'virtual-audio-capturer',
  'CABLE Output',
];

class AudioStreamer {
  constructor() {
    this.ffmpegProcess = null;
    this.httpServer = null;
    this.isStreaming = false;
    this.localIp = this.getLocalIp();
    this.clients = new Set();
    this.streamUrl = null;
    this.hlsDir = null;
    this.mode = 'hls';  // 'hls' or 'mp3'
  }

  getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  getFFmpegPath() {
    if (process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
      if (fs.existsSync(bundled)) {
        return bundled;
      }
    }
    const devPath = path.join(__dirname, '../../ffmpeg/ffmpeg.exe');
    if (fs.existsSync(devPath)) {
      return devPath;
    }
    return 'ffmpeg';
  }

  async getAudioDevices(forceRefresh = false) {
    // Cache audio devices for 30 seconds to avoid repeated FFmpeg spawns
    const CACHE_TTL = 30000;
    const now = Date.now();

    if (!forceRefresh && this._audioDevicesCache &&
        (now - this._audioDevicesCacheTime) < CACHE_TTL) {
      return this._audioDevicesCache;
    }

    return new Promise((resolve, reject) => {
      const ffmpeg = this.getFFmpegPath();
      const proc = spawn(ffmpeg, [
        '-list_devices', 'true',
        '-f', 'dshow',
        '-i', 'dummy'
      ], { windowsHide: true });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', () => {
        const lines = stderr.split('\n');
        const audioDevices = [];

        for (const line of lines) {
          if (line.includes('(audio)')) {
            const match = line.match(/"([^"]+)"/);
            if (match) {
              audioDevices.push(match[1]);
            }
          }
        }

        // Cache the result
        this._audioDevicesCache = audioDevices;
        this._audioDevicesCacheTime = now;

        console.log('Available audio devices:', audioDevices);
        resolve(audioDevices);
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to list audio devices: ${err.message}`));
      });
    });
  }

  async findAudioDevice() {
    const audioDevices = await this.getAudioDevices();

    for (const pref of AUDIO_DEVICES) {
      const found = audioDevices.find(d =>
        d.toLowerCase().includes(pref.toLowerCase())
      );
      if (found) {
        return found;
      }
    }

    if (audioDevices.length > 0) {
      return audioDevices[0];
    }

    throw new Error('No audio capture device found. Enable "Stereo Mix" in Windows Sound settings, or install VB-CABLE.');
  }

  async findAvailablePort(startPort = CONFIG.port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(startPort, () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', () => {
        resolve(this.findAvailablePort(startPort + 1));
      });
    });
  }

  /**
   * Create temp directory for HLS segments
   */
  createHlsDir() {
    this.hlsDir = path.join(os.tmpdir(), `pcnestspeaker-hls-${Date.now()}`);
    fs.mkdirSync(this.hlsDir, { recursive: true });
    console.log('HLS directory:', this.hlsDir);
    return this.hlsDir;
  }

  /**
   * Start HTTP server for HLS segments
   */
  startHlsServer(port) {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store');

        let filePath;
        let contentType;

        if (req.url === '/live.m3u8' || req.url === '/') {
          filePath = path.join(this.hlsDir, 'live.m3u8');
          contentType = 'application/vnd.apple.mpegurl';
        } else if (req.url.endsWith('.ts')) {
          filePath = path.join(this.hlsDir, path.basename(req.url));
          contentType = 'video/mp2t';
        } else if (req.url.endsWith('.aac')) {
          filePath = path.join(this.hlsDir, path.basename(req.url));
          contentType = 'audio/aac';
        } else {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        // Check if file exists
        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end('File not found');
          return;
        }

        const stat = fs.statSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stat.size,
        });

        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);
      });

      this.httpServer.listen(port, '0.0.0.0', () => {
        console.log(`HLS server on port ${port}`);
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  /**
   * Start HTTP server for progressive MP3 streaming with accumulating buffer
   * New clients get all buffered data immediately, then live audio continues
   */
  startMp3Server(port) {
    // Accumulating buffer - stores last ~10 seconds of audio (400KB at 320kbps)
    const MAX_BUFFER_SIZE = 400 * 1024;
    this.audioBuffer = [];
    this.audioBufferSize = 0;

    console.log(`Audio buffer: max ${Math.round(MAX_BUFFER_SIZE / 1024)} KB (~10 seconds at 320kbps)`);

    // Method to add audio to buffer (called by FFmpeg handler)
    this.addToBuffer = (chunk) => {
      this.audioBuffer.push(chunk);
      this.audioBufferSize += chunk.length;

      // Trim old data if buffer exceeds max size
      while (this.audioBufferSize > MAX_BUFFER_SIZE && this.audioBuffer.length > 1) {
        const removed = this.audioBuffer.shift();
        this.audioBufferSize -= removed.length;
      }
    };

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        if (req.url !== '/live.mp3' && req.url !== '/') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-cache, no-store',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Transfer-Encoding': 'chunked',
        });

        // Send ALL buffered audio immediately - fills Cast buffer fast!
        if (this.audioBuffer.length > 0) {
          const buffered = Buffer.concat(this.audioBuffer);
          res.write(buffered);
          console.log(`Sent ${Math.round(buffered.length / 1024)} KB buffered audio to client`);
        }

        this.clients.add(res);
        console.log(`Client connected. Total: ${this.clients.size}`);

        req.on('close', () => {
          this.clients.delete(res);
          console.log(`Client disconnected. Total: ${this.clients.size}`);
        });

        res.on('error', () => {
          this.clients.delete(res);
        });
      });

      this.httpServer.listen(port, '0.0.0.0', () => {
        console.log(`MP3 server on port ${port}`);
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  /**
   * Start FFmpeg for HLS output
   */
  startHlsFFmpeg(audioDevice) {
    const ffmpeg = this.getFFmpegPath();
    const outputPath = path.join(this.hlsDir, 'live.m3u8');

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      // Low latency input
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-rtbufsize', '64k',
      // Input from dshow
      '-f', 'dshow',
      '-audio_buffer_size', '50',
      '-i', `audio=${audioDevice}`,
      // Audio processing
      '-ac', String(CONFIG.channels),
      '-ar', String(CONFIG.sampleRate),
      // AAC output for HLS (better compatibility)
      '-c:a', 'aac',
      '-b:a', CONFIG.bitrate,
      '-profile:a', 'aac_low',
      // HLS output settings
      '-f', 'hls',
      '-hls_time', String(CONFIG.hlsSegmentTime),
      '-hls_list_size', String(CONFIG.hlsListSize),
      '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(this.hlsDir, 'segment%03d.ts'),
      outputPath,
    ];

    console.log('Starting FFmpeg HLS with device:', audioDevice);

    this.ffmpegProcess = spawn(ffmpeg, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.ffmpegProcess.stdout.on('data', (data) => {
      console.log('FFmpeg stdout:', data.toString());
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      // Only log warnings/errors, not info
      if (msg.includes('Warning') || msg.includes('Error') || msg.includes('error')) {
        console.error('FFmpeg:', msg);
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('FFmpeg error:', err);
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg exited with code ${code}`);
    });
  }

  /**
   * Start FFmpeg for MP3 streaming
   */
  startMp3FFmpeg(audioDevice) {
    const ffmpeg = this.getFFmpegPath();

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // Low latency input
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-rtbufsize', '64k',
      '-f', 'dshow',
      '-audio_buffer_size', '50',
      '-i', `audio=${audioDevice}`,
      // Audio processing
      '-ac', String(CONFIG.channels),
      '-ar', String(CONFIG.sampleRate),
      // MP3 320kbps output
      '-c:a', 'libmp3lame',
      '-b:a', CONFIG.bitrate,
      '-f', 'mp3',
      'pipe:1',
    ];

    console.log('Starting FFmpeg MP3 with device:', audioDevice);

    this.ffmpegProcess = spawn(ffmpeg, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let bytesStreamed = 0;
    let firstChunk = true;
    this.ffmpegProcess.stdout.on('data', (chunk) => {
      if (firstChunk) {
        console.log(`FFmpeg: First audio chunk received (${chunk.length} bytes)`);
        firstChunk = false;
      }
      bytesStreamed += chunk.length;

      // Add to rolling buffer (for new clients)
      if (this.addToBuffer) {
        this.addToBuffer(chunk);
      }

      // Log every 50KB of data streamed (more frequent logging)
      if (bytesStreamed % 51200 < chunk.length) {
        console.log(`FFmpeg data: ${Math.round(bytesStreamed / 1024)} KB streamed, buffer: ${Math.round(this.audioBufferSize / 1024)} KB, ${this.clients.size} clients`);
      }

      // Send to all connected clients
      for (const client of this.clients) {
        try {
          if (!client.writableEnded) {
            client.write(chunk);
          }
        } catch (e) {
          this.clients.delete(client);
        }
      }
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      console.error('FFmpeg:', data.toString());
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('FFmpeg error:', err);
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg exited with code ${code}`);
    });
  }

  /**
   * Wait for first HLS segment to be ready
   */
  async waitForHlsReady(timeout = 10000) {
    const playlistPath = path.join(this.hlsDir, 'live.m3u8');
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(playlistPath)) {
        const content = fs.readFileSync(playlistPath, 'utf8');
        if (content.includes('.ts')) {
          console.log('HLS playlist ready');
          return true;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    throw new Error('HLS playlist not ready in time');
  }

  async start(selectedDevice = null, mode = 'hls') {
    if (this.isStreaming) {
      throw new Error('Already streaming');
    }

    this.mode = mode;
    console.log(`Starting audio stream (${mode} mode)...`);

    const audioDevice = selectedDevice || await this.findAudioDevice();
    console.log('Using audio device:', audioDevice);

    const port = await this.findAvailablePort();

    // Ensure firewall allows incoming connections
    await ensureFirewallRule(port);

    if (mode === 'hls') {
      // HLS mode
      this.createHlsDir();
      await this.startHlsServer(port);
      this.startHlsFFmpeg(audioDevice);
      await this.waitForHlsReady();
      this.streamUrl = `http://${this.localIp}:${port}/live.m3u8`;
    } else {
      // MP3 mode
      await this.startMp3Server(port);
      this.startMp3FFmpeg(audioDevice);
      this.streamUrl = `http://${this.localIp}:${port}/live.mp3`;
    }

    this.isStreaming = true;
    console.log('Stream URL:', this.streamUrl);

    return this.streamUrl;
  }

  async stop() {
    console.log('Stopping audio stream...');
    this.isStreaming = false;

    for (const client of this.clients) {
      try {
        client.end();
      } catch (e) {}
    }
    this.clients.clear();

    if (this.ffmpegProcess) {
      try {
        this.ffmpegProcess.kill('SIGTERM');
      } catch (e) {}
      this.ffmpegProcess = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    // Clean up HLS directory
    if (this.hlsDir && fs.existsSync(this.hlsDir)) {
      try {
        fs.rmSync(this.hlsDir, { recursive: true });
        console.log('Cleaned up HLS directory');
      } catch (e) {
        console.error('Failed to clean HLS dir:', e);
      }
      this.hlsDir = null;
    }

    console.log('Audio stream stopped');
  }
}

module.exports = { AudioStreamer };
