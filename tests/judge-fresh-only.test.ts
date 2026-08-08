/**
 * The judge only grades enrichments that came from a FRESH VLM call.
 *
 * THE BUG (present since the judge shipped in v0.3.74): the call site in
 * src/llm-notifier.ts fired on `if (enriched.telemetryId)` alone, with no
 * check that a VLM call had actually happened for THIS event. But `enriched`
 * arrives by three routes:
 *
 *   1. a fresh callLlm            → shouldStore = true
 *   2. a responseCache HIT        → `enriched = cached`, shouldStore stays false
 *   3. an inFlightRequests await  → same, shouldStore stays false
 *
 * Routes 2 and 3 hand back the ORIGINAL call's telemetryId, so the judge ran
 * again on an id it had already graded. Two consequences:
 *
 *   (a) llm-judge.jsonl gets multiple rows keyed to one telemetryId, which
 *       corrupts the join /brief/llm-health does against llm-telemetry.jsonl.
 *   (b) Worse: the judge is handed THIS event's image (`imageDataUrl:
 *       imageUrl || imageUrls[0]`) but the CACHED event's description. It
 *       grades text against a frame that text was never generated from, and
 *       returns an accuracy verdict that means nothing.
 *
 * Latent while llmJudgeSampleRate is 0 (the default) — real for anyone who
 * turns the judge on.
 */

import { shouldRunJudge } from '../src/llm-judge';

describe('shouldRunJudge', () => {
    const TELEMETRY_ID = 'tel-abc123';

    it('runs when a fresh VLM call produced the enrichment', () => {
        expect(shouldRunJudge(true, TELEMETRY_ID)).toBe(true);
    });

    it('does NOT run on a responseCache hit, even though the id is present', () => {
        // This is the bug: the cached enrichment carries the original
        // telemetryId, so the old `if (enriched.telemetryId)` fired here.
        expect(shouldRunJudge(false, TELEMETRY_ID)).toBe(false);
    });

    it('does NOT run when an in-flight request supplied the enrichment', () => {
        // Same object, same id, arrived by await instead of by cache read.
        expect(shouldRunJudge(false, TELEMETRY_ID)).toBe(false);
    });

    it('does NOT run when telemetry is off and no id was minted', () => {
        // A fresh call still yields nothing to key a judge row on.
        expect(shouldRunJudge(true, undefined)).toBe(false);
    });

    it('treats an empty telemetry id as absent', () => {
        expect(shouldRunJudge(true, '')).toBe(false);
    });

    it('needs both conditions — neither alone is enough', () => {
        expect(shouldRunJudge(false, undefined)).toBe(false);
    });
});

describe('the judge call site uses the predicate (src/llm-notifier.ts)', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(
        path.resolve(__dirname, '../src/llm-notifier.ts'),
        'utf-8',
    );

    it('no longer fires the judge on the telemetry id alone', () => {
        // The exact expression that let cache hits through.
        expect(src).not.toMatch(/if\s*\(\s*enriched\.telemetryId\s*\)\s*\{\s*\n\s*this\.llmProvider\.maybeRunJudge/);
    });

    it('gates maybeRunJudge on shouldRunJudge(shouldStore, ...)', () => {
        expect(src).toMatch(/if\s*\(\s*shouldRunJudge\(\s*shouldStore\s*,\s*enriched\.telemetryId\s*\)\s*\)/);
    });

    it('imports the predicate from the judge module', () => {
        expect(src).toMatch(/shouldRunJudge/);
        expect(src).toMatch(/from\s+['"]\.\/llm-judge['"]/);
    });
});
