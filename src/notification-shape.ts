/**
 * summarizeNotificationShape — DIAGNOSTIC-ONLY probe (v0.3.168).
 *
 * Emits a compact description of an incoming notification so we can answer two
 * questions from real traffic instead of guessing:
 *
 *   1. WHICH FIELD IS THE SEEK TIME? llm-notifier seeks the NVR recording by
 *      `recordedEvent.details.eventTime`, falling back to Date.now(). But our
 *      own v0.3.153 capture of a real Scrypted recordedEvent recorded that the
 *      seek time is `data.timestamp` and that `details` carries ONLY
 *      `eventInterface`. If that holds, every poster/clip has been seeking on
 *      notification-handling time — which would explain posters and clips that
 *      do not match reality.
 *
 *   2. HOW DO WE RECOGNISE A NATIVE SCRYPTED STORY NOTIFICATION? The removed
 *      isStoryNotification() keyed on `data.storyId`, but our own dispatcher
 *      set that field, so it only ever detected our own Stories. Scrypted's NVR
 *      plugin is closed-source and the SDK types expose no story surface, so
 *      the discriminator must be found from live traffic. Dumping the option +
 *      data key sets makes any native marker visible the moment it arrives.
 *
 * Pure and side-effect free: `now` is injected rather than read from the clock,
 * so the output is deterministic and unit-testable. Never throws — a diagnostic
 * must not be able to break the notification path.
 */

import { extractHashTime } from './seek-time';

export type SeekFieldPresence =
    | 'both'
    | 'data.timestamp only'
    | 'details.eventTime only'
    | 'NEITHER (falls back to Date.now)';

export interface NotificationShape {
    optionKeys: string[];
    dataKeys: string[];
    hasRecordedEvent: boolean;
    hasDetectionId: boolean;
    detectionCount: number;
    reTopLevelId?: string;
    reDataKeys: string[];
    reDetailsKeys: string[];
    /** recordedEvent.data.timestamp — per v0.3.153, the REAL seek time. */
    dataTimestamp?: number;
    /** recordedEvent.details.eventTime — numeric value, if it actually is one. */
    detailsEventTime?: number;
    /**
     * `typeof details.eventTime` (plus a Date/Array refinement). Production
     * showed the key PRESENT in 51/51 samples yet never a finite number, while
     * the SDK declares it `number` — this records what it really is.
     */
    detailsEventTimeType?: string;
    /**
     * `time=` parsed out of data.hash — Scrypted's own seek target. For a Story
     * this is the candidate for the real instant, since data.timestamp is the
     * DELIVERY time. Compare hashTimeVsDataTimestampMs to see how far apart the
     * two are: near-zero on per-detection events, large on Stories if the hash
     * really does carry the story time. SIGN: hashTime - dataTimestamp, so a
     * NEGATIVE value means the hash points EARLIER than delivery — the Story
     * hypothesis. Near zero means the hash is just delivery time too.
     */
    hashTime?: number;
    hashTimeAgeMs?: number;
    hashTimeVsDataTimestampMs?: number;
    /** How stale each candidate is at handling time (ms). */
    dataTimestampAgeMs?: number;
    detailsEventTimeAgeMs?: number;
    seekFieldPresent: SeekFieldPresence;
}

function keysOf(o: any): string[] {
    return o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : [];
}

function numberOrUndefined(v: any): number | undefined {
    return typeof v === 'number' && isFinite(v) ? v : undefined;
}

/** typeof, refined enough to tell a Date or Array apart from a plain object. */
function describeType(v: any): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Date) return 'Date';
    const t = typeof v;
    if (t === 'number') return isFinite(v) ? 'number' : 'number(non-finite)';
    return t;
}

export function summarizeNotificationShape(options: any, now: number): NotificationShape {
    const re = options?.recordedEvent;
    const reData = re?.data;
    const reDetails = re?.details;

    const dataTimestamp = numberOrUndefined(reData?.timestamp);
    const detailsEventTime = numberOrUndefined(reDetails?.eventTime);

    const seekFieldPresent: SeekFieldPresence =
        dataTimestamp !== undefined && detailsEventTime !== undefined ? 'both'
            : dataTimestamp !== undefined ? 'data.timestamp only'
                : detailsEventTime !== undefined ? 'details.eventTime only'
                    : 'NEITHER (falls back to Date.now)';

    const detections = reData?.detections;
    const hashTime = extractHashTime(options?.data?.hash);

    return {
        optionKeys: keysOf(options),
        dataKeys: keysOf(options?.data),
        hasRecordedEvent: !!re,
        hasDetectionId: !!(reData?.detectionId ?? reData?.detections?.[0]?.id),
        detectionCount: Array.isArray(detections) ? detections.length : 0,
        reTopLevelId: typeof re?.id === 'string' ? re.id : undefined,
        reDataKeys: keysOf(reData),
        reDetailsKeys: keysOf(reDetails),
        dataTimestamp,
        detailsEventTime,
        detailsEventTimeType: reDetails && 'eventTime' in reDetails ? describeType(reDetails.eventTime) : undefined,
        hashTime,
        hashTimeAgeMs: hashTime !== undefined ? now - hashTime : undefined,
        hashTimeVsDataTimestampMs: (hashTime !== undefined && dataTimestamp !== undefined) ? hashTime - dataTimestamp : undefined,
        dataTimestampAgeMs: dataTimestamp !== undefined ? now - dataTimestamp : undefined,
        detailsEventTimeAgeMs: detailsEventTime !== undefined ? now - detailsEventTime : undefined,
        seekFieldPresent,
    };
}
