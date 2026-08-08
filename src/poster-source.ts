/**
 * Poster / thumbnail / delivery image selection.
 *
 * One raw source feeds all three: the stored poster, the gallery thumbnail
 * (served from that poster) and the image attached to the outgoing
 * notification. Selecting here therefore keeps the three identical.
 *
 * TWO ORDERS, split by notification type:
 *
 *   STORY (Scrypted "Summary"): the composite Scrypted ships with the
 *   notification WINS. A Story spans minutes — 5m22s on one observed Living
 *   Room story — and that composite is stitched from the story's own crops, so
 *   it summarises the whole span. A locally seeked frame is one arbitrary
 *   instant out of those minutes. Before v0.3.172 the composite sat last and
 *   the seek always succeeded, so it was discarded on essentially every Story:
 *   272 [Poster] lines in production yielded 174 subjectCrop, 11 posterBox and
 *   just 1 notificationImage, which is why gallery cards never matched the
 *   notification the operator had received.
 *
 *   PER-DETECTION: unchanged from v0.3.164 — posterBox, then subjectCrop, then
 *   fullFrame, with the notification image kept only as the never-blank last
 *   resort (v0.3.167). Here the seeked frame really is better than Scrypted's
 *   tight bbox thumbnail; that is precisely why v0.3.118 demoted it.
 *
 * Pure and dependency-free so both orders are unit-testable.
 */

export type PosterSourceName = 'notificationImage' | 'posterBox' | 'subjectCrop' | 'fullFrameBuf' | 'none';

export interface PosterSourceInput<T = Buffer> {
    /** True for a Scrypted native Summary/Story digest. */
    isSummary?: boolean;
    posterBoxCropBuf?: T;
    subjectCropBuf?: T;
    fullFrameBuf?: T;
    /** Scrypted's own notification image — a composite for Stories. */
    notificationImageBuf?: T;
}

export interface PosterSourceResult<T = Buffer> {
    buf?: T;
    source: PosterSourceName;
}

export function selectPosterRawSource<T>(input: PosterSourceInput<T>): PosterSourceResult<T> {
    const { isSummary, posterBoxCropBuf, subjectCropBuf, fullFrameBuf, notificationImageBuf } = input;

    // A Story's composite summarises the whole span — never discard it in
    // favour of a single seeked instant.
    if (isSummary && notificationImageBuf !== undefined)
        return { buf: notificationImageBuf, source: 'notificationImage' };

    if (posterBoxCropBuf !== undefined) return { buf: posterBoxCropBuf, source: 'posterBox' };
    if (subjectCropBuf !== undefined) return { buf: subjectCropBuf, source: 'subjectCrop' };
    if (fullFrameBuf !== undefined) return { buf: fullFrameBuf, source: 'fullFrameBuf' };
    // Never-blank last resort for per-detection events (v0.3.167).
    if (notificationImageBuf !== undefined) return { buf: notificationImageBuf, source: 'notificationImage' };

    return { buf: undefined, source: 'none' };
}
