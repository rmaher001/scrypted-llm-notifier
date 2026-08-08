/**
 * Brief header → Scrypted launcher link.
 *
 * The plugin registers itself in the Scrypted launcher (applicationInfo in
 * main.ts), so the launcher can reach the Brief — but the Brief had no way
 * back. UX report (2026-08-08): from the Daily Brief there is no affordance to
 * pop the launcher and switch to another app (Management Console, NVR, other
 * plugins).
 *
 * href="/" is correct ONLY when the Brief is viewed directly on the Scrypted
 * origin. Inside the HA card the Brief is iframed from the HA origin, where
 * "/" is HA's own dashboard root and a click replaces the iframe with HA's UI.
 * The framed guard tested below is therefore a REQUIRED companion to the
 * link, not optional polish — deleting it re-breaks the HA integration.
 *
 * Constraints (feedback_no_inline_onclick_in_templates): the anchor itself is
 * plain markup — no onclick; the framed guard lives in the page's existing
 * init script.
 */

export {};

const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');

function render(): string {
    return generateDailyBriefHTML(
        3,                       // eventCount
        'summary',               // summary
        [],                      // highlights
        1749000000000,           // generatedAt (fixed)
        'America/Los_Angeles',   // timezone
        'overview',              // overview
        [],                      // narrative
        '0.3.999',               // pluginVersion
    );
}

describe('brief header launcher link', () => {
    it('renders a link to the Scrypted launcher at the server root', () => {
        const html = render();
        expect(html).toMatch(/<a[^>]*class="[^"]*launcher-link[^"]*"[^>]*href="\/"/);
    });

    it('places the link inside the header', () => {
        const html = render();
        const header = html.match(/<header class="header">([\s\S]*?)<\/header>/)?.[1] ?? '';
        expect(header).toContain('launcher-link');
    });

    it('labels it for screen readers and hover', () => {
        const html = render();
        const link = html.match(/<a[^>]*launcher-link[^>]*>/)?.[0] ?? '';
        expect(link).toMatch(/title="Scrypted apps"/);
        expect(link).toMatch(/aria-label="Scrypted apps"/);
    });

    it('carries no inline event handlers', () => {
        const html = render();
        const link = html.match(/<a[^>]*launcher-link[^>]*>/)?.[0] ?? '';
        // Guard against vacuous pass: an absent link matches nothing and ''
        // trivially contains no onclick.
        expect(link).not.toBe('');
        expect(link).not.toMatch(/onclick=/);
    });

    it('strips the underline an <a> gets that .icon-btn (built for <button>) never needed', () => {
        const html = render();
        expect(html).toContain('a.launcher-link { text-decoration: none; }');
    });

    it('hides itself when the Brief is framed (HA card iframes it from the HA origin)', () => {
        // Inside the HA card, href="/" resolves to the HA dashboard root and a
        // click replaces the Brief iframe with HA's own UI — and there is no
        // Scrypted launcher to reach from there anyway. The page already
        // detects framing via `window.parent !== window`; the launcher link
        // must be hidden behind the same guard. Exact selector and property
        // strings, so a typo'd querySelector or style key fails here.
        const html = render();
        const framedGuards = html.match(/if \(window\.parent !== window\) \{[\s\S]*?\}/g) ?? [];
        const hideGuard = framedGuards.find(g => g.includes('launcher-link'));
        expect(hideGuard).toBeDefined();
        expect(hideGuard).toContain("document.querySelector('.launcher-link')");
        expect(hideGuard).toContain(".style.display = 'none'");
    });

    it('runs the framed hide before anything that can throw (localStorage init)', () => {
        // The hide shares one <script> block with theme/sort init, and those
        // touch localStorage, which can throw (e.g. blocked storage) and abort
        // the rest of the block. If the hide ran after them, a storage throw
        // would leave the link visible and clickable inside HA — the exact
        // failure the guard exists to prevent. It must come first.
        const html = render();
        const guardAt = html.indexOf("document.querySelector('.launcher-link')");
        const themeInitAt = html.indexOf('setTheme(getPreferredTheme())');
        expect(guardAt).toBeGreaterThan(-1);
        expect(themeInitAt).toBeGreaterThan(-1);
        expect(guardAt).toBeLessThan(themeInitAt);
    });
});
