// Tests for the one-shot Stories-grouping migration:
// - NotificationStore.stripLegacyGroupFields strips group fields in-memory
//   and rewrites the JSONL log; idempotent.
// - main.ts runs the migration on startup (pinned via grep).

import { NotificationStore } from '../src/notification-store';
import { NotificationLog } from '../src/notification-log';
import { StoredNotification } from '../src/types';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

function makeStorage() {
    const s = new Map<string, string>();
    return {
        getItem: (k: string) => s.get(k) ?? null,
        setItem: (k: string, v: string) => { s.set(k, v); },
        removeItem: (k: string) => { s.delete(k); },
    };
}

function baseNotif(id: string): StoredNotification {
    return {
        id,
        timestamp: Date.now(),
        cameraId: 'cam-1',
        cameraName: 'Cam 1',
        detectionType: 'person',
        names: [],
        llmTitle: 'Title',
        llmSubtitle: '',
        llmBody: 'Body',
    };
}

describe('NotificationStore.stripLegacyGroupFields', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notif-strip-'));
    });

    afterEach(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('strips groupId / isGroupPrimary / llmGroup* fields and rewrites the JSONL', async () => {
        const store = new NotificationStore(makeStorage(), async () => tmpDir);
        await store.initDiskStorage();

        const n1 = baseNotif('n1') as any;
        n1.groupId = 'group-old';
        n1.isGroupPrimary = true;
        n1.llmGroupTitle = 'Group T';
        n1.llmGroupSubtitle = 'Group S';
        n1.llmGroupBody = 'Group B';
        store.add(n1);
        const n2 = baseNotif('n2') as any;
        n2.groupId = 'group-old';
        store.add(n2);
        const n3 = baseNotif('n3');  // no group fields
        store.add(n3);

        const modified = store.stripLegacyGroupFields();
        expect(modified).toBe(2);

        const after = store.getById('n1') as any;
        expect(after.groupId).toBeUndefined();
        expect(after.isGroupPrimary).toBeUndefined();
        expect(after.llmGroupTitle).toBeUndefined();
        expect(after.llmGroupSubtitle).toBeUndefined();
        expect(after.llmGroupBody).toBeUndefined();
        // Non-group record unaffected
        expect(store.getById('n3')!.cameraName).toBe('Cam 1');

        // JSONL on disk was rewritten — no group fields present in any line.
        const jsonl = await fsp.readFile(path.join(tmpDir, 'notifications.jsonl'), 'utf-8');
        expect(jsonl).not.toMatch(/groupId/);
        expect(jsonl).not.toMatch(/isGroupPrimary/);
        expect(jsonl).not.toMatch(/llmGroupTitle/);
        expect(jsonl).not.toMatch(/llmGroupSubtitle/);
        expect(jsonl).not.toMatch(/llmGroupBody/);
    });

    it('is idempotent — second call returns 0 with no further mutation', async () => {
        const store = new NotificationStore(makeStorage(), async () => tmpDir);
        await store.initDiskStorage();
        const n1 = baseNotif('n1') as any;
        n1.groupId = 'g';
        store.add(n1);
        expect(store.stripLegacyGroupFields()).toBe(1);
        expect(store.stripLegacyGroupFields()).toBe(0);
    });

    it('returns 0 when there are no records with any group fields', async () => {
        const store = new NotificationStore(makeStorage(), async () => tmpDir);
        await store.initDiskStorage();
        store.add(baseNotif('n1'));
        store.add(baseNotif('n2'));
        expect(store.stripLegacyGroupFields()).toBe(0);
    });
});

describe('main.ts wires the stories migration on startup', () => {
    const ROOT = path.resolve(__dirname, '..');
    const mainTs = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf-8');

    it('declares runStoriesGroupingMigration method', () => {
        expect(mainTs).toMatch(/private async runStoriesGroupingMigration\(\)/);
    });

    it('calls the migration in the constructor (fire-and-forget)', () => {
        expect(mainTs).toMatch(/this\.runStoriesGroupingMigration\(\)\.catch\(/);
    });

    it('migration prunes posters/group-* files', () => {
        const idx = mainTs.indexOf('runStoriesGroupingMigration');
        // Find method body start
        const methodStart = mainTs.indexOf('private async runStoriesGroupingMigration(');
        expect(methodStart).toBeGreaterThan(-1);
        const block = mainTs.substring(methodStart, methodStart + 2500);
        expect(block).toMatch(/posters/);
        expect(block).toMatch(/startsWith\('group-'\)/);
        expect(block).toMatch(/fsp\.unlink/);
    });

    it('migration calls stripLegacyGroupFields on notificationStore', () => {
        const methodStart = mainTs.indexOf('private async runStoriesGroupingMigration(');
        const block = mainTs.substring(methodStart, methodStart + 2500);
        expect(block).toMatch(/this\.notificationStore\.stripLegacyGroupFields\(\)/);
    });
});
