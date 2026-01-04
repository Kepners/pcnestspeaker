/**
 * Audio Streamer - Handles audio capture and streaming via FFmpeg
 *
 * Audio Pipeline:
 * Windows Audio → WASAPI Loopback (electron-audio-loopback) → FFmpeg → HLS → HTTP Server → Nest Speaker
 *
 * Key: Uses native WASAPI loopback - NO external software (VB-CABLE etc) required!
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
  bitrate: '128k',
  hlsSegmentTime: 0.5,
  hlsListSize: 3,
};

class AudioStreamer {
  constructor() {
    this.ffmpegProcess = null;
    this.audioCapture = null;
    this.httpServer = null;
    this.isStreaming = false;
    this.outputDir = path.join(os.tmpdir(), 'pcnestspeaker');
    this.localIp = this.getLocalIp();
  }

  /**
   * Get local IP address
   */
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

  /**
   * Get FFmpeg path (bundled or system)
   */
  getFFmpegPath() {
    // Check for bundled FFmpeg in resources
    if (process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
      if (fs.existsSync(bundled)) {
        return bundled;
      }
    }

    // Check in project ffmpeg folder (dev mode)
    const devPath = path.join(__dirname, '../../ffmpeg/ffmpeg.exe');
    if (fs.existsSync(devPath)) {
      return devPath;
    }

    // Fall back to system FFmpeg
    return 'ffmpeg';
  }

  /**
   * Find an available port
   */
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
   * Start the HTTP server for streaming
   */
  async startHttpServer(port) {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');

        // Serve files from output directory
        const requestedPath = req.url.replace(/^\//, '').split('?')[0];
        const filePath = path.join(this.outputDir, requestedPath);

        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const ext = path.extname(filePath);
        const contentType = {
          '.m3u8': 'application/x-mpegURL',
          '.ts': 'video/MP2T',
          '.mp3': 'audio/mpeg',
        }[ext] || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
      });

      this.httpServer.listen(port, '0.0.0.0', () => {
        console.log(`HTTP server listening on port ${port}`);
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  /**
   * Initialize audio capture using electron-audio-loopback
   * This uses native WASAPI loopback - no VB-CABLE needed!
   */
  async initAudioCapture() {
    try {
      // Import the native audio loopback module
      const audioLoopback = require('electron-audio-loopback');

      // Start capturing system audio
      this.audioCapture = audioLoopback.startCapture({
        sampleRate: CONFIG.sampleRate,
        channels: CONFIG.channels,
        format: 'f32le', // 32-bit float, little-endian (compatible with FFmpeg)
      });

      console.log('Native WASAPI audio capture initialized');
      return this.audioCapture;
    } catch (error) {
      console.error('Failed to initialize native audio capture:', error);
      throw new Error('Audio capture failed. Please ensure Windows audio is working.');
    }
  }

  /**
   * Start FFmpeg with piped audio input
   * Receives raw PCM from electron-audio-loopback, outputs HLS
   */
  async startFFmpegWithPipedAudio(audioStream) {
    // Create output directory
    fs.mkdirSync(this.outputDir, { recursive: true });

    // Clean old files
    try {
      for (const file of fs.readdirSync(this.outputDir)) {
        fs.unlinkSync(path.join(this.outputDir, file));
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    const ffmpeg = this.getFFmpegPath();
    const playlistPath = path.join(this.outputDir, 'stream.m3u8');
    const segmentPath = path.join(this.outputDir, 'seg%d.ts');

    // FFmpeg args for piped input (raw PCM from WASAPI)
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // Input: raw PCM from stdin
      '-f', 'f32le',           // 32-bit float, little-endian
      '-ar', String(CONFIG.sampleRate),
      '-ac', String(CONFIG.channels),
      '-i', 'pipe:0',          // Read from stdin
      // Audio processing
      '-af', 'aresample=async=1:first_pts=0',
      // Output encoding
      '-c:a', 'aac',
      '-b:a', CONFIG.bitrate,
      '-profile:a', 'aac_low',
      // HLS output
      '-f', 'hls',
      '-hls_time', String(CONFIG.hlsSegmentTime),
      '-hls_list_size', String(CONFIG.hlsListSize),
      '-hls_flags', 'delete_segments+independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', segmentPath,
      '-fflags', '+genpts+nobuffer',
      '-flags', 'low_delay',
      playlistPath,
    ];

    return new Promise((resolve, reject) => {
      this.ffmpegProcess = spawn(ffmpeg, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Pipe audio data from WASAPI capture to FFmpeg
      audioStream.on('data', (buffer) => {
        if (this.ffmpegProcess && this.ffmpegProcess.stdin.writable) {
          this.ffmpegProcess.stdin.write(buffer);
        }
      });

      audioStream.on('error', (err) => {
        console.error('Audio capture error:', err);
      });

      this.ffmpegProcess.stderr.on('data', (data) => {
        console.error('FFmpeg:', data.toString());
      });

      this.ffmpegProcess.on('error', (err) => {
        reject(err);
      });

      this.ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg exited with code ${code}`);
      });

      // Wait for playlist to be created
      const checkPlaylist = setInterval(() => {
        if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0) {
          clearInterval(checkPlaylist);
          resolve(playlistPath);
        }
      }, 200);

      // Timeout after 20 seconds
      setTimeout(() => {
        clearInterval(checkPlaylist);
        reject(new Error('FFmpeg timeout - no stream created'));
      }, 20000);
    });
  }

  /**
   * Start streaming
   * @returns {Promise<string>} Stream URL
   */
  async start() {
    if (this.isStreaming) {
      throw new Error('Already streaming');
    }

    console.log('Starting audio stream...');

    // Find available port
    const port = await this.findAvailablePort();

    // Start HTTP server first
    await this.startHttpServer(port);

    // Initialize native audio capture (WASAPI loopback)
    const audioStream = await this.initAudioCapture();

    // Start FFmpeg with piped audio
    await this.startFFmpegWithPipedAudio(audioStream);

    this.isStreaming = true;

    const streamUrl = `http://${this.localIp}:${port}/stream.m3u8`;
    console.log('Stream URL:', streamUrl);

    return streamUrl;
  }

  /**
   * Stop streaming
   */
  async stop() {
    console.log('Stopping audio stream...');
    this.isStreaming = false;

    // Stop audio capture
    if (this.audioCapture) {
      try {
        const audioLoopback = require('electron-audio-loopback');
        audioLoopback.stopCapture();
      } catch (e) {
        // Ignore errors
      }
      this.audioCapture = null;
    }

    // Stop FFmpeg
    if (this.ffmpegProcess) {
      try {
        this.ffmpegProcess.stdin.end();
        this.ffmpegProcess.kill('SIGTERM');
      } catch (e) {
        // Ignore errors
      }
      this.ffmpegProcess = null;
    }

    // Stop HTTP server
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    // Clean up temp files
    try {
      if (fs.existsSync(this.outputDir)) {
        for (const file of fs.readdirSync(this.outputDir)) {
          fs.unlinkSync(path.join(this.outputDir, file));
        }
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    console.log('Audio stream stopped');
  }
}

module.exports = { AudioStreamer };
