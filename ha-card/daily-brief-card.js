/**
 * Daily Brief Card for Home Assistant
 * Thin iframe wrapper that loads the web UI from the Scrypted plugin endpoint.
 * All rendering (timeline, gallery, video, badges) is handled by the web UI.
 */

const CARD_VERSION = '0.3.43';

class DailyBriefCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._iframeOrigin = null;
    this._boundOnMessage = this._onMessage.bind(this);
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
  }

  disconnectedCallback() {
    window.removeEventListener('message', this._boundOnMessage);
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
  }

  _render() {
    // Validate and construct iframe URL safely
    var iframeUrl;
    try {
      iframeUrl = new URL(this._config.endpoint, window.location.origin);
      iframeUrl.pathname = iframeUrl.pathname.replace(/\/$/, '') + '/brief';
      iframeUrl.searchParams.set('scryptedToken', this._config.scrypted_token);
      iframeUrl.searchParams.set('v', CARD_VERSION);
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
