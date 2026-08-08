/**
 * Tests for downscaleForNotificationDelivery — the watch-friendly downscale
 * applied to a poster JPEG before it ships to a notifier. The gallery serves
 * the full-resolution original; only the notifier sees this downscaled copy.
 *
 * Per 2026-05-15 spec §4.5.
 */

import sharp from 'sharp';
import { downscaleForNotificationDelivery, downscaleForStorage } from '../src/notification-downscale';

async function makeJpeg(width: number, height: number, r = 200, g = 50, b = 50): Promise<Buffer> {
    return sharp({
        create: { width, height, channels: 3, background: { r, g, b } },
    }).jpeg({ quality: 90 }).toBuffer();
}

describe('downscaleForNotificationDelivery', () => {
    it('downscales a 1280-wide poster to the target width', async () => {
        const big = await makeJpeg(1280, 965);
        const out = await downscaleForNotificationDelivery(big);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBe(960);
        // Height scales proportionally (965 * 960/1280 ≈ 724).
        expect(meta.height).toBeGreaterThanOrEqual(720);
        expect(meta.height).toBeLessThanOrEqual(728);
    });

    it('produces a much smaller file than the source for typical posters', async () => {
        // 1920x1080 solo poster at q90.
        const big = await makeJpeg(1920, 1080, 80, 80, 80);
        const out = await downscaleForNotificationDelivery(big);
        // Should be at least 30% smaller (often >50%).
        expect(out.length).toBeLessThan(big.length * 0.7);
    });

    it('returns the original when already at or below target width', async () => {
        // 800-wide poster is already small enough; should not enlarge.
        const small = await makeJpeg(800, 450);
        const out = await downscaleForNotificationDelivery(small);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBeLessThanOrEqual(800);
    });

    it('honors custom target width and quality', async () => {
        const big = await makeJpeg(1280, 720);
        const out = await downscaleForNotificationDelivery(big, 640, 60);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBe(640);
        expect(meta.height).toBe(360);
    });

    it('output is a valid JPEG', async () => {
        const big = await makeJpeg(1280, 965);
        const out = await downscaleForNotificationDelivery(big);
        const meta = await sharp(out).metadata();
        expect(meta.format).toBe('jpeg');
    });
});

describe('downscaleForStorage (v0.3.119 §4.6)', () => {
    it('passes through buffers at or below the storage cap width', async () => {
        // 1920-wide source is below the 2560 cap — should pass through unchanged
        // to avoid an unnecessary re-encode.
        const in1080p = await makeJpeg(1920, 1080);
        const out = await downscaleForStorage(in1080p);
        expect(out).toBe(in1080p);
    });

    it('downscales 4K (3840 wide) sources to the storage cap width', async () => {
        const in4k = await makeJpeg(3840, 2160);
        const out = await downscaleForStorage(in4k);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBe(2048);
        // Height scales proportionally (2160 * 2048/3840 = 1152).
        expect(meta.height).toBeGreaterThanOrEqual(1150);
        expect(meta.height).toBeLessThanOrEqual(1154);
    });

    it('produces output that fits under the 500 KB poster cap for realistic 4K input', async () => {
        // Build a 4K source from random-ish RGB raw pixels (poorly compressible,
        // approximating real camera content noise). Encoded at q90 this would
        // typically exceed 1 MB; after downscaleForStorage it must fit under
        // the 500 KB poster cap.
        const W = 3840, H = 2160;
        const raw = Buffer.alloc(W * H * 3);
        for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) & 0xff;
        const big = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
            .jpeg({ quality: 90 })
            .toBuffer();
        const out = await downscaleForStorage(big);
        expect(out.length).toBeLessThan(500 * 1024);
    });

    it('honors custom maxWidth and quality', async () => {
        const big = await makeJpeg(3840, 2160);
        const out = await downscaleForStorage(big, 1920, 70);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBe(1920);
    });
});
