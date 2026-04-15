/**
 * Tests for memory optimization: thumbnailB64 elimination.
 * Verifies load stripping, save stripping, and in-memory cleanup.
 */

import { NotificationStore } from '../src/notification-store';
import { StoredNotification } from '../src/types';

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

function makeStorage(initial?: Record<string, string>): any {
    const data: Record<string, string> = { ...initial };
    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: jest.fn((key: string, value: string) => { data[key] = value; }),
        _data: data,
    };
}

describe('load() strips thumbnailB64', () => {
    it('strips thumbnailB64 from all notifications on load', () => {
        const storage = makeStorage({
            dailyBriefNotifications: JSON.stringify([
                makeNotification('n1', { thumbnailB64: 'data123', hasPoster: true }),
                makeNotification('n2', { thumbnailB64: 'data456', hasPoster: false }),
                makeNotification('n3', { hasPoster: true }),
            ]),
        });
        const store = new NotificationStore(storage);

        expect(store.getById('n1')?.thumbnailB64).toBeUndefined();
        expect(store.getById('n2')?.thumbnailB64).toBeUndefined();
        expect(store.getById('n3')?.thumbnailB64).toBeUndefined();
    });
});

describe('save() strips thumbnailB64', () => {
    it('never persists thumbnailB64 to storage', () => {
        const storage = makeStorage();
        const store = new NotificationStore(storage);

        store.add(makeNotification('n1', { thumbnailB64: 'should-not-persist', hasPoster: true }));

        const saved = JSON.parse(storage._data.dailyBriefNotifications);
        const n = saved.find((n: any) => n.id === 'n1');
        expect(n.thumbnailB64).toBeUndefined();
    });
});

describe('loadSummaryCache() migrates inline base64 thumbnails', () => {
    it('replaces data: URI thumbnails with poster marker on load', () => {
        const storage = makeStorage({
            dailyBriefSummaryCache: JSON.stringify([{
                date: '2026-04-09',
                summary: 'Test',
                generatedAt: Date.now(),
                notificationCount: 1,
                highlights: [
                    { id: 'h1', thumbnail: 'data:image/jpeg;base64,abc123', cameraId: 'c1', cameraName: 'Cam', timestamp: Date.now(), date: 'Apr 9', time: '8:00 AM', title: 'Test', subtitle: 'Sub', body: 'Body' },
                    { id: 'h2', thumbnail: 'poster', cameraId: 'c1', cameraName: 'Cam', timestamp: Date.now(), date: 'Apr 9', time: '8:01 AM', title: 'Test2', subtitle: 'Sub', body: 'Body' },
                    { id: 'h3', thumbnail: '', cameraId: 'c1', cameraName: 'Cam', timestamp: Date.now(), date: 'Apr 9', time: '8:02 AM', title: 'Test3', subtitle: 'Sub', body: 'Body' },
                ],
                windowStart: 0,
                windowEnd: Date.now(),
            }]),
        });
        const store = new NotificationStore(storage);

        const cached = store.getCachedSummary(new Date('2026-04-09'));
        expect(cached?.highlights[0].thumbnail).toBe('poster');
        expect(cached?.highlights[1].thumbnail).toBe('poster');
        expect(cached?.highlights[2].thumbnail).toBe('');
    });

    it('saves after migration so subsequent loads find clean data', () => {
        const storage = makeStorage({
            dailyBriefSummaryCache: JSON.stringify([{
                date: '2026-04-09',
                summary: 'Test',
                generatedAt: Date.now(),
                notificationCount: 1,
                highlights: [
                    { id: 'h1', thumbnail: 'data:image/jpeg;base64,abc', cameraId: 'c1', cameraName: 'Cam', timestamp: Date.now(), date: 'Apr 9', time: '8:00 AM', title: 'T', subtitle: 'S', body: 'B' },
                ],
                windowStart: 0,
                windowEnd: Date.now(),
            }]),
        });
        const store = new NotificationStore(storage);

        const saved = JSON.parse(storage._data.dailyBriefSummaryCache);
        expect(saved[0].highlights[0].thumbnail).toBe('poster');
    });
});

describe('add() strips thumbnailB64', () => {
    it('does not retain thumbnailB64 in memory after add', () => {
        const storage = makeStorage();
        const store = new NotificationStore(storage);

        store.add(makeNotification('n1', { thumbnailB64: 'inmemory', hasPoster: true }));

        const n = store.getById('n1');
        expect(n?.thumbnailB64).toBeUndefined();
    });
});
