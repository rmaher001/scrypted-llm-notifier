/**
 * prune()'s per-day cap buckets by the user's timezone, not UTC.
 *
 * The v0.3.177 fix made getForDate/getStats timezone-aware but left prune()
 * bucketing on `new Date(ts).toISOString().split('T')[0]` — a UTC calendar
 * date. Same class of bug: on a UTC server the "day" used for the
 * maxPerDay=2000 cap starts mid-afternoon local, so a single local day is split
 * across two buckets and two local days share one. At sustained volume that
 * evicts the wrong notifications near the boundary.
 */

import { NotificationStore } from '../src/notification-store';
import { StoredNotification } from '../src/types';

const LA = 'America/Los_Angeles';

function makeStorage(): any {
    const map = new Map<string, string>();
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => map.set(k, v),
        removeItem: (k: string) => map.delete(k),
    };
}

function at(iso: string, id: string): StoredNotification {
    return {
        id, timestamp: Date.parse(iso),
        cameraId: 'cam', cameraName: 'Cam', detectionType: 'person', names: [],
        llmTitle: 't', llmSubtitle: 's', llmBody: 'b',
    };
}

describe('prune buckets by the configured timezone', () => {
    it('treats one local day as one bucket even when it straddles UTC midnight', () => {
        // 2026-07-27 in LA runs 07:00Z that day .. 06:59:59Z the next. These
        // three are all the SAME local day but two different UTC days.
        const store = new NotificationStore(makeStorage());
        store.setRetentionDays(100_000);
        store.setTimezone(LA);
        store.setMaxPerDay(2);

        store.add(at('2026-07-27T08:00:00Z', 'a'));   // 1:00 AM local
        store.add(at('2026-07-27T20:00:00Z', 'b'));   // 1:00 PM local
        store.add(at('2026-07-28T05:00:00Z', 'c'));   // 10:00 PM local — same local day

        // One bucket, cap 2, newest kept.
        const kept = store.getForDate(new Date('2026-07-27T20:00:00Z'), LA).map(n => n.id).sort();
        expect(kept).toEqual(['b', 'c']);
    });

    it('keeps separate local days in separate buckets', () => {
        const store = new NotificationStore(makeStorage());
        store.setRetentionDays(100_000);
        store.setTimezone(LA);
        store.setMaxPerDay(1);

        store.add(at('2026-07-27T20:00:00Z', 'day1'));   // 1 PM local on the 27th
        store.add(at('2026-07-28T20:00:00Z', 'day2'));   // 1 PM local on the 28th

        // Different local days — the cap must not evict across them.
        expect(store.getForDate(new Date('2026-07-27T20:00:00Z'), LA).map(n => n.id)).toEqual(['day1']);
        expect(store.getForDate(new Date('2026-07-28T20:00:00Z'), LA).map(n => n.id)).toEqual(['day2']);
    });

    it('falls back to UTC bucketing when no timezone is configured', () => {
        const store = new NotificationStore(makeStorage());
        store.setRetentionDays(100_000);
        store.setMaxPerDay(2);
        store.add(at('2026-07-27T08:00:00Z', 'a'));
        store.add(at('2026-07-27T20:00:00Z', 'b'));
        store.add(at('2026-07-28T05:00:00Z', 'c'));   // different UTC day
        // 'a' and 'b' share a UTC day (cap 2, both kept); 'c' is its own.
        expect((store as any).notifications.map((n: any) => n.id).sort()).toEqual(['a', 'b', 'c']);
    });
});

describe('the store is told the timezone', () => {
    const fs = require('fs');
    const path = require('path');

    it('prune buckets via the timezone-aware key, not toISOString', () => {
        const store: string = fs.readFileSync(
            path.resolve(__dirname, '../src/notification-store.ts'), 'utf-8');
        const pruneBody = /private prune\(\)[\s\S]*?\n    \}/.exec(store)?.[0] ?? '';
        expect(pruneBody).toMatch(/localDateKey\(n\.timestamp, this\.timezone\)/);
        // The UTC form survives only as the no-timezone fallback, never as the
        // unconditional bucket key.
        expect(pruneBody).toMatch(/this\.timezone\s*\n?\s*\?\s*localDateKey/);
    });

    it('main.ts pushes the configured timezone into the store', () => {
        const main: string = fs.readFileSync(
            path.resolve(__dirname, '../src/main.ts'), 'utf-8');
        expect(main).toMatch(/notificationStore\.setTimezone\(/);
    });
});
