import sdk, {
    ChatCompletion,
    HttpRequest,
    HttpRequestHandler,
    HttpResponse,
    MixinProvider,
    Notifier,
    RTCSignalingChannel,
    ScryptedDevice,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedMimeTypes,
    Settings,
    SettingValue,
    VideoRecorder,
    WritableDeviceState
} from '@scrypted/sdk';
const { StorageSettings } = require('@scrypted/sdk/storage-settings');

const { mediaManager, endpointManager } = sdk;
import { LRUCache } from 'lru-cache';
import { WebRTCSignalingSession } from './webrtc';
import { withTimeout, resizeJpegNearest, getJpegDimensions, extractFirstJsonObject, supportsRecordingStream } from './utils';

import {
    StoredNotification,
    NarrativeSegment,
    NaturalPeriod,
    CachedHighlight,
    DailyBriefData,
    FrozenSegment,
    CandidateWithPriority
} from './types';
import { NotificationStore } from './notification-store';
import { PosterDecisionLog, PosterDecision } from './poster-decision-log';
import { buildCachedHighlights } from './daily-brief/highlights';
import { createTimeBuckets, isVehicleNotification, selectCandidatesFromBuckets } from './daily-brief/candidate-selection';
import { getNaturalPeriods, buildFrozenContext, createSummaryPrompt, toDisplayTimeRange, consolidatePeriodNarrative } from './daily-brief/prompts';
import { generateDailyBriefHTML, getHACardBundle } from './daily-brief/html-generator';
import { LLMNotifier } from './llm-notifier';
import { PosterStore } from './poster-store';
import { PersonStore } from './person-store';
import { buildPerEventClickData, sanitizeHaClickUrl } from './llm-notifier';
import { handleGalleryDataRequest, handleGallerySearchRequest, handlePeopleRequest, handlePeoplePhotoRequest, handlePeopleDeleteRequest } from './gallery';
import {
    LlmTelemetryLog,
    LlmJudgeLog,
    TelemetryRow,
    JudgeRow,
    aggregateTelemetry,
    pruneRows,
    makeTelemetryId,
    truncateError,
} from './llm-telemetry';
import { shouldSampleForJudging, runJudge, resolveJudgeProvider, JudgeInput } from './llm-judge';
import * as path from 'path';
import * as fsp from 'fs/promises';

// Module-level singleton timer for the Daily Brief scheduled fire. Scrypted
// has been observed instantiating LLMNotifierProvider more than once per
// plugin load (e.g. duplicated "Daily Brief available at ..." in the startup
// log), which previously caused each instance to arm its own 8:00 PM timer
// and fire N notifications at the scheduled hour. Holding the timer at
// module scope guarantees one timer in the process regardless of how many
// provider instances exist — the last scheduleDailySummary caller wins.
let dailyBriefTimer: NodeJS.Timeout | undefined;

export function resolveNotificationProvider<T>(
    notificationLlm: T | undefined,
    selectProvider: () => T,
): T {
    if (notificationLlm) return notificationLlm;
    return selectProvider();
}

// Build the Brief tab lede: the LLM-generated 1-2 sentence overview from the
// most recent period only. Joining all periods produced a wall of text that
// duplicated the timeline below; the lede should be a fresh "what just
// happened" intro, not a tour of every prior period.
export function joinPeriodOverviews(frozenSegments: FrozenSegment[]): string {
    const sorted = [...frozenSegments].sort((a, b) => a.periodStart - b.periodStart);
    for (let i = sorted.length - 1; i >= 0; i--) {
        const overview = sorted[i].overview;
        if (overview && overview.length > 0) return overview;
    }
    return '';
}

/**
 * A frozen narrative, healed for rendering. Every path that hands a frozen
 * segment to setCachedSummary goes through here — the persisted timeRange may
 * predate a label rename ("Thursday night" -> "Thursday early morning"), and
 * an early-return path that skips healing serves the stale label on exactly
 * the day the user checks whether the rename worked. Also clones: two of the
 * three call sites used to pass the live persisted object by reference.
 */
export function renderFrozenNarrative(fs: FrozenSegment): NarrativeSegment {
    return {
        timeRange: toDisplayTimeRange(fs.narrative.timeRange),
        text: fs.narrative.text,
        highlightIds: [...fs.narrative.highlightIds],
    };
}

/**
 * Parse a brief date param (`?date=YYYY-MM-DD` or `/brief/YYYY-MM-DD`) into a Date.
 *
 * Anchored at NOON UTC so the calendar day survives conversion to any display
 * timezone within UTC±12 (e.g. America/Los_Angeles). The prior code used
 * `new Date(param + 'T00:00:00')`, which JS parses in the SERVER's local zone —
 * UTC on the Linux host — putting the instant at 00:00 UTC. Downstream
 * `toLocaleDateString(displayTz)` then shifted that back a day (picking 6/11
 * rendered 6/10). Callers must pre-validate the YYYY-MM-DD shape.
 */
export function parseBriefDate(dateParam: string): Date {
    return new Date(dateParam + 'T12:00:00Z');
}

export default class LLMNotifierProvider extends ScryptedDeviceBase implements MixinProvider, Settings, HttpRequestHandler {
    private currentProviderIndex = 0;
    private currentNotificationProviderIndex = 0;
    private dailyBriefStartupTimer: NodeJS.Timeout | undefined;
    private dailyBriefIntervalTimer: NodeJS.Timeout | undefined;
    private pruneIntervalTimer: NodeJS.Timeout | undefined;
    detectionTracker = new LRUCache<string, {text: string, count: number}>({
        max: 100,
        ttl: 1000 * 60 * 30, // 30 minutes - longer TTL to see more detections
    });
    responseCache = new LRUCache<string, {title: string, subtitle: string, body: string, detailedDescription: string, clarity?: {score: number, reason: string}}>({
        max: 1000,
        ttl: 1000 * 60 * 5, // 5 minutes
    });
    inFlightRequests = new LRUCache<string, Promise<{title: string, subtitle: string, body: string, detailedDescription: string, clarity?: {score: number, reason: string}}>>({
        max: 100,
    });
    posterStore: PosterStore;
    personStore: PersonStore;
    notificationStore: NotificationStore;
    telemetryLog!: LlmTelemetryLog;
    judgeLog!: LlmJudgeLog;
    /** Latch so the "judging is inert" warning is said once, not per event. */
    private judgeInertWarned = false;
    posterDecisionLog!: PosterDecisionLog;
    telemetrySink!: { record(row: TelemetryRow): void };
    private telemetryPruneTimer: NodeJS.Timeout | undefined;
    private pluginVersion: string;
    private cachedLocalEndpoint: string | null = null;
    private cachedCloudEndpoint: string | null = null;

    constructor(nativeId?: string) {
        super(nativeId);
        this.notificationStore = new NotificationStore(this.storage, () => mediaManager.getFilesPath());
        this.posterStore = new PosterStore(() => mediaManager.getFilesPath());
        this.notificationStore.initDiskStorage().catch(e =>
            this.console.warn('[Daily Brief] Disk storage init failed:', e));
        this.personStore = new PersonStore(() => mediaManager.getFilesPath());

        // Initialize LLM telemetry + judge logs (lazy — resolve filesPath on first use).
        this.telemetryLog = new LlmTelemetryLog(async () => path.join(await mediaManager.getFilesPath(), 'llm-telemetry.jsonl'));
        this.judgeLog = new LlmJudgeLog(async () => path.join(await mediaManager.getFilesPath(), 'llm-judge.jsonl'));
        this.posterDecisionLog = new PosterDecisionLog(async () => path.join(await mediaManager.getFilesPath(), 'poster-decisions.jsonl'));
        this.telemetrySink = {
            record: (row: TelemetryRow) => {
                // Fire-and-forget; never block or throw into caller.
                this.telemetryLog.append(row).catch(err => {
                    try { this.console.warn('[Telemetry] append failed:', err); } catch { /* ignore */ }
                });
            },
        };
        try {
            this.pluginVersion = require('../package.json').version;
        } catch {
            this.pluginVersion = 'unknown';
        }

        // Wire configurable retention (storageSettings not available in constructor)
        const retentionDaysRaw = parseInt(this.storage.getItem('retentionDays') || '3', 10);
        const retentionDays = isNaN(retentionDaysRaw) ? 3 : retentionDaysRaw;
        this.notificationStore.setRetentionDays(retentionDays);
        // prune()'s per-day cap buckets by calendar day; give it the user's
        // zone so a local day isn't split across two UTC buckets.
        this.notificationStore.setTimezone(this.storage.getItem('dailyBriefTimezone') || undefined);
        // The store's constructor already pruned once, before it knew either
        // setting, so redo it now that both are in hand.
        this.notificationStore.pruneNow();

        // Deterministic inert-judge check at load. The maybeRunJudge warning
        // only fires once a sampled event with an inline image arrives, which
        // at a low sample rate can be a long, silent wait. Raw storage is used
        // because storageSettings is not available in the constructor.
        const judgeRate = parseFloat(this.storage.getItem('llmJudgeSampleRate') || '0');
        const judgeProviderId = this.storage.getItem('llmJudgeProvider');
        if (judgeRate > 0 && !judgeProviderId) {
            this.judgeInertWarned = true;
            this.console.warn('[Judge] Judge Sample Rate is above 0 but no Judge LLM Provider is selected — nothing is being graded. Pick one in settings; a judge is never chosen for you.');
        }

        // Cache endpoint URLs and log on startup (fire-and-forget)
        this.refreshEndpointCache();

        // Schedule daily brief notification
        this.scheduleDailySummary();

        // Start background generation timer
        this.startDailyBriefTimer();

        // Start periodic poster prune timer
        this.startPruneTimer();

        // One-shot migration: prune v0.3.83-v0.3.116 grouping artifacts.
        // Fire-and-forget so it doesn't block constructor.
        this.runStoriesGroupingMigration().catch(e =>
            this.console.warn('[Stories] Migration prune failed:', e));
    }

    /**
     * One-shot migration for installs that ran v0.3.83-v0.3.116 grouping.
     * Removes any lingering composite poster files (posters/group-*.jpg)
     * and strips orphan group fields (groupId, isGroupPrimary,
     * llmGroupTitle/Subtitle/Body) from existing notification records.
     * Idempotent — safe to run on every startup; subsequent runs are no-ops.
     */
    private async runStoriesGroupingMigration(): Promise<void> {
        // 1. Prune composite poster files
        const filesPath = await mediaManager.getFilesPath();
        const postersDir = path.join(filesPath, 'posters');
        let prunedPosters = 0;
        try {
            const entries = await fsp.readdir(postersDir);
            for (const e of entries) {
                if (e.startsWith('group-')) {
                    try {
                        await fsp.unlink(path.join(postersDir, e));
                        prunedPosters++;
                    } catch { /* ignore — best-effort */ }
                }
            }
        } catch { /* posters dir may not exist on fresh installs */ }
        if (prunedPosters > 0) {
            this.console.log(`[Stories migration] Pruned ${prunedPosters} legacy composite poster files`);
        }

        // 2. Strip orphan group fields from notifications.jsonl
        // Wait for notificationStore disk init first so getAll() returns disk records
        try {
            // initDiskStorage is fire-and-forget in the constructor; give it
            // a chance to finish. The store internally guards against
            // double-init, so calling it again is safe.
            await this.notificationStore.initDiskStorage();
        } catch (e) {
            this.console.warn('[Stories migration] notificationStore init wait failed:', e);
        }
        const modified = this.notificationStore.stripLegacyGroupFields();
        if (modified > 0) {
            this.console.log(`[Stories migration] Stripped legacy group fields from ${modified} notification records`);
        }
    }

    private async refreshEndpointCache(): Promise<void> {
        try {
            this.cachedLocalEndpoint = await endpointManager.getLocalEndpoint(this.nativeId);
            this.console.log(`Daily Brief available at: ${this.cachedLocalEndpoint.replace(/\/+$/, '')}/brief`);
            // Publish a Scrypted launcher entry so the Daily Brief is reachable
            // from the launcher page instead of only by copying a URL out of
            // settings. A relative path, not the SDK's absolute URL: that URL
            // carries an IP:port, but users reach Scrypted by hostname or
            // reverse proxy, and the launcher renders in whatever host the
            // browser is already on.
            this.applicationInfo = {
                name: 'LLM Notifier',
                description: 'Daily Brief, activity, and people',
                icon: 'fa-bell',
                href: `${new URL(this.cachedLocalEndpoint).pathname.replace(/\/+$/, '')}/brief`,
            };
        } catch {
            // Endpoint may not be ready yet
        }
        try {
            // Cloud endpoint resolves to whatever Scrypted Cloud has registered
            // for this user's plugin (per-user domain + token). Used for the
            // "Open Daily Brief (cloud)" settings link so the link works when
            // the plugin is opened from a Scrypted Cloud admin host. Domain is
            // never hardcoded — it comes entirely from the SDK.
            this.cachedCloudEndpoint = await endpointManager.getCloudEndpoint(this.nativeId);
        } catch {
            // Cloud not configured / not signed into Scrypted Cloud — link is
            // simply omitted in that case.
        }
    }

    // Calculate milliseconds until target hour in user's timezone
    private msUntilLocalTime(hour: number, timezone: string): number {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        const parts = formatter.formatToParts(now);
        const localHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
        const localMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');

        let hoursUntil = hour - localHour;
        if (hoursUntil < 0 || (hoursUntil === 0 && localMinute > 0)) {
            hoursUntil += 24; // Schedule for next day
        }
        return (hoursUntil * 60 - localMinute) * 60 * 1000;
    }

    // Schedule daily summary generation and notification
    private scheduleDailySummary() {
        // Clear any existing timeout (module-level — see dailyBriefTimer declaration).
        if (dailyBriefTimer) {
            clearTimeout(dailyBriefTimer);
            dailyBriefTimer = undefined;
        }

        // Check if feature is enabled
        if (!(this.storageSettings.values as any).dailyBriefEnabled) {
            return;
        }

        const timezone = this.storage.getItem('dailyBriefTimezone') || 'America/Los_Angeles';
        const hour = (this.storageSettings.values as any).dailyBriefHour ?? 20;
        const ms = this.msUntilLocalTime(hour, timezone);
        const hoursUntil = Math.round(ms / 3600000 * 10) / 10;

        // Check if we missed today's notification (e.g. plugin restarted after scheduled hour)
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
        const lastSentDate = this.storage.getItem('lastDailyBriefDate');
        if (lastSentDate !== todayStr && hoursUntil > 23) {
            // hoursUntil > 23 means we're past the scheduled hour (timer wrapped to tomorrow).
            // Reserve today's slot NOW, synchronously, so rapid restarts during the
            // generation window (3-9s LLM call) don't also schedule a fire. See Issue #7.
            this.storage.setItem('lastDailyBriefDate', todayStr);
            this.console.log(`[Daily Brief] Missed today's ${hour}:00 notification (last sent: ${lastSentDate || 'never'}), firing now`);
            dailyBriefTimer = setTimeout(async () => {
                // Cross-process race guard: the schedule-time setItem above
                // claims today's slot, but two provider processes may have
                // both read "yesterday" before either wrote. Re-read at fire
                // time and skip if generateAndNotifySummary has already
                // logged a successful fire (lastDailyBriefSentMs is set
                // inside generateAndNotifySummary on success).
                const sentMsRaw = this.storage.getItem('lastDailyBriefSentMs') || '0';
                const sentMs = parseInt(sentMsRaw, 10) || 0;
                const now = Date.now();
                if (now - sentMs < 60 * 60 * 1000) {
                    this.console.log(`[Daily Brief] Skipping missed-path fire — another process sent ${Math.round((now - sentMs) / 1000)}s ago`);
                    this.scheduleDailySummary();
                    return;
                }
                await this.generateAndNotifySummary();
                this.scheduleDailySummary(); // Reschedule for tomorrow
            }, 5000); // Short delay to let plugin finish initializing
            return;
        }

        this.console.log(`Daily Brief scheduled in ${hoursUntil}h (${timezone}, ${hour}:00)`);

        dailyBriefTimer = setTimeout(async () => {
            // Cross-process dedup: the user reported 4× notifications at the
            // scheduled hour (2026-05-04). Module-scope dailyBriefTimer
            // dedupes within one process, but two concurrent provider
            // processes can each schedule a timer for the same hour.
            // Re-check at fire time using lastDailyBriefSentMs (set inside
            // generateAndNotifySummary on success). 1h dedup window — well
            // larger than the LLM-generation latency (~3-9s) and any
            // restart-storm window.
            const sentMsRaw = this.storage.getItem('lastDailyBriefSentMs') || '0';
            const sentMs = parseInt(sentMsRaw, 10) || 0;
            const now = Date.now();
            if (now - sentMs < 60 * 60 * 1000) {
                this.console.log(`[Daily Brief] Skipping scheduled fire — another process sent ${Math.round((now - sentMs) / 1000)}s ago`);
                this.scheduleDailySummary();
                return;
            }
            const todayStrNow = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
            this.storage.setItem('lastDailyBriefDate', todayStrNow);
            await this.generateAndNotifySummary();
            this.scheduleDailySummary(); // Reschedule for next day
        }, ms);
    }

    // Clear all Daily Brief timers
    private clearDailyBriefTimers() {
        if (this.dailyBriefStartupTimer) {
            clearTimeout(this.dailyBriefStartupTimer);
            this.dailyBriefStartupTimer = undefined;
        }
        if (this.dailyBriefIntervalTimer) {
            clearInterval(this.dailyBriefIntervalTimer);
            this.dailyBriefIntervalTimer = undefined;
        }
    }

    // Start background generation timer for Daily Brief (aligned to top of hour)
    private startDailyBriefTimer() {
        // Clear any existing timers
        this.clearDailyBriefTimers();

        let intervalMinutes = parseInt(this.storage.getItem('dailyBriefGenerationInterval') || '60', 10);
        if (intervalMinutes <= 0) {
            this.console.log('[Daily Brief] Background generation disabled');
            return;
        }
        // Minimum 5 minutes to prevent excessive LLM calls
        if (intervalMinutes > 0 && intervalMinutes < 5) {
            this.console.warn(`[Daily Brief] Interval ${intervalMinutes}m too short, using 5m minimum`);
            intervalMinutes = 5;
        }

        const intervalMs = intervalMinutes * 60 * 1000;

        // Calculate ms until next top of hour
        const now = new Date();
        const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

        // If we just passed the top of the hour (within 5 seconds), run immediately
        // instead of waiting ~60 minutes. msUntilNextHour will be close to 60 min in this case.
        const effectiveDelay = msUntilNextHour > (60 * 60 * 1000 - 5000) ? 0 : msUntilNextHour;

        this.console.log(`[Daily Brief] Timer starts at top of hour (in ${Math.round(effectiveDelay / 1000 / 60)} min), then every ${intervalMinutes} min`);

        // Generate immediately if no cached summary exists
        const timezone = this.storage.getItem('dailyBriefTimezone') || 'America/Los_Angeles';
        const cached = this.notificationStore.getCachedSummary(new Date(), timezone);
        if (!cached) {
            this.console.log('[Daily Brief] No cached summary found, generating now...');
            this.generateDailyBriefInBackground();
        }

        // First run at top of hour, then interval
        this.dailyBriefStartupTimer = setTimeout(() => {
            this.dailyBriefStartupTimer = undefined;
            this.generateDailyBriefInBackground();
            this.dailyBriefIntervalTimer = setInterval(() => {
                this.generateDailyBriefInBackground();
            }, intervalMs);
        }, effectiveDelay);
    }

    private startPruneTimer() {
        if (this.pruneIntervalTimer) {
            clearInterval(this.pruneIntervalTimer);
            this.pruneIntervalTimer = undefined;
        }

        const retentionDaysRaw = parseInt(this.storage.getItem('retentionDays') || '3', 10);
        const retentionDays = isNaN(retentionDaysRaw) ? 3 : retentionDaysRaw;
        const pruneAgeDays = retentionDays + 2;

        this.pruneIntervalTimer = setInterval(() => {
            this.posterStore.pruneOlderThan(pruneAgeDays).then(n => {
                if (n > 0) this.console.log(`[Poster] Periodic prune: removed ${n} posters older than ${pruneAgeDays} days`);
            }).catch(e => this.console.warn('[Poster] Periodic prune failed:', e));
            this.pruneTelemetryLogs().catch(e => this.console.warn('[Telemetry] Periodic prune failed:', e));
        }, 24 * 60 * 60 * 1000);

        this.console.log(`[Poster] Prune timer set: daily, deleting posters older than ${pruneAgeDays} days`);
    }

    private async pruneTelemetryLogs() {
        const daysRaw = parseInt(this.storage.getItem('llmTelemetryRetentionDays') || '14', 10);
        const days = isNaN(daysRaw) ? 14 : Math.max(1, Math.min(90, daysRaw));
        const now = Date.now();

        try {
            const rows = await this.telemetryLog.loadAll();
            const kept = pruneRows(rows, days, now);
            if (kept.length < rows.length) {
                await this.telemetryLog.compact(kept);
                this.console.log(`[Telemetry] Pruned ${rows.length - kept.length} telemetry rows older than ${days}d`);
            }
        } catch (e) {
            this.console.warn('[Telemetry] Prune telemetry log failed:', e);
        }

        try {
            const jrows = await this.judgeLog.loadAll();
            const kept = pruneRows(jrows, days, now);
            if (kept.length < jrows.length) {
                await this.judgeLog.compact(kept);
                this.console.log(`[Telemetry] Pruned ${jrows.length - kept.length} judge rows older than ${days}d`);
            }
        } catch (e) {
            this.console.warn('[Telemetry] Prune judge log failed:', e);
        }
    }

    // Generate narrative for a single 6-hour period
    private async generateForPeriod(
        period: NaturalPeriod,
        notifications: StoredNotification[],
        dateStr: string,
        timezone: string,
        isCompleted: boolean,
        customInstructions?: string,
        frozenContext?: string,
    ): Promise<{ narrative: NarrativeSegment[]; overview: string; highlights: CachedHighlight[]; frozen?: FrozenSegment } | null> {
        // Filter notifications to this period
        const periodNotifications = notifications.filter(
            n => n.timestamp >= period.start && n.timestamp < period.end
        );

        if (periodNotifications.length === 0) {
            // Empty completed period — freeze with empty narrative
            if (isCompleted) {
                return {
                    narrative: [],
                    overview: '',
                    highlights: [],
                    frozen: {
                        periodKey: period.key,
                        periodStart: period.start,
                        periodEnd: period.end,
                        narrative: { timeRange: period.label, text: '', highlightIds: [] },
                        overview: '',
                        highlights: [],
                        highlightNotificationIds: [],
                    },
                };
            }
            return null;
        }

        // Bucket + select candidates for this period
        const buckets = createTimeBuckets(periodNotifications, period.start, period.end, 12, timezone);
        const candidates = selectCandidatesFromBuckets(buckets, 8);

        if (candidates.length === 0) {
            if (isCompleted) {
                return {
                    narrative: [],
                    overview: '',
                    highlights: [],
                    frozen: {
                        periodKey: period.key,
                        periodStart: period.start,
                        periodEnd: period.end,
                        narrative: { timeRange: period.label, text: '', highlightIds: [] },
                        overview: '',
                        highlights: [],
                        highlightNotificationIds: [],
                    },
                };
            }
            return null;
        }

        this.console.log(`[Daily Brief] Period ${period.label}: ${candidates.length} candidates from ${periodNotifications.length} events`);

        // Generate narrative for this period
        const { overview, narrative, highlightIds } = await this.generateDailySummary(
            candidates, dateStr, timezone, customInstructions, frozenContext, period.label
        );

        // Build highlights
        const highlights = buildCachedHighlights(candidates, highlightIds, timezone);

        // Override timeRange with the pre-computed period label (don't trust LLM's guess)
        // Convert narrative highlightIds from candidate indices to notification IDs for merge re-indexing
        const periodNarrative: NarrativeSegment[] = (narrative || []).map(seg => ({
            ...seg,
            timeRange: period.label,
            highlightIds: (seg.highlightIds || [])
                .filter(idx => idx >= 0 && idx < candidates.length)
                .map(idx => candidates[idx].notification.id) as any[],
        }));

        // Consolidate multi-segment responses into a single narrative segment
        // per period. Total over empty input (issue #12): a parse-failure
        // fallback or a fully-filtered response degrades this period to empty
        // instead of throwing and aborting every remaining period in the run.
        if (periodNarrative.length === 0)
            this.console.warn(`[Daily Brief] Period ${period.label}: LLM returned an empty narrative — rendering the period empty and continuing`);
        else if (periodNarrative.length > 1)
            this.console.log(`[Daily Brief] Period ${period.label}: LLM returned ${periodNarrative.length} segments, consolidating`);
        const consolidatedNarrative = consolidatePeriodNarrative(periodNarrative, period.label);

        // Freeze if completed AND the LLM actually produced something. An
        // empty narrative here is an LLM failure, not a quiet period —
        // candidates existed (the no-candidates case returned earlier).
        // Frozen keys are never regenerated, so freezing it would blank the
        // period PERMANENTLY; leaving it unfrozen means the next hourly run
        // retries — one LLM call per cycle, bounded by the 24h window.
        let frozen: FrozenSegment | undefined;
        if (isCompleted && periodNarrative.length > 0) {
            frozen = {
                periodKey: period.key,
                periodStart: period.start,
                periodEnd: period.end,
                narrative: consolidatedNarrative,
                overview: overview || '',
                highlights,
                // Derive from the consolidated narrative to stay in sync
                highlightNotificationIds: consolidatedNarrative.highlightIds as unknown as string[],
            };
        }

        return { narrative: [consolidatedNarrative], overview: overview || '', highlights, frozen };
    }

    // Generate Daily Brief summary in background (no notification)
    private async generateDailyBriefInBackground(forceFullRegeneration: boolean = false) {
        try {
            const timezone = this.storage.getItem('dailyBriefTimezone') || 'America/Los_Angeles';
            const now = new Date();
            const windowEnd = now.getTime();

            // Calculate midnight yesterday in the user's timezone
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
            const parts = formatter.formatToParts(now);
            const getPart = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');
            const tzHour = getPart('hour');
            const tzMinute = getPart('minute');
            const tzSecond = getPart('second');

            const msSinceMidnight = ((tzHour * 60 + tzMinute) * 60 + tzSecond) * 1000;
            const midnightTodayUtc = windowEnd - msSinceMidnight;
            const windowStart = midnightTodayUtc; // Midnight today (24h window — was 48h pre-v0.3.110, confused readers when yesterday's events led the lede)

            this.console.log(`[Daily Brief] Window: ${new Date(windowStart).toISOString()} to ${new Date(windowEnd).toISOString()} (${timezone})`);

            const notifications = this.notificationStore.getForTimeRange(windowStart, windowEnd);

            if (notifications.length === 0) {
                this.console.log('[Daily Brief] No notifications in window, skipping background generation');
                return;
            }

            const dateStr = now.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                timeZone: timezone
            });

            // === Incremental Narrative Generation ===

            // 1. Calculate natural 6-hour periods spanning the window
            const naturalPeriods = getNaturalPeriods(windowStart, windowEnd, timezone);

            // 2. Load existing frozen segments (skip if force refresh)
            let existingFrozen: FrozenSegment[] = [];
            if (!forceFullRegeneration) {
                const cached = this.notificationStore.getCachedSummary(now, timezone);
                if (cached?.frozenSegments) {
                    // Only keep frozen segments whose periods are still within the window
                    existingFrozen = cached.frozenSegments.filter(
                        fs => fs.periodEnd > windowStart && fs.periodStart < windowEnd
                    );
                }
            }

            // 3. Identify completed periods (end time strictly before now) already frozen → keep them
            // Use strict < to avoid premature freezing at exact period boundaries
            const frozenKeys = new Set(existingFrozen.map(fs => fs.periodKey));
            const completedPeriods = naturalPeriods.filter(p => p.end < windowEnd);
            const activePeriods = naturalPeriods.filter(p => p.end >= windowEnd);

            // Periods to generate: active + completed-but-not-yet-frozen
            const periodsToGenerate = [
                ...completedPeriods.filter(p => !frozenKeys.has(p.key)),
                ...activePeriods
            ];

            if (periodsToGenerate.length === 0 && existingFrozen.length > 0) {
                this.console.log(`[Daily Brief] All periods frozen, updating cache timestamp (${existingFrozen.length} frozen segments)`);
                const frozenHighlights = existingFrozen.flatMap(fs => fs.highlights);
                const frozenNarrative = existingFrozen.filter(fs => fs.narrative.text).map(renderFrozenNarrative);
                frozenHighlights.forEach((h, i) => { h.index = i; });
                const overview = joinPeriodOverviews(existingFrozen);
                this.notificationStore.setCachedSummary(
                    now, overview, notifications.length, frozenHighlights,
                    windowStart, windowEnd, timezone, overview, frozenNarrative, existingFrozen
                );
                return;
            }

            this.console.log(`[Daily Brief] Incremental: ${existingFrozen.length} frozen, ${periodsToGenerate.length} to generate (force=${forceFullRegeneration})`);

            // 4. Early exit if no notifications fall in any period to generate
            const hasNotificationsInPeriods = notifications.some(n =>
                periodsToGenerate.some(p => n.timestamp >= p.start && n.timestamp < p.end)
            );

            if (!hasNotificationsInPeriods && existingFrozen.length > 0) {
                this.console.log(`[Daily Brief] No new notifications in active periods, keeping frozen segments`);
                // Re-store with existing data (updates generatedAt)
                const frozenHighlights = existingFrozen.flatMap(fs => fs.highlights);
                const frozenNarrative = existingFrozen.filter(fs => fs.narrative.text).map(renderFrozenNarrative);
                // Re-index highlights contiguously
                frozenHighlights.forEach((h, i) => { h.index = i; });
                const overview = joinPeriodOverviews(existingFrozen);
                this.notificationStore.setCachedSummary(
                    now, overview, notifications.length, frozenHighlights,
                    windowStart, windowEnd, timezone, overview, frozenNarrative, existingFrozen
                );
                return;
            }

            // 5. Read custom instructions + build frozen context
            const customInstructions = this.storage.getItem('dailyBriefCustomPrompt') || '';
            const frozenContext = existingFrozen.length > 0 ? buildFrozenContext(existingFrozen) : undefined;
            if (frozenContext) {
                this.console.log(`[Daily Brief] Providing ${existingFrozen.length} frozen segments as context to LLM`);
            }

            // 6. Generate per-period: one LLM call per period
            // Accumulate frozenContext so each period's LLM prompt includes prior periods from this run
            const completedKeys = new Set(completedPeriods.map(p => p.key));
            const allNewNarrative: NarrativeSegment[] = [];
            const allNewHighlights: CachedHighlight[] = [];
            const newFrozen: FrozenSegment[] = [...existingFrozen];
            // Per-period overviews from active (non-completed) periods this run. Active
            // periods don't produce a FrozenSegment but their LLM overview must still
            // contribute to the day-level lede (issue #10).
            const activePeriodOverviewSegments: FrozenSegment[] = [];
            let accumulatedFrozenContext = frozenContext;

            for (const period of periodsToGenerate) {
                const isCompleted = completedKeys.has(period.key);
                const result = await this.generateForPeriod(
                    period, notifications,
                    dateStr, timezone, isCompleted,
                    customInstructions || undefined, accumulatedFrozenContext
                );
                if (result) {
                    allNewNarrative.push(...result.narrative);
                    allNewHighlights.push(...result.highlights);
                    if (result.frozen) {
                        newFrozen.push(result.frozen);
                        frozenKeys.add(result.frozen.periodKey);
                    } else if (result.overview) {
                        // No frozen segment but a usable overview: an active
                        // (still-running) period, or a completed one whose
                        // narrative failed and stays retryable. Synthesize an
                        // overview-only FrozenSegment for joinPeriodOverviews
                        // ordering. Not stored in cache — deliberately, so the
                        // failed-narrative case is regenerated next run.
                        activePeriodOverviewSegments.push({
                            periodKey: period.key,
                            periodStart: period.start,
                            periodEnd: period.end,
                            narrative: { timeRange: period.label, text: '', highlightIds: [] },
                            overview: result.overview,
                            highlights: [],
                            highlightNotificationIds: [],
                        });
                    }
                    // Accumulate context for subsequent periods (same format as buildFrozenContext)
                    if (result.narrative.length > 0) {
                        const newContext = result.narrative
                            .filter(n => n.text)
                            .map(n => `${n.timeRange}: ${n.text} (${(n.highlightIds || []).length} highlights)`)
                            .join('\n');
                        accumulatedFrozenContext = accumulatedFrozenContext
                            ? `${accumulatedFrozenContext}\n${newContext}`
                            : newContext;
                    }
                }
            }

            // 7. Merge: frozen segments + new segments
            this.console.log(`[Daily Brief] Reusing frozen periods: ${existingFrozen.map(fs => fs.periodKey).join(', ') || 'none'}`);
            const frozenNarrative: NarrativeSegment[] = [];
            const narrativeToFrozen = new Map<NarrativeSegment, FrozenSegment>();
            for (const fs of existingFrozen) {
                if (!fs.narrative.text) continue;
                const cloned = renderFrozenNarrative(fs);
                frozenNarrative.push(cloned);
                narrativeToFrozen.set(cloned, fs);
            }
            const mergedNarrative = [...frozenNarrative, ...allNewNarrative.filter(seg => seg.text)];

            // Merge highlights: frozen + new, re-index contiguously
            const frozenHighlights = existingFrozen.flatMap(fs => fs.highlights);
            const mergedHighlights = [...frozenHighlights, ...allNewHighlights];
            mergedHighlights.forEach((h, i) => { h.index = i; });

            // Re-index highlight IDs in narrative segments
            const highlightIdMap = new Map(mergedHighlights.map((h, i) => [h.id, i]));
            for (const seg of mergedNarrative) {
                const frozenSeg = narrativeToFrozen.get(seg);
                if (frozenSeg) {
                    seg.highlightIds = frozenSeg.highlightNotificationIds
                        .map(notifId => highlightIdMap.get(notifId) ?? -1)
                        .filter(idx => idx >= 0);
                } else {
                    seg.highlightIds = seg.highlightIds
                        .map(id => highlightIdMap.get(id as any) ?? -1)
                        .filter(idx => idx >= 0);
                }
            }

            // Sort chronologically — frozen segments by periodStart, new by first highlight timestamp
            mergedNarrative.sort((a, b) => {
                const aFrozen = narrativeToFrozen.get(a);
                const bFrozen = narrativeToFrozen.get(b);
                const aTime = aFrozen ? aFrozen.periodStart : (a.highlightIds.length > 0 && a.highlightIds[0] < mergedHighlights.length ? mergedHighlights[a.highlightIds[0]]?.timestamp || 0 : 0);
                const bTime = bFrozen ? bFrozen.periodStart : (b.highlightIds.length > 0 && b.highlightIds[0] < mergedHighlights.length ? mergedHighlights[b.highlightIds[0]]?.timestamp || 0 : 0);
                return aTime - bTime;
            });

            // 8. Build final summary from per-period LLM overviews (issue #10).
            // newFrozen contains every completed period's frozen segment with its
            // overview field; active (still-running) periods that aren't frozen
            // contribute their overview via activePeriodOverviews collected in the loop.
            const mergedOverview = joinPeriodOverviews([...newFrozen, ...activePeriodOverviewSegments]);

            this.notificationStore.setCachedSummary(
                now, mergedOverview, notifications.length, mergedHighlights,
                windowStart, windowEnd, timezone, mergedOverview, mergedNarrative, newFrozen
            );
            this.console.log(`[Daily Brief] Background generation complete (${mergedHighlights.length} highlights, ${mergedNarrative.length} segments, ${newFrozen.length} frozen)`);
        } catch (e) {
            this.console.error('[Daily Brief] Background generation failed:', e);
        }
    }

    // Generate summary and send notification (scheduled Daily Brief)
    private async generateAndNotifySummary() {
        this.console.log('[Daily Brief] Scheduled notification triggered');
        const today = new Date();
        const timezone = this.storage.getItem('dailyBriefTimezone') || 'America/Los_Angeles';

        try {
            // Use centralized generation logic
            await this.generateDailyBriefInBackground();

            // Get the generated summary from cache
            const cached = this.notificationStore.getCachedSummary(today, timezone);
            if (!cached) {
                this.console.log('No summary generated, skipping notification');
                return;
            }

            // Send notification
            this.console.log('[Daily Brief] Summary generated, sending notification...');
            await this.sendDailyBriefNotification(today, cached.summary, cached.notificationCount);
            // Cross-process dedup marker. Other timers re-read this and skip
            // their fire if it's within the last hour. See scheduleDailySummary.
            this.storage.setItem('lastDailyBriefSentMs', String(Date.now()));
            // Note: scheduler reserves lastDailyBriefDate synchronously before firing (Issue #7)
            this.console.log('[Daily Brief] Summary generated and notification sent');
        } catch (e) {
            this.console.error('Failed to generate scheduled summary:', e);
        }
    }

    // Send notification with link to Daily Brief
    private async sendDailyBriefNotification(date: Date, summary: string, eventCount: number) {
        try {
            // storageSettings.values for type:'device' (non-multiple) returns the device object directly
            const notifier = (this.storageSettings.values as any).dailyBriefNotifier as (Notifier & ScryptedDevice) | undefined;
            if (!notifier) {
                this.console.warn('[Daily Brief] No notifier selected for Daily Brief notifications');
                return;
            }

            const briefUrl = (this.storageSettings.values as any).dailyBriefNotificationUrl || '/daily-brief/0';

            await notifier.sendNotification(
                'Daily Brief Ready',
                {
                    subtitle: `${eventCount} events today`,
                    body: summary.substring(0, 75),
                    data: { ha: { url: briefUrl, clickAction: briefUrl } }
                }
            );

            this.console.log(`Daily Brief notification sent to ${notifier.name}`);
        } catch (e) {
            this.console.error('Failed to send Daily Brief notification:', e);
        }
    }

    async generateDailySummary(candidates: CandidateWithPriority[], dateStr: string, timezone: string, customInstructions?: string, frozenContext?: string, periodLabel?: string): Promise<{ summary: string; overview?: string; narrative?: NarrativeSegment[]; highlightIds: string[] }> {
        this.console.log(`[Daily Brief] Starting summary generation for ${candidates.length} candidates`);

        const device = this.selectProvider();
        if (!device) {
            this.console.error(`[Daily Brief] No LLM provider available`);
            throw new Error('No LLM provider available');
        }

        // Safety cap only - modern LLMs handle large context well
        const MAX_CANDIDATES = 10000;
        const limitedCandidates = candidates.length > MAX_CANDIDATES
            ? candidates.slice(0, MAX_CANDIDATES)
            : candidates;
        if (candidates.length > MAX_CANDIDATES) {
            this.console.log(`[Daily Brief] Limiting to ${MAX_CANDIDATES} of ${candidates.length} candidates`);
        }

        const prompt = createSummaryPrompt(limitedCandidates, dateStr, timezone, customInstructions, frozenContext, periodLabel);
        const promptSize = JSON.stringify(prompt).length;
        const timeoutMs = Math.max(1, Number((this.storageSettings.values as any).llmTimeoutMs ?? 90)) * 1000;

        this.console.log(`[Daily Brief] Sending ${limitedCandidates.length} candidates to LLM (prompt: ${promptSize} chars, timeout: ${timeoutMs}ms)`);

        const telemetryId = makeTelemetryId();
        const providerName = (device as any).name || '(unnamed)';
        const llmStartTime = Date.now();
        const emitTelemetry = (row: Omit<TelemetryRow, 'id' | 'ts' | 'providerName' | 'role' | 'timeoutMs' | 'promptBytes'>) => {
            try {
                this.telemetrySink.record({
                    id: telemetryId,
                    ts: Date.now(),
                    providerName,
                    role: 'daily-brief',
                    timeoutMs,
                    promptBytes: promptSize,
                    ...row,
                });
            } catch { /* ignore */ }
        };

        try {
            let result: any;
            try {
                result = await withTimeout(
                    device.getChatCompletion({
                        ...prompt,
                        temperature: 0.1,
                        max_tokens: 8000  // 2000 was truncating multi-period narratives mid-sentence
                    } as any),
                    timeoutMs,
                    'Daily summary generation'
                );
            } catch (err) {
                const outcome = /timed out|timeout/i.test((err as Error).message || '') ? 'timeout' : 'error';
                emitTelemetry({ outcome, latencyMs: Date.now() - llmStartTime, errorMsg: truncateError(err) });
                throw err;
            }

            const llmElapsed = Date.now() - llmStartTime;
            this.console.log(`[Daily Brief] LLM completed in ${llmElapsed}ms`);

            const content = result.choices[0]?.message?.content;
            this.console.log(`[Daily Brief] Response length: ${content?.length || 0} chars`);

            if (!content) {
                const err = new Error('Empty response from LLM');
                emitTelemetry({ outcome: 'parse_error', latencyMs: llmElapsed, errorMsg: err.message });
                throw err;
            }

            const responseBytes = Buffer.byteLength(content, 'utf8');

            // Parse JSON response (strip markdown code blocks if present)
            try {
                const json = JSON.parse(extractFirstJsonObject(content));
                emitTelemetry({ outcome: 'ok', latencyMs: llmElapsed, responseBytes });

                // Handle new narrative format with explicit validation (#7)
                if (!json.overview || typeof json.overview !== 'string') {
                    this.console.warn('[Daily Brief] Missing or invalid overview in LLM response');
                }
                if (!Array.isArray(json.narrative)) {
                    this.console.warn('[Daily Brief] Missing or invalid narrative array in LLM response');
                }

                const overview = (typeof json.overview === 'string') ? json.overview : '';

                // Validate and filter narrative segments (#4)
                const rawSegments = Array.isArray(json.narrative) ? json.narrative : [];
                const narrativeSegments: NarrativeSegment[] = [];
                for (const segment of rawSegments) {
                    if (typeof segment.timeRange !== 'string' ||
                        typeof segment.text !== 'string' ||
                        !Array.isArray(segment.highlightIds)) {
                        this.console.warn(`[Daily Brief] Invalid segment structure, skipping:`, JSON.stringify(segment));
                        continue;
                    }
                    // Skip empty segments (#8 - prompt says min 1 highlightId)
                    if (segment.highlightIds.length === 0) {
                        this.console.warn(`[Daily Brief] Empty highlightIds in segment "${segment.timeRange}", skipping`);
                        continue;
                    }
                    narrativeSegments.push(segment);
                }

                // Collect all highlight indices from narrative segments
                const allHighlightIndices = new Set<number>();
                for (const segment of narrativeSegments) {
                    const invalidIndices: (number | string)[] = [];
                    for (const idx of segment.highlightIds || []) {
                        // Validate element type (#8)
                        if (typeof idx !== 'number') {
                            invalidIndices.push(idx);
                            continue;
                        }
                        // Validate bounds (#5)
                        if (idx >= 0 && idx < limitedCandidates.length) {
                            allHighlightIndices.add(idx);
                        } else {
                            invalidIndices.push(idx);
                        }
                    }
                    if (invalidIndices.length > 0) {
                        this.console.warn(`[Daily Brief] Invalid indices in segment "${segment.timeRange}": ${invalidIndices.join(', ')}`);
                    }
                }

                // Enforce vehicle cap: max 3 vehicles unless delivery-related (#1)
                const MAX_VEHICLES = 3;
                const vehicleIndices: number[] = [];
                for (const idx of allHighlightIndices) {
                    if (isVehicleNotification(limitedCandidates[idx].notification)) {
                        vehicleIndices.push(idx);
                    }
                }
                if (vehicleIndices.length > MAX_VEHICLES) {
                    // Remove excess vehicles (keep first 3 chronologically)
                    vehicleIndices.sort((a, b) => a - b);
                    for (const idx of vehicleIndices.slice(MAX_VEHICLES)) {
                        allHighlightIndices.delete(idx);
                    }
                    this.console.warn(`[Daily Brief] Vehicle cap: removed ${vehicleIndices.length - MAX_VEHICLES} excess vehicles (max ${MAX_VEHICLES})`);
                }

                // Convert indices to notification IDs
                const highlightIds = Array.from(allHighlightIndices)
                    .sort((a, b) => a - b)
                    .map(idx => limitedCandidates[idx].notification.id);

                // Create summary from overview with fallback (#3, #9)
                let summary = overview;
                if (!summary && narrativeSegments.length > 0) {
                    // Include time context when falling back to narrative text
                    summary = narrativeSegments.map(s => `${s.timeRange}: ${s.text}`).join(' ');
                }
                if (!summary) {
                    summary = 'No summary available';
                }

                this.console.log(`[Daily Brief] Narrative generated: ${narrativeSegments.length} segments, ${highlightIds.length} unique highlights`);
                for (const segment of narrativeSegments) {
                    this.console.log(`  - ${segment.timeRange}: ${segment.highlightIds?.length || 0} events`);
                }

                return { summary: summary.trim(), overview, narrative: narrativeSegments, highlightIds };
            } catch (parseErr) {
                // Fallback: treat entire response as summary with no highlights
                emitTelemetry({ outcome: 'parse_error', latencyMs: llmElapsed, responseBytes, errorMsg: truncateError(parseErr) });
                this.console.warn(`[Daily Brief] JSON parse failed, using plain text:`, parseErr);
                return { summary: content.trim(), highlightIds: [] };
            }
        } catch (e) {
            this.console.error(`[Daily Brief] LLM call failed:`, e);
            throw e;
        }
    }

    /**
     * Unified helper to fetch and format Daily Brief data for endpoints.
     * Consolidates duplicate logic between /brief/ha-card and /brief endpoints.
     */
    private async getDailyBriefData(
        targetDate: Date,
        timezone: string,
        mode: 'normal' | 'incremental' | 'full',
        notifications: StoredNotification[],
        baseUrl?: string
    ): Promise<DailyBriefData> {
        // Fetch cached summary
        let cached = this.notificationStore.getCachedSummary(targetDate, timezone);

        // Incremental or full regeneration when requested
        if (mode !== 'normal' && notifications.length > 0) {
            const forceFullRegeneration = mode === 'full';
            this.console.log(`[Daily Brief] ${mode} regeneration`);
            await this.generateDailyBriefInBackground(forceFullRegeneration);
            cached = this.notificationStore.getCachedSummary(targetDate, timezone);
        }

        // Format generation timestamp
        const generatedAt = cached?.generatedAt || null;
        const dateFormatted = generatedAt
            ? `Generated ${new Date(generatedAt).toLocaleString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZone: timezone
            })}`
            : 'No Daily Brief generated yet';

        // Format date in user's timezone (YYYY-MM-DD)
        const localDateStr = targetDate.toLocaleDateString('en-CA', { timeZone: timezone });

        // Build highlights with optional video clip and poster-quality snapshot URLs
        const highlights = (cached?.highlights || []).map(h => ({
            ...h,
            ...(baseUrl ? {
                clip: `${baseUrl}/brief/video?id=${encodeURIComponent(h.id)}`,
                thumbnail: h.thumbnail ? `${baseUrl}/brief/snapshot?id=${encodeURIComponent(h.id)}` : '',
            } : {})
        }));

        return {
            date: localDateStr,
            dateFormatted,
            summary: cached?.summary || 'No Daily Brief generated yet.',
            overview: cached?.overview,
            narrative: cached?.narrative,
            highlights,
            eventCount: notifications.length,
            hasDailyBrief: !!cached?.summary,
            generatedAt
        };
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const url = request.url || '';
        const path = url.replace(request.rootPath || '', '').split('?')[0];

        this.console.log(`[Daily Brief] Request: ${path}`);

        try {
        // HA card loader pattern: tiny loader at the registered URL dynamically
        // imports the real bundle with a version query param for cache busting.
        // Users register this URL once and never need to change it.
        if (path === '/assets/daily-brief-card.js') {
            const loader = `(async()=>{let b='';try{const m=import.meta.url.match(/(.*?)\\/assets\\/daily-brief-card\\.js(?:\\?|$)/);if(m)b=m[1];}catch(e){}if(!b){console.error('[daily-brief-card] Could not determine base URL. import.meta.url:',String(import.meta&&import.meta.url));return;}try{const r=await fetch(b+'/assets/card-version');const{version:v}=await r.json();await import(b+'/assets/daily-brief-card-bundle.js?v='+v);}catch(e){console.error('[daily-brief-card] Loader error:',e);await import(b+'/assets/daily-brief-card-bundle.js?t='+Date.now());}})();`;
            response.send(loader, {
                headers: {
                    'Content-Type': 'application/javascript',
                    'Cache-Control': 'no-cache',
                }
            });
            return;
        }

        // Version endpoint for the loader to check for updates
        if (path === '/assets/card-version') {
            response.send(JSON.stringify({ version: this.pluginVersion }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                }
            });
            return;
        }

        // Serve the actual HA card bundle with long-lived cache
        // (cache busted by version query param from the loader)
        if (path === '/assets/daily-brief-card-bundle.js') {
            const bundle = getHACardBundle();
            if (bundle) {
                response.send(bundle, {
                    headers: {
                        'Content-Type': 'application/javascript',
                        'Cache-Control': 'public, max-age=86400',
                    }
                });
            } else {
                response.send('throw new Error("HA card bundle not available");', {
                    code: 500,
                    headers: { 'Content-Type': 'application/javascript' }
                });
            }
            return;
        }

        // LLM Health dashboard JSON: per-provider reliability/latency/quality aggregates
        if (path === '/brief/poster-decisions') {
            // v0.3.120 diagnostic: returns the last N poster decisions so
            // operator can see which path produced (or failed to produce)
            // each event's poster, without needing Scrypted log access.
            try {
                const url = new URL(request.url || '/', 'http://localhost');
                const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100));
                const rows = await this.posterDecisionLog.loadRecent(limit);
                // Aggregate source-breakdown for quick scanning at the top.
                const breakdown: Record<string, number> = {};
                for (const r of rows) breakdown[r.source] = (breakdown[r.source] || 0) + 1;
                response.send(JSON.stringify({ generatedAt: Date.now(), count: rows.length, breakdown, rows }), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
                });
            } catch (e) {
                this.console.warn('[PosterDecisions] endpoint failed:', e);
                response.send(JSON.stringify({ error: String(e) }), {
                    code: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return;
        }

        if (path === '/brief/llm-health') {
            try {
                const [telemetry, judge] = await Promise.all([
                    this.telemetryLog.loadAll(),
                    this.judgeLog.loadAll(),
                ]);
                const now = Date.now();
                const minute = 60 * 1000;
                const hour = 60 * minute;
                const day = 24 * hour;
                const cutoff15m = now - 15 * minute;
                const cutoff1h = now - hour;
                const cutoff24h = now - day;
                const cutoff7d = now - 7 * day;
                const rows15m = telemetry.filter(r => r.ts >= cutoff15m);
                const rows1h = telemetry.filter(r => r.ts >= cutoff1h);
                const rows24 = telemetry.filter(r => r.ts >= cutoff24h);
                const rows7d = telemetry.filter(r => r.ts >= cutoff7d);
                const judge15m = judge.filter(j => j.ts >= cutoff15m);
                const judge1h = judge.filter(j => j.ts >= cutoff1h);
                const judge24 = judge.filter(j => j.ts >= cutoff24h);
                const judge7d = judge.filter(j => j.ts >= cutoff7d);
                const payload = {
                    generatedAt: now,
                    windows: {
                        '15m': aggregateTelemetry(rows15m, now, judge15m),
                        '1h': aggregateTelemetry(rows1h, now, judge1h),
                        '24h': aggregateTelemetry(rows24, now, judge24),
                        '7d': aggregateTelemetry(rows7d, now, judge7d),
                    },
                };
                response.send(JSON.stringify(payload), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
                });
            } catch (e) {
                this.console.warn('[LLM Health] Failed to build aggregates:', e);
                response.send(JSON.stringify({ error: String(e) }), {
                    code: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return;
        }

        // Debug endpoint to check cloud URL (authenticated)
        if (path === '/brief/cloud-url') {
            const cloudEndpoint = await endpointManager.getCloudEndpoint(this.nativeId);
            response.send(JSON.stringify({ cloudUrl: cloudEndpoint }), {
                headers: { 'Content-Type': 'application/json' }
            });
            return;
        }

        // Test notification endpoint - triggers the full Daily Brief notification pipeline
        if (path === '/brief/test-notification' && request.method === 'POST') {
            try {
                await this.generateAndNotifySummary();
                response.send(JSON.stringify({ success: true }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (e) {
                this.console.error('[Test Notification] Error:', e);
                response.send(JSON.stringify({ error: 'Test notification failed' }), {
                    code: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return;
        }

        // Handle timezone auto-detection from browser
        if (path === '/brief/set-timezone' && request.method === 'POST') {
            try {
                const urlObj = new URL(url, 'http://localhost');
                const tz = urlObj.searchParams.get('tz');
                if (tz) {
                    // Validate timezone string
                    Intl.DateTimeFormat(undefined, { timeZone: tz });
                    this.storage.setItem('dailyBriefTimezone', tz);
                    this.console.log(`Timezone auto-detected: ${tz}`);
                }
            } catch (e) {
                // Invalid timezone or other error — ignore
            }
            response.send('OK', { headers: { 'Content-Type': 'text/plain' } });
            return;
        }

        // Parse date from path: /brief/2024-01-15 or /brief for today
        // Also check for ?date=YYYY-MM-DD query parameter
        let targetDate = new Date();
        const dateMatch = path.match(/\/brief\/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
            targetDate = parseBriefDate(dateMatch[1]);
        } else {
            // Check query parameter
            try {
                const urlObj = new URL(url, 'http://localhost');
                const dateParam = urlObj.searchParams.get('date');
                if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
                    targetDate = parseBriefDate(dateParam);
                }
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Get timezone for display
        const timezone = this.storage.getItem('dailyBriefTimezone') || 'America/Los_Angeles';

        const dateStr = targetDate.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: timezone
        });

        // Clear all data endpoint
        if (path === '/brief/clear' && request.method === 'POST') {
            this.notificationStore.clear();
            this.console.log('[Daily Brief] Storage cleared via HTTP endpoint');
            response.send(JSON.stringify({ success: true, message: 'All notifications cleared' }), {
                headers: { 'Content-Type': 'application/json' }
            });
            return;
        }

        // HA Card API endpoint - returns data in format expected by daily-brief-card.js
        if (path === '/brief/ha-card') {
            const urlObj = new URL(url, 'http://localhost');
            // Parse mode: ?mode=incremental|full|normal (default: normal)
            // Legacy: ?refresh=true maps to mode=full
            const refreshParam = urlObj.searchParams.get('refresh') === 'true';
            const modeParam = urlObj.searchParams.get('mode');
            let mode: 'normal' | 'incremental' | 'full' = 'normal';
            if (modeParam === 'incremental' || modeParam === 'full') {
                mode = modeParam;
            } else if (modeParam) {
                this.console.warn(`[Daily Brief] Invalid mode="${modeParam}", defaulting to normal`);
            } else if (refreshParam) {
                mode = 'full';
            }
            const baseUrl = request.rootPath || '';
            const allNotifications = this.notificationStore.getForDate(targetDate, timezone);

            const data = await this.getDailyBriefData(targetDate, timezone, mode, allNotifications, baseUrl);

            response.send(JSON.stringify(data, null, 2), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
            return;
        }

        // Video clip endpoint - serves stored clips directly
        if (path === '/brief/video') {
            const urlObj = new URL(url, 'http://localhost');
            const notificationId = urlObj.searchParams.get('id') || '';
            const reqCameraId = urlObj.searchParams.get('cameraId') || '';
            const reqTime = urlObj.searchParams.get('time') || '';

            // Resolve the clip's camera + anchor time. A notification resolves via
            // the store (anchor = timestamp - 5s pre-roll). A Story has no
            // notificationId, so the client passes cameraId + time (the Story
            // start) directly. Notification path is unchanged.
            let clipCameraId = '';
            let clipStartTime = 0;
            if (notificationId) {
                const notification = this.notificationStore.getById(notificationId);
                if (!notification) {
                    this.console.warn(`[Video] Notification not found: ${notificationId}`);
                    response.send(JSON.stringify({ error: 'Notification not found' }), {
                        code: 404,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }
                clipCameraId = notification.cameraId;
                // v0.3.173: seek by the instant the poster used, not our handling
                // time. They differ by 44-300s on a Story, which is emitted when
                // the story completes, so the clip used to run minutes late while
                // the poster was correct.
                clipStartTime = (notification.seekTimestamp ?? notification.timestamp) - 5000;
            } else if (reqCameraId && reqTime) {
                const t = Number(reqTime);
                if (!Number.isFinite(t) || t <= 0) {
                    response.send(JSON.stringify({ error: 'Invalid time parameter' }), {
                        code: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }
                clipCameraId = reqCameraId;
                clipStartTime = t;
            }

            // If we resolved a camera + anchor, fetch the clip from NVR.
            if (clipCameraId && clipStartTime) {
                this.console.log(`[Video] START - clip for camera=${clipCameraId} @ ${new Date(clipStartTime).toISOString()}`);

                // Resolve the camera. Gate on METHOD PRESENCE, not the
                // VideoRecorder interface flag — UniFi Protect cameras expose a
                // working getRecordingStream but may not advertise the interface
                // (same bug as the v0.3.166 poster fix). The getRecordingStream
                // call below is wrapped in try/catch, so a camera that truly
                // can't serve fails cleanly.
                const camera = sdk.systemManager.getDeviceById<VideoRecorder & ScryptedDevice>(clipCameraId);
                this.console.log(`[Video] Camera found: ${!!camera}, interfaces: ${camera?.interfaces?.join(',')}`);

                if (!supportsRecordingStream(camera)) {
                    this.console.warn(`[Video] Camera ${clipCameraId} does not expose getRecordingStream`);
                    response.send(JSON.stringify({ error: 'Camera does not support video recording' }), {
                        code: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }

                const timeoutPromise = <T>(promise: Promise<T>, ms: number, name: string): Promise<T> => {
                    return Promise.race([
                        promise,
                        new Promise<T>((_, reject) =>
                            setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms)
                        )
                    ]);
                };

                try {
                    // Request a 25-second clip from the resolved anchor.
                    const startTime = clipStartTime;
                    const duration = 25000;

                    this.console.log(`[Video] Calling getRecordingStream: startTime=${new Date(startTime).toISOString()}, duration=${duration}ms`);

                    // With duration specified, this returns a downloadable stream (per SDK docs)
                    const recordingMedia = await timeoutPromise(
                        camera.getRecordingStream({ startTime, duration }),
                        30000,
                        'getRecordingStream'
                    );
                    this.console.log(`[Video] getRecordingStream returned`);

                    // Get FFmpegInput from the MediaObject
                    this.console.log(`[Video] Getting FFmpegInput...`);
                    const ffmpegInput = await mediaManager.convertMediaObjectToJSON<any>(recordingMedia, ScryptedMimeTypes.FFmpegInput);
                    this.console.log(`[Video] FFmpegInput URL: ${ffmpegInput?.url}`);

                    if (!ffmpegInput?.inputArguments) {
                        throw new Error('No FFmpegInput available from recording stream');
                    }

                    // Spawn FFmpeg to convert to streaming-compatible fragmented MP4
                    // Uses frag_keyframe+empty_moov for streaming-compatible fragmented MP4
                    this.console.log(`[Video] Spawning FFmpeg for streaming MP4...`);
                    const { spawn } = await import('child_process');

                    const ffmpegArgs = [
                        ...ffmpegInput.inputArguments,
                        '-t', '30',  // Limit to 30 seconds
                        '-c:v', 'copy',  // Copy video codec (no re-encoding)
                        '-c:a', 'aac',   // Re-encode audio to AAC for compatibility
                        '-movflags', '+frag_keyframe+empty_moov',
                        '-f', 'mp4',
                        'pipe:1'
                    ];

                    this.console.log(`[Video] FFmpeg args: ${ffmpegArgs.slice(0, 5).join(' ')}...`);

                    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
                        stdio: ['ignore', 'pipe', 'pipe']
                    });

                    let stderrOutput = '';
                    ffmpeg.stderr.on('data', (data: Buffer) => {
                        stderrOutput += data.toString();
                        if (stderrOutput.length > 10000) {
                            stderrOutput = stderrOutput.slice(-10000);
                        }
                    });

                    const console = this.console;

                    // Capture exit code promise BEFORE consuming stdout to avoid race condition
                    const exitCodePromise = new Promise<number | null>((resolve) => {
                        ffmpeg.on('close', resolve);
                    });

                    // Stream FFmpeg output directly to the HTTP response via async generator
                    async function* streamFfmpegOutput(): AsyncGenerator<Buffer, void> {
                        let totalBytes = 0;
                        let timedOut = false;
                        const timeout = setTimeout(() => {
                            timedOut = true;
                            ffmpeg.kill('SIGKILL');
                        }, 60000);

                        try {
                            for await (const chunk of ffmpeg.stdout) {
                                totalBytes += chunk.length;
                                yield chunk as Buffer;
                            }
                        } finally {
                            clearTimeout(timeout);
                        }

                        const exitCode = await exitCodePromise;

                        if (timedOut) {
                            console.error(`[Video] FFmpeg timed out after 60 seconds`);
                        } else if (exitCode !== 0) {
                            console.error(`[Video] FFmpeg exited with code ${exitCode}: ${stderrOutput.slice(-500)}`);
                        }
                        console.log(`[Video] Streamed clip: ${totalBytes} bytes`);
                    }

                    response.sendStream(streamFfmpegOutput(), {
                        headers: {
                            'Content-Type': 'video/mp4',
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'public, max-age=3600'
                        }
                    });
                    return;
                } catch (e: any) {
                    this.console.error(`[Video] Error fetching clip from NVR:`, e);
                    response.send(JSON.stringify({ error: 'Failed to fetch video' }), {
                        code: 500,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }
            }

            // No usable clip reference (neither notification id nor cameraId+time)
            response.send(JSON.stringify({ error: 'Missing id or cameraId+time parameter' }), {
                code: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
            return;
        }

        // Snapshot endpoint - serves poster-quality image:
        // 1. posterStore (disk read, pre-generated at detection time)
        // 2. 404 (no image data)
        if (path === '/brief/snapshot') {
            const urlObj = new URL(url, 'http://localhost');
            const notificationId = urlObj.searchParams.get('id') || '';

            if (!notificationId) {
                response.send(JSON.stringify({ error: 'Missing notification id parameter' }), {
                    code: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
                return;
            }

            const notification = this.notificationStore.getById(notificationId);
            if (!notification) {
                response.send(JSON.stringify({ error: 'Notification not found' }), {
                    code: 404,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
                return;
            }

            try {
                // 1. Check disk-persisted poster first (fast, no camera lookup needed)
                const poster = await this.posterStore.get(notificationId);
                if (poster) {
                    this.console.log(`[Poster] Disk HIT: ${notificationId} (${Math.round(poster.length / 1024)}KB)`);
                    response.send(poster, {
                        headers: {
                            'Content-Type': 'image/jpeg',
                            'Content-Length': poster.length.toString(),
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'public, max-age=3600'
                        }
                    });
                    return;
                }

                // 2. No image data at all
                this.console.log(`[Poster] Disk MISS: ${notificationId}`);
                response.send(JSON.stringify({ error: 'No snapshot available' }), {
                    code: 404,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
                return;
            } catch (e: any) {
                this.console.error(`[Poster] Error fetching snapshot:`, e);
                response.send(JSON.stringify({ error: 'Failed to fetch snapshot' }), {
                    code: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
                return;
            }
        }

        // WebRTC signaling endpoint - HTTP-based SDP exchange (no WebSocket)
        // Browser sends offer, we get answer from camera via RTCSignalingChannel
        if (path === '/brief/webrtc-signal') {
            // Handle CORS preflight
            if (request.method === 'OPTIONS') {
                response.send('', {
                    code: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    }
                });
                return;
            }

            try {
                const body = JSON.parse(request.body || '{}');
                const { notificationId, offer } = body;

                if (!offer?.sdp) {
                    response.send(JSON.stringify({ error: 'Missing offer.sdp' }), {
                        code: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }

                // Resolve camera + anchor time from either a notificationId (store
                // lookup, anchor = timestamp - 5s) or an explicit cameraId+time
                // (Stories, which have no notificationId). Mirrors /brief/video.
                let clipCameraId = '';
                let clipStartTime = 0;
                if (notificationId) {
                    const notification = this.notificationStore.getById(notificationId);
                    if (!notification) {
                        response.send(JSON.stringify({ error: 'Notification not found' }), {
                            code: 404,
                            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                        });
                        return;
                    }
                    clipCameraId = notification.cameraId;
                    // v0.3.173: seek by the instant the poster used, not our handling
                    // time. They differ by 44-300s on a Story, which is emitted
                    // when the story completes, so the clip used to run minutes
                    // late while the poster was correct.
                    clipStartTime = (notification.seekTimestamp ?? notification.timestamp) - 5000;
                } else if (body.cameraId && body.time) {
                    const t = Number(body.time);
                    if (!Number.isFinite(t) || t <= 0) {
                        response.send(JSON.stringify({ error: 'Invalid time' }), {
                            code: 400,
                            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                        });
                        return;
                    }
                    clipCameraId = body.cameraId;
                    clipStartTime = t;
                } else {
                    response.send(JSON.stringify({ error: 'Missing notificationId or cameraId+time' }), {
                        code: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }

                this.console.log(`[WebRTC] Starting signaling for camera=${clipCameraId} @ ${new Date(clipStartTime).toISOString()}`);

                // Resolve the camera. Gate on METHOD PRESENCE, not the
                // VideoRecorder interface flag (see the HTTP-replay handler
                // above and the v0.3.166 poster fix). getRecordingStream is
                // called inside this handler's outer try/catch.
                const camera = sdk.systemManager.getDeviceById<VideoRecorder & ScryptedDevice>(clipCameraId);
                if (!supportsRecordingStream(camera)) {
                    response.send(JSON.stringify({ error: 'Camera does not support video recording' }), {
                        code: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }

                // Request a 25-second clip from the resolved anchor.
                const startTime = clipStartTime;
                const duration = 25000;

                this.console.log(`[WebRTC] Getting recording stream: startTime=${new Date(startTime).toISOString()}, duration=${duration}ms`);

                // Get recording stream as MediaObject
                // Set playbackRate: 1 to ensure 1x speed playback (default may be faster for recordings)
                const recordingMedia = await camera.getRecordingStream({ startTime, duration, playbackRate: 1 });

                // Convert MediaObject to RTCSignalingChannel
                // The WebRTC plugin's */* → RTCSignalingChannel converter handles this
                const channel = await mediaManager.convertMediaObject<RTCSignalingChannel>(
                    recordingMedia,
                    ScryptedMimeTypes.RTCSignalingChannel
                );

                if (!channel) {
                    throw new Error('Failed to convert media to RTCSignalingChannel');
                }

                // Create signaling session using proper class (required for RPC serialization)
                const session = new WebRTCSignalingSession({ type: 'offer', sdp: offer.sdp });

                // Start the signaling session
                await channel.startRTCSignalingSession(session);

                // Wait for the answer (with timeout)
                const timeoutMs = 20000;
                const answer = await Promise.race([
                    session.deferred.promise,
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('Timeout waiting for WebRTC answer')), timeoutMs)
                    )
                ]);

                if (!answer?.description?.sdp) {
                    throw new Error('Failed to get answer SDP');
                }

                this.console.log(`[WebRTC] Signaling complete, returning answer`);

                response.send(JSON.stringify({
                    answer: {
                        type: answer.description.type,
                        sdp: answer.description.sdp
                    }
                }), {
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
                return;

            } catch (e: any) {
                this.console.error(`[WebRTC] Signaling error:`, e);
                response.send(JSON.stringify({ error: 'WebRTC signaling failed' }), {
                    code: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
                return;
            }
        }

        // People endpoint
        if (path === '/brief/people') {
            const enableFaceId = this.storageSettings.values.enableLlmFaceId === true;
            const result = await handlePeopleRequest(this.personStore, enableFaceId, request.rootPath || '');
            response.send(result.body, {
                code: result.code,
                headers: { 'Content-Type': result.contentType, 'Access-Control-Allow-Origin': '*' }
            });
            return;
        }

        // People photo endpoint
        if (path === '/brief/people/photo') {
            const result = await handlePeoplePhotoRequest(url, this.personStore);
            if (Buffer.isBuffer(result.body)) {
                response.send(result.body as Buffer, {
                    code: result.code,
                    headers: {
                        'Content-Type': result.contentType,
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': result.cacheControl || '',
                    }
                });
            } else {
                response.send(result.body as string, {
                    code: result.code,
                    headers: { 'Content-Type': result.contentType, 'Access-Control-Allow-Origin': '*' }
                });
            }
            return;
        }

        // People delete endpoint (POST only to prevent CSRF)
        if (path === '/brief/people/delete' && request.method === 'POST') {
            const result = await handlePeopleDeleteRequest(url, this.personStore);
            response.send(result.body, {
                code: result.code,
                headers: { 'Content-Type': result.contentType, 'Access-Control-Allow-Origin': '*' }
            });
            return;
        }

        // Gallery SSE endpoint — pushes events when new notifications arrive
        if (path === '/brief/gallery/sse') {
            const keepaliveMs = 30_000;
            const console = this.console;

            async function* sseGenerator(store: { onAdd: (fn: () => void) => () => void }) {
                let pending = false;
                let wakeResolve: ((r: string) => void) | null = null;
                const unsub = store.onAdd(() => {
                    pending = true;
                    if (wakeResolve) { wakeResolve('notification'); wakeResolve = null; }
                });
                let keepaliveResolve: (() => void) | null = null;
                yield Buffer.from(': connected\n\n');
                let keepaliveTimer: NodeJS.Timeout | null = null;
                try {
                    keepaliveTimer = setInterval(() => { if (keepaliveResolve) keepaliveResolve(); }, keepaliveMs);
                    while (true) {
                        const reason = pending
                            ? 'notification'
                            : await new Promise<string>(resolve => {
                                wakeResolve = resolve;
                                keepaliveResolve = () => { keepaliveResolve = null; resolve('keepalive'); };
                            });
                        pending = false;
                        if (reason === 'notification') {
                            yield Buffer.from('data: new-notification\n\n');
                        } else {
                            yield Buffer.from(': keepalive\n\n');
                        }
                    }
                } finally {
                    unsub();
                    if (keepaliveTimer) clearInterval(keepaliveTimer);
                    console.log('[SSE] Client disconnected');
                }
            }

            this.console.log('[SSE] Client connected');
            response.sendStream(sseGenerator(this.notificationStore), {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                }
            });
            return;
        }

        // Gallery data endpoint
        if (path === '/brief/gallery/data') {
            const result = await handleGalleryDataRequest(url, this.notificationStore, request.rootPath || '');
            response.send(result.body, {
                code: result.code,
                headers: { 'Content-Type': result.contentType, 'Access-Control-Allow-Origin': '*' }
            });
            return;
        }

        // Gallery search endpoint
        if (path === '/brief/gallery/search') {
            if (request.method === 'OPTIONS') {
                response.send('', {
                    code: 200,
                    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
                });
                return;
            }
            const retentionDaysRaw = parseInt(this.storage.getItem('retentionDays') || '3', 10);
            const geminiApiKey = this.storageSettings.values.geminiEmbeddingApiKey;
            const geminiConfig = geminiApiKey ? { apiKey: geminiApiKey } : undefined;
            const result = await handleGallerySearchRequest(request.body || '{}', this.notificationStore, request.rootPath || '', isNaN(retentionDaysRaw) ? 3 : retentionDaysRaw, geminiConfig);
            response.send(result.body, {
                code: result.code,
                headers: { 'Content-Type': result.contentType, 'Access-Control-Allow-Origin': '*' }
            });
            return;
        }

        if (path === '/brief' || path.startsWith('/brief/')) {
            const allNotifications = this.notificationStore.getForDate(targetDate, timezone);
            const urlObj = new URL(request.url || '', 'http://localhost');
            // Parse mode: ?mode=incremental|full|normal (default: normal)
            // Legacy: ?refresh=true maps to mode=full
            const refreshParam = urlObj.searchParams.get('refresh') === 'true';
            const modeParam = urlObj.searchParams.get('mode');
            let mode: 'normal' | 'incremental' | 'full' = 'normal';
            if (modeParam === 'incremental' || modeParam === 'full') {
                mode = modeParam;
            } else if (modeParam) {
                this.console.warn(`[Daily Brief] Invalid mode="${modeParam}", defaulting to normal`);
            } else if (refreshParam) {
                mode = 'full';
            }

            this.console.log(`[Daily Brief] ${allNotifications.length} notifications, mode=${mode}`);

            // Check for JSON API request (keep simple - doesn't need full DailyBriefData)
            if (path.endsWith('/api') || urlObj.searchParams.get('format') === 'json') {
                const stats = this.notificationStore.getStats(targetDate, timezone);
                const cached = this.notificationStore.getCachedSummary(targetDate, timezone);
                response.send(JSON.stringify({ date: dateStr, stats, notifications: allNotifications, summary: cached?.summary, highlights: cached?.highlights }, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                });
                return;
            }

            // Use shared helper for data fetching and transformation
            // Don't pass baseUrl — web UI derives it at runtime from window.location.pathname
            const data = await this.getDailyBriefData(targetDate, timezone, mode, allNotifications);

            // Date-selector bounds (timezone-aware YYYY-MM-DD). selectedDate is the
            // day being viewed; max = today; min = today - retentionDays, so every
            // selectable day still has full timeline + image data (the /brief route
            // already honors ?date=YYYY-MM-DD — this just drives the header control).
            const retentionDaysRaw = parseInt(this.storage.getItem('retentionDays') || '3', 10);
            const retentionDays = isNaN(retentionDaysRaw) ? 3 : Math.max(1, retentionDaysRaw);
            const selectedDate = targetDate.toLocaleDateString('en-CA', { timeZone: timezone });
            const maxDate = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
            const minDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
                .toLocaleDateString('en-CA', { timeZone: timezone });

            // HTML response
            this.console.log(`[Daily Brief] Generating HTML response (narrative: ${data.narrative?.length || 0} segments)`);
            const html = generateDailyBriefHTML(
                data.eventCount,
                data.hasDailyBrief ? data.summary : null,
                data.highlights,
                data.generatedAt,
                timezone,
                data.overview,
                data.narrative,
                this.pluginVersion,
                this.cachedCloudEndpoint || undefined,
                (this.storageSettings.values as any).haNvrTimelinePath || undefined,
                selectedDate,
                minDate,
                maxDate,
            );
            this.console.log(`[Daily Brief] Sending HTML (${html.length} bytes)`);
            response.send(html, {
                headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
            });
            return;
        }

        // Default: redirect to /brief
        response.send(`<html><head><meta http-equiv="refresh" content="0;url=${request.rootPath}/brief"></head></html>`, {
            headers: { 'Content-Type': 'text/html' }
        });
        } catch (e) {
            this.console.error(`[Daily Brief] Unhandled error in request handler:`, e);
            // Return JSON for API endpoints, plain text for HTML
            if (path.includes('/video') || path.includes('/api') || path.includes('format=json')) {
                response.send(JSON.stringify({ error: 'Internal server error' }), {
                    code: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            } else {
                response.send('Internal error', {
                    code: 500,
                    headers: { 'Content-Type': 'text/plain' }
                });
            }
        }
    }

    storageSettings = new StorageSettings(this, {
        enabled: {
            title: 'Enable Notifications',
            type: 'boolean',
            description: 'Enhance notifications with LLM-generated titles and descriptions. When off, the plugin passes the original notification through unchanged. To stop them entirely, disable the LLM Notifier extension on this notifier device in Scrypted\'s device list.',
            defaultValue: true,
            group: 'Notifications',
        },
        snapshotMode: {
            title: 'Snapshot Mode',
            description: "Which image(s) to send to the LLM. 'full' (default) sends the full event frame — required for the LLM to pick the poster focus box so the notification thumbnail matches the description. 'cropped' sends only Scrypted's tight detection thumbnail (no poster focus box; poster falls back to the heuristic crop). 'both' sends the full frame AND the tight crop (best detail for distant subjects, at ~2x image cost per notification).",
            type: 'string',
            choices: ['cropped', 'full', 'both'],
            defaultValue: 'full',
            group: 'Notifications',
        },
        llmTimeoutMs: {
            title: 'LLM Timeout (sec)',
            description: 'Maximum seconds to wait for the LLM before falling back to original notification.',
            type: 'number',
            defaultValue: 90,
            group: 'Notifications',
        },
        chatCompletions: {
            title: 'LLM Providers',
            description: 'Select multiple LLM providers to distribute load. Install the LLM plugin to add external providers or run local LLM servers.',
            type: 'device',
            deviceFilter: `interfaces.includes('ChatCompletion')`,
            multiple: true,
            group: 'General',
        },
        notificationLlm: {
            title: 'Notification LLM',
            description: 'Optional: use dedicated models for enriching individual detections (e.g., a fast local LLM). '
                + 'Daily Brief and Person ID always use the main LLM Providers. '
                + 'If not set, all features use LLM Providers.',
            type: 'device',
            deviceFilter: `interfaces.includes('ChatCompletion')`,
            multiple: true,
            group: 'General',
        },
        userPrompt: {
            title: 'Notification Style',
            type: 'textarea',
            description: 'Optional: override the built-in wording instructions for how notifications describe detections.',
            group: 'Notifications',
            defaultValue: `STYLE PREFERENCES:

Title: Include person names ONLY when provided in metadata, otherwise use generic terms
- When name known: "<name> at front door"
- When name unknown: "Person at front door"
- For vehicles: Include make/model and license plate only if clearly visible

Subtitle: Category marker
- Format: "[Type] • [Area]"
- Examples: "Person • Indoor", "Vehicle • Street"

Body: Focus on actions and key visual details
- Describe what's happening in the scene
- Include relevant clothing, objects, or movements
- For vehicles: Include make, model, and license plate details when visible
- Examples:
  "Walking toward garage while checking phone and carrying a shopping bag"
  "White Tesla Model 3 (ABC123) pulling slowly into driveway"
  "Tall figure in blue jacket with package approaching and ringing doorbell"

Common locations: driveway, street, kitchen, living room, front door, yard, garage

Avoid generic phrases like "motion detected" or "person detected"`,
        },
        includeOriginalMessage: {
            title: 'Include Original Message',
            type: 'boolean',
            description: 'Include the original notification text in the LLM prompt for context',
            defaultValue: true,
            group: 'Notifications',
        },
        enableLlmFaceId: {
            title: 'LLM Person Identification',
            type: 'boolean',
            description: 'Optional: auto-curates reference photos from Scrypted face identifications, then uses the LLM to identify unrecognized persons by comparing against known faces.',
            defaultValue: false,
            group: 'Notifications',
        },
        verboseLogging: {
            title: 'Verbose Logging',
            type: 'boolean',
            description: 'Log detailed debug information including full LLM responses, image resize stats, and notification processing details.',
            defaultValue: false,
            group: 'Advanced',
        },
        llmTelemetryRetentionDays: {
            title: 'LLM Telemetry Retention (days)',
            type: 'number',
            description: 'How long to keep per-call LLM telemetry rows (latency/outcome/quality scores). Used by the LLM Health tab.',
            defaultValue: 14,
            group: 'LLM Health',
        },
        llmJudgeSampleRate: {
            title: 'Judge Sample Rate',
            type: 'number',
            description: 'Optional: fraction (0–1) of notification LLM calls to re-evaluate with the Judge provider for accuracy/completeness scoring. 0 = off.',
            defaultValue: 0,
            group: 'LLM Health',
        },
        llmJudgeProvider: {
            title: 'Judge LLM Provider',
            type: 'device',
            deviceFilter: `interfaces.includes('ChatCompletion')`,
            description: 'Optional: LLM provider used to grade notification enrichment output. Only used when Judge Sample Rate is above 0. Leave unset and nothing is graded — a judge is never chosen for you, because a model grading its own output is a weak check that still costs a call. Pick the same provider as your notification LLM if that is genuinely what you want.',
            group: 'LLM Health',
        },
        dailyBriefUrl: {
            title: 'Daily Brief URL',
            type: 'html',
            description: 'Opens the Daily Brief page - requires Scrypted login',
            group: 'General',
        },
        haCardSetup: {
            title: 'HA Card Setup',
            type: 'html',
            description: 'Instructions to add the Daily Brief card to Home Assistant',
            group: 'Home Assistant',
        },
        dailyBriefEnabled: {
            title: 'Enable Daily Brief Notifications',
            type: 'boolean',
            description: 'Optional: send a notification with the daily summary at the scheduled time.',
            defaultValue: false,
            group: 'Daily Brief',
        },
        dailyBriefTimezone: {
            title: 'Timezone',
            type: 'string',
            description: 'Your local timezone (auto-detected when you visit the Daily Brief page)',
            defaultValue: 'America/Los_Angeles',
            group: 'Daily Brief',
        },
        dailyBriefHour: {
            title: 'Notification Time (Hour)',
            type: 'number',
            description: 'Optional: hour to send the daily brief (24h format, e.g., 20 = 8pm). Only used when Enable Daily Brief Notifications is on.',
            defaultValue: 20,
            group: 'Daily Brief',
        },
        dailyBriefNotifier: {
            title: 'Notifier for Daily Brief',
            type: 'device',
            deviceFilter: `interfaces.includes('Notifier')`,
            description: 'Select which notifier to use for Daily Brief notifications',
            group: 'Daily Brief',
        },
        dailyBriefTestNotification: {
            title: 'Test Notification',
            type: 'button',
            description: 'Send a test notification to verify your notifier is working',
            group: 'Daily Brief',
        },
        dailyBriefNotificationUrl: {
            title: 'Notification Click URL',
            type: 'string',
            description: 'URL to open when notification is tapped. Set to the HA dashboard path where your Daily Brief card lives.',
            defaultValue: '/daily-brief/0',
            group: 'Home Assistant',
        },
        enablePerEventBriefClick: {
            title: 'Open Event on Tap (HA only)',
            type: 'boolean',
            description: 'HA notifiers only: tapping an enhanced notification opens the dashboard (set above) at that event in the Activity tab. Scrypted iPhone/Mac notifications are unaffected — the Scrypted app\'s closed NVR SPA has no route for plugin pages.',
            defaultValue: false,
            group: 'Home Assistant',
        },
        haNvrTimelinePath: {
            title: 'HA NVR Timeline Path',
            type: 'string',
            description: 'Optional: HA dashboard path that hosts a scrypted-nvr-iframe-card (e.g. /scrypted or /lovelace/scrypted/0). When set, the Daily Brief modal adds a "View in HA NVR Timeline" link that navigates HA to this path with ?camera=&time= query params — opens inside HA Companion (single tab on iPhone). Leave empty to disable the in-HA link; the Cloud "View in NVR Timeline" link remains either way.',
            defaultValue: '',
            group: 'Home Assistant',
        },
        dailyBriefGenerationInterval: {
            title: 'Background Generation Interval',
            type: 'number',
            description: 'How often to regenerate the Daily Brief summary in the background (in minutes). Set to 0 to disable.',
            defaultValue: 60,
            placeholder: '60',
            group: 'Daily Brief',
        },
        dailyBriefCustomPrompt: {
            title: 'Custom Instructions',
            type: 'textarea',
            description: 'Add custom context for the Daily Brief. e.g. "The small white dog is Rex" or "Ignore cars on the Sidewalk camera"',
            defaultValue: '',
            group: 'Daily Brief',
        },
        retentionDays: {
            title: 'Activity Retention (Days)',
            type: 'number',
            description: 'How many days to keep notifications, posters, and embeddings (default: 3)',
            defaultValue: 3,
            group: 'Activity',
        },
        geminiEmbeddingApiKey: {
            title: 'Gemini Embedding API Key',
            description: 'Optional: API key for Gemini multimodal embeddings (gemini-embedding-2-preview). Enables semantic search over both image and text; without it search falls back to keywords. Get a key at https://aistudio.google.com/apikey',
            type: 'password',
            group: 'Activity',
        },
    });

    async getSettings() {
        // Refresh endpoint cache in background (keeps URLs fresh without blocking)
        this.refreshEndpointCache();

        const settings: any[] = await this.storageSettings.getSettings();
        const byKey = new Map<string, any>();
        for (const s of settings) {
            if (s?.key)
                byKey.set(s.key, s);
        }

        // Populate Daily Brief URLs from cache (no network calls — fast getSettings)
        const urlSetting = byKey.get('dailyBriefUrl');
        if (urlSetting) {
            const links: string[] = [];
            if (this.cachedLocalEndpoint) {
                // Local link: relative path only — the SDK returns an absolute URL
                // with IP:port but users may access Scrypted via hostname or reverse
                // proxy on LAN. Relative URL resolves to whatever host the user is
                // viewing this settings page from, which is the right local target.
                const localPath = new URL(this.cachedLocalEndpoint).pathname.replace(/\/+$/, '');
                links.push(`<a href="${localPath}/brief" target="_blank">Open Daily Brief (local)</a>`);
            }
            if (this.cachedCloudEndpoint) {
                // Cloud link: absolute URL from the SDK. Works when this settings
                // page is opened from a Scrypted Cloud admin host (where a relative
                // URL would resolve against a host that doesn't proxy plugin
                // endpoints — see GitHub Pages 404 reproducer 2026-05-04).
                const cloudUrl = `${this.cachedCloudEndpoint.replace(/\/+$/, '')}/brief`;
                links.push(`<a href="${cloudUrl}" target="_blank">Open Daily Brief (cloud)</a>`);
            }
            urlSetting.value = links.length > 0 ? links.join(' &middot; ') : '(URL not available yet)';
        }


        // Populate HA Card setup instructions
        const haSetupSetting = byKey.get('haCardSetup');
        if (haSetupSetting) {
            // Link only. The YAML for both cards lives in the README's Home
            // Assistant section — a settings panel is a poor place to read
            // setup instructions, and duplicating them guarantees drift.
            haSetupSetting.value = `
<div style="font-size: 12px; line-height: 1.5;">
See the <a href="https://github.com/rmaher001/scrypted-llm-notifier#home-assistant" target="_blank">README</a>
to add the Daily Brief card, and the optional NVR timeline card that the setting below points at.
</div>`;
        }

        // Every defined setting must appear here, or it falls through to the
        // "leftovers" append below and lands in an arbitrary spot. A key that
        // is NOT a setting resolves to nothing and is silently skipped — which
        // is how 'promptUpdateInfo' survived here for months after its setting
        // was removed. Both directions are asserted by
        // tests/settings-organization.test.ts.
        const orderedKeys = [
            // General — shared infrastructure
            'chatCompletions',
            'notificationLlm',
            'dailyBriefUrl',
            // Notifications
            'enabled',
            'userPrompt',
            'snapshotMode',
            'includeOriginalMessage',
            'llmTimeoutMs',
            'enableLlmFaceId',
            // Daily Brief
            'dailyBriefEnabled',
            'dailyBriefNotifier',
            'dailyBriefTestNotification',
            'dailyBriefTimezone',
            'dailyBriefHour',
            'dailyBriefGenerationInterval',
            'dailyBriefCustomPrompt',
            // Activity
            'retentionDays',
            'geminiEmbeddingApiKey',
            // Home Assistant
            'haCardSetup',
            'dailyBriefNotificationUrl',
            'enablePerEventBriefClick',
            'haNvrTimelinePath',
            // LLM Health
            'llmTelemetryRetentionDays',
            'llmJudgeSampleRate',
            'llmJudgeProvider',
            // Advanced
            'verboseLogging',
        ];
        const ordered: any[] = [];
        for (const k of orderedKeys) {
            const s = byKey.get(k);
            if (s) ordered.push(s);
        }
        // append any leftovers
        for (const s of settings) {
            if (!ordered.includes(s))
                ordered.push(s);
        }
        return ordered;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'dailyBriefTestNotification') {
            await this.sendTestNotification();
            return;
        }

        await this.storageSettings.putSetting(key, value);

        // Restart timers if relevant settings changed
        if (key === 'dailyBriefGenerationInterval') {
            this.startDailyBriefTimer();
        } else if (key === 'dailyBriefEnabled' || key === 'dailyBriefHour' || key === 'dailyBriefTimezone') {
            if (key === 'dailyBriefTimezone') {
                this.notificationStore.setTimezone(String(value || '') || undefined);
                this.notificationStore.pruneNow();
            }
            this.scheduleDailySummary();
        } else if (key === 'retentionDays') {
            const days = Number(value) || 3;
            this.notificationStore.setRetentionDays(days);
            this.notificationStore.pruneNow();
            this.startPruneTimer();
        }
    }

    private async sendTestNotification() {
        this.console.log('[Daily Brief] Test notification triggered');
        await this.generateAndNotifySummary();
    }

    selectProvider() {
        const providerIds = this.storageSettings.values.chatCompletions;
        if (!providerIds || !providerIds.length) {
            throw new Error('No LLM providers selected');
        }
        
        const providerId = providerIds[this.currentProviderIndex];
        this.currentProviderIndex = (this.currentProviderIndex + 1) % providerIds.length;
        
        return sdk.systemManager.getDeviceById(providerId) as ScryptedDevice & ChatCompletion;
    }

    selectNotificationProvider(): ScryptedDevice & ChatCompletion {
        const providerIds = (this.storageSettings.values as any).notificationLlm as string[] | undefined;
        if (!providerIds?.length) {
            return resolveNotificationProvider(undefined, () => this.selectProvider());
        }
        const providerId = providerIds[this.currentNotificationProviderIndex % providerIds.length];
        this.currentNotificationProviderIndex = (this.currentNotificationProviderIndex + 1) % providerIds.length;
        const device = sdk.systemManager.getDeviceById(providerId) as ScryptedDevice & ChatCompletion;
        return resolveNotificationProvider(device, () => this.selectProvider());
    }

    // Selects the configured judge LLM device. Unset means judging is SKIPPED --
    // see resolveJudgeProvider for why there is no fallback to the main provider.
    private selectJudgeProvider(): (ScryptedDevice & ChatCompletion) | undefined {
        const judgeId = (this.storageSettings.values as any).llmJudgeProvider as string | undefined;
        return resolveJudgeProvider(judgeId, id =>
            sdk.systemManager.getDeviceById(id) as (ScryptedDevice & ChatCompletion) | undefined);
    }

    // Fire-and-forget: sampled judge evaluation of a notification enrichment.
    // Never throws, never awaited by caller. Writes a row to judgeLog on success.
    maybeRunJudge(args: {
        telemetryId: string;
        enriched: {
            title: string;
            subtitle: string;
            body: string;
            detailedDescription: string;
            identifiedPersons?: Array<{ name: string; confidence: number }> | null;
        };
        imageDataUrl: string;
        referenceImages?: Map<string, string>;
        verbose?: boolean;
    }): void {
        try {
            const rateRaw = (this.storageSettings.values as any).llmJudgeSampleRate;
            const rate = typeof rateRaw === 'number' ? rateRaw : parseFloat(String(rateRaw ?? 0));
            if (!shouldSampleForJudging(rate)) return;

            if (!args.imageDataUrl || !args.imageDataUrl.startsWith('data:image')) {
                if (args.verbose) this.console.log('[Judge] Skipping — no inline image data URL');
                return;
            }

            const provider = this.selectJudgeProvider();
            if (!provider) {
                // NOT gated on verboseLogging (default off). This is the only
                // signal a user gets that Judge Sample Rate is set but inert,
                // and the LLM Health Judge panel simply vanishes rather than
                // explaining itself. Latched so it says it once per load.
                if (!this.judgeInertWarned) {
                    this.judgeInertWarned = true;
                    // Covers both inert states: nothing selected, and a
                    // selected device that no longer exists (deleted/renamed).
                    this.console.warn('[Judge] Judge Sample Rate is above 0 but the Judge LLM Provider is not set, or the selected device no longer exists — nothing is being graded. Pick a provider in settings; a judge is never chosen for you.');
                }
                return;
            }

            const claimedPersonNames = (args.enriched.identifiedPersons || []).map(p => p.name);
            const refImages = new Map<string, string>();
            if (args.referenceImages) {
                for (const name of claimedPersonNames) {
                    const img = args.referenceImages.get(name);
                    if (img) refImages.set(name, img);
                }
            }

            const input: JudgeInput = {
                imageDataUrl: args.imageDataUrl,
                subjectTitle: args.enriched.title,
                subjectSubtitle: args.enriched.subtitle,
                subjectBody: args.enriched.body,
                subjectDetailedDescription: args.enriched.detailedDescription,
                claimedPersonNames,
                referenceImages: refImages,
            };

            const timeoutMs = Math.max(1, Number((this.storageSettings.values as any).llmTimeoutMs ?? 90)) * 1000;

            // Fire-and-forget.
            runJudge({ subjectId: args.telemetryId, provider, input, timeoutMs })
                .then(row => this.judgeLog.append(row))
                .then(() => { if (args.verbose) this.console.log(`[Judge] Recorded evaluation for ${args.telemetryId}`); })
                .catch(err => this.console.warn('[Judge] Evaluation failed:', err));
        } catch (err) {
            try { this.console.warn('[Judge] Setup failed:', err); } catch { /* ignore */ }
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]) {
        if (type === ScryptedDeviceType.Notifier && interfaces?.includes(ScryptedInterface.Notifier))
            return [ScryptedInterface.Notifier];
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        const ret = new LLMNotifier({
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
        });
        ret.llmProvider = this;
        return ret;
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
    }
}
