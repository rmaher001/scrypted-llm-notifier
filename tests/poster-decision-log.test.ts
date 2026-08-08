/**
 * Tests for PosterDecisionLog — append-only JSONL of per-event poster
 * decisions. Diagnostic-only, used to debug why some events end up without
 * a poster (and which path failed).
 *
 * Per 2026-05-16 spec amendment §4.7 (v0.3.120 observability).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PosterDecisionLog, PosterDecision } from '../src/poster-decision-log';

let tmpDir: string;
let log: PosterDecisionLog;

beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'poster-decision-test-'));
    log = new PosterDecisionLog(path.join(tmpDir, 'poster-decisions.jsonl'));
});

afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
});

function decision(overrides: Partial<PosterDecision> = {}): PosterDecision {
    return {
        id: overrides.id ?? 'evt-1',
        ts: overrides.ts ?? Date.now(),
        cameraId: overrides.cameraId ?? 'cam-1',
        cameraName: overrides.cameraName ?? 'Test Camera',
        source: overrides.source ?? 'subjectCrop',
        hasPoster: overrides.hasPoster ?? true,
        cameraHasVideoRecorder: overrides.cameraHasVideoRecorder ?? true,
        ...overrides,
    };
}

describe('PosterDecisionLog', () => {
    it('appends a single decision and reads it back', async () => {
        const d = decision({ id: 'a' });
        await log.append(d);
        const rows = await log.loadRecent(10);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('a');
    });

    it('returns rows in reverse-chronological order (newest first)', async () => {
        await log.append(decision({ id: 'old', ts: 1000 }));
        await log.append(decision({ id: 'new', ts: 2000 }));
        const rows = await log.loadRecent(10);
        expect(rows.map(r => r.id)).toEqual(['new', 'old']);
    });

    it('limits to the requested count', async () => {
        for (let i = 0; i < 5; i++) {
            await log.append(decision({ id: `e${i}`, ts: i * 100 }));
        }
        const rows = await log.loadRecent(3);
        expect(rows).toHaveLength(3);
        expect(rows.map(r => r.id)).toEqual(['e4', 'e3', 'e2']);
    });

    it('returns empty when the log file does not yet exist', async () => {
        const rows = await log.loadRecent(10);
        expect(rows).toEqual([]);
    });

    it('preserves diagnostic fields (errors, sizes, cameraHasVideoRecorder, hasPoster)', async () => {
        await log.append(decision({
            id: 'fail',
            source: 'none',
            hasPoster: false,
            cameraHasVideoRecorder: false,
            detectionInputError: 'Detection not found. It may have expired.',
            nvrSeekError: 'No interface',
            reason: 'rawSource undefined',
        }));
        const [row] = await log.loadRecent(10);
        expect(row.source).toBe('none');
        expect(row.hasPoster).toBe(false);
        expect(row.cameraHasVideoRecorder).toBe(false);
        expect(row.detectionInputError).toMatch(/Detection not found/);
        expect(row.nvrSeekError).toBe('No interface');
        expect(row.reason).toBe('rawSource undefined');
    });

    it('survives a single malformed JSONL line and returns the rest', async () => {
        await log.append(decision({ id: 'a' }));
        // Simulate corruption: append a non-JSON line directly.
        await fsp.appendFile(path.join(tmpDir, 'poster-decisions.jsonl'), 'NOT VALID JSON\n');
        await log.append(decision({ id: 'b' }));
        const rows = await log.loadRecent(10);
        expect(rows.map(r => r.id).sort()).toEqual(['a', 'b']);
    });
});
