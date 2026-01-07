/**
 * Stream Statistics Tracker
 *
 * Monitors FFmpeg output to track:
 * - Bitrate (kbps)
 * - Data sent (MB)
 * - Connection status
 * - Activity indicator (shows when FFmpeg is actively sending data)
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
    this.lastDataTime = 0;  // When we last got FFmpeg data
    this.audioLevels = new Array(8).fill(0);
    this.hasReceivedData = false;  // Have we ever received FFmpeg output?
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
   * - "size=N/A time=00:00:05.00 bitrate=N/A" (for some streams)
   */
  parseFfmpegOutput(line) {
    if (!this.isActive) return;

    // Log raw FFmpeg output for debugging
    if (line.includes('size=') || line.includes('bitrate=')) {
      console.log('[StreamStats] FFmpeg output:', line.trim());
    }

    // Extract bitrate - handle various formats
    // "bitrate= 128.0kbits/s" or "bitrate=128.0kbits/s" or "bitrate=128kbits/s"
    const bitrateMatch = line.match(/bitrate=\s*([0-9.]+)\s*kbits\/s/i);
    if (bitrateMatch) {
      this.bitrate = parseFloat(bitrateMatch[1]);
      this.lastDataTime = Date.now();
      this.hasReceivedData = true;
    }

    // Extract size (total data sent) - handle various formats
    // "size=    1024kB" or "size=1024kB" or "size=1024KiB"
    const sizeMatch = line.match(/size=\s*([0-9]+)\s*(kB|KiB)/i);
    if (sizeMatch) {
      this.totalBytes = parseInt(sizeMatch[1]) * 1024; // Convert kB to bytes
      this.lastDataTime = Date.now();
      this.hasReceivedData = true;
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
      // Active streaming - show animated bars based on bitrate
      const activityLevel = Math.min(100, (this.bitrate / 320) * 100); // 320kbps = 100%

      for (let i = 0; i < 8; i++) {
        // Create wave effect based on bitrate
        const phase = ((now / 200) + i * 0.5) % (Math.PI * 2);
        const wave = Math.sin(phase) * 0.3 + 0.7; // 0.4 to 1.0 range
        const level = Math.max(5, activityLevel * wave);
        this.audioLevels[i] = Math.round(level);
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
