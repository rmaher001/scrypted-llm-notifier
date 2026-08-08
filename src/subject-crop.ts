/**
 * Adaptive subject-centric crop for notification posters.
 *
 * Given a source frame and a detection bounding box, returns the rectangle
 * to extract from the frame that produces a useful notification preview:
 *
 *   - Subject covers >=30% of the frame area: output the full frame.
 *   - Subject covers <5% of the frame area: zoom to ~50% area centered on bbox.
 *   - In between: linearly interpolate area target between 50% and 100%.
 *
 * The output rectangle:
 *   - Always contains the entire bounding box (expanded if bbox is wider/taller
 *     than the area-targeted output would naturally be).
 *   - Always fits within the source frame (clipped to edges; bbox stays inside).
 *   - Preserves the target aspect ratio (default 16:9), to match the
 *     notification banner shape used by iOS HA companion + the v0.3.83 hero slot.
 */

export type Bbox = [number, number, number, number]; // [x, y, w, h] in source pixels

export interface CropRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

// v0.3.164: the VLM-returned "poster focus box" — the region of the FULL
// analyzed frame that best represents the notification's description. Stored
// normalized (fractions of frame width/height, top-left origin) because the
// VLM does not know the source pixel dimensions. Drives the poster crop in
// place of the face-first/first-bbox heuristic when present.
export interface PosterBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

// Validate + sanitize the raw posterBox from the VLM response. Returns a clean
// PosterBox with all fields in [0,1] and the box clamped to stay in-frame, or
// null when absent/malformed/degenerate (caller then falls back to the
// heuristic crop).
export function parsePosterBox(raw: any): PosterBox | null {
    if (!raw || typeof raw !== 'object') return null;
    const { x, y, width, height } = raw as Record<string, unknown>;
    for (const n of [x, y, width, height]) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    }
    const nx = x as number, ny = y as number, nw = width as number, nh = height as number;
    if (!(nw > 0) || !(nh > 0)) return null;
    // Clamp the origin into [0,1], then clamp the size so the box stays
    // in-frame. A box whose origin sits on the far edge has no room and is
    // rejected (caller falls back to the heuristic crop).
    const cx = Math.min(Math.max(nx, 0), 1);
    const cy = Math.min(Math.max(ny, 0), 1);
    const cw = Math.min(nw, 1 - cx);
    const ch = Math.min(nh, 1 - cy);
    if (!(cw > 0) || !(ch > 0)) return null;
    return { x: cx, y: cy, width: cw, height: ch };
}

// Gate: should the VLM posterBox drive the poster crop? Only when the model
// returned a box, a full frame is available to crop from, AND that full frame
// was actually the image the model analyzed (so the box's coordinates are
// relative to it — a stray box against a pre-cropped thumbnail must be ignored).
// Pure, so the gate is unit-tested independently of the Scrypted-wired
// sendNotification path.
export function shouldUsePosterBox(
    posterBox: PosterBox | null | undefined,
    hasFullFrame: boolean,
    fullFrameSentToLlm: boolean,
): boolean {
    return !!posterBox && hasFullFrame && fullFrameSentToLlm;
}

// Convert a normalized PosterBox to a pixel Bbox [x,y,w,h] for subjectCrop().
// Returns null on invalid frame dimensions or a degenerate (sub-pixel) result.
export function posterBoxToPixelBbox(
    box: PosterBox,
    frameWidth: number,
    frameHeight: number,
): Bbox | null {
    if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight)) return null;
    if (frameWidth < 1 || frameHeight < 1) return null;
    const x = Math.round(box.x * frameWidth);
    const y = Math.round(box.y * frameHeight);
    const w = Math.round(box.width * frameWidth);
    const h = Math.round(box.height * frameHeight);
    if (!(w > 0) || !(h > 0)) return null;
    return [x, y, w, h];
}

const SMALL_RATIO = 0.05;
const LARGE_RATIO = 0.30;
// v0.3.117: raised from 0.25 → 0.50 per 2026-05-15 spec "happy medium" rule.
// Tiny-bbox events now produce a crop covering ≥50% of the source frame so
// the subject stays clearly visible AND scene context survives.
const SMALL_OUTPUT_AREA_FRAC = 0.50;

export function subjectCrop(
    frameWidth: number,
    frameHeight: number,
    bbox: Bbox,
    targetAspect: number = 16 / 9,
): CropRect | null {
    if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight)) return null;
    if (frameWidth < 1 || frameHeight < 1) return null;
    if (!bbox || bbox.length < 4) return null;

    const [bx, by, bw, bh] = bbox;
    if (!(bw > 0) || !(bh > 0)) return null;
    if (!Number.isFinite(targetAspect) || targetAspect <= 0) return null;

    const frameArea = frameWidth * frameHeight;
    const bboxArea = bw * bh;
    const ratio = bboxArea / frameArea;

    // Pick output area as a fraction of frame area.
    let outputAreaFrac: number;
    if (ratio >= LARGE_RATIO) {
        outputAreaFrac = 1.0;
    } else if (ratio < SMALL_RATIO) {
        outputAreaFrac = SMALL_OUTPUT_AREA_FRAC;
    } else {
        // Linear interpolation from (SMALL_RATIO, 0.25) to (LARGE_RATIO, 1.0).
        const t = (ratio - SMALL_RATIO) / (LARGE_RATIO - SMALL_RATIO);
        outputAreaFrac = SMALL_OUTPUT_AREA_FRAC + t * (1.0 - SMALL_OUTPUT_AREA_FRAC);
    }

    const outputArea = frameArea * outputAreaFrac;

    // Compute output dimensions matching targetAspect.
    let outH = Math.sqrt(outputArea / targetAspect);
    let outW = outH * targetAspect;

    // Output must contain the entire bbox; expand the smaller dimension if needed,
    // re-deriving the other from targetAspect.
    if (outW < bw) {
        outW = bw;
        outH = outW / targetAspect;
    }
    if (outH < bh) {
        outH = bh;
        outW = outH * targetAspect;
    }

    // Cap at frame dimensions, preserving aspect.
    if (outW > frameWidth) {
        outW = frameWidth;
        outH = outW / targetAspect;
    }
    if (outH > frameHeight) {
        outH = frameHeight;
        outW = outH * targetAspect;
    }

    // Center on bbox center.
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    let x = cx - outW / 2;
    let y = cy - outH / 2;

    // Clip to frame edges (may shift the crop off-center near corners).
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + outW > frameWidth) x = frameWidth - outW;
    if (y + outH > frameHeight) y = frameHeight - outH;

    return {
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(outW),
        h: Math.round(outH),
    };
}
