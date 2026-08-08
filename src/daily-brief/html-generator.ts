import { CachedHighlight, NarrativeSegment } from '../types';
import { escapeHtml } from '../utils';
import { buildNameBadges } from '../llm-notifier';

// HA card JS is embedded at build time
import { HA_CARD_JS } from '../ha-card-embedded';

// VideoPlayer JS is embedded at build time (for web UI inline embed)
import { VIDEO_PLAYER_JS } from '../video-player-embedded';

// Gallery JS is embedded at build time (for web UI inline embed)
import { GALLERY_JS } from '../gallery-embedded';

// LLM Health tab JS is embedded at build time (for web UI inline embed)
import { LLM_HEALTH_JS } from '../llm-health-embedded';

// Scrypted NVR Iframe Card — bundled alongside DailyBriefCard so a single
// HA <script> include registers both custom elements.
import { SCRYPTED_NVR_IFRAME_CARD_JS } from '../scrypted-nvr-iframe-card-embedded';

export function getHACardBundle(): string {
    // Concatenate both cards so /brief/ha-card serves them in one fetch.
    // HA loads the bundle once and each IIFE registers its own
    // customElements.define independently.
    return HA_CARD_JS + '\n' + SCRYPTED_NVR_IFRAME_CARD_JS;
}

// ============================================================================
// Daily Brief HTML Template (NVR-style with dark/light theme)
// ============================================================================

export function generateDailyBriefHTML(
    eventCount: number,
    summary: string | null,
    highlights: CachedHighlight[],
    generatedAt: number | null,
    timezone: string = 'America/Los_Angeles',
    overview?: string,
    narrative?: NarrativeSegment[],
    pluginVersion?: string,
    cloudBaseUrl?: string,
    haNvrTimelinePath?: string,
    selectedDate?: string,
    minDate?: string,
    maxDate?: string,
): string {
    // Format generation timestamp for display
    const generatedAtStr = generatedAt
        ? `Generated ${new Date(generatedAt).toLocaleString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: timezone
        })}`
        : 'Generating...';

    // Short generated-time (e.g. "9:00 AM") for the compact meta beside the date
    // control — replaces the verbose "Generated <weekday> <date> at <time>" subtitle
    // once the date picker (which already shows the date) is present.
    const generatedTimeStr = generatedAt
        ? new Date(generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone })
        : '';

    // Date selector (header): bounded native date input + prev/next-day arrows.
    // Only rendered when the route supplies the timezone-aware date bounds.
    // Navigation reuses the page's `baseUrl` and the existing `?date=YYYY-MM-DD`
    // route param. Controls use data-attributes (no inline onclick) and the
    // injected script contains no regex literals or escaped quotes
    // (feedback_no_inline_onclick_in_templates).
    const hasDateNav = !!(selectedDate && minDate && maxDate);
    const prevDisabled = hasDateNav && selectedDate! <= minDate!;
    const nextDisabled = hasDateNav && selectedDate! >= maxDate!;
    const dateNavHtml = hasDateNav ? `
                <div class="date-nav">
                    <button class="date-arrow" data-date-nav="prev"${prevDisabled ? ' disabled' : ''} aria-label="Previous day">&#8249;</button>
                    <input type="date" class="date-input" id="briefDate" value="${selectedDate}" min="${minDate}" max="${maxDate}" aria-label="Brief date">
                    <button class="date-arrow" data-date-nav="next"${nextDisabled ? ' disabled' : ''} aria-label="Next day">&#8250;</button>
                </div>` : '';

    // Brief-tab control bar: Brief-only controls (date scrubber + generated time on
    // the left, regenerate + sort on the right). Lives inside #brief-tab — NOT the
    // global header — because none of these apply to Gallery/People/LLM Health. The
    // theme toggle stays in the header (it is global). regen/sort keep their existing
    // global onclick handlers; the date scrubber keeps its data-attr wiring.
    const briefControlsHtml = `
        <div class="brief-controls">
            <div class="brief-controls-left">${dateNavHtml}${generatedTimeStr ? `
                <span class="gen-meta">${generatedTimeStr}</span>` : ''}
            </div>
            <div class="brief-controls-right">
                <button class="icon-btn" onclick="refreshSummary()" title="Full regeneration (slow)">
                    <svg viewBox="0 0 24 24"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </button>
                <button class="icon-btn sort-btn" onclick="toggleSortOrder()" title="Toggle sort order">
                    <svg class="sort-newest-icon" viewBox="0 0 24 24"><path d="M3 4h13M3 8h9M3 12h5"/><path d="M19 4v16M19 20l-3-3M19 20l3-3"/></svg>
                    <svg class="sort-oldest-icon" viewBox="0 0 24 24"><path d="M3 4h5M3 8h9M3 12h13"/><path d="M19 4v16M19 4l-3 3M19 4l3 3"/></svg>
                </button>
            </div>
        </div>`;
    const dateNavScript = hasDateNav ? `
        (function() {
            var briefDateInput = document.getElementById('briefDate');
            if (!briefDateInput) return;
            var briefMin = ${JSON.stringify(minDate)};
            var briefMax = ${JSON.stringify(maxDate)};
            function stepDate(base, delta) {
                var p = base.split('-');
                var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
                dt.setDate(dt.getDate() + delta);
                var mo = ('0' + (dt.getMonth() + 1)).slice(-2);
                var da = ('0' + dt.getDate()).slice(-2);
                return dt.getFullYear() + '-' + mo + '-' + da;
            }
            function goBriefDate(d) {
                if (d < briefMin) d = briefMin;
                if (d > briefMax) d = briefMax;
                window.location.href = baseUrl + '/brief?date=' + d;
            }
            briefDateInput.addEventListener('change', function() { goBriefDate(briefDateInput.value); });
            var prevBtn = document.querySelector('[data-date-nav=prev]');
            var nextBtn = document.querySelector('[data-date-nav=next]');
            if (prevBtn) prevBtn.addEventListener('click', function() { if (!prevBtn.hasAttribute('disabled')) goBriefDate(stepDate(briefDateInput.value, -1)); });
            if (nextBtn) nextBtn.addEventListener('click', function() { if (!nextBtn.hasAttribute('disabled')) goBriefDate(stepDate(briefDateInput.value, 1)); });
        })();` : '';

    // Helper to render a cached highlight (compact version for timeline)
    const renderHighlightItem = (h: CachedHighlight, compact: boolean = false, index?: number) => {
        const itemClass = compact ? 'event-item timeline-item' : 'event-item';
        const indexAttr = index !== undefined ? ` data-index="${index}"` : '';
        // Name badges: Scrypted (green), LLM (teal), Both (purple) — stacked for multi-person
        const badges = buildNameBadges(h.names, h.llmIdentifiedNames, h.llmIdentifiedName);
        let nameBadge = '';
        if (badges.length > 0) {
            const badgeHtml = badges.map(b =>
                `<span class="name-badge ${b.cssClass}">${b.icon} ${escapeHtml(b.label)}</span>`
            ).join('');
            nameBadge = badges.length > 1
                ? `<div class="name-badges">${badgeHtml}</div>`
                : badgeHtml;
        }
        return `
        <div class="${itemClass}"${indexAttr} data-event-id="${escapeHtml(h.id)}" data-event-title="${escapeHtml(h.title)}" data-event-body="${escapeHtml(h.body)}" data-event-time="${escapeHtml(h.time)}" data-camera-id="${escapeHtml(h.cameraId)}" data-timestamp="${h.seekTimestamp ?? h.timestamp}">
            <div class="event-thumb">
                ${h.thumbnail === 'poster' ? `<img src="" alt="" data-poster-id="${escapeHtml(h.id)}">` : '<div class="no-thumb"></div>'}
                ${nameBadge}
            </div>
            <div class="event-meta">
                <div class="event-time">${h.date} • ${h.time}</div>
                <div class="event-title">${escapeHtml(h.title)}</div>
                ${compact ? '' : `<div class="event-body">${escapeHtml(h.body)}</div>`}
            </div>
        </div>`;
    };

    // Build index-to-highlight map for narrative rendering (filter out highlights without index)
    const highlightsWithIndex = highlights.filter(h => h.index !== undefined);
    const highlightByIndex = new Map(highlightsWithIndex.map(h => [h.index!, h]));

    // Helper to render a narrative segment with linked snapshots
    const renderNarrativeSegment = (segment: NarrativeSegment, index: number) => {
        const segmentHighlights = segment.highlightIds
            .map(idx => highlightByIndex.get(idx))
            .filter((h): h is CachedHighlight => h !== undefined);

        const snapshotsHTML = segmentHighlights.map(h => renderHighlightItem(h, true)).join('');

        return `
        <div class="timeline-segment" data-index="${index}">
            <div class="timeline-header">
                <span class="timeline-line"></span>
                <span class="timeline-label">${escapeHtml(segment.timeRange)}</span>
                <span class="timeline-line"></span>
            </div>
            <p class="timeline-text">${escapeHtml(segment.text)}</p>
            ${segmentHighlights.length > 0 ? `
            <div class="timeline-snapshots">
                ${snapshotsHTML}
            </div>
            ` : ''}
        </div>`;
    };

    // Render timeline or fallback to grid
    const hasNarrative = narrative && narrative.length > 0;
    // Render newest-first (matches default sort order 'newest') while preserving data-index for JS sort toggling
    const timelineHTML = hasNarrative
        ? narrative.map((seg, idx) => ({ seg, idx })).reverse()
            .map(({ seg, idx }) => renderNarrativeSegment(seg, idx)).join('')
        : '';
    const highlightsHTML = highlights.map((h, idx) => ({ h, idx })).reverse()
        .map(({ h, idx }) => renderHighlightItem(h, false, idx)).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,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">
    <title>Daily Brief - ${generatedAtStr}</title>
    <style>
        :root {
            --bg-primary: #000000;
            --bg-secondary: #121212;
            --text-primary: #ffffff;
            --accent: #7c4dff;
            --badge-bg: #e65100;
        }

        [data-theme="light"] {
            --bg-primary: #f5f5f5;
            --bg-secondary: #ffffff;
            --text-primary: #000000;
            --accent: #7c4dff;
            --badge-bg: #e65100;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
        }

        .header {
            background: #2a2a2a;
            padding: 12px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        [data-theme="light"] .header {
            background: #e8e8e8;
        }

        .header-title { font-size: 14px; font-weight: 500; letter-spacing: 2px; color: var(--text-primary); opacity: 0.7; white-space: nowrap; }

        /* Brief-tab control bar — Brief-only controls (date scrubber + generated time, regen + sort) */
        .brief-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 12px; padding: 12px 20px; }
        .brief-controls-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .brief-controls-right { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
        .gen-meta { font-size: 11px; color: var(--text-primary); opacity: 0.4; font-variant-numeric: tabular-nums; letter-spacing: 0.2px; white-space: nowrap; }

        /* Date scrubber — one segmented control (NVR timeline-navigation feel) */
        .date-nav { display: inline-flex; align-items: stretch; height: 30px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; overflow: hidden; flex-shrink: 0; }
        [data-theme="light"] .date-nav { background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.10); }
        .date-arrow { background: transparent; border: none; color: var(--text-primary); width: 30px; display: grid; place-items: center; font-size: 15px; line-height: 1; cursor: pointer; opacity: 0.8; transition: background 0.15s ease, opacity 0.15s ease; }
        .date-arrow:hover:not(:disabled) { background: rgba(255,255,255,0.08); opacity: 1; }
        [data-theme="light"] .date-arrow:hover:not(:disabled) { background: rgba(0,0,0,0.06); }
        .date-arrow:disabled { opacity: 0.25; cursor: default; }
        .date-input { background: transparent; border: none; border-left: 1px solid rgba(255,255,255,0.10); border-right: 1px solid rgba(255,255,255,0.10); color: var(--text-primary); padding: 0 10px; font-size: 12px; font-variant-numeric: tabular-nums; letter-spacing: 0.3px; cursor: pointer; color-scheme: light dark; field-sizing: content; }
        [data-theme="light"] .date-input { border-left-color: rgba(0,0,0,0.10); border-right-color: rgba(0,0,0,0.10); }
        .date-input::-webkit-calendar-picker-indicator { margin-left: 6px; padding: 0; opacity: 0.55; }

        .icon-btn {
            background: transparent;
            border: none;
            color: var(--text-primary);
            opacity: 0.7;
            padding: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            transition: background 0.2s ease, opacity 0.2s ease;
        }
        .icon-btn:hover { background: rgba(255, 255, 255, 0.1); opacity: 1; }
        [data-theme="light"] .icon-btn:hover { background: rgba(0, 0, 0, 0.1); }
        .icon-btn svg { width: 20px; height: 20px; stroke: currentColor; stroke-width: 2; fill: none; }
        /* The launcher link reuses .icon-btn (built for <button>); an <a> also
           needs the underline stripped. */
        a.launcher-link { text-decoration: none; }
        /* Catch Me Up Button */
        .catchup-bar {
            text-align: center;
            padding: 12px 20px 0;
        }
        .catchup-btn {
            background:
              linear-gradient(var(--bg-secondary), var(--bg-secondary)) padding-box,
              conic-gradient(from var(--border-angle), #7c4dff, #00bcd4, #e040fb, #7c4dff) border-box;
            border: 2px solid transparent;
            cursor: pointer;
            padding: 8px 20px;
            border-radius: 20px;
            color: #fff;
            font-size: 0.85em;
            font-weight: 500;
            letter-spacing: 0.5px;
            transition: filter 0.3s;
            animation: rotate-border 4s linear infinite;
        }
        [data-theme="light"] .catchup-btn { color: var(--text-primary); }
        .catchup-btn:hover { filter: drop-shadow(0 0 8px rgba(124, 77, 255, 0.5)); }
        .catchup-btn.loading { opacity: 0.5; pointer-events: none; animation-name: none; }
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
        .icon-btn .sun-icon { display: none; }
        .icon-btn .moon-icon { display: block; }
        [data-theme="light"] .icon-btn .sun-icon { display: block; }
        [data-theme="light"] .icon-btn .moon-icon { display: none; }
        .sort-btn .sort-newest-icon { display: block; }
        .sort-btn .sort-oldest-icon { display: none; }
        [data-sort="oldest"] .sort-btn .sort-newest-icon { display: none; }
        [data-sort="oldest"] .sort-btn .sort-oldest-icon { display: block; }

        .action-btn {
            background: var(--accent);
            border: none;
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 4px;
            color: #fff;
            font-size: 12px;
            font-weight: 500;
            transition: opacity 0.2s, background 0.2s;
        }
        .action-btn:hover { opacity: 0.9; }
        .action-btn.secondary {
            background: var(--bg-secondary);
            color: var(--text-primary);
            border: 1px solid rgba(255,255,255,0.1);
        }
        [data-theme="light"] .action-btn.secondary {
            border: 1px solid rgba(0,0,0,0.1);
        }
        .action-btn.loading {
            opacity: 0.6;
            cursor: wait;
        }

        /* Summary Section */
        .summary-section {
            padding: 24px 20px;
            background: var(--bg-secondary);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        [data-theme="light"] .summary-section {
            border-bottom: 1px solid rgba(0, 0, 0, 0.08);
        }
        .summary-text {
            font-size: 17px;
            line-height: 1.7;
            color: var(--text-primary);
        }

        .content-wrapper {
            max-width: 800px;
            margin: 0 auto;
            padding: 0 20px;
        }

        /* Tab bar */
        .tab-bar {
            display: flex;
            gap: 0;
            max-width: 800px;
            margin: 0 auto;
            padding: 0 20px;
            border-bottom: 1px solid var(--bg-secondary);
            position: sticky;
            top: 0;
            z-index: 99;
            background: var(--bg-primary);
        }
        .tab {
            padding: 10px 20px;
            border: none;
            background: none;
            color: var(--text-primary);
            opacity: 0.5;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            transition: opacity 0.2s, border-color 0.2s;
        }
        .tab:hover { opacity: 0.8; }
        .tab.active {
            opacity: 1;
            border-bottom-color: var(--accent);
        }
        .tab-content { }
        .gallery-container {
            max-width: 800px;
            margin: 0 auto;
            padding: 16px 20px;
        }

        /* People tab */
        .people-container {
            max-width: 800px;
            margin: 0 auto;
            padding: 16px 20px;
        }
        .people-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 16px;
        }
        .person-card {
            background: var(--bg-secondary);
            border-radius: 12px;
            overflow: hidden;
            text-align: center;
        }
        .person-card img {
            width: 100%;
            aspect-ratio: 1;
            object-fit: cover;
        }
        .person-card .person-info {
            padding: 8px;
        }
        .person-card .person-name {
            font-weight: 600;
            font-size: 14px;
            color: var(--text-primary);
        }
        .person-card .person-meta {
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 2px;
        }
        .person-delete {
            background: none;
            border: 1px solid rgba(255,59,48,0.4);
            color: #ff3b30;
            border-radius: 6px;
            padding: 4px 10px;
            font-size: 11px;
            cursor: pointer;
            margin-top: 6px;
        }
        .person-delete:hover { background: rgba(255,59,48,0.15); }
        .people-empty {
            text-align: center;
            color: var(--text-secondary);
            padding: 40px 20px;
            font-size: 14px;
        }

        .summary-generating {
            color: var(--text-primary);
            opacity: 0.5;
            font-style: italic;
        }

        /* Highlights Section */
        .highlights-section {
            padding: 16px 20px 24px;
            background: var(--bg-secondary);
            border-bottom: 3px solid var(--bg-primary);
        }
        .highlights-label {
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 1.5px;
            color: var(--text-primary);
            opacity: 0.4;
            text-transform: uppercase;
            margin-bottom: 12px;
        }
        .highlights-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            gap: 14px;
        }

        /* Section Header */
        .section-header {
            padding: 16px 20px;
            margin-top: 24px;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 1.5px;
            color: var(--text-primary);
            opacity: 0.8;
            background: #1a1a1a;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        [data-theme="light"] .section-header {
            background: #f0f0f0;
        }
        .section-header .section-title-text {
            text-transform: uppercase;
        }
        .section-header .section-meta {
            font-weight: 400;
            letter-spacing: 0.5px;
            text-transform: lowercase;
        }

        /* Events Grid - NVR Style */
        .events-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 12px;
            padding: 12px 12px 20px;
        }

        .event-item { cursor: pointer; }

        .event-thumb {
            position: relative;
            aspect-ratio: 4/3;
            background: #1a1a1a;
            overflow: hidden;
            border-radius: 6px;
        }
        .event-thumb img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            border-radius: 6px;
        }
        .no-thumb {
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
            border-radius: 6px;
        }

        .name-badges {
            position: absolute;
            bottom: 4px;
            left: 4px;
            display: flex;
            flex-direction: column;
            gap: 2px;
            pointer-events: none;
        }
        .name-badges .name-badge {
            position: static;
        }
        .name-badge {
            position: absolute;
            bottom: 4px;
            left: 4px;
            padding: 1px 6px;
            border-radius: 8px;
            color: #fff;
            font-size: 10px;
            font-weight: 600;
            pointer-events: none;
            line-height: 1.4;
        }
        .name-scrypted { background: rgba(76, 175, 80, 0.85); }
        .name-llm { background: rgba(0, 188, 212, 0.85); }
        .name-both { background: rgba(123, 44, 191, 0.85); }

        .event-meta {
            padding: 8px 4px 12px;
        }
        .event-time {
            font-size: 12px;
            color: var(--text-primary);
            opacity: 0.7;
        }
        .event-title {
            font-size: 12px;
            color: var(--text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 2px;
        }
        .event-body {
            font-size: 11px;
            color: var(--text-primary);
            opacity: 0.6;
            margin-top: 4px;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
            line-height: 1.5;
        }

        /* Timeline Styles */
        .timeline-section {
            padding: 16px 20px;
            background: var(--bg-secondary);
        }

        .timeline-segment {
            margin-bottom: 32px;
        }
        .timeline-segment:last-child {
            margin-bottom: 16px;
        }

        .timeline-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
        }

        .timeline-line {
            flex: 1;
            height: 1px;
            background: rgba(255, 255, 255, 0.1);
        }
        [data-theme="light"] .timeline-line {
            background: rgba(0, 0, 0, 0.1);
        }

        .timeline-label {
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 1.5px;
            color: var(--text-primary);
            opacity: 0.5;
            text-transform: uppercase;
            white-space: nowrap;
        }

        .timeline-text {
            font-size: 16px;
            line-height: 1.6;
            color: var(--text-primary);
            margin-bottom: 16px;
        }

        .timeline-snapshots {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            padding-bottom: 8px;
        }

        .timeline-item {
            flex: 1 1 150px;
            max-width: 200px;
        }
        .timeline-item .event-thumb {
            aspect-ratio: 4/3;
        }
        .timeline-item .event-meta {
            padding: 6px 2px 8px;
        }
        .timeline-item .event-time {
            font-size: 11px;
        }
        .timeline-item .event-title {
            font-size: 11px;
        }

        /* Empty state */
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--text-primary);
            opacity: 0.5;
        }
        .empty-state svg {
            width: 48px;
            height: 48px;
            stroke: var(--text-primary);
            stroke-width: 1.5;
            fill: none;
            margin-bottom: 12px;
        }
        .event-count {
            text-align: center;
            font-size: 0.85em;
            color: var(--text-secondary);
            padding: 16px 0;
        }

        @media (max-width: 600px) {
            .events-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }

        /* Clickable event items */
        .event-item {
            cursor: pointer;
        }
        .event-item:hover {
            opacity: 0.9;
        }

        /* Video Modal */
        .modal {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.9);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }
        .modal.active { display: flex; }
        .modal-content {
            max-width: 90vw;
            max-height: 90vh;
            position: relative;
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
        .modal-content video {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #000;
        }
        .modal-content video.loading {
            visibility: hidden;
        }
        /* Custom controls — replace iOS native overlay (pause button + dim
           that briefly shows when a <video controls> first plays). */
        .custom-controls {
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none;
        }
        .custom-tap-layer {
            position: absolute; inset: 0; z-index: 2; cursor: pointer;
            pointer-events: auto;
        }
        .custom-pause-indicator {
            position: absolute; top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            width: 72px; height: 72px; border-radius: 50%;
            background: rgba(0, 0, 0, 0.55); color: #fff;
            display: none; align-items: center; justify-content: center;
            z-index: 3; pointer-events: none;
            transition: opacity 0.15s ease-out; opacity: 0;
        }
        .custom-pause-indicator.visible { display: flex; opacity: 1; }
        .custom-scrub-bar {
            position: absolute; left: 0; right: 0; bottom: 0;
            display: flex; align-items: center; gap: 8px;
            padding: 8px 12px;
            background: linear-gradient(to top, rgba(0,0,0,0.6), rgba(0,0,0,0));
            z-index: 3; pointer-events: auto;
            color: #fff; font-size: 12px; font-variant-numeric: tabular-nums;
        }
        .custom-scrub-track {
            flex: 1; position: relative; height: 24px; cursor: pointer;
            display: flex; align-items: center;
        }
        .custom-scrub-track::before {
            content: ''; position: absolute; left: 0; right: 0; height: 3px;
            background: rgba(255, 255, 255, 0.3); border-radius: 2px;
        }
        .custom-scrub-fill {
            position: absolute; left: 0; height: 3px; width: 0;
            background: var(--accent, #6c63ff); border-radius: 2px;
        }
        .custom-scrub-thumb {
            position: absolute; width: 14px; height: 14px; border-radius: 50%;
            background: var(--accent, #6c63ff);
            transform: translateX(-50%);
            top: 50%; margin-top: -7px; left: 0;
        }
        .custom-time { min-width: 36px; text-align: center; }
        .modal-poster {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #000;
        }
        .modal-close {
            position: absolute;
            top: -40px; right: 0;
            background: none;
            border: none;
            color: white;
            font-size: 32px;
            cursor: pointer;
        }
        .modal-info {
            color: white;
            padding: 12px 0;
            text-align: center;
        }
        .modal-info span {
            display: block;
        }
        #modalTitle {
            font-size: 16px;
            font-weight: 500;
        }
        #modalBody {
            font-size: 14px;
            opacity: 0.9;
            margin-top: 4px;
        }
        #modalTime {
            font-size: 13px;
            opacity: 0.7;
            margin-top: 4px;
        }
        .modal-loading {
            color: white;
            font-size: 16px;
            padding: 40px;
        }
        .modal-nvr-btn {
            display: block;
            width: 100%;
            margin-top: 12px;
            padding: 12px 0;
            background: var(--accent, #6c63ff);
            color: #fff;
            border: none;
            border-radius: 10px;
            font-size: 14px;
            font-weight: 680;
            cursor: pointer;
            text-align: center;
        }
        .modal-nvr-btn:hover { filter: brightness(1.08); }
        .modal-status {
            color: white;
            font-size: 13px;
            opacity: 0.7;
            margin-top: 8px;
            text-align: center;
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
    </style>
</head>
<body>
    <header class="header">
        <a class="icon-btn launcher-link" href="/" title="Scrypted apps" aria-label="Scrypted apps">
            <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        </a>
        <span class="header-title" title="${pluginVersion ? `v${pluginVersion}` : 'Daily Brief'}">DAILY BRIEF</span>
        <button class="icon-btn" onclick="toggleTheme()" title="Toggle theme">
            <svg class="moon-icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            <svg class="sun-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        </button>
    </header>

    <div class="tab-bar">
        <button class="tab active" data-tab="brief">Brief</button>
        <button class="tab" data-tab="activity">Activity</button>
        <button class="tab" data-tab="people">People</button>
        <button class="tab" data-tab="llm-health">LLM Health</button>
    </div>

    <div id="brief-tab" class="tab-content">
    ${briefControlsHtml}
    <div class="content-wrapper">
    ${hasNarrative ? `
    <!-- New Timeline View -->
    ${overview ? `
    <div class="summary-section">
        <div class="summary-text">${escapeHtml(overview)}</div>
    </div>
    ` : ''}
    <div class="catchup-bar"><button class="catchup-btn" onclick="catchMeUp()">Catch Me Up</button></div>
    <div class="timeline-section">
        ${timelineHTML}
    </div>
    ` : summary ? `
    <!-- Legacy Summary + Highlights Grid -->
    <div class="summary-section">
        <div class="summary-text">${escapeHtml(summary)}</div>
    </div>
    ${highlights.length > 0 ? `
    <div class="highlights-section">
        <div class="highlights-label">Highlights</div>
        <div class="highlights-grid">
            ${highlightsHTML}
        </div>
    </div>
    ` : ''}
    ` : eventCount > 0 ? `
    <div class="summary-section">
        <div class="summary-text summary-generating">Generating summary...</div>
    </div>
    ` : ''}

    <main>
        ${eventCount === 0 ? `
            <div class="empty-state">
                <svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                <div>No notifications recorded for this day</div>
            </div>
        ` : `
            <div class="event-count">${eventCount} total events today</div>
        `}
    </main>
    </div>
    </div><!-- /brief-tab -->

    <div id="activity-tab" class="tab-content" style="display:none">
        <div class="gallery-container"></div>
    </div>

    <div id="people-tab" class="tab-content" style="display:none">
        <div class="people-container">
            <div class="people-grid"></div>
        </div>
    </div>

    <div id="llm-health-tab" class="tab-content" style="display:none">
        <div class="llm-health-container"></div>
    </div>

    <!-- Video Modal -->
    <div id="videoModal" class="modal" onclick="closeModal(event)">
        <div class="modal-content" onclick="event.stopPropagation()">
            <button class="modal-close" onclick="closeModal()">&times;</button>
            <div class="modal-media-container">
                <img id="modalPoster" class="modal-poster" style="display:none;">
                <video id="modalVideo" autoplay playsinline></video>
                <div id="replayOverlay" class="replay-overlay" style="display:none;" onclick="replayVideo()">
                    <button class="replay-btn">\u21BB</button>
                </div>
                <div id="customControls" class="custom-controls" style="display:none;">
                    <div id="customTapLayer" class="custom-tap-layer"></div>
                    <div id="customPauseIndicator" class="custom-pause-indicator">
                        <svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
                    </div>
                    <div id="customScrubBar" class="custom-scrub-bar" style="display:none;">
                        <span id="customCurTime" class="custom-time">0:00</span>
                        <div id="customScrubTrack" class="custom-scrub-track">
                            <div id="customScrubFill" class="custom-scrub-fill"></div>
                            <div id="customScrubThumb" class="custom-scrub-thumb"></div>
                        </div>
                        <span id="customDurTime" class="custom-time">0:00</span>
                    </div>
                </div>
            </div>
            <div class="modal-info">
                <span id="modalTitle"></span>
                <span id="modalBody"></span>
                <span id="modalTime"></span>
                <button id="modalNvrBtn" class="modal-nvr-btn" style="display:none">Open in NVR \u2197</button>
                <div id="modalStatus" class="modal-status"></div>
            </div>
        </div>
    </div>

    <script>
        try { CSS.registerProperty({ name: '--border-angle', syntax: '<angle>', initialValue: '0deg', inherits: false }); } catch(e) {}
        ${VIDEO_PLAYER_JS}
        ${GALLERY_JS}
        ${LLM_HEALTH_JS}
    </script>
    <script>
        function getPreferredTheme() {
            const saved = localStorage.getItem('dailyBriefTheme');
            if (saved) return saved;
            return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        }
        function setTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('dailyBriefTheme', theme);
        }
        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            setTheme(current === 'dark' ? 'light' : 'dark');
        }
        // Base URL for API calls (derived at runtime from current page URL)
        var baseUrl = window.location.pathname.replace(/\\/brief.*/, '');

        // Absolute Scrypted Cloud base URL (server-injected). Used by the NVR
        // timeline link so the URL works even when opened in a browser
        // without HA session cookies (iOS HA Companion -> Safari handoff).
        ${cloudBaseUrl ? `window.__cloudBaseUrl = ${JSON.stringify(cloudBaseUrl.replace(/\/+$/, ''))};` : '/* cloud base URL not available */'}

        // HA-route NVR timeline path (server-injected from haNvrTimelinePath
        // setting). Empty string -> openNvrTimeline falls back to the cloud URL.
        // When set, the "Open in NVR" button (Stories + per-event modal) routes
        // in-HA to a dashboard hosting scrypted-nvr-iframe-card.
        var haNvrTimelinePath = ${haNvrTimelinePath ? JSON.stringify(haNvrTimelinePath) : '""'};

        function catchMeUp() {
            var btn = event.target.closest('.catchup-btn');
            if (!btn) return;
            btn.classList.add('loading');
            btn.textContent = 'Updating';
            window.location.href = baseUrl + '/brief?mode=incremental';
        }
        function refreshSummary() {
            window.location.href = baseUrl + '/brief?refresh=true';
        }
${dateNavScript}

        // Shared URL builder (used by VideoPlayer and Gallery)
        function buildUrl(path, params) {
            var url = baseUrl + path;
            var qs = new URLSearchParams(params || {});
            return qs.toString() ? url + '?' + qs.toString() : url;
        }

        // Client-side HTML escaping for dynamic content
        function esc(s) {
            var d = document.createElement('div');
            d.appendChild(document.createTextNode(s));
            return d.innerHTML.replace(/"/g, '&quot;');
        }

        // Resolve poster thumbnail URLs at runtime using baseUrl
        document.querySelectorAll('img[data-poster-id]').forEach(function(img) {
            var id = img.getAttribute('data-poster-id');
            if (id) img.src = buildUrl('/brief/snapshot', { id: id });
        });

        // NVR timeline URL builder — swaps plugin path for NVR path
        // Prefers the absolute Scrypted Cloud URL when available (set
        // server-side via window.__cloudBaseUrl). Cloud URL has a
        // self-contained token so the NVR loads even when the link is
        // opened in a browser without HA cookies (iOS HA Companion hands
        // external links to Safari, which lacks the HA session cookie —
        // that breaks the relative HA-proxy URL on iPhone but not Mac).
        // Falls back to relative path-rewrite when cloud URL is not
        // available (works on LAN access via local Scrypted host).
        // Uses the raw event timestamp (no offset). A previous version
        // subtracted 5s for pre-roll, but on cameras without continuous
        // recording the offset put the time param outside the recording
        // window and NVR returned "recording not available".
        function buildNvrTimelineUrl(cameraId, timestamp) {
            var re = new RegExp('(.*\\/endpoint\\/)[^/]+\\/[^/]+');
            var base = (typeof window.__cloudBaseUrl === 'string' && window.__cloudBaseUrl)
                ? window.__cloudBaseUrl
                : baseUrl;
            var nvrBase = base.replace(re, '$1@scrypted/nvr/public');
            return nvrBase + '/#/timeline/' + encodeURIComponent(cameraId) + '?time=' + Number(timestamp);
        }

        // Shared "Open in NVR" router — used by BOTH the Activity ▸ Stories detail
        // button and the per-event video-modal button (Stories-style treatment).
        // When iframed, route via the parent bridge — kind:'ha' to the NVR iframe
        // card when haNvrTimelinePath is set (in-HA, cellular-safe), else
        // kind:'cloud'; plain window.open when standalone (no iframe parent).
        function openNvrTimeline(cameraId, timeMs) {
            if (window.parent !== window) {
                if (haNvrTimelinePath) {
                    var sep = haNvrTimelinePath.indexOf('?') >= 0 ? '&' : '?';
                    var haUrl = haNvrTimelinePath + sep + 'camera=' + encodeURIComponent(cameraId) + '&time=' + Number(timeMs);
                    window.parent.postMessage({ type: 'daily-brief-open-nvr', url: haUrl, kind: 'ha' }, _parentOrigin || '*');
                } else {
                    window.parent.postMessage({ type: 'daily-brief-open-nvr', url: buildNvrTimelineUrl(cameraId, timeMs), kind: 'cloud' }, _parentOrigin || '*');
                }
            } else {
                window.open(buildNvrTimelineUrl(cameraId, timeMs), 'scrypted-nvr');
            }
        }

        // Wire the modal "Open in NVR" button to the shared openNvrTimeline
        // router (same path the Stories detail button uses). The router decides
        // HA-iframe-card vs cloud at click time from haNvrTimelinePath, and posts
        // through the parent bridge so the 'scrypted-nvr' named target / in-app HA
        // navigation behaves identically to Stories. A -5000ms pre-roll matches
        // the in-modal video anchor (notification.timestamp - 5000) so the NVR
        // scrubber lands at the lead-up, not the analyzer's late detection epoch.
        (function wireNvrButton() {
            var btn = document.getElementById('modalNvrBtn');
            if (!btn) return;
            btn.addEventListener('click', function() {
                if (!currentCameraId || !currentTimestamp) return;
                var preRollMs = 5000;
                openNvrTimeline(currentCameraId, Number(currentTimestamp) - preRollMs);
            });
        })();

        // Event delegation for timeline/highlight items (avoids inline onclick XSS)
        document.addEventListener('click', function(e) {
            var item = e.target.closest('[data-event-id]');
            if (!item) return;
            var id = item.getAttribute('data-event-id');
            var title = item.getAttribute('data-event-title');
            var body = item.getAttribute('data-event-body');
            var time = item.getAttribute('data-event-time');
            var cameraId = item.getAttribute('data-camera-id');
            var timestamp = item.getAttribute('data-timestamp');
            if (id) openVideoModal(id, title || '', body || '', time || '', cameraId, timestamp);
        });

        // Shared VideoPlayer instance
        var player = new VideoPlayer({
            videoEl: document.getElementById('modalVideo'),
            posterEl: document.getElementById('modalPoster'),
            replayOverlay: document.getElementById('replayOverlay'),
            statusFn: function(msg) {
                var el = document.getElementById('modalStatus');
                if (el) el.textContent = msg || '';
            },
            buildUrl: buildUrl,
            logPrefix: '[WebRTC]'
        });

        // Recording-clip duration constant — kept in sync with the server's
        // getRecordingStream({ duration }) call (src/main.ts). WebRTC's video
        // element reports duration=Infinity for live streams, so we fall back
        // to this when displaying progress / total time on the scrub bar.
        window.__videoExpectedDurationSec = 25;

        // Custom video controls — replace iOS native overlay (pause + dim flash
        // that briefly shows when <video controls> first plays). Tap toggles
        // play/pause; scrub bar shown for HTTP playback (finite duration).
        (function setupCustomControls() {
            var video = document.getElementById('modalVideo');
            var controlsEl = document.getElementById('customControls');
            var tapLayer = document.getElementById('customTapLayer');
            var pauseInd = document.getElementById('customPauseIndicator');
            var scrubBar = document.getElementById('customScrubBar');
            var scrubTrack = document.getElementById('customScrubTrack');
            var scrubFill = document.getElementById('customScrubFill');
            var scrubThumb = document.getElementById('customScrubThumb');
            var curTime = document.getElementById('customCurTime');
            var durTime = document.getElementById('customDurTime');
            if (!video || !tapLayer) return;

            function fmt(s) {
                if (!isFinite(s) || s < 0) return '0:00';
                var m = Math.floor(s / 60);
                var sec = Math.floor(s % 60);
                return m + ':' + (sec < 10 ? '0' : '') + sec;
            }

            tapLayer.addEventListener('click', function() {
                if (video.paused) video.play().catch(function() {});
                else video.pause();
            });

            // Track expected duration for WebRTC clips (live streams report
            // Infinity for video.duration even though the underlying clip is
            // finite). Set externally via window.__videoExpectedDurationSec.
            function getExpectedDuration() {
                if (isFinite(video.duration) && video.duration > 0) return video.duration;
                if (typeof window.__videoExpectedDurationSec === 'number' && window.__videoExpectedDurationSec > 0) {
                    return window.__videoExpectedDurationSec;
                }
                return 0;
            }
            function canSeek() {
                return isFinite(video.duration) && video.duration > 0;
            }

            video.addEventListener('play', function() {
                pauseInd.classList.remove('visible');
            });
            video.addEventListener('pause', function() {
                if (video.currentTime > 0 && !video.ended) {
                    pauseInd.classList.add('visible');
                }
            });
            video.addEventListener('playing', function() {
                controlsEl.style.display = 'block';
                scrubBar.style.display = 'flex';
                var dur = getExpectedDuration();
                durTime.textContent = dur > 0 ? fmt(dur) : '--';
                // Disabled-look when seek is not available (live / WebRTC).
                scrubTrack.style.cursor = canSeek() ? 'pointer' : 'default';
                scrubThumb.style.opacity = canSeek() ? '1' : '0.5';
            });
            video.addEventListener('timeupdate', function() {
                var dur = getExpectedDuration();
                if (dur <= 0) return;
                var pct = Math.min(100, (video.currentTime / dur) * 100);
                scrubFill.style.width = pct + '%';
                scrubThumb.style.left = pct + '%';
                curTime.textContent = fmt(video.currentTime);
            });

            function seekFromEvent(evt) {
                if (!canSeek()) return;
                var rect = scrubTrack.getBoundingClientRect();
                var clientX = (evt.touches && evt.touches[0]) ? evt.touches[0].clientX : evt.clientX;
                var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                video.currentTime = pct * video.duration;
            }
            scrubTrack.addEventListener('click', seekFromEvent);
            var dragging = false;
            scrubTrack.addEventListener('mousedown', function(e) { if (!canSeek()) return; dragging = true; seekFromEvent(e); });
            window.addEventListener('mousemove', function(e) { if (dragging) seekFromEvent(e); });
            window.addEventListener('mouseup', function() { dragging = false; });
            scrubTrack.addEventListener('touchstart', function(e) { if (!canSeek()) return; dragging = true; seekFromEvent(e); }, { passive: true });
            scrubTrack.addEventListener('touchmove', function(e) { if (dragging) seekFromEvent(e); }, { passive: true });
            scrubTrack.addEventListener('touchend', function() { dragging = false; });
        })();

        // Store current modal metadata for display + the "Open in NVR" button
        var currentTitle = null;
        var currentBody = null;
        var currentTime = null;
        var currentCameraId = null;
        var currentTimestamp = null;

        async function openVideoModal(notificationId, title, body, time, cameraId, timestamp) {
            var modal = document.getElementById('videoModal');
            document.getElementById('modalTitle').textContent = title;
            document.getElementById('modalBody').textContent = body;
            document.getElementById('modalTime').textContent = time;

            // Show the "Open in NVR" button when we know which camera + moment to
            // open. Routing (HA iframe card vs cloud) and the -5000ms pre-roll are
            // handled by the button's click handler (wireNvrButton → openNvrTimeline);
            // stash the camera + timestamp here for it to read.
            currentCameraId = cameraId || null;
            currentTimestamp = timestamp || null;
            var nvrBtn = document.getElementById('modalNvrBtn');
            if (nvrBtn) nvrBtn.style.display = (cameraId && timestamp) ? '' : 'none';

            currentTitle = title;
            currentBody = body;
            currentTime = time;

            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
            // Pre-position as absolute before postMessage round-trip (prevents flash)
            if (window.parent !== window) {
                var scrollTop = window.scrollY || document.documentElement.scrollTop;
                modal.style.position = 'absolute';
                modal.style.top = scrollTop + 'px';
                modal.style.height = window.innerHeight + 'px';
                modal.style.bottom = 'auto';
            }
            notifyParentModal('open');
            await player.openVideo(notificationId);
        }

        function replayVideo() {
            player.replay();
        }

        function closeModal(event) {
            if (event && event.target !== event.currentTarget) return;
            player.close();
            var modal = document.getElementById('videoModal');
            modal.classList.remove('active');
            modal.style.position = '';
            modal.style.top = '';
            modal.style.height = '';
            modal.style.bottom = '';
            document.body.style.overflow = '';
            // Reset custom controls so the next open starts clean
            var ce = document.getElementById('customControls');
            var pi = document.getElementById('customPauseIndicator');
            var sb = document.getElementById('customScrubBar');
            if (ce) ce.style.display = 'none';
            if (pi) pi.classList.remove('visible');
            if (sb) sb.style.display = 'none';
            notifyParentModal('close');
        }

        // Notify parent iframe to lock/unlock height for modal
        function notifyParentModal(state) {
            if (window.parent === window) return;
            window.parent.postMessage({ type: 'daily-brief-modal', state: state }, _parentOrigin || '*');
        }

        // Listen for viewport geometry from parent (iframe modal positioning)
        var _parentOrigin = null;
        window.addEventListener('message', function(evt) {
            if (evt.data && evt.data.type === 'daily-brief-viewport') {
                // Validate origin: only accept from known parent (first sender wins)
                if (!_parentOrigin) _parentOrigin = evt.origin;
                if (evt.origin !== _parentOrigin) return;
                var modal = document.getElementById('videoModal');
                var scrollTop = window.scrollY || document.documentElement.scrollTop;
                var visibleTop = Math.max(0, scrollTop - evt.data.iframeTop);
                modal.style.position = 'absolute';
                modal.style.top = visibleTop + 'px';
                modal.style.height = evt.data.viewportHeight + 'px';
                modal.style.bottom = 'auto';
            }
        });

        // Close on Escape key
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeModal();
        });

        // Auto-detect and send browser timezone to server
        (function() {
            try {
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (tz) {
                    fetch(baseUrl + '/brief/set-timezone?tz=' + encodeURIComponent(tz), { method: 'POST' });
                }
            } catch (e) {}
        })();
        function getSortOrder() {
            try {
                var val = localStorage.getItem('briefSortOrder');
                return (val === 'oldest' || val === 'newest') ? val : 'newest';
            } catch (e) { return 'newest'; }
        }
        function applySortOrder(order) {
            document.documentElement.setAttribute('data-sort', order);
            try { localStorage.setItem('briefSortOrder', order); } catch (e) {}
            // Sort timeline segments by data-index (stable, works on repeated calls)
            var timelineSection = document.querySelector('.timeline-section');
            if (timelineSection) {
                var segments = Array.from(timelineSection.querySelectorAll('.timeline-segment'));
                segments.sort(function(a, b) {
                    var ai = parseInt(a.getAttribute('data-index') || '0', 10);
                    var bi = parseInt(b.getAttribute('data-index') || '0', 10);
                    return order === 'newest' ? bi - ai : ai - bi;
                });
                var frag = document.createDocumentFragment();
                segments.forEach(function(s) { frag.appendChild(s); });
                timelineSection.appendChild(frag);
            }
            // Sort standalone highlights grid items
            var grid = document.querySelector('.highlights-grid');
            if (grid) {
                var items = Array.from(grid.querySelectorAll('.event-item'));
                items.sort(function(a, b) {
                    var ai = parseInt(a.getAttribute('data-index') || '0', 10);
                    var bi = parseInt(b.getAttribute('data-index') || '0', 10);
                    return order === 'newest' ? bi - ai : ai - bi;
                });
                var frag2 = document.createDocumentFragment();
                items.forEach(function(i) { frag2.appendChild(i); });
                grid.appendChild(frag2);
            }
        }
        function toggleSortOrder() {
            var current = getSortOrder();
            applySortOrder(current === 'newest' ? 'oldest' : 'newest');
        }
        // Framed (HA card iframe): hide the launcher link. Its href="/" would
        // resolve to the HA origin and a click replaces this iframe with HA's
        // own dashboard — and there is no Scrypted launcher there to reach.
        // This runs FIRST in the init sequence: the calls below touch
        // localStorage, which can throw and abort the rest of the block, and
        // the hide must not be lost to that (nor paint before hiding).
        if (window.parent !== window) {
            var launcherLink = document.querySelector('.launcher-link');
            if (launcherLink) {
                launcherLink.style.display = 'none';
            }
        }

        setTheme(getPreferredTheme());
        applySortOrder(getSortOrder());

        // Sticky offsets: measure actual header height, set tab bar top
        (function() {
            var header = document.querySelector('.header');
            var tabBar = document.querySelector('.tab-bar');
            if (header && tabBar) {
                tabBar.style.top = header.offsetHeight + 'px';
            }
        })();

        // ---- Gallery tab integration ----
        var galleryInitialized = false;
        var gallery = null;

        // Inject Gallery CSS
        (function() {
            if (typeof Gallery !== 'undefined' && Gallery.CSS) {
                var s = document.createElement('style');
                s.textContent = Gallery.CSS;
                document.head.appendChild(s);
            }
        })();

        // Tab switching
        document.querySelectorAll('.tab').forEach(function(tab) {
            tab.onclick = function() {
                document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
                document.querySelectorAll('.tab-content').forEach(function(c) { c.style.display = 'none'; });
                tab.classList.add('active');
                var target = tab.getAttribute('data-tab');
                var targetEl = document.getElementById(target + '-tab');
                if (targetEl) targetEl.style.display = '';
                // Activity tab → the Events gallery
                if (target === 'activity') {
                    initGalleryOnce();
                }
                // Lazy-init people
                if (target === 'people' && !peopleLoaded) {
                    peopleLoaded = true;
                    loadPeople();
                }
                // Lazy-init LLM Health
                if (target === 'llm-health' && !llmHealthInstance) {
                    var healthContainer = document.querySelector('.llm-health-container');
                    if (typeof LlmHealth === 'undefined') {
                        healthContainer.innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-primary)">LLM Health failed to load.</p>';
                    } else {
                        try {
                            llmHealthInstance = new LlmHealth({ containerEl: healthContainer, buildUrl: buildUrl });
                            llmHealthInstance.init();
                        } catch (err) {
                            console.error('[LLM Health] Init failed:', err);
                            healthContainer.innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-primary)">LLM Health init failed.</p>';
                        }
                    }
                }
                // Update URL without reload
                var url = new URL(window.location);
                url.searchParams.set('tab', target);
                window.history.replaceState({}, '', url);
            };
        });

        function initGalleryOnce() {
            if (galleryInitialized) return;
            galleryInitialized = true;
            var containerEl = document.querySelector('.gallery-container');
            if (typeof Gallery === 'undefined') {
                containerEl.innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-primary)">Gallery failed to load. Please refresh the page.</p>';
                return;
            }
            try {
                gallery = new Gallery({
                    containerEl: containerEl,
                    player: player,
                    buildUrl: buildUrl,
                    formatTime: function(ts) {
                        return new Date(ts).toLocaleString('en-US', {
                            month: 'short', day: 'numeric',
                            hour: 'numeric', minute: '2-digit', hour12: true
                        });
                    },
                    onCardClick: function(id, title, body, time, cameraId, timestamp) {
                        openVideoModal(id, title, body, time, cameraId, timestamp);
                    }
                });
                gallery.init();
            } catch (err) {
                console.error('[Gallery] Init failed:', err);
                containerEl.innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-primary)">Gallery initialization failed.</p>';
            }
        }

        document.addEventListener('click', function(e) {
            var btn = e.target.closest('.person-delete');
            if (!btn) return;
            var name = btn.getAttribute('data-person-name');
            if (!name || !confirm('Delete reference photo for "' + name + '"?')) return;
            fetch(buildUrl('/brief/people/delete', { name: name }), { method: 'POST' })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.ok) loadPeople();
                })
                .catch(function(err) { console.error('[People] Delete failed:', err); });
        });

        var peopleLoaded = false;
        var llmHealthInstance = null;
        function loadPeople() {
            var grid = document.querySelector('.people-grid');
            grid.innerHTML = '<div class="people-empty">Loading...</div>';
            fetch(buildUrl('/brief/people'))
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (!data.people || data.people.length === 0) {
                        grid.innerHTML = '<div class="people-empty">No reference photos yet. Enable LLM Person Identification in settings to auto-curate reference photos from face detections.</div>';
                        return;
                    }
                    grid.innerHTML = data.people.map(function(p) {
                        return '<div class="person-card">'
                            + '<img src="' + buildUrl('/brief/people/photo', { name: p.name }) + '" alt="' + esc(p.name) + '" loading="lazy">'
                            + '<div class="person-info">'
                            + '<div class="person-name">' + esc(p.name) + '</div>'
                            + '<div class="person-meta">' + (p.faceReferenceScore ? 'Face: ' + p.faceReferenceScore + '/10' : 'Clarity: ' + p.clarityScore + '/10')
                            + (p.cameraName ? ' &middot; ' + esc(p.cameraName) : '') + '</div>'
                            + '<button class="person-delete" data-person-name="' + esc(p.name) + '">Delete</button>'
                            + '</div></div>';
                    }).join('');
                })
                .catch(function(err) {
                    console.error('[People] Load failed:', err);
                    grid.innerHTML = '<div class="people-empty">Failed to load reference photos.</div>';
                    peopleLoaded = false;
                });
        }

        // Check URL for ?tab= on load
        (function() {
            var params = new URLSearchParams(window.location.search);
            var tab = params.get('tab');
            var deepLinkId = params.get('id');
            var deepLinkGroupId = params.get('groupId');

            // Deep link to a group: switch to Gallery tab and drill into the
            // group's hero view once the gallery initializes. Bail out if the
            // user navigates to a different tab during the poll window.
            if (deepLinkGroupId) {
                var gTab = document.querySelector('.tab[data-tab="activity"]');
                if (gTab) gTab.click();
                var groupAttempts = 0;
                var groupPoll = setInterval(function() {
                    groupAttempts++;
                    if (groupAttempts > 50) { clearInterval(groupPoll); return; }
                    var galleryTabActive = document.querySelector('.tab[data-tab="activity"].active');
                    if (!galleryTabActive) { clearInterval(groupPoll); return; }
                    // Wait for the gallery's initial page fetch to settle before
                    // drilling — _drillIntoGroup early-returns if _loading is true,
                    // so calling it on the first tick (while _fetchPage is in flight)
                    // silently no-ops and the user sees the normal gallery list.
                    if (gallery && typeof gallery._drillIntoGroup === 'function' && !gallery._loading) {
                        clearInterval(groupPoll);
                        gallery._drillIntoGroup(deepLinkGroupId);
                    }
                }, 100);
                return;
            }

            // Deep link to a specific gallery entry: switch to Gallery tab and
            // open that card's modal once the card renders. Bounded polling so
            // we fail gracefully if the notification has scrolled off page 1.
            if (deepLinkId) {
                var gTab = document.querySelector('.tab[data-tab="activity"]');
                if (gTab) gTab.click();
                var attempts = 0;
                var poll = setInterval(function() {
                    attempts++;
                    if (attempts > 50) { clearInterval(poll); return; }
                    var cards = document.querySelectorAll('.gallery-card');
                    for (var i = 0; i < cards.length; i++) {
                        if (cards[i].getAttribute('data-id') === deepLinkId) {
                            var match = cards[i];
                            clearInterval(poll);
                            match.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            setTimeout(function() { match.click(); }, 200);
                            return;
                        }
                    }
                }, 100);
                return;
            }

            if (tab === 'gallery' || tab === 'activity') {
                var galleryTab = document.querySelector('.tab[data-tab="activity"]');
                if (galleryTab) galleryTab.click();
            } else if (tab === 'people') {
                var peopleTab = document.querySelector('.tab[data-tab="people"]');
                if (peopleTab) peopleTab.click();
            } else if (tab === 'llm-health') {
                var healthTab = document.querySelector('.tab[data-tab="llm-health"]');
                if (healthTab) healthTab.click();
            }
        })();
    </script>
</body>
</html>`;
}
