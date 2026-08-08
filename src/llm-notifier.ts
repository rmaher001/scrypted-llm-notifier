import sdk, {
    MediaObject,
    MixinDeviceBase,
    Notifier,
    NotifierOptions,
    ScryptedMimeTypes,
} from '@scrypted/sdk';
const { mediaManager } = sdk;
import { StoredNotification } from './types';
import { parseClarity, withTimeout, resizeJpegNearest, getJpegDimensions, buildImageList, extractFirstJsonObject, FaceReferenceQuality, parseFaceReferenceQuality, cropJpeg } from './utils';
import { subjectCrop, parsePosterBox, posterBoxToPixelBbox, shouldUsePosterBox, PosterBox } from './subject-crop';
import { getFullEventFrame } from './full-frame-source';
import { summarizeNotificationShape } from './notification-shape';
import { resolveSeekTimestamp, isSummaryNotification } from './seek-time';
import { selectPosterRawSource } from './poster-source';
import { shouldRunJudge } from './llm-judge';
import { downscaleForNotificationDelivery, downscaleForStorage } from './notification-downscale';
import type { PosterSource } from './poster-decision-log';
import { PendingNoMediaBuffer } from './pending-no-media';
import { generateEmbedding, GeminiEmbeddingConfig } from './gemini-embedding';
import {
    TelemetryRow,
    LlmRole,
    LlmOutcome,
    makeTelemetryId,
    truncateError,
} from './llm-telemetry';
import type LLMNotifierProvider from './main';

/**
 * LLM Notifier Plugin for Scrypted
 * Enhances notifications with images using LLM analysis
 * Preserves known person names from notifications
 */

// ============================================================================
// Pure helper functions (extracted from sendNotification for testability)
// ============================================================================

/**
 * Resize a full-frame JPEG buffer for LLM consumption.
 * Returns a base64 data URL on success, or undefined on failure.
 */
export async function processFullFrame(
    fullBuf: Buffer,
    console: { warn(...args: any[]): void },
): Promise<string | undefined> {
    const { width: sw, height: sh } = getJpegDimensions(fullBuf);
    let targetWidth = sw;
    if (sw > 3000) targetWidth = 640;
    else if (sw > 1500) targetWidth = 512;
    else if (sw > 800) targetWidth = 384;
    const dw = Math.min(targetWidth, sw);
    const resized = await resizeJpegNearest(fullBuf, dw, 60);
    return `data:image/jpeg;base64,${resized.toString('base64')}`;
}

export function extractDetectionId(options?: any): string | undefined {
    const re = options?.recordedEvent;
    const data = re?.data || {};
    return data?.detectionId || data?.detections?.[0]?.id;
}

export function extractDetectionData(
    detections: any[],
    originalTitle: string,
    originalBody?: string,
): { detectionType: string; names: string[] } {
    let detectionType = 'motion';
    if (detections.length > 0) {
        detectionType = detections[0]?.className || 'motion';
    }

    const names: string[] = [];
    for (const det of detections) {
        if (det.label && det.className === 'face') {
            names.push(det.label);
        }
    }

    const maybeMatch = (originalTitle + ' ' + (originalBody || '')).match(/Maybe:\s*(\w+)/gi);
    if (maybeMatch) {
        for (const m of maybeMatch) {
            const name = m.replace(/Maybe:\s*/i, '').trim();
            if (name && !names.includes(name)) {
                names.push(name);
            }
        }
    }

    return { detectionType, names };
}



export function extractFaceBoundingBox(
    detections: any[],
    name: string,
    minSize = 0,
): [number, number, number, number] | undefined {
    for (const det of detections) {
        if (det.className === 'face' && det.label === name && Array.isArray(det.boundingBox) && det.boundingBox.length >= 4) {
            const [, , w, h] = det.boundingBox;
            if (minSize > 0 && (w < minSize || h < minSize)) continue;
            return det.boundingBox as [number, number, number, number];
        }
    }
    return undefined;
}

export function shouldLoadReferenceImages(enableLlmFaceId: boolean, detections: any[]): boolean {
    if (!enableLlmFaceId || !detections || !detections.length) return false;
    // v0.3.138: tightened further to "only when at least one face is detected
    // AND every face entry is unlabeled (Scrypted's matcher couldn't ID anyone)".
    //
    // History:
    //   - pre-v0.3.130: required a high-confidence unlabeled face.
    //   - v0.3.130: broadened to ANY person|face detection so LLM could attempt
    //     ID even when Scrypted seemed to miss the face. Caused ref-photo load
    //     on ~100% of person events.
    //   - v0.3.136: FaceID-Probe (132 samples) showed unlabeled face entries
    //     DO reach our detections array (23% of probe events); person-only
    //     events have no face data at all (50%).
    //   - v0.3.137: narrowed back to face-only (any face). Dropped the 50%
    //     person-only branch.
    //   - v0.3.138 (THIS): also skip when all faces are labeled (27% of
    //     events). Combined with v0.3.137, ~77% of per-event LLM calls now
    //     skip ref-photo loading.
    //
    // Tradeoff: skipping ref-load on labeled faces means we no longer verify
    // Scrypted matcher's IDs with the LLM. Operator accepted this 2026-05-25
    // under burst-overload pressure on mlx_vlm.server. Scrypted's notification
    // text uses 'Maybe: <Name>' for low-confidence matches, so user retains
    // an upstream confidence signal even without LLM verification.
    const faceEntries = detections.filter((d: any) => d.className === 'face');
    if (faceEntries.length === 0) return false;
    // Fire if AT LEAST ONE face is unlabeled. Multi-person scenes where
    // Scrypted labeled some but missed others still need the LLM to attempt
    // ID on the unlabeled ones.
    return faceEntries.some((d: any) => !d.label);
}

/**
 * Summarizes a detections array for the FaceID diagnostic probe (v0.3.136).
 * Produces a compact one-line representation that lets us answer: do we ever
 * see `className: 'face'` entries with no label (i.e., a face was detected
 * but the matcher couldn't identify it)? If yes, narrow shouldLoadReferenceImages
 * to face-only and stop wasting LLM-ID calls on faceless person detections.
 * If no, NVR is stripping unlabeled faces and we need a different signal.
 *
 * Format:
 *   classes=person×2,face×1 | labels=Casey,(none) | nested-face=0
 *
 * - `classes` counts top-level className entries
 * - `labels` lists the .label values on `face` entries (or '(none)' if absent)
 * - `nested` counts face entries that appear in any top-level detection's
 *   .detections[] sub-array (in case NVR nests rather than flattens)
 */
export function summarizeDetectionsForFaceProbe(detections: any[]): string {
    if (!Array.isArray(detections) || detections.length === 0) return 'empty';
    const classCounts = new Map<string, number>();
    const faceLabels: string[] = [];
    let nestedFaceCount = 0;
    for (const d of detections) {
        const cls = String(d?.className ?? '<no-className>');
        classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
        if (cls === 'face') {
            faceLabels.push(d?.label ? String(d.label) : '(none)');
        }
        // Some detection pipelines nest face inside the person detection.
        const nested = d?.detections;
        if (Array.isArray(nested)) {
            for (const n of nested) {
                if (n?.className === 'face') nestedFaceCount++;
            }
        }
    }
    const classPart = [...classCounts.entries()]
        .map(([k, v]) => `${k}×${v}`)
        .sort()
        .join(',');
    const labelsPart = faceLabels.length > 0 ? faceLabels.join(',') : '(no-face-entries)';
    return `classes=${classPart} | labels=${labelsPart} | nested-face=${nestedFaceCount}`;
}

export function shouldCurateReference(
    enableLlmFaceId: boolean,
    names: string[],
    clarityScore: number | undefined,
    imageUrl: string | undefined,
    faceRef?: FaceReferenceQuality | null,
): boolean {
    if (!enableLlmFaceId || !names.length) return false;
    if (!imageUrl?.startsWith('data:image/jpeg;base64,')) return false;

    if (faceRef) {
        if (!faceRef.frontFacing || !faceRef.unobstructed) return false;
        if (faceRef.score < 7) return false;
        return true;
    }

    // Legacy fallback
    if (clarityScore == null || clarityScore < 5) return false;
    return true;
}

export function mergeIdentifiedPersons(names: string[], identifiedNames: string[]): string[] {
    const merged = [...names];
    for (const name of identifiedNames) {
        if (!merged.includes(name)) merged.push(name);
    }
    return merged;
}

export function filterAcceptedPersons(
    persons: Array<{ name: string; confidence: number }> | null | undefined,
    threshold: number
): string[] {
    if (!persons) return [];
    return persons
        .filter(p => p.name && !isNaN(p.confidence) && p.confidence >= threshold)
        .map(p => p.name);
}

export interface NameBadge {
    label: string;
    cssClass: string;
    icon: string;
}

export function buildNameBadges(
    names?: string[],
    llmIdentifiedNames?: string[],
    llmIdentifiedName?: string,
): NameBadge[] {
    const scryptedSet = new Set(names || []);
    // Prefer array over singular (backward compat)
    const llmNames = (llmIdentifiedNames && llmIdentifiedNames.length > 0)
        ? llmIdentifiedNames
        : (llmIdentifiedName ? [llmIdentifiedName] : []);
    const llmSet = new Set(llmNames);

    const allNames = new Set([...scryptedSet, ...llmSet]);
    const badges: NameBadge[] = [];

    for (const name of allNames) {
        const inScrypted = scryptedSet.has(name);
        const inLlm = llmSet.has(name);
        if (inScrypted && inLlm) {
            badges.push({ label: name, cssClass: 'name-both', icon: '\uD83D\uDC64\u2728' });
        } else if (inLlm) {
            badges.push({ label: name, cssClass: 'name-llm', icon: '\u2728' });
        } else {
            badges.push({ label: name, cssClass: 'name-scrypted', icon: '\uD83D\uDC64' });
        }
    }

    return badges;
}

export interface BuildStoredNotificationParams {
    id: string;
    detectionEpoch: number;
    cameraId: string;
    cameraName: string;
    detectionType: string;
    names: string[];
    enriched: Partial<EnrichmentResult>;
    hasPoster: boolean;
    llmIdentifiedNames?: string[];
    /** The instant the poster seek resolved to; persisted so the clip and NVR link match it. */
    seekTimestamp?: number;
    /** True when this came from a Scrypted native Summary/Story digest. */
    isSummary?: boolean;
}

export function buildStoredNotification(params: BuildStoredNotificationParams): StoredNotification {
    return {
        id: params.id,
        timestamp: params.detectionEpoch,
        cameraId: params.cameraId,
        cameraName: params.cameraName,
        detectionType: params.detectionType,
        names: params.names,
        llmTitle: params.enriched.title || '',
        llmSubtitle: params.enriched.subtitle || '',
        llmBody: params.enriched.body || '',
        hasPoster: params.hasPoster,
        detailedDescription: params.enriched.detailedDescription,
        clarity: params.enriched.clarity,
        llmIdentifiedNames: params.llmIdentifiedNames,
        seekTimestamp: params.seekTimestamp,
        isSummary: params.isSummary,
    };
}

export interface PerEventClickSettings {
    /** enablePerEventBriefClick — gates the Daily Brief gallery rung only. */
    enabled: boolean;
    /** dailyBriefNotificationUrl — the Daily Brief Card dashboard path. */
    haDailyBriefPath?: string;
    /** haNvrTimelinePath — the in-HA iframed scrypted-nvr-iframe-card dashboard path. */
    haNvrTimelinePath?: string;
    /** Source camera's Scrypted device id (media.sourceId). Needed for the NVR rung. */
    cameraId?: string;
    /** Camera-side event time (ms). Needed for the NVR rung's timeline seek. */
    eventTimeMs?: number;
}

// Overrides click-target fields on options.data.ha so that tapping an
// enhanced per-event notification delivered to Home Assistant opens the
// Daily Brief gallery entry for that event (via the configured HA
// dashboard path) instead of the camera timeline. HA-only: the Scrypted
// iPhone/Mac apps route data.hash through a closed SPA with no hook for
// external/plugin URLs (confirmed 2026-04-24 — hash-probe landed on a
// blank screen). Returns the input data by reference when the override
// does not apply, so callers can use identity to detect a no-op.
export function buildPerEventClickData(
    existingData: any,
    notifierPluginId: string | undefined,
    notificationId: string,
    settings: PerEventClickSettings,
): any {
    // HA-only: the Scrypted iPhone/Mac apps route data.hash through a closed
    // SPA with no hook for external/plugin URLs.
    if (notifierPluginId !== '@scrypted/homeassistant') return existingData;

    const withHaUrl = (url: string): any => {
        const data = existingData ? { ...existingData } : {};
        data.ha = { ...(data.ha || {}), url, clickAction: url };
        return data;
    };

    // Rung 1 (highest): the in-HA iframed Scrypted NVR timeline dashboard
    // (haNvrTimelinePath), keyed by ?camera=&time= — the same contract the
    // scrypted-nvr-iframe-card speaks. Preferred over the upstream direct
    // Scrypted deep link, which HA's WKWebView aborts (WebKitErrorDomain
    // Code 102). haNvrTimelinePath being set is its own opt-in — independent
    // of enablePerEventBriefClick, which gates only the gallery rung below.
    // Requires cameraId + eventTimeMs; without them we can't build the seek,
    // so fall through.
    const nvrPath = settings.haNvrTimelinePath?.trim();
    if (nvrPath && settings.cameraId && typeof settings.eventTimeMs === 'number') {
        const sep = nvrPath.includes('?') ? '&' : '?';
        return withHaUrl(
            `${nvrPath}${sep}camera=${encodeURIComponent(settings.cameraId)}&time=${settings.eventTimeMs}`,
        );
    }

    // Rung 2: the Daily Brief gallery entry, gated by enablePerEventBriefClick.
    if (!settings.enabled) return existingData;
    if (!settings.haDailyBriefPath) return existingData;
    const base = settings.haDailyBriefPath;
    return withHaUrl(`${base}${base.includes('?') ? '&' : '?'}id=${encodeURIComponent(notificationId)}`);
}

// Issue #9: Some upstream Scrypted plugins emit notification URLs where the
// first separator after the path is `&` instead of `?` (e.g.
// `/scrypted_<hash>&url=/api/scrypted/...#/timeline/<id>?time=...`). iOS HA
// companion app's WKWebView treats the whole thing as a path (no query),
// then aborts the load with WebKitErrorDomain Code 102 ("Frame load
// interrupted"). Normalize that first `&` to `?` defensively at delivery
// time. Assumes the `&` is the missing first query separator; URLs that
// already have a `?` (or a fragment) before the first `&` are returned
// unchanged.
export function normalizeNotificationClickUrl<T extends string | null | undefined>(url: T): T {
    if (typeof url !== 'string') return url;
    const ampIdx = url.indexOf('&');
    if (ampIdx === -1) return url;
    const qIdx = url.indexOf('?');
    if (qIdx !== -1 && qIdx < ampIdx) return url;
    const hashIdx = url.indexOf('#');
    if (hashIdx !== -1 && hashIdx < ampIdx) return url;
    return (url.slice(0, ampIdx) + '?' + url.slice(ampIdx + 1)) as T;
}

// Returns a new options.data with data.ha.url and data.ha.clickAction
// normalized via normalizeNotificationClickUrl. Returns the input by
// reference when no change is needed, so callers can detect a no-op via
// identity.
export function sanitizeHaClickUrl(data: any): any {
    if (!data || typeof data !== 'object') return data;
    const ha = data.ha;
    if (!ha || typeof ha !== 'object') return data;
    const url = typeof ha.url === 'string' ? ha.url : undefined;
    const clickAction = typeof ha.clickAction === 'string' ? ha.clickAction : undefined;
    if (url === undefined && clickAction === undefined) return data;
    const fixedUrl = url !== undefined ? normalizeNotificationClickUrl(url) : undefined;
    const fixedClick = clickAction !== undefined ? normalizeNotificationClickUrl(clickAction) : undefined;
    if (fixedUrl === url && fixedClick === clickAction) return data;
    const newHa: any = { ...ha };
    if (url !== undefined) newHa.url = fixedUrl;
    if (clickAction !== undefined) newHa.clickAction = fixedClick;
    return { ...data, ha: newHa };
}

export function buildMetadata(
    title: string,
    subtitle?: string,
    body?: string,
    includeOriginal: boolean = false,
    faceNames: string[] = [],
): any {
    const metadata: any = {};
    if (includeOriginal) {
        metadata.originalTitle = title;
        metadata.originalSubtitle = subtitle;
        metadata.originalBody = body;
        metadata.instruction = "Extract any 'Maybe: [name]' from the original text and use that name. Each field (title, subtitle, body) must contain DIFFERENT information - no repetition between fields.";
    }
    // Scrypted's structured face labels. Previously the LLM's only route to a
    // name was scraping "Maybe: NAME" out of the notification prose, so a
    // native Story — whose text is prose like "Person in living room" — reached
    // the model with no name at all and came back "A man", while the card badge
    // read the structured field and correctly said Alex.
    //
    // Rendered in that same "Maybe: NAME" form on purpose: CRITICAL RULE 1 and
    // the Scenario A block key on that exact wording, so the tuned person-ID
    // prompt needs no change and its behaviour is unaltered.
    //
    // Deliberately outside the includeOriginal guard — turning off "Include
    // Original Message" should drop the original text, not the identities.
    if (faceNames.length > 0) {
        metadata.faceMatches = faceNames.map(n => `Maybe: ${n}`);
    }
    return metadata;
}

export interface EnrichmentResult {
    title: string;
    subtitle: string;
    body: string;
    detailedDescription: string;
    clarity?: { score: number; reason: string };
    identifiedPerson?: string | null;
    identifiedPersonConfidence?: number | null;
    identifiedPersons?: Array<{ name: string; confidence: number }> | null;
    faceReferenceQuality?: FaceReferenceQuality | null;
    // v0.3.164: the region of the full analyzed frame the VLM says its
    // description centers on (normalized 0-1). Drives the poster crop so the
    // still reflects the text. null when absent/invalid → heuristic fallback.
    posterBox?: PosterBox | null;
    telemetryId?: string;
}

export interface TelemetrySinkOptions {
    sink: { record(row: TelemetryRow): void | Promise<void> };
    role: LlmRole;
    promptBytes: number;
    imageCount?: number;
}

function recordTelemetrySafe(
    sink: TelemetrySinkOptions['sink'],
    row: TelemetryRow,
    console: { warn(...args: any[]): void },
): void {
    try {
        const maybePromise = sink.record(row);
        if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
            (maybePromise as Promise<unknown>).catch(err => {
                try { console.warn('[Telemetry] sink.record rejected:', err); } catch { /* ignore */ }
            });
        }
    } catch (err) {
        try { console.warn('[Telemetry] sink.record threw:', err); } catch { /* ignore */ }
    }
}

function classifyOutcome(err: unknown): LlmOutcome {
    const msg = err instanceof Error ? err.message : String(err || '');
    if (/timed out|timeout/i.test(msg)) return 'timeout';
    return 'error';
}

export async function callLlm(
    provider: { getChatCompletion(messages: any): Promise<any> },
    messageTemplate: any,
    timeoutMs: number,
    console: { log(...args: any[]): void; warn(...args: any[]): void },
    verbose: boolean = false,
    telemetry?: TelemetrySinkOptions,
): Promise<EnrichmentResult> {
    const start = Date.now();
    const providerName = (provider as any).name || '(unnamed)';
    const telemetryId = telemetry ? makeTelemetryId() : undefined;
    if (verbose) console.log(`Calling LLM ${providerName} (timeout ${timeoutMs}ms)...`);

    let llmData: any;
    try {
        llmData = await withTimeout(provider.getChatCompletion(messageTemplate), timeoutMs, 'LLM request');
    } catch (err) {
        if (telemetry && telemetryId) {
            recordTelemetrySafe(telemetry.sink, {
                id: telemetryId,
                ts: Date.now(),
                providerName,
                role: telemetry.role,
                outcome: classifyOutcome(err),
                latencyMs: Date.now() - start,
                timeoutMs,
                promptBytes: telemetry.promptBytes,
                imageCount: telemetry.imageCount,
                errorMsg: truncateError(err),
            }, console);
        }
        throw err;
    }

    const responseTime = Date.now() - start;
    const responseTimeSeconds = Math.round(responseTime / 1000);

    const content = llmData.choices[0].message.content;
    if (!content) {
        const err = new Error('Empty response from LLM');
        if (telemetry && telemetryId) {
            recordTelemetrySafe(telemetry.sink, {
                id: telemetryId,
                ts: Date.now(),
                providerName,
                role: telemetry.role,
                outcome: 'parse_error',
                latencyMs: responseTime,
                timeoutMs,
                promptBytes: telemetry.promptBytes,
                imageCount: telemetry.imageCount,
                errorMsg: truncateError(err),
            }, console);
        }
        throw err;
    }

    let json: any;
    try {
        json = JSON.parse(extractFirstJsonObject(content));
    } catch (err) {
        if (telemetry && telemetryId) {
            recordTelemetrySafe(telemetry.sink, {
                id: telemetryId,
                ts: Date.now(),
                providerName,
                role: telemetry.role,
                outcome: 'parse_error',
                latencyMs: responseTime,
                timeoutMs,
                promptBytes: telemetry.promptBytes,
                imageCount: telemetry.imageCount,
                responseBytes: Buffer.byteLength(content, 'utf8'),
                errorMsg: truncateError(err),
            }, console);
        }
        throw err;
    }
    if (verbose) console.log('LLM response:', json);

    // Extract identifiedPersons: prefer new array format, fall back to legacy singular
    let identifiedPersons: Array<{ name: string; confidence: number }> | null = null;
    if (Array.isArray(json.identifiedPersons)) {
        identifiedPersons = json.identifiedPersons;
    } else if (json.identifiedPerson && typeof json.identifiedPerson === 'string') {
        // Legacy backward compat: convert singular to array
        identifiedPersons = [{ name: json.identifiedPerson, confidence: json.identifiedPersonConfidence ?? 0 }];
    }

    const result: EnrichmentResult = {
        title: json.title,
        subtitle: json.subtitle,
        body: json.body,
        detailedDescription: json.detailedDescription || '',
        clarity: parseClarity(json.clarity, console),
        identifiedPerson: json.identifiedPerson ?? null,
        identifiedPersonConfidence: json.identifiedPersonConfidence ?? null,
        identifiedPersons,
        faceReferenceQuality: parseFaceReferenceQuality(json.faceReferenceQuality, console),
        posterBox: parsePosterBox(json.posterBox),
        telemetryId,
    };

    const recordParseError = (err: Error) => {
        if (telemetry && telemetryId) {
            recordTelemetrySafe(telemetry.sink, {
                id: telemetryId,
                ts: Date.now(),
                providerName,
                role: telemetry.role,
                outcome: 'parse_error',
                latencyMs: Date.now() - start,
                timeoutMs,
                promptBytes: telemetry.promptBytes,
                imageCount: telemetry.imageCount,
                responseBytes: Buffer.byteLength(content, 'utf8'),
                errorMsg: truncateError(err),
            }, console);
        }
    };

    if (typeof result.title !== 'string' || typeof result.subtitle !== 'string' ||
        typeof result.body !== 'string' || typeof result.detailedDescription !== 'string') {
        const err = new Error('Invalid response format from LLM');
        recordParseError(err);
        throw err;
    }

    if (json.identifiedPerson !== undefined && json.identifiedPerson !== null
        && typeof json.identifiedPerson !== 'string') {
        const err = new Error('Invalid response format from LLM');
        recordParseError(err);
        throw err;
    }

    if (verbose) console.log(`[LLM] detailedDescription: ${result.detailedDescription ? result.detailedDescription.substring(0, 100) : '(empty)'}`);
    if (verbose && result.clarity) {
        console.log(`🔍 Clarity score: ${result.clarity.score}/10 - ${result.clarity.reason}`);
    }

    if (telemetry && telemetryId) {
        recordTelemetrySafe(telemetry.sink, {
            id: telemetryId,
            ts: Date.now(),
            providerName,
            role: telemetry.role,
            outcome: 'ok',
            latencyMs: Date.now() - start,
            timeoutMs,
            promptBytes: telemetry.promptBytes,
            imageCount: telemetry.imageCount,
            responseBytes: Buffer.byteLength(content, 'utf8'),
            clarityScore: result.clarity?.score,
            faceRefScore: result.faceReferenceQuality?.score,
            detailedDescLen: result.detailedDescription.length,
            identifiedPersonCount: identifiedPersons ? identifiedPersons.length : 0,
        }, console);
    }

    return result;
}

export function createMessageTemplate(userPrompt: string, imageUrls: string[], metadata: any, referenceImages?: Map<string, string>, includePosterBox?: boolean) {
    // Rule 10's examples render with the name actually in play. A literal
    // example name can collide with the user's own style text or shadow the
    // real detection, so none is ever baked; without an injected name the
    // symbolic <name> placeholder keeps the rule teachable without inventing
    // anyone. Pets have no injection path, so their example is always symbolic.
    // Sanitized: the label is external data landing in the SYSTEM prompt. A
    // newline in it would start a line at column 0, indistinguishable from a
    // real CRITICAL RULE; a quote breaks the example's quoting; and there is
    // no legitimate 40+ character first name.
    const injectedNames: string[] = (metadata?.faceMatches ?? [])
        .map((m: string) => String(m).replace(/^Maybe:\s*/, '')
            .replace(/\s+/g, ' ').replace(/["`]/g, '').trim().slice(0, 40))
        .filter(Boolean);
    const exampleName = injectedNames[0] ?? '<name>';

    // Hardcoded base prompt with structural requirements
    const basePrompt = `Analyze the security camera image and generate a notification.

CRITICAL RULES (DO NOT VIOLATE):
1. ONLY use names if metadata contains "Maybe: [name]" - use that EXACT name WITHOUT "Maybe:"
2. If NO name in metadata, use generic terms: Person, Man, Woman, Visitor
3. NEVER make up names like John, Sarah, etc. - only use names from metadata
4. NEVER make up license plates like ABC123, XYZ789, etc. - only mention actual visible plates or "partially visible plate"
5. NEVER include "Maybe:" in your response - only use the actual name
6. Title format MUST be: "[Person/Object] at [location]"
7. Some platforms only show title+body - put ALL critical info there
8. Each field MUST contain different information - no repetition between fields
9. Response MUST be valid JSON with these fields: title, subtitle, body, detailedDescription, clarity, faceReferenceQuality
10. NAMED ENTITY CONSISTENCY: Once a name is established in one field (a person name from the metadata, or a pet name from the user's context), use that SAME name in the remaining downstream fields — subtitle, body, AND detailedDescription. Pronouns (she/he/they/it) are acceptable after first mention. NEVER substitute generic nouns like "Person", "Man", "Woman", "Visitor", "the subject", "dog", "cat", or "the animal" IN PLACE OF a name you have already used. (Those generic terms ARE still correct when no name is available — this rule only applies once a name has been established.)
    WRONG: title "${exampleName} in Kitchen" + body "Person in a blue sweatshirt"
    RIGHT: title "${exampleName} in Kitchen" + body "${exampleName} in a blue sweatshirt"
    WRONG: title "<pet name> on the patio" + body "Small white fluffy dog on a chair"
    RIGHT: title "<pet name> on the patio" + body "<pet name> resting on a chair"
11. detailedDescription: Write 2-3 detailed sentences focusing on what makes THIS moment unique. Prioritize: specific actions (slicing fruit, opening a box, ironing a shirt), interactions between people, items being carried or used, temporary objects (packages, food, tools), expressions, posture, and anything unusual. Include people's appearance (hair, build, clothing, footwear) and vehicle details (make, model, color, plate) when visible. Briefly note the setting but don't dwell on permanent fixtures — focus more on what is happening than on the room itself. These details power search and daily summaries.
12. clarity: Return an OBJECT with two fields — 'score' (integer 1-10) and 'reason' (short string). NEVER return clarity as a string like "7/10 - clear view" or "8 (motion blur)". The exact required form is: {"score": 7, "reason": "brief explanation"}. Assess on a 1-10 scale with SPECIFIC criteria:
    - Score 1-2: UNUSABLE - Cannot identify what subject IS (blob, shadow, severe motion blur, too dark)
    - Score 3-4: POOR - Can identify subject TYPE only (person vs animal vs vehicle, but no other details)
    - Score 5-6: FAIR - Some details visible but uncertain (probably male, possibly dark clothing)
    - Score 7-8: GOOD - Most details clear (male wearing blue hoodie, carrying backpack)
    - Score 9-10: EXCELLENT - Face features visible, license plates readable, fine details clear
    Be STRICT and HONEST - if you're guessing what something is, score 5 or below.
13. faceReferenceQuality: Assess whether this image would work as a face reference photo for identifying this person in future images. Return null if no person or face is visible. Otherwise:
    - score (1-10): How suitable is this as a face reference photo? Be VERY STRICT:
      1-2: No face visible, back of head, too far away
      3-4: Face barely visible, severe blur, very poor lighting, or looking straight down
      5: Profile/side view, or face mostly turned away from camera
      6: Face visible but at an angle (3/4 view), or partially obscured
      7: Face mostly front-facing but minor issues (slight angle, mediocre lighting, some motion blur)
      8: Clear front-facing view with good lighting and minimal blur
      9: Excellent front-facing portrait-quality view, sharp focus, even lighting
      10: Perfect passport-style photo quality
      CRITICAL: Profile views, looking down, or turned heads are NEVER above 5. Only score 8+ for truly front-facing, well-lit, sharp faces.
    - frontFacing: Is the person looking DIRECTLY at or near the camera? Profile views, looking down, looking away = false.
    - unobstructed: Is the face free of sunglasses, masks, hands covering features, or heavy shadows?
    - singleSubject: Is there only one prominent person in the image?`;

    // When a name is supplied but NO reference photos are, the Scenario A/B
    // framework below does not ship — v0.3.138 skips loading references when
    // every face is already labeled, an accepted tradeoff under LLM burst load.
    // That leaves only CRITICAL RULE 1, which says to use the name flatly. Since
    // the label is Scrypted's unverified match and its face library is known to
    // confuse household members, say so: use the name (it is what the card badge
    // shows), but do not manufacture corroborating detail around it.
    // Mutually exclusive with personIdPrompt below — the two guards are exact
    // negations of the same reference-image condition, so at most one is ever
    // non-empty and their concatenation order does not matter.
    let unverifiedNamePrompt = '';
    const hasNameWithoutRefs = !!metadata?.faceMatches?.length
        && !(referenceImages && referenceImages.size > 0);
    if (hasNameWithoutRefs) {
        unverifiedNamePrompt = `\n\nNAME PROVENANCE:
The "Maybe: NAME" entries in metadata are an UNVERIFIED upstream match from Scrypted's face recognition. No reference photos were supplied with this request, so you cannot check the match yourself.
Use the name — it is the identity already shown to the user — but treat it as a label only. Do NOT invent or assert identifying details (facial features, distinguishing marks, relationships) that you cannot actually see in the image, and do NOT describe the match as confirmed or recognized.`;
    }

    // Add person identification instructions when reference images are provided
    let personIdPrompt = '';
    if (referenceImages && referenceImages.size > 0) {
        personIdPrompt = `\n\nPERSON IDENTIFICATION:
Reference photos of known household members are provided below. Two scenarios depending on the metadata:

SCENARIO A — METADATA CONTAINS "Maybe: NAME"
Scrypted's face-recognition system has matched a face and passes the label as "Maybe: NAME". Scrypted ALWAYS uses the "Maybe:" prefix even at high confidence.

CRITICAL: Scrypted's face library can produce wrong matches (it has been known to label one household member as another, or label a stranger as a household member). Treat "Maybe: NAME" as a HYPOTHESIS to verify against the reference photos of NAME, NOT as a confident ID to accept. Your role in Scenario A is to confirm Scrypted's match against the reference, OR catch its mismatches.

USE NAME only when you can point to at least one specific identifying feature in the image that matches the reference photos of NAME and distinguishes NAME from other household members. Acceptable features: a clear face glimpse (eyes, nose, jawline, skin tone) that matches the reference; distinctive hair style/length/color matching the reference; glasses, facial hair, a tattoo, or other persistent marker visible in the reference; a build genuinely distinctive to NAME within the household.

Generic cues are NOT sufficient — "looks like an adult woman", same approximate height, common clothing (dark jacket, jeans, white t-shirt), or "same build" are NOT enough by themselves, because Scrypted can match faces that look superficially similar to NAME but are actually a different household member or a stranger.

DECLINE the name when:
- You cannot point to a specific identifying feature that distinguishes NAME (generic cues only).
- The image is a silhouette, rear view, back-of-head, or otherwise shows no identifying features.
- The visible features could equally fit a different person in the reference set (e.g., two members with similar build / hair color, and no distinguishing feature visible).
- The visible features actively contradict NAME (clearly different sex, age, race, or build than the reference).

Prefer to PRESERVE the entry with confidence in the 4-6 band rather than omitting it — the system filters confidence < 7 from name badges, but logs 4-6 entries as "weak match" telemetry. Omit entirely ONLY when the image actively contradicts NAME (use 1-3 in that case to make the contradiction visible in telemetry).

"Nothing in the image contradicts NAME" is NOT the same as "the image confirms NAME". Absence of contradiction is the 4-6 band (uncertain), not 7-8.

SCENARIO B — METADATA HAS NO PERSON NAME (no "Maybe:" present)
Scrypted did not match a face to any known person. This happens when there is no upstream face match — the face is at an angle, partially obscured, far away, in low light, or there was no face sub-detection. The person in the image MAY STILL be identifiable to you using non-face cues from the reference photos: build, hair color/style, typical clothing patterns, glasses, height, walk/posture, or a partial face glimpse.

YOUR ROLE in Scenario B is to ACTIVELY ATTEMPT a fresh match against the reference photos — Scrypted missed the face for technical reasons (angle, lighting, distance), not because the person isn't in the known set. If you can see a distinctive identifying feature that matches a reference (uncommon hairstyle, specific build, characteristic posture, glasses, distinctive clothing the operator typically wears, or a partial face glimpse), USE THE NAME. Multiple people can be IDed if the cues fit multiple references.

Same bar as Scenario A applies: common clothing (dark jacket, jeans, white t-shirt) is NOT sufficient by itself; you need a feature genuinely distinctive to the reference. When the visible cues could equally fit a stranger or another household member, decline (return null or omit that person). Unlike Scenario A, do NOT include speculative 4-6-band entries in Scenario B — there is no upstream hypothesis to audit, so a weak-match entry is just noise.

Decline in Scenario B when nobody in the image has a distinctive feature matching any reference, OR when the image quality is too low to make any feature-based judgment, OR when the only matching cues are common (could fit any stranger of the same general appearance).

IN BOTH SCENARIOS:
- If multiple people are visible AND each plausibly matches different references, include ALL of them in identifiedPersons.
- Return identifiedPersons as an array of {name, confidence} objects, or null if nobody plausibly matches.
- Only use the exact names from the reference photo labels.
- Confidence scale (1-10):
  - 1-3: Clear mismatch — the image actively contradicts the claimed name (Scenario A) or none of the visible cues match any reference (Scenario B)
  - 4-6: No distinctive feature visible — subject obscured / distant / generic cues only / nothing contradicts but nothing confirms. DEFAULT band when you cannot point to a feature that distinguishes the named person from other household members or strangers.
  - 7-8: Distinctive feature visible and matches the reference (clear face glimpse, distinctive hair, glasses, characteristic build that's genuinely distinctive to that person)
  - 9-10: Unmistakable match at close range — clear face plus one or more distinctive features confirmed`;
    }

    // Poster focus box (only requested when the FULL frame is one of the
    // analyzed images — coordinates are meaningless against a pre-cropped
    // thumbnail). Drives the notification poster crop downstream.
    let posterBoxPrompt = '';
    if (includePosterBox) {
        posterBoxPrompt = `\n\nPOSTER FOCUS BOX:
Also return "posterBox": the region of THE FULL IMAGE that best represents your description — the main subject or action a person should see at a glance in the notification thumbnail. Express it as normalized fractions of the full image: an object {"x","y","width","height"} where x,y is the top-left corner (0,0 = top-left of the image, 1,1 = bottom-right) and width,height are the box size, all numbers between 0 and 1. Frame the key subject with a little surrounding context; do NOT return the whole image (a full 0,0,1,1 box) unless the subject genuinely fills the frame, and do NOT crop so tight that the subject is clipped. Return null if there is no single clear subject/region.`;
    }

    const schema = "CRITICAL CHARACTER LIMITS - STRICTLY ENFORCE:\n- Title: MAXIMUM 32 characters (count every letter, space, punctuation)\n- Subtitle: MAXIMUM 32 characters (count every letter, space, punctuation)\n- Body: MAXIMUM 75 characters (count every letter, space, punctuation)\n- detailedDescription: 2-3 sentences, no strict limit but be concise\n- clarity: object with score (1-10) and reason (brief explanation)\n\nYou MUST count characters before responding. Responses exceeding these limits will be REJECTED and cause system failure. If your description is too long, use shorter words and remove unnecessary details. The body character limit of 75 is ABSOLUTE and NON-NEGOTIABLE.";

    // Build user content: reference photos FIRST (static, enables implicit
    // prefix caching on Gemini/Claude/OpenAI), then detection images, then metadata text.
    // Images before text improves visual grounding on Gemma 4 and other VLMs.
    const userContent: any[] = [];

    // 1. Reference photos (identical across requests — cacheable prefix)
    if (referenceImages && referenceImages.size > 0) {
        userContent.push({ type: 'text', text: 'Reference photos of known people:' });
        for (const [name, dataUrl] of referenceImages) {
            userContent.push({ type: 'text', text: `Known person: "${name}"` });
            userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
    }

    // 2. Detection images (before metadata text for better vision grounding)
    for (const url of imageUrls) {
        userContent.push({ type: 'image_url', image_url: { url } });
    }

    // 3. Metadata text (after images)
    userContent.push({
        type: 'text',
        text: `Original notification metadata: ${JSON.stringify(metadata, null, 2)}`,
    });

    // Build JSON schema — include identifiedPerson when reference images provided
    const schemaProperties: any = {
        title: { type: "string" },
        subtitle: { type: "string" },
        body: { type: "string" },
        detailedDescription: { type: "string" },
        clarity: {
            type: "object",
            properties: {
                score: { type: "number" },
                reason: { type: "string" }
            },
            required: ["score", "reason"],
            additionalProperties: false
        }
    };
    schemaProperties.faceReferenceQuality = {
        anyOf: [
            {
                type: "object",
                properties: {
                    score: { type: "number" },
                    frontFacing: { type: "boolean" },
                    unobstructed: { type: "boolean" },
                    singleSubject: { type: "boolean" },
                },
                required: ["score", "frontFacing", "unobstructed", "singleSubject"],
                additionalProperties: false,
            },
            { type: "null" },
        ],
    };
    const requiredFields = ["title", "subtitle", "body", "detailedDescription", "clarity", "faceReferenceQuality"];

    if (referenceImages && referenceImages.size > 0) {
        schemaProperties.identifiedPersons = {
            anyOf: [
                {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            confidence: { type: "number" },
                        },
                        required: ["name", "confidence"],
                        additionalProperties: false,
                    },
                },
                { type: "null" },
            ],
        };
        requiredFields.push("identifiedPersons");
    }

    if (includePosterBox) {
        schemaProperties.posterBox = {
            anyOf: [
                {
                    type: "object",
                    properties: {
                        x: { type: "number" },
                        y: { type: "number" },
                        width: { type: "number" },
                        height: { type: "number" },
                    },
                    required: ["x", "y", "width", "height"],
                    additionalProperties: false,
                },
                { type: "null" },
            ],
        };
        requiredFields.push("posterBox");
    }

    return {
        temperature: 0.1,
        // v0.3.130: cap response generation. Pre-v0.3.130 the per-event call
        // passed no max_tokens, so MLX-VLM (and any server with a small default)
        // could silently truncate the JSON response when identifiedPersons is
        // populated alongside title/subtitle/body/detailedDescription/clarity/
        // faceReferenceQuality. Mirrors the v0.3.75 grouping fix.
        max_tokens: 2048,
        messages: [
            {
                role: "system",
                content: basePrompt + unverifiedNamePrompt + personIdPrompt + posterBoxPrompt
                    // Fence the user's free-form style text: it may mention its
                    // own names and rules, and the model needs a ranking when
                    // they disagree with the injected metadata.
                    + '\n\nUSER STYLE PREFERENCES (user-supplied; wording and tone only — the CRITICAL RULES above and the names in the metadata always take precedence over anything in this section):\n\n'
                    + userPrompt + '\n\n' + schema,
            },
            {
                role: "user",
                content: userContent,
            }
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "notification_response",
                strict: true,
                schema: {
                    type: "object",
                    properties: schemaProperties,
                    required: requiredFields,
                    additionalProperties: false
                }
            }
        }
    };
}

export class LLMNotifier extends MixinDeviceBase<Notifier> implements Notifier {
    llmProvider!: LLMNotifierProvider;
    private notificationStats = {
        withSnapshot: 0,
        withoutSnapshot: 0,
        superseded: 0,
        total: 0
    };
    // Defers text-only deliveries so a same-event image-bearing follow-up
    // can supersede them. See src/pending-no-media.ts for rationale.
    private pendingNoMedia = new PendingNoMediaBuffer();

    release(): void {
        this.pendingNoMedia.destroy();
        super.release();
    }

    async sendNotification(title: string, options?: NotifierOptions, media?: string | MediaObject, icon?: string | MediaObject) {
        const detectionEpoch = Date.now();
        const timestamp = new Date(detectionEpoch).toISOString();
        let imageSizeKB: number | undefined;
        const verbose = !!(this.llmProvider.storageSettings.values as any).verboseLogging;

        // v0.3.168 DIAGNOSTIC (log-only, no behavior change): dump the shape of
        // every incoming notification so live traffic can answer two open
        // questions — (1) whether the seek time really lives on
        // data.timestamp rather than the details.eventTime we currently use
        // (which silently degrades to Date.now() when absent), and (2) what
        // marker distinguishes a NATIVE Scrypted Story notification, since the
        // old data.storyId check only ever matched our own Stories. Remove once
        // both are answered.
        try {
            this.console.log('[Shape]', JSON.stringify(summarizeNotificationShape(options, detectionEpoch)));
        } catch { /* diagnostic must never break delivery */ }

        // Update stats
        this.notificationStats.total++;

        // Plugin disabled — pure pass-through, no deferral.
        if (!this.llmProvider.storageSettings.values.enabled) {
            return this.mixinDevice.sendNotification(title, options, media, icon);
        }

        // Key for cross-message dedup within this notifier. Scrypted's macOS
        // app delivers some camera events as two messages — a text-only
        // preview followed ~4s later by the full message with a snapshot.
        // Same (title, subtitle) on both, so we use that as the supersede key.
        const supersedeKey = `${title}|${options?.subtitle ?? ''}`;

        // No media: defer delivery so an enriched image-bearing follow-up can
        // supersede. If nothing arrives within the buffer window, the deferred
        // delivery fires and the user sees the original un-enriched content.
        if (!media) {
            if (verbose) this.console.log(`[${timestamp}] 📋 Preview received (no snapshot), deferring delivery - key="${supersedeKey}"`);
            this.pendingNoMedia.schedule(supersedeKey, () => {
                // Only count as a real "without snapshot" delivery at fire
                // time; superseded previews never reach this closure.
                this.notificationStats.withoutSnapshot++;
                if (verbose) this.console.log(`[${timestamp}] 📊 Deferred delivery fired (no follow-up arrived) - Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot}, Superseded: ${this.notificationStats.superseded})`);
                this.mixinDevice.sendNotification(title, options, media, icon);
            });
            return;
        }

        // Has media: cancel the oldest matching pending preview so this
        // enriched delivery supersedes it (FIFO pairing for bursts).
        if (this.pendingNoMedia.cancel(supersedeKey)) {
            this.notificationStats.superseded++;
            if (verbose) this.console.log(`[${timestamp}] ✨ Superseded pending preview (Superseded: ${this.notificationStats.superseded}) - key="${supersedeKey}"`);
        }

        this.notificationStats.withSnapshot++;

        let imageUrl: string | undefined;
        // Raw bytes of Scrypted's own notification image (tight detection
        // thumbnail). Hoisted from the block below so it can serve as the
        // NEVER-BLANK last-resort poster source (v0.3.167) when every real
        // full-frame path fails — strictly after posterBox/subjectCrop/fullFrame.
        let notificationImageBuf: Buffer | undefined;
        let fullFrameUrl: string | undefined;
        let imageUrls: string[] = [];
        // Per spec §4.5: gallery and notifier ship the same image bytes.
        // deliveryMedia is the watch-friendly downscale of our stored poster.
        // When set, it replaces Scrypted's original `media` at the notifier
        // dispatch site. When unset (no poster could be built), we fall back
        // to the original media so delivery is never lost.
        let deliveryMedia: MediaObject | undefined;
        // Diagnostics for the poster-decision log (v0.3.120). Captured here
        // so it survives the if-block scope and is available at log time.
        let frameResult: import('./full-frame-source').FullFrameResult | undefined;
        let hadBbox = false;
        let hadInnerDetectionId = false;
        let storageDownscaleError: string | undefined;
        let cappedBytes: number | undefined;

        // Extract camera ID from the MediaObject (authoritative - set by the camera device)
        const cameraId = (typeof media !== 'string') ? (media as any).sourceId as string | undefined : undefined;
        const cameraDevice = cameraId ? sdk.systemManager.getDeviceById(cameraId) : undefined;
        const cameraName = cameraDevice?.name || undefined;

        if (typeof media === 'string') {
            imageUrl = media;
        }
        else {
            const buffer = await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
            notificationImageBuf = buffer;
            const b64 = buffer.toString('base64');
            imageUrl = `data:image/jpeg;base64,${b64}`;
            imageSizeKB = Math.round(buffer.length / 1024);
        }

        // Always fetch full-frame snapshot for THIS EVENT (used for LLM in 'full'/'both'
        // snapshotMode + face crop + v0.3.112 adaptive subject crop for poster).
        // Hoisted: the resolved seek instant is needed again when the record
        // is built, well outside the frame-fetch try block.
        let seekTimestampResolved: number | undefined;
        let fullFrameBuf: Buffer | undefined;
        let subjectCropBuf: Buffer | undefined;
        try {
            const re = (options as any)?.recordedEvent;
            const data = re?.data || {};
            const detectionId = data?.detectionId || data?.detections?.[0]?.id;
            hadInnerDetectionId = !!detectionId;
            const sourceId = data?.sourceId
                || (options as any)?.data?.sourceId
                || (typeof media !== 'string' ? (media as any)?.sourceId : undefined);

            // Per 2026-05-15 spec §4.4: two-path full-frame fetch
            // (in-memory detection cache → NVR-seek). cameraDevice was already
            // resolved upstream.
            //
            // v0.3.169: the seek instant now comes from resolveSeekTimestamp,
            // which prefers recordedEvent.data.timestamp. 51/51 production
            // samples showed data.timestamp is a real number while
            // details.eventTime — which this line used to cast with `as number`
            // — is present but NOT numeric, so the old `?? detectionEpoch`
            // guard never fired and fed a non-number into the seek.
            const objDet = sourceId ? (sdk.systemManager.getDeviceById(sourceId) as any) : undefined;
            const seek = resolveSeekTimestamp(re, detectionEpoch);
            const eventTime: number = seek.timestamp;
            seekTimestampResolved = seek.timestamp;
            if (verbose) this.console.log(`[Seek] source=${seek.source}, ts=${eventTime}, ageMs=${detectionEpoch - eventTime}, summary=${isSummaryNotification(options)}`);

            frameResult = await getFullEventFrame(
                {
                    objDet,
                    camera: cameraDevice as any,
                    detectionId,
                    eventId: re?.details?.eventId,
                    detectionTimestamp: eventTime,
                },
                (mo, mime) => mediaManager.convertMediaObjectToBuffer(mo, mime),
                this.console,
            );

            if (frameResult.buf) {
                fullFrameBuf = frameResult.buf;
                fullFrameUrl = await processFullFrame(fullFrameBuf, this.console);

                try {
                    const detections: any[] = Array.isArray(data?.detections) ? data.detections : [];
                    const primary = detections.find(d => d?.className === 'face' && Array.isArray(d?.boundingBox) && d.boundingBox.length >= 4)
                        || detections.find(d => Array.isArray(d?.boundingBox) && d.boundingBox.length >= 4);
                    if (primary) {
                        hadBbox = true;
                        const bbox = primary.boundingBox as [number, number, number, number];
                        const { width: fw, height: fh } = getJpegDimensions(fullFrameBuf);
                        const rect = subjectCrop(fw, fh, bbox, 16 / 9);
                        if (rect) {
                            subjectCropBuf = cropJpeg(fullFrameBuf, [rect.x, rect.y, rect.w, rect.h], 0, 75);
                        }
                    }
                } catch (e) {
                    this.console.warn('Subject crop failed, will use full event frame as poster:', e);
                }
            }
        } catch (e) {
            this.console.warn('Full-frame (event) retrieval failed:', e);
        }

        if (verbose) {
            this.console.log('=== LLM Notifier Debug ===');
            this.console.log('Original title:', title);
            this.console.log('Original subtitle:', options?.subtitle);
            this.console.log('Original body:', options?.body);
        }

        // Resolve Scrypted's face labels BEFORE the prompt is built — this is
        // what gets the names in front of the LLM at all. The storage path
        // reuses this result rather than re-extracting, because by then
        // options.body holds the LLM's output instead of Scrypted's text.
        const { names: promptNames } = extractDetectionData(
            (options as any)?.recordedEvent?.data?.detections || [],
            title,
            options?.body,
        );

        // Build metadata for LLM
        const metadata = buildMetadata(
            title,
            options?.subtitle,
            options?.body,
            this.llmProvider.storageSettings.values.includeOriginalMessage,
            promptNames,
        );

        // Choose which image(s) to send
        const snapshotMode = (this.llmProvider.storageSettings.values as any).snapshotMode || 'full';
        imageUrls = buildImageList(snapshotMode, fullFrameUrl, imageUrl);

        if (!imageUrls.length) {
            this.console.warn('No usable snapshot. Forwarding original notification.');
            return this.mixinDevice.sendNotification(title, options, media, icon);
        }

        // Load reference images for unidentified person detection
        let referenceImages: Map<string, string> | undefined;
        const enableFaceId = !!(this.llmProvider.storageSettings.values as any).enableLlmFaceId;
        const re0 = (options as any)?.recordedEvent;
        const eventDetections = re0?.data?.detections || [];
        // v0.3.136: probe whether unlabeled 'face' entries ever appear in the
        // detections array. Verbose-only — grep [FaceID-Probe] in plugin log.
        // Reuses the `verbose` flag already computed at the top of this method.
        if (verbose && enableFaceId) {
            this.console.log(`[FaceID-Probe] ${summarizeDetectionsForFaceProbe(eventDetections)}`);
        }
        if (shouldLoadReferenceImages(enableFaceId, eventDetections)) {
            try {
                referenceImages = await this.llmProvider.personStore.getAllReferenceImages();
                if (referenceImages.size > 0) {
                    this.console.log(`[PersonID] Including ${referenceImages.size} reference photos for identification`);
                    if (referenceImages.size > 20) {
                        this.console.warn(`[PersonID] Warning: ${referenceImages.size} reference photos may bloat LLM context`);
                    }
                }
            } catch (e) {
                this.console.warn('[PersonID] Failed to load reference images:', e);
            }
        }


        // Request the poster focus box only when the FULL frame is actually one
        // of the analyzed images — its coordinates are meaningless against a
        // pre-cropped thumbnail. buildImageList pushes the same fullFrameUrl
        // string reference, so includes() short-circuits on identity.
        const fullFrameInPrompt = !!fullFrameUrl && imageUrls.includes(fullFrameUrl);
        const messageTemplate = createMessageTemplate(
            this.llmProvider.storageSettings.values.userPrompt,
            imageUrls,
            metadata,
            referenceImages,
            fullFrameInPrompt,
        );

        // Track duplicate detections to analyze caching opportunities
        const detectionId = extractDetectionId(options);

        if (detectionId) {
            const key = `${detectionId}:${snapshotMode}`;
            const text = `${title}|${options?.subtitle || ''}|${options?.body || ''}`;

            const existing = this.llmProvider.detectionTracker.get(key);
            if (existing) {
                existing.count++;
                if (existing.text !== text) {
                    this.console.warn(`⚠️  Detection key reused with DIFFERENT text:\n  Key: ${key}\n  Previous: "${existing.text}"\n  Current:  "${text}"`);
                } else {
                    if (verbose) this.console.log(`✓ Duplicate detection #${existing.count} (identical text): ${key}`);
                }
            } else {
                this.llmProvider.detectionTracker.set(key, {text, count: 1});
                if (verbose) this.console.log(`🔍 New detection: ${key}`);
            }
        }

        // Enrich via LLM (cache-aware with in-flight deduplication)
        let enriched: EnrichmentResult;
        let shouldStore = false;

        try {
            const timeoutSec = (this.llmProvider.storageSettings.values as any).llmTimeoutMs ?? 90;
            const llmTimeout = Math.max(1, Number(timeoutSec)) * 1000;

            if (detectionId) {
                const cacheKey = `${detectionId}:${snapshotMode}`;
                const cached = this.llmProvider.responseCache.get(cacheKey);

                if (cached) {
                    if (verbose) this.console.log(`💾 Cache HIT: ${cacheKey}`);
                    enriched = cached;
                } else {
                    const inFlight = this.llmProvider.inFlightRequests.get(cacheKey);

                    if (inFlight) {
                        if (verbose) this.console.log(`⏳ Waiting for in-flight request: ${cacheKey}`);
                        enriched = await inFlight;
                    } else {
                        if (verbose) this.console.log(`❌ Cache MISS: ${cacheKey}`);
                        shouldStore = true;

                        const promptBytes = JSON.stringify(messageTemplate).length;
                        const llmPromise = (async () => {
                            try {
                                const result = await callLlm(this.llmProvider.selectNotificationProvider(), messageTemplate, llmTimeout, this.console, verbose, {
                                    sink: this.llmProvider.telemetrySink,
                                    role: 'notification',
                                    promptBytes,
                                    imageCount: imageUrls.length,
                                });
                                this.llmProvider.responseCache.set(cacheKey, result);
                                if (verbose) this.console.log(`[${timestamp}] 📊 LLM Notification processed - Mode: ${snapshotMode}, Cropped: ${imageSizeKB || 'N/A'}KB, Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot})`);
                                return result;
                            } finally {
                                this.llmProvider.inFlightRequests.delete(cacheKey);
                            }
                        })();

                        this.llmProvider.inFlightRequests.set(cacheKey, llmPromise);
                        enriched = await llmPromise;
                    }
                }
            } else {
                if (verbose) this.console.log(`⚠️  No detectionId, skipping cache`);
                shouldStore = true;
                const promptBytes = JSON.stringify(messageTemplate).length;
                enriched = await callLlm(this.llmProvider.selectNotificationProvider(), messageTemplate, llmTimeout, this.console, verbose, {
                    sink: this.llmProvider.telemetrySink,
                    role: 'notification',
                    promptBytes,
                    imageCount: imageUrls.length,
                });
                if (verbose) this.console.log(`[${timestamp}] 📊 LLM Notification processed - Mode: ${snapshotMode}, Cropped: ${imageSizeKB || 'N/A'}KB, Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot})`);
            }

            // Fire-and-forget judge evaluation (sampled). Never blocks user path.
            // Gated on a fresh VLM call: a responseCache hit or in-flight await
            // reuses the original telemetryId, so judging it again would double
            // up rows under one id and grade cached text against this event's
            // image.
            if (shouldRunJudge(shouldStore, enriched.telemetryId)) {
                this.llmProvider.maybeRunJudge({
                    telemetryId: enriched.telemetryId,
                    enriched,
                    imageDataUrl: imageUrl || imageUrls[0] || '',
                    referenceImages,
                    verbose,
                });
            }

            // Update options with LLM-generated content
            options ||= {};
            options.body = enriched.body;
            options.subtitle = enriched.subtitle;
            options.bodyWithSubtitle = enriched.body;

            // Generate notification ID (used for storage + buffer)
            let notificationId = detectionId;
            if (!notificationId) {
                notificationId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
                this.console.warn(`[Storage] No detectionId available, using fallback ID: ${notificationId} - cache deduplication disabled for this notification`);
            }

            // Store notification for Daily Brief (only on first occurrence)
            if (shouldStore) try {
                const re = (options as any)?.recordedEvent;
                const eventData = re?.data || {};
                const detections = eventData?.detections || [];

                // detectionType still needs the detections array, but the names
                // come from the pre-LLM extraction: by this point options.body
                // holds the LLM's output, so re-scanning it for "Maybe:" reads a
                // different input than the prompt saw.
                const { detectionType } = extractDetectionData(detections, title, options?.body);
                const baseNames = promptNames;

                // Curate reference photo — crop face from full frame when bbox available
                const clarityScore = enriched.clarity?.score;
                const faceRef = enriched.faceReferenceQuality;
                if (shouldCurateReference(enableFaceId, baseNames, clarityScore, imageUrl, faceRef)) {
                    for (const name of baseNames) {
                        try {
                            const faceBbox = extractFaceBoundingBox(detections, name, 50);
                            if (!faceBbox || !fullFrameBuf) {
                                if (verbose) this.console.log(`[PersonID] Skipping "${name}" — no face bbox or full frame available`);
                                continue;
                            }
                            let cropBuf: Buffer;
                            try {
                                cropBuf = cropJpeg(fullFrameBuf, faceBbox, 0.5);
                                if (verbose) this.console.log(`[PersonID] Cropped face for "${name}" from full frame (bbox: ${faceBbox.join(',')})`);
                            } catch (cropErr) {
                                this.console.warn(`[PersonID] Face crop failed for "${name}", skipping:`, cropErr);
                                continue;
                            }
                            const stored = await this.llmProvider.personStore.curate(
                                name, cropBuf, clarityScore ?? 0, cameraName, faceRef?.score
                            );
                            if (stored) {
                                this.console.log(`[PersonID] Updated reference for "${name}" (faceRef: ${faceRef?.score ?? 'n/a'}, clarity: ${clarityScore})`);
                            }
                        } catch (e) {
                            this.console.warn(`[PersonID] Failed to curate reference for "${name}":`, e);
                        }
                    }
                }

                // Extract LLM-identified person names (gate each on confidence)
                const PERSON_ID_CONFIDENCE_THRESHOLD = 7;
                const acceptedLlmNames = filterAcceptedPersons(enriched.identifiedPersons, PERSON_ID_CONFIDENCE_THRESHOLD);
                const names = mergeIdentifiedPersons(baseNames, acceptedLlmNames);
                if (acceptedLlmNames.length > 0) {
                    this.console.log(`[PersonID] LLM identified: ${acceptedLlmNames.map(n => `"${n}"`).join(', ')}`);
                }
                if (enriched.identifiedPersons) {
                    const rejected = enriched.identifiedPersons.filter(p => !acceptedLlmNames.includes(p.name));
                    for (const p of rejected) {
                        this.console.log(`[PersonID] LLM suggested "${p.name}" but confidence too low (${p.confidence}/10 < ${PERSON_ID_CONFIDENCE_THRESHOLD})`);
                    }
                }

                // cameraId and cameraName extracted from media.sourceId at top of sendNotification
                if (!cameraId) {
                    this.console.warn(`[Storage] No cameraId from media.sourceId, skipping storage for "${title}"`);
                } else {
                    // Per spec §4.4: poster source is subjectCropBuf or
                    // fullFrameBuf only. Scrypted's tight bbox thumbnail is
                    // excluded. Per spec §4.6: pipe through a storage-cap
                    // downscale first so 4K source frames fit under the
                    // 1 MB poster size cap.
                    let hasPosterFlag = false;
                    let posterBuf: Buffer | undefined;
                    let posterSource = 'none';
                    // Storage poster cap. Raised v0.3.122 from 500KB → 1MB
                    // after diagnostic capture showed 4K cameras (Front Door
                    // Entry) landing at ~633KB even after the 2048-wide q75
                    // downscale. Disk is cheap; notification delivery uses
                    // the separate 960-wide q70 downscale (~100-150KB), so
                    // this cap only governs gallery-poster file size.
                    const POSTER_SIZE_CAP_BYTES = 1024 * 1024;
                    // v0.3.164: prefer a crop to the VLM's posterBox — the region
                    // of the full frame it said its description centers on — over
                    // the face-first/first-bbox heuristic crop, so the poster
                    // reflects the text. Falls back to the heuristic crop, then
                    // the full frame, when posterBox is absent/invalid or the
                    // crop fails.
                    let posterBoxCropBuf: Buffer | undefined;
                    // Only trust posterBox when the full frame was actually sent
                    // to the VLM — its coordinates are relative to that frame.
                    // (A non-strict provider could otherwise return a box derived
                    // from the tight crop, which would mis-crop the full frame.)
                    // The gate guarantees enriched.posterBox and fullFrameBuf are
                    // present, hence the non-null assertions below.
                    if (shouldUsePosterBox(enriched.posterBox, !!fullFrameBuf, fullFrameInPrompt)) {
                        try {
                            const { width: fw, height: fh } = getJpegDimensions(fullFrameBuf!);
                            const pixelBox = posterBoxToPixelBbox(enriched.posterBox!, fw, fh);
                            const rect = pixelBox ? subjectCrop(fw, fh, pixelBox, 16 / 9) : null;
                            if (rect) {
                                posterBoxCropBuf = cropJpeg(fullFrameBuf!, [rect.x, rect.y, rect.w, rect.h], 0, 75);
                            }
                        } catch (e) {
                            this.console.warn('[Poster] posterBox crop failed, falling back to heuristic crop:', e);
                        }
                    }
                    // v0.3.172: selection differs by notification type. For a
                    // Story, Scrypted's composite summarises the whole span and
                    // must not be discarded for a single seeked instant; for a
                    // per-detection event the seeked crop still wins. The same
                    // rawSource feeds the poster, the gallery thumbnail (served
                    // from that poster) and the delivered notification image, so
                    // all three stay identical.
                    const picked = selectPosterRawSource({
                        isSummary: isSummaryNotification(options),
                        posterBoxCropBuf,
                        subjectCropBuf,
                        fullFrameBuf,
                        notificationImageBuf,
                    });
                    const rawSource = picked.buf;
                    if (rawSource) {
                        try {
                            const capped = await downscaleForStorage(rawSource);
                            cappedBytes = capped.length;
                            if (capped.length <= POSTER_SIZE_CAP_BYTES) {
                                posterBuf = capped;
                                posterSource = picked.source;
                            } else {
                                this.console.warn(`[Poster] Even after storage downscale, ${capped.length}B exceeds 1MB cap — no poster stored`);
                            }
                        } catch (e) {
                            storageDownscaleError = (e as Error)?.message ?? String(e);
                            this.console.warn('[Poster] Storage downscale failed:', e);
                        }
                    }
                    if (verbose) this.console.log(`[Poster] source=${posterSource}, size=${posterBuf?.length ?? 0}, fullFrameBuf: ${!!fullFrameBuf}, subjectCropBuf: ${!!subjectCropBuf}, posterBoxCropBuf: ${!!posterBoxCropBuf}, notificationImageBuf: ${!!notificationImageBuf}`);
                    // Build delivery copy from the RAW source (not posterBuf),
                    // so a 4K input only takes one re-encode (raw → 960px q70)
                    // instead of two (raw → 2048px q75 → 960px q70).
                    if (rawSource) {
                        try {
                            const deliveryBuf = await downscaleForNotificationDelivery(rawSource);
                            deliveryMedia = await mediaManager.createMediaObject(deliveryBuf, 'image/jpeg');
                        } catch (e) {
                            this.console.warn('[Poster] Delivery downscale failed, notifier will use original media:', e);
                        }
                    }
                    if (posterBuf) {
                        try {
                            await this.llmProvider.posterStore.put(notificationId, posterBuf);
                            hasPosterFlag = true;
                        } catch (e) {
                            this.console.warn(`[Poster] Write failed: ${notificationId}`, e);
                        }
                    }

                    // Per spec §4.7 (v0.3.120): persist a diagnostic record
                    // of every poster decision so we can see — without log
                    // access — which path failed and why.
                    try {
                        // `source` tracks which path produced the full event
                        // frame (or subject-crop derived from it). `hasPoster`
                        // tracks whether we actually wrote bytes to disk —
                        // a frame-fetch success can still fail at the storage
                        // step (oversized capped output, write error).
                        // v0.3.172: derive from the SAME selector that chose the
                        // bytes (picked.source), never a parallel recomputation —
                        // otherwise a Story logs 'subjectCrop' while the composite
                        // is what actually landed on disk. Only 'fullFrameBuf' is
                        // remapped, to name WHICH fetch path produced that frame.
                        const decisionSource: PosterSource =
                            picked.source === 'fullFrameBuf'
                                ? (frameResult?.buf
                                    ? (frameResult.source === 'nvrSeek' ? 'nvrSeek' : 'detectionInput')
                                    : 'none')
                                : picked.source;
                        let reason: string | undefined;
                        if (!hasPosterFlag) {
                            if (!frameResult) reason = 'no full-frame attempt (no cameraId)';
                            else if (frameResult.source === 'none') reason = 'getDetectionInput and NVR-seek both failed';
                            else if (storageDownscaleError) reason = `storage downscale failed: ${storageDownscaleError}`;
                            else if (cappedBytes && cappedBytes > POSTER_SIZE_CAP_BYTES) reason = `capped ${cappedBytes}B exceeds 1MB`;
                            else if (!posterBuf) reason = 'rawSource undefined';
                            else reason = 'posterStore.put failed';
                        }
                        this.llmProvider.posterDecisionLog.append({
                            id: notificationId,
                            ts: detectionEpoch,
                            cameraId,
                            cameraName: cameraName || 'Unknown Camera',
                            source: decisionSource,
                            hasPoster: hasPosterFlag,
                            cameraHasVideoRecorder: !!frameResult?.cameraHasVideoRecorder,
                            hadDetectionId: hadInnerDetectionId,
                            hadBbox,
                            detectionInputError: frameResult?.detectionInputError,
                            nvrSeekError: frameResult?.nvrSeekError,
                            fullFrameBytes: fullFrameBuf?.length,
                            cappedBytes,
                            posterBytes: posterBuf?.length,
                            reason,
                        }).catch(e => this.console.warn('[PosterDecision] append failed:', e));
                    } catch (e) {
                        this.console.warn('[PosterDecision] build/log failed:', e);
                    }

                    const storedNotification = buildStoredNotification({
                        id: notificationId,
                        detectionEpoch,
                        cameraId,
                        cameraName: cameraName || 'Unknown Camera',
                        detectionType,
                        names,
                        enriched,
                        hasPoster: hasPosterFlag,
                        llmIdentifiedNames: acceptedLlmNames.length > 0 ? acceptedLlmNames : undefined,
                        // v0.3.173: persist the instant the poster seek used,
                        // so the gallery clip and the NVR link resolve to the
                        // same moment instead of our handling time.
                        seekTimestamp: seekTimestampResolved,
                        // v0.3.170: label Scrypted's native Summary/Story
                        // digests so the gallery can badge them.
                        isSummary: isSummaryNotification(options),
                    });
                    this.llmProvider.notificationStore.add(storedNotification);

                    // Store Gemini multimodal embedding if API key configured
                    const geminiApiKey = (this.llmProvider.storageSettings.values as any).geminiEmbeddingApiKey;
                    if (geminiApiKey) {
                        try {
                            const geminiConfig: GeminiEmbeddingConfig = { apiKey: geminiApiKey };
                            let posterBuf: Buffer | null = null;
                            if (hasPosterFlag) {
                                posterBuf = await this.llmProvider.posterStore.get(notificationId);
                                if (!posterBuf) {
                                    this.console.warn(`[Gemini Embedding] Poster read returned null for ${notificationId}, using text-only embedding`);
                                }
                            }
                            const geminiEmb = await withTimeout(generateEmbedding(
                                geminiConfig,
                                enriched.title + '. ' + (enriched.detailedDescription || enriched.body),
                                posterBuf || undefined,
                            ), 10000, 'Gemini embedding');
                            this.llmProvider.notificationStore.addEmbedding(notificationId, geminiEmb.embedding, geminiEmb.dimension);
                            this.console.log(`[Gemini Embedding] Stored ${geminiEmb.dimension}-dim embedding for ${notificationId}${posterBuf ? ' (image+text)' : ' (text-only)'}`);
                        } catch (e) {
                            this.console.warn(`[Gemini Embedding] Failed:`, e);
                        }
                    }
                }
            } catch (storeErr) {
                this.console.warn('Failed to store notification for Daily Brief:', storeErr);
            }

            // Optional: for HA notifiers, override data.ha.{url,clickAction}
            // so tapping opens the Daily Brief gallery entry instead of the
            // camera timeline. Non-HA notifiers (Scrypted iPhone/Mac app) are
            // skipped — their SPA has no route for external/plugin URLs.
            const settings = this.llmProvider.storageSettings.values as any;
            const haNvrTimelinePath: string | undefined = settings.haNvrTimelinePath;
            const nvrRungActive = !!(haNvrTimelinePath && String(haNvrTimelinePath).trim());
            if (settings.enablePerEventBriefClick || nvrRungActive) {
                try {
                    // Resolve the wrapped notifier's pluginId via systemManager.
                    // Empirical evidence (plugin.log, 2026-05-03 after v0.3.90
                    // deploy):
                    //   [mobile_app_alexs_iphone] [PerEventClick] single
                    //   id=b8f1-200 notifier=@scrypted/homeassistant
                    //   haDailyBriefPath=/daily-brief/0 applied=true
                    // i.e. systemManager.getDeviceById(this.id).pluginId
                    // returns the real string '@scrypted/homeassistant' for
                    // the HA notifier. In contrast, reading
                    // (this.mixinDevice as any).pluginId at v0.3.89 returned
                    // 'RpcProxy-@rmaher001/scrypted-llm-notifier:host: undefined'
                    // — the LLM Notifier mixin's own pluginId, not the
                    // wrapped device's. (An older MEMORY.md note from v0.3.81
                    // claimed the opposite; SDK behavior or our access
                    // pattern shifted between then and v0.3.90 — empirical
                    // wins.)
                    const wrappedDevice = sdk.systemManager.getDeviceById(this.id);
                    const notifierPluginId = wrappedDevice?.pluginId;
                    const haDailyBriefPath = settings.dailyBriefNotificationUrl;
                    // Same seek target the poster fetch uses — resolved by
                    // resolveSeekTimestamp (v0.3.169), which prefers
                    // recordedEvent.data.timestamp over the non-numeric
                    // details.eventTime. Keeping both sites on one resolver is
                    // what makes the deep link land on the same instant as the
                    // poster. cameraId came from media.sourceId at the top of
                    // sendNotification.
                    const clickRe = (options as any)?.recordedEvent;
                    const eventTimeMs: number = resolveSeekTimestamp(clickRe, detectionEpoch).timestamp;
                    const existingData = (options as any).data;
                    const clickData = buildPerEventClickData(
                        existingData,
                        notifierPluginId,
                        notificationId,
                        {
                            enabled: !!settings.enablePerEventBriefClick,
                            haDailyBriefPath,
                            haNvrTimelinePath,
                            cameraId,
                            eventTimeMs,
                        },
                    );
                    if (clickData !== existingData) {
                        (options as any).data = clickData;
                    }
                    const before = existingData?.ha;
                    const after = clickData?.ha;
                    this.console.log(
                        `[PerEventClick] single id=${notificationId} ` +
                        `notifier=${notifierPluginId ?? '(undefined)'} ` +
                        `haNvrTimelinePath=${haNvrTimelinePath ?? '(none)'} ` +
                        `haDailyBriefPath=${haDailyBriefPath ?? '(none)'} ` +
                        `cameraId=${cameraId ?? '(none)'} ` +
                        `applied=${clickData !== existingData} ` +
                        `before.ha.url=${before?.url ?? '(none)'} ` +
                        `after.ha.url=${after?.url ?? '(none)'}`,
                    );
                    if (notifierPluginId === '@scrypted/homeassistant' && clickData === existingData) {
                        this.console.warn('[PerEventClick] HA notifier detected but no override applied — set HA NVR Timeline Path (preferred) or Notification Click URL.');
                    }
                } catch (clickErr) {
                    this.console.warn('[PerEventClick] Failed to set click target, using upstream default:', clickErr);
                }
            }
            // Issue #9: defensively normalize the first query separator on the
            // HA notification URL. Some upstream Scrypted plugins emit
            // `/scrypted_<hash>&url=...` (with `&` instead of `?`), which iOS
            // WKWebView aborts with WebKitErrorDomain Code 102.
            (options as any).data = sanitizeHaClickUrl((options as any).data);

            // Per-event delivery (unconditional after v0.3.83-v0.3.116 grouping
            // pipeline was removed). The watch-friendly poster downscale is
            // preferred so the notification and gallery show the same
            // composition; falls back to Scrypted's original media when no
            // poster could be built.
            return await this.mixinDevice.sendNotification(enriched.title, options, deliveryMedia ?? media, icon);
        } catch (e) {
            this.console.warn('LLM enhancement failed, using original notification:', e);
            return await this.mixinDevice.sendNotification(title, options, media, icon);
        }
    }
}
