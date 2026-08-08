/**
 * The judge provider must be a DELIBERATE choice — no silent fallback.
 *
 * WHAT WAS WRONG: selectJudgeProvider() ended with
 *
 *     try { return this.selectProvider(); } catch { return undefined; }
 *
 * so turning Judge Sample Rate above 0 without picking a Judge LLM Provider
 * quietly graded every sampled notification with the SAME model that wrote it.
 * Two problems, one silent:
 *
 *   (a) A model scoring its own output is a weak evaluation — it is the least
 *       likely grader to catch the mistake it just made. The LLM Health tab
 *       presents the result as an independent accuracy signal regardless.
 *   (b) It still spends a vision call per sampled event, so the user pays for
 *       a number that does not mean what the UI says it means.
 *
 * The decision (2026-08-06): skip judging entirely when no judge provider is
 * configured. Anyone who genuinely wants same-model grading can select that
 * provider explicitly — then it is a choice, not an accident.
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveJudgeProvider } from '../src/llm-judge';

describe('resolveJudgeProvider', () => {
    const DEVICE = { id: 'judge-1', name: 'Strong Judge' };
    const lookup = (id: string) => (id === 'judge-1' ? DEVICE : undefined);

    it('returns the configured provider', () => {
        expect(resolveJudgeProvider('judge-1', lookup)).toBe(DEVICE);
    });

    it('returns undefined when no provider is configured — no fallback', () => {
        // THE FIX. Previously this returned the main notification provider.
        expect(resolveJudgeProvider(undefined, lookup)).toBeUndefined();
    });

    it('never consults the device lookup when nothing is configured', () => {
        // Proves the skip is decided up front rather than by a failed lookup.
        const spy = jest.fn();
        expect(resolveJudgeProvider(undefined, spy)).toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
    });

    it('treats an empty id as unconfigured', () => {
        expect(resolveJudgeProvider('', lookup)).toBeUndefined();
    });

    it('returns undefined when the configured device no longer exists', () => {
        // A deleted judge device must skip judging, not silently demote to the
        // main provider — that is the same self-grading trap by another route.
        expect(resolveJudgeProvider('deleted-device', lookup)).toBeUndefined();
    });

    it('normalizes a null lookup result to undefined', () => {
        expect(resolveJudgeProvider('judge-1', () => null)).toBeUndefined();
    });
});

describe('main.ts wires the judge to the resolver, with no fallback path', () => {
    const src: string = fs.readFileSync(
        path.resolve(__dirname, '../src/main.ts'), 'utf-8');

    /** The body of selectJudgeProvider(), where the fallback used to live. */
    function selectJudgeProviderBody(): string {
        const m = /private selectJudgeProvider\([\s\S]*?\n {4}\}/.exec(src);
        expect(m).toBeTruthy();
        return m![0];
    }

    it('no longer falls back to the main provider', () => {
        expect(selectJudgeProviderBody()).not.toMatch(/this\.selectProvider\(\)/);
    });

    it('delegates to the shared resolver', () => {
        expect(selectJudgeProviderBody()).toMatch(/resolveJudgeProvider\(/);
        expect(src).toMatch(/resolveJudgeProvider/);
    });

    /**
     * The body of maybeRunJudge(), brace-matched from the `{` that closes its
     * signature. A regex cannot do this: `maybeRunJudge(args: { ... }): void {`
     * has a 4-space-indented `}` in the PARAMETER TYPE, so the obvious
     * `[\s\S]*?\n {4}\}` stops before the body ever starts and every assertion
     * below silently examines the signature instead. The anchor check at the
     * end makes a mis-extraction fail loudly rather than pass vacuously.
     */
    function maybeRunJudgeBody(): string {
        const decl = src.indexOf('maybeRunJudge(args:');
        expect(decl).toBeGreaterThan(-1);
        const start = src.indexOf('{', src.indexOf('): void {', decl));
        expect(start).toBeGreaterThan(-1);

        let depth = 0;
        let i = start;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) break;
        }
        const body = src.slice(start, i + 1);

        // If extraction drifted, these anchors disappear and the test fails
        // instead of quietly asserting against the wrong text.
        expect(body).toContain('shouldSampleForJudging');
        expect(body).toContain('selectJudgeProvider');
        return body;
    }

    it('warns when the judge is configured but inert, WITHOUT the verbose gate', () => {
        // An install with Sample Rate > 0 and no provider is the one case where
        // a user has an active setting that now does nothing. Gating the only
        // signal behind verboseLogging (default false) means silence.
        const noProviderBranch = /if \(!provider\) \{([\s\S]*?)\n {12}\}/.exec(maybeRunJudgeBody());
        expect(noProviderBranch).toBeTruthy();

        expect(noProviderBranch![1]).toMatch(/console\.warn/);
        expect(noProviderBranch![1]).not.toMatch(/args\.verbose/);
    });

    it('says it once rather than on every sampled event', () => {
        // Asserting the LATCH SEMANTICS, not that the identifier appears
        // somewhere. A substring check for `judgeInertWarned` stayed green
        // when the `= true` assignment was dropped — the guard would then read
        // a flag nothing ever sets and the warning would fire on every single
        // sampled event, which is the exact behaviour the latch prevents.
        const latch = /if \(!this\.judgeInertWarned\) \{([\s\S]*?)\n {16}\}/
            .exec(maybeRunJudgeBody());
        expect(latch).toBeTruthy();

        expect(latch![1]).toMatch(/this\.judgeInertWarned = true;/);
        expect(latch![1]).toMatch(/console\.warn/);
    });

    it('documents the skip in the Judge LLM Provider setting', () => {
        // The setting description is the only place a user learns this before
        // turning the sample rate up and wondering why nothing is scored.
        // Quote class covers ' " and ` so a template-literal conversion of the
        // long description string cannot produce a false RED.
        const desc = /title:\s*['"`]Judge LLM Provider['"`],[\s\S]{0,400}?description:\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(src);
        expect(desc).toBeTruthy();
        expect(desc![2]).toMatch(/no judging|not.*judged|skipped|nothing is (graded|scored)/i);
    });

    it('the per-event warning is honest about the deleted-device case', () => {
        // The per-event skip fires for TWO states: no provider selected, and a
        // selected provider whose device no longer exists. A message asserting
        // "no Judge LLM Provider is selected" is false in the second state and
        // sends the user to re-select a setting that is already set. The
        // message must describe both ("selected" AND "missing"/"deleted"/"no
        // longer exists"), unlike the startup check, which verifies only the
        // unset case and may say so plainly.
        const perEvent = /if \(!this\.judgeInertWarned\) \{[\s\S]*?console\.warn\((['"`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(maybeRunJudgeBody());
        expect(perEvent).toBeTruthy();
        const msg = perEvent![2];
        // No "not set"-style alternative here: the bare unset phrasing would
        // satisfy it, letting the deleted-device clause be trimmed away while
        // the test stays green. Only the deleted-device wording counts.
        expect(msg).toMatch(/no longer exists|deleted|missing/i);
    });

    it('warns deterministically at plugin load when the judge is inert', () => {
        // The maybeRunJudge warning waits for a sampled event with an inline
        // image; at a 1% sample rate that can be a long silent wait. The
        // constructor check reads raw storage (storageSettings is not built
        // yet) and warns immediately.
        const check = /llmJudgeSampleRate[\s\S]{0,300}?llmJudgeProvider[\s\S]{0,300}?judgeRate > 0 && !judgeProviderId/.exec(src);
        expect(check).toBeTruthy();

        const branch = /if \(judgeRate > 0 && !judgeProviderId\) \{([\s\S]*?)\n {8}\}/.exec(src);
        expect(branch).toBeTruthy();
        expect(branch![1]).toMatch(/console\.warn/);
        // Latch is set so the per-event path does not repeat the message.
        expect(branch![1]).toMatch(/this\.judgeInertWarned = true;/);
    });
});
