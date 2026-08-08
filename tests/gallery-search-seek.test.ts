/**
 * Gallery SEARCH results must carry the seek anchor too.
 *
 * The Gallery tab renders search results with the SAME card renderer as normal
 * browsing (ha-card/gallery.js `_renderCards`), and that renderer emits
 * data-timestamp = seekTimestamp || timestamp — the anchor "Open in NVR" and
 * the clip use. But the search projections in src/gallery.ts are hand-written
 * object literals, separate from getGalleryPage's, and they omitted
 * seekTimestamp. Because the field is optional, TypeScript stayed silent and
 * the omission was invisible: any card opened *after searching* silently fell
 * back to our handling time, reintroducing the 44-300s-late NVR/clip anchor on
 * Stories that v0.3.173 exists to fix.
 *
 * isSummary (v0.3.170, drives the Story badge) was missing from the same
 * literals for the same reason, so searched Story cards lost their badge.
 */

import { handleGallerySearchRequest } from '../src/gallery';
import { StoredNotification } from '../src/types';

const SEEK = 1_700_000_000_000;
const HANDLED = 1_700_000_120_000;   // 120s later — a Story's delivery lag

function storyRecord(): StoredNotification {
    return {
        id: 'story-1',
        timestamp: HANDLED,
        seekTimestamp: SEEK,
        isSummary: true,
        cameraId: 'cam-1',
        cameraName: 'Living Room',
        detectionType: 'person',
        names: [],
        llmTitle: 'Silver car on street',
        llmSubtitle: 'Vehicle',
        llmBody: 'A silver sedan drives down the residential street.',
        hasPoster: true,
    };
}

/** Minimal NotificationStore double — search only needs getAll(). */
function fakeStore(): any {
    const recs = [storyRecord()];
    return { getAll: () => recs, getAllEmbeddings: () => new Map(), getEmbedding: () => undefined };
}

describe('gallery search projection carries the seek anchor', () => {
    it('keyword search results expose seekTimestamp, not just timestamp', async () => {
        const res = await handleGallerySearchRequest(
            JSON.stringify({ query: 'silver' }), fakeStore(), '');
        const body = JSON.parse(res.body);

        expect(body.results.length).toBeGreaterThan(0);
        const hit = body.results[0];
        expect(hit.seekTimestamp).toBe(SEEK);
        // The display/sort time is unchanged.
        expect(hit.timestamp).toBe(HANDLED);
    });

    it('keyword search results keep the isSummary flag so Story badges survive a search', async () => {
        const res = await handleGallerySearchRequest(
            JSON.stringify({ query: 'silver' }), fakeStore(), '');
        const hit = JSON.parse(res.body).results[0];
        expect(hit.isSummary).toBe(true);
    });
});

describe('every gallery projection stays in sync', () => {
    const fsp = require('fs/promises');
    const path = require('path');
    let src: string;

    beforeAll(async () => {
        src = await fsp.readFile(path.resolve(__dirname, '../src/gallery.ts'), 'utf-8');
    });

    it('each thumbnailUrl-bearing projection also emits seekTimestamp and isSummary', () => {
        // These hand-maintained literals have now silently skipped a new field
        // twice (isSummary in v0.3.170, seekTimestamp in v0.3.173). Counting
        // them keeps the next addition honest: if a projection is added without
        // the anchor, this fails.
        // Count only real projections (value-producing), not the interface
        // field declaration.
        const projections = (src.match(/thumbnailUrl:\s*(n\.hasPoster|buildThumbnailUrl)/g) ?? []).length;
        const seeks = (src.match(/seekTimestamp:\s*n\.seekTimestamp/g) ?? []).length;
        const summaries = (src.match(/isSummary:\s*n\.isSummary/g) ?? []).length;
        expect(projections).toBeGreaterThanOrEqual(4);
        expect(seeks).toBe(projections);
        expect(summaries).toBe(projections);
    });
});
