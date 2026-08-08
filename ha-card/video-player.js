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
    // Normalized clip ref: { id } for a notification, or { cameraId, time,
    // posterUrl } for a Story (which has no notificationId).
    this._currentRef = null;

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

  // Build the query params that identify the clip for /brief/video and
  // /brief/snapshot — cameraId+time for a Story, else the notification id.
  _clipParams() {
    var r = this._currentRef || {};
    if (r.cameraId && r.time != null) return { cameraId: r.cameraId, time: r.time };
    return { id: r.id };
  }

  // Build the /brief/webrtc-signal POST body for the current clip ref.
  _signalBody(offer) {
    var r = this._currentRef || {};
    if (r.cameraId && r.time != null) {
      return { cameraId: r.cameraId, time: r.time, offer: offer };
    }
    return { notificationId: r.id, offer: offer };
  }

  _hasRef() {
    var r = this._currentRef || {};
    return !!(r.id || (r.cameraId && r.time != null));
  }

  async _tryWebRTC() {
    if (!this._hasRef()) {
      console.log(this._logPrefix, 'No clip ref, skipping WebRTC');
      return false;
    }

    var video = this._videoEl;
    var poster = this._posterEl;
    var self = this;

    try {
      console.log(this._logPrefix, 'Starting WebRTC for clip:', JSON.stringify(this._clipParams()));

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
        // Defer by two paint frames so the first video frame is on-screen
        // before we drop visibility — without this gap iOS shows its
        // loading-dim overlay between `playing` firing and first paint.
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            video.classList.remove('loading');
            poster.style.display = 'none';
            self._statusFn('');
            self.startStallDetector();
          });
        });
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
        body: JSON.stringify(this._signalBody({
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp
        }))
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

  _loadHttpVideo() {
    var video = this._videoEl;
    var poster = this._posterEl;
    var self = this;

    try {
      var videoUrl = this._buildUrl('/brief/video', this._clipParams());
      console.log(this._logPrefix, 'Loading HTTP video:', videoUrl);
      this._statusFn('Loading video...');

      video.srcObject = null;
      video.src = videoUrl;
      video.controls = false;
      video.onerror = function() { self.stopStallDetector(); self._statusFn('Failed to load video.'); };
      video.onloadeddata = function() { self._statusFn(''); };
      video.onplaying = function() {
        // Defer transition by two paint frames; see WebRTC path for rationale.
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            video.classList.remove('loading');
            poster.style.display = 'none';
            self._statusFn('');
            self.startStallDetector();
          });
        });
      };
      video.play().catch(function() {});
    } catch (e) {
      console.error(this._logPrefix, 'HTTP video error:', e);
      this._statusFn('Failed to load video: ' + e.message);
    }
  }

  // ---- Public API ----

  async openVideo(ref) {
    this.stopStallDetector();
    // ref: a notificationId string (back-compat for Events/Brief) OR a
    // descriptor { cameraId, time, posterUrl } for a Story (no notificationId).
    this._currentRef = (typeof ref === 'string') ? { id: ref } : (ref || {});
    this._currentNotificationId = this._currentRef.id || null;

    var video = this._videoEl;
    var poster = this._posterEl;

    this._statusFn('Connecting...');

    // Reset video state
    video.srcObject = null;
    video.src = '';
    video.controls = false;
    video.muted = true;
    video.classList.add('loading');
    this._replayOverlay.style.display = 'none';

    // Poster: an explicit posterUrl (Story hero) wins; else the notification
    // snapshot. Browser HTTP cache handles caching either way.
    var snapshotUrl = this._currentRef.posterUrl || this._buildUrl('/brief/snapshot', this._clipParams());
    poster.src = snapshotUrl;
    poster.style.display = 'block';

    // Clean up previous connection (null before close to prevent track ended race)
    if (this._currentPC) {
      var pc = this._currentPC;
      this._currentPC = null;
      pc.close();
    }

    // Try WebRTC first, fall back to HTTP
    var webrtcSuccess = await this._tryWebRTC();
    if (!webrtcSuccess) {
      console.log(this._logPrefix, 'WebRTC failed, falling back to HTTP');
      this._loadHttpVideo();
    }
  }

  async replay() {
    this.stopStallDetector();
    this._replayOverlay.style.display = 'none';
    this._videoEl.controls = false;

    if (this._currentPC) {
      var pc = this._currentPC;
      this._currentPC = null;
      try { pc.close(); } catch (e) { console.warn(this._logPrefix, 'Error closing peer connection:', e); }
    }

    if (this._hasRef()) {
      this._videoEl.classList.add('loading');
      this._statusFn('Connecting...');
      var ok = await this._tryWebRTC();
      if (!ok) {
        console.log(this._logPrefix, 'WebRTC replay failed, falling back to HTTP');
        this._loadHttpVideo();
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
    video.controls = false;
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
