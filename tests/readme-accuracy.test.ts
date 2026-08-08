/**
 * Asserts that user-facing prose describes the software as it actually behaves.
 *
 * WHY THIS EXISTS: prose has no compiler. Three claims shipped that a reader
 * could act on and get nowhere — a troubleshooting step pointing at a "footer"
 * that has never existed in the UI, a settings default documented as "none"
 * when the code silently falls back to the main provider, and an in-product
 * settings string telling users to disable the mixin "on the camera" when the
 * mixin only ever attaches to notifier devices.
 *
 * Each test below pins a doc claim to the code that makes it true, from BOTH
 * sides: change the prose and it fails, change the behaviour and it fails too.
 * A one-sided assertion would let the pair drift apart again.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

const README = read('README.md');
const MAIN_TS = read('src/main.ts');
const CARD_JS = read('ha-card/daily-brief-card.js');
const HTML_GENERATOR = read('src/daily-brief/html-generator.ts');

/** The bullet for a named setting in the README's Settings list. */
function settingBullet(name: string): string {
    const line = README.split('\n').find(l => l.startsWith(`- **${name}**`));
    expect(line).toBeTruthy();
    return line!;
}

/** The `description:` string of a named storage setting in main.ts. */
function settingDescription(title: string): string {
    // Quote class covers ' " and ` — converting a long description to a
    // template literal is an innocent edit and must not produce a false RED.
    const re = new RegExp(`title:\\s*['"\`]${title}['"\`],[\\s\\S]{0,400}?description:\\s*(['"\`])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`);
    const m = re.exec(MAIN_TS);
    expect(m).toBeTruthy();
    return m![2];
}

describe('README troubleshooting steps point at things that exist', () => {
    it('does not send users to a footer — the UI has never had one', () => {
        // The guard is two-sided on purpose. If a real footer is ever added,
        // the second half stops asserting and the README is free to say so.
        const uiSources = CARD_JS + HTML_GENERATOR + read('ha-card/gallery.js');
        const uiHasFooter = /<footer|class="footer|id="footer/i.test(uiSources);

        if (!uiHasFooter)
            expect(README).not.toMatch(/footer/i);
    });

    it('the stale-card step names a version signal the card actually emits', () => {
        // README tells the reader where to look...
        expect(README).toMatch(/browser console/i);
        // ...and the card must actually put it there.
        expect(CARD_JS).toMatch(/console\.log\([^)]*CARD_VERSION[^)]*\)/);
    });
});

describe('documented settings match their implemented behaviour', () => {
    it('Judge LLM Provider documents that judging is skipped when unset', () => {
        // The code skips rather than quietly grading with the main provider...
        expect(MAIN_TS).toMatch(/selectJudgeProvider\(\)[\s\S]{0,400}?resolveJudgeProvider\(/);
        expect(MAIN_TS).not.toMatch(
            /selectJudgeProvider\(\)[\s\S]{0,400}?this\.selectProvider\(\)/);

        // ...and the README must not promise a score the user will never get.
        expect(settingBullet('Judge LLM Provider')).toMatch(/skipped/i);
    });

    it('Enable Notifications does not tell users to act on a camera', () => {
        // The mixin attaches to notifiers only, so a camera has nothing to turn off.
        expect(MAIN_TS).toMatch(/type === ScryptedDeviceType\.Notifier/);

        expect(settingDescription('Enable Notifications')).not.toMatch(/\bcamera\b/i);
    });

    it('Enable Notifications points at the device the mixin actually attaches to', () => {
        expect(settingDescription('Enable Notifications')).toMatch(/notifier/i);
    });
});
