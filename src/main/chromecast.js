/**
 * Chromecast/Nest Speaker Discovery and Casting
 */

const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;

class ChromecastManager {
  constructor() {
    this.speakers = new Map();
    this.activeConnections = new Map();
    this.mdns = null;
  }

  /**
   * Discover Chromecast/Nest speakers on the network
   * @returns {Promise<Array>} List of discovered speakers
   */
  async discoverSpeakers(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const speakers = [];

      try {
        // Use mdns-js for discovery
        const mdns = require('mdns-js');
        this.mdns = mdns;

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

            const speaker = {
              name,
              model,
              ip: service.addresses[0],
              port: service.port || 8009,
              id: service.txt?.find(t => t.startsWith('id='))?.replace('id=', '') || name,
            };

            // Avoid duplicates
            if (!speakers.find(s => s.ip === speaker.ip)) {
              speakers.push(speaker);
              this.speakers.set(speaker.name, speaker);
            }
          }
        });

        // Stop discovery after timeout
        setTimeout(() => {
          browser.stop();
          resolve(speakers);
        }, timeout);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop mDNS discovery
   */
  stopDiscovery() {
    // mdns-js doesn't have a global stop, browsers are stopped individually
  }

  /**
   * Cast audio to a speaker
   * @param {string} speakerName - Name of the speaker
   * @param {string} streamUrl - URL of the audio stream
   * @param {string} contentType - MIME type (default: audio/mpeg for MP3 streaming)
   */
  async castToSpeaker(speakerName, streamUrl, contentType = 'audio/mpeg') {
    const speaker = this.speakers.get(speakerName);
    if (!speaker) {
      throw new Error(`Speaker "${speakerName}" not found`);
    }

    return new Promise((resolve, reject) => {
      const client = new Client();

      client.connect(speaker.ip, () => {
        client.launch(DefaultMediaReceiver, (err, player) => {
          if (err) {
            client.close();
            return reject(err);
          }

          const media = {
            contentId: streamUrl,
            contentType: contentType,
            streamType: 'LIVE',
            metadata: {
              type: 0,
              metadataType: 0,
              title: 'PC Audio',
              subtitle: 'Streaming from PC',
            },
          };

          player.load(media, { autoplay: true }, (err, status) => {
            if (err) {
              client.close();
              return reject(err);
            }

            // Store connection for later control
            this.activeConnections.set(speakerName, { client, player });
            resolve(status);
          });
        });
      });

      client.on('error', (err) => {
        client.close();
        reject(err);
      });
    });
  }

  /**
   * Stop casting to a speaker
   * @param {string} speakerName - Name of the speaker
   */
  async stopCasting(speakerName) {
    const connection = this.activeConnections.get(speakerName);
    if (connection) {
      try {
        connection.player.stop();
        connection.client.close();
      } catch (e) {
        // Ignore errors during cleanup
      }
      this.activeConnections.delete(speakerName);
    }
  }

  /**
   * Stop all active casts
   */
  async stopAll() {
    for (const [name] of this.activeConnections) {
      await this.stopCasting(name);
    }
  }
}

module.exports = { ChromecastManager };
