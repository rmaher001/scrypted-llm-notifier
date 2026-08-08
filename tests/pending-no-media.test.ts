/**
 * PendingNoMediaBuffer — holds text-only notifications briefly so a
 * subsequent notification for the same event (usually with an image)
 * can supersede and enrich it.
 *
 * Motivating case: Scrypted native macOS app delivers camera events
 * as two messages to a single notifier — a lightweight text-only
 * preview (~4s earlier), then a follow-up with the camera snapshot.
 * Before this buffer, the preview was delivered un-enriched and the
 * user saw "Person Detected. Tap to view." while iPhone got the
 * enriched "Person on sidewalk / A person in dark clothing...".
 */

import { PendingNoMediaBuffer } from '../src/pending-no-media';

describe('PendingNoMediaBuffer', () => {
    let buffer: PendingNoMediaBuffer;

    beforeEach(() => {
        jest.useFakeTimers();
        buffer = new PendingNoMediaBuffer(1000);
    });

    afterEach(() => {
        buffer.destroy();
        jest.useRealTimers();
    });

    it('fires the delivery function after the timeout elapses', () => {
        const deliver = jest.fn();
        buffer.schedule('Sidewalk Camera|Person Detected', deliver);

        expect(deliver).not.toHaveBeenCalled();
        jest.advanceTimersByTime(999);
        expect(deliver).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(deliver).toHaveBeenCalledTimes(1);
    });

    it('cancel() before timeout prevents delivery', () => {
        const deliver = jest.fn();
        buffer.schedule('Sidewalk Camera|Person Detected', deliver);

        const cancelled = buffer.cancel('Sidewalk Camera|Person Detected');
        expect(cancelled).toBe(true);

        jest.advanceTimersByTime(2000);
        expect(deliver).not.toHaveBeenCalled();
    });

    it('cancel() on an unknown key returns false and is a no-op', () => {
        expect(buffer.cancel('unknown')).toBe(false);
    });

    it('multiple schedules under the same key each fire independently on their own timeouts', () => {
        // Queue semantics — re-scheduling does NOT replace. Two previews
        // arriving close together for the same camera are two distinct
        // events and both must be preserved if no follow-ups cancel them.
        const first = jest.fn();
        const second = jest.fn();

        buffer.schedule('Sidewalk Camera|Person Detected', first);
        jest.advanceTimersByTime(500);
        buffer.schedule('Sidewalk Camera|Person Detected', second);

        // At t=500ms total elapsed: first has 500ms left, second has 1000ms.
        jest.advanceTimersByTime(500);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();

        jest.advanceTimersByTime(500);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('cancel() consumes the OLDEST pending timer first (FIFO matching)', () => {
        // Pairing invariant: preview_A → preview_B → followup_A → followup_B.
        // cancel() on followup_A must remove preview_A (oldest), leaving
        // preview_B to either fire or be cancelled by followup_B.
        const previewA = jest.fn();
        const previewB = jest.fn();

        buffer.schedule('camera|person', previewA);
        buffer.schedule('camera|person', previewB);
        expect(buffer.size).toBe(2);

        // Cancel once — should kill previewA (oldest), leaving previewB pending.
        expect(buffer.cancel('camera|person')).toBe(true);
        expect(buffer.size).toBe(1);

        jest.advanceTimersByTime(1000);
        expect(previewA).not.toHaveBeenCalled();
        expect(previewB).toHaveBeenCalledTimes(1);
    });

    it('cancel() returns false once the queue for a key is exhausted', () => {
        const fn = jest.fn();
        buffer.schedule('k', fn);
        expect(buffer.cancel('k')).toBe(true);
        expect(buffer.cancel('k')).toBe(false);
    });

    it('different keys fire independently', () => {
        const a = jest.fn();
        const b = jest.fn();

        buffer.schedule('Sidewalk Camera|Person Detected', a);
        buffer.schedule('Garage Street Camera|Vehicle Detected', b);

        jest.advanceTimersByTime(1000);

        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('deletes the entry from the map once the timer fires', () => {
        const deliver = jest.fn();
        buffer.schedule('key', deliver);

        expect(buffer.size).toBe(1);
        jest.advanceTimersByTime(1000);
        expect(buffer.size).toBe(0);
    });

    it('destroy() cancels all pending timers', () => {
        const a = jest.fn();
        const b = jest.fn();

        buffer.schedule('a', a);
        buffer.schedule('b', b);
        expect(buffer.size).toBe(2);

        buffer.destroy();
        expect(buffer.size).toBe(0);

        jest.advanceTimersByTime(2000);
        expect(a).not.toHaveBeenCalled();
        expect(b).not.toHaveBeenCalled();
    });

    it('defaults to a sensible timeout when none is provided', () => {
        const defaultBuffer = new PendingNoMediaBuffer();
        const deliver = jest.fn();
        defaultBuffer.schedule('k', deliver);

        // Anything in the 2-30s range is defensible; this test just asserts
        // the buffer uses SOME default > 0 and fires once it elapses.
        jest.advanceTimersByTime(30000);
        expect(deliver).toHaveBeenCalledTimes(1);
        defaultBuffer.destroy();
    });
});

// Integration pins: make sure llm-notifier.ts uses the buffer where it
// should, so a future refactor can't silently regress the fix.
describe('PendingNoMediaBuffer integration pins (src/llm-notifier.ts)', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(
        path.resolve(__dirname, '../src/llm-notifier.ts'),
        'utf-8',
    );

    it('imports PendingNoMediaBuffer from its module', () => {
        expect(src).toMatch(/import\s+\{\s*PendingNoMediaBuffer\s*\}\s+from\s+['"]\.\/pending-no-media['"]/);
    });

    it('LLMNotifier has a pendingNoMedia field', () => {
        expect(src).toMatch(/private\s+pendingNoMedia\s*=\s*new\s+PendingNoMediaBuffer/);
    });

    it('no-media branch schedules delivery instead of invoking mixinDevice.sendNotification directly', () => {
        // The deferred delivery must route through the buffer; a bare call
        // to this.mixinDevice.sendNotification(...) in the no-media branch
        // would bypass it.
        expect(src).toMatch(/pendingNoMedia\.schedule\s*\(/);
    });

    it('with-media branch cancels any pending no-media for the same key', () => {
        expect(src).toMatch(/pendingNoMedia\.cancel\s*\(/);
    });

    it('release() destroys the pending buffer to avoid timer leaks', () => {
        expect(src).toMatch(/pendingNoMedia\.destroy\s*\(/);
    });

    // Counter semantics (reviewer feedback on v0.3.79):
    // - withoutSnapshot must only increment when a deferred delivery actually
    //   fires (not when we merely accept the preview into the buffer).
    // - A new "superseded" counter records how often cancel() matched and
    //   a preview was replaced by an image-bearing follow-up.

    it('notificationStats declares a superseded counter', () => {
        expect(src).toMatch(/notificationStats[\s\S]{0,200}superseded\s*:\s*0/);
    });

    it('withoutSnapshot increments inside the scheduled deliver closure, not at receive time', () => {
        // The pending-schedule block should contain the increment; the outer
        // no-media branch before .schedule(...) should not.
        const scheduleBlockMatch = src.match(
            /pendingNoMedia\.schedule\s*\([^,]+,\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/,
        );
        expect(scheduleBlockMatch).not.toBeNull();
        expect(scheduleBlockMatch![1]).toMatch(/withoutSnapshot\s*\+\+/);
    });

    it('superseded increments inside the cancel() success branch', () => {
        // Pattern: `if (this.pendingNoMedia.cancel(...)) { ... superseded++ ... }`
        expect(src).toMatch(/pendingNoMedia\.cancel\s*\([\s\S]*?\)\s*\)\s*\{[\s\S]{0,300}superseded\s*\+\+/);
    });

    it('release() is synchronous (matches MixinDeviceBase signature)', () => {
        // MixinDeviceBase declares `release(): void`. Our override must not be
        // `async release()` or it becomes `Promise<void>` and breaks the
        // contract. Also the super call should be direct, not `super.release?.()`.
        expect(src).toMatch(/\n\s*release\s*\(\s*\)\s*:\s*void\s*\{/);
        expect(src).not.toMatch(/super\.release\?\./);
    });
});
