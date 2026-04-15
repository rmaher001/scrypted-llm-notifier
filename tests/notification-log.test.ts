/**
 * Tests for NotificationLog — append-only JSONL file storage.
 * Pure filesystem module, no Scrypted deps.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { NotificationLog } from '../src/notification-log';
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

let tmpDir: string;
let log: NotificationLog<StoredNotification>;

beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notif-log-test-'));
    log = new NotificationLog<StoredNotification>(path.join(tmpDir, 'notifications.jsonl'));
});

afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('append', () => {
    it('writes one line to file', async () => {
        const n = makeNotification('n1');
        await log.append(n);

        const content = await fsp.readFile(path.join(tmpDir, 'notifications.jsonl'), 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]).id).toBe('n1');
    });

    it('appends multiple notifications as separate lines', async () => {
        await log.append(makeNotification('n1'));
        await log.append(makeNotification('n2'));
        await log.append(makeNotification('n3'));

        const content = await fsp.readFile(path.join(tmpDir, 'notifications.jsonl'), 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(3);
    });
});

describe('loadAll', () => {
    it('reads all lines and parses', async () => {
        await log.append(makeNotification('n1', { llmTitle: 'First' }));
        await log.append(makeNotification('n2', { llmTitle: 'Second' }));

        const notifications = await log.loadAll();
        expect(notifications).toHaveLength(2);
        expect(notifications.find(n => n.id === 'n1')?.llmTitle).toBe('First');
        expect(notifications.find(n => n.id === 'n2')?.llmTitle).toBe('Second');
    });

    it('deduplicates by ID — last write wins', async () => {
        await log.append(makeNotification('n1', { llmTitle: 'Original' }));
        await log.append(makeNotification('n1', { llmTitle: 'Updated' }));

        const notifications = await log.loadAll();
        expect(notifications).toHaveLength(1);
        expect(notifications[0].llmTitle).toBe('Updated');
    });

    it('returns empty array for missing file', async () => {
        const emptyLog = new NotificationLog<StoredNotification>(path.join(tmpDir, 'nonexistent.jsonl'));
        const notifications = await emptyLog.loadAll();
        expect(notifications).toEqual([]);
    });

    it('returns empty array for empty file', async () => {
        await fsp.writeFile(path.join(tmpDir, 'notifications.jsonl'), '');
        const notifications = await log.loadAll();
        expect(notifications).toEqual([]);
    });

    it('skips malformed lines gracefully', async () => {
        await log.append(makeNotification('n1'));
        await fsp.appendFile(path.join(tmpDir, 'notifications.jsonl'), 'not valid json\n');
        await log.append(makeNotification('n2'));

        const notifications = await log.loadAll();
        expect(notifications).toHaveLength(2);
        expect(notifications.map(n => n.id).sort()).toEqual(['n1', 'n2']);
    });
});

describe('compact', () => {
    it('rewrites file with only given notifications', async () => {
        await log.append(makeNotification('n1'));
        await log.append(makeNotification('n2'));
        await log.append(makeNotification('n3'));

        await log.compact([makeNotification('n1'), makeNotification('n3')]);

        const notifications = await log.loadAll();
        expect(notifications).toHaveLength(2);
        expect(notifications.map(n => n.id).sort()).toEqual(['n1', 'n3']);
    });

    it('creates a clean file with no duplicate entries', async () => {
        await log.append(makeNotification('n1', { llmTitle: 'V1' }));
        await log.append(makeNotification('n1', { llmTitle: 'V2' }));
        await log.append(makeNotification('n1', { llmTitle: 'V3' }));

        const current = await log.loadAll();
        await log.compact(current);

        const content = await fsp.readFile(path.join(tmpDir, 'notifications.jsonl'), 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]).llmTitle).toBe('V3');
    });

    it('handles empty compaction', async () => {
        await log.append(makeNotification('n1'));
        await log.compact([]);

        const notifications = await log.loadAll();
        expect(notifications).toEqual([]);
    });
});
