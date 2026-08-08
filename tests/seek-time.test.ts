/**
 * resolveSeekTimestamp / isSummaryNotification — v0.3.169.
 *
 * EVIDENCE (51 [Shape] samples from production, 2026-07-25):
 *
 *  - `recordedEvent.data.timestamp` was a finite number in 51/51 samples.
 *  - `recordedEvent.details.eventTime` was PRESENT as a key in 51/51 samples
 *    (reDetailsKeys = eventInterface, eventId, eventTime) but was NOT a finite
 *    number in any of them — seekFieldPresent came back 'data.timestamp only'
 *    every time. The SDK declares `eventTime: number` (types.input.ts:88), so
 *    the runtime value disagrees with the type.
 *
 *    That matters because the old call site did:
 *        (re?.details?.eventTime as number) ?? detectionEpoch
 *    `as number` is a compile-time cast with NO runtime effect and `??` only
 *    catches null/undefined — so a present-but-non-numeric eventTime was passed
 *    straight into the NVR seek instead of falling back. Hence: validate the
 *    NUMBER, never trust the declared type.
 *
 *  - Two notification shapes were observed. Per-detection notifications carry
 *    options.tag + data.actionUrl + data.snoozeId and their data.timestamp is
 *    sub-second fresh (median 798 ms). SUMMARY notifications carry none of
 *    those and their data.timestamp is 93s-300s old (median 130 s). Summaries
 *    are Scrypted's native digest over a span of activity; the removed
 *    isStoryNotification() keyed on data.storyId, which our OWN dispatcher set,
 *    so it never matched these.
 */

import { resolveSeekTimestamp, isSummaryNotification } from '../src/seek-time';

const EPOCH = 1_700_000_000_000;

describe('resolveSeekTimestamp', () => {
    it('prefers data.timestamp — the only field observed to be a real number in production', () => {
        const r = resolveSeekTimestamp({
            data: { timestamp: EPOCH - 800 },
            details: { eventInterface: 'ObjectDetector', eventId: 'e1', eventTime: EPOCH - 5 },
        }, EPOCH);

        expect(r.timestamp).toBe(EPOCH - 800);
        expect(r.source).toBe('data.timestamp');
    });

    it('IGNORES a present-but-non-numeric details.eventTime instead of passing it to the seek', () => {
        // The exact production case: the key exists, the value is not a number.
        // The old `as number` cast let this through; it must not anymore.
        for (const bad of ['2026-07-25T05:20:32Z', new Date(EPOCH), {}, [], NaN, Infinity, null]) {
            const r = resolveSeekTimestamp({ data: {}, details: { eventTime: bad } }, EPOCH);
            expect(r.timestamp).toBe(EPOCH);
            expect(r.source).toBe('fallback:now');
        }
    });

    it('falls back to details.eventTime ONLY when it is a finite number and data.timestamp is not', () => {
        const r = resolveSeekTimestamp({
            data: {},
            details: { eventTime: EPOCH - 1234 },
        }, EPOCH);

        expect(r.timestamp).toBe(EPOCH - 1234);
        expect(r.source).toBe('details.eventTime');
    });

    it('rejects a non-numeric data.timestamp and moves down the chain', () => {
        const r = resolveSeekTimestamp({
            data: { timestamp: '1700000000000' },
            details: { eventTime: EPOCH - 50 },
        }, EPOCH);

        expect(r.timestamp).toBe(EPOCH - 50);
        expect(r.source).toBe('details.eventTime');
    });

    it('falls back to the supplied epoch when there is no usable timestamp anywhere', () => {
        expect(resolveSeekTimestamp(undefined, EPOCH)).toEqual({ timestamp: EPOCH, source: 'fallback:now' });
        expect(resolveSeekTimestamp(null, EPOCH)).toEqual({ timestamp: EPOCH, source: 'fallback:now' });
        expect(resolveSeekTimestamp({}, EPOCH)).toEqual({ timestamp: EPOCH, source: 'fallback:now' });
    });

    it('rejects a non-positive timestamp (0 / negative are not valid epochs)', () => {
        expect(resolveSeekTimestamp({ data: { timestamp: 0 } }, EPOCH).source).toBe('fallback:now');
        expect(resolveSeekTimestamp({ data: { timestamp: -5 } }, EPOCH).source).toBe('fallback:now');
    });
});

describe('both seek call sites stay wired to the one resolver', () => {
    // The poster image and the notification click-through deep link MUST land
    // on the same instant. That currently holds because both sites call
    // resolveSeekTimestamp on the same unmutated options.recordedEvent — an
    // invariant that was true only by inspection until this test. A future edit
    // that reintroduces a raw eventTime read, or reassigns options.recordedEvent
    // between the two sites, would silently desync poster from deep link.
    const fsp = require('fs/promises');
    const path = require('path');
    let src: string;

    beforeAll(async () => {
        src = await fsp.readFile(path.resolve(__dirname, '../src/llm-notifier.ts'), 'utf-8');
    });

    it('resolves the seek time via resolveSeekTimestamp at BOTH sites', () => {
        const calls = src.match(/resolveSeekTimestamp\s*\(/g) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it('never reads details.eventTime directly for a seek (the `as number` trap)', () => {
        expect(src).not.toMatch(/details\?\.\s*eventTime\s+as\s+number/);
        expect(src).not.toMatch(/eventTime\s+as\s+number\s*\)\s*\?\?/);
    });

    it('never reassigns options.recordedEvent, so both sites read the same object', () => {
        // Mutating options.data is fine (the click payload does it); swapping
        // recordedEvent out from under the second site is not.
        expect(src).not.toMatch(/options\s*(as any)?\s*\)?\.recordedEvent\s*=/);
    });

    it('yields an identical instant when both sites resolve the same recordedEvent', () => {
        const re = { data: { timestamp: EPOCH - 800 }, details: { eventTime: 'not-a-number' } };
        expect(resolveSeekTimestamp(re, EPOCH)).toEqual(resolveSeekTimestamp(re, EPOCH));
    });
});

describe('isSummaryNotification', () => {
    it('identifies a Summary by the ABSENCE of the per-detection markers', () => {
        // Observed Summary shape: dataKeys = localAddresses, hash, ha
        const summary = {
            subtitle: 's', body: 'b', bodyWithSubtitle: 'bs', actions: [], data: {
                localAddresses: [], hash: '#/x', ha: {},
            }, recordedEvent: {},
        };
        expect(isSummaryNotification(summary)).toBe(true);
    });

    it('does NOT flag a per-detection notification (has tag + actionUrl + snoozeId)', () => {
        // Observed per-detection shape.
        const perEvent = {
            tag: 'cam-1', subtitle: 's', body: 'b', bodyWithSubtitle: 'bs', actions: [],
            data: { localAddresses: [], hash: '#/x', ha: {}, actionUrl: 'u', snoozeId: 'z' },
            recordedEvent: {}, critical: false,
        };
        expect(isSummaryNotification(perEvent)).toBe(false);
    });

    it('treats any single per-detection marker as enough to NOT be a summary', () => {
        expect(isSummaryNotification({ data: { snoozeId: 'z' } })).toBe(false);
        expect(isSummaryNotification({ data: { actionUrl: 'u' } })).toBe(false);
        expect(isSummaryNotification({ tag: 't', data: {} })).toBe(false);
    });

    it('never throws on undefined/garbage', () => {
        expect(() => isSummaryNotification(undefined)).not.toThrow();
        expect(() => isSummaryNotification(null)).not.toThrow();
        expect(isSummaryNotification({})).toBe(true);
    });
});
