/**
 * Scrypted's structured face label reaches the LLM.
 *
 * THE BUG (reported 2026-07-27): a card showed the badge "Alex" while the
 * LLM body read "A man in a grey t-shirt and blue jeans". Two disconnected
 * paths fed by the same event:
 *
 *   badge  <- det.label on the face detection, via extractDetectionData
 *   prompt <- buildMetadata, which passed ONLY originalTitle/Subtitle/Body
 *
 * The label was never forwarded. The prompt's only route to a name was the
 * "Maybe: NAME" prefix appearing in Scrypted's own notification TEXT. A native
 * Scrypted Story's text is prose — "Person in living room" — with no such
 * prefix, so the LLM got nothing and wrote "A man" while the badge, reading the
 * structured field, correctly said Alex.
 *
 * Second facet: buildMetadata returned {} outright when includeOriginalMessage
 * was off, silently starving the LLM of names for anyone with that setting off.
 *
 * The fix renders the labels in the SAME "Maybe: NAME" form the prompt rules
 * already key on (CRITICAL RULE 1 and the Scenario A block), so the carefully
 * tuned person-ID prompt needs no change and its behaviour is unaltered.
 */

import { buildMetadata, createMessageTemplate } from '../src/llm-notifier';

describe('buildMetadata forwards structured face labels', () => {
    it('carries the name when the notification prose does not', () => {
        // The Story case: prose with no "Maybe:" anywhere.
        const md = buildMetadata('Person in living room', undefined,
            'A man in a grey t-shirt.', true, ['Alex']);
        expect(JSON.stringify(md)).toMatch(/Maybe: Alex/);
    });

    it('carries names even when Include Original Message is OFF', () => {
        // Previously returned {} and dropped every name on the floor.
        const md = buildMetadata('t', 's', 'b', false, ['Alex']);
        expect(JSON.stringify(md)).toMatch(/Maybe: Alex/);
    });

    it('still omits the original text when Include Original Message is OFF', () => {
        const md = buildMetadata('SECRET TITLE', 's', 'b', false, ['Alex']);
        expect(JSON.stringify(md)).not.toMatch(/SECRET TITLE/);
    });

    it('carries every name when several faces are labelled', () => {
        const md = buildMetadata('t', 's', 'b', true, ['Alex', 'Casey']);
        const s = JSON.stringify(md);
        expect(s).toMatch(/Maybe: Alex/);
        expect(s).toMatch(/Maybe: Casey/);
    });

    it('is unchanged when there are no labels', () => {
        expect(buildMetadata('t', 's', 'b', false, [])).toEqual({});
        expect(buildMetadata('t', 's', 'b', false)).toEqual({});
    });

    it('keeps the original fields intact alongside the names', () => {
        const md: any = buildMetadata('T', 'S', 'B', true, ['Alex']);
        expect(md.originalTitle).toBe('T');
        expect(md.originalSubtitle).toBe('S');
        expect(md.originalBody).toBe('B');
    });
});

describe('the name actually reaches the prompt the LLM sees', () => {
    it('appears in the serialized message template', () => {
        // End to end through the real template builder — a metadata field the
        // template drops would make the fix cosmetic.
        const md = buildMetadata('Person in living room', undefined,
            'A man in a grey t-shirt.', true, ['Alex']);
        const template = createMessageTemplate('style', ['data:image/jpeg;base64,AAA'], md);
        expect(JSON.stringify(template)).toMatch(/Maybe: Alex/);
    });

    it('reaches the prompt with Include Original Message off', () => {
        const md = buildMetadata('t', 's', 'b', false, ['Alex']);
        const template = createMessageTemplate('style', ['data:image/jpeg;base64,AAA'], md);
        expect(JSON.stringify(template)).toMatch(/Maybe: Alex/);
    });
});

describe('the call site passes the labels', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(
        path.resolve(__dirname, '../src/llm-notifier.ts'), 'utf-8');

    it('buildMetadata is called with the detected names', () => {
        // A bare 4-argument call silently reverts to prose-scraping only.
        expect(src).toMatch(/buildMetadata\([\s\S]{0,200}?promptNames,?\s*\n?\s*\)/);
    });

    it('names are resolved before the metadata is built', () => {
        const namesAt = src.indexOf('promptNames');
        const metaAt = src.indexOf('const metadata = buildMetadata');
        expect(namesAt).toBeGreaterThan(-1);
        expect(namesAt).toBeLessThan(metaAt);
    });
});

describe('a forwarded name is not rubber-stamped when it cannot be verified', () => {
    // v0.3.133 built the Scenario A framework because "Scrypted mis-ids and the
    // LLM rubber stamps" it. That framework only ships when reference photos
    // are loaded, and v0.3.138 deliberately skips loading them when every face
    // is already labelled — the operator accepted losing LLM verification there
    // under burst-load pressure.
    //
    // So forwarding a label into a prompt WITHOUT references leaves only
    // CRITICAL RULE 1: "ONLY use names if metadata contains 'Maybe: [name]' -
    // use that EXACT name". No hedge, no instruction against inventing
    // corroborating detail. The name still gets used (that is the point of the
    // fix and it matches the badge), but the model must be told it is an
    // unverified upstream match.
    const md = buildMetadata('Person in living room', undefined, 'A man.', true, ['Alex']);

    it('tells the model the name is an unverified upstream match', () => {
        const prompt = JSON.stringify(createMessageTemplate('style', ['data:image/jpeg;base64,AAA'], md));
        expect(prompt).toMatch(/Maybe: Alex/);
        expect(prompt).toMatch(/UNVERIFIED/i);
    });

    it('does not add that caveat when reference photos ARE supplied', () => {
        // With references, the full Scenario A framework runs and owns the
        // verification instructions; a second overlapping rule would muddy it.
        const refs = new Map([['Alex', 'data:image/jpeg;base64,BBB']]);
        const prompt = JSON.stringify(
            createMessageTemplate('style', ['data:image/jpeg;base64,AAA'], md, refs));
        expect(prompt).toMatch(/SCENARIO A/);
        expect(prompt).not.toMatch(/UNVERIFIED upstream match/i);
    });

    it('adds nothing when there is no name to caveat', () => {
        const bare = buildMetadata('t', 's', 'b', true, []);
        const prompt = JSON.stringify(createMessageTemplate('style', ['data:image/jpeg;base64,AAA'], bare));
        expect(prompt).not.toMatch(/UNVERIFIED/i);
    });
});
