/**
 * An empty LLM narrative degrades to an empty period — never a crash that
 * aborts the whole Daily Brief run.
 *
 * Issue #12: generateForPeriod did `consolidatedNarrative = periodNarrative[0]`
 * and then dereferenced it (`.highlightIds` when freezing a completed period,
 * `.text` in the caller's context accumulation). `periodNarrative` is empty on
 * two real paths: the JSON parse-failure fallback returns an object with no
 * `narrative` key, and the segment validator can filter every segment out.
 * Neither is theoretical — the MLX-VLM backend has no response_format, so
 * parse failures are a live condition. One bad LLM response cost the rest of
 * the brief: the outer handler caught the throw and abandoned every remaining
 * period in the loop.
 *
 * The consolidation is now a pure, total function: any input yields a valid
 * segment, so the loop always continues to the next period.
 */

import * as fs from 'fs';
import * as path from 'path';

import { consolidatePeriodNarrative } from '../src/daily-brief/prompts';
import { NarrativeSegment } from '../src/types';

const LABEL = 'Thursday morning';

function seg(text: string, ids: string[]): NarrativeSegment {
    return { timeRange: LABEL, text, highlightIds: ids as any[] };
}

describe('consolidatePeriodNarrative is total — a segment comes back for ANY input', () => {
    it('empty array (all segments filtered out) yields an empty period, not undefined', () => {
        // Variant 2 of the issue: main.ts:958's validator emptied the array.
        const out = consolidatePeriodNarrative([], LABEL);
        expect(out).toEqual({ timeRange: LABEL, text: '', highlightIds: [] });
        // The exact dereferences that used to throw:
        expect(out.highlightIds).toEqual([]);
        expect(out.text).toBe('');
    });

    it('parse-failure fallback (narrative key absent → mapped to []) is the same shape', () => {
        // Variant 1: main.ts:1029 returns { overview, highlightIds } with NO
        // narrative key; the caller maps (narrative || []) so this arrives as [].
        const parseFailureResult: { narrative?: NarrativeSegment[] } = {};
        const fromParseFailure = parseFailureResult.narrative || [];
        const out = consolidatePeriodNarrative(fromParseFailure, LABEL);
        expect(out.text).toBe('');
        expect(out.highlightIds).toEqual([]);
    });

    it('single segment passes through untouched', () => {
        const only = seg('Casey walked the dog.', ['a', 'b']);
        expect(consolidatePeriodNarrative([only], LABEL)).toBe(only);
    });

    it('multiple segments consolidate: joined text, deduplicated ids, period label', () => {
        const out = consolidatePeriodNarrative([
            seg('First.', ['a', 'b']),
            seg('Second.', ['b', 'c']),
        ], LABEL);
        expect(out.timeRange).toBe(LABEL);
        expect(out.text).toBe('First. Second.');
        expect(out.highlightIds).toEqual(['a', 'b', 'c']);
    });

    it('an empty result renders as an empty period downstream, matching the no-candidates shape', () => {
        // The no-candidates early return already produces exactly this empty
        // narrative for a completed period; an empty LLM response must be
        // indistinguishable from it so every downstream filter (.text checks)
        // treats both the same way.
        const out = consolidatePeriodNarrative([], LABEL);
        expect([out].filter(s => s.text)).toEqual([]);
    });
});

describe('generateForPeriod survives an empty narrative end-to-end (source wiring)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf-8');

    it('uses the total consolidation helper instead of raw [0] indexing', () => {
        expect(src).toMatch(/consolidatePeriodNarrative\(/);
        // Ban [0]-indexing of the period narrative ANYWHERE in the file, not
        // just the exact assignment from the issue: a ternary that only calls
        // the helper for length > 1 reintroduces the crash through an
        // expression a narrower regex cannot see (mutation-tested).
        expect(src).not.toMatch(/periodNarrative\[0\]/);
    });

    it('no longer declares the uninitialized variable the crash flowed from', () => {
        expect(src).not.toMatch(/let consolidatedNarrative: NarrativeSegment;/);
    });

    it('logs when a period comes back empty so a silent skip is still visible', () => {
        // The failure mode being fixed was an invisible abort; the fix must
        // not replace it with an invisible skip.
        expect(src).toMatch(/empty narrative[\s\S]{0,120}?period/i);
    });

    it('never FREEZES an empty narrative — an LLM failure must stay retryable', () => {
        // By the freeze site, the no-candidates early return has already
        // passed: candidates existed, so an empty narrative is an LLM failure,
        // not a quiet period. Frozen keys are excluded from every future run,
        // so freezing it would blank the period PERMANENTLY. The pre-fix crash
        // was at least self-healing (nothing froze; the next hourly run
        // retried) — degrading must not trade that for silent data loss.
        expect(src).toMatch(/if \(isCompleted && periodNarrative\.length > 0\)/);
        // The unconditional freeze must be gone from generateForPeriod's
        // freeze site (the no-candidates early return freezes by design and
        // does not use this variable).
        expect(src).not.toMatch(/if \(isCompleted\) \{\s*\n\s*frozen =/);
    });
});
