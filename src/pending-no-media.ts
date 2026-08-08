// ============================================================================
// PendingNoMediaBuffer — defers delivery of text-only (no-media) notifications
// for a short window so a subsequent notification with an image for the same
// event can supersede and enrich it.
//
// Scrypted's native macOS app delivers some camera events as two messages to
// one notifier: a lightweight preview (no snapshot) followed ~4s later by
// the full message with a snapshot. Without this buffer, the preview gets
// delivered un-enriched while the enriched follow-up is also delivered —
// two notifications per event, the first unhelpful.
//
// Design notes:
// - Per-key queue semantics (FIFO cancel). Multiple previews for the same
//   (title, subtitle) key enqueue independently; cancel() consumes the
//   OLDEST. This pairs preview_n with follow-up_n for bursts on the same
//   camera/detectionClass without losing events.
// - Pure, no Scrypted imports, no side effects beyond the registered
//   callback. Safe to unit test with fake timers.
// ============================================================================

const DEFAULT_TIMEOUT_MS = 8_000;

export class PendingNoMediaBuffer {
    // Per-key queue of active timers, oldest first. Entries are removed
    // either on cancel() (shift) or when the timer fires (removeTimer).
    private pending = new Map<string, NodeJS.Timeout[]>();
    private readonly timeoutMs: number;

    constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
        this.timeoutMs = timeoutMs;
    }

    /**
     * Defer deliverFn by timeoutMs. Multiple schedules for the same key
     * queue independently — cancel() consumes the oldest first so a burst
     * of N previews followed by N matching with-media follow-ups pair
     * correctly.
     */
    schedule(key: string, deliverFn: () => void): void {
        const timer: NodeJS.Timeout = setTimeout(() => {
            this.removeTimer(key, timer);
            try { deliverFn(); } catch { /* swallow — never throw from timer */ }
        }, this.timeoutMs);

        const queue = this.pending.get(key);
        if (queue) queue.push(timer);
        else this.pending.set(key, [timer]);
    }

    /**
     * Cancel the OLDEST pending delivery for key, if any. Returns true if
     * a timer was actually cancelled (useful for a "superseded" metric),
     * false if no pending entry existed.
     */
    cancel(key: string): boolean {
        const queue = this.pending.get(key);
        if (!queue || queue.length === 0) return false;
        const timer = queue.shift()!;
        clearTimeout(timer);
        if (queue.length === 0) this.pending.delete(key);
        return true;
    }

    private removeTimer(key: string, timer: NodeJS.Timeout): void {
        const queue = this.pending.get(key);
        if (!queue) return;
        const idx = queue.indexOf(timer);
        if (idx >= 0) queue.splice(idx, 1);
        if (queue.length === 0) this.pending.delete(key);
    }

    get size(): number {
        let n = 0;
        for (const queue of this.pending.values()) n += queue.length;
        return n;
    }

    /** Cancel all pending timers. Call on release/shutdown. */
    destroy(): void {
        for (const queue of this.pending.values()) {
            for (const t of queue) clearTimeout(t);
        }
        this.pending.clear();
    }
}
