/**
 * extractHashTime — pull the `time=` parameter out of a Scrypted notification's
 * data.hash deep link.
 *
 * WHY (2026-07-25, live bug): a Story/Summary notification's
 * recordedEvent.data.timestamp is the DELIVERY time, not the story's time.
 * Observed: a card stamped 11:27 AM whose clip played 11:27:41-11:28:06 and
 * whose NVR link landed at 11:28:03 — while the actual Story marker in NVR was
 * 11:12 AM (1m44s) and its thumbnail matched the notification's description.
 * ~16 minutes late, so neither the clip nor the NVR view contained the subject.
 * Four sibling cards were all stamped 11:28 across three different cameras,
 * i.e. a batch delivered at once.
 *
 * Scrypted's own notifications carry data.hash in the form
 *     #/timeline/<cameraId>?time=<ms>&from=notification&serverId=<id>
 * (format confirmed from the pre-v0.3.165 story-deeplink module). That `time`
 * is Scrypted's OWN seek target, so it is the candidate for the story's real
 * instant. This extractor is DIAGNOSTIC-ONLY for now: it feeds the [Shape]
 * probe so live traffic can prove whether hash time == story time BEFORE any
 * seek behavior changes.
 */

import { extractHashTime } from '../src/seek-time';

describe('extractHashTime', () => {
    // Fixtures are SYNTHETIC on purpose. This package is published publicly, so
    // no real camera id, serverId or captured timestamp may appear here.
    const CAM = 'cam-0';
    const SERVER = 'deadbeef00000000';

    it('extracts the time parameter from a Scrypted deep-link hash', () => {
        const hash = `#/timeline/${CAM}?time=1700000000000&from=notification&serverId=${SERVER}`;
        expect(extractHashTime(hash)).toBe(1700000000000);
    });

    it('works regardless of parameter order', () => {
        expect(extractHashTime(`#/timeline/${CAM}?from=notification&time=1700000000000`)).toBe(1700000000000);
    });

    it('does not confuse another parameter that merely ends in "time"', () => {
        // e.g. a future &endTime= or &startTime= must not be mistaken for time=
        expect(extractHashTime(`#/timeline/${CAM}?endTime=1700000000000`)).toBeUndefined();
        expect(extractHashTime(`#/timeline/${CAM}?startTime=999&time=1700000000000`)).toBe(1700000000000);
    });

    it('rejects a non-numeric or non-positive time rather than returning garbage', () => {
        expect(extractHashTime(`#/timeline/${CAM}?time=abc`)).toBeUndefined();
        expect(extractHashTime(`#/timeline/${CAM}?time=0`)).toBeUndefined();
        expect(extractHashTime(`#/timeline/${CAM}?time=-5`)).toBeUndefined();
        expect(extractHashTime(`#/timeline/${CAM}?time=`)).toBeUndefined();
    });

    it('returns undefined when there is no time parameter or no hash at all', () => {
        expect(extractHashTime(`#/timeline/${CAM}?from=notification`)).toBeUndefined();
        expect(extractHashTime('')).toBeUndefined();
        expect(extractHashTime(undefined)).toBeUndefined();
        expect(extractHashTime(null)).toBeUndefined();
        expect(extractHashTime(12345 as any)).toBeUndefined();
    });
});
