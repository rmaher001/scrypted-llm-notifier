/**
 * getFullEventFrame — fetch the camera frame at a detection trigger moment.
 *
 * Two paths, in order:
 *   1. ObjectDetector.getDetectionInput(detectionId, eventId) — fastest when
 *      the in-memory detection cache hasn't evicted the entry yet.
 *      Verified failure mode (Scrypted's objectdetector plugin):
 *        throws 'Detection not found. It may have expired.' once evicted
 *        (objectdetector/src/main.ts:677-684).
 *   2. getRecordingStreamThumbnail(detectionTimestampMs) —
 *      seeks into the NVR recording at the exact detection timestamp and
 *      returns the native full-resolution still (no resize/options passed).
 *      Decided by METHOD PRESENCE, not the 'VideoRecorder' interface flag:
 *      UniFi Protect cameras return a working thumbnail but may not advertise
 *      VideoRecorder, and the old interface gate skipped the only path that
 *      works. SDK: RecordingStreamThumbnailOptions in sdk/types/src/types.input.ts.
 *
 * Per 2026-05-15 notification-image-rules spec §4.4. The point: if path 1
 * fails (which it regularly does once the detection cache has rolled over),
 * the operator was seeing Scrypted's pre-cropped 172×172 detection thumbnail
 * because the plugin used to fall back to that. The NVR-seek path returns
 * the full-resolution camera frame at exactly the trigger timestamp, so the
 * subject-crop pipeline can run on a real frame instead.
 *
 * Pure-ish: SDK objects are duck-typed, mediaManager is injected as
 * `convertToBuffer`. Testable with mocks; no Scrypted imports.
 */

export interface ObjectDetectorLike {
    getDetectionInput?: (detectionId: string, eventId?: string) => Promise<any>;
}

export interface CameraLike {
    interfaces?: readonly string[];
    getRecordingStreamThumbnail?: (time: number, options?: any) => Promise<any>;
}

export interface FullFrameSourceInput {
    objDet?: ObjectDetectorLike;
    camera?: CameraLike;
    detectionId?: string;
    eventId?: string;
    detectionTimestamp: number;
}

export type FullFrameSource = 'detectionInput' | 'nvrSeek' | 'none';

export interface FullFrameResult {
    buf?: Buffer;
    source: FullFrameSource;
    cameraHasVideoRecorder: boolean;
    detectionInputError?: string;
    nvrSeekError?: string;
}

type ConvertToBuffer = (mo: any, mime: string) => Promise<Buffer>;

interface ConsoleLike {
    warn(...args: any[]): void;
}

export async function getFullEventFrame(
    input: FullFrameSourceInput,
    convertToBuffer: ConvertToBuffer,
    console: ConsoleLike,
): Promise<FullFrameResult> {
    const { objDet, camera, detectionId, eventId, detectionTimestamp } = input;
    const cameraHasVideoRecorder = !!camera?.interfaces?.includes('VideoRecorder');
    let detectionInputError: string | undefined;
    let nvrSeekError: string | undefined;

    if (objDet?.getDetectionInput && detectionId) {
        try {
            const mo = await objDet.getDetectionInput(detectionId, eventId);
            if (mo) {
                const buf = await convertToBuffer(mo, 'image/jpeg');
                return { buf, source: 'detectionInput', cameraHasVideoRecorder };
            }
            detectionInputError = 'getDetectionInput returned null';
        } catch (e) {
            // Expected when the detection map has evicted the entry. Falls
            // through to NVR-seek, which works for any timestamp inside the
            // NVR retention window.
            detectionInputError = (e as Error)?.message ?? String(e);
            console.warn('[FullFrame] getDetectionInput failed, trying NVR seek:', detectionInputError);
        }
    }

    // Decide on method presence, NOT the 'VideoRecorder' interface flag. UniFi
    // Protect cameras return a working getRecordingStreamThumbnail but may not
    // list VideoRecorder in interfaces; gating on the flag skipped the only path
    // that actually works. Seek by the exact detection timestamp with NO options
    // (no resize) so the NVR returns the native full-resolution frame. This is
    // the exact call shape validated live (succeeds at every interval 0s-90s).
    // A detectionId option is deliberately NOT passed: these events are often
    // Protect-native, so the NVR may not know that id, and passing it risks
    // breaking the timestamp seek that is proven to work. Failures are caught.
    if (camera?.getRecordingStreamThumbnail) {
        try {
            const mo = await camera.getRecordingStreamThumbnail(detectionTimestamp);
            if (mo) {
                const buf = await convertToBuffer(mo, 'image/jpeg');
                return { buf, source: 'nvrSeek', cameraHasVideoRecorder, detectionInputError };
            }
            nvrSeekError = 'getRecordingStreamThumbnail returned null';
        } catch (e) {
            nvrSeekError = (e as Error)?.message ?? String(e);
            console.warn('[FullFrame] NVR-seek thumbnail failed:', nvrSeekError);
        }
    }

    return { source: 'none', cameraHasVideoRecorder, detectionInputError, nvrSeekError };
}
