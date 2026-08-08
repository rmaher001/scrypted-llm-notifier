/**
 * LLM Health tab — renders per-provider reliability/latency/quality aggregates.
 * Plain class, same pattern as Gallery.
 */

// eslint-disable-next-line no-unused-vars
class LlmHealth {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.containerEl
   * @param {function(string, Object=): string} options.buildUrl
   */
  constructor(options) {
    this._containerEl = options.containerEl;
    this._buildUrl = options.buildUrl;
    this._window = '24h';
    this._data = null;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    this._renderShell();
    await this._load();
  }

  async refresh() {
    await this._load();
  }

  _renderShell() {
    this._containerEl.innerHTML = [
      '<div class="llm-health-root">',
      '  <div class="llm-health-controls">',
      '    <button type="button" data-window="15m" class="llm-health-tab-btn">Last 15 min</button>',
      '    <button type="button" data-window="1h" class="llm-health-tab-btn">Last 1h</button>',
      '    <button type="button" data-window="24h" class="llm-health-tab-btn active">Last 24h</button>',
      '    <button type="button" data-window="7d" class="llm-health-tab-btn">Last 7 days</button>',
      '    <button type="button" class="llm-health-refresh" title="Refresh">↻</button>',
      '    <span class="llm-health-generated"></span>',
      '  </div>',
      '  <div class="llm-health-body"><div class="llm-health-loading">Loading…</div></div>',
      '</div>',
      '<style>',
      '.llm-health-root { font-size: 14px; }',
      '.llm-health-controls { display:flex; align-items:center; gap:8px; padding:8px 12px; flex-wrap:wrap; border-bottom:1px solid var(--border-color, #333); position:sticky; top:0; background:var(--bg-primary, #111); z-index:5; }',
      '.llm-health-tab-btn { background:transparent; color:var(--fg-primary, #eee); border:1px solid var(--border-color, #333); border-radius:4px; padding:4px 10px; cursor:pointer; }',
      '.llm-health-tab-btn.active { background:var(--accent, #2563eb); color:#fff; border-color:var(--accent, #2563eb); }',
      '.llm-health-refresh { background:transparent; color:var(--fg-primary, #eee); border:1px solid var(--border-color, #333); border-radius:4px; padding:2px 8px; cursor:pointer; margin-left:auto; }',
      '.llm-health-generated { font-size:11px; color:var(--fg-muted, #888); }',
      '.llm-health-body { padding:12px; display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:12px; }',
      '.llm-health-empty { grid-column:1/-1; text-align:center; color:var(--fg-muted, #888); padding:24px 0; }',
      '.llm-health-loading { grid-column:1/-1; text-align:center; color:var(--fg-muted, #888); padding:24px 0; }',
      '.llm-health-card { border:1px solid var(--border-color, #333); border-radius:6px; padding:12px; background:var(--bg-secondary, #1c1c1c); }',
      '.llm-health-card h3 { margin:0 0 4px; font-size:15px; }',
      '.llm-health-card .role { font-size:11px; color:var(--fg-muted, #888); text-transform:uppercase; letter-spacing:.04em; }',
      '.llm-health-card .count { font-size:11px; color:var(--fg-muted, #888); margin-top:2px; }',
      '.llm-health-grid { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; margin-top:10px; }',
      '.llm-health-grid dt { color:var(--fg-muted, #aaa); font-size:12px; }',
      '.llm-health-grid dd { margin:0; font-size:13px; font-variant-numeric:tabular-nums; }',
      '.llm-health-grid dd.good { color:#3fb950; }',
      '.llm-health-grid dd.warn { color:#d29922; }',
      '.llm-health-grid dd.bad { color:#f85149; }',
      '.llm-health-section { margin-top:10px; padding-top:10px; border-top:1px solid var(--border-color, #333); }',
      '.llm-health-section-title { font-size:11px; color:var(--fg-muted, #888); text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }',
      '</style>',
    ].join('');

    this._bodyEl = this._containerEl.querySelector('.llm-health-body');
    this._generatedEl = this._containerEl.querySelector('.llm-health-generated');

    var self = this;
    var btns = this._containerEl.querySelectorAll('.llm-health-tab-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        self._window = btn.getAttribute('data-window');
        btns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        self._render();
      });
    });
    this._containerEl.querySelector('.llm-health-refresh').addEventListener('click', function () {
      self._load();
    });
  }

  async _load() {
    try {
      this._bodyEl.innerHTML = '<div class="llm-health-loading">Loading…</div>';
      var res = await fetch(this._buildUrl('/brief/llm-health'), { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this._data = await res.json();
      this._render();
    } catch (err) {
      this._bodyEl.innerHTML = '<div class="llm-health-empty">Failed to load: ' + (err && err.message ? err.message : err) + '</div>';
    }
  }

  _render() {
    if (!this._data) return;
    var w = this._data.windows && this._data.windows[this._window];
    if (!w || !w.providers || w.providers.length === 0) {
      this._bodyEl.innerHTML = '<div class="llm-health-empty">No LLM calls recorded in this window.</div>';
    } else {
      var sorted = w.providers.slice().sort(function (a, b) {
        if (a.role !== b.role) return a.role < b.role ? -1 : 1;
        return (b.count || 0) - (a.count || 0);
      });
      this._bodyEl.innerHTML = sorted.map(this._renderCard).join('');
    }
    if (this._data.generatedAt) {
      this._generatedEl.textContent = 'Updated ' + new Date(this._data.generatedAt).toLocaleTimeString();
    }
  }

  _renderCard(p) {
    function pct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }
    function ms(x) { return x == null || x === 0 ? '—' : Math.round(x) + ' ms'; }
    function num(x, d) { return x == null ? '—' : x.toFixed(d == null ? 2 : d); }
    function reliabilityClass(ok) { return ok == null ? '' : ok >= 0.98 ? 'good' : ok >= 0.9 ? 'warn' : 'bad'; }
    function latencyClass(p95) { return p95 == null ? '' : p95 <= 5000 ? 'good' : p95 <= 15000 ? 'warn' : 'bad'; }
    function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }

    var qualitySection = '';
    if (p.meanClarity != null || p.meanFaceRef != null || p.meanDescLen != null) {
      qualitySection = [
        '<div class="llm-health-section">',
        '  <div class="llm-health-section-title">Self-reported quality</div>',
        '  <dl class="llm-health-grid">',
        p.meanClarity != null ? '    <dt>Clarity</dt><dd>' + num(p.meanClarity, 2) + ' / 10</dd>' : '',
        p.meanFaceRef != null ? '    <dt>Face ref</dt><dd>' + num(p.meanFaceRef, 2) + ' / 10</dd>' : '',
        p.meanDescLen != null ? '    <dt>Desc chars</dt><dd>' + Math.round(p.meanDescLen) + '</dd>' : '',
        p.meanIdentifiedPersons != null ? '    <dt>Persons id\'d</dt><dd>' + num(p.meanIdentifiedPersons, 2) + '</dd>' : '',
        '  </dl>',
        '</div>',
      ].filter(Boolean).join('');
    }

    var judgeSection = '';
    if (p.judgeSampleSize && p.judgeSampleSize > 0) {
      judgeSection = [
        '<div class="llm-health-section">',
        '  <div class="llm-health-section-title">Judge (n=' + p.judgeSampleSize + ')</div>',
        '  <dl class="llm-health-grid">',
        p.meanJudgeAccuracy != null ? '    <dt>Accuracy</dt><dd>' + num(p.meanJudgeAccuracy, 2) + ' / 10</dd>' : '',
        p.meanJudgeCompleteness != null ? '    <dt>Completeness</dt><dd>' + num(p.meanJudgeCompleteness, 2) + ' / 10</dd>' : '',
        p.personIdCorrectRate != null ? '    <dt>Person ID correct</dt><dd class="' + reliabilityClass(p.personIdCorrectRate) + '">' + pct(p.personIdCorrectRate) + '</dd>' : '',
        '  </dl>',
        '</div>',
      ].filter(Boolean).join('');
    }

    return [
      '<div class="llm-health-card">',
      '  <h3>' + escapeHtml(p.providerName) + '</h3>',
      '  <div class="role">' + escapeHtml(p.role) + '</div>',
      '  <div class="count">' + escapeHtml(String(p.count == null ? 0 : p.count)) + ' calls</div>',
      '  <dl class="llm-health-grid">',
      '    <dt>OK</dt><dd class="' + reliabilityClass(p.okRate) + '">' + pct(p.okRate) + '</dd>',
      '    <dt>Timeout</dt><dd class="' + (p.timeoutRate > 0.05 ? 'bad' : p.timeoutRate > 0.01 ? 'warn' : '') + '">' + pct(p.timeoutRate) + '</dd>',
      '    <dt>Error</dt><dd class="' + (p.errorRate > 0.05 ? 'bad' : p.errorRate > 0.01 ? 'warn' : '') + '">' + pct(p.errorRate) + '</dd>',
      '    <dt>p50 latency</dt><dd>' + ms(p.latencyP50) + '</dd>',
      '    <dt>p95 latency</dt><dd class="' + latencyClass(p.latencyP95) + '">' + ms(p.latencyP95) + '</dd>',
      '    <dt>p99 latency</dt><dd class="' + latencyClass(p.latencyP99) + '">' + ms(p.latencyP99) + '</dd>',
      '  </dl>',
      qualitySection,
      judgeSection,
      '</div>',
    ].join('');
  }
}

// Browser-friendly global.
if (typeof window !== 'undefined') {
  window.LlmHealth = LlmHealth;
}
