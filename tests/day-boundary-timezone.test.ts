/**
 * The day boundary honours the user's configured timezone, not the server's.
 *
 * THE BUG (reported 2026-07-27, 12:24 AM PDT): the Daily Brief footer read
 * "267 total events today" 24 minutes into a brand-new day, and the summary
 * panel sat on "Generating summary..." forever.
 *
 * Scrypted always runs UTC. getForDate computed the day with
 * `setHours(0,0,0,0)` / `setHours(23,59,59,999)`, which are SERVER-local — so
 * "today" began at 00:00 UTC, i.e. 5 PM the previous afternoon in California.
 * That window swept up the whole previous evening: 267 events.
 *
 * Meanwhile every other day boundary in the plugin is timezone-aware
 * (getCachedSummary keys on toLocaleDateString('en-CA', { timeZone })), so the
 * summary side correctly saw an empty new day and produced nothing. The page
 * then read the WRONG count, hit its `eventCount > 0` branch, and promised a
 * summary that could never arrive instead of showing the empty state.
 *
 * The bug also cuts the other way: once UTC's date rolls past the user's,
 * genuinely-today events fall outside the window and vanish from the count.
 *
 * These assertions are expressed in absolute UTC instants so they hold no
 * matter what timezone the machine running the tests is in.
 */

// NOTE ON MACHINE TIMEZONE. The behavioural getForDate cases below compare a
// named zone against the *server's* zone, so on a developer machine already in
// America/Los_Angeles the LA cases pass whether or not the timezone is
// honoured. (Setting process.env.TZ here does not help — Jest initialises Date
// before the file runs.) The `dayBoundsMs` block asserts exact UTC instants and
// the forwarding pin asserts the wiring, and those two DO bite on any machine.
// Keep all three: together they cover the logic, the constants, and the plumbing.

import { NotificationStore, dayBoundsMs } from '../src/notification-store';
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

function at(iso: string): StoredNotification {
    return {
        id: iso,
        timestamp: Date.parse(iso),
        cameraId: 'cam',
        cameraName: 'Cam',
        detectionType: 'person',
        names: [],
        llmTitle: 't',
        llmSubtitle: 's',
        llmBody: 'b',
    };
}

function storeWith(...isos: string[]): NotificationStore {
    const s = new NotificationStore(makeStorage());
    // add() prunes anything older than the retention window (default 3 days),
    // which would silently drop past-dated fixtures — a DST test using a date
    // from earlier this year returns an empty array and looks like a boundary
    // bug. Widen the window so fixtures survive regardless of the run date.
    s.setRetentionDays(100_000);
    for (const iso of isos) s.add(at(iso));
    return s;
}

function idsOn(store: NotificationStore, date: string, tz: string): string[] {
    return store.getForDate(new Date(date), tz).map(n => n.id).sort();
}

describe('getForDate respects the configured timezone', () => {
    // On 2026-07-27 California is PDT (UTC-7), so the local day runs
    // 2026-07-27T07:00:00Z .. 2026-07-28T06:59:59.999Z.

    it('excludes the previous evening — the 267-events bug', () => {
        // 23:59 PDT on the 26th is 06:59Z on the 27th. Under the old
        // server-local (UTC) rule this counted as "today" and dragged in the
        // entire previous evening.
        const store = storeWith(
            '2026-07-27T02:00:00Z',   // 7:00 PM PDT on the 26th — yesterday
            '2026-07-27T06:59:59Z',   // 11:59:59 PM PDT on the 26th — yesterday
            '2026-07-27T07:10:00Z',   // 12:10 AM PDT on the 27th — today
        );
        expect(idsOn(store, '2026-07-27T07:24:00Z', LA)).toEqual(['2026-07-27T07:10:00Z']);
    });

    it('includes events after UTC rolls over but before the local day ends', () => {
        // 9 PM PDT on the 27th is 04:00Z on the 28th — still the 27th locally.
        // The old rule dropped these, under-counting the evening.
        const store = storeWith('2026-07-28T04:00:00Z');
        expect(idsOn(store, '2026-07-27T20:00:00Z', LA)).toEqual(['2026-07-28T04:00:00Z']);
    });

    it('excludes the following local day', () => {
        const store = storeWith('2026-07-28T07:00:00Z');   // 12:00 AM PDT on the 28th
        expect(idsOn(store, '2026-07-27T20:00:00Z', LA)).toEqual([]);
    });

    it('handles a timezone ahead of UTC', () => {
        // Tokyo is UTC+9, so 2026-07-27 there runs 2026-07-26T15:00Z .. 2026-07-27T14:59:59.999Z.
        const store = storeWith(
            '2026-07-26T14:00:00Z',   // 11 PM on the 26th JST — yesterday
            '2026-07-26T16:00:00Z',   // 1 AM on the 27th JST — today
        );
        expect(idsOn(store, '2026-07-27T02:00:00Z', 'Asia/Tokyo'))
            .toEqual(['2026-07-26T16:00:00Z']);
    });
});

describe('getForDate handles DST transitions', () => {
    it('covers the 23-hour spring-forward day', () => {
        // 2026-03-08: PST (UTC-8) -> PDT (UTC-7) at 2 AM local.
        // Local day = 2026-03-08T08:00:00Z .. 2026-03-09T06:59:59.999Z.
        const store = storeWith(
            '2026-03-08T07:59:00Z',   // 11:59 PM PST on the 7th — yesterday
            '2026-03-08T08:00:00Z',   // 12:00 AM PST on the 8th — today
            '2026-03-09T06:59:00Z',   // 11:59 PM PDT on the 8th — today
            '2026-03-09T07:00:00Z',   // 12:00 AM PDT on the 9th — tomorrow
        );
        expect(idsOn(store, '2026-03-08T20:00:00Z', LA))
            .toEqual(['2026-03-08T08:00:00Z', '2026-03-09T06:59:00Z']);
    });

    it('covers the 25-hour fall-back day', () => {
        // 2026-11-01: PDT (UTC-7) -> PST (UTC-8) at 2 AM local.
        // Local day = 2026-11-01T07:00:00Z .. 2026-11-02T07:59:59.999Z.
        const store = storeWith(
            '2026-11-01T06:59:00Z',   // 11:59 PM PDT on 10/31 — yesterday
            '2026-11-01T07:00:00Z',   // 12:00 AM PDT on the 1st — today
            '2026-11-02T07:59:00Z',   // 11:59 PM PST on the 1st — today
            '2026-11-02T08:00:00Z',   // 12:00 AM PST on the 2nd — tomorrow
        );
        expect(idsOn(store, '2026-11-01T20:00:00Z', LA))
            .toEqual(['2026-11-01T07:00:00Z', '2026-11-02T07:59:00Z']);
    });
});

describe('getStats uses the same boundary', () => {
    it('counts only the local day', () => {
        const store = storeWith(
            '2026-07-27T06:59:00Z',   // yesterday locally
            '2026-07-27T07:10:00Z',   // today
        );
        expect(store.getStats(new Date('2026-07-27T07:24:00Z'), LA).total).toBe(1);
    });
});

describe('dayBoundsMs computes exact instants', () => {
    // Absolute UTC values — these hold on any machine, in any zone, so they
    // catch a regression the behavioural cases above can miss on a US-Pacific
    // developer box.
    const t = (iso: string) => Date.parse(iso);

    it('spans a normal PDT day', () => {
        expect(dayBoundsMs(new Date('2026-07-27T07:24:00Z'), LA)).toEqual({
            start: t('2026-07-27T07:00:00.000Z'),
            end: t('2026-07-28T06:59:59.999Z'),
        });
    });

    it('spans the 23-hour spring-forward day', () => {
        const { start, end } = dayBoundsMs(new Date('2026-03-08T20:00:00Z'), LA);
        expect(start).toBe(t('2026-03-08T08:00:00.000Z'));
        expect(end).toBe(t('2026-03-09T06:59:59.999Z'));
        expect(end + 1 - start).toBe(23 * 3600_000);
    });

    it('spans the 25-hour fall-back day', () => {
        const { start, end } = dayBoundsMs(new Date('2026-11-01T20:00:00Z'), LA);
        expect(start).toBe(t('2026-11-01T07:00:00.000Z'));
        expect(end).toBe(t('2026-11-02T07:59:59.999Z'));
        expect(end + 1 - start).toBe(25 * 3600_000);
    });

    it('handles a zone whose DST change lands at midnight', () => {
        // America/Santiago springs forward 00:00 -> 01:00 on 2026-09-06, so
        // local midnight does not exist; the day's first instant is 01:00.
        // Offset arithmetic gets this wrong in one direction and Asia/Beirut
        // wrong in the other, which is why the boundary is searched, not
        // computed. Both zones are pinned here.
        expect(dayBoundsMs(new Date('2026-09-06T12:00:00Z'), 'America/Santiago').start)
            .toBe(t('2026-09-06T04:00:00.000Z'));
        expect(dayBoundsMs(new Date('2026-03-29T12:00:00Z'), 'Asia/Beirut').start)
            .toBe(t('2026-03-28T22:00:00.000Z'));
    });

    it('spans a day in a zone ahead of UTC', () => {
        expect(dayBoundsMs(new Date('2026-07-27T02:00:00Z'), 'Asia/Tokyo')).toEqual({
            start: t('2026-07-26T15:00:00.000Z'),
            end: t('2026-07-27T14:59:59.999Z'),
        });
    });

    it('falls back to server-local when no timezone is given', () => {
        const d = new Date('2026-07-27T20:00:00Z');
        const expectStart = new Date(d); expectStart.setHours(0, 0, 0, 0);
        expect(dayBoundsMs(d).start).toBe(expectStart.getTime());
    });
});

describe('call sites pass the timezone through', () => {
    const fs = require('fs');
    const path = require('path');
    const main: string = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf-8');

    it('getForDate forwards its timezone argument to dayBoundsMs', () => {
        // Guards the one-token regression `dayBoundsMs(date, undefined)`, which
        // silently reverts to the server day and which the behavioural cases
        // cannot see on a US-Pacific machine.
        const store: string = fs.readFileSync(
            path.resolve(__dirname, '../src/notification-store.ts'), 'utf-8');
        expect(store).toMatch(/dayBoundsMs\(\s*date\s*,\s*timezone\s*\)/);
    });

    it('no getForDate/getStats call omits the timezone', () => {
        // A bare getForDate(targetDate) silently reverts to the server day and
        // reintroduces the bug at exactly one call site — invisible in review.
        const bare = main.match(/notificationStore\.(getForDate|getStats)\(\s*targetDate\s*\)/g) ?? [];
        expect(bare).toEqual([]);
        const withTz = main.match(/notificationStore\.(getForDate|getStats)\(\s*targetDate\s*,\s*timezone\s*\)/g) ?? [];
        expect(withTz.length).toBeGreaterThanOrEqual(3);
    });
});
