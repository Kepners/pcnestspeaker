/**
 * Chromecast/Nest Speaker Discovery and Casting
 * Uses castv2-client with Python pychromecast fallback for Nest devices
 */

const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const mdns = require('mdns-js');
const { spawn } = require('child_process');
const path = require('path');

class ChromecastManager {
  constructor() {
    this.speakers = new Map();
    this.activeClient = null;
    this.activePlayer = null;
    this.logCallback = null;
    this.usedPython = false;
    this.pythonSpeaker = null;
  }

  setLogCallback(callback) {
    this.logCallback = callback;
  }

  _log(message, type = 'info') {
    console.log(`[Chromecast] ${message}`);
    if (this.logCallback) {
      this.logCallback(message, type);
    }
  }

  /**
   * Discover Chromecast/Nest speakers on the network
   */
  async discoverSpeakers(timeout = 10000) {
    return new Promise((resolve) => {
      const speakers = [];

      this._log('Starting mDNS discovery...');

      const browser = mdns.createBrowser(mdns.tcp('googlecast'));

      browser.on('ready', () => {
        browser.discover();
      });

      browser.on('update', (service) => {
        if (service.addresses && service.addresses.length > 0) {
          const name = service.txt?.find(t => t.startsWith('fn='))?.replace('fn=', '') ||
                       service.fullname?.split('.')[0] ||
                       'Unknown Device';

          const model = service.txt?.find(t => t.startsWith('md='))?.replace('md=', '') || 'Chromecast';

          if (!this.speakers.has(name)) {
            this._log(`Found: ${name} (${service.addresses[0]})`);

            const speaker = {
              name,
              model,
              ip: service.addresses[0],
              port: service.port || 8009,
            };

            speakers.push(speaker);
            this.speakers.set(name, speaker);
          }
        }
      });

      setTimeout(() => {
        browser.stop();
        this._log(`Discovery complete. Found ${speakers.length} devices.`);
        resolve(speakers);
      }, timeout);
    });
  }

  stopDiscovery() {}

  /**
   * Cast audio to a speaker - simple approach like pychromecast
   */
  async castToSpeaker(speakerName, streamUrl, contentType = 'audio/mpeg') {
    const speaker = this.speakers.get(speakerName);
    if (!speaker) {
      throw new Error(`Speaker "${speakerName}" not found`);
    }

    // Close any existing connection
    if (this.activeClient) {
      try {
        this.activeClient.close();
      } catch (e) {}
      this.activeClient = null;
      this.activePlayer = null;
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      let resolved = false;

      const cleanup = (err) => {
        if (!resolved) {
          resolved = true;
          client.close();
          reject(err);
        }
      };

      // Set a timeout for the whole operation
      const timeout = setTimeout(() => {
        cleanup(new Error('Cast operation timed out after 30 seconds'));
      }, 30000);

      this._log(`Connecting to ${speakerName} (${speaker.ip})...`);

      client.connect(speaker.ip, () => {
        this._log('Connected!', 'success');

        // Like pychromecast: just launch and play, don't check status first
        this._log('Launching media receiver...');

        client.launch(DefaultMediaReceiver, (err, player) => {
          if (err) {
            clearTimeout(timeout);
            this._log(`Launch failed: ${err.message}`, 'error');

            // Check if it's a Nest restriction - try Python fallback
            if (err.message.includes('NOT_ALLOWED')) {
              this._log('Node.js blocked, trying Python pychromecast...', 'warn');

              // Try Python fallback
              this.castWithPython(speakerName, streamUrl, contentType)
                .then((result) => {
                  clearTimeout(timeout);
                  resolved = true;
                  this.usedPython = true;
                  this.pythonSpeaker = speakerName;
                  resolve(result);
                })
                .catch((pyErr) => {
                  clearTimeout(timeout);
                  cleanup(new Error(
                    `Node.js: ${err.message}. Python fallback: ${pyErr.message}`
                  ));
                });
              return;
            } else {
              cleanup(err);
            }
            return;
          }

          this._log('Media receiver launched!', 'success');

          // Set up player event handlers
          player.on('status', (status) => {
            if (status && status.playerState) {
              this._log(`Player: ${status.playerState}`);
            }
          });

          player.on('error', (playerErr) => {
            this._log(`Player error: ${playerErr.message}`, 'error');
          });

          // Load the media
          const media = {
            contentId: streamUrl,
            contentType: contentType,
            streamType: 'LIVE',
            metadata: {
              type: 0,
              metadataType: 0,
              title: 'PC Audio',
              subtitle: 'Streaming from PC'
            }
          };

          this._log(`Loading: ${streamUrl}`);

          player.load(media, { autoplay: true }, (loadErr, status) => {
            clearTimeout(timeout);

            if (loadErr) {
              this._log(`Load failed: ${loadErr.message}`, 'error');
              cleanup(loadErr);
              return;
            }

            resolved = true;
            this._log(`Playing! State: ${status.playerState}`, 'success');

            this.activeClient = client;
            this.activePlayer = player;

            resolve({ playerState: status.playerState });
          });
        });
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        this._log(`Connection error: ${err.message}`, 'error');
        cleanup(err);
      });
    });
  }

  async stopCasting() {
    // If we used Python, stop via Python
    if (this.usedPython && this.pythonSpeaker) {
      await this.stopWithPython(this.pythonSpeaker);
      this.usedPython = false;
      this.pythonSpeaker = null;
    }

    // Also try to stop Node.js connection
    if (this.activePlayer) {
      try {
        this.activePlayer.stop();
      } catch (e) {}
    }
    if (this.activeClient) {
      try {
        this.activeClient.close();
      } catch (e) {}
    }
    this.activeClient = null;
    this.activePlayer = null;
    this._log('Stopped');
  }

  async stopAll() {
    await this.stopCasting();
  }

  /**
   * Cast using Python pychromecast (fallback for Nest devices)
   */
  async castWithPython(speakerName, streamUrl, contentType = 'audio/mpeg') {
    return new Promise((resolve, reject) => {
      this._log('Trying Python pychromecast fallback...', 'warn');

      const pythonScript = path.join(__dirname, 'cast-helper.py');
      const python = spawn('python', [pythonScript, 'cast', speakerName, streamUrl, contentType], {
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
        this._log(`Python: ${data.toString().trim()}`);
      });

      python.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const result = JSON.parse(stdout.trim());
            if (result.success) {
              this._log('Python cast successful!', 'success');
              resolve(result);
            } else {
              this._log(`Python cast failed: ${result.error}`, 'error');
              reject(new Error(result.error));
            }
          } catch (e) {
            this._log(`Python output parse error: ${stdout}`, 'error');
            reject(new Error('Failed to parse Python output'));
          }
        } else {
          this._log(`Python exited with code ${code}: ${stderr}`, 'error');
          reject(new Error(stderr || `Python exited with code ${code}`));
        }
      });

      python.on('error', (err) => {
        this._log(`Python spawn error: ${err.message}`, 'error');
        reject(new Error(`Python not available: ${err.message}`));
      });
    });
  }

  /**
   * Stop casting using Python
   */
  async stopWithPython(speakerName) {
    return new Promise((resolve) => {
      const pythonScript = path.join(__dirname, 'cast-helper.py');
      const python = spawn('python', [pythonScript, 'stop', speakerName], {
        windowsHide: true
      });

      python.on('close', () => {
        this._log('Python stop complete');
        resolve();
      });

      python.on('error', () => {
        resolve(); // Ignore errors on stop
      });
    });
  }
}

module.exports = { ChromecastManager };
