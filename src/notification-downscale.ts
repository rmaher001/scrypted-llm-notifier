/**
 * downscaleForNotificationDelivery — produce a watch-friendly JPEG of a
 * poster image for notifier delivery. The full-resolution source remains
 * stored in posterStore and served unchanged to the gallery; only the
 * notifier receives this smaller copy.
 *
 * Sized to land at ~80-150 KB so Apple Watch APNs delivery doesn't trigger
 * the notification-load spinner. Calibration from v0.3.83.
 *
 * Per 2026-05-15 notification-image-rules spec §4.5.
 */

import sharp from 'sharp';

const DEFAULT_TARGET_WIDTH = 960;
const DEFAULT_QUALITY = 70;
const STORAGE_MAX_WIDTH = 2048;
const STORAGE_QUALITY = 75;

export async function downscaleForNotificationDelivery(
    fullBuf: Buffer,
    targetWidth: number = DEFAULT_TARGET_WIDTH,
    quality: number = DEFAULT_QUALITY,
): Promise<Buffer> {
    return sharp(fullBuf)
        .resize(targetWidth, null, { withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
}

/**
 * Storage-cap downscale (spec §4.6). Caps stored posters at a manageable
 * width so 4K cameras stay well under the 1 MB poster size cap. Sources
 * already at or below the cap pass through unchanged to avoid an unnecessary
 * re-encode (which would otherwise add JPEG artifacts on already-compressed
 * input).
 */
export async function downscaleForStorage(
    fullBuf: Buffer,
    maxWidth: number = STORAGE_MAX_WIDTH,
    quality: number = STORAGE_QUALITY,
): Promise<Buffer> {
    const meta = await sharp(fullBuf).metadata();
    if ((meta.width ?? 0) <= maxWidth) return fullBuf;
    return sharp(fullBuf)
        .resize(maxWidth, null, { withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
}
