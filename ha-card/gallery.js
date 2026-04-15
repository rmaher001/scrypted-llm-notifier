/**
 * Shared Gallery - searchable, filterable thumbnail grid for Daily Brief.
 * No module system - plain class in global scope (same pattern as VideoPlayer).
 */

// eslint-disable-next-line no-unused-vars
class Gallery {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.containerEl - Where to render the gallery
   * @param {Object} options.player - VideoPlayer instance for video playback
   * @param {function(string, Object=): string} options.buildUrl - URL construction
   * @param {function(number): string} options.formatTime - Timestamp to display string
   * @param {function(string, string, string, string): void} options.onCardClick - Click handler
   * @param {string} [options.logPrefix='[Gallery]']
   */
  constructor(options) {
    this._containerEl = options.containerEl;
    this._player = options.player;
    this._buildUrl = options.buildUrl;
    this._formatTime = options.formatTime || function(ts) {
      return new Date(ts).toLocaleString();
    };
    this._onCardClickFn = options.onCardClick || null;
    this._logPrefix = options.logPrefix || '[Gallery]';

    this._notifications = [];
    this._filters = { cameras: [], types: [], names: [] };
    this._activeFilters = {};
    this._page = 1;
    this._pageSize = 50;
    this._hasMore = false;
    this._total = 0;
    this._searchMode = null;
    this._searchQuery = '';
    this._debounceTimer = null;
    this._initialized = false;
    this._loading = false;
    this._savedState = null;
    this._inGroupView = false;
    this._sse = null;
    this._pendingSSE = false;

    // DOM refs (set by _renderShell)
    this._gridEl = null;
    this._backBtn = null;
    this._searchInput = null;
    this._cameraSelect = null;
    this._typeSelect = null;
    this._nameSelect = null;
    this._loadMoreBtn = null;
    this._statusEl = null;
    this._modeIndicator = null;
  }

  // ---- Public API ----

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    this._renderShell();
    await this._fetchPage(1, {});
    this._connectSSE();
  }

  async search(query) {
    this._searchQuery = query;
    this._page = 1;
    this._notifications = [];
    if (!query.trim()) {
      this._searchMode = null;
      await this._fetchPage(1, this._activeFilters);
      return;
    }
    await this._fetchSearch(query, this._activeFilters);
  }

  async applyFilters(filters) {
    this._activeFilters = filters;
    this._page = 1;
    this._notifications = [];
    if (this._searchQuery.trim()) {
      await this._fetchSearch(this._searchQuery, filters);
    } else {
      await this._fetchPage(1, filters);
    }
  }

  async loadMore() {
    if (!this._hasMore || this._loading) return;
    this._page++;
    await this._fetchPage(this._page, this._activeFilters, true);
  }

  destroy() {
    if (this._sse) { this._sse.close(); this._sse = null; }
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._containerEl.innerHTML = '';
    this._initialized = false;
  }

  // ---- Internal: SSE ----

  _connectSSE() {
    if (typeof EventSource === 'undefined') return;
    var self = this;
    var url = this._buildUrl('/brief/gallery/sse');
    this._sse = new EventSource(url);
    this._sse.onmessage = function(e) {
      if (e.data === 'new-notification') {
        self._onSSEUpdate();
      }
    };
    this._sse.onerror = function() {
      console.log(self._logPrefix, 'SSE reconnecting...');
    };
  }

  _onSSEUpdate() {
    if (this._inGroupView) return;
    if (this._loading) { this._pendingSSE = true; return; }
    this._pendingSSE = false;
    this._page = 1;
    this._notifications = [];
    if (this._searchQuery && this._searchQuery.trim()) {
      this._fetchSearch(this._searchQuery, this._activeFilters);
    } else {
      this._fetchPage(1, this._activeFilters);
    }
  }

  // ---- Internal: Data ----

  async _fetchPage(page, filters, append) {
    this._loading = true;
    this._showLoading(true);
    try {
      var params = { page: page, pageSize: this._pageSize };
      if (filters.camera) params.camera = filters.camera;
      if (filters.type) params.type = filters.type;
      if (filters.name) params.name = filters.name;
      var url = this._buildUrl('/brief/gallery/data', params);
      console.log(this._logPrefix, 'Fetching page', page, url);
      var resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      if (append) {
        this._notifications = this._notifications.concat(data.notifications);
      } else {
        this._notifications = data.notifications;
      }
      this._total = data.total;
      this._hasMore = data.hasMore;
      this._page = data.page;
      this._filters = data.filters;
      this._searchMode = null;
      this._renderFilters(data.filters);
      this._renderCards(this._notifications);
      this._renderSearchMode(null);
    } catch (e) {
      console.error(this._logPrefix, 'Fetch error:', e);
      this._renderEmpty('Failed to load gallery: ' + e.message);
    } finally {
      this._loading = false;
      this._showLoading(false);
      if (this._pendingSSE) this._onSSEUpdate();
    }
  }

  async _fetchSearch(query, filters) {
    this._loading = true;
    this._showLoading(true);
    try {
      var url = this._buildUrl('/brief/gallery/search');
      var body = { query: query };
      if (filters.camera) body.camera = filters.camera;
      if (filters.type) body.type = filters.type;
      if (filters.name) body.name = filters.name;
      console.log(this._logPrefix, 'Searching:', query);
      var resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      this._notifications = data.results;
      this._total = data.total;
      this._hasMore = false;
      this._searchMode = data.mode;
      this._renderCards(this._notifications);
      this._renderSearchMode(data.mode);
    } catch (e) {
      console.error(this._logPrefix, 'Search error:', e);
      this._renderEmpty('Search failed: ' + e.message);
    } finally {
      this._loading = false;
      this._showLoading(false);
      if (this._pendingSSE) this._onSSEUpdate();
    }
  }

  // ---- Internal: Rendering ----

  _renderShell() {
    var self = this;
    this._containerEl.innerHTML = '';

    var shell = document.createElement('div');
    shell.className = 'gallery-shell';
    shell.innerHTML =
      '<div class="gallery-controls-sticky">' +
      '<div class="gallery-search-bar">' +
        '<input type="text" class="gallery-search-input" placeholder="Search detections..." />' +
        '<span class="gallery-mode-indicator"></span>' +
      '</div>' +
      '<div class="gallery-filter-bar">' +
        '<select class="gallery-filter gallery-camera-filter"><option value="">All Cameras</option></select>' +
        '<select class="gallery-filter gallery-type-filter"><option value="">All Types</option></select>' +
        '<select class="gallery-filter gallery-name-filter"><option value="">All Names</option></select>' +
      '</div>' +
      '</div>' +
      '<div class="gallery-status"></div>' +
      '<div class="gallery-grid"></div>' +
      '<div class="gallery-load-more-wrap">' +
        '<button class="gallery-load-more" style="display:none">Load More</button>' +
      '</div>';

    this._containerEl.appendChild(shell);

    // Set sticky offset based on header + tab bar heights
    var stickyWrap = shell.querySelector('.gallery-controls-sticky');
    if (stickyWrap) {
      var header = document.querySelector('.header');
      var tabBar = document.querySelector('.tab-bar');
      var offset = (header ? header.offsetHeight : 0) + (tabBar ? tabBar.offsetHeight : 0);
      stickyWrap.style.top = offset + 'px';
    }

    this._gridEl = shell.querySelector('.gallery-grid');
    this._searchInput = shell.querySelector('.gallery-search-input');
    this._cameraSelect = shell.querySelector('.gallery-camera-filter');
    this._typeSelect = shell.querySelector('.gallery-type-filter');
    this._nameSelect = shell.querySelector('.gallery-name-filter');
    this._loadMoreBtn = shell.querySelector('.gallery-load-more');
    this._statusEl = shell.querySelector('.gallery-status');
    this._modeIndicator = shell.querySelector('.gallery-mode-indicator');

    // Events
    this._searchInput.addEventListener('input', function(e) { self._onSearchInput(e); });
    this._searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        self._searchInput.value = '';
        self.search('');
      }
    });
    this._cameraSelect.addEventListener('change', function() { self._onFilterChange(); });
    this._typeSelect.addEventListener('change', function() { self._onFilterChange(); });
    this._nameSelect.addEventListener('change', function() { self._onFilterChange(); });
    this._loadMoreBtn.addEventListener('click', function() { self.loadMore(); });
  }

  _renderCards(notifications) {
    if (!this._gridEl) return;

    if (notifications.length === 0) {
      this._renderEmpty(this._searchQuery ? 'No results for "' + this._searchQuery + '"' : 'No detections found');
      this._loadMoreBtn.style.display = 'none';
      return;
    }

    var self = this;
    var html = '';
    for (var i = 0; i < notifications.length; i++) {
      var n = notifications[i];
      var time = self._formatTime(n.timestamp);
      var title = n.llmTitle || 'Detection';
      var thumbSrc = n.thumbnailUrl ? self._buildUrl('/brief/snapshot', { id: n.id }) : '';
      var escapedId = self._escapeHtml(n.id);
      var escapedTitle = self._escapeHtml(title);
      var escapedBody = self._escapeHtml(n.llmBody || '');
      var escapedTime = self._escapeHtml(time);
      var groupBadge = (n.groupSize && n.groupSize > 1)
        ? '<span class="gallery-group-badge">' + n.groupSize + ' events</span>'
        : '';
      // Name badges: Scrypted (green), LLM (teal), Both (purple) — stacked for multi-person
      var nameBadge = '';
      var badgeItems = self._buildNameBadges(n.names, n.llmIdentifiedNames, n.llmIdentifiedName);
      if (badgeItems.length > 0) {
        var badgeHtml = badgeItems.map(function(b) {
          return '<span class="gallery-name-badge gallery-' + b.cssClass + '">' + b.icon + ' ' + self._escapeHtml(b.label) + '</span>';
        }).join('');
        nameBadge = badgeItems.length > 1
          ? '<div class="gallery-name-badges">' + badgeHtml + '</div>'
          : badgeHtml;
      }
      var groupAttr = n.groupId ? ' data-group-id="' + self._escapeHtml(n.groupId) + '"' : '';
      var groupSizeAttr = (n.groupSize && n.groupSize > 1) ? ' data-group-size="' + n.groupSize + '"' : '';
      html +=
        '<div class="gallery-card" data-id="' + escapedId + '" data-title="' + escapedTitle + '" data-body="' + escapedBody + '" data-time="' + escapedTime + '" data-camera-id="' + self._escapeHtml(n.cameraId || '') + '" data-timestamp="' + (n.timestamp || '') + '"' + groupAttr + groupSizeAttr + '>' +
          '<div class="gallery-card-thumb">' +
            (thumbSrc ? '<img src="' + thumbSrc + '" alt="" loading="lazy" />' : '<div class="gallery-card-no-thumb"></div>') +
            groupBadge + nameBadge +
          '</div>' +
          '<div class="gallery-card-info">' +
            '<div class="gallery-card-time">' + time + '</div>' +
            '<div class="gallery-card-title">' + self._escapeHtml(title) + '</div>' +
            (n.llmBody ? '<div class="gallery-card-body">' + self._escapeHtml(n.llmBody) + '</div>' : '') +
          '</div>' +
        '</div>';
    }
    this._gridEl.innerHTML = html;

    // Attach click handlers
    var cards = this._gridEl.querySelectorAll('.gallery-card');
    for (var j = 0; j < cards.length; j++) {
      cards[j].addEventListener('click', function() {
        var id = this.getAttribute('data-id');
        var t = this.getAttribute('data-title');
        var b = this.getAttribute('data-body');
        var tm = this.getAttribute('data-time');
        var cid = this.getAttribute('data-camera-id');
        var ts = this.getAttribute('data-timestamp');
        var gid = this.getAttribute('data-group-id');
        var gs = parseInt(this.getAttribute('data-group-size') || '0', 10);
        self._onCardClick(id, t, b, tm, cid, ts, gid, gs);
      });
    }

    this._loadMoreBtn.style.display = this._hasMore ? 'block' : 'none';
    this._statusEl.textContent = this._total + ' detection' + (this._total !== 1 ? 's' : '');
  }

  _renderFilters(filters) {
    if (!this._cameraSelect) return;
    this._updateSelect(this._cameraSelect, filters.cameras, 'All Cameras');
    this._updateSelect(this._typeSelect, filters.types, 'All Types');
    this._updateSelect(this._nameSelect, filters.names, 'All Names');
  }

  _updateSelect(selectEl, options, placeholder) {
    var current = selectEl.value;
    selectEl.innerHTML = '<option value="">' + placeholder + '</option>';
    for (var i = 0; i < options.length; i++) {
      var opt = document.createElement('option');
      opt.value = options[i];
      opt.textContent = options[i];
      selectEl.appendChild(opt);
    }
    selectEl.value = current;
  }

  _renderEmpty(message) {
    if (!this._gridEl) return;
    this._gridEl.innerHTML =
      '<div class="gallery-empty">' +
        '<div class="gallery-empty-icon">🔍</div>' +
        '<div class="gallery-empty-text">' + this._escapeHtml(message) + '</div>' +
      '</div>';
  }

  _renderSearchMode(mode) {
    if (!this._modeIndicator) return;
    if (mode === 'semantic') {
      this._modeIndicator.textContent = '✨ Semantic search';
      this._modeIndicator.style.display = 'inline';
    } else if (mode === 'keyword') {
      this._modeIndicator.textContent = '🔤 Keyword search';
      this._modeIndicator.style.display = 'inline';
    } else {
      this._modeIndicator.textContent = '';
      this._modeIndicator.style.display = 'none';
    }
  }

  _showLoading(show) {
    if (this._statusEl) {
      this._statusEl.textContent = show ? 'Loading...' : '';
    }
  }

  // ---- Internal: Events ----

  _onSearchInput(e) {
    var self = this;
    var query = e.target.value;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(function() {
      self.search(query);
    }, 400);
  }

  _onFilterChange() {
    var filters = {};
    if (this._cameraSelect.value) filters.camera = this._cameraSelect.value;
    if (this._typeSelect.value) filters.type = this._typeSelect.value;
    if (this._nameSelect.value) filters.name = this._nameSelect.value;
    this.applyFilters(filters);
  }

  _onCardClick(notificationId, title, body, time, cameraId, timestamp, groupId, groupSize) {
    // If clicking a grouped card (with multiple events) and not already in group view, drill down
    if (groupId && groupSize > 1 && !this._inGroupView) {
      console.log(this._logPrefix, 'Drilling into group:', groupId, '(' + groupSize + ' events)');
      this._drillIntoGroup(groupId);
      return;
    }
    console.log(this._logPrefix, 'Card clicked:', notificationId, title);
    if (this._onCardClickFn) {
      this._onCardClickFn(notificationId, title, body, time, cameraId, timestamp);
    }
  }

  async _drillIntoGroup(groupId) {
    if (this._loading) return;
    // Save current state for back navigation
    this._savedState = {
      notifications: this._notifications,
      filters: this._filters,
      activeFilters: this._activeFilters,
      page: this._page,
      hasMore: this._hasMore,
      total: this._total,
      searchQuery: this._searchQuery,
      searchMode: this._searchMode,
      scrollTop: this._containerEl.scrollTop || 0,
    };
    this._inGroupView = true;

    this._loading = true;
    this._showLoading(true);
    try {
      var url = this._buildUrl('/brief/gallery/data', { groupId: groupId, pageSize: 100 });
      console.log(this._logPrefix, 'Fetching group:', groupId, url);
      var resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      this._notifications = data.notifications;
      this._total = data.total;
      this._hasMore = false;
      this._searchMode = null;
      this._renderCards(this._notifications);
      this._renderSearchMode(null);
      // Show back button
      this._showBackButton(data.groupTitle || 'Group', data.groupMemberCount || data.total);
      // Hide filters and search in group view
      this._setControlsVisible(false);
    } catch (e) {
      console.error(this._logPrefix, 'Group fetch error:', e);
      this._renderEmpty('Failed to load group: ' + e.message);
    } finally {
      this._loading = false;
      this._showLoading(false);
      if (this._pendingSSE) this._onSSEUpdate();
    }
  }

  _exitGroupView() {
    if (!this._savedState) return;
    this._inGroupView = false;

    // Restore previous state
    this._notifications = this._savedState.notifications;
    this._filters = this._savedState.filters;
    this._activeFilters = this._savedState.activeFilters;
    this._page = this._savedState.page;
    this._hasMore = this._savedState.hasMore;
    this._total = this._savedState.total;
    this._searchQuery = this._savedState.searchQuery;
    this._searchMode = this._savedState.searchMode;

    var scrollTop = this._savedState.scrollTop;
    this._savedState = null;

    // Re-render with saved state
    this._renderCards(this._notifications);
    this._renderFilters(this._filters);
    this._renderSearchMode(this._searchMode);
    this._hideBackButton();
    this._setControlsVisible(true);

    // Restore scroll position
    if (scrollTop) {
      this._containerEl.scrollTop = scrollTop;
    }
  }

  _showBackButton(groupTitle, memberCount) {
    if (!this._backBtn) {
      var self = this;
      this._backBtn = document.createElement('button');
      this._backBtn.className = 'gallery-back-btn';
      this._backBtn.addEventListener('click', function() { self._exitGroupView(); });
      // Insert before the grid
      var shell = this._gridEl.parentElement;
      shell.insertBefore(this._backBtn, this._statusEl);
    }
    this._backBtn.textContent = '\u2190 Back to Gallery';
    this._backBtn.style.display = 'block';
    // Update status with group info
    if (this._statusEl) {
      this._statusEl.textContent = groupTitle + ' \u2014 ' + memberCount + ' event' + (memberCount !== 1 ? 's' : '') + ' in group';
    }
  }

  _hideBackButton() {
    if (this._backBtn) {
      this._backBtn.style.display = 'none';
    }
  }

  _setControlsVisible(visible) {
    var stickyWrap = this._containerEl.querySelector('.gallery-controls-sticky');
    if (stickyWrap) stickyWrap.style.display = visible ? '' : 'none';
  }

  _buildNameBadges(names, llmIdentifiedNames, llmIdentifiedName) {
    var scryptedSet = {};
    (names || []).forEach(function(n) { scryptedSet[n] = true; });
    var llmNames = (llmIdentifiedNames && llmIdentifiedNames.length > 0)
      ? llmIdentifiedNames
      : (llmIdentifiedName ? [llmIdentifiedName] : []);
    var llmSet = {};
    llmNames.forEach(function(n) { llmSet[n] = true; });
    var allNames = {};
    Object.keys(scryptedSet).forEach(function(n) { allNames[n] = true; });
    Object.keys(llmSet).forEach(function(n) { allNames[n] = true; });
    var badges = [];
    Object.keys(allNames).forEach(function(name) {
      var inS = !!scryptedSet[name];
      var inL = !!llmSet[name];
      if (inS && inL) {
        badges.push({ label: name, cssClass: 'name-both', icon: '\uD83D\uDC64\u2728' });
      } else if (inL) {
        badges.push({ label: name, cssClass: 'name-llm', icon: '\u2728' });
      } else {
        badges.push({ label: name, cssClass: 'name-scrypted', icon: '\uD83D\uDC64' });
      }
    });
    return badges;
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Gallery CSS (injected once when Gallery is used)
Gallery.CSS = '' +
  '.gallery-shell { padding: 0; }' +
  '.gallery-controls-sticky { position: sticky; top: 0; z-index: 10; background: var(--bg-primary, #000); padding-top: 12px; }' +
  '.gallery-search-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }' +
  '.gallery-search-input {' +
    'flex: 1; padding: 10px 14px; border-radius: 8px;' +
    'border: 1px solid var(--bg-secondary, #333); background: var(--bg-secondary, #1a1a2e);' +
    'color: var(--text-primary, #e0e0e0); font-size: 14px; outline: none;' +
  '}' +
  '.gallery-search-input:focus { border-color: var(--accent, #6c63ff); }' +
  '.gallery-mode-indicator {' +
    'font-size: 12px; color: var(--text-secondary, #888); white-space: nowrap; display: none;' +
  '}' +
  '.gallery-filter-bar { display: flex; gap: 8px; margin-bottom: 0; flex-wrap: wrap; padding-bottom: 12px; }' +
  '.gallery-filter {' +
    'padding: 6px 10px; border-radius: 6px;' +
    'border: 1px solid var(--bg-secondary, #333); background: var(--bg-secondary, #1a1a2e);' +
    'color: var(--text-primary, #e0e0e0); font-size: 13px; cursor: pointer;' +
  '}' +
  '.gallery-status { font-size: 12px; color: var(--text-secondary, #888); margin-bottom: 8px; }' +
  '.gallery-grid {' +
    'display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));' +
    'gap: 12px;' +
  '}' +
  '.gallery-card {' +
    'border-radius: 8px; overflow: hidden; cursor: pointer;' +
    'background: var(--bg-secondary, #1a1a2e); transition: transform 0.15s, box-shadow 0.15s;' +
  '}' +
  '.gallery-card:hover { transform: scale(1.03); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }' +
  '.gallery-card-thumb { width: 100%; aspect-ratio: 16/9; overflow: hidden; background: #111; position: relative; }' +
  '.gallery-card-thumb img { width: 100%; height: 100%; object-fit: cover; }' +
  '.gallery-card-no-thumb { width: 100%; height: 100%; background: #222; }' +
  '.gallery-group-badge {' +
    'position: absolute; top: 6px; right: 6px; padding: 2px 8px; border-radius: 10px;' +
    'background: rgba(108, 99, 255, 0.9); color: #fff; font-size: 11px; font-weight: 600;' +
    'pointer-events: none; line-height: 1.4;' +
  '}' +
  '.gallery-name-badges {' +
    'position: absolute; bottom: 6px; left: 6px; display: flex; flex-direction: column; gap: 2px; pointer-events: none;' +
  '}' +
  '.gallery-name-badges .gallery-name-badge { position: static; }' +
  '.gallery-name-badge {' +
    'position: absolute; bottom: 6px; left: 6px; padding: 2px 8px; border-radius: 10px;' +
    'color: #fff; font-size: 11px; font-weight: 600;' +
    'pointer-events: none; line-height: 1.4;' +
  '}' +
  '.gallery-name-scrypted { background: rgba(76, 175, 80, 0.85); }' +
  '.gallery-name-llm { background: rgba(0, 188, 212, 0.85); }' +
  '.gallery-name-both { background: rgba(123, 44, 191, 0.85); }' +
  '.gallery-card-info { padding: 8px; }' +
  '.gallery-card-time { font-size: 11px; color: var(--text-secondary, #888); }' +
  '.gallery-card-title { font-size: 13px; color: var(--text-primary, #e0e0e0); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
  '.gallery-card-body { font-size: 11px; color: var(--text-secondary, #888); margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }' +
  '.gallery-empty { grid-column: 1 / -1; text-align: center; padding: 48px 16px; }' +
  '.gallery-empty-icon { font-size: 48px; margin-bottom: 12px; }' +
  '.gallery-empty-text { color: var(--text-secondary, #888); font-size: 14px; }' +
  '.gallery-load-more-wrap { text-align: center; margin-top: 16px; }' +
  '.gallery-load-more {' +
    'padding: 10px 24px; border-radius: 8px; border: none; cursor: pointer;' +
    'background: var(--accent, #6c63ff); color: #fff; font-size: 14px;' +
  '}' +
  '.gallery-load-more:hover { opacity: 0.9; }' +
  '.gallery-back-btn {' +
    'display: none; padding: 6px 14px; margin-bottom: 12px; border-radius: 6px;' +
    'border: 1px solid var(--bg-secondary, #333); background: var(--bg-secondary, #1a1a2e);' +
    'color: var(--text-primary, #e0e0e0); font-size: 13px; cursor: pointer;' +
  '}' +
  '.gallery-back-btn:hover { background: var(--accent, #6c63ff); color: #fff; }';
