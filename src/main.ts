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
import { withTimeout, resizeJpegNearest, getJpegDimensions } from './utils';

import {
    StoredNotification,
    NarrativeSegment,
    DailyBriefData,
    FrozenSegment,
    CandidateWithPriority
} from './types';
import { NotificationStore } from './notification-store';
import { buildCachedHighlights } from './daily-brief/highlights';
import { createTimeBuckets, isVehicleNotification, selectCandidatesFromBuckets } from './daily-brief/candidate-selection';
import { getNaturalPeriods, matchSegmentToPeriod, buildFrozenContext, createSummaryPrompt } from './daily-brief/prompts';
import { generateDailyBriefHTML, getHACardBundle } from './daily-brief/html-generator';
import { LLMNotifier } from './llm-notifier';
import { PosterStore } from './poster-store';
import { handleGalleryDataRequest, handleGallerySearchRequest, handleThumbnailRequest, findTextEmbeddingProvider } from './gallery';

export default class LLMNotifierProvider extends ScryptedDeviceBase implements MixinProvider, Settings, HttpRequestHandler {
    private currentProviderIndex = 0;
    private summaryScheduleTimeout: NodeJS.Timeout | undefined;
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
    inFlightRequests = new Map<string, Promise<{title: string, subtitle: string, body: string, detailedDescription: string, clarity?: {score: number, reason: string}}>>();
    posterStore: PosterStore;
    notificationStore: NotificationStore;
    private pluginVersion: string;

    constructor(nativeId?: string) {
        super(nativeId);
        this.notificationStore = new NotificationStore(this.storage);
        this.posterStore = new PosterStore(() => mediaManager.getFilesPath());
        try {
            this.pluginVersion = require('../package.json').version;
        } catch {
            this.pluginVersion = 'unknown';
        }

        // Wire configurable retention (storageSettings not available in constructor)
        const retentionDaysRaw = parseInt(this.storage.getItem('retentionDays') || '3', 10);
        this.notificationStore.setRetentionDays(isNaN(retentionDaysRaw) ? 3 : retentionDaysRaw);

        // Prune orphaned poster files (fire-and-forget)
        const validIds = this.notificationStore.getAllIds();
        this.posterStore.prune(validIds).then(n => {
            if (n > 0) this.console.log(`[Poster] Pruned ${n} orphaned posters`);
        }).catch(e => this.console.warn('[Poster] Prune failed:', e));

        // Log endpoint URL on startup
        this.logEndpoint();

        // Schedule daily brief notification
        this.scheduleDailySummary();

        // Start background generation timer
        this.startDailyBriefTimer();

        // Start periodic poster prune timer
        this.startPruneTimer();
    }

    private async logEndpoint() {
        try {
            const endpoint = await endpointManager.getLocalEndpoint(this.nativeId, { public: true });
            this.console.log(`Daily Brief available at: ${endpoint.replace(/\/+$/, '')}/brief`);
        } catch (e) {
            // Ignore - endpoint may not be ready yet
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
        // Clear any existing timeout
        if (this.summaryScheduleTimeout) {
            clearTimeout(this.summaryScheduleTimeout);
            this.summaryScheduleTimeout = undefined;
        }

        // Check if feature is enabled
        if (!(this.storageSettings.values as any).dailyBriefEnabled) {
            return;
        }

        const timezone = this.storage.getItem('dailyBriefTimezone') || 'America/Los_Angeles';
        const hour = (this.storageSettings.values as any).dailyBriefHour ?? 20;
        const ms = this.msUntilLocalTime(hour, timezone);
        const hoursUntil = Math.round(ms / 3600000 * 10) / 10;

        this.console.log(`Daily Brief scheduled in ${hoursUntil}h (${timezone}, ${hour}:00)`);

        this.summaryScheduleTimeout = setTimeout(async () => {
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
        const intervalMs = (retentionDays + 2) * 24 * 60 * 60 * 1000;

        this.pruneIntervalTimer = setInterval(() => {
            const validIds = this.notificationStore.getAllIds();
            this.posterStore.prune(validIds).then(n => {
                if (n > 0) this.console.log(`[Poster] Periodic prune: removed ${n} orphaned posters`);
            }).catch(e => this.console.warn('[Poster] Periodic prune failed:', e));
        }, intervalMs);

        this.console.log(`[Poster] Prune timer set: every ${retentionDays + 2} days`);
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
            const windowStart = midnightTodayUtc - (24 * 60 * 60 * 1000); // Midnight yesterday

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
                const frozenNarrative = existingFrozen.filter(fs => fs.narrative.text).map(fs => fs.narrative);
                frozenHighlights.forEach((h, i) => { h.index = i; });
                const overview = frozenNarrative.map(s => s.text).join(' ').slice(0, 200);
                this.notificationStore.setCachedSummary(
                    now, overview, notifications.length, frozenHighlights,
                    windowStart, windowEnd, timezone, overview, frozenNarrative, existingFrozen
                );
                return;
            }

            this.console.log(`[Daily Brief] Incremental: ${existingFrozen.length} frozen, ${periodsToGenerate.length} to generate (force=${forceFullRegeneration})`);

            // 4. Filter notifications to only those in periods to generate
            const periodsToGenerateNotifications = notifications.filter(n => {
                return periodsToGenerate.some(p => n.timestamp >= p.start && n.timestamp < p.end);
            });

            if (periodsToGenerateNotifications.length === 0 && existingFrozen.length > 0) {
                this.console.log(`[Daily Brief] No new notifications in active periods, keeping frozen segments`);
                // Re-store with existing data (updates generatedAt)
                const frozenHighlights = existingFrozen.flatMap(fs => fs.highlights);
                const frozenNarrative = existingFrozen.filter(fs => fs.narrative.text).map(fs => fs.narrative);
                // Re-index highlights contiguously
                frozenHighlights.forEach((h, i) => { h.index = i; });
                const overview = frozenNarrative.map(s => s.text).join(' ').slice(0, 200);
                this.notificationStore.setCachedSummary(
                    now, overview, notifications.length, frozenHighlights,
                    windowStart, windowEnd, timezone, overview, frozenNarrative, existingFrozen
                );
                return;
            }

            // 5. Bucket + select candidates for only the periods to generate
            const buckets = createTimeBuckets(periodsToGenerateNotifications, windowStart, windowEnd, 12, timezone);
            const candidates = selectCandidatesFromBuckets(buckets, 8);

            const bucketSummary = buckets.map(b => `${b.label}: ${b.notifications.length}`).join(', ');
            this.console.log(`[Daily Brief] Buckets: ${bucketSummary}`);
            this.console.log(`[Daily Brief] Selected ${candidates.length} candidates from ${periodsToGenerateNotifications.length} events (${notifications.length} total)`);

            // Guard: if no candidates were selected, skip LLM call
            if (candidates.length === 0) {
                this.console.log(`[Daily Brief] No candidates after bucketing, skipping LLM call`);
                if (existingFrozen.length > 0) {
                    // Re-store frozen segments only (updates generatedAt)
                    const frozenHighlights = existingFrozen.flatMap(fs => fs.highlights);
                    const frozenNarrative = existingFrozen.filter(fs => fs.narrative.text).map(fs => fs.narrative);
                    frozenHighlights.forEach((h, i) => { h.index = i; });
                    const fallbackOverview = frozenNarrative.map(s => s.text).join(' ').slice(0, 200);
                    this.notificationStore.setCachedSummary(
                        now, fallbackOverview, notifications.length, frozenHighlights,
                        windowStart, windowEnd, timezone, fallbackOverview, frozenNarrative, existingFrozen
                    );
                }
                return;
            }

            // 6. Build frozen context for the LLM prompt
            const frozenContext = existingFrozen.length > 0 ? buildFrozenContext(existingFrozen) : undefined;
            if (frozenContext) {
                this.console.log(`[Daily Brief] Providing ${existingFrozen.length} frozen segments as context to LLM`);
            }

            // 7. Read custom instructions from settings
            const customInstructions = this.storage.getItem('dailyBriefCustomPrompt') || '';

            // 8. Generate summary for new candidates (with frozen context)
            const { summary, overview, narrative, highlightIds } = await this.generateDailySummary(
                candidates, dateStr, timezone, customInstructions || undefined, frozenContext
            );

            // 9. Build highlights for the new segments
            const newHighlights = buildCachedHighlights(candidates, highlightIds, timezone);

            // 10. Freeze any newly-completed segments
            const newFrozen: FrozenSegment[] = [...existingFrozen];
            if (narrative) {
                for (const segment of narrative) {
                    const matchedPeriod = matchSegmentToPeriod(segment, completedPeriods, candidates);
                    if (matchedPeriod && !frozenKeys.has(matchedPeriod.key)) {
                        // Resolve this segment's highlights to notification IDs (stable across runs)
                        const segmentNotifIds = (segment.highlightIds || [])
                            .filter(idx => idx >= 0 && idx < candidates.length)
                            .map(idx => candidates[idx].notification.id);
                        const segmentHighlights = buildCachedHighlights(candidates, segmentNotifIds, timezone);

                        newFrozen.push({
                            periodKey: matchedPeriod.key,
                            periodStart: matchedPeriod.start,
                            periodEnd: matchedPeriod.end,
                            narrative: segment,
                            highlights: segmentHighlights,
                            highlightNotificationIds: segmentNotifIds,
                        });
                        frozenKeys.add(matchedPeriod.key);
                    }
                }
            }

            // 10b. Freeze empty completed periods (no events = no segments matched)
            for (const period of completedPeriods) {
                if (!frozenKeys.has(period.key)) {
                    newFrozen.push({
                        periodKey: period.key,
                        periodStart: period.start,
                        periodEnd: period.end,
                        narrative: { timeRange: period.label, text: '', highlightIds: [] },
                        highlights: [],
                        highlightNotificationIds: [],
                    });
                    frozenKeys.add(period.key);
                }
            }

            // 11. Merge: frozen segments + active (non-frozen) segments
            // Clone frozen narratives to avoid mutating originals during re-indexing
            this.console.log(`[Daily Brief] Reusing frozen periods: ${existingFrozen.map(fs => fs.periodKey).join(', ') || 'none'}`);
            const narrativeToFrozen = new Map<NarrativeSegment, FrozenSegment>();
            const frozenNarrative: NarrativeSegment[] = [];
            for (const fs of existingFrozen) {
                if (!fs.narrative.text) continue;  // Skip empty frozen periods (no events)
                const cloned: NarrativeSegment = {
                    timeRange: fs.narrative.timeRange,
                    text: fs.narrative.text,
                    highlightIds: [...fs.narrative.highlightIds],
                };
                frozenNarrative.push(cloned);
                narrativeToFrozen.set(cloned, fs);
            }
            const activeNarrative = narrative?.filter(seg => {
                const matched = matchSegmentToPeriod(seg, completedPeriods, candidates);
                // Keep segments that are NOT in a newly-frozen completed period
                // (they're already in frozenNarrative from existingFrozen) OR are active
                return !matched || !existingFrozen.some(fs => fs.periodKey === matched.key);
            }) || [];
            const mergedNarrative = [...frozenNarrative, ...activeNarrative];

            if (activeNarrative.length === 0 && narrative && narrative.length > 0) {
                this.console.log(`[Daily Brief] All ${narrative.length} new segments matched frozen periods, no active segments added`);
            }

            // Merge highlights: frozen + new, re-index contiguously
            const frozenHighlights = existingFrozen.flatMap(fs => fs.highlights);
            const mergedHighlights = [...frozenHighlights, ...newHighlights];
            mergedHighlights.forEach((h, i) => { h.index = i; });

            // Re-index highlight IDs in merged narrative segments to match new contiguous indices
            const highlightIdMap = new Map(mergedHighlights.map((h, i) => [h.id, i]));
            for (const seg of mergedNarrative) {
                const frozenSeg = narrativeToFrozen.get(seg);
                if (frozenSeg) {
                    // Frozen segments: use stored notification IDs (stable across runs)
                    seg.highlightIds = frozenSeg.highlightNotificationIds
                        .map(notifId => highlightIdMap.get(notifId) ?? -1)
                        .filter(idx => idx >= 0);
                } else {
                    // New segments: highlightIds are candidate array indices
                    seg.highlightIds = seg.highlightIds
                        .map(oldIdx => {
                            if (oldIdx >= 0 && oldIdx < candidates.length) {
                                const notifId = candidates[oldIdx]?.notification?.id;
                                if (!notifId) return -1;
                                return highlightIdMap.get(notifId) ?? -1;
                            }
                            return -1;
                        })
                        .filter(idx => idx >= 0);
                }
            }

            // Sort merged narrative chronologically by period start time
            mergedNarrative.sort((a, b) => {
                const aFrozen = narrativeToFrozen.get(a);
                const bFrozen = narrativeToFrozen.get(b);
                const aTime = aFrozen ? aFrozen.periodStart : (a.highlightIds.length > 0 && a.highlightIds[0] < mergedHighlights.length ? mergedHighlights[a.highlightIds[0]]?.timestamp || 0 : 0);
                const bTime = bFrozen ? bFrozen.periodStart : (b.highlightIds.length > 0 && b.highlightIds[0] < mergedHighlights.length ? mergedHighlights[b.highlightIds[0]]?.timestamp || 0 : 0);
                return aTime - bTime;
            });

            // 12. Build final summary
            const mergedOverview = overview || summary;

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

    async generateDailySummary(candidates: CandidateWithPriority[], dateStr: string, timezone: string, customInstructions?: string, frozenContext?: string): Promise<{ summary: string; overview?: string; narrative?: NarrativeSegment[]; highlightIds: string[] }> {
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

        const prompt = createSummaryPrompt(limitedCandidates, dateStr, timezone, customInstructions, frozenContext);
        const promptSize = JSON.stringify(prompt).length;
        const timeoutMs = Math.max(1, Number((this.storageSettings.values as any).llmTimeoutMs ?? 90)) * 1000;

        this.console.log(`[Daily Brief] Sending ${limitedCandidates.length} candidates to LLM (prompt: ${promptSize} chars, timeout: ${timeoutMs}ms)`);

        const llmStartTime = Date.now();
        try {
            const result = await withTimeout(
                device.getChatCompletion({
                    ...prompt,
                    temperature: 0.1,
                    max_tokens: 2000  // Increased for narrative response
                } as any),
                timeoutMs,
                'Daily summary generation'
            );

            const llmElapsed = Date.now() - llmStartTime;
            this.console.log(`[Daily Brief] LLM completed in ${llmElapsed}ms`);

            const content = result.choices[0]?.message?.content;
            this.console.log(`[Daily Brief] Response length: ${content?.length || 0} chars`);

            if (!content) {
                throw new Error('Empty response from LLM');
            }

            // Parse JSON response (strip markdown code blocks if present)
            try {
                let jsonContent = content.trim();
                // Remove markdown code block wrapper if present
                if (jsonContent.startsWith('```')) {
                    jsonContent = jsonContent.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
                }
                const json = JSON.parse(jsonContent);

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
                response.send(JSON.stringify({ error: String(e) }), {
                    code: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return;
        }

        // Handle timezone auto-detection from browser
        if (path === '/brief/set-timezone') {
            try {
                const urlObj = new URL(url, 'http://localhost');
                const tz = urlObj.searchParams.get('tz');
                if (tz) {
                    this.storage.setItem('dailyBriefTimezone', tz);
                    this.console.log(`Timezone auto-detected: ${tz}`);
                }
            } catch (e) {
                // Ignore errors
            }
            response.send('OK', { headers: { 'Content-Type': 'text/plain' } });
            return;
        }

        // Parse date from path: /brief/2024-01-15 or /brief for today
        // Also check for ?date=YYYY-MM-DD query parameter
        let targetDate = new Date();
        const dateMatch = path.match(/\/brief\/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
            targetDate = new Date(dateMatch[1] + 'T00:00:00');
        } else {
            // Check query parameter
            try {
                const urlObj = new URL(url, 'http://localhost');
                const dateParam = urlObj.searchParams.get('date');
                if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
                    targetDate = new Date(dateParam + 'T00:00:00');
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
        if (path === '/brief/clear') {
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
            const allNotifications = this.notificationStore.getForDate(targetDate);

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

            // If notification ID provided, fetch clip from NVR via VideoRecorder
            if (notificationId) {
                this.console.log(`[Video] START - Fetching clip for notification: ${notificationId}`);

                // Look up the notification to get timestamp and camera
                const notification = this.notificationStore.getById(notificationId);
                if (!notification) {
                    this.console.warn(`[Video] Notification not found: ${notificationId}`);
                    response.send(JSON.stringify({ error: 'Notification not found' }), {
                        code: 404,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }

                this.console.log(`[Video] Found notification: cameraId=${notification.cameraId}, timestamp=${notification.timestamp}`);

                // Find the camera with VideoRecorder interface
                const camera = sdk.systemManager.getDeviceById<VideoRecorder & ScryptedDevice>(notification.cameraId);
                this.console.log(`[Video] Camera found: ${!!camera}, interfaces: ${camera?.interfaces?.join(',')}`);

                if (!camera?.interfaces?.includes('VideoRecorder')) {
                    this.console.warn(`[Video] Camera ${notification.cameraId} doesn't support VideoRecorder`);
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
                    // Request a 30-second clip: 10s before detection, 20s after
                    const startTime = notification.timestamp - 10000;
                    const duration = 30000;

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
                    response.send(JSON.stringify({ error: `Failed to fetch video: ${e?.message || e}` }), {
                        code: 500,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }
            }

            // No notification ID provided
            response.send(JSON.stringify({ error: 'Missing notification id parameter' }), {
                code: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
            return;
        }

        // Snapshot endpoint - serves poster-quality image with fallback chain:
        // 1. posterStore (disk read, pre-generated at detection time)
        // 2. thumbnailB64 (low-res crop fallback, better than nothing)
        // 3. 404 (no image data — client waits for WebRTC)
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

            // Look up the notification to get timestamp and camera
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

                // 2. Fall back to thumbnailB64 (low-res crop, better than nothing)
                if (notification.thumbnailB64) {
                    this.console.log(`[Poster] No disk poster, falling back to thumbnailB64: ${notificationId}`);
                    const jpegBuffer = Buffer.from(notification.thumbnailB64, 'base64');
                    response.send(jpegBuffer, {
                        headers: {
                            'Content-Type': 'image/jpeg',
                            'Content-Length': jpegBuffer.length.toString(),
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'public, max-age=3600'
                        }
                    });
                    return;
                }

                // 3. No image data at all
                response.send(JSON.stringify({ error: 'No snapshot available' }), {
                    code: 404,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
                return;
            } catch (e: any) {
                this.console.error(`[Poster] Error fetching snapshot:`, e);
                response.send(JSON.stringify({ error: `Failed to fetch snapshot: ${e?.message || e}` }), {
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

                if (!notificationId || !offer?.sdp) {
                    response.send(JSON.stringify({ error: 'Missing notificationId or offer.sdp' }), {
                        code: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }

                this.console.log(`[WebRTC] Starting signaling for notification: ${notificationId}`);

                // Look up the notification to get camera and timestamp
                const notification = this.notificationStore.getById(notificationId);
                if (!notification) {
                    response.send(JSON.stringify({ error: 'Notification not found' }), {
                        code: 404,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }

                // Get the camera with VideoRecorder interface
                const camera = sdk.systemManager.getDeviceById<VideoRecorder & ScryptedDevice>(notification.cameraId);
                if (!camera?.interfaces?.includes('VideoRecorder')) {
                    response.send(JSON.stringify({ error: 'Camera does not support video recording' }), {
                        code: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                    return;
                }

                // Request a 30-second clip: 10s before detection, 20s after
                const startTime = notification.timestamp - 10000;
                const duration = 30000;

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
                response.send(JSON.stringify({ error: e?.message || 'WebRTC signaling failed' }), {
                    code: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
                return;
            }
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
            const providerIds = this.storageSettings.values.chatCompletions || [];
            const textProvider = await findTextEmbeddingProvider(providerIds, sdk.systemManager);
            const retentionDaysRaw = parseInt(this.storage.getItem('retentionDays') || '3', 10);
            const result = await handleGallerySearchRequest(request.body || '{}', this.notificationStore, textProvider, request.rootPath || '', isNaN(retentionDaysRaw) ? 3 : retentionDaysRaw);
            response.send(result.body, {
                code: result.code,
                headers: { 'Content-Type': result.contentType, 'Access-Control-Allow-Origin': '*' }
            });
            return;
        }

        // Thumbnail endpoint
        if (path === '/brief/thumbnail') {
            const result = await handleThumbnailRequest(url, this.notificationStore);
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

        if (path === '/brief' || path.startsWith('/brief/')) {
            const allNotifications = this.notificationStore.getForDate(targetDate);
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
                const stats = this.notificationStore.getStats(targetDate);
                const cached = this.notificationStore.getCachedSummary(targetDate, timezone);
                response.send(JSON.stringify({ date: dateStr, stats, notifications: allNotifications, summary: cached?.summary, highlights: cached?.highlights }, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                });
                return;
            }

            // Use shared helper for data fetching and transformation
            const data = await this.getDailyBriefData(targetDate, timezone, mode, allNotifications, request.rootPath || '');

            // Build refresh and catch-up URLs
            const datePath = dateMatch ? '/' + dateMatch[1] : '';
            const refreshUrl = `${request.rootPath}/brief${datePath}?refresh=true`;
            const catchUpUrl = `${request.rootPath}/brief${datePath}?mode=incremental`;

            // HTML response
            this.console.log(`[Daily Brief] Generating HTML response (narrative: ${data.narrative?.length || 0} segments)`);
            const html = generateDailyBriefHTML(
                data.eventCount,
                data.hasDailyBrief ? data.summary : null,
                data.highlights,
                data.generatedAt,
                refreshUrl,
                timezone,
                data.overview,
                data.narrative,
                catchUpUrl
            );
            this.console.log(`[Daily Brief] Sending HTML (${html.length} bytes)`);
            response.send(html, {
                headers: { 'Content-Type': 'text/html' }
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
                response.send(JSON.stringify({ error: 'Internal server error: ' + (e as Error).message }), {
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
            title: 'Enable LLM Enhancement',
            type: 'boolean',
            description: 'Enable LLM-based notification enhancement',
            defaultValue: true,
            group: 'Advanced',
        },
        snapshotMode: {
            title: 'Snapshot Mode',
            description: 'Which image(s) to send to the LLM',
            type: 'string',
            choices: ['cropped', 'full', 'both'],
            defaultValue: 'cropped',
            group: 'Advanced',
        },
        llmTimeoutMs: {
            title: 'LLM Timeout (sec)',
            description: 'Maximum seconds to wait for the LLM before falling back to original notification.',
            type: 'number',
            defaultValue: 90,
            group: 'Advanced',
        },
        chatCompletions: {
            title: 'LLM Providers',
            description: 'Select multiple LLM providers to distribute load. Install the LLM plugin to add external providers or run local LLM servers.',
            type: 'device',
            deviceFilter: `interfaces.includes('ChatCompletion')`,
            multiple: true,
            group: 'General',
        },
        userPrompt: {
            title: 'Notification Style',
            type: 'textarea',
            description: 'Customize how notifications describe detections. v12 improvements available in README.',
            defaultValue: `STYLE PREFERENCES:

Title: Include person names ONLY when provided in metadata, otherwise use generic terms
- When name known: "Richard at front door"
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
            group: 'General',
        },
        includeOriginalMessage: {
            title: 'Include Original Message',
            type: 'boolean',
            description: 'Include the original notification text in the LLM prompt for context',
            defaultValue: true,
            group: 'Advanced',
        },
        dailyBriefUrl: {
            title: 'Daily Brief URL (Local)',
            type: 'html',
            description: 'Local network URL - requires Scrypted login',
            group: 'Daily Brief',
        },
        dailyBriefCloudUrl: {
            title: 'Daily Brief URL (External)',
            type: 'html',
            description: 'External URL via Scrypted Cloud - requires Scrypted Cloud login',
            group: 'Daily Brief',
        },
        haCardSetup: {
            title: 'HA Card Setup',
            type: 'html',
            description: 'Instructions to add the Daily Brief card to Home Assistant',
            group: 'Daily Brief',
        },
        dailyBriefEnabled: {
            title: 'Enable Daily Brief Notifications',
            type: 'boolean',
            description: 'Send a notification with daily summary at scheduled time',
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
            description: 'Hour to send daily brief (24h format, e.g., 20 = 8pm)',
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
            group: 'Daily Brief',
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
            description: 'Add custom context for the Daily Brief. e.g. "The small white dog is Lily" or "Ignore cars on the Sidewalk camera"',
            defaultValue: '',
            group: 'Daily Brief',
        },
        retentionDays: {
            title: 'Gallery Retention (Days)',
            type: 'number',
            description: 'How many days to keep notifications, posters, and embeddings (default: 3)',
            defaultValue: 3,
            group: 'Daily Brief',
        },
    });

    async getSettings() {
        const settings: any[] = await this.storageSettings.getSettings();
        const byKey = new Map<string, any>();
        for (const s of settings) {
            if (s?.key)
                byKey.set(s.key, s);
        }

        // Populate Daily Brief URLs dynamically - HTML for clickable links
        const urlSetting = byKey.get('dailyBriefUrl');
        if (urlSetting) {
            try {
                const endpoint = await endpointManager.getLocalEndpoint(this.nativeId, { public: true });
                const urlStr = `${endpoint.replace(/\/+$/, '')}/brief`;
                urlSetting.value = `<a href="${urlStr}" target="_blank">Open Daily Brief (Local)</a>`;
            } catch {
                urlSetting.value = '(URL not available yet)';
            }
        }

        // Populate cloud URL (authenticated access - requires Scrypted Cloud login)
        const cloudUrlSetting = byKey.get('dailyBriefCloudUrl');
        if (cloudUrlSetting) {
            try {
                const cloudEndpoint = await endpointManager.getPublicCloudEndpoint(this.nativeId);
                const cloudUrl = new URL(cloudEndpoint);
                // Remove /public/ from path and strip query params (user_token) for authenticated access
                cloudUrl.pathname = cloudUrl.pathname.replace('/public/', '/').replace(/\/?$/, '/brief');
                cloudUrl.search = '';
                const urlStr = cloudUrl.toString();
                cloudUrlSetting.value = `<a href="${urlStr}" target="_blank">Open Daily Brief</a>`;
            } catch {
                cloudUrlSetting.value = '(Scrypted Cloud not configured)';
            }
        }

        // Populate HA Card setup instructions
        const haSetupSetting = byKey.get('haCardSetup');
        if (haSetupSetting) {
            haSetupSetting.value = `
<div style="font-size: 12px; line-height: 1.5;">
<strong>Step 1:</strong> Add Lovelace Resource<br>
<code style="background: rgba(128,128,128,0.3); padding: 2px 6px; border-radius: 3px; font-size: 11px;">/api/scrypted/TOKEN/endpoint/@rmaher001/scrypted-llm-notifier/assets/daily-brief-card.js</code>
<br><br>
<strong>Step 2:</strong> Add Card to Dashboard<br>
<pre style="background: rgba(128,128,128,0.3); padding: 8px; border-radius: 4px; font-size: 11px; margin: 4px 0; overflow-x: auto;">type: custom:daily-brief-card
endpoint: /api/scrypted/TOKEN/endpoint/@rmaher001/scrypted-llm-notifier
scrypted_token: TOKEN</pre>
<small>Replace <strong>TOKEN</strong> with your Scrypted token from HA Settings → Devices → Scrypted integration</small>
</div>`;
        }

        const orderedKeys = [
            // General first
            'chatCompletions',
            'promptUpdateInfo',
            'userPrompt',
            // Options (Advanced)
            'enabled',
            'llmTimeoutMs',
            'snapshotMode',
            'includeOriginalMessage',
            // Daily Brief
            'dailyBriefUrl',
            'dailyBriefCloudUrl',
            'haCardSetup',
            'dailyBriefEnabled',
            'dailyBriefNotifier',
            'dailyBriefTestNotification',
            'dailyBriefNotificationUrl',
            'dailyBriefTimezone',
            'dailyBriefHour',
            'dailyBriefGenerationInterval',
            'dailyBriefCustomPrompt',
            'retentionDays',
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
            this.scheduleDailySummary();
        } else if (key === 'retentionDays') {
            this.notificationStore.setRetentionDays(Number(value) || 3);
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
