/**
 * Tests for Daily Brief duplicate-notification fix (Issue #7).
 *
 * Root cause of duplicates: the dedup token `lastDailyBriefDate` was written
 * AFTER `generateAndNotifySummary()` finished (which includes a 3-9s LLM call
 * and the notifier send). If the plugin restarted multiple times inside that
 * window, each new instance saw `lastSentDate !== todayStr` and fired again.
 *
 * Fix: the scheduler reserves the day's slot synchronously — writes
 * `lastDailyBriefDate` BEFORE scheduling the fire — so rapid restarts see the
 * reservation and skip.
 *
 * These tests pin the ordering invariant in the source of `scheduleDailySummary`
 * and confirm the redundant post-send write in `generateAndNotifySummary` is
 * removed. The pattern mirrors `tests/daily-brief-per-period.test.ts`.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';

const mainTsPath = path.resolve(__dirname, '../src/main.ts');

/**
 * Extract a method body by finding a line that starts with a method-definition
 * prefix (private/public/protected, optionally with async) followed by the name,
 * then walking matching braces from the first `{`. Avoids matching call sites.
 */
function extractMethodBody(src: string, methodName: string): string {
    const defRegex = new RegExp(
        `^\\s+(?:private|public|protected)(?:\\s+async)?\\s+${methodName}\\s*\\(`,
        'm',
    );
    const m = src.match(defRegex);
    if (!m || m.index === undefined) throw new Error(`method ${methodName} definition not found`);
    const openBrace = src.indexOf('{', m.index);
    if (openBrace < 0) throw new Error(`no opening brace for ${methodName}`);
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(openBrace, i + 1);
        }
    }
    throw new Error(`unterminated method body for ${methodName}`);
}

describe('Daily Brief dedup ordering (Issue #7)', () => {
    let scheduleBody: string;
    let generateBody: string;

    beforeAll(async () => {
        const mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
        scheduleBody = extractMethodBody(mainSrc, 'scheduleDailySummary');
        generateBody = extractMethodBody(mainSrc, 'generateAndNotifySummary');
    });

    it('scheduleDailySummary reserves lastDailyBriefDate before the missed-notification setTimeout', () => {
        // Within the missed-notification branch (after `hoursUntil > 23`),
        // setItem('lastDailyBriefDate', ...) must appear before setTimeout(...).
        const missedIdx = scheduleBody.search(/hoursUntil\s*>\s*23/);
        expect(missedIdx).toBeGreaterThanOrEqual(0);

        const tail = scheduleBody.slice(missedIdx);
        const setItemRelIdx = tail.search(/storage\.setItem\(\s*['"]lastDailyBriefDate['"]/);
        const setTimeoutRelIdx = tail.search(/setTimeout\(/);

        expect(setItemRelIdx).toBeGreaterThanOrEqual(0);
        expect(setTimeoutRelIdx).toBeGreaterThanOrEqual(0);
        expect(setItemRelIdx).toBeLessThan(setTimeoutRelIdx);
    });

    it('scheduleDailySummary reserves lastDailyBriefDate before awaiting generateAndNotifySummary in the scheduled-fire callback', () => {
        // The scheduled-hour setTimeout callback (last setTimeout in the method)
        // must write lastDailyBriefDate BEFORE awaiting generation.
        const timeoutMatches = [...scheduleBody.matchAll(/setTimeout\(/g)];
        expect(timeoutMatches.length).toBeGreaterThanOrEqual(1);
        const lastTimeoutIdx = timeoutMatches[timeoutMatches.length - 1].index!;

        const tail = scheduleBody.slice(lastTimeoutIdx);
        const setItemRelIdx = tail.search(/storage\.setItem\(\s*['"]lastDailyBriefDate['"]/);
        const awaitGenRelIdx = tail.search(/await\s+this\.generateAndNotifySummary\(\)/);

        expect(setItemRelIdx).toBeGreaterThanOrEqual(0);
        expect(awaitGenRelIdx).toBeGreaterThanOrEqual(0);
        expect(setItemRelIdx).toBeLessThan(awaitGenRelIdx);
    });

    it('generateAndNotifySummary no longer writes lastDailyBriefDate (scheduler owns it)', () => {
        // The post-send write must be removed so the scheduler is the single
        // source of truth for the reservation token.
        expect(generateBody).not.toMatch(/storage\.setItem\(\s*['"]lastDailyBriefDate['"]/);
    });
});

// Module-level singleton scheduler (v0.3.80):
//
// Scrypted occasionally instantiates LLMNotifierProvider more than once per
// plugin load — the startup logs "Daily Brief available at ..." have been
// observed doubled back-to-back after a reload. When that happens, every
// instance has its own scheduleDailySummary timer for the same hour, so the
// scheduled time produces N notifications (6-8 seen in practice).
//
// The fix moves the timer handle from an instance field
// (this.summaryScheduleTimeout) to a module-level variable (dailyBriefTimer).
// Any instance that calls scheduleDailySummary clears the module-level timer
// and sets a new one, so there is only ever ONE timer in the process.
describe('Daily Brief scheduler is a module-level singleton (v0.3.80)', () => {
    let mainSrc: string;
    let scheduleBody: string;

    beforeAll(async () => {
        mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
        scheduleBody = extractMethodBody(mainSrc, 'scheduleDailySummary');
    });

    it('instance field summaryScheduleTimeout is removed from LLMNotifierProvider', () => {
        // Per-instance storage means N instances = N timers, which is exactly
        // the bug we are fixing. The module-level variable replaces it.
        expect(mainSrc).not.toMatch(/private\s+summaryScheduleTimeout\s*:/);
    });

    it('module-level dailyBriefTimer variable is declared outside the class', () => {
        // A top-level `let dailyBriefTimer: NodeJS.Timeout | undefined;` shared
        // across all instances via JS module semantics.
        expect(mainSrc).toMatch(/^\s*let\s+dailyBriefTimer\s*:\s*NodeJS\.Timeout\s*\|\s*undefined\s*;/m);
    });

    it('scheduleDailySummary reads and writes the module-level timer, not an instance field', () => {
        // clearTimeout / setTimeout must both target the module-level var.
        expect(scheduleBody).toMatch(/clearTimeout\s*\(\s*dailyBriefTimer\s*\)/);
        expect(scheduleBody).toMatch(/dailyBriefTimer\s*=\s*setTimeout\s*\(/);
        // And there must be no residual reference to the old instance field.
        expect(scheduleBody).not.toMatch(/this\.summaryScheduleTimeout/);
    });
});
