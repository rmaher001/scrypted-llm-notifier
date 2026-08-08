/**
 * Story badge — surface Scrypted's native Summary/Story notifications in the
 * gallery so they are visually distinguishable from per-detection events.
 *
 * WHY (2026-07-25): with per-detection notification types now enabled, the
 * gallery mixes two kinds of card. Per-detection events were confirmed working
 * end to end (thumbnail, poster, WebRTC clip, NVR link) after the v0.3.169 seek
 * fix, while the Story cards are still unverified for poster / clip / NVR link.
 * They are indistinguishable on screen today, so there is no way to tell which
 * card is which when judging what is broken. This badge is DIAGNOSTIC-FIRST:
 * label the cards before changing any Story behavior.
 *
 * The flag rides from isSummaryNotification() -> StoredNotification.isSummary
 * -> the gallery JSON projection -> the card badge.
 */

import { buildStoredNotification } from '../src/llm-notifier';
import { getGalleryPage } from '../src/gallery';
import { StoredNotification } from '../src/types';

function makeNotif(id: string, overrides?: Partial<StoredNotification>): StoredNotification {
    return {
        id,
        timestamp: Date.now(),
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: [],
        llmTitle: 'Person Detected',
        llmSubtitle: 'Person',
        llmBody: 'Someone at the door',
        ...overrides,
    };
}

describe('buildStoredNotification carries isSummary', () => {
    const base = {
        id: 'n1',
        detectionEpoch: 1_700_000_000_000,
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: [],
        enriched: { title: 't', subtitle: 's', body: 'b' },
        hasPoster: true,
    };

    it('persists isSummary=true so the gallery can label Story cards', () => {
        expect(buildStoredNotification({ ...base, isSummary: true }).isSummary).toBe(true);
    });

    it('persists isSummary=false for per-detection notifications', () => {
        expect(buildStoredNotification({ ...base, isSummary: false }).isSummary).toBe(false);
    });

    it('leaves isSummary undefined when not supplied (records written before this shipped)', () => {
        expect(buildStoredNotification(base).isSummary).toBeUndefined();
    });
});

describe('gallery projection exposes isSummary', () => {
    it('passes isSummary through to the gallery row', () => {
        const result = getGalleryPage([makeNotif('n1', { isSummary: true })], 1, 50, {});
        expect(result.notifications[0].isSummary).toBe(true);
    });

    it('passes isSummary=false through unchanged', () => {
        const result = getGalleryPage([makeNotif('n2', { isSummary: false })], 1, 50, {});
        expect(result.notifications[0].isSummary).toBe(false);
    });

    it('leaves isSummary undefined for legacy records rather than guessing', () => {
        const result = getGalleryPage([makeNotif('n3')], 1, 50, {});
        expect(result.notifications[0].isSummary).toBeUndefined();
    });
});

describe('gallery card renders the Story badge', () => {
    const galleryJs: string = require('../src/gallery-embedded').GALLERY_JS;

    it('emits a story badge element when the row is a Summary', () => {
        expect(galleryJs).toMatch(/gallery-story-badge/);
        expect(galleryJs).toMatch(/n\.isSummary/);
    });

    it('labels the badge with TEXT, not colour alone (operator is colourblind)', () => {
        // v0.3.132 established that colour cannot be the only signal on this
        // gallery. The badge must carry a readable word.
        expect(galleryJs).toMatch(/>\s*Story\s*<|Story<\/span>|'Story'/);
    });

    it('does not collide with the group badge (top-right) or name badges (top-left)', () => {
        const css = galleryJs.match(/\.gallery-story-badge \{[^}]*\}/)?.[0] ?? '';
        expect(css).toBeTruthy();
        expect(css).toMatch(/bottom:/);
        expect(css).not.toMatch(/top:/);
    });
});
