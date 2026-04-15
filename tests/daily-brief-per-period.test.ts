/**
 * Tests for per-period Daily Brief generation.
 * Both full and incremental generation should produce one LLM call per period,
 * not dump all candidates into a single call.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';

const mainTsPath = path.resolve(__dirname, '../src/main.ts');
const promptsTsPath = path.resolve(__dirname, '../src/daily-brief/prompts.ts');

describe('per-period generation structure', () => {
    let mainSrc: string;

    beforeAll(async () => {
        mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
    });

    it('has a generateForPeriod method', () => {
        expect(mainSrc).toContain('generateForPeriod');
    });

    it('generateDailyBriefInBackground calls generateForPeriod in a loop over periodsToGenerate', () => {
        // The background method should iterate periodsToGenerate and call generateForPeriod for each
        const loopMatch = mainSrc.match(
            /for\s*\(\s*const\s+period\s+of\s+periodsToGenerate\s*\)[\s\S]*?generateForPeriod/
        );
        expect(loopMatch).toBeTruthy();
    });

    it('delegates LLM calls to generateForPeriod instead of calling generateDailySummary directly', () => {
        // generateDailyBriefInBackground should call generateForPeriod, which calls generateDailySummary
        // Verify the delegation chain exists
        const bgMethod = mainSrc.match(
            /generateDailyBriefInBackground[\s\S]*?this\.generateForPeriod\(/
        );
        expect(bgMethod).toBeTruthy();

        // generateForPeriod should call generateDailySummary
        const forPeriodMethod = mainSrc.match(
            /generateForPeriod[\s\S]*?this\.generateDailySummary\(/
        );
        expect(forPeriodMethod).toBeTruthy();
    });
});

describe('per-period prompt context', () => {
    let promptsSrc: string;

    beforeAll(async () => {
        promptsSrc = await fsp.readFile(promptsTsPath, 'utf-8');
    });

    it('createSummaryPrompt accepts a periodLabel parameter', () => {
        // The function signature should include periodLabel
        const sig = promptsSrc.match(/createSummaryPrompt\([^)]*periodLabel/);
        expect(sig).toBeTruthy();
    });

    it('prompt includes time_period context when periodLabel is provided', () => {
        expect(promptsSrc).toContain('<time_period>');
    });

    it('instructs LLM to write a single segment when periodLabel is provided', () => {
        // When generating per-period, the prompt should tell the LLM to write exactly one segment
        // This is different from "one period" — it must say "Write a single narrative segment" or similar
        expect(promptsSrc).toMatch(/Write (?:a )?single narrative segment/i);
    });
});

describe('period label override', () => {
    let mainSrc: string;

    beforeAll(async () => {
        mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
    });

    it('generateForPeriod overrides timeRange with period.label', () => {
        // After LLM returns, timeRange should be set to period.label (object property syntax)
        const overrideMatch = mainSrc.match(
            /generateForPeriod[\s\S]*?timeRange:\s*period\.label/
        );
        expect(overrideMatch).toBeTruthy();
    });
});
