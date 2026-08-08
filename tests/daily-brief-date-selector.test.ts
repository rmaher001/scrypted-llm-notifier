/**
 * Daily Brief date selector (header control).
 *
 * The /brief route already renders for an arbitrary ?date=YYYY-MM-DD (main.ts
 * parses it into targetDate). This adds the missing UI affordance: a bounded
 * native date input flanked by prev/next-day arrows in the brief header, so the
 * user can navigate to a past day's brief. Picking a date / pressing an arrow
 * reloads `${baseUrl}/brief?date=YYYY-MM-DD` — no new backend logic.
 *
 * Constraints (feedback_no_inline_onclick_in_templates): controls use data-
 * attributes + addEventListener, and the script reuses the existing `baseUrl`
 * var — NO inline onclick, NO new regex literals inside the <script> template.
 */

// Force module scope: this file uses `require` with no import/export, which
// makes it a global "script". Another script-mode test (activity-tab.test.ts)
// also declares `const generateDailyBriefHTML` at top level; when ts-jest
// co-locates both in one worker they collide (TS2451). `export {}` makes each
// a module so its top-level consts are module-scoped.
export {};

const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');

// Mirrors the production call (main.ts /brief route) with the three new
// date-selector params appended: selectedDate, minDate, maxDate (all
// timezone-aware YYYY-MM-DD strings).
function render(selectedDate: string, minDate: string, maxDate: string): string {
    return generateDailyBriefHTML(
        3,                       // eventCount
        'summary',               // summary
        [],                      // highlights
        1749000000000,           // generatedAt (fixed)
        'America/Los_Angeles',   // timezone
        'overview',              // overview
        [],                      // narrative
        '0.3.999',               // pluginVersion
        undefined,               // cloudBaseUrl
        undefined,               // haNvrTimelinePath
        selectedDate,            // NEW
        minDate,                 // NEW
        maxDate,                 // NEW
    );
}

describe('daily brief date selector', () => {
    it('renders a native date input seeded with the selected date and bounded by min/max', () => {
        const html = render('2026-06-10', '2026-06-09', '2026-06-12');
        expect(html).toMatch(/<input[^>]*type="date"[^>]*>/);
        expect(html).toMatch(/<input[^>]*type="date"[^>]*value="2026-06-10"/);
        expect(html).toMatch(/<input[^>]*type="date"[^>]*min="2026-06-09"/);
        expect(html).toMatch(/<input[^>]*type="date"[^>]*max="2026-06-12"/);
    });

    it('renders prev and next day arrows wired by data-attribute (no inline onclick)', () => {
        const html = render('2026-06-10', '2026-06-09', '2026-06-12');
        expect(html).toMatch(/data-date-nav="prev"/);
        expect(html).toMatch(/data-date-nav="next"/);
        // The arrow buttons themselves must not carry an inline onclick handler.
        expect(html).not.toMatch(/data-date-nav="[^"]*"[^>]*onclick=/);
    });

    it('navigates to /brief?date= when the date changes', () => {
        const html = render('2026-06-10', '2026-06-09', '2026-06-12');
        expect(html).toContain('/brief?date=');
    });

    it('disables the next arrow when the selected date is the max (today)', () => {
        const html = render('2026-06-12', '2026-06-09', '2026-06-12');
        expect(html).toMatch(/data-date-nav="next"[^>]*\bdisabled\b|\bdisabled\b[^>]*data-date-nav="next"/);
    });

    it('disables the prev arrow when the selected date is the min (oldest available)', () => {
        const html = render('2026-06-09', '2026-06-09', '2026-06-12');
        expect(html).toMatch(/data-date-nav="prev"[^>]*\bdisabled\b|\bdisabled\b[^>]*data-date-nav="prev"/);
    });

    it('does not render the date selector when date params are absent (back-compat)', () => {
        const html = generateDailyBriefHTML(3, 'summary', [], 1749000000000, 'America/Los_Angeles');
        expect(html).not.toMatch(/data-date-nav=/);
    });

    it('injects a date-nav script that parses as valid JS (no template-literal corruption)', () => {
        // Guards feedback_no_inline_onclick_in_templates: a stray regex literal or
        // escaped quote inside the <script> template would survive string assertions
        // but throw a SyntaxError in the browser. new Function() parses (does not run)
        // the body, so free globals (document/window/baseUrl) are fine; corruption throws.
        const html = render('2026-06-10', '2026-06-09', '2026-06-12');
        const m = html.match(/\(function\(\) \{\s*var briefDateInput[\s\S]*?\}\)\(\);/);
        expect(m).toBeTruthy();
        // eslint-disable-next-line no-new-func
        expect(() => new Function('baseUrl', m![0])).not.toThrow();
    });
});

describe('daily brief controls live under the Brief tab (not the global header)', () => {
    const withNav = () => render('2026-06-13', '2026-06-10', '2026-06-13');
    function headerOf(html: string): string {
        const m = html.match(/<header class="header">([\s\S]*?)<\/header>/);
        return m ? m[1] : '';
    }

    it('the global header holds only the title + the (global) theme toggle', () => {
        const h = headerOf(withNav());
        expect(h).toContain('DAILY BRIEF');
        expect(h).toMatch(/toggleTheme\(\)/);
        // Brief-only controls must NOT be in the global header anymore.
        expect(h).not.toMatch(/data-date-nav/);
        expect(h).not.toMatch(/refreshSummary\(\)/);
        expect(h).not.toMatch(/toggleSortOrder\(\)/);
    });

    it('renders a Brief-tab control bar carrying the date scrubber, regen, and sort', () => {
        const html = withNav();
        expect(html).toMatch(/class="brief-controls"/);
        expect(html).toMatch(/data-date-nav="prev"/);
        expect(html).toMatch(/refreshSummary\(\)/);
        expect(html).toMatch(/toggleSortOrder\(\)/);
    });

    it('shows the version as a hover tooltip on the title, not as visible header text', () => {
        const html = withNav();
        expect(html).toMatch(/class="header-title"[^>]*title="v0\.3\.999"/);
        expect(html).not.toMatch(/class="header-ver"/);
        expect(html).not.toMatch(/class="header-meta"/);
    });
});

describe('parseBriefDate — timezone-safe ?date= parsing (fixes 6/11 → 6/10)', () => {
    // Import the pure helper; the existing daily-brief-overview test imports from
    // ../src/main the same way (jest maps @scrypted/sdk to a mock).
    const { parseBriefDate } = require('../src/main');

    it('anchors the calendar day at noon UTC (instant is machine-timezone-invariant)', () => {
        // The bug: `new Date("2026-06-11T00:00:00")` is parsed in the SERVER's local
        // zone (UTC on the Linux host) = 2026-06-11T00:00:00Z, which a downstream
        // toLocaleDateString('America/Los_Angeles') renders as 2026-06-10. Anchoring
        // at noon UTC keeps the day correct for any display zone within UTC±12.
        expect(parseBriefDate('2026-06-11').toISOString()).toBe('2026-06-11T12:00:00.000Z');
    });

    it('preserves the requested calendar day in behind-UTC display zones (the reported bug)', () => {
        const d = parseBriefDate('2026-06-11');
        expect(d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })).toBe('2026-06-11');
        expect(d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })).toBe('2026-06-11');
    });

    it('preserves the requested calendar day at UTC and ahead-of-UTC zones (≤ +11)', () => {
        const d = parseBriefDate('2026-06-11');
        expect(d.toLocaleDateString('en-CA', { timeZone: 'UTC' })).toBe('2026-06-11');
        expect(d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })).toBe('2026-06-11'); // +9
    });
});

describe('daily brief /brief route wires the date selector', () => {
    const fs = require('fs');
    const path = require('path');
    const mainSrc: string = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf-8');

    it('forwards selectedDate, minDate, maxDate to generateDailyBriefHTML', () => {
        const idx = mainSrc.indexOf('generateDailyBriefHTML(');
        expect(idx).toBeGreaterThan(-1);
        const region = mainSrc.slice(idx, idx + 900);
        expect(region).toMatch(/selectedDate/);
        expect(region).toMatch(/minDate/);
        expect(region).toMatch(/maxDate/);
    });

    it('derives the minDate lower bound from retentionDays', () => {
        // Lower bound = today - retentionDays, so every selectable day has full
        // timeline + image data (narratives survive longer, but the timeline does not).
        expect(mainSrc).toMatch(/minDate[\s\S]{0,240}retentionDays|retentionDays[\s\S]{0,240}minDate/);
    });
});
