/**
 * Tests for LLM-identified name integration in Gallery.
 * Covers: GalleryNotification includes llmIdentifiedName,
 * name filter merging, keyword search, and search pre-filter.
 */

import { getGalleryPage, keywordSearch } from '../src/gallery';
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
        llmSubtitle: 'Front Door',
        llmBody: 'Someone at the door',
        ...overrides,
    };
}

// ---- Step 1: GalleryNotification includes llmIdentifiedName ----

describe('GalleryNotification llmIdentifiedName field', () => {
    it('returns llmIdentifiedName when present on StoredNotification', () => {
        const notifications = [makeNotif('n1', { llmIdentifiedName: 'Alex' })];
        const result = getGalleryPage(notifications, 1, 50, {});
        expect(result.notifications[0].llmIdentifiedName).toBe('Alex');
    });

    it('returns undefined llmIdentifiedName when not set', () => {
        const notifications = [makeNotif('n1')];
        const result = getGalleryPage(notifications, 1, 50, {});
        expect(result.notifications[0].llmIdentifiedName).toBeUndefined();
    });
});

// ---- Step 2: Merge LLM-identified names into name filter ----

describe('name filter includes llmIdentifiedName', () => {
    it('filters.names includes llmIdentifiedName values', () => {
        const notifications = [
            makeNotif('n1', { names: ['Alice'], llmIdentifiedName: 'Bob' }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {});
        expect(result.filters.names).toContain('Alice');
        expect(result.filters.names).toContain('Bob');
    });

    it('does not duplicate when llmIdentifiedName already in names[]', () => {
        const notifications = [
            makeNotif('n1', { names: ['Alex'], llmIdentifiedName: 'Alex' }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {});
        // Set deduplication: should appear only once
        const alexCount = result.filters.names.filter(n => n === 'Alex').length;
        expect(alexCount).toBe(1);
    });

    it('name filter matches notifications where only llmIdentifiedName matches', () => {
        const notifications = [
            makeNotif('n1', { names: ['Alice'] }),
            makeNotif('n2', { names: [], llmIdentifiedName: 'Bob' }),
        ];
        const result = getGalleryPage(notifications, 1, 50, { name: 'Bob' });
        expect(result.notifications).toHaveLength(1);
        expect(result.notifications[0].id).toBe('n2');
    });

    it('name filter matches both names[] and llmIdentifiedName', () => {
        const notifications = [
            makeNotif('n1', { names: ['Bob'] }),
            makeNotif('n2', { names: [], llmIdentifiedName: 'Bob' }),
            makeNotif('n3', { names: ['Alice'] }),
        ];
        const result = getGalleryPage(notifications, 1, 50, { name: 'Bob' });
        expect(result.notifications).toHaveLength(2);
        expect(result.notifications.map(n => n.id).sort()).toEqual(['n1', 'n2']);
    });
});

// ---- Step 2: keywordSearch matches llmIdentifiedName ----

describe('keywordSearch matches llmIdentifiedName', () => {
    it('finds notification by llmIdentifiedName', () => {
        const notifications = [
            makeNotif('n1', { llmIdentifiedName: 'Alex' }),
            makeNotif('n2', { llmIdentifiedName: 'Blake' }),
            makeNotif('n3'),
        ];
        const results = keywordSearch('alex', notifications);
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('n1');
    });

    it('is case insensitive for llmIdentifiedName', () => {
        const notifications = [
            makeNotif('n1', { llmIdentifiedName: 'Alex' }),
        ];
        const results = keywordSearch('ALEX', notifications);
        expect(results).toHaveLength(1);
    });
});
