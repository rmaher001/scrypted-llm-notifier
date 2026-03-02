import jpeg from 'jpeg-js';

export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Helper to validate and normalize clarity from LLM response
export function parseClarity(raw: any, console?: { warn: (msg: string, ...args: any[]) => void }): {score: number, reason: string} | undefined {
    if (!raw) return undefined;

    // Validate structure
    if (typeof raw.score !== 'number' || typeof raw.reason !== 'string') {
        console?.warn('[Clarity] Invalid format from LLM:', raw);
        return undefined;
    }

    // Clamp score to 1-10 range and warn on out-of-range (#13)
    const clampedScore = Math.max(1, Math.min(10, Math.round(raw.score)));
    if (raw.score < 1 || raw.score > 10) {
        console?.warn(`[Clarity] Score ${raw.score} out of range (1-10), clamping to ${clampedScore}`);
    } else if (clampedScore !== raw.score) {
        console?.warn(`[Clarity] Score rounded from ${raw.score} to ${clampedScore}`);
    }

    return { score: clampedScore, reason: raw.reason };
}

export function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T> {
    let to: NodeJS.Timeout;
    const timeout = new Promise<T>((_, reject) => {
        to = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(to!)) as Promise<T>;
}

// Local JPEG resize using area-average (box filter) for quality downscaling.
// Nearest-neighbor looks terrible at large scale ratios (e.g. 4K→640px).
// Area-average properly blends all source pixels that map to each destination pixel.
export async function resizeJpegNearest(input: Buffer, targetWidth: number, quality = 60): Promise<Buffer> {
    const { data: src, width: sw, height: sh } = jpeg.decode(input, { useTArray: true });
    if (!sw || !sh)
        return input;
    const dw = Math.min(targetWidth, sw);
    if (dw === sw)
        return input;
    const dh = Math.max(1, Math.round((sh * dw) / sw));
    const dst = Buffer.allocUnsafe(dw * dh * 4);
    const xRatio = sw / dw;
    const yRatio = sh / dh;
    for (let y = 0; y < dh; y++) {
        const srcY0 = y * yRatio;
        const srcY1 = Math.min((y + 1) * yRatio, sh);
        const iy0 = Math.floor(srcY0);
        const iy1 = Math.min(Math.ceil(srcY1), sh);
        for (let x = 0; x < dw; x++) {
            const srcX0 = x * xRatio;
            const srcX1 = Math.min((x + 1) * xRatio, sw);
            const ix0 = Math.floor(srcX0);
            const ix1 = Math.min(Math.ceil(srcX1), sw);
            let r = 0, g = 0, b = 0, area = 0;
            for (let sy = iy0; sy < iy1; sy++) {
                // Vertical weight: fraction of this source row covered by the dest pixel
                const wy = Math.min(sy + 1, srcY1) - Math.max(sy, srcY0);
                for (let sx = ix0; sx < ix1; sx++) {
                    // Horizontal weight: fraction of this source col covered
                    const wx = Math.min(sx + 1, srcX1) - Math.max(sx, srcX0);
                    const w = wx * wy;
                    const si = (sy * sw + sx) << 2;
                    r += src[si] * w;
                    g += src[si + 1] * w;
                    b += src[si + 2] * w;
                    area += w;
                }
            }
            const di = (y * dw + x) << 2;
            dst[di] = Math.round(r / area);
            dst[di + 1] = Math.round(g / area);
            dst[di + 2] = Math.round(b / area);
            dst[di + 3] = 255;
        }
    }
    const { data } = jpeg.encode({ data: dst, width: dw, height: dh }, quality);
    return Buffer.from(data);
}

export function getJpegDimensions(input: Buffer): { width: number; height: number } {
    const { width, height } = jpeg.decode(input, { useTArray: true });
    return { width, height };
}

export function buildImageList(mode: string, full?: string, cropped?: string): string[] {
    const list: string[] = [];
    if (mode === 'both') {
        if (full) list.push(full);
        if (cropped) list.push(cropped);
    } else if (mode === 'full') {
        if (full) list.push(full);
        else if (cropped) list.push(cropped);
    } else { // 'cropped'
        if (cropped) list.push(cropped);
        else if (full) list.push(full);
    }
    return list;
}
