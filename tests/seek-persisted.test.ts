/**
 * The stored record carries the SEEK instant, so the gallery clip and the NVR
 * link land where the poster did (v0.3.173).
 *
 * THE BUG: StoredNotification.timestamp is detectionEpoch — the moment WE
 * handled the notification — and both clip endpoints seek by
 * `notification.timestamp - 5000` (src/main.ts). The poster, since v0.3.169,
 * seeks by recordedEvent.data.timestamp instead. Those are different instants:
 * ~1.5s apart for a per-detection event (invisible) but 44-300s apart for a
 * Story (median ~124s), because a Story notification is emitted when the story
 * COMPLETES. So the gallery clip and "Open in NVR" ran minutes late on Stories
 * while the poster was correct.
 *
 * That data.timestamp is the right instant is corroborated by Scrypted itself:
 * its own notification deep link (data.hash ?time=) uses the same value, and
 * the operator confirmed tapping the notification lands correctly.
 *
 * seekTimestamp is stored separately from `timestamp` on purpose — `timestamp`
 * remains the card's displayed time and the sort key; only the seek moves.
 */

import { buildStoredNotification } from '../src/llm-notifier';

const BASE = {
    id: 'n1',
    detectionEpoch: 1_700_000_120_000,   // when we handled it
    cameraId: 'cam-1',
    cameraName: 'Front Door',
    detectionType: 'person',
    names: [],
    enriched: { title: 't', subtitle: 's', body: 'b' },
    hasPoster: true,
};

describe('buildStoredNotification persists the seek instant', () => {
    it('stores seekTimestamp when supplied, distinct from the display timestamp', () => {
        const seek = 1_700_000_000_000;  // 120s before handling — a Story
        const r = buildStoredNotification({ ...BASE, seekTimestamp: seek });
        expect(r.seekTimestamp).toBe(seek);
        // The displayed/sortable time is unchanged.
        expect(r.timestamp).toBe(BASE.detectionEpoch);
    });

    it('leaves seekTimestamp undefined when not supplied (records predating this)', () => {
        expect(buildStoredNotification(BASE).seekTimestamp).toBeUndefined();
    });

    it('keeps both fields when they coincide (per-detection events)', () => {
        const r = buildStoredNotification({ ...BASE, seekTimestamp: BASE.detectionEpoch });
        expect(r.seekTimestamp).toBe(BASE.detectionEpoch);
        expect(r.timestamp).toBe(BASE.detectionEpoch);
    });
});

describe('both clip endpoints seek by the stored seek instant', () => {
    const fsp = require('fs/promises');
    const path = require('path');
    let main: string;
    let notifier: string;

    beforeAll(async () => {
        main = await fsp.readFile(path.resolve(__dirname, '../src/main.ts'), 'utf-8');
        notifier = await fsp.readFile(path.resolve(__dirname, '../src/llm-notifier.ts'), 'utf-8');
    });

    it('neither endpoint seeks by the raw handling timestamp any more', () => {
        // This is the exact expression that made the clip run late on Stories.
        expect(main).not.toMatch(/clipStartTime\s*=\s*notification\.timestamp\s*-\s*5000/);
    });

    it('both endpoints derive the anchor from seekTimestamp, falling back to timestamp', () => {
        // Two clip paths exist — HTTP replay and WebRTC — and both must agree,
        // or tapping a card behaves differently from playing it.
        const uses = main.match(/notification\.seekTimestamp\s*\?\?\s*notification\.timestamp/g) ?? [];
        expect(uses.length).toBeGreaterThanOrEqual(2);
    });

    it('the web UI "Open in NVR" button seeks by the stored instant, not handling time', () => {
        // data-timestamp is a SEEK anchor — the card's visible time comes from
        // data-time / data-event-time. Both renderers must emit the seek
        // instant, or the button reopens the very bug this fixes: the server
        // clip endpoints would be right while the NVR link stayed minutes late
        // on Stories.
        const galleryJs: string = require('../src/gallery-embedded').GALLERY_JS;
        expect(galleryJs).toMatch(/data-timestamp="'\s*\+\s*\(n\.seekTimestamp\s*\|\|\s*n\.timestamp/);

        const html = require('fs').readFileSync(
            require('path').resolve(__dirname, '../src/daily-brief/html-generator.ts'), 'utf-8');
        expect(html).toMatch(/data-timestamp="\$\{h\.seekTimestamp\s*\?\?\s*h\.timestamp\}"/);
    });

    it('carries seekTimestamp through the gallery JSON projection to the client', () => {
        const { getGalleryPage } = require('../src/gallery');
        const rec = {
            id: 'n1', timestamp: 1_700_000_120_000, seekTimestamp: 1_700_000_000_000,
            cameraId: 'c', cameraName: 'C', detectionType: 'person', names: [],
            llmTitle: 't', llmSubtitle: 's', llmBody: 'b',
        };
        expect(getGalleryPage([rec], 1, 50, {}).notifications[0].seekTimestamp).toBe(1_700_000_000_000);
    });

    it('the notifier persists the same instant the poster seek resolved', () => {
        // The stored value must be the SAME resolved instant getFullEventFrame
        // was given (hoisted out of the fetch block), not a recomputation —
        // otherwise the poster and the clip drift apart again.
        expect(notifier).toMatch(/seekTimestampResolved\s*=\s*seek\.timestamp/);
        expect(notifier).toMatch(/seekTimestamp:\s*seekTimestampResolved/);
    });
});
