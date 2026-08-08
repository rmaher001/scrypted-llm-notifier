/**
 * Seek-time resolution for the NVR recording seek (poster frame + video clip).
 *
 * WHY THIS EXISTS (evidence: 51 [Shape] samples from production, 2026-07-25):
 *
 * The call sites used to seek with:
 *     (re?.details?.eventTime as number) ?? detectionEpoch
 *
 * Two things were wrong with that. `as number` is a compile-time cast with no
 * runtime effect, and `??` only substitutes for null/undefined. In production
 * `details.eventTime` was PRESENT as a key in 51/51 samples but was never a
 * finite number — so the guard never fired and a non-numeric value was handed
 * straight to the seek. The SDK declares `eventTime: number`
 * (sdk/types/src/types.input.ts:88), so the runtime value disagrees with its
 * declared type: validate the number, never trust the type.
 *
 * `recordedEvent.data.timestamp` WAS a finite number in 51/51 samples, so it is
 * the primary source. Its observed freshness also confirms it is the right
 * field: sub-second on per-detection notifications (median 798 ms), matching the
 * measured UniFi Protect publish lag.
 */

export type SeekTimestampSource = 'data.timestamp' | 'details.eventTime' | 'fallback:now';

export interface SeekTimestamp {
    timestamp: number;
    source: SeekTimestampSource;
}

/** A usable epoch-ms value: finite, numeric, and positive. */
function validEpoch(v: any): number | undefined {
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Resolve the instant to seek the recording to, reporting which field supplied
 * it so the choice is visible in diagnostics rather than silently assumed.
 */
export function resolveSeekTimestamp(recordedEvent: any, fallbackEpoch: number): SeekTimestamp {
    const fromData = validEpoch(recordedEvent?.data?.timestamp);
    if (fromData !== undefined) return { timestamp: fromData, source: 'data.timestamp' };

    const fromDetails = validEpoch(recordedEvent?.details?.eventTime);
    if (fromDetails !== undefined) return { timestamp: fromDetails, source: 'details.eventTime' };

    return { timestamp: fallbackEpoch, source: 'fallback:now' };
}

/**
 * Pull the `time=` parameter out of a Scrypted notification's data.hash deep
 * link, which has the form
 *     #/timeline/<cameraId>?time=<ms>&from=notification&serverId=<id>
 *
 * That value is Scrypted's OWN seek target for the notification, which makes it
 * the candidate for a Story's real instant — a Story's
 * recordedEvent.data.timestamp is its DELIVERY time, which can run many minutes
 * after the activity it describes.
 *
 * DIAGNOSTIC ONLY at present: reported by the [Shape] probe so live traffic can
 * establish whether hash time actually equals story time before any seek
 * behavior depends on it.
 */
export function extractHashTime(hash: any): number | undefined {
    if (typeof hash !== 'string' || !hash) return undefined;
    // (?:[?&]) so a parameter merely ENDING in "time" (endTime=, startTime=)
    // cannot match.
    const m = /[?&]time=(\d+)/.exec(hash);
    if (!m) return undefined;
    const n = Number(m[1]);
    return isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Whether this is one of Scrypted's native "Summary" notifications — a digest
 * covering a SPAN of activity rather than a single detection.
 *
 * Detected by the ABSENCE of the per-detection markers, because Summaries are
 * defined by what they lack. Observed shapes (2026-07-25):
 *   per-detection: options.tag + data.actionUrl + data.snoozeId, and a
 *                  sub-second-fresh data.timestamp (median 798 ms)
 *   summary:       none of those, and a data.timestamp 93-300 s old (median 130 s)
 *
 * NOTE: the old isStoryNotification() keyed on data.storyId, but OUR OWN
 * story-notifier set that field, so it only ever matched our own Stories and
 * never Scrypted's native Summaries.
 */
export function isSummaryNotification(options: any): boolean {
    if (options?.tag !== undefined) return false;
    const data = options?.data;
    if (data?.actionUrl !== undefined) return false;
    if (data?.snoozeId !== undefined) return false;
    return true;
}
