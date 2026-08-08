/**
 * Poster source order — structure tests on llm-notifier.ts.
 *
 * Chain (highest priority first):
 *   1. posterBoxCropBuf     — 16:9 crop centered on the VLM's posterBox. v0.3.164.
 *   2. subjectCropBuf       — 16:9 zoom centered on detection bbox (heuristic).
 *   3. fullFrameBuf         — full event frame (getDetectionInput OR NVR-seek via
 *                             getRecordingStreamThumbnail; see full-frame-source.ts).
 *   4. notificationImageBuf — Scrypted's own notification image (the tight
 *                             detection thumbnail), NEVER-BLANK last resort. v0.3.167.
 *
 * HISTORY: v0.3.118 removed the notification thumbnail as a poster source
 * ENTIRELY (operator rule "I do not want to see this anywhere", accepting a
 * blank placeholder over the 172×172 crop). v0.3.167 REVERSES that for the
 * strict last-resort case ONLY: on Protect-native detections both
 * getDetectionInput and the NVR-seek can come up empty, and operator judgment
 * is now that a blank card is worse than the thumbnail. It remains forbidden
 * AHEAD of any real frame — it appears only when posterBox, subjectCrop AND
 * fullFrame are all absent (the tail of the nullish-coalesce chain).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';

const llmNotifierPath = path.resolve(__dirname, '../src/llm-notifier.ts');

describe('poster source order (v0.3.118)', () => {
    let src: string;

    beforeAll(async () => {
        src = await fsp.readFile(llmNotifierPath, 'utf-8');
    });

    it('poster source is delegated to selectPosterRawSource, which splits by type (v0.3.172)', () => {
        // v0.3.164 prepended the VLM posterBox crop; v0.3.167 appended
        // notificationImageBuf as the NEVER-BLANK last resort; v0.3.172 moved
        // the whole decision into a pure selector so a STORY can keep
        // Scrypted's composite while per-detection events keep the crop order.
        // The per-type orders themselves are pinned in poster-source-summary.test.ts.
        expect(src).toMatch(/selectPosterRawSource\s*\(/);
        expect(src).toMatch(/isSummary:\s*isSummaryNotification\(options\)/);
        expect(src).toMatch(/const\s+rawSource\s*=\s*picked\.buf/);
    });

    it('raw source is piped through downscaleForStorage before the 1 MB cap check (v0.3.122 §4.6)', () => {
        expect(src).toMatch(/await\s+downscaleForStorage\(\s*rawSource\s*\)/);
        // v0.3.122 raised the cap from 500KB to 1MB. The check now uses a
        // named constant (POSTER_SIZE_CAP_BYTES = 1024 * 1024).
        expect(src).toMatch(/const\s+POSTER_SIZE_CAP_BYTES\s*=\s*1024\s*\*\s*1024/);
        expect(src).toMatch(/capped\.length\s*<=\s*POSTER_SIZE_CAP_BYTES/);
    });

    it('the notification image is never selected AHEAD of a real frame (old imageUrl-first ordering banned)', () => {
        // v0.3.167 allows the notification thumbnail as the strict LAST resort
        // (via notificationImageBuf, tail of the chain), but the old ordering
        // that put it ahead of the full frame must never return.
        expect(src).not.toMatch(/posterUrl\s*=\s*imageUrl\s*\|\|\s*fullFrameUrl/);
        expect(src).not.toMatch(/posterUrl\s*=\s*fullFrameUrl\s*\|\|\s*imageUrl/);
    });

    it('poster bytes are never sourced from the imageUrl base64 string', () => {
        // The last-resort path uses the raw notificationImageBuf buffer, NOT a
        // re-decode of the imageUrl data-URL string.
        const posterAssignFromImageUrl = /posterBuf\s*=\s*Buffer\.from\(\s*imageUrl/;
        expect(src).not.toMatch(posterAssignFromImageUrl);
    });

    it('poster source label "imageUrl" is never used (last-resort label is "notificationImage")', () => {
        // The old 'imageUrl' label must not reappear; v0.3.167 labels the
        // last-resort source 'notificationImage' instead.
        expect(src).not.toMatch(/posterSource\s*=\s*['"]imageUrl['"]/);
    });

    it('poster write happens per-event (before grouping decisions, so grouping ON or OFF both benefit)', () => {
        expect(src).toMatch(/await\s+this\.llmProvider\.posterStore\.put\(\s*notificationId\s*,/);
    });

    it('subject crop is computed from the full event frame + detection bbox', () => {
        expect(src).toMatch(/subjectCrop\s*\(\s*fw\s*,\s*fh\s*,\s*bbox/);
        expect(src).toMatch(/cropJpeg\s*\(\s*fullFrameBuf/);
    });

    it('full event frame fetched via getFullEventFrame helper (NVR-seek capable)', () => {
        // The helper consolidates getDetectionInput + getRecordingStreamThumbnail
        // fallback so the call site doesn't have to repeat the two-path logic.
        expect(src).toMatch(/import\s*\{\s*getFullEventFrame\s*\}\s*from\s*['"]\.\/full-frame-source['"]/);
        expect(src).toMatch(/await\s+getFullEventFrame\s*\(/);
    });
});
