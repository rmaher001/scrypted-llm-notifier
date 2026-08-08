// ============================================================================
// LlmJudge — sampled asynchronous quality evaluator.
//
// Given a notification LLM's output + the original image, ask a (presumably
// stronger) judge model to grade accuracy/completeness, and whether any person
// identification claim matched the reference photos.
//
// Pure logic module — emits a JudgeRow that the caller is responsible for
// persisting via LlmJudgeLog.
// ============================================================================

import { withTimeout, extractFirstJsonObject } from './utils';
import type { JudgeRow } from './llm-telemetry';

export interface JudgeInput {
    imageDataUrl: string;                           // full frame or cropped snapshot
    subjectTitle: string;
    subjectSubtitle: string;
    subjectBody: string;
    subjectDetailedDescription: string;
    claimedPersonNames: string[];
    referenceImages: Map<string, string>;           // name -> data URL, used to verify person ID
}

export interface JudgeEvaluation {
    accuracyScore: number;          // 1–10
    completenessScore: number;      // 1–10
    personIdCorrect: boolean | null;
    notes?: string;
}

export interface JudgeProvider {
    name?: string;
    getChatCompletion(messages: any): Promise<any>;
}

export interface RunJudgeArgs {
    subjectId: string;
    provider: JudgeProvider;
    input: JudgeInput;
    timeoutMs: number;
}

// ---- Eligibility -----------------------------------------------------------

/**
 * Is this enrichment eligible to be judged at all?
 *
 * Only enrichments produced by a FRESH VLM call for the current event qualify.
 * An enrichment reused from responseCache or awaited from inFlightRequests
 * carries the ORIGINAL call's telemetryId, so judging it again would write a
 * second judge row under an id that already has one — and would grade that
 * cached description against the current event's image, which it was never
 * generated from.
 *
 * `freshCall` is the caller's `shouldStore`, which is true on exactly the
 * fresh-call paths. Sampling is applied separately, downstream.
 *
 * Declared as a type guard so the call site keeps the narrowing the old
 * `if (enriched.telemetryId)` truthiness check gave it — maybeRunJudge takes a
 * required string.
 */
export function shouldRunJudge(freshCall: boolean, telemetryId?: string): telemetryId is string {
    return freshCall && !!telemetryId;
}

// ---- Provider selection ----------------------------------------------------

/**
 * Which provider grades the enrichment — or nobody, and judging is skipped.
 *
 * There is deliberately NO fallback to the notification provider. Falling back
 * meant the model that wrote the description also graded it: the least likely
 * grader to catch its own mistake, presented in the LLM Health tab as an
 * independent accuracy signal, and costing a vision call per sampled event to
 * produce it. Same-model grading is still available — the user just has to
 * select that provider explicitly, which makes it a choice rather than a
 * silent default.
 *
 * A configured-but-missing device (deleted, renamed away) also resolves to
 * undefined: that is the same self-grading trap by another route.
 */
export function resolveJudgeProvider<T>(
    judgeId: string | undefined | null,
    lookup: (id: string) => T | undefined | null,
): T | undefined {
    if (!judgeId) return undefined;
    return lookup(judgeId) ?? undefined;
}

// ---- Sampling --------------------------------------------------------------

export function shouldSampleForJudging(
    rate: number,
    rng: () => number = Math.random,
): boolean {
    // Number.isFinite is false for NaN/Infinity/-Infinity.
    if (!Number.isFinite(rate)) return false;
    const clamped = Math.max(0, Math.min(1, rate));
    if (clamped <= 0) return false;
    if (clamped >= 1) return true;
    return rng() < clamped;
}

// ---- Prompt ----------------------------------------------------------------

export function buildJudgePrompt(input: JudgeInput): any {
    const personIdSection = input.claimedPersonNames.length > 0
        ? `\n\nPERSON IDENTIFICATION CLAIM:\nThe model claims this image shows: ${input.claimedPersonNames.join(', ')}.\n` +
          `Reference photos for claimed names are provided below. ` +
          `Set personIdCorrect=true if the face(s) in the snapshot plausibly match the reference photo(s), ` +
          `false if they do NOT match, or null if the face is not visible clearly enough to judge.`
        : `\n\nPERSON IDENTIFICATION CLAIM: The model did not claim to identify any specific person. ` +
          `Set personIdCorrect=null.`;

    const systemPrompt = `You are an impartial judge evaluating the output of a security-camera notification model. ` +
        `You are given the original snapshot and the model's notification text. ` +
        `Grade the output using ONLY information visible in the image. Be strict and honest.`;

    const instructions = `Evaluate the following notification:

TITLE: ${input.subjectTitle}
SUBTITLE: ${input.subjectSubtitle}
BODY: ${input.subjectBody}
DETAILED DESCRIPTION: ${input.subjectDetailedDescription}
${personIdSection}

Return STRICT JSON with these fields (and nothing else):
{
  "accuracyScore": integer 1-10,   // How well does the description match what is actually visible? Hallucinated details = low score.
  "completenessScore": integer 1-10, // Are important visible details captured? Missing critical info = low score.
  "personIdCorrect": true | false | null,
  "notes": string (max 200 chars, any concerns)
}

Rubric:
  accuracyScore
    1-2: Major hallucination (e.g. claims a person when none visible)
    3-4: Several wrong or made-up details
    5-6: Mostly right but with notable errors
    7-8: Accurate with only minor quibbles
    9-10: Fully accurate
  completenessScore
    1-2: Missing the main subject or event
    3-4: Describes scene but misses obvious notable details (package, tool, second person)
    5-6: Adequate
    7-8: Good coverage of what's visible
    9-10: Thorough`;

    const userContent: any[] = [
        { type: 'text', text: instructions },
        { type: 'image_url', image_url: { url: input.imageDataUrl } },
    ];

    // Append reference images so the judge can verify person ID claims.
    for (const [name, dataUrl] of input.referenceImages) {
        userContent.push({ type: 'text', text: `Reference photo for "${name}":` });
        userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
    }

    return {
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 400,
    };
}

// ---- Parsing ---------------------------------------------------------------

function clampScore(n: unknown, field: string): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new Error(`Judge response missing/invalid numeric ${field}`);
    }
    return Math.max(1, Math.min(10, Math.round(n)));
}

export function parseJudgeResponse(content: string): JudgeEvaluation {
    if (!content || !content.trim()) throw new Error('Empty judge response');
    const json = JSON.parse(extractFirstJsonObject(content));

    const accuracyScore = clampScore(json.accuracyScore, 'accuracyScore');
    const completenessScore = clampScore(json.completenessScore, 'completenessScore');

    let personIdCorrect: boolean | null;
    if (json.personIdCorrect === true || json.personIdCorrect === false) {
        personIdCorrect = json.personIdCorrect;
    } else {
        personIdCorrect = null;
    }

    let notes: string | undefined;
    if (typeof json.notes === 'string') {
        notes = json.notes.length > 200 ? json.notes.slice(0, 200) : json.notes;
    }

    return { accuracyScore, completenessScore, personIdCorrect, notes };
}

// ---- Execution -------------------------------------------------------------

export async function runJudge(args: RunJudgeArgs): Promise<JudgeRow> {
    const { subjectId, provider, input, timeoutMs } = args;
    const prompt = buildJudgePrompt(input);
    const start = Date.now();

    const response = await withTimeout(
        provider.getChatCompletion(prompt),
        timeoutMs,
        'LLM judge',
    );

    const latencyMs = Date.now() - start;
    const content = response?.choices?.[0]?.message?.content ?? '';
    const evalResult = parseJudgeResponse(content);

    return {
        subjectId,
        ts: Date.now(),
        judgeProviderName: (provider as any).name || '(unnamed)',
        latencyMs,
        accuracyScore: evalResult.accuracyScore,
        completenessScore: evalResult.completenessScore,
        personIdCorrect: evalResult.personIdCorrect,
        notes: evalResult.notes,
    };
}
