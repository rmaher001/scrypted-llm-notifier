import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadCardHelpers(): any {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'ha-card', 'scrypted-nvr-iframe-card.js'),
        'utf8',
    );
    const sandbox: any = {
        window: { customCards: [] },
        document: { createElement: () => ({}) },
        customElements: { define: () => {} },
        HTMLElement: class { attachShadow() { return {}; } },
        console,
        URLSearchParams,
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.__scryptedNvrIframeCardHelpers;
}

describe('substituteUrlTemplate', () => {
    let helpers: any;
    beforeAll(() => { helpers = loadCardHelpers(); });

    it('replaces {camera} and {time} with URL-encoded values', () => {
        const out = helpers.substituteUrlTemplate(
            'https://nvr.example.com/timeline/{camera}?time={time}',
            { camera: '694', time: '1777832465226' },
        );
        expect(out).toBe('https://nvr.example.com/timeline/694?time=1777832465226');
    });

    it('URL-encodes camera id with special chars', () => {
        const out = helpers.substituteUrlTemplate(
            'https://nvr.example.com/timeline/{camera}',
            { camera: 'cam id/with spaces', time: '1' },
        );
        expect(out).toBe('https://nvr.example.com/timeline/cam%20id%2Fwith%20spaces');
    });

    it('returns null when a referenced placeholder has no value', () => {
        const out = helpers.substituteUrlTemplate(
            'https://nvr.example.com/timeline/{camera}?time={time}',
            { camera: '694', time: '' },
        );
        expect(out).toBeNull();
    });

    it('returns null when the params object is missing a key the template references', () => {
        const out = helpers.substituteUrlTemplate(
            'https://nvr.example.com/timeline/{camera}?time={time}',
            { camera: '694' },
        );
        expect(out).toBeNull();
    });

    it('ignores params whose placeholder is not in the template', () => {
        const out = helpers.substituteUrlTemplate(
            'https://nvr.example.com/timeline/{camera}',
            { camera: '694', time: '12345' },
        );
        expect(out).toBe('https://nvr.example.com/timeline/694');
    });

    it('returns the template unchanged when there are no placeholders', () => {
        const out = helpers.substituteUrlTemplate(
            'https://nvr.example.com/static',
            {},
        );
        expect(out).toBe('https://nvr.example.com/static');
    });
});

describe('iframe sizing CSS', () => {
    // Mobile bottom-nav regression: iframe height was 100vh which is the parent
    // document's full viewport. Inside an HA YAML-mode panel view, HA's chrome
    // (top bar + view title) eats ~50–80px from the visible area, but the iframe
    // remains 100vh tall — so Scrypted's bottom-anchored mobile nav lands BELOW
    // the visible viewport and gets clipped by ha-card's overflow: hidden.
    // Fix: use height: 100% so the iframe inherits the container's actual height
    // (chained through :host, ha-card, iframe) and Scrypted's responsive layout
    // sees the real visible area.
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'ha-card', 'scrypted-nvr-iframe-card.js'),
        'utf8',
    );

    it('does not size iframe with 100vh (clips bottom nav under HA chrome)', () => {
        // Look only inside the _render() method's <style> block.
        const styleBlock = src.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
        expect(styleBlock).not.toMatch(/height:\s*100vh/);
    });

    it('chains height: 100% through :host, ha-card, and iframe', () => {
        const styleBlock = src.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
        expect(styleBlock).toMatch(/:host\s*\{[^}]*height:\s*100%/);
        expect(styleBlock).toMatch(/ha-card\s*\{[^}]*height:\s*100%/);
        expect(styleBlock).toMatch(/iframe\s*\{[^}]*height:\s*100%/);
    });

    it('does NOT use safe-area or absolute-positioning hacks (v0.3.108 baseline)', () => {
        // History of failed attempts to close the iOS home-indicator gap:
        // - v0.3.104: padding-bottom: env(safe-area-inset-bottom) → pushed nav UP (wrong direction).
        // - v0.3.106: ha-card margin-bottom: calc(-1 * env(...)) → bleed clipped by HA parent.
        // - v0.3.107: position: absolute iframe with negative bottom → broke Scrypted layout.
        // Accepted: the gap is part of HA's panel-view layout chain we can't override.
        // This test prevents accidental re-introduction of any of those approaches.
        const styleBlock = src.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
        expect(styleBlock).not.toMatch(/safe-area-inset-bottom/);
        expect(styleBlock).not.toMatch(/position\s*:\s*absolute/);
        expect(styleBlock).not.toMatch(/margin-bottom\s*:/);
    });
});

describe('readDeepLinkParams', () => {
    let helpers: any;
    beforeAll(() => { helpers = loadCardHelpers(); });

    it('reads camera and time from search', () => {
        const out = helpers.readDeepLinkParams('?camera=694&time=12345', '');
        expect(out).toEqual({ camera: '694', time: '12345' });
    });

    it('reads camera and time from hash query string when search is empty', () => {
        const out = helpers.readDeepLinkParams('', '#/lovelace?camera=694&time=12345');
        expect(out).toEqual({ camera: '694', time: '12345' });
    });

    it('prefers search over hash when both are present', () => {
        const out = helpers.readDeepLinkParams('?camera=A&time=1', '#/x?camera=B&time=2');
        expect(out).toEqual({ camera: 'A', time: '1' });
    });

    it('returns nulls when neither has params', () => {
        const out = helpers.readDeepLinkParams('', '#/lovelace');
        expect(out).toEqual({ camera: null, time: null });
    });

    it('returns nulls when search/hash are malformed', () => {
        const out = helpers.readDeepLinkParams('?', '#');
        expect(out).toEqual({ camera: null, time: null });
    });

    it('handles partial params (camera only)', () => {
        const out = helpers.readDeepLinkParams('?camera=694', '');
        expect(out).toEqual({ camera: '694', time: null });
    });
});
