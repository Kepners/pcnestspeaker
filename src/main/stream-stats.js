/**
 * Stream Statistics Tracker
 *
 * Monitors FFmpeg output to track:
 * - Bitrate (kbps)
 * - Data sent (MB)
 * - Connection status
 * - Audio levels (simulated for visualizer)
 */

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
    this.audioLevels = new Array(8).fill(0);
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
      this.updateAudioLevels();
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
   * Example FFmpeg output:
   * "frame=  123 fps= 25 q=28.0 size=    1024kB time=00:00:05.00 bitrate= 128.0kbits/s speed=1.0x"
   */
  parseFfmpegOutput(line) {
    if (!this.isActive) return;

    // Extract bitrate
    const bitrateMatch = line.match(/bitrate=\s*([0-9.]+)kbits\/s/);
    if (bitrateMatch) {
      this.bitrate = parseFloat(bitrateMatch[1]);
    }

    // Extract size (total data sent)
    const sizeMatch = line.match(/size=\s*([0-9]+)kB/);
    if (sizeMatch) {
      this.totalBytes = parseInt(sizeMatch[1]) * 1024; // Convert kB to bytes
    }

    // Update timestamp
    this.lastUpdateTime = Date.now();
  }

  /**
   * Update simulated audio levels for visualizer
   * Creates random animated bars that look like audio activity
   */
  updateAudioLevels() {
    if (!this.isActive) {
      this.audioLevels = new Array(8).fill(0);
      return;
    }

    // Generate random levels for each bar (0-100)
    // Use different frequencies to make it look more natural
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      // Each bar oscillates at a different frequency
      const freq = 0.5 + (i * 0.2);
      const phase = (now / 1000) * freq;

      // Mix sine waves with some randomness
      const sine = Math.sin(phase) * 0.5 + 0.5; // 0-1 range
      const random = Math.random() * 0.3; // Add 30% randomness
      const level = Math.min(100, Math.max(10, (sine + random) * 100));

      this.audioLevels[i] = Math.round(level);
    }
  }

  /**
   * Get current stats
   */
  getStats() {
    const dataMB = (this.totalBytes / (1024 * 1024)).toFixed(2);
    const uptime = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;

    return {
      bitrate: Math.round(this.bitrate),
      data: dataMB,
      connection: this.isActive ? 'Active' : 'Inactive',
      audioLevels: this.audioLevels,
      uptime,
      isActive: this.isActive
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
