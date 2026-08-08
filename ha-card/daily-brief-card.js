/**
 * Daily Brief Card for Home Assistant
 * Thin iframe wrapper that loads the web UI from the Scrypted plugin endpoint.
 * All rendering (timeline, gallery, video, badges) is handled by the web UI.
 */

const CARD_VERSION = '0.3.187';

class DailyBriefCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._iframeOrigin = null;
    this._boundOnMessage = this._onMessage.bind(this);
    this._lastDeepLinkId = null;
    this._lastDeepLinkGroupId = null;
  }

  set hass(hass) {
    // No-op: iframe handles its own data fetching
  }

  setConfig(config) {
    if (!config.endpoint) {
      throw new Error('Please set the "endpoint" config option to your Scrypted LLM Notifier endpoint URL');
    }
    if (!config.scrypted_token) {
      throw new Error('Please set the "scrypted_token" config option for authentication');
    }
    // Skip re-render if config hasn't changed (HA may call setConfig multiple times)
    if (this._config.endpoint === config.endpoint && this._config.scrypted_token === config.scrypted_token) return;
    this._config = { endpoint: config.endpoint, scrypted_token: config.scrypted_token };
    // Derive and store expected iframe origin for postMessage validation
    try {
      this._iframeOrigin = new URL(this._config.endpoint, window.location.origin).origin;
    } catch (e) {
      this._iframeOrigin = window.location.origin;
    }
    this._render();
  }

  connectedCallback() {
    window.addEventListener('message', this._boundOnMessage);
    // HA may navigate the dashboard URL (notification tap → ?groupId=)
    // without re-instantiating the card, so re-render the iframe when the
    // URL changes to pick up the new deep-link params.
    this._boundOnUrlChange = this._onUrlChange.bind(this);
    window.addEventListener('popstate', this._boundOnUrlChange);
    window.addEventListener('hashchange', this._boundOnUrlChange);
    window.addEventListener('location-changed', this._boundOnUrlChange);
  }

  disconnectedCallback() {
    window.removeEventListener('message', this._boundOnMessage);
    if (this._boundOnUrlChange) {
      window.removeEventListener('popstate', this._boundOnUrlChange);
      window.removeEventListener('hashchange', this._boundOnUrlChange);
      window.removeEventListener('location-changed', this._boundOnUrlChange);
    }
  }

  _onUrlChange() {
    if (!this._config || !this._config.endpoint) return;
    // Only re-render if our deep-link params actually changed; HA fires
    // popstate / location-changed on every internal nav, and we don't want
    // to thrash the iframe.
    var p = this._readDeepLinkParams();
    if (p.id === this._lastDeepLinkId && p.groupId === this._lastDeepLinkGroupId) return;
    this._lastDeepLinkId = p.id;
    this._lastDeepLinkGroupId = p.groupId;
    this._render();
  }

  _onMessage(event) {
    // Validate origin matches the expected iframe source
    if (this._iframeOrigin && event.origin !== this._iframeOrigin) return;
    const iframe = this.shadowRoot.querySelector('iframe');
    if (!iframe) return;

    // Ignore resize messages — iframe uses fixed viewport height for internal scrolling
    // This enables sticky headers and avoids double scrollbars in Panel view

    if (event.data && event.data.type === 'daily-brief-modal') {
      if (event.data.state === 'open') {
        this._modalOpen = true;
        // Send viewport geometry to iframe so it can position the modal
        var rect = iframe.getBoundingClientRect();
        iframe.contentWindow.postMessage({
          type: 'daily-brief-viewport',
          viewportHeight: window.innerHeight,
          iframeTop: rect.top
        }, this._iframeOrigin);
      } else {
        this._modalOpen = false;
      }
    }

    // NVR timeline open. kind:'cloud' (default for back-compat) ->
    // window.open with named target so Mac reuses the same browser tab
    // (iOS still spawns a new tab — OS-level constraint we accept).
    // kind:'ha' -> in-app HA navigation via history.pushState +
    // 'location-changed' event; same-origin so iOS HA Companion stays
    // in-app and the named target / new-tab issue doesn't apply.
    if (event.data && event.data.type === 'daily-brief-open-nvr' && typeof event.data.url === 'string') {
      var url = event.data.url;
      var kind = event.data.kind || 'cloud';
      if (kind === 'ha') {
        // pushState throws SecurityError if `url` is cross-origin to the
        // current document. The HA-route URL should always be a same-origin
        // path (e.g. /scrypted?camera=...) but if the iframe ever sends an
        // absolute URL with a different origin, fall back to window.open
        // so the user still gets to the URL rather than failing silently.
        try {
          window.history.pushState(null, '', url);
          window.dispatchEvent(new Event('location-changed'));
        } catch (e) {
          try { window.open(url, 'scrypted-nvr'); } catch (e2) { /* popup blocked */ }
        }
      } else {
        try { window.open(url, 'scrypted-nvr'); } catch (e) { /* popup blocked */ }
      }
    }
  }

  _readDeepLinkParams() {
    // HA's frontend routes by path and may emit query params either on
    // location.search or on location.hash (e.g., '#/lovelace?groupId=x').
    // Read both, prefer search, fall back to hash. Best-effort.
    var ids = { id: null, groupId: null };
    try {
      var s = new URLSearchParams(window.location.search);
      ids.id = s.get('id');
      ids.groupId = s.get('groupId');
      if (!ids.id && !ids.groupId && window.location.hash) {
        var h = window.location.hash.indexOf('?');
        if (h >= 0) {
          var hs = new URLSearchParams(window.location.hash.slice(h + 1));
          ids.id = hs.get('id');
          ids.groupId = hs.get('groupId');
        }
      }
    } catch (e) { /* best-effort */ }
    return ids;
  }

  _render() {
    // Validate and construct iframe URL safely
    var iframeUrl;
    try {
      iframeUrl = new URL(this._config.endpoint, window.location.origin);
      iframeUrl.pathname = iframeUrl.pathname.replace(/\/$/, '') + '/brief';
      iframeUrl.searchParams.set('scryptedToken', this._config.scrypted_token);
      iframeUrl.searchParams.set('v', CARD_VERSION);
      var deepLink = this._readDeepLinkParams();
      if (deepLink.id) iframeUrl.searchParams.set('id', deepLink.id);
      if (deepLink.groupId) iframeUrl.searchParams.set('groupId', deepLink.groupId);
      this._lastDeepLinkId = deepLink.id;
      this._lastDeepLinkGroupId = deepLink.groupId;
      try {
        var logUrl = new URL(iframeUrl.toString());
        logUrl.searchParams.set('scryptedToken', '[redacted]');
        console.log('[daily-brief-card] iframe URL:', logUrl.toString(),
          'parent search:', window.location.search, 'hash:', window.location.hash);
      } catch (e) { /* logging is best-effort */ }
    } catch (e) {
      this._renderError('Invalid endpoint URL: ' + this._config.endpoint);
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          overflow: hidden;
          border-radius: var(--ha-card-border-radius, 12px);
          padding: 0;
        }
        iframe {
          width: 100%;
          height: 100vh;
          border: none;
          display: block;
          border-radius: var(--ha-card-border-radius, 12px);
        }
      </style>
      <ha-card>
        <iframe src="${iframeUrl.toString()}" allow="autoplay; fullscreen"></iframe>
      </ha-card>
    `;
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
        <p class="error-detail" style="font-size: 0.9em; color: var(--secondary-text-color);"></p>
      </div>
    `;
    // Use textContent to avoid XSS
    this.shadowRoot.querySelector('.error-detail').textContent = message;
  }

  getCardSize() {
    return 8;
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
