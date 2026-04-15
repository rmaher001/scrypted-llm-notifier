import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// PosterStore will be imported after we create it
// For now, these tests should FAIL (RED phase)
import { PosterStore } from '../src/poster-store';

let tmpDir: string;
let store: PosterStore;

const SAMPLE_JPEG = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0,  // JPEG SOI + APP0 marker
    0x00, 0x10, 0x4A, 0x46,  // Length + "JF"
    0x49, 0x46, 0x00, 0x01,  // "IF" + version
    // ... minimal JPEG header (not a real image, just bytes for testing)
    0xFF, 0xD9               // JPEG EOI
]);

beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'poster-store-test-'));
    store = new PosterStore(async () => tmpDir);
});

afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('PosterStore', () => {
    describe('put + get', () => {
        test('stores and retrieves a JPEG buffer', async () => {
            await store.put('notif-123', SAMPLE_JPEG);
            const result = await store.get('notif-123');
            expect(result).not.toBeNull();
            expect(Buffer.compare(result!, SAMPLE_JPEG)).toBe(0);
        });

        test('returns null for non-existent id', async () => {
            const result = await store.get('does-not-exist');
            expect(result).toBeNull();
        });

        test('overwrites existing poster', async () => {
            const buf1 = Buffer.from([0xFF, 0xD8, 0x01, 0xFF, 0xD9]);
            const buf2 = Buffer.from([0xFF, 0xD8, 0x02, 0xFF, 0xD9]);
            await store.put('notif-456', buf1);
            await store.put('notif-456', buf2);
            const result = await store.get('notif-456');
            expect(Buffer.compare(result!, buf2)).toBe(0);
        });
    });

    describe('has', () => {
        test('returns true when poster exists', async () => {
            await store.put('notif-abc', SAMPLE_JPEG);
            expect(await store.has('notif-abc')).toBe(true);
        });

        test('returns false when poster does not exist', async () => {
            expect(await store.has('no-such-id')).toBe(false);
        });
    });

    describe('pruneOlderThan', () => {
        test('deletes files older than specified days', async () => {
            await store.put('old-1', SAMPLE_JPEG);
            await store.put('old-2', SAMPLE_JPEG);
            await store.put('recent', SAMPLE_JPEG);

            // Backdate old files to 10 days ago
            const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
            const postersDir = path.join(tmpDir, 'posters');
            await fsp.utimes(path.join(postersDir, 'old-1.jpg'), tenDaysAgo, tenDaysAgo);
            await fsp.utimes(path.join(postersDir, 'old-2.jpg'), tenDaysAgo, tenDaysAgo);

            const pruned = await store.pruneOlderThan(5);

            expect(pruned).toBe(2);
            expect(await store.has('old-1')).toBe(false);
            expect(await store.has('old-2')).toBe(false);
            expect(await store.has('recent')).toBe(true);
        });

        test('returns 0 when no files are old enough', async () => {
            await store.put('fresh', SAMPLE_JPEG);
            const pruned = await store.pruneOlderThan(5);
            expect(pruned).toBe(0);
        });

        test('handles empty directory gracefully', async () => {
            const pruned = await store.pruneOlderThan(5);
            expect(pruned).toBe(0);
        });
    });

    describe('sanitizeId', () => {
        test('handles IDs with special characters', async () => {
            const specialId = 'cam/front:2026-03-01T12:00:00.000Z';
            await store.put(specialId, SAMPLE_JPEG);
            const result = await store.get(specialId);
            expect(result).not.toBeNull();
            expect(Buffer.compare(result!, SAMPLE_JPEG)).toBe(0);
        });

        test('handles IDs with path traversal attempts', async () => {
            const maliciousId = '../../../etc/passwd';
            await store.put(maliciousId, SAMPLE_JPEG);
            // File should be in the posters dir, not traversing up
            const result = await store.get(maliciousId);
            expect(result).not.toBeNull();
            // Verify the file is actually in the posters subdirectory
            const postersDir = path.join(tmpDir, 'posters');
            const files = await fsp.readdir(postersDir);
            expect(files.length).toBe(1);
            // Filename should not contain path separators
            expect(files[0]).not.toMatch(/[\/\\]/);
        });
    });

    describe('ensureDir', () => {
        test('creates posters subdirectory on first put', async () => {
            const postersDir = path.join(tmpDir, 'posters');
            expect(fs.existsSync(postersDir)).toBe(false);
            await store.put('first', SAMPLE_JPEG);
            expect(fs.existsSync(postersDir)).toBe(true);
        });

        test('works when posters directory already exists', async () => {
            await fsp.mkdir(path.join(tmpDir, 'posters'), { recursive: true });
            await store.put('second', SAMPLE_JPEG);
            const result = await store.get('second');
            expect(result).not.toBeNull();
        });

        test('retries after getFilesPath failure', async () => {
            let callCount = 0;
            const flaky = new PosterStore(async () => {
                callCount++;
                if (callCount === 1) throw new Error('SDK not ready');
                return tmpDir;
            });

            // First call should fail
            await expect(flaky.put('retry-test', SAMPLE_JPEG)).rejects.toThrow('SDK not ready');

            // Second call should succeed (retry)
            await flaky.put('retry-test', SAMPLE_JPEG);
            const result = await flaky.get('retry-test');
            expect(result).not.toBeNull();
            expect(callCount).toBe(2);
        });
    });
});
