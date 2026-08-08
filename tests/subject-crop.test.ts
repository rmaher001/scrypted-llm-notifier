/**
 * v0.3.112 Phase 2: subject-centric adaptive crop math.
 *
 * Given a full source frame and a detection bounding box, compute a 16:9
 * (or other target-aspect) crop region that:
 *   - Uses the full frame when the subject is already large (>=30% area)
 *   - Zooms in around the subject when small (<5% area), targeting ~25% area
 *   - Linearly interpolates between the above for mid-sized subjects
 *   - Always contains the entire bounding box
 *   - Stays within the source frame boundaries (clips to edges if subject is corner-positioned)
 *   - Returns null on invalid inputs (zero/negative dimensions)
 */

import { subjectCrop, parsePosterBox, posterBoxToPixelBbox, shouldUsePosterBox, PosterBox } from '../src/subject-crop';

describe('subjectCrop', () => {
    const TARGET_ASPECT = 16 / 9;

    it('returns the full frame when the bbox covers >=30% of frame area', () => {
        // 1920x1080 frame, bbox 1100x600 in middle: area ratio ~0.318
        const frameW = 1920, frameH = 1080;
        const bbox: [number, number, number, number] = [410, 240, 1100, 600];
        const out = subjectCrop(frameW, frameH, bbox, TARGET_ASPECT)!;
        expect(out.x).toBe(0);
        expect(out.y).toBe(0);
        expect(out.w).toBe(frameW);
        expect(out.h).toBe(frameH);
    });

    it('zooms toward a small bbox (<5% area), targeting ~50% area (v0.3.117 floor)', () => {
        // 1920x1080 frame, small 200x200 bbox in center: area ratio ~0.019
        const frameW = 1920, frameH = 1080;
        const bbox: [number, number, number, number] = [860, 440, 200, 200];
        const out = subjectCrop(frameW, frameH, bbox, TARGET_ASPECT)!;
        const outArea = out.w * out.h;
        const frameArea = frameW * frameH;
        // v0.3.117: floor raised to 50%; small bbox should produce ~50% area.
        expect(outArea / frameArea).toBeGreaterThanOrEqual(0.49);
        expect(outArea / frameArea).toBeLessThan(0.55);
        // Aspect ratio should be approximately 16:9
        expect(out.w / out.h).toBeCloseTo(TARGET_ASPECT, 1);
        // Bbox must be fully contained in output
        expect(out.x).toBeLessThanOrEqual(bbox[0]);
        expect(out.y).toBeLessThanOrEqual(bbox[1]);
        expect(out.x + out.w).toBeGreaterThanOrEqual(bbox[0] + bbox[2]);
        expect(out.y + out.h).toBeGreaterThanOrEqual(bbox[1] + bbox[3]);
    });

    it('always contains the entire bounding box, even when bbox aspect mismatches target', () => {
        // Tall, narrow bbox (portrait person at distance)
        const frameW = 1920, frameH = 1080;
        const bbox: [number, number, number, number] = [950, 100, 80, 800];
        const out = subjectCrop(frameW, frameH, bbox, TARGET_ASPECT)!;
        // Bbox containment
        expect(out.x).toBeLessThanOrEqual(bbox[0]);
        expect(out.y).toBeLessThanOrEqual(bbox[1]);
        expect(out.x + out.w).toBeGreaterThanOrEqual(bbox[0] + bbox[2]);
        expect(out.y + out.h).toBeGreaterThanOrEqual(bbox[1] + bbox[3]);
    });

    it('clips output to frame edges when subject is in a corner', () => {
        const frameW = 1920, frameH = 1080;
        // Subject in top-left corner
        const bbox: [number, number, number, number] = [10, 10, 200, 200];
        const out = subjectCrop(frameW, frameH, bbox, TARGET_ASPECT)!;
        // Output must stay within frame
        expect(out.x).toBeGreaterThanOrEqual(0);
        expect(out.y).toBeGreaterThanOrEqual(0);
        expect(out.x + out.w).toBeLessThanOrEqual(frameW);
        expect(out.y + out.h).toBeLessThanOrEqual(frameH);
        // Bbox still contained
        expect(out.x + out.w).toBeGreaterThanOrEqual(bbox[0] + bbox[2]);
        expect(out.y + out.h).toBeGreaterThanOrEqual(bbox[1] + bbox[3]);
    });

    it('never returns dimensions exceeding the source frame', () => {
        const frameW = 1280, frameH = 720;
        // Bbox that would force a giant output if not clipped
        const bbox: [number, number, number, number] = [600, 350, 100, 100];
        const out = subjectCrop(frameW, frameH, bbox, TARGET_ASPECT)!;
        expect(out.w).toBeLessThanOrEqual(frameW);
        expect(out.h).toBeLessThanOrEqual(frameH);
        expect(out.x).toBeGreaterThanOrEqual(0);
        expect(out.y).toBeGreaterThanOrEqual(0);
    });

    it('preserves the target aspect ratio (within 1% tolerance)', () => {
        const frameW = 1920, frameH = 1080;
        const bbox: [number, number, number, number] = [800, 400, 300, 300];
        const out = subjectCrop(frameW, frameH, bbox, TARGET_ASPECT)!;
        const aspect = out.w / out.h;
        // Within 1% of target aspect (rounding tolerance for integer coords)
        expect(Math.abs(aspect - TARGET_ASPECT) / TARGET_ASPECT).toBeLessThan(0.01);
    });

    it('returns null for zero or negative frame dimensions', () => {
        expect(subjectCrop(0, 1080, [0, 0, 100, 100])).toBeNull();
        expect(subjectCrop(1920, 0, [0, 0, 100, 100])).toBeNull();
        expect(subjectCrop(-1, 1080, [0, 0, 100, 100])).toBeNull();
    });

    it('returns null for invalid bbox', () => {
        expect(subjectCrop(1920, 1080, [0, 0, 0, 100])).toBeNull();
        expect(subjectCrop(1920, 1080, [0, 0, 100, 0])).toBeNull();
        expect(subjectCrop(1920, 1080, [0, 0, -10, 100])).toBeNull();
    });

    it('produces integer pixel coordinates (compatible with sharp.extract)', () => {
        const frameW = 1920, frameH = 1080;
        const bbox: [number, number, number, number] = [867, 423, 217, 311];
        const out = subjectCrop(frameW, frameH, bbox, TARGET_ASPECT)!;
        expect(Number.isInteger(out.x)).toBe(true);
        expect(Number.isInteger(out.y)).toBe(true);
        expect(Number.isInteger(out.w)).toBe(true);
        expect(Number.isInteger(out.h)).toBe(true);
    });

    it('mid-sized bbox (~10% area) produces an intermediate zoom', () => {
        const frameW = 1920, frameH = 1080;
        // 600x350 = 210000 px = 10.1% of 1920x1080
        const bbox: [number, number, number, number] = [660, 365, 600, 350];
        const out = subjectCrop(frameW, frameH, bbox, TARGET_ASPECT)!;
        const outRatio = (out.w * out.h) / (frameW * frameH);
        // Between the small (~25%) and full (~100%) regimes
        expect(outRatio).toBeGreaterThan(0.30);
        expect(outRatio).toBeLessThan(0.95);
    });

    it('produces output area >= 50% of source frame for very small bboxes (v0.3.117 floor)', () => {
        // 1920x1080 source, tiny bbox (~0.1% of frame area) far from edges.
        // Pre-v0.3.117 floor was 25%; v0.3.117 raises to 50% so context survives.
        const result = subjectCrop(1920, 1080, [900, 500, 80, 26]);
        expect(result).not.toBeNull();
        const frameArea = 1920 * 1080;
        const outputArea = result!.w * result!.h;
        // 50% floor with small tolerance for targetAspect rounding/clipping.
        expect(outputArea / frameArea).toBeGreaterThanOrEqual(0.49);
    });
});

// v0.3.164: the VLM-returned poster focus box (normalized 0-1) that drives the
// notification poster crop so the still reflects what the description is about.
describe('parsePosterBox', () => {
    it('accepts a well-formed normalized box', () => {
        const out = parsePosterBox({ x: 0.25, y: 0.1, width: 0.4, height: 0.5 });
        expect(out).toEqual({ x: 0.25, y: 0.1, width: 0.4, height: 0.5 });
    });

    it('returns null for null/undefined/non-object', () => {
        expect(parsePosterBox(null)).toBeNull();
        expect(parsePosterBox(undefined)).toBeNull();
        expect(parsePosterBox('nope')).toBeNull();
        expect(parsePosterBox(42)).toBeNull();
    });

    it('returns null when any coordinate is missing or non-numeric', () => {
        expect(parsePosterBox({ x: 0.1, y: 0.1, width: 0.2 })).toBeNull();
        expect(parsePosterBox({ x: 0.1, y: 0.1, width: 0.2, height: '0.3' })).toBeNull();
        expect(parsePosterBox({ x: NaN, y: 0.1, width: 0.2, height: 0.3 })).toBeNull();
        expect(parsePosterBox({ x: 0.1, y: 0.1, width: Infinity, height: 0.3 })).toBeNull();
    });

    it('returns null for zero/negative width or height', () => {
        expect(parsePosterBox({ x: 0.1, y: 0.1, width: 0, height: 0.3 })).toBeNull();
        expect(parsePosterBox({ x: 0.1, y: 0.1, width: 0.2, height: -0.1 })).toBeNull();
    });

    it('clamps a negative origin to 0', () => {
        const out = parsePosterBox({ x: -0.2, y: -0.05, width: 0.4, height: 0.3 })!;
        expect(out.x).toBe(0);
        expect(out.y).toBe(0);
        expect(out.width).toBe(0.4);
        expect(out.height).toBe(0.3);
    });

    it('clamps width/height so the box stays inside the frame', () => {
        const out = parsePosterBox({ x: 0.8, y: 0.9, width: 0.5, height: 0.5 })!;
        expect(out.x).toBe(0.8);
        expect(out.y).toBe(0.9);
        expect(out.width).toBeCloseTo(0.2, 6);   // 1 - 0.8
        expect(out.height).toBeCloseTo(0.1, 6);  // 1 - 0.9
    });

    it('returns null when the origin is at/over the far edge (no room left)', () => {
        expect(parsePosterBox({ x: 1, y: 0.5, width: 0.3, height: 0.3 })).toBeNull();
        expect(parsePosterBox({ x: 0.5, y: 1.2, width: 0.3, height: 0.3 })).toBeNull();
    });
});

describe('posterBoxToPixelBbox', () => {
    const box: PosterBox = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };

    it('scales a normalized box to pixel [x,y,w,h]', () => {
        expect(posterBoxToPixelBbox(box, 1920, 1080)).toEqual([480, 540, 960, 270]);
    });

    it('rounds to whole pixels', () => {
        // 0.333*1000 = 333, 0.5*1000 = 500, 0.334*1000 = 334
        const out = posterBoxToPixelBbox({ x: 0.3335, y: 0.5, width: 0.3334, height: 0.2 }, 1000, 1000)!;
        expect(out).toEqual([334, 500, 333, 200]);
    });

    it('returns null for invalid frame dimensions', () => {
        expect(posterBoxToPixelBbox(box, 0, 1080)).toBeNull();
        expect(posterBoxToPixelBbox(box, 1920, NaN)).toBeNull();
    });

    it('returns null when the scaled box is degenerate (rounds to zero size)', () => {
        expect(posterBoxToPixelBbox({ x: 0.5, y: 0.5, width: 0.0001, height: 0.2 }, 100, 100)).toBeNull();
    });

    it('produces a Bbox that subjectCrop accepts', () => {
        const px = posterBoxToPixelBbox(box, 1920, 1080)!;
        const rect = subjectCrop(1920, 1080, px, 16 / 9);
        expect(rect).not.toBeNull();
        // The crop must contain the focus box's center.
        const cx = px[0] + px[2] / 2, cy = px[1] + px[3] / 2;
        expect(cx).toBeGreaterThanOrEqual(rect!.x);
        expect(cx).toBeLessThanOrEqual(rect!.x + rect!.w);
        expect(cy).toBeGreaterThanOrEqual(rect!.y);
        expect(cy).toBeLessThanOrEqual(rect!.y + rect!.h);
    });
});

describe('shouldUsePosterBox', () => {
    const box: PosterBox = { x: 0.2, y: 0.3, width: 0.4, height: 0.25 };

    it('is true only when box present AND full frame available AND full frame was sent to the LLM', () => {
        expect(shouldUsePosterBox(box, true, true)).toBe(true);
    });

    it('is false when the model returned no box', () => {
        expect(shouldUsePosterBox(null, true, true)).toBe(false);
        expect(shouldUsePosterBox(undefined, true, true)).toBe(false);
    });

    it('is false when no full frame buffer is available to crop from', () => {
        expect(shouldUsePosterBox(box, false, true)).toBe(false);
    });

    it('is false when the full frame was NOT the analyzed image (e.g. snapshotMode=cropped)', () => {
        // The key safety gate: even a fully-fetched full frame + a stray box
        // must be ignored if that frame was never sent to the model, because
        // the box coordinates would be relative to the tight crop instead.
        expect(shouldUsePosterBox(box, true, false)).toBe(false);
    });
});
