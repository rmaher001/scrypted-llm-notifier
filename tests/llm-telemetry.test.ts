/**
 * Tests for LlmTelemetry — per-call telemetry log and aggregation.
 * Pure filesystem + math module, no Scrypted deps.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    LlmTelemetryLog,
    TelemetryRow,
    aggregateTelemetry,
    percentile,
    pruneRows,
    truncateError,
    makeTelemetryId,
} from '../src/llm-telemetry';

let tmpDir: string;
let log: LlmTelemetryLog;

function row(overrides: Partial<TelemetryRow> = {}): TelemetryRow {
    return {
        id: overrides.id ?? makeTelemetryId(),
        ts: overrides.ts ?? Date.now(),
        providerName: overrides.providerName ?? 'gemma4:e4b',
        role: overrides.role ?? 'notification',
        outcome: overrides.outcome ?? 'ok',
        latencyMs: overrides.latencyMs ?? 1000,
        timeoutMs: overrides.timeoutMs ?? 90000,
        promptBytes: overrides.promptBytes ?? 2048,
        ...overrides,
    };
}

beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'llm-telemetry-test-'));
    log = new LlmTelemetryLog(path.join(tmpDir, 'llm-telemetry.jsonl'));
});

afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('makeTelemetryId', () => {
    it('produces unique ids', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 1000; i++) ids.add(makeTelemetryId());
        expect(ids.size).toBe(1000);
    });

    it('returns a reasonably short string', () => {
        const id = makeTelemetryId();
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(4);
        expect(id.length).toBeLessThan(64);
    });
});

describe('truncateError', () => {
    it('returns undefined for undefined', () => {
        expect(truncateError(undefined)).toBeUndefined();
    });

    it('preserves short strings', () => {
        expect(truncateError('boom')).toBe('boom');
    });

    it('truncates long strings to 200 chars max', () => {
        const long = 'x'.repeat(500);
        const result = truncateError(long);
        expect(result!.length).toBeLessThanOrEqual(200);
    });

    it('handles Error instances by extracting message', () => {
        const err = new Error('something broke');
        expect(truncateError(err)).toBe('something broke');
    });

    it('stringifies non-error objects', () => {
        const result = truncateError({ code: 'ETIMEDOUT' });
        expect(result).toContain('ETIMEDOUT');
    });
});

describe('LlmTelemetryLog append + loadAll', () => {
    it('appends and reads back a row', async () => {
        const r = row({ id: 't1', providerName: 'gemma4:e4b' });
        await log.append(r);
        const all = await log.loadAll();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe('t1');
        expect(all[0].providerName).toBe('gemma4:e4b');
    });

    it('appends many rows as separate lines', async () => {
        for (let i = 0; i < 5; i++) await log.append(row({ id: `t${i}` }));
        const all = await log.loadAll();
        expect(all).toHaveLength(5);
    });

    it('returns empty array when file is missing', async () => {
        const empty = new LlmTelemetryLog(path.join(tmpDir, 'nope.jsonl'));
        expect(await empty.loadAll()).toEqual([]);
    });

    it('skips malformed lines', async () => {
        await log.append(row({ id: 't1' }));
        await fsp.appendFile(path.join(tmpDir, 'llm-telemetry.jsonl'), 'garbage\n');
        await log.append(row({ id: 't2' }));
        const all = await log.loadAll();
        expect(all).toHaveLength(2);
    });
});

describe('LlmTelemetryLog loadSince', () => {
    it('filters by timestamp', async () => {
        const now = Date.now();
        await log.append(row({ id: 'old', ts: now - 10_000 }));
        await log.append(row({ id: 'new', ts: now - 1_000 }));
        const recent = await log.loadSince(now - 5_000);
        expect(recent).toHaveLength(1);
        expect(recent[0].id).toBe('new');
    });
});

describe('pruneRows', () => {
    it('drops rows older than cutoff', () => {
        const now = Date.now();
        const rows = [
            row({ id: 'old', ts: now - 20 * 86400_000 }),
            row({ id: 'mid', ts: now - 5 * 86400_000 }),
            row({ id: 'new', ts: now - 1 * 86400_000 }),
        ];
        const kept = pruneRows(rows, 7, now);
        expect(kept.map(r => r.id).sort()).toEqual(['mid', 'new']);
    });

    it('keeps all when all within retention', () => {
        const now = Date.now();
        const rows = [row({ ts: now - 1000 }), row({ ts: now - 2000 })];
        expect(pruneRows(rows, 14, now)).toHaveLength(2);
    });

    it('drops all when all older than retention', () => {
        const now = Date.now();
        const rows = [row({ ts: now - 100 * 86400_000 })];
        expect(pruneRows(rows, 14, now)).toEqual([]);
    });
});

describe('percentile', () => {
    it('returns 0 for empty input', () => {
        expect(percentile([], 0.5)).toBe(0);
    });

    it('returns the single value for a one-element array', () => {
        expect(percentile([42], 0.5)).toBe(42);
        expect(percentile([42], 0.95)).toBe(42);
    });

    it('computes median for odd length', () => {
        expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    });

    it('computes p95 correctly on sorted values', () => {
        const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
        const p95 = percentile(values, 0.95);
        expect(p95).toBeGreaterThanOrEqual(95);
        expect(p95).toBeLessThanOrEqual(96);
    });

    it('handles unsorted input (sorts internally)', () => {
        expect(percentile([5, 3, 1, 4, 2], 0.5)).toBe(3);
    });
});

describe('aggregateTelemetry', () => {
    const baseTs = Date.now();

    it('returns empty aggregation for no rows', () => {
        const result = aggregateTelemetry([], baseTs);
        expect(result.providers).toEqual([]);
    });

    it('groups by (providerName, role)', () => {
        const rows = [
            row({ providerName: 'gemma', role: 'notification', latencyMs: 100 }),
            row({ providerName: 'gemma', role: 'notification', latencyMs: 200 }),
            row({ providerName: 'gemini', role: 'daily-brief', latencyMs: 5000 }),
        ];
        const result = aggregateTelemetry(rows, baseTs);
        expect(result.providers).toHaveLength(2);
        const gemma = result.providers.find(p => p.providerName === 'gemma' && p.role === 'notification')!;
        const gemini = result.providers.find(p => p.providerName === 'gemini' && p.role === 'daily-brief')!;
        expect(gemma.count).toBe(2);
        expect(gemini.count).toBe(1);
    });

    it('computes reliability rates from outcomes', () => {
        const rows = [
            row({ providerName: 'p', outcome: 'ok' }),
            row({ providerName: 'p', outcome: 'ok' }),
            row({ providerName: 'p', outcome: 'timeout' }),
            row({ providerName: 'p', outcome: 'error' }),
        ];
        const result = aggregateTelemetry(rows, baseTs);
        const p = result.providers[0];
        expect(p.count).toBe(4);
        expect(p.okRate).toBeCloseTo(0.5, 5);
        expect(p.timeoutRate).toBeCloseTo(0.25, 5);
        expect(p.errorRate).toBeCloseTo(0.25, 5);
    });

    it('computes latency percentiles from ok rows only', () => {
        const rows = [
            ...Array.from({ length: 10 }, (_, i) =>
                row({ providerName: 'p', outcome: 'ok', latencyMs: (i + 1) * 100 }),
            ),
            // errors/timeouts should NOT skew latency stats
            row({ providerName: 'p', outcome: 'timeout', latencyMs: 999999 }),
        ];
        const result = aggregateTelemetry(rows, baseTs);
        const p = result.providers[0];
        expect(p.latencyP50).toBeGreaterThanOrEqual(500);
        expect(p.latencyP50).toBeLessThanOrEqual(600);
        expect(p.latencyP99).toBeLessThanOrEqual(1000);
    });

    it('averages quality signals across ok rows that reported them', () => {
        const rows = [
            row({ providerName: 'p', outcome: 'ok', clarityScore: 6, faceRefScore: 8, detailedDescLen: 100 }),
            row({ providerName: 'p', outcome: 'ok', clarityScore: 8, faceRefScore: 4, detailedDescLen: 200 }),
            row({ providerName: 'p', outcome: 'ok' }), // no quality fields — ignored in means
        ];
        const result = aggregateTelemetry(rows, baseTs);
        const p = result.providers[0];
        expect(p.meanClarity).toBeCloseTo(7, 5);
        expect(p.meanFaceRef).toBeCloseTo(6, 5);
        expect(p.meanDescLen).toBeCloseTo(150, 5);
    });

    it('returns undefined for means when no rows reported the signal', () => {
        const rows = [row({ providerName: 'p', outcome: 'ok' })];
        const result = aggregateTelemetry(rows, baseTs);
        const p = result.providers[0];
        expect(p.meanClarity).toBeUndefined();
        expect(p.meanFaceRef).toBeUndefined();
    });

    it('excludes failed calls from quality means', () => {
        const rows = [
            row({ providerName: 'p', outcome: 'ok', clarityScore: 9 }),
            row({ providerName: 'p', outcome: 'timeout', clarityScore: 1 as any }), // ignored
            row({ providerName: 'p', outcome: 'error' }),
        ];
        const result = aggregateTelemetry(rows, baseTs);
        expect(result.providers[0].meanClarity).toBeCloseTo(9, 5);
    });

    it('aggregates reviewer reassignment + hallucination stats', () => {
        // Of 4 reviewer calls: 2 merged something (reassignmentCount > 0), 2 did not.
        // Total reassignments: 2+0+4+0 = 6. Total hallucinated: 0+1+0+0 = 1.
        const rows = [
            row({ providerName: 'p', role: 'reviewer', outcome: 'ok', reassignmentCount: 2, hallucinatedCount: 0 }),
            row({ providerName: 'p', role: 'reviewer', outcome: 'ok', reassignmentCount: 0, hallucinatedCount: 1 }),
            row({ providerName: 'p', role: 'reviewer', outcome: 'ok', reassignmentCount: 4, hallucinatedCount: 0 }),
            row({ providerName: 'p', role: 'reviewer', outcome: 'ok', reassignmentCount: 0, hallucinatedCount: 0 }),
        ];
        const result = aggregateTelemetry(rows, baseTs);
        const p = result.providers[0];
        expect(p.meanReassignments).toBeCloseTo(1.5, 5);
        expect(p.totalReassignments).toBe(6);
        expect(p.callsWithMerge).toBe(2);
        expect(p.meanHallucinated).toBeCloseTo(0.25, 5);
        expect(p.totalHallucinated).toBe(1);
    });

    it('reviewer stats are undefined when no rows reported reassignmentCount', () => {
        const rows = [row({ providerName: 'p', role: 'reviewer', outcome: 'ok' })];
        const result = aggregateTelemetry(rows, baseTs);
        const p = result.providers[0];
        expect(p.meanReassignments).toBeUndefined();
        expect(p.totalReassignments).toBeUndefined();
        expect(p.callsWithMerge).toBeUndefined();
    });

    it('reviewer stats ignore non-ok rows', () => {
        const rows = [
            row({ providerName: 'p', role: 'reviewer', outcome: 'ok', reassignmentCount: 3, hallucinatedCount: 0 }),
            row({ providerName: 'p', role: 'reviewer', outcome: 'timeout', reassignmentCount: 99 as any }), // ignored
            row({ providerName: 'p', role: 'reviewer', outcome: 'error' }),
        ];
        const result = aggregateTelemetry(rows, baseTs);
        const p = result.providers[0];
        expect(p.meanReassignments).toBeCloseTo(3, 5);
        expect(p.totalReassignments).toBe(3);
        expect(p.callsWithMerge).toBe(1);
    });
});

describe('aggregateTelemetry with judge rows', () => {
    it('folds judge rows into subject-provider aggregates', () => {
        const subject = makeTelemetryId();
        const rows = [
            row({ id: subject, providerName: 'gemma', role: 'notification', outcome: 'ok' }),
        ];
        const judgeRows = [
            {
                subjectId: subject,
                ts: Date.now(),
                judgeProviderName: 'gemini',
                latencyMs: 800,
                accuracyScore: 8,
                completenessScore: 7,
                personIdCorrect: true as const,
                notes: 'looks good',
            },
        ];
        const result = aggregateTelemetry(rows, Date.now(), judgeRows);
        const p = result.providers.find(x => x.providerName === 'gemma')!;
        expect(p.meanJudgeAccuracy).toBeCloseTo(8, 5);
        expect(p.meanJudgeCompleteness).toBeCloseTo(7, 5);
        expect(p.personIdCorrectRate).toBeCloseTo(1, 5);
        expect(p.judgeSampleSize).toBe(1);
    });

    it('ignores judge rows that do not match a telemetry id', () => {
        const rows = [row({ id: 'a', providerName: 'gemma', outcome: 'ok' })];
        const judgeRows = [
            {
                subjectId: 'unknown-id',
                ts: Date.now(),
                judgeProviderName: 'gemini',
                latencyMs: 500,
                accuracyScore: 5,
                completenessScore: 5,
                personIdCorrect: null,
            },
        ];
        const result = aggregateTelemetry(rows, Date.now(), judgeRows);
        expect(result.providers[0].judgeSampleSize ?? 0).toBe(0);
        expect(result.providers[0].meanJudgeAccuracy).toBeUndefined();
    });

    it('averages personIdCorrect as a rate, ignoring null entries', () => {
        const rows = [
            row({ id: 'a', providerName: 'p', outcome: 'ok' }),
            row({ id: 'b', providerName: 'p', outcome: 'ok' }),
            row({ id: 'c', providerName: 'p', outcome: 'ok' }),
        ];
        const judgeRows = [
            { subjectId: 'a', ts: Date.now(), judgeProviderName: 'j', latencyMs: 1, accuracyScore: 7, completenessScore: 7, personIdCorrect: true as const },
            { subjectId: 'b', ts: Date.now(), judgeProviderName: 'j', latencyMs: 1, accuracyScore: 7, completenessScore: 7, personIdCorrect: false as const },
            { subjectId: 'c', ts: Date.now(), judgeProviderName: 'j', latencyMs: 1, accuracyScore: 7, completenessScore: 7, personIdCorrect: null },
        ];
        const result = aggregateTelemetry(rows, Date.now(), judgeRows);
        expect(result.providers[0].personIdCorrectRate).toBeCloseTo(0.5, 5);
    });
});
