/**
 * Phase 4: JPEG header parsing + reference image cache.
 * - getJpegDimensions: parse SOF marker instead of full decode
 * - PersonStore.getAllReferenceImages: cache with 30s TTL
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getJpegDimensions } from '../src/utils';
import { PersonStore } from '../src/person-store';

// Minimal valid JPEG with SOF0 marker (2x2 pixel)
// JPEG: FF D8 (SOI), FF E0 (APP0 header), FF C0 (SOF0 with dimensions), FF D9 (EOI)
function createMinimalJpeg(width: number, height: number): Buffer {
    return Buffer.from([
        0xFF, 0xD8,                         // SOI
        0xFF, 0xE0, 0x00, 0x10,             // APP0 marker + length 16
        0x4A, 0x46, 0x49, 0x46, 0x00,       // JFIF\0
        0x01, 0x01, 0x00, 0x00, 0x01,       // version, units, density
        0x00, 0x01, 0x00, 0x00,             // density, thumbnail
        0xFF, 0xC0, 0x00, 0x0B,             // SOF0 marker + length 11
        0x08,                                // precision 8 bits
        (height >> 8) & 0xFF, height & 0xFF, // height (2 bytes big-endian)
        (width >> 8) & 0xFF, width & 0xFF,   // width (2 bytes big-endian)
        0x01,                                // components
        0x01, 0x11, 0x00,                    // component data
        0xFF, 0xD9,                          // EOI
    ]);
}

describe('getJpegDimensions SOF parsing', () => {
    it('extracts dimensions from SOF0 marker without full decode', () => {
        const jpeg = createMinimalJpeg(640, 480);
        const { width, height } = getJpegDimensions(jpeg);
        expect(width).toBe(640);
        expect(height).toBe(480);
    });

    it('handles large dimensions', () => {
        const jpeg = createMinimalJpeg(3840, 2160);
        const { width, height } = getJpegDimensions(jpeg);
        expect(width).toBe(3840);
        expect(height).toBe(2160);
    });

    it('throws on non-JPEG input', () => {
        const notJpeg = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header
        expect(() => getJpegDimensions(notJpeg)).toThrow();
    });

    it('throws on truncated JPEG', () => {
        // SOI + start of APP0 but truncated before SOF
        const truncated = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
        expect(() => getJpegDimensions(truncated)).toThrow();
    });

    it('handles 0xFF fill bytes before marker', () => {
        // SOI + 0xFF fill byte + APP0 + SOF0
        const jpeg = Buffer.from([
            0xFF, 0xD8,
            0xFF, 0xFF, 0xE0, 0x00, 0x10,      // extra 0xFF fill before APP0
            0x4A, 0x46, 0x49, 0x46, 0x00,
            0x01, 0x01, 0x00, 0x00, 0x01,
            0x00, 0x01, 0x00, 0x00,
            0xFF, 0xC0, 0x00, 0x0B,
            0x08,
            0x00, 0x64, 0x00, 0xC8,             // 100x200
            0x01, 0x01, 0x11, 0x00,
            0xFF, 0xD9,
        ]);
        const { width, height } = getJpegDimensions(jpeg);
        expect(width).toBe(200);
        expect(height).toBe(100);
    });
});

describe('PersonStore reference image cache', () => {
    let tmpDir: string;
    let store: PersonStore;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'person-cache-'));
        store = new PersonStore(() => Promise.resolve(tmpDir));
    });

    afterEach(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns cached result on second call within TTL', async () => {
        // Write a reference photo
        const peopleDir = path.join(tmpDir, 'people');
        await fsp.mkdir(peopleDir, { recursive: true });
        await fsp.writeFile(path.join(peopleDir, 'metadata.json'), JSON.stringify([
            { name: 'Alice', clarityScore: 8, updatedAt: Date.now() }
        ]));
        await fsp.writeFile(path.join(peopleDir, 'alice.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));

        const first = await store.getAllReferenceImages();
        const second = await store.getAllReferenceImages();

        // Same Map reference = cached
        expect(first).toBe(second);
    });

    it('invalidates cache after curate()', async () => {
        // Setup initial reference
        const peopleDir = path.join(tmpDir, 'people');
        await fsp.mkdir(peopleDir, { recursive: true });
        await fsp.writeFile(path.join(peopleDir, 'metadata.json'), JSON.stringify([
            { name: 'Alice', clarityScore: 5, updatedAt: Date.now() }
        ]));
        await fsp.writeFile(path.join(peopleDir, 'alice.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));

        const first = await store.getAllReferenceImages();

        // Curate with higher clarity — should invalidate cache
        await store.curate('Alice', Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]), 9);

        const second = await store.getAllReferenceImages();
        expect(first).not.toBe(second);
    });

    it('invalidates cache after remove()', async () => {
        const peopleDir = path.join(tmpDir, 'people');
        await fsp.mkdir(peopleDir, { recursive: true });
        await fsp.writeFile(path.join(peopleDir, 'metadata.json'), JSON.stringify([
            { name: 'Alice', clarityScore: 8, updatedAt: Date.now() }
        ]));
        await fsp.writeFile(path.join(peopleDir, 'alice.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));

        const first = await store.getAllReferenceImages();
        await store.remove('Alice');
        const second = await store.getAllReferenceImages();

        expect(first).not.toBe(second);
    });

    it('invalidates cache after prune()', async () => {
        const peopleDir = path.join(tmpDir, 'people');
        await fsp.mkdir(peopleDir, { recursive: true });
        await fsp.writeFile(path.join(peopleDir, 'metadata.json'), JSON.stringify([
            { name: 'Alice', clarityScore: 8, updatedAt: Date.now() },
            { name: 'Bob', clarityScore: 7, updatedAt: Date.now() },
        ]));
        await fsp.writeFile(path.join(peopleDir, 'alice.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
        await fsp.writeFile(path.join(peopleDir, 'bob.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));

        const first = await store.getAllReferenceImages();
        expect(first.size).toBe(2);

        // Prune with only Alice known — Bob should be removed
        await store.prune(new Set(['Alice']));
        const second = await store.getAllReferenceImages();

        expect(first).not.toBe(second);
        expect(second.size).toBe(1);
    });
});
