/**
 * Audio Streamer - Handles audio capture and streaming via FFmpeg
 *
 * Audio Pipeline:
 * Windows Audio → Loopback Capture → FFmpeg → HLS/MP3 → HTTP Server → Nest Speaker
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
  mp3ChunkSize: 8192,
};

class AudioStreamer {
  constructor() {
    this.ffmpegProcess = null;
    this.httpServer = null;
    this.isStreaming = false;
    this.mode = 'hls'; // 'hls' or 'mp3'
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
   * Find available audio capture device
   */
  async findAudioDevice() {
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
        // Parse audio devices from FFmpeg output
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

        // Priority order for devices
        const preferred = [
          'Stereo Mix',
          'What U Hear',
          'Wave Out Mix',
          'virtual-audio-capturer',
          'CABLE Output',
        ];

        for (const pref of preferred) {
          const found = audioDevices.find(d =>
            d.toLowerCase().includes(pref.toLowerCase())
          );
          if (found) {
            resolve(found);
            return;
          }
        }

        // Return first audio device if no preferred found
        if (audioDevices.length > 0) {
          resolve(audioDevices[0]);
        } else {
          reject(new Error('No audio capture device found. Enable "Stereo Mix" in Windows Sound settings.'));
        }
      });
    });
  }

  /**
   * Get FFmpeg path (bundled or system)
   */
  getFFmpegPath() {
    // Check for bundled FFmpeg
    const bundled = path.join(process.resourcesPath || '', 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(bundled)) {
      return bundled;
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
        const filePath = path.join(this.outputDir, req.url.replace(/^\//, ''));

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
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  /**
   * Start FFmpeg with HLS output
   */
  async startFFmpegHLS(audioDevice) {
    // Create output directory
    fs.mkdirSync(this.outputDir, { recursive: true });

    // Clean old files
    for (const file of fs.readdirSync(this.outputDir)) {
      fs.unlinkSync(path.join(this.outputDir, file));
    }

    const ffmpeg = this.getFFmpegPath();
    const playlistPath = path.join(this.outputDir, 'stream.m3u8');
    const segmentPath = path.join(this.outputDir, 'seg%d.ts');

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'dshow',
      '-audio_buffer_size', '50',
      '-i', `audio=${audioDevice}`,
      '-af', 'aresample=async=1:first_pts=0',
      '-ac', String(CONFIG.channels),
      '-ar', String(CONFIG.sampleRate),
      '-c:a', 'aac',
      '-b:a', CONFIG.bitrate,
      '-profile:a', 'aac_low',
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
      this.ffmpegProcess = spawn(ffmpeg, args);

      this.ffmpegProcess.stderr.on('data', (data) => {
        console.error('FFmpeg:', data.toString());
      });

      this.ffmpegProcess.on('error', (err) => {
        reject(err);
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

    // Find audio device
    const audioDevice = await this.findAudioDevice();
    console.log('Using audio device:', audioDevice);

    // Find available port
    const port = await this.findAvailablePort();

    // Start HTTP server
    await this.startHttpServer(port);

    // Start FFmpeg
    await this.startFFmpegHLS(audioDevice);

    this.isStreaming = true;

    const streamUrl = `http://${this.localIp}:${port}/stream.m3u8`;
    console.log('Stream URL:', streamUrl);

    return streamUrl;
  }

  /**
   * Stop streaming
   */
  async stop() {
    this.isStreaming = false;

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }

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
  }
}

module.exports = { AudioStreamer };
