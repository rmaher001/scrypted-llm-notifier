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

export class NotificationStore {
    private notifications: StoredNotification[] = [];
    private summaryCache: Map<string, CachedSummary> = new Map();
    private embeddings: Map<string, { embedding: string; dimension: number }> = new Map();
    private storage: any;
    private retentionDays = 3;
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
        const maxPerDay = 2000;

        // Step 1: Remove items older than retention window
        this.notifications = this.notifications.filter(n => now - n.timestamp < maxAge);

        // Step 2: Group by day and keep only maxPerDay per day (newest first)
        const byDay = new Map<string, StoredNotification[]>();
        for (const n of this.notifications) {
            const day = new Date(n.timestamp).toISOString().split('T')[0];
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day)!.push(n);
        }

        // Keep only newest 500 per day
        this.notifications = [];
        for (const [, dayNotifications] of byDay) {
            dayNotifications.sort((a, b) => b.timestamp - a.timestamp);
            this.notifications.push(...dayNotifications.slice(0, maxPerDay));
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

    getForDate(date: Date): StoredNotification[] {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return this.notifications.filter(n =>
            n.timestamp >= startOfDay.getTime() && n.timestamp <= endOfDay.getTime()
        ).sort((a, b) => b.timestamp - a.timestamp);
    }

    // Get notifications within a specific time range (for 24hr rolling window)
    getForTimeRange(startTime: number, endTime: number): StoredNotification[] {
        return this.notifications.filter(n =>
            n.timestamp >= startTime && n.timestamp <= endTime
        ).sort((a, b) => b.timestamp - a.timestamp);
    }

    getStats(date: Date): DailyStats {
        const notifications = this.getForDate(date);
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

    getByGroupId(groupId: string): StoredNotification[] {
        if (!groupId) return [];
        return this.notifications.filter(n => n.groupId === groupId);
    }

    // Update group metadata for a set of notification IDs
    updateGroup(notificationIds: string[], groupId: string, primaryId: string): void {
        const idSet = new Set(notificationIds);
        const updated: StoredNotification[] = [];
        for (const n of this.notifications) {
            if (idSet.has(n.id)) {
                n.groupId = groupId;
                n.isGroupPrimary = (n.id === primaryId);
                updated.push(n);
            }
        }
        if (this.diskReady && this.notifLog) {
            for (const n of updated) {
                this.notifLog.appendSync(n);
            }
        } else {
            this.save();
        }
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
