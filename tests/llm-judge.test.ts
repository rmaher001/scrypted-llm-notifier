/**
 * Tests for LlmJudge — sampled async quality evaluator.
 * Pure logic module. No Scrypted deps.
 */

import {
    shouldSampleForJudging,
    buildJudgePrompt,
    parseJudgeResponse,
    runJudge,
    JudgeInput,
} from '../src/llm-judge';

describe('shouldSampleForJudging', () => {
    it('returns false when rate is 0', () => {
        const rng = () => 0; // would always sample if rate > 0
        expect(shouldSampleForJudging(0, rng)).toBe(false);
    });

    it('returns true when rate is 1', () => {
        const rng = () => 0.9999;
        expect(shouldSampleForJudging(1, rng)).toBe(true);
    });

    it('samples proportionally based on rng', () => {
        // rate 0.25: rng 0.1 → sampled, rng 0.5 → not sampled
        expect(shouldSampleForJudging(0.25, () => 0.1)).toBe(true);
        expect(shouldSampleForJudging(0.25, () => 0.5)).toBe(false);
    });

    it('clamps negative rates to 0', () => {
        expect(shouldSampleForJudging(-0.5, () => 0)).toBe(false);
    });

    it('clamps rates above 1 to 1', () => {
        expect(shouldSampleForJudging(2, () => 0.99)).toBe(true);
    });

    it('returns false for NaN rate', () => {
        expect(shouldSampleForJudging(NaN, () => 0)).toBe(false);
    });
});

describe('buildJudgePrompt', () => {
    const baseInput: JudgeInput = {
        imageDataUrl: 'data:image/jpeg;base64,abc',
        subjectTitle: 'Person at Front Door',
        subjectSubtitle: 'Front Door',
        subjectBody: 'Adult approaching the porch.',
        subjectDetailedDescription: 'A man in a blue jacket walks up the front steps carrying a package.',
        claimedPersonNames: [],
        referenceImages: new Map(),
    };

    it('produces a chat-completion-shaped object with system + user roles', () => {
        const prompt = buildJudgePrompt(baseInput);
        expect(Array.isArray(prompt.messages)).toBe(true);
        const roles = prompt.messages.map((m: any) => m.role);
        expect(roles).toContain('system');
        expect(roles).toContain('user');
    });

    it('includes the image as an image_url content part', () => {
        const prompt = buildJudgePrompt(baseInput);
        const userMsg = prompt.messages.find((m: any) => m.role === 'user')!;
        const parts = userMsg.content as any[];
        const imagePart = parts.find(p => p.type === 'image_url');
        expect(imagePart).toBeDefined();
        expect(imagePart.image_url.url).toContain('data:image/jpeg');
    });

    it('includes the subject output in the prompt text', () => {
        const prompt = buildJudgePrompt(baseInput);
        const serialized = JSON.stringify(prompt);
        expect(serialized).toContain('Person at Front Door');
        expect(serialized).toContain('blue jacket');
    });

    it('notes person identification claims when present', () => {
        const prompt = buildJudgePrompt({
            ...baseInput,
            claimedPersonNames: ['Alex'],
            referenceImages: new Map([['Alex', 'data:image/jpeg;base64,ref1']]),
        });
        const serialized = JSON.stringify(prompt);
        expect(serialized).toContain('Alex');
    });

    it('requests JSON output', () => {
        const prompt = buildJudgePrompt(baseInput);
        const serialized = JSON.stringify(prompt).toLowerCase();
        expect(serialized).toContain('json');
    });
});

describe('parseJudgeResponse', () => {
    it('parses well-formed JSON', () => {
        const content = JSON.stringify({
            accuracyScore: 8,
            completenessScore: 7,
            personIdCorrect: true,
            notes: 'matches well',
        });
        const result = parseJudgeResponse(content);
        expect(result.accuracyScore).toBe(8);
        expect(result.completenessScore).toBe(7);
        expect(result.personIdCorrect).toBe(true);
        expect(result.notes).toBe('matches well');
    });

    it('strips markdown code fences', () => {
        const content = '```json\n{"accuracyScore":9,"completenessScore":9,"personIdCorrect":null}\n```';
        const result = parseJudgeResponse(content);
        expect(result.accuracyScore).toBe(9);
        expect(result.personIdCorrect).toBeNull();
    });

    it('clamps scores outside 1-10 to the nearest bound', () => {
        const content = JSON.stringify({
            accuracyScore: 15,
            completenessScore: -3,
            personIdCorrect: null,
        });
        const result = parseJudgeResponse(content);
        expect(result.accuracyScore).toBe(10);
        expect(result.completenessScore).toBe(1);
    });

    it('treats missing personIdCorrect as null', () => {
        const content = JSON.stringify({ accuracyScore: 5, completenessScore: 5 });
        const result = parseJudgeResponse(content);
        expect(result.personIdCorrect).toBeNull();
    });

    it('truncates long notes to 200 chars', () => {
        const content = JSON.stringify({
            accuracyScore: 5,
            completenessScore: 5,
            personIdCorrect: null,
            notes: 'x'.repeat(500),
        });
        const result = parseJudgeResponse(content);
        expect(result.notes!.length).toBeLessThanOrEqual(200);
    });

    it('throws on invalid JSON', () => {
        expect(() => parseJudgeResponse('not json')).toThrow();
    });

    it('throws when score fields are non-numeric', () => {
        expect(() => parseJudgeResponse(JSON.stringify({ accuracyScore: 'high' }))).toThrow();
    });
});

describe('runJudge', () => {
    const input: JudgeInput = {
        imageDataUrl: 'data:image/jpeg;base64,abc',
        subjectTitle: 't',
        subjectSubtitle: 's',
        subjectBody: 'b',
        subjectDetailedDescription: 'd',
        claimedPersonNames: [],
        referenceImages: new Map(),
    };

    it('calls the provider with the built prompt and returns a JudgeRow', async () => {
        let seenPrompt: any;
        const provider = {
            name: 'judge-provider',
            getChatCompletion: async (p: any) => {
                seenPrompt = p;
                return {
                    choices: [{ message: { content: JSON.stringify({
                        accuracyScore: 8,
                        completenessScore: 7,
                        personIdCorrect: null,
                        notes: 'ok',
                    }) } }],
                };
            },
        };

        const result = await runJudge({
            subjectId: 'sub-1',
            provider,
            input,
            timeoutMs: 10_000,
        });

        expect(seenPrompt.messages).toBeDefined();
        expect(result.subjectId).toBe('sub-1');
        expect(result.judgeProviderName).toBe('judge-provider');
        expect(result.accuracyScore).toBe(8);
        expect(result.completenessScore).toBe(7);
        expect(result.personIdCorrect).toBeNull();
        expect(typeof result.latencyMs).toBe('number');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        expect(typeof result.ts).toBe('number');
    });

    it('rejects on provider timeout', async () => {
        const provider = {
            name: 'slow',
            getChatCompletion: () => new Promise(() => { /* never resolves */ }),
        };

        await expect(runJudge({
            subjectId: 'sub-2',
            provider,
            input,
            timeoutMs: 50,
        })).rejects.toThrow();
    });

    it('propagates provider errors', async () => {
        const provider = {
            name: 'broken',
            getChatCompletion: async () => { throw new Error('nope'); },
        };

        await expect(runJudge({
            subjectId: 'sub-3',
            provider,
            input,
            timeoutMs: 5_000,
        })).rejects.toThrow('nope');
    });

    it('throws parse error when response content is empty', async () => {
        const provider = {
            name: 'empty',
            getChatCompletion: async () => ({ choices: [{ message: { content: '' } }] }),
        };

        await expect(runJudge({
            subjectId: 'sub-4',
            provider,
            input,
            timeoutMs: 5_000,
        })).rejects.toThrow();
    });
});
