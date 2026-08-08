/**
 * Pinning tests for the MLX-VLM prose-wrapping hardening.
 *
 * Context: MLX-VLM and several other local LLM servers silently drop
 * response_format, causing models to emit prose-wrapped or markdown-wrapped
 * JSON. Raw `JSON.parse(stripJsonFences(content))` fails in those cases.
 * The fix is to use `extractFirstJsonObject` (a string-aware balanced-brace
 * scanner) instead.
 *
 * These tests pin the fix in place for each JSON-producing LLM code path.
 * If a future refactor reverts one to stripJsonFences, the test fails.
 */

import * as fs from 'fs';
import * as path from 'path';

function readSource(relativePath: string): string {
    return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8');
}

describe('JSON parser hardening (MLX-VLM prose tolerance)', () => {
    describe('enrichment path — src/llm-notifier.ts', () => {
        const src = readSource('src/llm-notifier.ts');

        it('imports extractFirstJsonObject from utils', () => {
            expect(src).toMatch(/import\s+\{[^}]*\bextractFirstJsonObject\b[^}]*\}\s+from\s+['"]\.\/utils['"]/);
        });

        it('does not call JSON.parse(stripJsonFences(...)) on LLM response content', () => {
            // The enrichment-response parse at the old line 333 was the vulnerability.
            // Any JSON.parse(stripJsonFences(...)) pattern here is a regression.
            expect(src).not.toMatch(/JSON\.parse\(\s*stripJsonFences\s*\(/);
        });

        it('parses LLM responses via extractFirstJsonObject', () => {
            expect(src).toMatch(/JSON\.parse\(\s*extractFirstJsonObject\s*\(/);
        });
    });

    describe('daily brief path — src/main.ts', () => {
        const src = readSource('src/main.ts');

        it('imports extractFirstJsonObject from utils', () => {
            expect(src).toMatch(/import\s+\{[^}]*\bextractFirstJsonObject\b[^}]*\}\s+from\s+['"]\.\/utils['"]/);
        });

        it('does not call JSON.parse(stripJsonFences(...)) in the daily brief path', () => {
            expect(src).not.toMatch(/JSON\.parse\(\s*stripJsonFences\s*\(/);
        });

        it('parses LLM responses via extractFirstJsonObject', () => {
            expect(src).toMatch(/JSON\.parse\(\s*extractFirstJsonObject\s*\(/);
        });
    });

    describe('enrichment prompt — clarity object format', () => {
        const src = readSource('src/llm-notifier.ts');

        // MoE and small models frequently emit clarity as a natural-language
        // string ("7/10 - reason") instead of the required object. Prompt
        // must explicitly require the object form so parse warnings stop.
        it('enrichment prompt explicitly forbids string clarity', () => {
            expect(src).toMatch(/clarity[\s\S]{0,200}(?:NEVER|do NOT|not a string)/i);
        });

        it('enrichment prompt shows clarity object example', () => {
            // The example token "score" appearing next to "reason" in the
            // clarity section pins the correct structural hint.
            expect(src).toMatch(/\{[^{}]*"score"[^{}]*"reason"[^{}]*\}/);
        });
    });

    describe('judge path — src/llm-judge.ts', () => {
        const src = readSource('src/llm-judge.ts');

        it('imports extractFirstJsonObject from utils', () => {
            expect(src).toMatch(/import\s+\{[^}]*\bextractFirstJsonObject\b[^}]*\}\s+from\s+['"]\.\/utils['"]/);
        });

        it('does not call JSON.parse(stripJsonFences(...)) on LLM response content', () => {
            expect(src).not.toMatch(/JSON\.parse\(\s*stripJsonFences\s*\(/);
        });

        it('parses LLM responses via extractFirstJsonObject', () => {
            expect(src).toMatch(/JSON\.parse\(\s*extractFirstJsonObject\s*\(/);
        });
    });
});
