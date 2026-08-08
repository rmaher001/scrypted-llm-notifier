/**
 * Tests for buildThumbnailUrl — the gallery card thumbnail URL builder.
 *
 * Per 2026-05-15 spec §4.5: grouped events use the composite as their gallery
 * thumbnail (matching what's shown in the notification). Solo events use
 * their per-event poster. Drill-down view always uses the per-event poster
 * (it's already inside a group hero shell that shows the composite separately).
 *
 * v0.3.123 fix: pre-v0.3.123, every gallery card pointed at the per-event
 * poster regardless of grouping, so the cards for grouped primaries didn't
 * match the composite shown in the notification.
 */

import { buildThumbnailUrl } from '../src/gallery';
import { StoredNotification } from '../src/types';

function n(overrides: Partial<StoredNotification> = {}): StoredNotification {
    return {
        id: 'evt-1',
        timestamp: 1_700_000_000_000,
        cameraId: 'cam-1',
        cameraName: 'Test Camera',
        detectionType: 'person',
        names: [],
        llmTitle: 'Person at door',
        llmBody: 'A person at the door',
        llmSubtitle: '',
        detailedDescription: '',
        hasPoster: true,
        ...overrides,
    };
}

describe('buildThumbnailUrl', () => {
    const BASE = 'https://host';

    it('returns the per-event poster URL for a solo event with hasPoster', () => {
        const url = buildThumbnailUrl(n({ id: 'solo' }), BASE, { isDrillDown: false });
        expect(url).toBe('https://host/brief/snapshot?id=solo');
    });

    it('returns empty string for a solo event without a stored poster', () => {
        const url = buildThumbnailUrl(n({ id: 'solo', hasPoster: false }), BASE, { isDrillDown: false });
        expect(url).toBe('');
    });

    it('ignores groupId (composite endpoint deleted with grouping pipeline) — returns per-event poster URL', () => {
        // Post-stories-grouping: any record with groupId still returns the
        // per-event poster, since the composite poster files were never
        // created (or have been pruned) after the grouping pipeline was
        // deleted. Phase 8 migration strips groupId fields entirely.
        const url = buildThumbnailUrl(
            n({ id: 'primary', groupId: 'g-abc' }),
            BASE,
            { isDrillDown: false, groupSize: 4 },
        );
        expect(url).toBe('https://host/brief/snapshot?id=primary');
    });

    it('returns empty string when an old grouped record has no per-event poster', () => {
        const url = buildThumbnailUrl(
            n({ id: 'primary', hasPoster: false, groupId: 'g-abc' }),
            BASE,
            { isDrillDown: false, groupSize: 3 },
        );
        expect(url).toBe('');
    });

    it('URL-encodes the notification id for per-event fallbacks', () => {
        const url = buildThumbnailUrl(n({ id: 'evt 1/x' }), BASE, { isDrillDown: false });
        expect(url).toBe('https://host/brief/snapshot?id=evt%201%2Fx');
    });

    it('handles empty base URL', () => {
        const url = buildThumbnailUrl(n({ id: 'solo' }), '', { isDrillDown: false });
        expect(url).toBe('/brief/snapshot?id=solo');
    });
});
