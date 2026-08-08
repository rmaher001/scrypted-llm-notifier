/**
 * Scrypted NVR Iframe Card for Home Assistant
 *
 * Renders an iframe whose `src` is built from a `url_template` config field
 * and the parent dashboard URL's `?camera=` and `?time=` query params.
 * Listens for HA frontend nav events so the iframe re-renders when the
 * parent URL changes (e.g. from a Daily Brief deep-link tap).
 *
 * Distributed in the same /brief/ha-card bundle as DailyBriefCard.
 */

(function () {
  'use strict';

  const CARD_VERSION = '0.3.108';

  // Returns the substituted URL string, or null if any referenced
  // placeholder has no value in `params`. A template with no
  // placeholders returns the template unchanged.
  function substituteUrlTemplate(template, params) {
    if (typeof template !== 'string' || !template) return null;
    // Fresh regex per call — module-level stateful /g regex is a trap
    // (lastIndex from one call leaks into the next).
    const scanRe = /\{(camera|time)\}/g;
    const referenced = new Set();
    let match;
    while ((match = scanRe.exec(template)) !== null) {
      referenced.add(match[1]);
    }
    for (const key of referenced) {
      const v = params[key];
      if (v === undefined || v === null || v === '') return null;
    }
    return template.replace(/\{(camera|time)\}/g, function (_, key) {
      return encodeURIComponent(params[key]);
    });
  }

  // Reads `camera` and `time` deep-link params from the parent dashboard
  // URL. HA's frontend sometimes routes query strings via location.search
  // and sometimes via the hash (e.g. '#/lovelace?camera=694'); read both,
  // prefer search. Returns nulls for missing keys.
  function readDeepLinkParams(searchStr, hashStr) {
    var out = { camera: null, time: null };
    function fill(qs) {
      try {
        var p = new URLSearchParams(qs);
        if (p.has('camera') && out.camera === null) out.camera = p.get('camera');
        if (p.has('time') && out.time === null) out.time = p.get('time');
      } catch (e) { /* ignore malformed */ }
    }
    if (typeof searchStr === 'string' && searchStr.length > 1) {
      fill(searchStr.charAt(0) === '?' ? searchStr.slice(1) : searchStr);
    }
    if (typeof hashStr === 'string' && hashStr.length > 0) {
      var qIdx = hashStr.indexOf('?');
      if (qIdx >= 0 && qIdx < hashStr.length - 1) {
        fill(hashStr.slice(qIdx + 1));
      }
    }
    return out;
  }

  class ScryptedNvrIframeCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._config = {};
      this._lastSrc = null;
      this._boundOnUrlChange = this._onUrlChange.bind(this);
    }

    setConfig(config) {
      if (!config || typeof config.url_template !== 'string' || !config.url_template) {
        throw new Error('scrypted-nvr-iframe-card: "url_template" config is required.');
      }
      var nextDefault = typeof config.default_url === 'string' ? config.default_url : '';
      // HA may call setConfig on every parent re-render. Bail early if
      // nothing changed — otherwise we'd destroy and recreate the iframe,
      // losing any in-progress NVR timeline navigation.
      if (this._config.url_template === config.url_template
          && this._config.default_url === nextDefault) {
        return;
      }
      this._config = {
        url_template: config.url_template,
        default_url: nextDefault,
      };
      this._render();
      this._updateSrc();
    }

    set hass(_hass) { /* no-op — card is purely URL-driven */ }

    connectedCallback() {
      window.addEventListener('popstate', this._boundOnUrlChange);
      window.addEventListener('hashchange', this._boundOnUrlChange);
      window.addEventListener('location-changed', this._boundOnUrlChange);
    }

    disconnectedCallback() {
      window.removeEventListener('popstate', this._boundOnUrlChange);
      window.removeEventListener('hashchange', this._boundOnUrlChange);
      window.removeEventListener('location-changed', this._boundOnUrlChange);
    }

    _onUrlChange() { this._updateSrc(); }

    _updateSrc() {
      var iframe = this.shadowRoot.querySelector('iframe');
      if (!iframe) return;
      var params = readDeepLinkParams(window.location.search, window.location.hash);
      var url = substituteUrlTemplate(this._config.url_template, params);
      if (!url) url = this._config.default_url;
      if (!url) {
        iframe.removeAttribute('src');
        return;
      }
      if (url === this._lastSrc) return;
      this._lastSrc = url;
      iframe.src = url;
    }

    _render() {
      // Height chain :host -> ha-card -> iframe all at 100% so the iframe
      // matches the actually-visible container area, not the full device
      // viewport. Earlier 100vh caused Scrypted's mobile bottom-nav to land
      // below the visible viewport (clipped by ha-card's overflow: hidden)
      // because HA's chrome eats ~50-80px from the top.
      //
      // History: v0.3.104 (padding-bottom: env(safe-area-inset-bottom))
      // pushed the nav UP — wrong direction. v0.3.106 (negative
      // margin-bottom on ha-card) was clipped by HA's parent chain.
      // v0.3.107 (position: absolute iframe with negative bottom) broke
      // Scrypted's mobile layout entirely. Reverted to v0.3.105 baseline:
      // accept the iOS home-indicator gap as Scrypted-side or HA-side.
      this.shadowRoot.innerHTML = ''
        + '<style>'
        +   ':host { display: block; height: 100%; }'
        +   'ha-card { height: 100%; overflow: hidden; border-radius: var(--ha-card-border-radius, 12px); padding: 0; }'
        +   'iframe { width: 100%; height: 100%; border: none; display: block;'
        +            'border-radius: var(--ha-card-border-radius, 12px); }'
        + '</style>'
        + '<ha-card><iframe allow="autoplay; fullscreen"></iframe></ha-card>';
    }

    getCardSize() { return 8; }

    static getStubConfig() {
      return {
        url_template: 'https://YOUR_SCRYPTED_HOST/endpoint/YOUR_TOKEN/@scrypted/nvr/public/#/timeline/{camera}?time={time}',
        default_url: '',
      };
    }
  }

  customElements.define('scrypted-nvr-iframe-card', ScryptedNvrIframeCard);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'scrypted-nvr-iframe-card',
    name: 'Scrypted NVR Iframe Card',
    description: 'Embeds Scrypted NVR timeline with deep-link support (camera + time from URL).',
    preview: false,
  });

  // Expose helpers for unit tests (loaded via Node vm).
  window.__scryptedNvrIframeCardHelpers = {
    substituteUrlTemplate: substituteUrlTemplate,
    readDeepLinkParams: readDeepLinkParams,
  };

  console.log('Scrypted NVR Iframe Card v' + CARD_VERSION + ' loaded');
})();
