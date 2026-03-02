/**
 * Shared VideoPlayer - unified video playback for HA Card and Web UI
 * Encapsulates WebRTC signaling, stall detection, HTTP fallback, and replay.
 * No module system - just a plain class available in global scope.
 */

// eslint-disable-next-line no-unused-vars
class VideoPlayer {
  /**
   * @param {Object} options
   * @param {HTMLVideoElement} options.videoEl - the <video> element
   * @param {HTMLImageElement} options.posterEl - the <img> poster element
   * @param {HTMLElement} options.replayOverlay - the replay overlay <div>
   * @param {function(string): void} options.statusFn - display status text
   * @param {function(string, Object=): string} options.buildUrl - construct endpoint URLs
   * @param {string} [options.logPrefix='[VideoPlayer]'] - log prefix
   */
  constructor(options) {
    this._videoEl = options.videoEl;
    this._posterEl = options.posterEl;
    this._replayOverlay = options.replayOverlay;
    this._statusFn = options.statusFn;
    this._buildUrl = options.buildUrl;
    this._logPrefix = options.logPrefix || '[VideoPlayer]';

    this._currentPC = null;
    this._currentNotificationId = null;

    // Stall detector state
    this._stallLastFrameTime = 0;
    this._stallTimer = null;
    this._stallRafId = null;
    this._stallFrameReceived = false;

    // Bind video ended event
    this._onVideoEnded = () => {
      this._replayOverlay.style.display = 'flex';
      this._videoEl.controls = false;
    };
    this._videoEl.addEventListener('ended', this._onVideoEnded);

    // Bind fullscreenchange
    this._onFullscreenChange = () => {
      if (!document.fullscreenElement && this._videoEl.ended) {
        this._replayOverlay.style.display = 'flex';
        this._videoEl.controls = false;
      }
    };
    document.addEventListener('fullscreenchange', this._onFullscreenChange);
  }

  get currentNotificationId() {
    return this._currentNotificationId;
  }

  get peerConnection() {
    return this._currentPC;
  }

  // ---- Stall Detector ----

  _onVideoFrame(now) {
    this._stallFrameReceived = true;
    this._stallLastFrameTime = now;
    this._stallRafId = this._videoEl.requestVideoFrameCallback(this._onVideoFrame.bind(this));
  }

  startStallDetector() {
    this.stopStallDetector();
    this._stallFrameReceived = false;
    this._stallLastFrameTime = performance.now();
    try {
      this._stallRafId = this._videoEl.requestVideoFrameCallback(this._onVideoFrame.bind(this));
    } catch (e) {
      this._stallRafId = null;
    }
    var self = this;
    this._stallTimer = setInterval(function() {
      if (!self._videoEl.paused) {
        if (self._stallFrameReceived && performance.now() - self._stallLastFrameTime > 2000) {
          self.stopStallDetector();
          self._replayOverlay.style.display = 'flex';
          self._videoEl.controls = false;
        }
      }
    }, 1000);
  }

  stopStallDetector() {
    if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
    if (this._stallRafId !== null) {
      try { this._videoEl.cancelVideoFrameCallback(this._stallRafId); } catch (e) {}
      this._stallRafId = null;
    }
    this._stallLastFrameTime = 0;
    this._stallFrameReceived = false;
  }

  // ---- WebRTC ----

  async _tryWebRTC(notificationId) {
    if (!notificationId) {
      console.log(this._logPrefix, 'No notification ID, skipping WebRTC');
      return false;
    }

    var video = this._videoEl;
    var poster = this._posterEl;
    var self = this;

    try {
      console.log(this._logPrefix, 'Starting WebRTC for notification:', notificationId);

      var pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });
      this._currentPC = pc;

      var mediaStream = new MediaStream();
      video.srcObject = mediaStream;

      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      // Start playback immediately while user gesture is still active
      // (before first await - code before await runs synchronously in click handler context)
      video.play().catch(function(e) { console.log(self._logPrefix, 'Autoplay blocked:', e); });

      pc.ontrack = function(event) {
        console.log(self._logPrefix, 'Got track:', event.track.kind);
        mediaStream.addTrack(event.track);
        if (event.track.kind === 'video') {
          event.track.addEventListener('ended', function() {
            // Guard: if _currentPC was nulled or changed (replay/close), skip overlay
            if (self._currentPC !== pc) return;
            console.log(self._logPrefix, 'Video track ended');
            self._replayOverlay.style.display = 'flex';
            video.controls = false;
          });
        }
      };

      pc.oniceconnectionstatechange = function() {
        console.log(self._logPrefix, 'ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          self._statusFn('');
        } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          self._statusFn('Connection lost');
        }
      };

      video.onplaying = function() {
        video.classList.remove('loading');
        poster.style.display = 'none';
        self._statusFn('');
        self.startStallDetector();
      };

      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete
      await new Promise(function(resolve) {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          pc.onicegatheringstatechange = function() {
            if (pc.iceGatheringState === 'complete') resolve();
          };
          setTimeout(resolve, 5000);
        }
      });

      var signalingUrl = this._buildUrl('/brief/webrtc-signal');
      console.log(this._logPrefix, 'Sending offer to:', signalingUrl);

      var response = await fetch(signalingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notificationId: notificationId,
          offer: {
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp
          }
        })
      });

      if (!response.ok) {
        var errorText = await response.text();
        throw new Error('Signaling failed: ' + response.status + ' - ' + errorText);
      }

      var result = await response.json();
      if (!result.answer) {
        throw new Error('No answer in response');
      }

      console.log(this._logPrefix, 'Got answer, setting remote description');
      await pc.setRemoteDescription(new RTCSessionDescription(result.answer));

      return true;

    } catch (e) {
      console.error(this._logPrefix, 'WebRTC error:', e);
      this._statusFn('WebRTC failed, trying HTTP...');
      return false;
    }
  }

  // ---- HTTP Fallback ----

  _loadHttpVideo(notificationId) {
    var video = this._videoEl;
    var poster = this._posterEl;
    var self = this;

    try {
      var videoUrl = this._buildUrl('/brief/video', { id: notificationId });
      console.log(this._logPrefix, 'Loading HTTP video:', videoUrl);
      this._statusFn('Loading video...');

      video.srcObject = null;
      video.src = videoUrl;
      video.controls = true;
      video.onerror = function() { self.stopStallDetector(); self._statusFn('Failed to load video.'); };
      video.onloadeddata = function() { self._statusFn(''); };
      video.onplaying = function() {
        video.classList.remove('loading');
        poster.style.display = 'none';
        self._statusFn('');
        self.startStallDetector();
      };
      video.play().catch(function() {});
    } catch (e) {
      console.error(this._logPrefix, 'HTTP video error:', e);
      this._statusFn('Failed to load video: ' + e.message);
    }
  }

  // ---- Public API ----

  async openVideo(notificationId) {
    this.stopStallDetector();
    this._currentNotificationId = notificationId;

    var video = this._videoEl;
    var poster = this._posterEl;

    this._statusFn('Connecting...');

    // Reset video state
    video.srcObject = null;
    video.src = '';
    video.controls = true;
    video.muted = true;
    video.classList.add('loading');
    this._replayOverlay.style.display = 'none';

    // Show snapshot poster via URL (browser HTTP cache handles caching)
    var snapshotUrl = this._buildUrl('/brief/snapshot', { id: notificationId });
    poster.src = snapshotUrl;
    poster.style.display = 'block';

    // Clean up previous connection (null before close to prevent track ended race)
    if (this._currentPC) {
      var pc = this._currentPC;
      this._currentPC = null;
      pc.close();
    }

    // Try WebRTC first, fall back to HTTP
    var webrtcSuccess = await this._tryWebRTC(notificationId);
    if (!webrtcSuccess) {
      console.log(this._logPrefix, 'WebRTC failed, falling back to HTTP');
      this._loadHttpVideo(notificationId);
    }
  }

  async replay() {
    this.stopStallDetector();
    this._replayOverlay.style.display = 'none';
    this._videoEl.controls = true;

    if (this._currentPC) {
      var pc = this._currentPC;
      this._currentPC = null;
      try { pc.close(); } catch (e) { console.warn(this._logPrefix, 'Error closing peer connection:', e); }
    }

    if (this._currentNotificationId) {
      this._videoEl.classList.add('loading');
      this._statusFn('Connecting...');
      var ok = await this._tryWebRTC(this._currentNotificationId);
      if (!ok) {
        console.log(this._logPrefix, 'WebRTC replay failed, falling back to HTTP');
        this._loadHttpVideo(this._currentNotificationId);
      }
    } else {
      this._statusFn('Video URL not available for replay');
    }
  }

  close() {
    this.stopStallDetector();
    var video = this._videoEl;
    var poster = this._posterEl;

    video.pause();
    video.srcObject = null;
    video.src = '';
    video.controls = true;
    video.classList.remove('loading');
    poster.style.display = 'none';
    poster.src = '';
    this._replayOverlay.style.display = 'none';
    this._statusFn('');

    if (this._currentPC) {
      var pc = this._currentPC;
      this._currentPC = null;
      pc.close();
    }
  }

  destroy() {
    this.close();
    this._videoEl.removeEventListener('ended', this._onVideoEnded);
    document.removeEventListener('fullscreenchange', this._onFullscreenChange);
  }
}
