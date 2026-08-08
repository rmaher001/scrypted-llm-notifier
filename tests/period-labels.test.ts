/**
 * The 12am-6am period displays as "early morning", not "night".
 *
 * UX report (2026-08-06): a Daily Brief section headed "Thursday
 * Night" contained 5:23-5:52 AM events. Colloquially "Thursday night" means
 * Thursday EVENING — the label was off by a day in the reader's head.
 *
 * The period KEY keeps the internal name ('...-night'): keys are persisted
 * identifiers for frozen segments, and renaming them would orphan every
 * frozen period on upgrade. Only the human-facing label changes.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getNaturalPeriods, toDisplayTimeRange, createSummaryPrompt } from '../src/daily-brief/prompts';

const TZ = 'America/Los_Angeles';
// Thursday 2026-08-06 05:00 PDT
const THU_5AM = new Date('2026-08-06T05:00:00-07:00').getTime();

function periodContaining(ts: number) {
    const periods = getNaturalPeriods(ts, ts + 1, TZ);
    expect(periods).toHaveLength(1);
    return periods[0];
}

describe('period labels', () => {
    it('labels 12am-6am "early morning", never "night"', () => {
        const p = periodContaining(THU_5AM);
        expect(p.label).toBe('Thursday early morning');
    });

    it('keeps the persisted key stable as "night"', () => {
        const p = periodContaining(THU_5AM);
        expect(p.key).toBe('2026-08-06-night');
    });

    it('leaves the other three periods unchanged', () => {
        expect(periodContaining(new Date('2026-08-06T09:00:00-07:00').getTime()).label)
            .toBe('Thursday morning');
        expect(periodContaining(new Date('2026-08-06T14:00:00-07:00').getTime()).label)
            .toBe('Thursday afternoon');
        expect(periodContaining(new Date('2026-08-06T20:00:00-07:00').getTime()).label)
            .toBe('Thursday evening');
    });
});

describe('frozen segments persisted under the OLD label heal at render time', () => {
    // Frozen 12am-6am segments written before the rename carry the literal
    // string "Thursday night" in their persisted timeRange, and the renderer
    // reuses it verbatim. Without display-time healing, the upgrade LOOKS like
    // it failed until the period ages out at midnight — or someone forces a
    // full regeneration, which costs real LLM calls just to fix a word.
    it('rewrites "night" to "early morning" in a stale timeRange', () => {
        expect(toDisplayTimeRange('Thursday night')).toBe('Thursday early morning');
    });

    it('handles the midnight-crossing form', () => {
        expect(toDisplayTimeRange('Sunday night to Monday morning'))
            .toBe('Sunday early morning to Monday morning');
    });

    it('is case-insensitive — headers render capitalized', () => {
        expect(toDisplayTimeRange('Thursday Night')).toBe('Thursday early morning');
    });

    it('never touches words merely containing "night"', () => {
        expect(toDisplayTimeRange('a nightly visitor at midnight'))
            .toBe('a nightly visitor at midnight');
    });

    it('passes already-correct labels through untouched', () => {
        expect(toDisplayTimeRange('Thursday early morning')).toBe('Thursday early morning');
        expect(toDisplayTimeRange('Thursday evening')).toBe('Thursday evening');
    });

    it('is applied on EVERY path a frozen narrative reaches the render cache', () => {
        // Three sites hand frozen narratives to setCachedSummary: the
        // all-frozen early return, the no-new-notifications early return, and
        // the incremental clone. The first fix healed only the clone; the
        // no-new-notifications path is exactly the reported scenario —
        // overnight events, Brief opened mid-morning before anything new —
        // and it served the stale "night" label straight from disk.
        const src = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf-8');
        // No site may hand the persisted narrative through unhealed, by any
        // shape: neither a verbatim field copy...
        expect(src).not.toMatch(/timeRange:\s*fs\.narrative\.timeRange\s*,/);
        // ...nor passing the raw persisted object by reference.
        expect(src).not.toMatch(/\.map\(\s*fs\s*=>\s*fs\.narrative\s*\)/);
        // Every read that builds render output goes through the healer —
        // count USE sites (point-free map reference or direct call), not the
        // definition.
        const uses = src.match(/\.map\(renderFrozenNarrative\)|renderFrozenNarrative\(fs\)/g) ?? [];
        expect(uses.length).toBeGreaterThanOrEqual(3);
    });

    it('heals the frozen context the LLM sees, not just the display', () => {
        // buildFrozenContext feeds "previously narrated" history back to the
        // model; a stale "Thursday night" there invites the model to echo the
        // retired vocabulary into fresh prose under a corrected header.
        const frozen = [{
            periodKey: '2026-08-06-night',
            periodStart: 0,
            periodEnd: 1,
            narrative: { timeRange: 'Thursday night', text: 'Quiet.', highlightIds: [] },
            highlights: [],
        }] as any;
        const { buildFrozenContext } = require('../src/daily-brief/prompts');
        const ctx = buildFrozenContext(frozen);
        expect(ctx).toContain('Thursday early morning');
        expect(ctx).not.toMatch(/Thursday night/);
    });
});

describe('the LLM prompt teaches the display vocabulary', () => {
    const prompt = JSON.stringify(createSummaryPrompt([], 'Thursday, August 6', 'America/Los_Angeles'));

    it('describes 12am-6am as "early morning"', () => {
        expect(prompt).toMatch(/early morning \(12am-6am\)/);
    });

    it('never teaches the old "night" period name', () => {
        // The narrative prose is the LLM's own words; teaching it "night
        // (12am-6am)" invites "during the night" sentences under a header
        // that now says early morning.
        expect(prompt).not.toMatch(/night \(12am-6am\)/);
        expect(prompt).not.toMatch(/Sunday night/);
    });
});
