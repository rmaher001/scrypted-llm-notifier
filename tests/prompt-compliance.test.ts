/**
 * Pinning tests for v0.3.78 prompt compliance hardening.
 *
 * Context: with gemma-4-26b-a4b-it-4bit on both main + notification LLM
 * (v0.3.76+), the enrichment prompt showed two systematic compliance
 * failures across 20 real gallery samples:
 *
 *   1. Title-to-body genericization: title "Erin in Kitchen" + body
 *      "Woman in a blue sweatshirt" (3/11 name-available samples).
 *
 *   2. Outright name refusal: Scrypted labels "Maybe: Casey" + ref photos
 *      loaded, but LLM still emits "Woman" in both title AND body
 *      (5/11 samples). Root cause: rule 1 tells the model to use the
 *      "Maybe: NAME" metadata, but PERSON_ID_PROMPT requires clearly
 *      seeing the face, and the MoE defaults to the stricter rule.
 *
 *   3. Pet genericization: "Rex on the patio" + "A small white fluffy
 *      dog walking..." (same shape as #1 but for named pets).
 *
 * These tests pin the rule changes so a future prompt edit can't silently
 * regress the fixes. Behavioral verification is done by pulling fresh
 * gallery samples after deploy.
 */

import * as fs from 'fs';
import * as path from 'path';

const llmNotifierSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/llm-notifier.ts'),
    'utf-8',
);

describe('Prompt compliance hardening (v0.3.78)', () => {
    describe('rule 10 — named entity consistency across all fields', () => {
        it('includes a WRONG/RIGHT example for person name genericization', () => {
            // The title→body drop ("Erin in Kitchen" / "Woman in a blue sweatshirt")
            // is the most common compliance failure. An explicit WRONG/RIGHT pair
            // in the prompt is what made the grouping prompt stick.
            expect(llmNotifierSrc).toMatch(/WRONG[\s\S]*?title[\s\S]*?body[\s\S]{0,300}RIGHT/i);
        });

        it('includes a WRONG/RIGHT example covering a named pet', () => {
            // Pets show the same pattern — title "<pet name> on the patio" +
            // body "small white fluffy dog". The example is symbolic: pets have
            // no injection path, and a literal pet name would be a baked name,
            // which the prompt must never carry (see prompt-name-injection).
            expect(llmNotifierSrc).toMatch(/<pet name> on the patio/);
        });

        it('explicitly lists generic substitutes the model must avoid', () => {
            // Naming the exact tokens the model falls into helps with small-model
            // compliance. Based on the real gallery samples.
            const ruleRegion = llmNotifierSrc.slice(
                llmNotifierSrc.indexOf('10.'),
                llmNotifierSrc.indexOf('11.'),
            );
            expect(ruleRegion).toMatch(/\bPerson\b/);
            expect(ruleRegion).toMatch(/\bWoman\b/);
            expect(ruleRegion).toMatch(/\bMan\b/);
        });

        it('extends the consistency rule beyond title→body', () => {
            // Rule 10 currently only covers title+body. The observed failures
            // also hit detailedDescription. Rule must mention all downstream
            // fields.
            const ruleRegion = llmNotifierSrc.slice(
                llmNotifierSrc.indexOf('10.'),
                llmNotifierSrc.indexOf('11.'),
            );
            expect(ruleRegion).toMatch(/detailedDescription|subtitle/i);
        });
    });

    describe('PERSON_ID_PROMPT — reframed around Scrypted upstream', () => {
        it('v0.3.133: treats Scrypted "Maybe: NAME" as a hypothesis to verify, not a confident ID to rubber-stamp', () => {
            // Pre-v0.3.133 the prompt said "treat Maybe: NAME as a confident
            // upstream ID, not a hedge" + "not required to re-verify every ID".
            // That framing made the LLM rubber-stamp Scrypted's mis-IDs (face
            // library was wiped 2026-05-08 due to contamination; retrained
            // library still produces some wrong matches). The operator reported
            // significant false positives where Scrypted mis-IDed and the LLM
            // confirmed because nothing visibly contradicted. v0.3.133 flips
            // Scenario A to require an affirmative feature match.
            const personIdStart = llmNotifierSrc.indexOf('PERSON IDENTIFICATION');
            const personIdEnd = llmNotifierSrc.indexOf('const schema');
            const personIdRegion = llmNotifierSrc.slice(personIdStart, personIdEnd);
            // The "not required to re-verify" framing must be GONE.
            expect(personIdRegion).not.toMatch(/not\s+to\s+re-verify|not\s+required\s+to\s+re-verify/i);
            // And the prompt must explicitly reframe Maybe: NAME as a
            // hypothesis the LLM verifies (not a fact it trusts).
            expect(personIdRegion).toMatch(/hypothesis|to verify|verify against|verify the (face|match|hypothesis)/i);
        });

        it('v0.3.133: Scenario A requires a specific identifying feature, generic cues NOT sufficient', () => {
            // The fix: USE NAME only when a distinctive feature (face glimpse,
            // distinctive hair, glasses, characteristic build) is visibly
            // matched against the reference. Generic cues (same build,
            // common clothing) must be explicitly insufficient — the same
            // bar Scenario B already enforces.
            const personIdStart = llmNotifierSrc.indexOf('PERSON IDENTIFICATION');
            const personIdEnd = llmNotifierSrc.indexOf('SCENARIO B');
            const scenarioARegion = llmNotifierSrc.slice(personIdStart, personIdEnd);
            // Must demand a specific / distinctive / identifying feature.
            expect(scenarioARegion).toMatch(/specific feature|distinctive feature|identifying feature|distinguishing feature|distinctive (cue|match)/i);
            // Must explicitly disqualify generic cues.
            expect(scenarioARegion).toMatch(/generic|common clothing|same build|build alone|approximate height/i);
            expect(scenarioARegion).toMatch(/not sufficient|insufficient|NOT enough/i);
        });

        it('v0.3.133: "nothing contradicts" defaults to confidence <=6, not 7-8', () => {
            // PERSON_ID_CONFIDENCE_THRESHOLD=7 filters weak matches — but
            // only if the model returns a low number. Pre-v0.3.133 the
            // confidence scale told the model 7-8 was the "default in
            // Scenario A when nothing contradicts", defeating the threshold.
            // v0.3.133: default for "no distinctive feature visible" is 4-6.
            const personIdStart = llmNotifierSrc.indexOf('PERSON IDENTIFICATION');
            const personIdEnd = llmNotifierSrc.indexOf('const schema');
            const personIdRegion = llmNotifierSrc.slice(personIdStart, personIdEnd);
            // The 7-8 band must no longer be tagged as the default for
            // "nothing contradicts" / generic-cue-only situations.
            expect(personIdRegion).not.toMatch(/7-?8[\s\S]{0,120}(default|nothing contradicts)/i);
            // The 4-6 band must now own the "no distinctive feature" /
            // generic-cue case (the rubber-stamp territory).
            expect(personIdRegion).toMatch(/4-?6[\s\S]{0,250}(no\s+distinctive|generic|nothing\s+contradicts|cannot\s+point|absence)/i);
        });

        it('v0.3.133: Scenario B reframes "weak-evidence prior" to actively encourage attempt when feature visible', () => {
            // Scenario B pre-v0.3.133 had a discouraging "absence of Scrypted
            // match is weak evidence this person may NOT be in the known set"
            // prior that suppressed nearly all LLM-only IDs in production
            // (0 LLM-only IDs over hundreds of person events). The bar
            // (distinctive feature required) is correct and stays; the
            // discouragement framing goes. User direction: "would be nice if
            // LLM ids when scrypted does not".
            const scenarioBStart = llmNotifierSrc.indexOf('SCENARIO B');
            const scenarioBEnd = llmNotifierSrc.indexOf('IN BOTH SCENARIOS');
            const scenarioBRegion = scenarioBEnd > scenarioBStart
                ? llmNotifierSrc.slice(scenarioBStart, scenarioBEnd)
                : llmNotifierSrc.slice(scenarioBStart, llmNotifierSrc.indexOf('const schema'));
            // The "weak evidence" framing must be GONE — it's the prior that
            // told the model to default to "probably a stranger".
            expect(scenarioBRegion).not.toMatch(/weak\s+evidence|may\s+NOT\s+be\s+in\s+the\s+known/i);
            // Common-clothing bar still required (false-positive guard).
            expect(scenarioBRegion).toMatch(/common clothing|generic/i);
            expect(scenarioBRegion).toMatch(/not sufficient|insufficient/i);
            // Active encouragement to attempt when feature visible.
            expect(scenarioBRegion).toMatch(/attempt|identify|ID them|USE\s+(the\s+)?NAME/i);
        });

        it('no longer asserts a front-facing face is REQUIRED to use a name', () => {
            // The "NEVER sufficient" line was the main culprit — it flipped the
            // default from "trust Scrypted" to "reject unless face visible".
            // Loosened phrasing is OK, but the absolute should be gone.
            expect(llmNotifierSrc).not.toMatch(/NEVER sufficient for identification/);
        });

        it('references the "Maybe: NAME" metadata format', () => {
            // Scrypted always labels as "Maybe: NAME" even at high confidence,
            // so the prompt has to treat that label as a confident ID rather
            // than a hedge.
            expect(llmNotifierSrc).toMatch(/Maybe[^\w]*NAME|Maybe: [A-Z]/);
        });

        it('lists silhouette / back-of-head as a decline case', () => {
            // Reviewer catch: default 7-8 confidence when "nothing contradicts"
            // plus a full-silhouette image = confident name of someone whose
            // identifying features are invisible. Must be an explicit decline
            // within the PERSON_ID_PROMPT decline-examples region (not elsewhere
            // in the file, e.g. rule 13's faceReferenceQuality scale).
            const personIdStart = llmNotifierSrc.indexOf('PERSON IDENTIFICATION');
            const personIdEnd = llmNotifierSrc.indexOf('const schema');
            const personIdRegion = llmNotifierSrc.slice(personIdStart, personIdEnd);
            expect(personIdRegion).toMatch(/silhouette|rear view|back-of-head|no identifying features/i);
        });

        it('v0.3.131: has a fresh-ID branch for the no-Maybe-in-metadata case', () => {
            // Pre-v0.3.131 the prompt was wholly oriented around verifying
            // Scrypted's "Maybe: NAME" hint. When metadata had no name (Scrypted
            // missed the face — side angle, low light, no face sub-detection),
            // the prompt didn't direct the LLM to attempt fresh ID against the
            // reference photos. Result observed in production: 0 LLM-only IDs
            // even though v0.3.130 sent refs on every person event. New prompt
            // must explicitly cover the no-Scrypted-name branch.
            const personIdStart = llmNotifierSrc.indexOf('PERSON IDENTIFICATION');
            const personIdEnd = llmNotifierSrc.indexOf('const schema');
            const personIdRegion = llmNotifierSrc.slice(personIdStart, personIdEnd);
            // Looks for explicit framing of the no-Scrypted-name path.
            expect(personIdRegion).toMatch(/no\s+(person\s+)?name|no\s+Maybe|metadata\s+has\s+no|without\s+a\s+Maybe|no\s+upstream\s+(face\s+)?(match|id|name)/i);
            // Looks for affirmative direction to attempt fresh ID using
            // non-face cues (build, hair, clothing) since face is the case
            // Scrypted couldn't resolve.
            expect(personIdRegion).toMatch(/build|hair|clothing|silhouette\s+features|partial\s+(face|view)/i);
        });
    });

    describe('rule 10 / rule 1 token conflict', () => {
        it('scopes rule 10 prohibition to cases where a name was already used', () => {
            // Rule 1 tells the model to use "Man"/"Woman"/"Visitor" when no
            // name is available. Rule 10's unscoped "NEVER substitute" list
            // includes the same tokens and can confuse a small model into
            // refusing them globally. The rule must scope its prohibition
            // to the name-established case.
            const ruleRegion = llmNotifierSrc.slice(
                llmNotifierSrc.indexOf('10.'),
                llmNotifierSrc.indexOf('11.'),
            );
            expect(ruleRegion).toMatch(/in place of a name|already used|once a name|already introduced|already named/i);
        });
    });
});
