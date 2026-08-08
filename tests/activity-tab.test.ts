/**
 * Activity tab — the renamed Gallery tab showing the Events gallery.
 * The plugin's own Stories segment was removed (v0.3.165); Scrypted's native
 * Stories are handled natively and, when routed through the plugin, appear as
 * ordinary enriched notifications in the Events gallery.
 */

// Force module scope: this file uses `require` with no import/export, which
// makes it a global "script". Another script-mode test (daily-brief-date-
// selector.test.ts) also declares `const generateDailyBriefHTML` at top level;
// when ts-jest co-locates both in one worker they collide (TS2451). `export {}`
// makes each a module so its top-level consts are module-scoped.
export {};

const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');

function render(): string {
    return generateDailyBriefHTML(3, 'summary', [], 1749000000000, 'America/Los_Angeles');
}

describe('Activity tab (Events gallery)', () => {
    it('renames the Gallery tab to Activity', () => {
        const h = render();
        expect(h).toMatch(/data-tab="activity"[^>]*>\s*Activity\s*</);
        expect(h).not.toMatch(/data-tab="gallery"/);
        expect(h).not.toMatch(/>\s*Gallery\s*<\/button>/);
    });

    it('renames the tab content container to activity-tab', () => {
        const h = render();
        expect(h).toMatch(/id="activity-tab"/);
        expect(h).not.toMatch(/id="gallery-tab"/);
    });

    it('shows the Events gallery directly with no Stories segment', () => {
        const h = render();
        expect(h).toMatch(/class="gallery-container"/);
        expect(h).not.toMatch(/class="stories-container"/);
        expect(h).not.toMatch(/data-seg="stories"/);
        expect(h).not.toMatch(/class="activity-segment"/);
    });

    it('carries no Stories view code', () => {
        const h = render();
        expect(h).not.toMatch(/StoriesView/);
        expect(h).not.toMatch(/playStoryClip/);
        expect(h).not.toMatch(/showActivitySegment/);
        // The Story-only {cameraId,time,posterUrl} playRef path was removed with
        // playStoryClip; openVideoModal now always plays by notificationId.
        expect(h).not.toMatch(/playRef/);
    });

    it('routes ?id= / ?groupId= deep links to the Activity tab', () => {
        const h = render();
        expect(h).not.toMatch(/data-tab="gallery"/);
        // Deep-link handlers click the activity tab, which lazy-inits the gallery.
        expect(h).toMatch(/\.tab\[data-tab="activity"\]/);
        expect(h).not.toMatch(/deepLinkStoryId/);
    });
});
