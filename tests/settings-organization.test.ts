/**
 * The settings panel stays organized and honest.
 *
 * Three problems this pins, all found in the 2026-07-26 audit:
 *
 * 1. The "Per-Event Notifications" group name was meaningless. It only ever
 *    existed to contrast with grouped notifications (removed) and the
 *    plugin-side Stories subsystem (removed in v0.3.165). With both gone it
 *    differentiated against nothing.
 *
 * 2. The "Daily Brief" group had collected 13 settings against 6/3/2/1/1
 *    everywhere else, and four of them were not Daily Brief settings at all:
 *    Gallery retention, the NVR timeline path, the notification-tap toggle,
 *    and the HA install instructions.
 *
 * 3. `orderedKeys` listed 'promptUpdateInfo', which is not a setting and never
 *    was — the lookup silently missed it. Dead entries there are invisible,
 *    so this asserts every ordered key resolves to a real setting.
 *
 * These are read off the source rather than a live provider because
 * constructing StorageSettings requires a Scrypted device host.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf-8');

/** The storageSettings object literal. */
function settingsBlock(): string {
    const start = SRC.indexOf('storageSettings = new StorageSettings');
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf('\n    });', start);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
}

/** setting key -> group name */
function settingGroups(): Map<string, string> {
    const block = settingsBlock();
    const out = new Map<string, string>();
    // Each entry is `        key: {` at 8 spaces, followed by its fields.
    const entryRe = /\n {8}([a-zA-Z][a-zA-Z0-9]*): \{/g;
    const starts: Array<{ key: string; at: number }> = [];
    let m;
    while ((m = entryRe.exec(block)) !== null) starts.push({ key: m[1], at: m.index });
    starts.forEach((s, i) => {
        const body = block.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : block.length);
        const g = /group: '([^']*)'/.exec(body);
        if (g) out.set(s.key, g[1]);
    });
    return out;
}

function orderedKeys(): string[] {
    const start = SRC.indexOf('const orderedKeys = [');
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf('];', start);
    return SRC.slice(start, end)
        .split('\n')
        .map(l => /^\s*'([^']+)',/.exec(l)?.[1])
        .filter((k): k is string => !!k);
}

describe('setting groups', () => {
    it('has no group called "Per-Event Notifications"', () => {
        const groups = new Set(settingGroups().values());
        expect(groups.has('Per-Event Notifications')).toBe(false);
    });

    it('no group is overloaded', () => {
        // Daily Brief held 13. Anything above 8 means a group has become a
        // dumping ground again.
        const counts = new Map<string, number>();
        for (const g of settingGroups().values()) counts.set(g, (counts.get(g) ?? 0) + 1);
        const overloaded = [...counts.entries()].filter(([, n]) => n > 8);
        expect(overloaded).toEqual([]);
    });

    it('puts Activity-scoped settings in the Activity group, not Daily Brief', () => {
        const groups = settingGroups();
        // retentionDays governs the Activity tab's history; geminiEmbeddingApiKey
        // powers its search. Neither has anything to do with the Daily Brief.
        expect(groups.get('retentionDays')).toBe('Activity');
        expect(groups.get('geminiEmbeddingApiKey')).toBe('Activity');
    });

    it('puts Home Assistant integration settings in their own group', () => {
        const groups = settingGroups();
        for (const k of ['haCardSetup', 'haNvrTimelinePath', 'enablePerEventBriefClick', 'dailyBriefNotificationUrl']) {
            expect(groups.get(k)).toBe('Home Assistant');
        }
    });

    it('leaves the Daily Brief group holding only Daily Brief settings', () => {
        const groups = settingGroups();
        const brief = [...groups.entries()].filter(([, g]) => g === 'Daily Brief').map(([k]) => k);
        expect(brief.length).toBeGreaterThan(0);
        for (const k of brief) expect(k.startsWith('dailyBrief')).toBe(true);
    });
});

describe('setting titles', () => {
    it('does not call notifications "per-event" any more', () => {
        const block = settingsBlock();
        const titles = [...block.matchAll(/title: '([^']*)'/g)].map(m => m[1]);
        const offenders = titles.filter(t => /per-event/i.test(t));
        expect(offenders).toEqual([]);
    });

    it('keeps a master enable switch', () => {
        expect(settingsBlock()).toMatch(/\n {8}enabled: \{/);
    });
});

describe('orderedKeys', () => {
    it('contains no key that is not a real setting', () => {
        // 'promptUpdateInfo' sat here for months resolving to nothing.
        const defined = settingGroups();
        const ghosts = orderedKeys().filter(k => !defined.has(k));
        expect(ghosts).toEqual([]);
    });

    it('orders every defined setting explicitly', () => {
        // Anything omitted falls through to the "leftovers" append, landing in
        // an arbitrary spot at the bottom of the panel.
        const ordered = new Set(orderedKeys());
        const missing = [...settingGroups().keys()].filter(k => !ordered.has(k));
        expect(missing).toEqual([]);
    });
});
