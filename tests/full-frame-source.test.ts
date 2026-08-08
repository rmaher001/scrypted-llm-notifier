/**
 * Tests for getFullEventFrame — fetches the full camera frame at a detection
 * trigger moment, with NVR-seek fallback when the in-process detection cache
 * has evicted the entry. Pure logic; SDK objects are duck-typed mocks.
 *
 * v0.3.120: returns a FullFrameResult always (never null) so callers can
 * record diagnostic info (cameraHasVideoRecorder, error messages from each
 * path) for the poster-decision log.
 *
 * Per 2026-05-15 notification-image-rules spec §4.4.
 */

import { getFullEventFrame } from '../src/full-frame-source';

function silentConsole() {
    return { warn: () => {} };
}

function fakeMediaObject(label: string) {
    return { __label: label } as any;
}

function fakeConvertToBuffer(map: Map<unknown, Buffer>): (mo: any, mime: string) => Promise<Buffer> {
    return async (mo: any) => {
        const buf = map.get(mo);
        if (!buf) throw new Error('mock convert: no entry for media object');
        return buf;
    };
}

describe('getFullEventFrame', () => {
    const TIMESTAMP = 1_700_000_000_000;
    const DETECTION_ID = 'det-abc';
    const EVENT_ID = 'evt-xyz';

    it('returns detectionInput frame when getDetectionInput resolves', async () => {
        const detMo = fakeMediaObject('det');
        const detBuf = Buffer.from([1, 2, 3]);
        const convert = fakeConvertToBuffer(new Map([[detMo, detBuf]]));
        const objDet = { getDetectionInput: jest.fn().mockResolvedValue(detMo) };
        const camera = { interfaces: ['VideoRecorder'], getRecordingStreamThumbnail: jest.fn() };

        const result = await getFullEventFrame(
            { objDet, camera, detectionId: DETECTION_ID, eventId: EVENT_ID, detectionTimestamp: TIMESTAMP },
            convert,
            silentConsole(),
        );

        expect(result.buf).toBe(detBuf);
        expect(result.source).toBe('detectionInput');
        expect(result.cameraHasVideoRecorder).toBe(true);
        expect(result.detectionInputError).toBeUndefined();
        expect(objDet.getDetectionInput).toHaveBeenCalledWith(DETECTION_ID, EVENT_ID);
        expect(camera.getRecordingStreamThumbnail).not.toHaveBeenCalled();
    });

    it('falls back to NVR-seek when getDetectionInput throws and captures the error message', async () => {
        const nvrMo = fakeMediaObject('nvr');
        const nvrBuf = Buffer.from([9, 9, 9, 9]);
        const convert = fakeConvertToBuffer(new Map([[nvrMo, nvrBuf]]));
        const objDet = { getDetectionInput: jest.fn().mockRejectedValue(new Error('Detection not found. It may have expired.')) };
        const camera = { interfaces: ['VideoRecorder'], getRecordingStreamThumbnail: jest.fn().mockResolvedValue(nvrMo) };

        const result = await getFullEventFrame(
            { objDet, camera, detectionId: DETECTION_ID, eventId: EVENT_ID, detectionTimestamp: TIMESTAMP },
            convert,
            silentConsole(),
        );

        expect(result.buf).toBe(nvrBuf);
        expect(result.source).toBe('nvrSeek');
        expect(result.detectionInputError).toMatch(/Detection not found/);
        // Seek by the exact detection timestamp with NO options → native full-res frame.
        expect(camera.getRecordingStreamThumbnail).toHaveBeenCalledWith(TIMESTAMP);
    });

    it('calls NVR-seek even when the camera does not advertise VideoRecorder (method presence, not the interface flag, decides)', async () => {
        // Regression fix: UniFi Protect cameras return a working
        // getRecordingStreamThumbnail but may not list 'VideoRecorder' in
        // interfaces. The old gate skipped the one path that actually works.
        // Decide on method presence and catch failures instead.
        const nvrMo = fakeMediaObject('nvr');
        const nvrBuf = Buffer.from([4, 4]);
        const convert = fakeConvertToBuffer(new Map([[nvrMo, nvrBuf]]));
        const objDet = { getDetectionInput: jest.fn().mockRejectedValue(new Error('expired')) };
        const camera = { interfaces: ['Camera'], getRecordingStreamThumbnail: jest.fn().mockResolvedValue(nvrMo) };

        const result = await getFullEventFrame(
            { objDet, camera, detectionId: DETECTION_ID, detectionTimestamp: TIMESTAMP },
            convert,
            silentConsole(),
        );

        expect(result.buf).toBe(nvrBuf);
        expect(result.source).toBe('nvrSeek');
        // Still reported honestly for diagnostics, but no longer gates the call.
        expect(result.cameraHasVideoRecorder).toBe(false);
        expect(camera.getRecordingStreamThumbnail).toHaveBeenCalledWith(TIMESTAMP);
    });

    it('returns source=none when the camera has no getRecordingStreamThumbnail method', async () => {
        const objDet = { getDetectionInput: jest.fn().mockRejectedValue(new Error('expired')) };
        const camera = { interfaces: ['Camera'] };

        const result = await getFullEventFrame(
            { objDet, camera, detectionId: DETECTION_ID, detectionTimestamp: TIMESTAMP },
            fakeConvertToBuffer(new Map()),
            silentConsole(),
        );

        expect(result.buf).toBeUndefined();
        expect(result.source).toBe('none');
        expect(result.detectionInputError).toBe('expired');
        expect(result.nvrSeekError).toBeUndefined();
    });

    it('returns source=none capturing both error messages when both paths fail', async () => {
        const objDet = { getDetectionInput: jest.fn().mockRejectedValue(new Error('expired')) };
        const camera = { interfaces: ['VideoRecorder'], getRecordingStreamThumbnail: jest.fn().mockRejectedValue(new Error('NVR offline')) };

        const result = await getFullEventFrame(
            { objDet, camera, detectionId: DETECTION_ID, detectionTimestamp: TIMESTAMP },
            fakeConvertToBuffer(new Map()),
            silentConsole(),
        );

        expect(result.buf).toBeUndefined();
        expect(result.source).toBe('none');
        expect(result.cameraHasVideoRecorder).toBe(true);
        expect(result.detectionInputError).toBe('expired');
        expect(result.nvrSeekError).toBe('NVR offline');
    });

    it('skips getDetectionInput when no detectionId is provided', async () => {
        const nvrMo = fakeMediaObject('nvr');
        const nvrBuf = Buffer.from([7]);
        const convert = fakeConvertToBuffer(new Map([[nvrMo, nvrBuf]]));
        const objDet = { getDetectionInput: jest.fn() };
        const camera = { interfaces: ['VideoRecorder'], getRecordingStreamThumbnail: jest.fn().mockResolvedValue(nvrMo) };

        const result = await getFullEventFrame(
            { objDet, camera, detectionTimestamp: TIMESTAMP },
            convert,
            silentConsole(),
        );

        expect(result.buf).toBe(nvrBuf);
        expect(result.source).toBe('nvrSeek');
        expect(result.detectionInputError).toBeUndefined();
        expect(objDet.getDetectionInput).not.toHaveBeenCalled();
        // No detectionId → still a bare-timestamp seek (no options object).
        expect(camera.getRecordingStreamThumbnail).toHaveBeenCalledWith(TIMESTAMP);
    });

    it('returns source=none when no objDet AND no camera', async () => {
        const result = await getFullEventFrame(
            { detectionTimestamp: TIMESTAMP },
            fakeConvertToBuffer(new Map()),
            silentConsole(),
        );
        expect(result.buf).toBeUndefined();
        expect(result.source).toBe('none');
        expect(result.cameraHasVideoRecorder).toBe(false);
    });

    it('treats getDetectionInput resolving to null as a failure and falls back, marking the error', async () => {
        const nvrMo = fakeMediaObject('nvr');
        const nvrBuf = Buffer.from([5]);
        const convert = fakeConvertToBuffer(new Map([[nvrMo, nvrBuf]]));
        const objDet = { getDetectionInput: jest.fn().mockResolvedValue(undefined) };
        const camera = { interfaces: ['VideoRecorder'], getRecordingStreamThumbnail: jest.fn().mockResolvedValue(nvrMo) };

        const result = await getFullEventFrame(
            { objDet, camera, detectionId: DETECTION_ID, detectionTimestamp: TIMESTAMP },
            convert,
            silentConsole(),
        );

        expect(result.buf).toBe(nvrBuf);
        expect(result.source).toBe('nvrSeek');
        expect(result.detectionInputError).toBe('getDetectionInput returned null');
    });
});
