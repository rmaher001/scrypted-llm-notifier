/**
 * selectPosterRawSource — poster/thumbnail/delivery image selection, split by
 * notification type (v0.3.172).
 *
 * EVIDENCE (production log under v0.3.171, 272 [Poster] lines): 174 subjectCrop,
 * 11 posterBox, only 1 notificationImage. Scrypted's own composite was
 * effectively never used, because it sits LAST in the chain and the NVR seek
 * succeeds for Stories — so subjectCrop always won.
 *
 * That is wrong for a STORY. A Story spans minutes (5m22s observed on the
 * Scrypted timeline for one Living Room story), and Scrypted delivers a
 * COMPOSITE image stitched from the story's own crops — a summary of the whole
 * span. A single seeked frame is one arbitrary instant out of those minutes, so
 * the gallery card never matched the notification the operator received.
 * Operator direction 2026-07-25: "do not discard" the composite, and "the
 * poster should also be the same as the thumbnail - composite".
 *
 * Because the gallery thumbnail is served from the stored poster and the
 * delivered notification image is built from the same raw source, selecting the
 * composite here makes poster, thumbnail and delivered image identical for a
 * Story.
 *
 * PER-DETECTION events keep the existing order: there the seeked frame is
 * genuinely better than Scrypted's tight bbox thumbnail, which is exactly why
 * v0.3.118 demoted that thumbnail in the first place.
 */

import { selectPosterRawSource } from '../src/poster-source';

const POSTER_BOX = 'posterBoxBuf' as any;
const SUBJECT = 'subjectCropBuf' as any;
const FULL = 'fullFrameBuf' as any;
const COMPOSITE = 'notificationImageBuf' as any;

describe('selectPosterRawSource — STORY (summary)', () => {
    it('prefers Scrypted\'s composite over every locally-derived crop', () => {
        const r = selectPosterRawSource({
            isSummary: true,
            posterBoxCropBuf: POSTER_BOX,
            subjectCropBuf: SUBJECT,
            fullFrameBuf: FULL,
            notificationImageBuf: COMPOSITE,
        });
        expect(r.buf).toBe(COMPOSITE);
        expect(r.source).toBe('notificationImage');
    });

    it('falls back through the normal chain when no composite came with the notification', () => {
        expect(selectPosterRawSource({
            isSummary: true, posterBoxCropBuf: POSTER_BOX, subjectCropBuf: SUBJECT, fullFrameBuf: FULL,
        })).toEqual({ buf: POSTER_BOX, source: 'posterBox' });

        expect(selectPosterRawSource({
            isSummary: true, subjectCropBuf: SUBJECT, fullFrameBuf: FULL,
        })).toEqual({ buf: SUBJECT, source: 'subjectCrop' });

        expect(selectPosterRawSource({
            isSummary: true, fullFrameBuf: FULL,
        })).toEqual({ buf: FULL, source: 'fullFrameBuf' });
    });
});

describe('selectPosterRawSource — PER-DETECTION', () => {
    it('keeps the v0.3.164 order: posterBox, then subjectCrop, then fullFrame', () => {
        expect(selectPosterRawSource({
            isSummary: false,
            posterBoxCropBuf: POSTER_BOX, subjectCropBuf: SUBJECT, fullFrameBuf: FULL, notificationImageBuf: COMPOSITE,
        })).toEqual({ buf: POSTER_BOX, source: 'posterBox' });

        expect(selectPosterRawSource({
            isSummary: false, subjectCropBuf: SUBJECT, fullFrameBuf: FULL, notificationImageBuf: COMPOSITE,
        })).toEqual({ buf: SUBJECT, source: 'subjectCrop' });

        expect(selectPosterRawSource({
            isSummary: false, fullFrameBuf: FULL, notificationImageBuf: COMPOSITE,
        })).toEqual({ buf: FULL, source: 'fullFrameBuf' });
    });

    it('still uses the notification image as the never-blank LAST resort (v0.3.167)', () => {
        expect(selectPosterRawSource({
            isSummary: false, notificationImageBuf: COMPOSITE,
        })).toEqual({ buf: COMPOSITE, source: 'notificationImage' });
    });

    it('reports source=none when there is nothing at all', () => {
        expect(selectPosterRawSource({ isSummary: false })).toEqual({ buf: undefined, source: 'none' });
        expect(selectPosterRawSource({ isSummary: true })).toEqual({ buf: undefined, source: 'none' });
    });
});

describe('call site uses the shared selector', () => {
    const fsp = require('fs/promises');
    const path = require('path');
    let src: string;
    beforeAll(async () => {
        src = await fsp.readFile(path.resolve(__dirname, '../src/llm-notifier.ts'), 'utf-8');
    });

    it('llm-notifier delegates poster selection instead of inlining the chain', () => {
        expect(src).toMatch(/selectPosterRawSource\s*\(/);
        // The old inlined nullish chain must not linger alongside the selector.
        expect(src).not.toMatch(/const\s+rawSource\s*=\s*posterBoxCropBuf\s*\?\?/);
    });

    it('the delivered notification image is built from the SAME raw source as the poster', () => {
        // Guarantees notification image == gallery thumbnail == poster.
        expect(src).toMatch(/downscaleForNotificationDelivery\(\s*rawSource\s*\)/);
    });

    it('passes the composite into the selector, not just the crops', () => {
        expect(src).toMatch(/selectPosterRawSource\(\{[\s\S]*?notificationImageBuf,[\s\S]*?\}\)/);
    });

    it('the poster-decision log reports the SELECTOR\'s choice, never a parallel recomputation', () => {
        // v0.3.83 lesson: when two algorithms each decide "which image", they
        // drift and the diagnostic starts lying. decisionSource must derive
        // from picked.source, so a Story cannot log 'subjectCrop' while the
        // composite is what actually reached disk.
        expect(src).toMatch(/const\s+decisionSource:\s*PosterSource\s*=[\s\S]{0,400}?picked\.source/);
        expect(src).not.toMatch(/const\s+decisionSource:\s*PosterSource\s*=\s*\n?\s*posterBoxCropBuf\s*\?/);
    });
});
