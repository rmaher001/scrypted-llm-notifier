import * as fs from 'fs';
import * as path from 'path';

// The brief page deep-link IIFE drills into a group via gallery._drillIntoGroup.
// _drillIntoGroup early-returns if gallery._loading is true. The poll must wait
// for the gallery's initial _fetchPage to settle before calling, otherwise the
// drill silently no-ops and the user lands on the normal gallery list.
//
// This test pins the poll predicate by reading the source — the embedded
// HTML fragment is generated inline, so we check the source guard rather
// than executing the JS in a jsdom harness.

describe('brief page ?groupId= deep-link', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'daily-brief', 'html-generator.ts'),
        'utf-8',
    );

    test('groupId poll predicate guards against gallery._loading', () => {
        // Locate the deepLinkGroupId block
        const blockStart = src.indexOf('if (deepLinkGroupId)');
        expect(blockStart).toBeGreaterThan(0);
        // The body of the poll, up to the next top-level `if (deepLinkId)` check
        const blockEnd = src.indexOf('if (deepLinkId)', blockStart);
        expect(blockEnd).toBeGreaterThan(blockStart);
        const block = src.slice(blockStart, blockEnd);

        // The fix: poll predicate must include `!gallery._loading`. Without it,
        // the first 100 ms tick fires while _fetchPage is in flight, drillIntoGroup
        // bails on its `if (this._loading) return;` guard, and the UI shows the
        // normal gallery list instead of the group hero.
        expect(block).toMatch(/!gallery\._loading/);
    });
});
