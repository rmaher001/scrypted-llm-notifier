/**
 * Phase 5: Remaining cleanup.
 * - inFlightRequests: LRUCache with max size
 * - maxPerDay: 2000
 * - summaryCache: prune on load
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { NotificationStore } from '../src/notification-store';
import type { StoredNotification } from '../src/types';

const mainTsPath = path.resolve(__dirname, '../src/main.ts');
const notifStorePath = path.resolve(__dirname, '../src/notification-store.ts');

function makeNotification(id: string, overrides?: Partial<StoredNotification>): StoredNotification {
    return {
        id,
        timestamp: Date.now(),
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: [],
        llmTitle: 'Person',
        llmSubtitle: 'Door',
        llmBody: 'Approaching',
        ...overrides,
    };
}

function makeStorage(initial?: Record<string, string>): any {
    const data: Record<string, string> = { ...initial };
    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: jest.fn((key: string, value: string) => { data[key] = value; }),
        removeItem: jest.fn((key: string) => { delete data[key]; }),
        _data: data,
    };
}

describe('5a: inFlightRequests uses LRUCache', () => {
    let mainSrc: string;

    beforeAll(async () => {
        mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
    });

    it('inFlightRequests is an LRUCache with max size', () => {
        expect(mainSrc).toMatch(/inFlightRequests\s*=\s*new LRUCache/);
    });
});

describe('5b: maxPerDay is 2000', () => {
    let storeSrc: string;

    beforeAll(async () => {
        storeSrc = await fsp.readFile(notifStorePath, 'utf-8');
    });

    it('maxPerDay constant is 2000', () => {
        expect(storeSrc).toMatch(/maxPerDay\s*=\s*2000/);
    });
});

describe('5c: summaryCache prunes stale entries on load', () => {
    it('removes summaries older than 7 days during loadSummaryCache', () => {
        const staleDate = '2020-01-01';
        const freshDate = new Date().toISOString().split('T')[0];
        const storage = makeStorage({
            dailyBriefSummaryCache: JSON.stringify([
                {
                    date: staleDate,
                    summary: 'Stale',
                    generatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
                    notificationCount: 1,
                    highlights: [],
                    windowStart: 0,
                    windowEnd: 1,
                },
                {
                    date: freshDate,
                    summary: 'Fresh',
                    generatedAt: Date.now(),
                    notificationCount: 1,
                    highlights: [],
                    windowStart: 0,
                    windowEnd: Date.now(),
                },
            ]),
        });

        const store = new NotificationStore(storage);

        // Stale entry should have been pruned on load
        expect(store.getCachedSummary(new Date('2020-01-01'))).toBeUndefined();
        // Fresh entry should remain
        expect(store.getCachedSummary(new Date(freshDate))).toBeDefined();
    });
});
