import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { PersonStore, PersonReference } from '../src/person-store';

let tmpDir: string;
let store: PersonStore;

const SAMPLE_JPEG = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0,
    0x00, 0x10, 0x4A, 0x46,
    0x49, 0x46, 0x00, 0x01,
    0xFF, 0xD9
]);

const SAMPLE_JPEG_2 = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0,
    0x00, 0x10, 0x4A, 0x46,
    0x49, 0x46, 0x00, 0x02,
    0xFF, 0xD9
]);

beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'person-store-test-'));
    store = new PersonStore(async () => tmpDir);
});

afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('PersonStore', () => {
    describe('normalizeName', () => {
        it('lowercases names', () => {
            expect(store.normalizeName('Richard')).toBe('richard');
        });

        it('trims whitespace', () => {
            expect(store.normalizeName('  Richard  ')).toBe('richard');
        });

        it('handles mixed case and whitespace', () => {
            expect(store.normalizeName('  OLESIA  ')).toBe('olesia');
        });

        it('treats different names as different people', () => {
            expect(store.normalizeName('Rich')).not.toBe(store.normalizeName('Richard'));
        });
    });

    describe('curate', () => {
        it('stores JPEG and metadata for a new person', async () => {
            const stored = await store.curate('Richard', SAMPLE_JPEG, 7, 'Front Door');
            expect(stored).toBe(true);

            const photo = await store.getPhoto('Richard');
            expect(photo).not.toBeNull();
            expect(Buffer.compare(photo!, SAMPLE_JPEG)).toBe(0);

            const meta = await store.getMetadata('Richard');
            expect(meta).toBeDefined();
            expect(meta!.name).toBe('Richard');
            expect(meta!.clarityScore).toBe(7);
            expect(meta!.cameraName).toBe('Front Door');
            expect(meta!.updatedAt).toBeGreaterThan(0);
        });

        it('overwrites when new clarity is strictly higher', async () => {
            await store.curate('Olesia', SAMPLE_JPEG, 5);
            const stored = await store.curate('Olesia', SAMPLE_JPEG_2, 8, 'Backyard');
            expect(stored).toBe(true);

            const meta = await store.getMetadata('Olesia');
            expect(meta!.clarityScore).toBe(8);
            expect(meta!.cameraName).toBe('Backyard');

            const photo = await store.getPhoto('Olesia');
            expect(Buffer.compare(photo!, SAMPLE_JPEG_2)).toBe(0);
        });

        it('does NOT overwrite when new clarity is lower', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 8);
            const stored = await store.curate('Richard', SAMPLE_JPEG_2, 5);
            expect(stored).toBe(false);

            const meta = await store.getMetadata('Richard');
            expect(meta!.clarityScore).toBe(8);

            const photo = await store.getPhoto('Richard');
            expect(Buffer.compare(photo!, SAMPLE_JPEG)).toBe(0);
        });

        it('does NOT overwrite when new clarity is equal', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            const stored = await store.curate('Richard', SAMPLE_JPEG_2, 7);
            expect(stored).toBe(false);

            const photo = await store.getPhoto('Richard');
            expect(Buffer.compare(photo!, SAMPLE_JPEG)).toBe(0);
        });

        it('normalizes name for file storage', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            await store.curate('richard', SAMPLE_JPEG_2, 9);

            // Should overwrite since same normalized name and higher clarity
            const all = await store.getAllPeople();
            expect(all).toHaveLength(1);
        });
    });

    describe('getPhoto', () => {
        it('returns buffer for existing person', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            const photo = await store.getPhoto('Richard');
            expect(photo).not.toBeNull();
            expect(Buffer.compare(photo!, SAMPLE_JPEG)).toBe(0);
        });

        it('returns null for non-existent person', async () => {
            const photo = await store.getPhoto('Nobody');
            expect(photo).toBeNull();
        });

        it('is case-insensitive', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            const photo = await store.getPhoto('RICHARD');
            expect(photo).not.toBeNull();
        });
    });

    describe('getMetadata', () => {
        it('returns reference for existing person', async () => {
            await store.curate('Olesia', SAMPLE_JPEG, 6, 'Kitchen');
            const meta = await store.getMetadata('Olesia');
            expect(meta).toBeDefined();
            expect(meta!.name).toBe('Olesia');
            expect(meta!.clarityScore).toBe(6);
            expect(meta!.cameraName).toBe('Kitchen');
        });

        it('returns undefined for non-existent person', async () => {
            const meta = await store.getMetadata('Ghost');
            expect(meta).toBeUndefined();
        });

        it('is case-insensitive', async () => {
            await store.curate('Olesia', SAMPLE_JPEG, 6);
            const meta = await store.getMetadata('olesia');
            expect(meta).toBeDefined();
        });
    });

    describe('getAllPeople', () => {
        it('returns all stored references', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            await store.curate('Olesia', SAMPLE_JPEG, 6);

            const all = await store.getAllPeople();
            expect(all).toHaveLength(2);
            const names = all.map(p => p.name);
            expect(names).toContain('Richard');
            expect(names).toContain('Olesia');
        });

        it('returns empty array when no people stored', async () => {
            const all = await store.getAllPeople();
            expect(all).toEqual([]);
        });
    });

    describe('getAllReferenceImages', () => {
        it('returns Map of name to base64 data URLs', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            await store.curate('Olesia', SAMPLE_JPEG_2, 6);

            const refs = await store.getAllReferenceImages();
            expect(refs.size).toBe(2);
            expect(refs.has('Richard')).toBe(true);
            expect(refs.has('Olesia')).toBe(true);

            const richardUrl = refs.get('Richard')!;
            expect(richardUrl).toMatch(/^data:image\/jpeg;base64,/);

            // Verify the base64 decodes to the original JPEG
            const decoded = Buffer.from(richardUrl.replace('data:image/jpeg;base64,', ''), 'base64');
            expect(Buffer.compare(decoded, SAMPLE_JPEG)).toBe(0);
        });

        it('returns empty Map when no people stored', async () => {
            const refs = await store.getAllReferenceImages();
            expect(refs.size).toBe(0);
        });

        it('skips people with missing photo files', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);

            // Manually delete the photo file
            const peopleDir = path.join(tmpDir, 'people');
            const files = await fsp.readdir(peopleDir);
            for (const f of files) {
                if (f.endsWith('.jpg')) {
                    await fsp.unlink(path.join(peopleDir, f));
                }
            }

            const refs = await store.getAllReferenceImages();
            expect(refs.size).toBe(0);
        });
    });

    describe('remove', () => {
        it('deletes JPEG and metadata entry', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            const removed = await store.remove('Richard');
            expect(removed).toBe(true);

            expect(await store.getPhoto('Richard')).toBeNull();
            expect(await store.getMetadata('Richard')).toBeUndefined();
        });

        it('returns false for non-existent person', async () => {
            const removed = await store.remove('Nobody');
            expect(removed).toBe(false);
        });

        it('does not affect other people', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            await store.curate('Olesia', SAMPLE_JPEG_2, 6);

            await store.remove('Richard');
            const all = await store.getAllPeople();
            expect(all).toHaveLength(1);
            expect(all[0].name).toBe('Olesia');
        });
    });

    describe('prune', () => {
        it('removes people not in the provided name set', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            await store.curate('Olesia', SAMPLE_JPEG, 6);
            await store.curate('Zoia', SAMPLE_JPEG, 5);

            const pruned = await store.prune(new Set(['Richard', 'Olesia']));
            expect(pruned).toBe(1);

            const all = await store.getAllPeople();
            expect(all).toHaveLength(2);
            expect(all.map(p => p.name)).not.toContain('Zoia');
        });

        it('returns 0 when nothing to prune', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            const pruned = await store.prune(new Set(['Richard']));
            expect(pruned).toBe(0);
        });

        it('handles empty store gracefully', async () => {
            const pruned = await store.prune(new Set());
            expect(pruned).toBe(0);
        });

        it('is case-insensitive on name matching', async () => {
            await store.curate('Richard', SAMPLE_JPEG, 7);
            // Prune with lowercase — Richard should be kept
            const pruned = await store.prune(new Set(['richard']));
            expect(pruned).toBe(0);
        });
    });

    describe('ensureDir', () => {
        it('creates people subdirectory on first curate', async () => {
            const peopleDir = path.join(tmpDir, 'people');
            expect(fs.existsSync(peopleDir)).toBe(false);
            await store.curate('Richard', SAMPLE_JPEG, 7);
            expect(fs.existsSync(peopleDir)).toBe(true);
        });

        it('retries after getFilesPath failure', async () => {
            let callCount = 0;
            const flaky = new PersonStore(async () => {
                callCount++;
                if (callCount === 1) throw new Error('SDK not ready');
                return tmpDir;
            });

            // First call should fail
            await expect(flaky.curate('Test', SAMPLE_JPEG, 5)).rejects.toThrow('SDK not ready');

            // Second call should succeed (retry)
            await flaky.curate('Test', SAMPLE_JPEG, 5);
            const photo = await flaky.getPhoto('Test');
            expect(photo).not.toBeNull();
            expect(callCount).toBe(2);
        });
    });
});
