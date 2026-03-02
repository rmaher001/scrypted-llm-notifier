/**
 * Daily Brief Card for Home Assistant
 * Displays LLM-curated security camera highlights with video playback
 */

const CARD_VERSION = '0.3.12';

try {
  CSS.registerProperty({
    name: '--border-angle',
    syntax: '<angle>',
    initialValue: '0deg',
    inherits: false,
  });
} catch(e) {}

class DailyBriefCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._data = null;
    this._hass = null;
    this._player = null;
    try {
      const val = localStorage.getItem('briefSortOrder');
      this._sortOrder = (val === 'oldest' || val === 'newest') ? val : 'newest';
    } catch (e) {
      this._sortOrder = 'newest';
    }
  }

  set hass(hass) {
    this._hass = hass;
    // Could use hass to read from an entity instead of fetching JSON
  }

  setConfig(config) {
    if (!config.endpoint) {
      throw new Error('Please set the "endpoint" config option to your Scrypted LLM Notifier endpoint URL');
    }
    if (!config.scrypted_token) {
      throw new Error('Please set the "scrypted_token" config option for authentication');
    }
    this._config = { endpoint: config.endpoint, scrypted_token: config.scrypted_token };
    this._loadData();
  }

  _buildUrl(path, params) {
    const url = new URL(this._config.endpoint, window.location.origin);
    url.pathname = url.pathname.replace(/\/$/, '') + path;
    url.searchParams.set('scryptedToken', this._config.scrypted_token);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  async _loadData(options = {}) {
    // Server handles date/timezone - we just request the data
    // options: { mode?: 'incremental' | 'full', refresh?: boolean }
    const params = {};
    if (options.mode) params.mode = options.mode;
    else if (options.refresh) params.refresh = 'true';
    const url = this._buildUrl('/brief/ha-card', Object.keys(params).length ? params : undefined);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const text = await response.text();
      try {
        this._data = JSON.parse(text);
      } catch (parseErr) {
        throw new Error(`Invalid JSON: ${text.substring(0, 100)}`);
      }
      this._render();
    } catch (e) {
      console.error('Daily Brief: Failed to load data', e);
      this._renderError(`${e.message} (URL: ${url})`);
    }
  }

  _render() {
    if (!this._data) return;

    // Destroy previous player if any
    if (this._player) {
      this._player.destroy();
      this._player = null;
    }

    // Build index → highlight map for narrative linking
    const highlightByIndex = new Map();
    (this._data.highlights || []).forEach(h => {
      if (h.index !== undefined) highlightByIndex.set(h.index, h);
    });

    // Check if we have narrative data
    const hasNarrative = this._data.narrative && this._data.narrative.length > 0;

    // Apply sort order: reverse arrays for display if 'newest' first
    const narrativeSegments = hasNarrative
      ? (this._sortOrder === 'newest' ? [...this._data.narrative].reverse() : this._data.narrative)
      : [];
    const sortedHighlights = this._sortOrder === 'newest'
      ? [...(this._data.highlights || [])].reverse()
      : (this._data.highlights || []);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--primary-font-family, 'Roboto', sans-serif);
        }
        .card {
          background: var(--ha-card-background, var(--card-background-color, white));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.1));
          padding: 16px;
          color: var(--primary-text-color);
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }
        .title {
          font-size: 1.5em;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .date {
          font-size: 0.9em;
          color: var(--secondary-text-color);
        }
        .header-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .version {
          font-size: 0.65em;
          color: var(--secondary-text-color);
          opacity: 0.5;
        }
        .action-btn {
          background: var(--primary-color, #03a9f4);
          border: none;
          cursor: pointer;
          padding: 6px 12px;
          border-radius: 4px;
          color: var(--text-primary-color, #fff);
          font-size: 0.8em;
          font-weight: 500;
          transition: opacity 0.2s, background 0.2s;
        }
        .action-btn:hover {
          opacity: 0.9;
        }
        .action-btn.secondary {
          background: var(--secondary-background-color, #444);
          color: var(--primary-text-color, #fff);
        }
        .action-btn.loading {
          opacity: 0.6;
          cursor: wait;
        }
        .sort-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px;
          color: var(--secondary-text-color);
          opacity: 0.7;
          transition: opacity 0.2s;
        }
        .sort-btn:hover {
          opacity: 1;
        }
        .sort-btn svg {
          width: 18px;
          height: 18px;
          fill: none;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .sort-btn .sort-oldest-icon { display: none; }
        [data-sort="oldest"] .sort-btn .sort-newest-icon { display: none; }
        [data-sort="oldest"] .sort-btn .sort-oldest-icon { display: block; }
        .refresh-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px;
          color: var(--secondary-text-color);
          opacity: 0.7;
          transition: opacity 0.2s;
        }
        .refresh-btn:hover {
          opacity: 1;
        }
        .refresh-btn svg {
          width: 18px;
          height: 18px;
          fill: none;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .refresh-btn.loading svg {
          animation: spin 1s linear infinite;
        }
        .refresh-btn.loading {
          pointer-events: none;
          opacity: 0.5;
        }
        .catchup-bar {
          text-align: center;
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
        }
        .catchup-btn {
          background:
            linear-gradient(
              var(--card-background-color, var(--secondary-background-color, #121212)),
              var(--card-background-color, var(--secondary-background-color, #121212))
            ) padding-box,
            conic-gradient(from var(--border-angle), #7c4dff, #00bcd4, #e040fb, #7c4dff) border-box;
          border: 2px solid transparent;
          cursor: pointer;
          padding: 8px 20px;
          border-radius: 20px;
          color: var(--text-primary-color, #fff);
          font-size: 0.85em;
          font-weight: 500;
          letter-spacing: 0.5px;
          transition: filter 0.3s;
          animation: rotate-border 4s linear infinite;
        }
        .catchup-btn:hover {
          filter: drop-shadow(0 0 8px rgba(124, 77, 255, 0.5));
        }
        .catchup-btn.loading {
          opacity: 0.5;
          pointer-events: none;
          animation-name: none;
        }
        .catchup-btn.loading::after {
          content: '';
          display: inline-block;
          width: 14px;
          height: 14px;
          margin-left: 8px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
          vertical-align: middle;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes rotate-border {
          to { --border-angle: 360deg; }
        }
        .summary {
          background: var(--secondary-background-color, #f5f5f5);
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 16px;
          line-height: 1.5;
        }
        .section-title {
          font-size: 0.85em;
          font-weight: 600;
          letter-spacing: 1px;
          text-transform: uppercase;
          margin-bottom: 12px;
          padding: 12px 16px;
          margin-left: -16px;
          margin-right: -16px;
          color: var(--primary-text-color);
          opacity: 0.8;
          background: #262626;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .section-meta {
          font-weight: 400;
          letter-spacing: 0.5px;
          text-transform: lowercase;
        }
        .highlights-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          gap: 12px;
        }
        .highlight-item {
          cursor: pointer;
          border-radius: 8px;
          overflow: hidden;
          background: var(--secondary-background-color);
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .highlight-item:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }
        .highlight-thumb {
          width: 100%;
          aspect-ratio: 16/9;
          object-fit: cover;
          display: block;
          background: var(--secondary-background-color, #333);
          border-radius: 8px 8px 0 0;
        }
        .highlight-thumb.no-thumb {
          background: linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 100%);
        }
        .highlight-info {
          padding: 8px;
        }
        .highlight-title {
          font-weight: 500;
          font-size: 0.9em;
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .highlight-body {
          font-size: 0.8em;
          color: var(--primary-text-color);
          margin-bottom: 6px;
          line-height: 1.3;
        }
        .highlight-meta {
          display: flex;
          justify-content: space-between;
          font-size: 0.75em;
          color: var(--secondary-text-color);
        }
        .highlight-time {
          color: var(--secondary-text-color);
        }
        .highlight-camera {
          color: var(--secondary-text-color);
        }

        /* Timeline styles */
        .timeline-segment {
          margin-bottom: 24px;
        }
        .timeline-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }
        .timeline-line {
          flex: 1;
          height: 1px;
          background: rgba(255,255,255,0.1);
        }
        .timeline-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 1.5px;
          text-transform: uppercase;
          color: var(--primary-text-color);
          opacity: 0.5;
        }
        .timeline-text {
          font-size: 15px;
          line-height: 1.6;
          color: var(--primary-text-color);
          margin-bottom: 16px;
        }
        .timeline-snapshots {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          gap: 12px;
          padding-bottom: 8px;
        }

        /* Modal styles */
        .modal-overlay {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0,0,0,0.8);
          z-index: 1000;
          justify-content: center;
          align-items: center;
        }
        .modal-overlay.active {
          display: flex;
        }
        .modal-content {
          background: #1a1a1a;
          color: #fff;
          border-radius: 12px;
          max-width: 90vw;
          max-height: 90vh;
          overflow: hidden;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .modal-title {
          font-weight: 500;
        }
        .modal-close {
          background: none;
          border: none;
          font-size: 1.5em;
          cursor: pointer;
          color: #fff;
          padding: 4px 8px;
        }
        .modal-close:hover {
          opacity: 0.7;
        }
        .modal-media-container {
          position: relative;
          width: 800px;
          max-width: 90vw;
          aspect-ratio: 16/9;
          background: #000;
          border-radius: 8px;
          overflow: hidden;
        }
        .modal-video {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: #000;
        }
        .modal-video.loading {
          visibility: hidden;
        }
        .modal-poster {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: #000;
        }
        .modal-info {
          padding: 12px 16px;
          text-align: center;
        }
        .modal-caption-title {
          font-size: 1em;
          font-weight: 500;
          color: #fff;
        }
        .modal-caption-body {
          font-size: 0.9em;
          color: rgba(255,255,255,0.9);
          margin-top: 4px;
        }
        .modal-time {
          font-size: 0.85em;
          color: rgba(255,255,255,0.6);
          margin-top: 4px;
        }
        .modal-status {
          font-size: 0.85em;
          color: rgba(255,255,255,0.6);
          margin-top: 4px;
        }
        .replay-overlay {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.5);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 10;
          cursor: pointer;
        }
        .replay-btn {
          background: rgba(255,255,255,0.15);
          border: 2px solid rgba(255,255,255,0.6);
          border-radius: 50%;
          width: 64px;
          height: 64px;
          font-size: 32px;
          color: #fff;
          cursor: pointer;
          display: flex;
          justify-content: center;
          align-items: center;
          transition: background 0.2s, transform 0.2s;
        }
        .replay-btn:hover {
          background: rgba(255,255,255,0.25);
          transform: scale(1.1);
        }
        .event-count {
          font-size: 0.85em;
          color: var(--secondary-text-color);
          margin-top: 16px;
          text-align: center;
        }
        .tab-bar {
          display: flex;
          gap: 0;
          margin-bottom: 16px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .tab {
          background: none;
          border: none;
          padding: 8px 16px;
          cursor: pointer;
          color: var(--secondary-text-color);
          font-size: 0.9em;
          font-weight: 500;
          border-bottom: 2px solid transparent;
          transition: color 0.2s, border-color 0.2s;
        }
        .tab.active {
          color: var(--primary-text-color);
          border-bottom-color: var(--primary-color, #03a9f4);
        }
        .tab:hover {
          color: var(--primary-text-color);
        }
        .gallery-container {
          --bg-secondary: var(--secondary-background-color, #1a1a2e);
          --text-primary: var(--primary-text-color, #e0e0e0);
          --text-secondary: var(--secondary-text-color, #888);
          --accent: var(--primary-color, #03a9f4);
        }
        ${Gallery.CSS}
      </style>

      <div class="card" data-sort="${this._sortOrder}">
        <div class="header">
          <div>
            <div class="title">Daily Brief</div>
            <div class="date">${this._data.dateFormatted}</div>
          </div>
          <div class="header-actions">
            <span class="version">v${CARD_VERSION}</span>
            <button class="sort-btn" title="Toggle sort order">
              <svg class="sort-newest-icon" viewBox="0 0 24 24"><path d="M3 4h13M3 8h9M3 12h5"/><path d="M19 4v16M19 20l-3-3M19 20l3-3"/></svg>
              <svg class="sort-oldest-icon" viewBox="0 0 24 24"><path d="M3 4h5M3 8h9M3 12h13"/><path d="M19 4v16M19 4l-3 3M19 4l3 3"/></svg>
            </button>
            <button class="refresh-btn" title="Full regeneration (slow)">
              <svg viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
          </div>
        </div>

        <div class="tab-bar">
          <button class="tab active" data-tab="brief">Brief</button>
          <button class="tab" data-tab="gallery">Gallery</button>
        </div>

        <div class="tab-content" data-tab-content="brief">
        <div class="summary">
          ${this._data.overview || this._data.summary}
        </div>

        <div class="catchup-bar">
          <button class="catchup-btn">Catch Me Up</button>
        </div>

        ${hasNarrative ? `
          ${narrativeSegments.map(segment => `
            <div class="timeline-segment">
              <div class="timeline-header">
                <span class="timeline-line"></span>
                <span class="timeline-label">${this._escapeHtml(segment.timeRange)}</span>
                <span class="timeline-line"></span>
              </div>
              <p class="timeline-text">${this._escapeHtml(segment.text)}</p>
              ${(() => {
                const validHighlights = (segment.highlightIds || [])
                  .map(idx => highlightByIndex.get(idx))
                  .filter(h => h);
                if (validHighlights.length === 0) return '';
                return `
                  <div class="timeline-snapshots">
                    ${validHighlights.map(h => `
                      <div class="highlight-item" data-id="${this._escapeHtml(h.id)}" data-clip="${this._escapeHtml(h.clip || '')}" data-title="${this._escapeHtml(h.title)}" data-body="${this._escapeHtml(h.body)}" data-date="${h.date || ''}" data-time="${h.time}" data-camera="${this._escapeHtml(h.cameraName)}" data-thumbnail="${h.thumbnail || ''}">
                        ${h.thumbnail ? `<img class="highlight-thumb" src="${this._buildUrl('/brief/snapshot', { id: h.id })}" alt="${this._escapeHtml(h.title)}" loading="lazy">` : '<div class="highlight-thumb no-thumb"></div>'}
                        <div class="highlight-info">
                          <div class="highlight-title">${this._escapeHtml(h.title)}</div>
                          <div class="highlight-meta">
                            <span class="highlight-time">${h.time}</span>
                          </div>
                        </div>
                      </div>
                    `).join('')}
                  </div>
                `;
              })()}
            </div>
          `).join('')}
        ` : `
          <div class="section-title">Highlights</div>
          <div class="highlights-grid">
            ${sortedHighlights.map(h => `
              <div class="highlight-item" data-id="${this._escapeHtml(h.id)}" data-clip="${this._escapeHtml(h.clip)}" data-title="${this._escapeHtml(h.title)}" data-body="${this._escapeHtml(h.body)}" data-date="${h.date || ''}" data-time="${h.time}" data-camera="${this._escapeHtml(h.cameraName)}" data-thumbnail="${h.thumbnail || ''}">
                ${h.thumbnail ? `<img class="highlight-thumb" src="${this._buildUrl('/brief/snapshot', { id: h.id })}" alt="${this._escapeHtml(h.title)}" loading="lazy">` : '<div class="highlight-thumb no-thumb"></div>'}
                <div class="highlight-info">
                  <div class="highlight-title">${this._escapeHtml(h.title)}</div>
                  <div class="highlight-body">${this._escapeHtml(h.body)}</div>
                  <div class="highlight-meta">
                    <span class="highlight-time">${h.date ? `${h.date}, ` : ''}${h.time}</span>
                    <span class="highlight-camera">${this._escapeHtml(h.cameraName)}</span>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        `}


        <div class="event-count">${this._data.eventCount} total events today</div>
        </div>

        <div class="tab-content" data-tab-content="gallery" style="display:none">
          <div class="gallery-container"></div>
        </div>
      </div>

      <div class="modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <span class="modal-title"></span>
            <button class="modal-close">&times;</button>
          </div>
          <div class="modal-media-container">
            <img class="modal-poster" style="display:none;">
            <video class="modal-video" controls></video>
            <div class="replay-overlay" style="display:none;">
              <button class="replay-btn">\u21BB</button>
            </div>
          </div>
          <div class="modal-info">
            <div class="modal-caption-title"></div>
            <div class="modal-caption-body"></div>
            <div class="modal-time"></div>
            <div class="modal-status"></div>
          </div>
        </div>
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const items = this.shadowRoot.querySelectorAll('.highlight-item');
    const modal = this.shadowRoot.querySelector('.modal-overlay');
    const video = this.shadowRoot.querySelector('.modal-video');
    const poster = this.shadowRoot.querySelector('.modal-poster');
    const closeBtn = this.shadowRoot.querySelector('.modal-close');
    const modalCaptionTitle = this.shadowRoot.querySelector('.modal-caption-title');
    const modalCaptionBody = this.shadowRoot.querySelector('.modal-caption-body');
    const modalTime = this.shadowRoot.querySelector('.modal-time');
    const modalStatus = this.shadowRoot.querySelector('.modal-status');
    const refreshBtn = this.shadowRoot.querySelector('.refresh-btn');
    const catchupBtn = this.shadowRoot.querySelector('.catchup-btn');
    const sortBtn = this.shadowRoot.querySelector('.sort-btn');
    const replayOverlay = this.shadowRoot.querySelector('.replay-overlay');
    const self = this;

    // Create shared VideoPlayer instance
    this._player = new VideoPlayer({
      videoEl: video,
      posterEl: poster,
      replayOverlay: replayOverlay,
      statusFn: function(msg) { modalStatus.textContent = msg || ''; },
      buildUrl: function(path, params) { return self._buildUrl(path, params); },
      logPrefix: '[Daily Brief]'
    });

    // Tab switching
    const tabs = this.shadowRoot.querySelectorAll('.tab');
    const tabContents = this.shadowRoot.querySelectorAll('.tab-content');
    let galleryInitialized = false;
    let gallery = null;

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.style.display = 'none');
        tab.classList.add('active');
        const target = tab.dataset.tab;
        const targetEl = self.shadowRoot.querySelector(`[data-tab-content="${target}"]`);
        if (targetEl) targetEl.style.display = '';

        // Lazy-init gallery on first switch
        if (target === 'gallery' && !galleryInitialized) {
          galleryInitialized = true;
          const containerEl = self.shadowRoot.querySelector('.gallery-container');
          gallery = new Gallery({
            containerEl: containerEl,
            player: self._player,
            buildUrl: function(path, params) { return self._buildUrl(path, params); },
            formatTime: function(ts) {
              return new Date(ts).toLocaleString('en-US', {
                month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit', hour12: true
              });
            },
            onCardClick: function(id, title, body, time) {
              modalCaptionTitle.textContent = title;
              modalCaptionBody.textContent = body;
              modalTime.textContent = time;
              modal.classList.add('active');
              self._player.openVideo(id);
            }
          });
          gallery.init();
        }
      });
    });

    // Sort toggle button
    sortBtn?.addEventListener('click', () => {
      self._sortOrder = self._sortOrder === 'newest' ? 'oldest' : 'newest';
      try { localStorage.setItem('briefSortOrder', self._sortOrder); } catch (e) {}
      self._render();
    });

    // Catch me up button - incremental refresh
    catchupBtn?.addEventListener('click', async () => {
      catchupBtn.classList.add('loading');
      catchupBtn.textContent = 'Updating';
      await self._loadData({ mode: 'incremental' });
      catchupBtn.textContent = 'Catch Me Up';
      catchupBtn.classList.remove('loading');
    });

    // Refresh button - full regeneration
    refreshBtn?.addEventListener('click', async () => {
      refreshBtn.classList.add('loading');
      await self._loadData({ mode: 'full' });
      refreshBtn.classList.remove('loading');
    });

    items.forEach(item => {
      item.addEventListener('click', async () => {
        const notificationId = item.dataset.id;
        const title = item.dataset.title;
        const body = item.dataset.body;
        const date = item.dataset.date;
        const time = item.dataset.time;
        const camera = item.dataset.camera;

        modalCaptionTitle.textContent = title;
        modalCaptionBody.textContent = body;
        modalTime.textContent = `${date ? `${date}, ` : ''}${time} - ${camera}`;
        modal.classList.add('active');

        await self._player.openVideo(notificationId);
      });
    });

    // Replay click handler
    replayOverlay.addEventListener('click', async () => {
      await self._player.replay();
    });

    closeBtn.addEventListener('click', () => {
      self._player.close();
      modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        self._player.close();
        modal.classList.remove('active');
      }
    });
  }

  _renderError(message) {
    this.shadowRoot.innerHTML = `
      <style>
        .card {
          background: var(--ha-card-background, white);
          border-radius: 12px;
          padding: 16px;
          text-align: center;
          color: var(--error-color, #db4437);
        }
      </style>
      <div class="card">
        <p>Failed to load Daily Brief</p>
        <p style="font-size: 0.9em; color: var(--secondary-text-color);">${message}</p>
      </div>
    `;
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  _isSafeUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'data:';
    } catch {
      return false;
    }
  }

  getCardSize() {
    return 4;
  }

  static getConfigElement() {
    return document.createElement('daily-brief-card-editor');
  }

  static getStubConfig() {
    return {
      endpoint: '/api/scrypted/YOUR_SCRYPTED_TOKEN/endpoint/@rmaher001/scrypted-llm-notifier',
      scrypted_token: 'YOUR_SCRYPTED_TOKEN'
    };
  }
}

// Register the card
customElements.define('daily-brief-card', DailyBriefCard);

// Register with Home Assistant's custom card registry
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'daily-brief-card',
  name: 'Daily Brief Card',
  description: 'Displays LLM-curated security camera highlights with video playback',
  preview: true
});

console.log(`Daily Brief Card v${CARD_VERSION} loaded`);
