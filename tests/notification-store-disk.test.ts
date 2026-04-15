/**
 * Tests for NotificationStore disk wiring — JSONL append-only log integration.
 * Phase 2 of memory optimization: replace storage.setItem with filesystem append.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
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

function makeStorage(initial?: Record<string, string>): any {
    const data: Record<string, string> = { ...initial };
    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: jest.fn((key: string, value: string) => { data[key] = value; }),
        removeItem: jest.fn((key: string) => { delete data[key]; }),
        _data: data,
    };
}

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notif-store-disk-'));
});

afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
});

function getFilesPath(): Promise<string> {
    return Promise.resolve(tmpDir);
}

async function readJsonl(filename: string): Promise<any[]> {
    try {
        const content = await fsp.readFile(path.join(tmpDir, filename), 'utf-8');
        if (!content.trim()) return [];
        return content.trim().split('\n').map(line => JSON.parse(line));
    } catch (e: any) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

describe('NotificationStore disk wiring', () => {
    describe('add() after initDiskStorage', () => {
        it('appends to JSONL file instead of legacy save', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            store.add(makeNotification('n1'));

            const lines = await readJsonl('notifications.jsonl');
            expect(lines).toHaveLength(1);
            expect(lines[0].id).toBe('n1');

            // Legacy save should NOT have been called after disk init
            // (It gets called once during constructor load, so we check no additional calls)
            const saveCalls = storage.setItem.mock.calls.filter(
                (c: any[]) => c[0] === 'dailyBriefNotifications'
            );
            expect(saveCalls).toHaveLength(0);
        });
    });

    describe('add() before initDiskStorage', () => {
        it('falls back to legacy save', () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            // Do NOT call initDiskStorage — disk not ready

            store.add(makeNotification('n1'));

            // Legacy save should have been called
            const saveCalls = storage.setItem.mock.calls.filter(
                (c: any[]) => c[0] === 'dailyBriefNotifications'
            );
            expect(saveCalls.length).toBeGreaterThan(0);
        });
    });

    describe('migration', () => {
        it('writes legacy storage data to JSONL and removes legacy key', async () => {
            const n1 = makeNotification('n1');
            const n2 = makeNotification('n2');
            const storage = makeStorage({
                dailyBriefNotifications: JSON.stringify([n1, n2]),
            });
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            // JSONL file should contain migrated notifications
            const lines = await readJsonl('notifications.jsonl');
            expect(lines).toHaveLength(2);
            expect(lines.map((l: any) => l.id).sort()).toEqual(['n1', 'n2']);

            // Legacy storage key should be removed
            expect(storage.removeItem).toHaveBeenCalledWith('dailyBriefNotifications');
        });

        it('loads from existing JSONL file on subsequent startups', async () => {
            // Simulate a previous session's JSONL file
            const n1 = makeNotification('n1', { llmTitle: 'From Disk' });
            await fsp.writeFile(
                path.join(tmpDir, 'notifications.jsonl'),
                JSON.stringify(n1) + '\n'
            );

            const storage = makeStorage(); // no legacy data
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            const loaded = store.getById('n1');
            expect(loaded).toBeDefined();
            expect(loaded!.llmTitle).toBe('From Disk');
        });
    });

    describe('updateGroup() after disk init', () => {
        it('appends updated entries to log', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            store.add(makeNotification('n1'));
            store.add(makeNotification('n2'));
            store.updateGroup(['n1', 'n2'], 'group-abc', 'n1');

            const lines = await readJsonl('notifications.jsonl');
            // 2 initial appends + 2 updated appends = 4 lines
            expect(lines).toHaveLength(4);
            const lastN1 = lines.filter((l: any) => l.id === 'n1').pop();
            expect(lastN1.groupId).toBe('group-abc');
            expect(lastN1.isGroupPrimary).toBe(true);
        });
    });

    describe('markHasPoster() after disk init', () => {
        it('appends updated entry to log', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            store.add(makeNotification('n1', { hasPoster: false }));
            store.markHasPoster('n1');

            const lines = await readJsonl('notifications.jsonl');
            // 1 initial append + 1 update append = 2 lines
            expect(lines).toHaveLength(2);
            const updated = lines[1];
            expect(updated.id).toBe('n1');
            expect(updated.hasPoster).toBe(true);
        });
    });

    describe('pruneNow() after disk init', () => {
        it('compacts the log file removing duplicates and expired', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            const now = Date.now();
            store.add(makeNotification('n1', { timestamp: now }));
            store.add(makeNotification('n2', { timestamp: now }));
            // Update n1 — creates a duplicate line in the log
            store.markHasPoster('n1');

            // Before prune: 3 lines (n1 + n2 + n1-updated)
            let lines = await readJsonl('notifications.jsonl');
            expect(lines).toHaveLength(3);

            store.pruneNow();

            // After prune: compacted to 2 clean entries
            lines = await readJsonl('notifications.jsonl');
            expect(lines).toHaveLength(2);
            expect(lines.map((l: any) => l.id).sort()).toEqual(['n1', 'n2']);
            expect(lines.find((l: any) => l.id === 'n1').hasPoster).toBe(true);
        });
    });

    describe('clear() after disk init', () => {
        it('truncates the log file', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            store.add(makeNotification('n1'));
            store.add(makeNotification('n2'));
            store.clear();

            const lines = await readJsonl('notifications.jsonl');
            expect(lines).toHaveLength(0);
        });
    });

    describe('addEmbedding() after disk init', () => {
        it('appends to embedding log', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            store.addEmbedding('n1', 'base64data', 768);

            const lines = await readJsonl('embeddings.jsonl');
            expect(lines).toHaveLength(1);
            expect(lines[0]).toEqual({ id: 'n1', embedding: 'base64data', dimension: 768 });
        });
    });

    describe('pruneEmbeddings after disk init', () => {
        it('compacts embedding log removing orphans', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            // Add notification and embedding
            store.add(makeNotification('n1'));
            store.addEmbedding('n1', 'emb1', 768);
            store.addEmbedding('n-orphan', 'emb2', 768);

            // Prune should remove orphan embedding (no matching notification)
            store.pruneNow();

            const lines = await readJsonl('embeddings.jsonl');
            expect(lines).toHaveLength(1);
            expect(lines[0].id).toBe('n1');
        });
    });

    describe('add() during init window on second startup', () => {
        it('preserves notifications added before initDiskStorage resolves', async () => {
            // Simulate first startup: write JSONL with one notification
            const n1 = makeNotification('n1', { llmTitle: 'From Disk' });
            await fsp.writeFile(
                path.join(tmpDir, 'notifications.jsonl'),
                JSON.stringify(n1) + '\n'
            );

            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);

            // add() before initDiskStorage completes — goes to legacy save
            store.add(makeNotification('n2', { llmTitle: 'Added During Init' }));

            await store.initDiskStorage();

            // Both n1 (from disk) and n2 (added during init) should exist
            expect(store.getById('n1')).toBeDefined();
            expect(store.getById('n2')).toBeDefined();
            expect(store.getById('n2')!.llmTitle).toBe('Added During Init');
        });
    });

    describe('add() does not write evicted notifications to disk', () => {
        it('skips disk append if notification is pruned away', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            // Add a notification that's older than retention (3 days default)
            const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000;
            store.add(makeNotification('n-expired', { timestamp: oldTimestamp }));

            // Should NOT be on disk (pruned away)
            const lines = await readJsonl('notifications.jsonl');
            expect(lines.find((l: any) => l.id === 'n-expired')).toBeUndefined();

            // Should NOT be in memory either
            expect(store.getById('n-expired')).toBeUndefined();
        });
    });

    describe('initDiskStorage idempotency', () => {
        it('second call is a no-op', async () => {
            const storage = makeStorage();
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            store.add(makeNotification('n1'));

            // Second init should not overwrite
            await store.initDiskStorage();

            expect(store.getById('n1')).toBeDefined();
        });
    });

    describe('getAllIds before initDiskStorage on second startup', () => {
        it('returns IDs from JSONL after init, not empty set', async () => {
            // Simulate second startup: JSONL exists, legacy key removed
            const n1 = makeNotification('n1');
            const n2 = makeNotification('n2');
            await fsp.writeFile(
                path.join(tmpDir, 'notifications.jsonl'),
                [JSON.stringify(n1), JSON.stringify(n2)].join('\n') + '\n'
            );

            const storage = makeStorage(); // no legacy data (key was removed)
            const store = new NotificationStore(storage, getFilesPath);

            // BEFORE initDiskStorage: getAllIds should be empty (legacy key gone)
            const idsBefore = store.getAllIds();
            expect(idsBefore.size).toBe(0);

            await store.initDiskStorage();

            // AFTER initDiskStorage: getAllIds must return all IDs from JSONL
            const idsAfter = store.getAllIds();
            expect(idsAfter.size).toBe(2);
            expect(idsAfter.has('n1')).toBe(true);
            expect(idsAfter.has('n2')).toBe(true);
        });
    });

    describe('embedding migration', () => {
        it('migrates legacy embeddings to JSONL and removes key', async () => {
            const storage = makeStorage({
                dailyBriefEmbeddings: JSON.stringify([
                    ['e1', { embedding: 'data1', dimension: 768 }],
                    ['e2', { embedding: 'data2', dimension: 768 }],
                ]),
            });
            const store = new NotificationStore(storage, getFilesPath);
            await store.initDiskStorage();

            const lines = await readJsonl('embeddings.jsonl');
            expect(lines).toHaveLength(2);
            expect(lines.map((l: any) => l.id).sort()).toEqual(['e1', 'e2']);

            expect(storage.removeItem).toHaveBeenCalledWith('dailyBriefEmbeddings');
        });
    });
});
