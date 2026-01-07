/**
 * Stream Statistics Tracker
 *
 * Monitors FFmpeg output to track:
 * - Bitrate (kbps)
 * - Data sent (MB)
 * - Connection status
 * - Activity indicator (shows when FFmpeg is actively sending data)
 *
 * Note: For RTSP streaming (WebRTC mode), FFmpeg shows bitrate=N/A and size=N/A.
 * In this case, we use configured values and calculate estimated data sent.
 */

// Configured bitrate for Opus encoding (kbps)
const CONFIGURED_BITRATE = 128;

class StreamStats {
  constructor() {
    this.reset();
    this.updateInterval = null;
    this.listeners = [];
  }

  reset() {
    this.bitrate = 0;
    this.totalBytes = 0;
    this.isActive = false;
    this.startTime = null;
    this.lastUpdateTime = Date.now();
    this.lastDataTime = 0;  // When we last got FFmpeg data
    this.audioLevels = new Array(8).fill(0);
    this.hasReceivedData = false;  // Have we ever received FFmpeg output?
    this.elapsedSeconds = 0;  // FFmpeg reported elapsed time
    this.useEstimatedData = false;  // True when FFmpeg reports N/A
  }

  /**
   * Start monitoring stream
   */
  start() {
    this.reset();
    this.isActive = true;
    this.startTime = Date.now();

    // Update stats every 100ms
    this.updateInterval = setInterval(() => {
      this.updateActivityIndicator();
      this.notifyListeners();
    }, 100);
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.isActive = false;
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.reset();
    this.notifyListeners();
  }

  /**
   * Parse FFmpeg output line to extract stats
   * FFmpeg audio output formats:
   * - "size=    1024kB time=00:00:05.00 bitrate= 128.0kbits/s"
   * - "size=1024kB time=00:00:05.00 bitrate=128.0kbits/s"
   * - "size=N/A time=00:00:05.00 bitrate=N/A speed=1x" (RTSP streaming)
   */
  parseFfmpegOutput(line) {
    if (!this.isActive) return;

    // Only process lines with FFmpeg stats
    if (!line.includes('time=')) return;

    // Extract elapsed time from FFmpeg output
    // "time=00:13:08.45" -> parse to seconds
    const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const seconds = parseFloat(timeMatch[3]);
      this.elapsedSeconds = hours * 3600 + minutes * 60 + seconds;
      this.lastDataTime = Date.now();
      this.hasReceivedData = true;
    }

    // Extract bitrate - handle various formats
    // "bitrate= 128.0kbits/s" or "bitrate=128.0kbits/s" or "bitrate=128kbits/s"
    const bitrateMatch = line.match(/bitrate=\s*([0-9.]+)\s*kbits\/s/i);
    if (bitrateMatch) {
      this.bitrate = parseFloat(bitrateMatch[1]);
      this.useEstimatedData = false;
    } else if (line.includes('bitrate=N/A')) {
      // RTSP streaming mode - use configured bitrate
      this.bitrate = CONFIGURED_BITRATE;
      this.useEstimatedData = true;
    }

    // Extract size (total data sent) - handle various formats
    // "size=    1024kB" or "size=1024kB" or "size=1024KiB"
    const sizeMatch = line.match(/size=\s*([0-9]+)\s*(kB|KiB)/i);
    if (sizeMatch) {
      this.totalBytes = parseInt(sizeMatch[1]) * 1024; // Convert kB to bytes
      this.useEstimatedData = false;
    } else if (line.includes('size=N/A') && this.elapsedSeconds > 0) {
      // RTSP streaming mode - estimate data based on bitrate and time
      // Bitrate in kbits/s -> bytes = (kbits * time_seconds) / 8 * 1000
      this.totalBytes = (CONFIGURED_BITRATE * this.elapsedSeconds * 1000) / 8;
      this.useEstimatedData = true;
    }

    // Update timestamp
    this.lastUpdateTime = Date.now();
  }

  /**
   * Update activity indicator based on whether FFmpeg is actually sending data
   * Bars show activity when receiving FFmpeg progress updates
   */
  updateActivityIndicator() {
    if (!this.isActive) {
      this.audioLevels = new Array(8).fill(0);
      return;
    }

    const now = Date.now();
    const timeSinceData = now - this.lastDataTime;

    // If we received FFmpeg data in the last 2 seconds, show activity
    // Otherwise, show minimal activity or flat bars
    if (this.hasReceivedData && timeSinceData < 2000) {
      // Active streaming - show audio-like randomized bars
      // Use configured bitrate if actual is N/A
      const effectiveBitrate = this.bitrate || CONFIGURED_BITRATE;
      const activityLevel = Math.min(100, (effectiveBitrate / 320) * 100); // 320kbps = 100%

      for (let i = 0; i < 8; i++) {
        // Audio-like visualization: random spiky bars with smooth decay
        // Each bar has its own random target and smoothly moves toward it
        const currentLevel = this.audioLevels[i] || 0;

        // Generate new random target (more variation = more audio-like)
        // Low frequencies (left bars) tend to be higher, highs (right) more variable
        const baseLevel = activityLevel * (0.4 + Math.random() * 0.6);
        const frequencyBias = 1.0 - (i * 0.05); // Left bars slightly higher (bass)
        const targetLevel = Math.max(10, baseLevel * frequencyBias);

        // Smooth interpolation toward target (fast attack, slower decay)
        const isRising = targetLevel > currentLevel;
        const smoothFactor = isRising ? 0.7 : 0.3; // Fast attack, slow decay
        const newLevel = currentLevel + (targetLevel - currentLevel) * smoothFactor;

        this.audioLevels[i] = Math.round(Math.max(5, Math.min(100, newLevel)));
      }
    } else if (this.isActive && !this.hasReceivedData) {
      // Waiting for data - show pulsing "connecting" animation
      for (let i = 0; i < 8; i++) {
        const phase = ((now / 500) + i * 0.3) % (Math.PI * 2);
        const pulse = Math.sin(phase) * 0.5 + 0.5; // 0 to 1 range
        this.audioLevels[i] = Math.round(pulse * 20); // Max 20%
      }
    } else {
      // No recent data - show flat low bars
      this.audioLevels = new Array(8).fill(5);
    }
  }

  /**
   * Get current stats
   */
  getStats() {
    const dataMB = (this.totalBytes / (1024 * 1024)).toFixed(2);
    const uptime = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;

    // Use configured bitrate if actual is N/A
    const effectiveBitrate = this.bitrate || (this.isActive ? CONFIGURED_BITRATE : 0);

    return {
      bitrate: Math.round(effectiveBitrate),
      data: dataMB,
      connection: this.isActive ? 'Active' : 'Inactive',
      audioLevels: this.audioLevels,
      uptime,
      isActive: this.isActive,
      isEstimated: this.useEstimatedData,  // True when using estimated data
      elapsedSeconds: Math.round(this.elapsedSeconds)
    };
  }

  /**
   * Register a listener for stats updates
   */
  addListener(callback) {
    this.listeners.push(callback);
  }

  /**
   * Remove a listener
   */
  removeListener(callback) {
    this.listeners = this.listeners.filter(cb => cb !== callback);
  }

  /**
   * Notify all listeners of stats update
   */
  notifyListeners() {
    const stats = this.getStats();
    this.listeners.forEach(cb => {
      try {
        cb(stats);
      } catch (err) {
        console.error('[StreamStats] Listener error:', err);
      }
    });
  }
}

module.exports = { StreamStats };
