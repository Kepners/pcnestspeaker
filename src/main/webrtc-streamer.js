/**
 * WebRTC Audio Streamer - Sub-1 second latency to Chromecast
 *
 * Uses Electron's desktopCapturer for system audio + WebRTC for transport.
 * Signaling is relayed through Python pychromecast via Cast custom namespace.
 */

const { desktopCapturer } = require('electron');

const WEBRTC_NAMESPACE = 'urn:x-cast:com.pcnestspeaker.webrtc';
const CUSTOM_APP_ID = 'FCAA4619';

class WebRTCStreamer {
  constructor() {
    this.peerConnection = null;
    this.audioStream = null;
    this.isStreaming = false;
    this.onSignalingMessage = null; // Callback to send messages to Cast device
  }

  /**
   * Get system audio stream using desktopCapturer
   * This captures "what you hear" - all system audio
   */
  async getSystemAudioStream() {
    // Note: desktopCapturer.getSources is for screen capture
    // For audio-only, we need to use screen capture with audio enabled
    // then extract just the audio track

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 } // Don't need thumbnails
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available for audio capture');
    }

    // Request audio from the screen source
    // This works because Chromium's desktopCapturer can capture system audio
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sources[0].id
        }
      },
      video: false
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      return stream;
    } catch (error) {
      throw new Error(`Failed to capture system audio: ${error.message}`);
    }
  }

  /**
   * Create RTCPeerConnection with audio track
   */
  createPeerConnection() {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    this.peerConnection = new RTCPeerConnection(config);

    // Handle ICE candidates - send to Cast device
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.onSignalingMessage) {
        console.log('[WebRTC] Sending ICE candidate');
        this.onSignalingMessage({
          type: 'ice',
          candidate: event.candidate
        });
      }
    };

    // Connection state logging
    this.peerConnection.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', this.peerConnection.connectionState);
      if (this.peerConnection.connectionState === 'connected') {
        this.isStreaming = true;
        console.log('[WebRTC] Connected! Audio streaming...');
      } else if (this.peerConnection.connectionState === 'failed') {
        this.isStreaming = false;
        console.error('[WebRTC] Connection failed');
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state:', this.peerConnection.iceConnectionState);
    };

    return this.peerConnection;
  }

  /**
   * Start WebRTC streaming
   * @param {Function} sendMessage - Callback to send signaling messages to Cast device
   * @returns {Promise<RTCSessionDescriptionInit>} - SDP offer to send to receiver
   */
  async start(sendMessage) {
    if (this.isStreaming) {
      throw new Error('Already streaming');
    }

    this.onSignalingMessage = sendMessage;
    console.log('[WebRTC] Starting...');

    // Get system audio
    console.log('[WebRTC] Capturing system audio...');
    this.audioStream = await this.getSystemAudioStream();
    console.log('[WebRTC] Got audio stream:', this.audioStream.getAudioTracks().length, 'tracks');

    // Create peer connection
    this.createPeerConnection();

    // Add audio track to connection
    const audioTrack = this.audioStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('No audio track in stream');
    }
    this.peerConnection.addTrack(audioTrack, this.audioStream);
    console.log('[WebRTC] Added audio track');

    // Create and send offer
    const offer = await this.peerConnection.createOffer({
      offerToReceiveAudio: false, // We're sending, not receiving
      offerToReceiveVideo: false
    });
    await this.peerConnection.setLocalDescription(offer);
    console.log('[WebRTC] Created offer');

    return offer;
  }

  /**
   * Handle SDP answer from Cast receiver
   */
  async handleAnswer(answer) {
    if (!this.peerConnection) {
      throw new Error('No peer connection');
    }

    console.log('[WebRTC] Received answer');
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    console.log('[WebRTC] Set remote description');
  }

  /**
   * Handle ICE candidate from Cast receiver
   */
  async handleIceCandidate(candidate) {
    if (!this.peerConnection) {
      return;
    }

    console.log('[WebRTC] Received ICE candidate');
    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /**
   * Handle incoming signaling message from Cast device
   */
  async handleSignalingMessage(message) {
    switch (message.type) {
      case 'answer':
        await this.handleAnswer(message.sdp);
        break;
      case 'ice':
        await this.handleIceCandidate(message.candidate);
        break;
      default:
        console.log('[WebRTC] Unknown message type:', message.type);
    }
  }

  /**
   * Stop streaming
   */
  stop() {
    console.log('[WebRTC] Stopping...');
    this.isStreaming = false;

    if (this.peerConnection) {
      // Send close message to receiver
      if (this.onSignalingMessage) {
        this.onSignalingMessage({ type: 'close' });
      }
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }

    this.onSignalingMessage = null;
    console.log('[WebRTC] Stopped');
  }
}

module.exports = { WebRTCStreamer, CUSTOM_APP_ID, WEBRTC_NAMESPACE };
