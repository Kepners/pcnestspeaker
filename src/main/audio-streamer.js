/**
 * Audio Streamer - Handles FFmpeg audio capture and HTTP streaming
 *
 * Supports two modes:
 * 1. HLS (default) - Lower latency with Cast devices, uses 0.5s segments
 * 2. MP3 - Fallback progressive streaming
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const net = require('net');

// Configuration
const CONFIG = {
  port: 8000,
  sampleRate: 48000,
  channels: 2,
  bitrate: '320k',  // Higher bitrate = faster buffer fill = lower latency (~8-10s vs ~22s)
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

  async getAudioDevices() {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.getFFmpegPath();
      const proc = spawn(ffmpeg, [
        '-list_devices', 'true',
        '-f', 'dshow',
        '-i', 'dummy'
      ]);

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
   * Start HTTP server for progressive MP3 streaming
   */
  startMp3Server(port) {
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
   * Start FFmpeg for MP3 output
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
      // Input from dshow
      '-f', 'dshow',
      '-audio_buffer_size', '50',
      '-i', `audio=${audioDevice}`,
      // Audio processing
      '-ac', String(CONFIG.channels),
      '-ar', String(CONFIG.sampleRate),
      // MP3 output
      '-c:a', 'libmp3lame',
      '-b:a', CONFIG.bitrate,
      '-reservoir', '0',
      // Low latency output
      '-flush_packets', '1',
      '-avioflags', 'direct',
      '-max_delay', '0',
      '-f', 'mp3',
      'pipe:1',
    ];

    console.log('Starting FFmpeg MP3 with device:', audioDevice);

    this.ffmpegProcess = spawn(ffmpeg, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.ffmpegProcess.stdout.on('data', (chunk) => {
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
