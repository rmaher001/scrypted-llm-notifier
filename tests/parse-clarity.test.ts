/**
 * Lenient parseClarity — recovers from MoE / small-model string outputs.
 *
 * Observed formats in plugin.log (v0.3.76, gemma-4-26b-a4b-it-4bit):
 *   "7/10 - The subject is clearly identifiable but shows slight motion blur."
 *   "8 (Clear view of the vehicle and license plate)"
 *   "9/10 Excellent focus on the subject and setting."
 *
 * The schema says clarity must be an object with score+reason. Small models
 * often ignore the nested type and emit a natural-language string instead.
 * parseClarity previously returned undefined for these, silently losing
 * clarity scores that feed downstream face-reference curation and gallery UX.
 */

import { parseClarity } from '../src/utils';

describe('parseClarity — lenient string handling', () => {
    it('parses "N/10 - reason" (dash separator)', () => {
        const result = parseClarity('7/10 - Subject clearly visible but slightly motion-blurred');
        expect(result).toBeDefined();
        expect(result!.score).toBe(7);
        expect(result!.reason).toBe('Subject clearly visible but slightly motion-blurred');
    });

    it('parses "N (reason)" (paren-wrapped reason)', () => {
        const result = parseClarity('8 (Clear view of the vehicle and license plate)');
        expect(result).toBeDefined();
        expect(result!.score).toBe(8);
        expect(result!.reason).toBe('Clear view of the vehicle and license plate');
    });

    it('parses "N/10 reason" (no separator, score prefix only)', () => {
        const result = parseClarity('9/10 Excellent focus on the subject and setting.');
        expect(result).toBeDefined();
        expect(result!.score).toBe(9);
        expect(result!.reason).toBe('Excellent focus on the subject and setting.');
    });

    it('parses bare "N" with no reason', () => {
        const result = parseClarity('7');
        expect(result).toBeDefined();
        expect(result!.score).toBe(7);
        expect(typeof result!.reason).toBe('string');
    });

    it('clamps string-form out-of-range scores to 1-10', () => {
        const high = parseClarity('15/10 very sharp');
        expect(high!.score).toBe(10);
        const low = parseClarity('0 (not visible)');
        expect(low!.score).toBe(1);
    });

    it('returns undefined for strings that do not start with a digit', () => {
        expect(parseClarity('high quality — clear view')).toBeUndefined();
        expect(parseClarity('')).toBeUndefined();
    });

    it('still accepts the proper object form (no regression)', () => {
        const result = parseClarity({ score: 6, reason: 'Fair' });
        expect(result).toEqual({ score: 6, reason: 'Fair' });
    });

    // Guards against \d{1,2} silently truncating "100" to "10" and leaving
    // "0 - reason" as the reason. Score must be parsed whole then clamped.
    it('handles 3-digit percentage-style scores without truncating reason', () => {
        const result = parseClarity('100 - very clear');
        expect(result!.score).toBe(10);
        expect(result!.reason).toBe('very clear');
    });
});
