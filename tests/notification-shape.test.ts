/**
 * summarizeNotificationShape — a DIAGNOSTIC-ONLY probe (v0.3.168).
 *
 * Two open questions it exists to answer, both raised 2026-07-25:
 *
 *  1. Which field actually carries the seek time? Our own v0.3.153 capture of a
 *     real Scrypted recordedEvent documented "the seek time is data.timestamp
 *     (NOT details.eventTime), and details carries ONLY eventInterface" — yet
 *     llm-notifier.ts seeks by details.eventTime and silently falls back to
 *     Date.now() when it is absent. If details.eventTime is undefined in the
 *     wild, every poster/clip has been seeking on notification-handling time.
 *
 *  2. How do we recognise a NATIVE Scrypted Story notification? The old
 *     isStoryNotification() keyed on options.data.storyId, but OUR OWN
 *     story-notifier set that field (story-notifier.ts:163) — it was a
 *     self-detection loop guard, so it says nothing about native Stories. The
 *     NVR plugin that emits them is closed-source and the SDK types carry no
 *     story surface, so the discriminator has to be found empirically.
 *
 * Pure: takes the raw options + an injected `now`, returns a compact JSON-able
 * record. No SDK imports, no side effects.
 */

import { summarizeNotificationShape } from '../src/notification-shape';

const NOW = 1_700_000_100_000;

describe('summarizeNotificationShape', () => {
    it('reports the top-level option keys and data keys so an unknown story marker is visible', () => {
        const s = summarizeNotificationShape({
            body: 'x',
            data: { storyId: 'abc', hash: '#/timeline/1' },
        }, NOW);

        expect(s.optionKeys).toEqual(['body', 'data']);
        expect(s.dataKeys).toEqual(['storyId', 'hash']);
    });

    it('captures BOTH candidate seek fields and their age, so we can see which is real', () => {
        const s = summarizeNotificationShape({
            recordedEvent: {
                id: 'cam-1',
                data: { timestamp: NOW - 4000, detectionId: 'det-1' },
                details: { eventInterface: 'ObjectDetector', eventTime: NOW - 500 },
            },
        }, NOW);

        expect(s.dataTimestamp).toBe(NOW - 4000);
        expect(s.detailsEventTime).toBe(NOW - 500);
        expect(s.dataTimestampAgeMs).toBe(4000);
        expect(s.detailsEventTimeAgeMs).toBe(500);
    });

    it('flags when details.eventTime is ABSENT — the case that silently falls back to Date.now()', () => {
        // This is the shape our v0.3.153 diagnostic actually captured in the
        // wild: details carries ONLY eventInterface.
        const s = summarizeNotificationShape({
            recordedEvent: {
                id: 'cam-1',
                data: { timestamp: NOW - 3000, detectionId: 'det-1' },
                details: { eventInterface: 'ObjectDetector' },
            },
        }, NOW);

        expect(s.detailsEventTime).toBeUndefined();
        expect(s.detailsEventTimeAgeMs).toBeUndefined();
        expect(s.seekFieldPresent).toBe('data.timestamp only');
        expect(s.reDetailsKeys).toEqual(['eventInterface']);
    });

    it('reports which seek fields exist for each combination', () => {
        const both = summarizeNotificationShape({
            recordedEvent: { data: { timestamp: 1 }, details: { eventTime: 2 } },
        }, NOW);
        expect(both.seekFieldPresent).toBe('both');

        const detailsOnly = summarizeNotificationShape({
            recordedEvent: { data: {}, details: { eventTime: 2 } },
        }, NOW);
        expect(detailsOnly.seekFieldPresent).toBe('details.eventTime only');

        const neither = summarizeNotificationShape({
            recordedEvent: { data: {}, details: {} },
        }, NOW);
        expect(neither.seekFieldPresent).toBe('NEITHER (falls back to Date.now)');
    });

    it('records detectionId presence and the recordedEvent sub-shape', () => {
        const s = summarizeNotificationShape({
            recordedEvent: {
                id: 'cam-9',
                data: { timestamp: 5, detectionId: 'det-9', detections: [{ className: 'person' }] },
                details: { eventInterface: 'ObjectDetector' },
            },
        }, NOW);

        expect(s.hasRecordedEvent).toBe(true);
        expect(s.hasDetectionId).toBe(true);
        expect(s.detectionCount).toBe(1);
        expect(s.reTopLevelId).toBe('cam-9');
        expect(s.reDataKeys).toEqual(['timestamp', 'detectionId', 'detections']);
    });

    it('survives a notification with no recordedEvent at all (the suspected Story shape)', () => {
        const s = summarizeNotificationShape({ body: 'Story: activity in the kitchen', data: {} }, NOW);

        expect(s.hasRecordedEvent).toBe(false);
        expect(s.hasDetectionId).toBe(false);
        expect(s.seekFieldPresent).toBe('NEITHER (falls back to Date.now)');
        expect(s.dataTimestamp).toBeUndefined();
    });

    it('never throws on undefined/garbage input', () => {
        expect(() => summarizeNotificationShape(undefined, NOW)).not.toThrow();
        expect(() => summarizeNotificationShape(null, NOW)).not.toThrow();
        expect(summarizeNotificationShape(undefined, NOW).hasRecordedEvent).toBe(false);
        expect(summarizeNotificationShape('a string' as any, NOW).optionKeys).toEqual([]);
    });
});
