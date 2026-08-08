import {
    StoredNotification,
    DailyStats,
    CachedHighlight,
    NarrativeSegment,
    CachedSummary,
    FrozenSegment,
} from './types';
import { NotificationLog } from './notification-log';
import * as fsp from 'fs/promises';
import * as path from 'path';

export interface EmbeddingEntry {
    id: string;
    embedding: string;
    dimension: number;
}

/** The YYYY-MM-DD a UTC instant falls on, as read in `timeZone`. */
function localDateKey(instant: number, timeZone: string): string {
    return new Date(instant).toLocaleDateString('en-CA', { timeZone });
}

/**
 * The first instant belonging to the given YYYY-MM-DD in `timeZone`.
 *
 * Found by binary search for the boundary where the local calendar date first
 * reaches `dateKey`, rather than by computing an offset and subtracting it.
 * Offset arithmetic has no single correct form: where the DST change lands at
 * midnight, applying the offset taken at 00:00 UTC is right for America/Santiago
 * but wrong for Asia/Beirut, and applying the refined offset is the reverse.
 * Searching for the boundary is correct in both, and also returns 01:00 local on
 * spring-forward days where midnight does not exist at all.
 *
 * Bounds are +/-26h around the naive UTC date, comfortably outside the +/-14h
 * range of real zone offsets, so the invariant
 * `localDateKey(lo) < dateKey <= localDateKey(hi)` always holds. ~28 iterations.
 */
function zonedDayStartMs(dateKey: string, timeZone: string): number {
    const [y, m, d] = dateKey.split('-').map(Number);
    const approx = Date.UTC(y, m - 1, d);
    let lo = approx - 26 * 3600_000;
    let hi = approx + 26 * 3600_000;
    while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (localDateKey(mid, timeZone) < dateKey) lo = mid;
        else hi = mid;
    }
    return hi;
}

/**
 * Inclusive [start, end] of the calendar day containing `date`, in `timeZone`.
 * The end is derived from the NEXT day's midnight rather than by adding 24h,
 * so 23- and 25-hour DST days are covered exactly.
 */
export function dayBoundsMs(date: Date, timeZone?: string): { start: number; end: number } {
    if (!timeZone) {
        const start = new Date(date); start.setHours(0, 0, 0, 0);
        const end = new Date(date); end.setHours(23, 59, 59, 999);
        return { start: start.getTime(), end: end.getTime() };
    }
    const key = localDateKey(date.getTime(), timeZone);
    const start = zonedDayStartMs(key, timeZone);
    // End comes from the NEXT day's start, so 23- and 25-hour DST days are
    // exact rather than assumed to be 24h.
    const nextKey = localDateKey(start + 36 * 3600_000, timeZone);
    return { start, end: zonedDayStartMs(nextKey, timeZone) - 1 };
}

export class NotificationStore {
    private notifications: StoredNotification[] = [];
    private summaryCache: Map<string, CachedSummary> = new Map();
    private embeddings: Map<string, { embedding: string; dimension: number }> = new Map();
    private storage: any;
    private retentionDays = 3;
    private timezone: string | undefined;
    private maxPerDay = 2000;
    private getFilesPath?: () => Promise<string>;
    private notifLog?: NotificationLog<StoredNotification>;
    private embeddingLog?: NotificationLog<EmbeddingEntry>;
    private diskReady = false;
    private addListeners: Array<() => void> = [];

    onAdd(fn: () => void): () => void {
        this.addListeners.push(fn);
        return () => { this.addListeners = this.addListeners.filter(l => l !== fn); };
    }

    constructor(storage: any, getFilesPath?: () => Promise<string>) {
        this.storage = storage;
        this.getFilesPath = getFilesPath;
        this.load();
        this.loadSummaryCache();
        this.loadEmbeddings();
    }

    async initDiskStorage(): Promise<void> {
        if (!this.getFilesPath || this.diskReady) return;
        const filesPath = await this.getFilesPath();

        const notifPath = path.join(filesPath, 'notifications.jsonl');
        const embPath = path.join(filesPath, 'embeddings.jsonl');

        this.notifLog = new NotificationLog<StoredNotification>(notifPath);
        this.embeddingLog = new NotificationLog<EmbeddingEntry>(embPath);

        // Migrate or load notifications
        const notifExists = await fsp.access(notifPath).then(() => true, () => false);
        if (!notifExists && this.notifications.length > 0) {
            this.notifLog.compactSync(this.notifications);
            this.storage.removeItem('dailyBriefNotifications');
        } else if (notifExists) {
            const fromDisk = await this.notifLog.loadAll();
            for (const n of fromDisk) delete n.thumbnailB64;
            // Merge: keep any notifications added between constructor and init
            const diskIds = new Set(fromDisk.map(n => n.id));
            const pending = this.notifications.filter(n => !diskIds.has(n.id));
            this.notifications = fromDisk;
            for (const n of pending) {
                this.notifications.push(n);
                this.notifLog.appendSync(n);
            }
        }

        // Migrate or load embeddings
        const embExists = await fsp.access(embPath).then(() => true, () => false);
        if (!embExists && this.embeddings.size > 0) {
            const entries: EmbeddingEntry[] = Array.from(this.embeddings.entries())
                .map(([id, e]) => ({ id, ...e }));
            this.embeddingLog.compactSync(entries);
            this.storage.removeItem('dailyBriefEmbeddings');
        } else if (embExists) {
            const entries = await this.embeddingLog.loadAll();
            this.embeddings = new Map(
                entries.map(e => [e.id, { embedding: e.embedding, dimension: e.dimension }])
            );
        }

        this.diskReady = true;
        console.log(`[Daily Brief] Disk storage initialized: ${this.notifications.length} notifications, ${this.embeddings.size} embeddings`);
    }

    setRetentionDays(days: number) {
        this.retentionDays = isNaN(days) ? 3 : Math.max(1, Math.floor(days));
    }

    /**
     * The zone prune() buckets by for its per-day cap. Without it the cap uses
     * UTC calendar dates, which on a UTC server splits one local day across two
     * buckets and shares one bucket between two local days.
     */
    setTimezone(timezone: string | undefined) {
        this.timezone = timezone || undefined;
    }

    /** Per-day cap for prune(). Exposed so tests need not build 2000 records. */
    setMaxPerDay(max: number) {
        this.maxPerDay = Math.max(1, Math.floor(max));
    }

    // Immediately evict stale notifications (e.g. after reducing retentionDays)
    pruneNow() {
        this.prune();
        if (this.diskReady && this.notifLog) {
            this.notifLog.compactSync(this.notifications);
        } else {
            this.save();
        }
    }

    private load() {
        try {
            const data = this.storage.getItem('dailyBriefNotifications');
            if (data) {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    this.notifications = parsed;
                    for (const n of this.notifications) delete n.thumbnailB64;
                    this.prune();
                    console.log(`[Daily Brief] Loaded ${this.notifications.length} notifications`);
                } else {
                    console.error('[Daily Brief] Invalid data format, expected array');
                }
            }
        } catch (e) {
            console.error('[Daily Brief] Failed to load notifications:', e);
            // Don't wipe existing data on error - just leave notifications empty
        }
    }

    private save() {
        if (this.diskReady) return;
        try {
            this.storage.setItem('dailyBriefNotifications', JSON.stringify(
                this.notifications,
                (key, value) => key === 'thumbnailB64' ? undefined : value,
            ));
        } catch (e) {
            console.error('Failed to save notifications:', e);
        }
    }

    private loadSummaryCache() {
        try {
            const data = this.storage.getItem('dailyBriefSummaryCache');
            if (data) {
                const arr: CachedSummary[] = JSON.parse(data);
                this.summaryCache = new Map(arr.map(s => [s.date, s]));
                // Migrate pre-0.3.48 inline base64 thumbnails to poster markers
                let migrated = false;
                for (const summary of this.summaryCache.values()) {
                    for (const h of summary.highlights) {
                        if (h.thumbnail?.startsWith('data:')) {
                            h.thumbnail = 'poster';
                            migrated = true;
                        }
                    }
                }
                // Prune stale entries on load (saveSummaryCache prunes on save too)
                const maxAge = 7 * 24 * 60 * 60 * 1000;
                const cutoff = Date.now() - maxAge;
                for (const [key, summary] of this.summaryCache) {
                    if (summary.generatedAt < cutoff) {
                        this.summaryCache.delete(key);
                        migrated = true; // trigger save to persist the pruning
                    }
                }
                if (migrated) this.saveSummaryCache();
            }
        } catch (e) {
            console.error('Failed to load summary cache:', e);
        }
    }

    private saveSummaryCache() {
        try {
            const arr = Array.from(this.summaryCache.values());
            // Keep only last 7 days of summaries
            const maxAge = 7 * 24 * 60 * 60 * 1000;
            const cutoff = Date.now() - maxAge;
            const filtered = arr.filter(s => s.generatedAt > cutoff);
            this.storage.setItem('dailyBriefSummaryCache', JSON.stringify(filtered));
        } catch (e) {
            console.error('Failed to save summary cache:', e);
        }
    }

    getCachedSummary(date: Date, timezone?: string): CachedSummary | undefined {
        // Use timezone-aware date key to avoid UTC conversion issues
        const dateKey = timezone
            ? date.toLocaleDateString('en-CA', { timeZone: timezone })
            : date.toISOString().split('T')[0];
        return this.summaryCache.get(dateKey);
    }

    setCachedSummary(
        date: Date,
        summary: string,
        notificationCount: number,
        highlights: CachedHighlight[],
        windowStart: number,
        windowEnd: number,
        timezone?: string,
        overview?: string,
        narrative?: NarrativeSegment[],
        frozenSegments?: FrozenSegment[]
    ) {
        // Use timezone-aware date key to avoid UTC conversion issues
        const dateKey = timezone
            ? date.toLocaleDateString('en-CA', { timeZone: timezone })
            : date.toISOString().split('T')[0];
        this.summaryCache.set(dateKey, {
            date: dateKey,
            summary,
            overview,
            narrative,
            generatedAt: Date.now(),
            notificationCount,
            highlights,
            windowStart,
            windowEnd,
            frozenSegments
        });
        this.saveSummaryCache();
    }

    clearCachedSummary(date: Date, timezone?: string) {
        const dateKey = timezone
            ? date.toLocaleDateString('en-CA', { timeZone: timezone })
            : date.toISOString().split('T')[0];
        this.summaryCache.delete(dateKey);
        this.saveSummaryCache();
    }

    private prune() {
        const now = Date.now();
        const maxAge = this.retentionDays * 24 * 60 * 60 * 1000;

        // Step 1: Remove items older than retention window
        this.notifications = this.notifications.filter(n => now - n.timestamp < maxAge);

        // Step 2: Group by day and keep only maxPerDay per day (newest first)
        const byDay = new Map<string, StoredNotification[]>();
        for (const n of this.notifications) {
            // Bucket by the user's calendar day. UTC dates split one local day
            // in two on a UTC server, so the cap evicted the wrong records.
            const day = this.timezone
                ? localDateKey(n.timestamp, this.timezone)
                : new Date(n.timestamp).toISOString().split('T')[0];
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day)!.push(n);
        }

        // Keep only newest 500 per day
        this.notifications = [];
        for (const [, dayNotifications] of byDay) {
            dayNotifications.sort((a, b) => b.timestamp - a.timestamp);
            this.notifications.push(...dayNotifications.slice(0, this.maxPerDay));
        }

        // Sort final result by timestamp descending
        this.notifications.sort((a, b) => b.timestamp - a.timestamp);

        // Sync embeddings with remaining notifications
        this.pruneEmbeddings();
    }

    add(notification: StoredNotification) {
        // Prevent duplicates - same detection can trigger multiple notifiers
        if (this.notifications.some(n => n.id === notification.id)) {
            return;
        }
        // Strip thumbnailB64 from memory — posters on disk are the source of truth
        if (notification.thumbnailB64) {
            delete notification.thumbnailB64;
        }
        this.notifications.push(notification);
        this.prune();
        // Only persist if notification survived pruning
        const survived = this.notifications.some(n => n.id === notification.id);
        if (this.diskReady && this.notifLog) {
            if (survived) this.notifLog.appendSync(notification);
        } else {
            this.save();
        }
        if (survived) this.addListeners.forEach(fn => fn());
    }

    // Clear all stored notifications (for manual cleanup)
    clear() {
        const count = this.notifications.length;
        this.notifications = [];
        if (this.diskReady && this.notifLog) {
            this.notifLog.compactSync([]);
        } else {
            this.save();
        }
        console.log(`[Daily Brief] Cleared ${count} notifications`);
    }

    /**
     * Notifications belonging to the calendar day that contains `date`, as
     * measured in `timezone`.
     *
     * Scrypted runs UTC, so `setHours(0,0,0,0)` — the old implementation —
     * started the day at 00:00 UTC, which is the previous afternoon or evening
     * for anyone west of Greenwich. That both over-counted (the whole previous
     * evening landed in "today") and under-counted (this evening's events fell
     * into "tomorrow" once UTC rolled over). Every other day boundary in the
     * plugin is timezone-aware; this one is now too.
     *
     * Omitting `timezone` keeps the old server-local behavior, for callers that
     * genuinely have no user timezone to honor.
     */
    getForDate(date: Date, timezone?: string): StoredNotification[] {
        const { start, end } = dayBoundsMs(date, timezone);
        return this.notifications.filter(n =>
            n.timestamp >= start && n.timestamp <= end
        ).sort((a, b) => b.timestamp - a.timestamp);
    }

    // Get notifications within a specific time range (for 24hr rolling window)
    getForTimeRange(startTime: number, endTime: number): StoredNotification[] {
        return this.notifications.filter(n =>
            n.timestamp >= startTime && n.timestamp <= endTime
        ).sort((a, b) => b.timestamp - a.timestamp);
    }

    getStats(date: Date, timezone?: string): DailyStats {
        const notifications = this.getForDate(date, timezone);
        const stats: DailyStats = {
            total: notifications.length,
            byType: {},
            byCamera: {},
            byHour: {},
            names: []
        };

        const nameSet = new Set<string>();

        for (const n of notifications) {
            // By type
            stats.byType[n.detectionType] = (stats.byType[n.detectionType] || 0) + 1;

            // By camera
            stats.byCamera[n.cameraName] = (stats.byCamera[n.cameraName] || 0) + 1;

            // By hour
            const hour = new Date(n.timestamp).getHours();
            stats.byHour[hour] = (stats.byHour[hour] || 0) + 1;

            // Names
            for (const name of n.names) {
                nameSet.add(name);
            }
        }

        stats.names = Array.from(nameSet);
        return stats;
    }

    getAll(): StoredNotification[] {
        return this.notifications;
    }

    getAllIds(): Set<string> {
        return new Set(this.notifications.map(n => n.id));
    }

    getById(id: string): StoredNotification | undefined {
        return this.notifications.find(n => n.id === id);
    }

    /**
     * One-shot migration: strip the v0.3.83-v0.3.116 grouping fields
     * (groupId, isGroupPrimary, llmGroupTitle, llmGroupSubtitle, llmGroupBody)
     * from all in-memory records and rewrite the JSONL log. Called once at
     * plugin startup after the stories-grouping replacement landed; safe to
     * run multiple times (idempotent).
     *
     * Returns the number of records modified (0 if no records had any of
     * the legacy fields).
     */
    stripLegacyGroupFields(): number {
        let modified = 0;
        for (const n of this.notifications) {
            const r = n as any;
            if (r.groupId !== undefined || r.isGroupPrimary !== undefined
                || r.llmGroupTitle !== undefined || r.llmGroupSubtitle !== undefined
                || r.llmGroupBody !== undefined) {
                delete r.groupId;
                delete r.isGroupPrimary;
                delete r.llmGroupTitle;
                delete r.llmGroupSubtitle;
                delete r.llmGroupBody;
                modified++;
            }
        }
        if (modified > 0) {
            if (this.diskReady && this.notifLog) {
                this.notifLog.compactSync(this.notifications);
            } else {
                this.save();
            }
        }
        return modified;
    }

    // Mark a notification as having a poster on disk (for NVR backfill)
    markHasPoster(id: string) {
        const n = this.notifications.find(n => n.id === id);
        if (n && !n.hasPoster) {
            n.hasPoster = true;
            if (this.diskReady && this.notifLog) {
                this.notifLog.appendSync(n);
            } else {
                this.save();
            }
        }
    }

    // ---- Embedding storage (separate from notifications to avoid serialization bloat) ----

    private loadEmbeddings() {
        try {
            const data = this.storage.getItem('dailyBriefEmbeddings');
            if (data) {
                const arr: [string, { embedding: string; dimension: number }][] = JSON.parse(data);
                this.embeddings = new Map(arr);
                console.log(`[Daily Brief] Loaded ${this.embeddings.size} embeddings`);
            }
        } catch (e) {
            console.error('[Daily Brief] Failed to load embeddings:', e);
        }
    }

    private saveEmbeddings() {
        if (this.diskReady) return;
        try {
            const arr = Array.from(this.embeddings.entries());
            this.storage.setItem('dailyBriefEmbeddings', JSON.stringify(arr));
        } catch (e) {
            console.error('[Daily Brief] Failed to save embeddings:', e);
        }
    }

    private pruneEmbeddings() {
        // Remove embeddings for notifications that no longer exist
        const notifIds = new Set(this.notifications.map(n => n.id));
        let pruned = 0;
        for (const id of this.embeddings.keys()) {
            if (!notifIds.has(id)) {
                this.embeddings.delete(id);
                pruned++;
            }
        }
        if (pruned > 0) {
            if (this.diskReady && this.embeddingLog) {
                const entries: EmbeddingEntry[] = Array.from(this.embeddings.entries())
                    .map(([id, e]) => ({ id, ...e }));
                this.embeddingLog.compactSync(entries);
            } else {
                this.saveEmbeddings();
            }
        }
    }

    addEmbedding(id: string, embedding: string, dimension: number) {
        this.embeddings.set(id, { embedding, dimension });
        if (this.diskReady && this.embeddingLog) {
            this.embeddingLog.appendSync({ id, embedding, dimension });
        } else {
            this.saveEmbeddings();
        }
    }

    getEmbedding(id: string): { embedding: string; dimension: number } | undefined {
        return this.embeddings.get(id);
    }

    getAllEmbeddings(): Map<string, { embedding: string; dimension: number }> {
        return this.embeddings;
    }
}
