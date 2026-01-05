/**
 * WebRTC Client - Runs in renderer process for sub-1 second latency streaming
 *
 * Flow:
 * 1. Request system audio via main process (desktopCapturer)
 * 2. Create RTCPeerConnection with audio track
 * 3. Send SDP offer to Cast receiver via main process
 * 4. Handle SDP answer and ICE candidates
 * 5. Stream audio over WebRTC (UDP) - no HTTP buffering!
 */

class WebRTCClient {
  constructor() {
    this.peerConnection = null;
    this.audioStream = null;
    this.isStreaming = false;
    this.speakerName = null;
  }

  log(message, type = 'info') {
    console.log(`[WebRTC] ${message}`);
    // Also log to UI if available
    if (window.addLog) {
      window.addLog(`[WebRTC] ${message}`, type);
    }
  }

  /**
   * Get system audio stream
   * Uses Electron's desktopCapturer via IPC
   */
  async getSystemAudioStream() {
    this.log('Requesting system audio...');

    // Get screen sources (needed to capture system audio)
    const sources = await window.electronAPI.getDesktopSources();

    if (!sources || sources.length === 0) {
      throw new Error('No screen sources available for audio capture');
    }

    // Request audio from the first screen source
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
      this.log(`Got audio stream: ${stream.getAudioTracks().length} tracks`);
      return stream;
    } catch (error) {
      // System audio capture might not be supported on all platforms
      throw new Error(`Failed to capture system audio: ${error.message}. Try enabling "Stereo Mix" in Windows Sound settings.`);
    }
  }

  /**
   * Create RTCPeerConnection
   */
  createPeerConnection() {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    this.peerConnection = new RTCPeerConnection(config);
    this.log('PeerConnection created');

    // Handle ICE candidates
    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        this.log('Sending ICE candidate...');
        try {
          await window.electronAPI.webrtcSignal(this.speakerName, {
            type: 'ice',
            candidate: event.candidate
          });
        } catch (e) {
          this.log(`ICE send error: ${e.message}`, 'error');
        }
      }
    };

    // Connection state changes
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      this.log(`Connection state: ${state}`);

      if (state === 'connected') {
        this.isStreaming = true;
        this.log('WebRTC connected! Audio streaming with sub-1s latency!', 'success');
      } else if (state === 'failed' || state === 'disconnected') {
        this.isStreaming = false;
        this.log(`Connection ${state}`, 'error');
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      this.log(`ICE state: ${this.peerConnection.iceConnectionState}`);
    };

    return this.peerConnection;
  }

  /**
   * Start WebRTC streaming to a speaker
   */
  async start(speakerName) {
    if (this.isStreaming) {
      throw new Error('Already streaming');
    }

    this.speakerName = speakerName;
    this.log(`Starting WebRTC stream to "${speakerName}"...`);

    try {
      // Step 1: Launch custom receiver on Cast device
      this.log('Launching custom receiver...');
      const launchResult = await window.electronAPI.webrtcLaunch(speakerName);

      if (!launchResult.success) {
        throw new Error(launchResult.error || 'Failed to launch receiver');
      }
      this.log('Custom receiver launched');

      // Step 2: Get system audio
      this.log('Capturing system audio...');
      this.audioStream = await this.getSystemAudioStream();

      // Step 3: Create peer connection
      this.createPeerConnection();

      // Add audio track
      const audioTrack = this.audioStream.getAudioTracks()[0];
      if (!audioTrack) {
        throw new Error('No audio track in stream');
      }
      this.peerConnection.addTrack(audioTrack, this.audioStream);
      this.log('Added audio track to connection');

      // Step 4: Create and send SDP offer
      this.log('Creating SDP offer...');
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      await this.peerConnection.setLocalDescription(offer);
      this.log('Created local description');

      // Step 5: Send offer to receiver and get answer
      this.log('Sending offer to receiver...');
      const signalResult = await window.electronAPI.webrtcSignal(speakerName, {
        type: 'offer',
        sdp: offer
      });

      if (!signalResult.success) {
        throw new Error(signalResult.error || 'Signaling failed');
      }

      // Step 6: Handle answer
      if (signalResult.response && signalResult.response.type === 'answer') {
        this.log('Received SDP answer');
        await this.peerConnection.setRemoteDescription(
          new RTCSessionDescription(signalResult.response.sdp || signalResult.response)
        );
        this.log('Set remote description');
      } else {
        this.log('No answer received, connection may still establish via ICE', 'warning');
      }

      return { success: true };
    } catch (error) {
      this.log(`Start failed: ${error.message}`, 'error');
      this.stop();
      throw error;
    }
  }

  /**
   * Handle incoming ICE candidate from receiver
   */
  async handleRemoteIceCandidate(candidate) {
    if (this.peerConnection && candidate) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        this.log('Added remote ICE candidate');
      } catch (e) {
        this.log(`ICE candidate error: ${e.message}`, 'error');
      }
    }
  }

  /**
   * Stop streaming
   */
  async stop() {
    this.log('Stopping WebRTC stream...');
    this.isStreaming = false;

    // Close peer connection
    if (this.peerConnection) {
      // Send close message to receiver
      if (this.speakerName) {
        try {
          await window.electronAPI.webrtcSignal(this.speakerName, { type: 'close' });
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Stop audio tracks
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }

    this.speakerName = null;
    this.log('WebRTC stream stopped');
  }
}

// Export for use in renderer
window.WebRTCClient = WebRTCClient;
