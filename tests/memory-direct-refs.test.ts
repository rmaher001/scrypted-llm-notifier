/**
 * Tests for Phase 3: Eliminate full copies in getAll() and getAllEmbeddings().
 * Callers never mutate results, so returning direct references avoids
 * unnecessary array spreads and Map copies on every gallery request.
 */

import { NotificationStore } from '../src/notification-store';
import type { StoredNotification } from '../src/types';

function makeNotification(id: string, overrides?: Partial<StoredNotification>): StoredNotification {
    return {
        id,
        timestamp: Date.now(),
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: [],
        llmTitle: 'Person at Door',
        llmSubtitle: 'Front Door',
        llmBody: 'Adult approaching',
        ...overrides,
    };
}

function makeStorage(): any {
    const data: Record<string, string> = {};
    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: jest.fn((key: string, value: string) => { data[key] = value; }),
        removeItem: jest.fn((key: string) => { delete data[key]; }),
    };
}

describe('getAll() returns direct reference', () => {
    it('returns the same array reference on consecutive calls', () => {
        const store = new NotificationStore(makeStorage());
        store.add(makeNotification('n1'));
        store.add(makeNotification('n2'));

        const first = store.getAll();
        const second = store.getAll();
        expect(first).toBe(second);
    });

    it('returns notifications sorted by timestamp descending', () => {
        const store = new NotificationStore(makeStorage());
        const now = Date.now();
        store.add(makeNotification('old', { timestamp: now - 1000 }));
        store.add(makeNotification('new', { timestamp: now }));

        const all = store.getAll();
        expect(all[0].id).toBe('new');
        expect(all[1].id).toBe('old');
    });
});

describe('getAllEmbeddings() returns direct reference', () => {
    it('returns the same Map reference on consecutive calls', () => {
        const store = new NotificationStore(makeStorage());
        store.addEmbedding('n1', 'data', 768);

        const first = store.getAllEmbeddings();
        const second = store.getAllEmbeddings();
        expect(first).toBe(second);
    });
});
