/**
 * Audio Streamer - Handles audio capture and streaming via FFmpeg
 *
 * Audio Pipeline:
 * Windows Audio → WASAPI Loopback (electron-audio-loopback) → FFmpeg → MP3 Stream → HTTP → Nest Speaker
 *
 * Key: Uses progressive MP3 streaming - NO files created on disk!
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
  chunkSize: 8192, // Bytes per chunk (from reference Python code)
};

class AudioStreamer {
  constructor() {
    this.ffmpegProcess = null;
    this.audioCapture = null;
    this.httpServer = null;
    this.isStreaming = false;
    this.localIp = this.getLocalIp();
    this.clients = new Set(); // Track connected HTTP clients
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
   * Start the HTTP server for MP3 streaming
   * Streams directly from FFmpeg stdout to connected clients - NO FILES!
   */
  startHttpServer(port) {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // Only serve the live stream
        if (req.url !== '/live.mp3' && req.url !== '/') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        // Stream headers for Chromecast compatibility
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-cache, no-store',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Transfer-Encoding': 'chunked',
        });

        // Track this client
        this.clients.add(res);
        console.log(`Client connected. Total clients: ${this.clients.size}`);

        // Clean up on disconnect
        req.on('close', () => {
          this.clients.delete(res);
          console.log(`Client disconnected. Total clients: ${this.clients.size}`);
        });

        res.on('error', () => {
          this.clients.delete(res);
        });
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
        format: 'f32le', // 32-bit float, little-endian
      });

      console.log('Native WASAPI audio capture initialized');
      return this.audioCapture;
    } catch (error) {
      console.error('Failed to initialize native audio capture:', error);
      throw new Error('Audio capture failed. Please ensure Windows audio is working.');
    }
  }

  /**
   * Start FFmpeg with MP3 output to stdout
   * Streams directly - no files created!
   */
  startFFmpegMP3(audioStream) {
    const ffmpeg = this.getFFmpegPath();

    // FFmpeg args for piped input, MP3 output to stdout
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // Input: raw PCM from stdin
      '-f', 'f32le',
      '-ar', String(CONFIG.sampleRate),
      '-ac', String(CONFIG.channels),
      '-i', 'pipe:0',
      // Audio processing - async resampling for stability
      '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
      // MP3 output
      '-c:a', 'libmp3lame',
      '-b:a', CONFIG.bitrate,
      '-q:a', '2',
      // Streaming optimizations
      '-fflags', '+nobuffer',
      '-bufsize', '256k',
      '-f', 'mp3',
      'pipe:1', // Output to stdout
    ];

    this.ffmpegProcess = spawn(ffmpeg, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe audio data from WASAPI capture to FFmpeg stdin
    audioStream.on('data', (buffer) => {
      if (this.ffmpegProcess && this.ffmpegProcess.stdin.writable) {
        this.ffmpegProcess.stdin.write(buffer);
      }
    });

    audioStream.on('error', (err) => {
      console.error('Audio capture error:', err);
    });

    // Pipe FFmpeg MP3 output to all connected HTTP clients
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

    console.log('FFmpeg MP3 streaming started');
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

    // Start FFmpeg with MP3 output to connected clients
    this.startFFmpegMP3(audioStream);

    this.isStreaming = true;

    const streamUrl = `http://${this.localIp}:${port}/live.mp3`;
    console.log('Stream URL:', streamUrl);

    return streamUrl;
  }

  /**
   * Stop streaming
   */
  async stop() {
    console.log('Stopping audio stream...');
    this.isStreaming = false;

    // Close all client connections
    for (const client of this.clients) {
      try {
        client.end();
      } catch (e) {
        // Ignore
      }
    }
    this.clients.clear();

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

    console.log('Audio stream stopped');
  }
}

module.exports = { AudioStreamer };
