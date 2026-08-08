/**
 * Issue #10: Daily Brief 'Brief' tab summary text cut off mid-sentence.
 *
 * Root cause: src/main.ts builds `mergedOverview` (and the early-exit overviews) by
 * joining narrative segment text and slicing to 200 chars. The Brief tab renders
 * that as the lede paragraph, so users see a sentence clipped mid-word
 * (e.g. "Rex, the little white").
 *
 * Fix: use the LLM's `overview` field (1-2 sentence summary, per prompt) instead
 * of a sliced join of segment narratives. Plumb it through FrozenSegment so it
 * survives across incremental regeneration.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';

const mainTsPath = path.resolve(__dirname, '../src/main.ts');
const typesTsPath = path.resolve(__dirname, '../src/types.ts');

describe('daily brief overview is not truncated (issue #10)', () => {
    let mainSrc: string;
    let typesSrc: string;

    beforeAll(async () => {
        mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
        typesSrc = await fsp.readFile(typesTsPath, 'utf-8');
    });

    it('main.ts does not slice joined narrative text to 200 chars for overview', () => {
        // The bug: `.map(s => s.text).join(' ').slice(0, 200)` produces a 200-char-clipped
        // narrative as the displayed overview. After the fix, no such pattern should exist.
        const sliceJoinPattern = /\.map\(\s*s\s*=>\s*s\.text\s*\)\s*\.join\([^)]*\)\s*\.slice\(\s*0\s*,\s*200\s*\)/;
        expect(mainSrc).not.toMatch(sliceJoinPattern);
    });

    it('FrozenSegment carries an overview field so per-period overviews persist across incremental runs', () => {
        // The LLM's per-period overview must survive the freeze/merge cycle. Without
        // a field on FrozenSegment, the overview is lost the moment a period is frozen.
        expect(typesSrc).toMatch(/interface\s+FrozenSegment\s*\{[\s\S]*?overview\s*\??:\s*string/);
    });

    it('generateForPeriod returns overview alongside narrative', () => {
        // Currently `return { narrative: [consolidatedNarrative], highlights, frozen }` drops
        // the LLM's overview. The fix surfaces it so generateDailyBriefInBackground can
        // assemble the day-level overview without re-deriving from segment text.
        const generateForPeriodBody = mainSrc.match(
            /generateForPeriod[\s\S]*?return\s*\{[\s\S]*?\};/
        );
        expect(generateForPeriodBody).toBeTruthy();
        expect(generateForPeriodBody![0]).toMatch(/overview/);
    });

    it('mergedOverview is assembled from per-period LLM overviews, not from slicing segment text', () => {
        // After fix, mergedOverview should join per-period overview strings (themselves
        // already constrained to 1-2 sentences by the prompt) rather than slicing narrative.
        // We assert by absence of the bug pattern in proximity to mergedOverview.
        const mergedRegion = mainSrc.match(/(const|let)\s+mergedOverview[\s\S]{0,400}/);
        expect(mergedRegion).toBeTruthy();
        expect(mergedRegion![0]).not.toMatch(/\.slice\(\s*0\s*,\s*200\s*\)/);
    });

    it('daily brief window is 24h (midnight today → now), not 48h', () => {
        // v0.3.110: window starts at midnight TODAY, not midnight yesterday.
        // The 48h variant produced a confusing lede that started with the previous day.
        expect(mainSrc).toMatch(/const\s+windowStart\s*=\s*midnightTodayUtc\s*;/);
        expect(mainSrc).not.toMatch(/windowStart\s*=\s*midnightTodayUtc\s*-\s*\(\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\s*\)/);
    });
});

describe('joinPeriodOverviews helper', () => {
    // Import indirectly via require to avoid pulling in the full Scrypted SDK at test time.
    // The helper is a pure function with no SDK dependencies.
    const { joinPeriodOverviews } = require('../src/main');

    it('returns the most recent period\'s overview, regardless of input order', () => {
        // Lede should be "what just happened" not a tour of every prior period.
        const result = joinPeriodOverviews([
            { periodKey: 'pm', periodStart: 200, periodEnd: 300, narrative: { timeRange: 'pm', text: '', highlightIds: [] }, overview: 'PM intro.', highlights: [], highlightNotificationIds: [] },
            { periodKey: 'am', periodStart: 100, periodEnd: 200, narrative: { timeRange: 'am', text: '', highlightIds: [] }, overview: 'AM intro.', highlights: [], highlightNotificationIds: [] },
        ]);
        expect(result).toBe('PM intro.');
    });

    it('falls back to the next-most-recent overview when the latest is missing (legacy frozen)', () => {
        const result = joinPeriodOverviews([
            { periodKey: 'am', periodStart: 100, periodEnd: 200, narrative: { timeRange: 'am', text: '', highlightIds: [] }, overview: 'AM intro.', highlights: [], highlightNotificationIds: [] },
            { periodKey: 'pm', periodStart: 200, periodEnd: 300, narrative: { timeRange: 'pm', text: 'narrative', highlightIds: [] }, highlights: [], highlightNotificationIds: [] },
        ]);
        expect(result).toBe('AM intro.');
    });

    it('skips empty-string overviews and returns the next non-empty one', () => {
        const result = joinPeriodOverviews([
            { periodKey: 'am', periodStart: 100, periodEnd: 200, narrative: { timeRange: 'am', text: '', highlightIds: [] }, overview: 'Morning was active.', highlights: [], highlightNotificationIds: [] },
            { periodKey: 'pm', periodStart: 200, periodEnd: 300, narrative: { timeRange: 'pm', text: '', highlightIds: [] }, overview: '', highlights: [], highlightNotificationIds: [] },
        ]);
        expect(result).toBe('Morning was active.');
    });

    it('does NOT clip the chosen overview at 200 chars', () => {
        const long = 'L'.repeat(400);
        const result = joinPeriodOverviews([
            { periodKey: 'am', periodStart: 100, periodEnd: 200, narrative: { timeRange: 'am', text: '', highlightIds: [] }, overview: 'AM', highlights: [], highlightNotificationIds: [] },
            { periodKey: 'pm', periodStart: 200, periodEnd: 300, narrative: { timeRange: 'pm', text: '', highlightIds: [] }, overview: long, highlights: [], highlightNotificationIds: [] },
        ]);
        expect(result).toBe(long);
        expect(result.length).toBe(400);
    });

    it('returns empty string for empty input', () => {
        expect(joinPeriodOverviews([])).toBe('');
    });

    it('returns empty string when all overviews are missing or empty', () => {
        const result = joinPeriodOverviews([
            { periodKey: 'am', periodStart: 100, periodEnd: 200, narrative: { timeRange: 'am', text: 'x', highlightIds: [] }, highlights: [], highlightNotificationIds: [] },
            { periodKey: 'pm', periodStart: 200, periodEnd: 300, narrative: { timeRange: 'pm', text: 'y', highlightIds: [] }, overview: '', highlights: [], highlightNotificationIds: [] },
        ]);
        expect(result).toBe('');
    });
});
