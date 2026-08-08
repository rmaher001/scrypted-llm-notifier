// ============================================================================
// Gallery: Search, filtering, pagination, and thumbnail delivery
// ============================================================================

import { StoredNotification } from './types';
import { NotificationStore } from './notification-store';
import { PersonStore } from './person-store';
import { generateQueryEmbedding, GeminiEmbeddingConfig } from './gemini-embedding';

// ---- Embedding math ----

export function decodeEmbedding(base64: string): Float32Array {
    const buf = Buffer.from(base64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

export function cosineDistance(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom === 0) return 0;
    return dot / denom;
}

// ---- Keyword search fallback ----

export function keywordSearch(query: string, notifications: StoredNotification[]): StoredNotification[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    if (terms.length === 0) return [];

    const scored: { n: StoredNotification; score: number }[] = [];
    for (const n of notifications) {
        const searchText = [
            n.llmTitle,
            n.llmSubtitle,
            n.llmBody,
            n.detailedDescription || '',
            n.cameraName,
            ...n.names,
            ...(n.llmIdentifiedNames || []),
            n.llmIdentifiedName || '',
        ].join(' ').toLowerCase();
        const matchCount = terms.filter(t => searchText.includes(t)).length;
        if (matchCount > 0) {
            scored.push({ n, score: matchCount / terms.length });
        }
    }

    // Sort by match score descending, then by recency
    scored.sort((a, b) => b.score - a.score || b.n.timestamp - a.n.timestamp);
    return scored.map(s => s.n);
}

// ---- Group collapsing ----

/**
 * Build the gallery card thumbnail URL for a notification.
 *
 * Per 2026-05-15 spec §4.5/§4.8 (v0.3.123): grouped events show the composite
 * in their gallery card, matching the image shown in the notification. Solo
 * events fall back to their per-event poster. Drill-down view always uses
 * the per-event poster (the group hero shell renders the composite
 * separately above the strip).
 *
 * Singleton "groups" (size=1) and orphans (size=undefined) fall back to the
 * per-event poster because no composite was written for those cases.
 *
 * Call-site assumption: in the flat-list path, callers pass only group
 * primaries (collapseByGroup filters non-primaries upstream). The helper
 * does NOT re-check isGroupPrimary — a non-primary passed in with
 * groupSize > 1 would still get the composite URL, which is undefined behavior.
 */
export function buildThumbnailUrl(
    n: StoredNotification,
    base: string,
    _opts: { isDrillDown: boolean; groupSize?: number },
): string {
    // Always return the per-event poster URL. Group composite posters were
    // produced by the deleted v0.3.83-v0.3.116 grouping pipeline; the
    // composite endpoint is gone and any group-* poster URL now 404s. Old
    // JSONL records may still carry `groupId`, but Phase 8 migration strips
    // them. Until that runs, this function ignores groupId to avoid broken
    // image URLs against existing data.
    return n.hasPoster ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '';
}

/**
 * Build a per-group union of identified names so the gallery card's
 * name badges reflect everyone identified across the WHOLE group, not
 * just the primary record. Pre-v0.3.129 bug: a primary that didn't
 * catch a face left the card with no badge even when other group
 * members had clearly identified the same person in the composite.
 */
export interface GroupNamesEntry {
    /** Scrypted face-recognition names (StoredNotification.names) union. */
    names: string[];
    /** LLM-identified names (llmIdentifiedNames + legacy llmIdentifiedName) union. */
    llmIdentifiedNames: string[];
}

export function buildGroupNamesIndex(
    notifications: StoredNotification[],
): Map<string, GroupNamesEntry> {
    const idx = new Map<string, { names: Set<string>; llm: Set<string> }>();
    for (const n of notifications) {
        if (!n.groupId) continue;
        let entry = idx.get(n.groupId);
        if (!entry) {
            entry = { names: new Set<string>(), llm: new Set<string>() };
            idx.set(n.groupId, entry);
        }
        for (const name of n.names || []) entry.names.add(name);
        for (const name of n.llmIdentifiedNames || []) entry.llm.add(name);
        if (n.llmIdentifiedName) entry.llm.add(n.llmIdentifiedName);
    }
    const out = new Map<string, GroupNamesEntry>();
    for (const [gid, e] of idx) {
        out.set(gid, {
            names: Array.from(e.names),
            llmIdentifiedNames: Array.from(e.llm),
        });
    }
    return out;
}

export function collapseByGroup(notifications: StoredNotification[]): StoredNotification[] {
    return notifications.filter(n => {
        if (!n.groupId) return true;            // ungrouped — show as-is
        if (n.isGroupPrimary) return true;      // show primary only
        return false;                           // hide non-primary group members
    });
}

// ---- Pagination & filtering ----

interface GalleryFilters {
    camera?: string;
    type?: string;
    name?: string;
}

interface GalleryNotification {
    id: string;
    timestamp: number;
    cameraId: string;
    cameraName: string;
    detectionType: string;
    names: string[];
    llmTitle: string;
    llmBody: string;
    /** llmSubtitle of the source notification — needed by clients that
     *  reconstruct the grouping-LLM input text (e.g. burst extraction). */
    subtitle: string;
    /** Long-form description used by the production grouping prompt. May be
     *  empty when the source notification was buffered before description
     *  generation completed. */
    detailedDescription?: string;
    thumbnailUrl: string;
    hasEmbedding: boolean;
    groupId?: string;
    groupSize?: number;
    llmIdentifiedName?: string;
    llmIdentifiedNames?: string[];
    /** True = Scrypted native Summary/Story digest; drives the gallery Story badge. */
    isSummary?: boolean;
    /** Instant to seek the NVR to — the same one the poster used. Differs from
     *  `timestamp` (our handling time) by minutes on a Story. */
    seekTimestamp?: number;
}

interface GalleryPageResult {
    notifications: GalleryNotification[];
    total: number;
    page: number;
    hasMore: boolean;
    filters: {
        cameras: string[];
        types: string[];
        names: string[];
    };
    groupTitle?: string;
    groupMemberCount?: number;
    // Group hero view metadata — only set on drill-down responses.
    groupId?: string;
    groupBody?: string;
    groupHeroUrl?: string;
    groupStartMs?: number;
    groupDurationMs?: number;
    groupPrimaryId?: string;
}

export function getGalleryPage(
    notifications: StoredNotification[],
    page: number,
    pageSize: number,
    filters: GalleryFilters,
    embeddings?: Map<string, { embedding: string; dimension: number }>,
    baseUrl?: string,
    groupId?: string,
): GalleryPageResult {
    const isDrillDown = !!groupId;

    // In drill-down mode, filter to only group members and skip collapsing
    let working: StoredNotification[];
    let groupTitle: string | undefined;
    let groupMemberCount: number | undefined;
    let groupSizesMap: Map<string, number> | undefined;

    let groupBody: string | undefined;
    let groupHeroUrl: string | undefined;
    let groupStartMs: number | undefined;
    let groupDurationMs: number | undefined;

    if (isDrillDown) {
        working = notifications.filter(n => n.groupId === groupId);
        const primary = working.find(n => n.isGroupPrimary);
        // Prefer persisted LLM group title/body when set; fall back to primary's own
        // event-level fields for backward compat with groups created before persistence.
        groupTitle = primary?.llmGroupTitle ?? primary?.llmTitle;
        groupBody = primary?.llmGroupBody ?? primary?.llmBody;
        groupMemberCount = working.length;

        if (working.length > 0) {
            const timestamps = working.map(n => n.timestamp);
            groupStartMs = Math.min(...timestamps);
            groupDurationMs = Math.max(...timestamps) - groupStartMs;
        }

        if (groupId) {
            const base = baseUrl || '';
            // Composite poster files were produced by the deleted
            // v0.3.83-v0.3.116 grouping pipeline; no `group-*` posters get
            // written anymore. Point drill-down hero at the primary's
            // per-event poster instead (empty string if the primary has no
            // poster on disk). Phase 8 migration removes drill-down entirely.
            const primaryRec = working.find(n => n.isGroupPrimary);
            groupHeroUrl = primaryRec?.hasPoster
                ? `${base}/brief/snapshot?id=${encodeURIComponent(primaryRec.id)}`
                : '';
        }
    } else {
        // Compute group sizes before collapsing (count members per groupId)
        groupSizesMap = new Map<string, number>();
        for (const n of notifications) {
            if (n.groupId) {
                groupSizesMap.set(n.groupId, (groupSizesMap.get(n.groupId) || 0) + 1);
            }
        }

        // Collapse groups to show only primary notifications
        working = collapseByGroup(notifications);
    }

    // Per-group name union — used in the flat-list to surface all identified
    // names on the card badge, in the filter dropdown, and as the predicate
    // for the name filter — not just the primary's (v0.3.129).
    const groupNamesIndex = isDrillDown ? undefined : buildGroupNamesIndex(notifications);

    // Helpers that fold the group union into the per-notification name views.
    const effectiveScryptedNames = (n: StoredNotification): string[] => {
        if (!isDrillDown && n.groupId) {
            const e = groupNamesIndex?.get(n.groupId);
            if (e) return e.names;
        }
        return n.names || [];
    };
    const effectiveLlmNames = (n: StoredNotification): string[] => {
        if (!isDrillDown && n.groupId) {
            const e = groupNamesIndex?.get(n.groupId);
            if (e) return e.llmIdentifiedNames;
        }
        return n.llmIdentifiedNames || (n.llmIdentifiedName ? [n.llmIdentifiedName] : []);
    };

    // Collect filter options — uses the effective name views so a name
    // identified only by a non-primary group member still appears in the
    // dropdown and is reachable via filtering.
    const cameraSet = new Set<string>();
    const typeSet = new Set<string>();
    const nameSet = new Set<string>();
    for (const n of working) {
        cameraSet.add(n.cameraName);
        typeSet.add(n.detectionType);
        for (const name of effectiveScryptedNames(n)) nameSet.add(name);
        for (const name of effectiveLlmNames(n)) nameSet.add(name);
    }

    // Apply filters
    let filtered = working;
    if (filters.camera) {
        filtered = filtered.filter(n => n.cameraName === filters.camera);
    }
    if (filters.type) {
        filtered = filtered.filter(n => n.detectionType === filters.type);
    }
    if (filters.name) {
        filtered = filtered.filter(n =>
            effectiveScryptedNames(n).includes(filters.name!) ||
            effectiveLlmNames(n).includes(filters.name!),
        );
    }

    // Sort newest first (storage order may be chronological after JSONL migration)
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);

    const base = baseUrl || '';
    const galleryNotifications: GalleryNotification[] = paged.map(n => {
        const gs = isDrillDown ? undefined : (n.groupId && groupSizesMap ? groupSizesMap.get(n.groupId) : undefined);
        // For grouped primaries (gs > 1), badge names come from the union
        // across all members so a face IDed by any member shows on the card.
        const useGroupNames = !isDrillDown && !!n.groupId && (gs ?? 0) > 1;
        const groupEntry = useGroupNames ? groupNamesIndex?.get(n.groupId!) : undefined;
        return {
            id: n.id,
            timestamp: n.timestamp,
            cameraId: n.cameraId,
            cameraName: n.cameraName,
            detectionType: n.detectionType,
            names: groupEntry?.names ?? n.names,
            llmTitle: n.llmTitle,
            llmBody: n.llmBody,
            subtitle: n.llmSubtitle,
            detailedDescription: n.detailedDescription,
            thumbnailUrl: buildThumbnailUrl(n, base, { isDrillDown, groupSize: gs }),
            hasEmbedding: embeddings ? embeddings.has(n.id) : false,
            groupId: n.groupId,
            groupSize: gs,
            llmIdentifiedName: n.llmIdentifiedName,
            llmIdentifiedNames: groupEntry?.llmIdentifiedNames ?? n.llmIdentifiedNames,
            isSummary: n.isSummary,
            seekTimestamp: n.seekTimestamp,
        };
    });

    const result: GalleryPageResult = {
        notifications: galleryNotifications,
        total,
        page,
        hasMore: start + pageSize < total,
        filters: {
            cameras: Array.from(cameraSet).sort(),
            types: Array.from(typeSet).sort(),
            names: Array.from(nameSet).sort(),
        },
    };

    if (isDrillDown) {
        result.groupId = groupId;
        result.groupTitle = groupTitle;
        result.groupMemberCount = groupMemberCount;
        result.groupBody = groupBody;
        result.groupHeroUrl = groupHeroUrl;
        result.groupStartMs = groupStartMs;
        result.groupDurationMs = groupDurationMs;
        const primary = working.find(n => n.isGroupPrimary);
        if (primary) {
            result.groupPrimaryId = primary.id;
        }
    }

    return result;
}

// ---- Text bonus for hybrid ranking ----

export function computeTextBonus(query: string, n: StoredNotification): number {
    const q = query.toLowerCase();
    const terms = q.split(/\s+/).filter(t => t.length > 1);
    if (terms.length === 0) return 0;
    const searchText = [
        n.llmTitle, n.llmBody, n.detailedDescription || '',
        n.cameraName, ...n.names, ...(n.llmIdentifiedNames || []),
    ].join(' ').toLowerCase();
    const matchCount = terms.filter(t => searchText.includes(t)).length;
    return matchCount / terms.length;
}

// ---- Semantic search with hybrid ranking ----

export const MIN_SIMILARITY = 0.15;

// Hybrid scoring weights — must sum to 1.0
// Text bonus weighted heavily because fixed cameras produce compressed cosine scores
export const WEIGHT_SIMILARITY = 0.50;
export const WEIGHT_RECENCY = 0.15;
export const WEIGHT_TEXT = 0.35;

// Per-camera normalization weights — must sum to 1.0
export const WEIGHT_GLOBAL = 0.60;
export const WEIGHT_PER_CAMERA = 0.40;

interface ScoredItem {
    id: string;
    cameraId: string;
    rawSimilarity: number;
}

/**
 * Normalize cosine similarity scores within each camera group, then blend
 * with global scores. Prevents cameras with uniformly high baselines
 * (fixed background) from dominating search results.
 */
export function normalizeByCameraGroup(items: ScoredItem[]): Map<string, number> {
    if (items.length === 0) return new Map();

    // Group by cameraId
    const groups = new Map<string, ScoredItem[]>();
    for (const item of items) {
        const group = groups.get(item.cameraId);
        if (group) group.push(item);
        else groups.set(item.cameraId, [item]);
    }

    // Compute blended scores
    const result = new Map<string, number>();
    for (const group of groups.values()) {
        let min = Infinity, max = -Infinity;
        for (const item of group) {
            if (item.rawSimilarity < min) min = item.rawSimilarity;
            if (item.rawSimilarity > max) max = item.rawSimilarity;
        }
        const range = max - min;

        for (const item of group) {
            const perCameraNorm = range === 0 ? item.rawSimilarity : (item.rawSimilarity - min) / range;
            result.set(item.id, WEIGHT_GLOBAL * item.rawSimilarity + WEIGHT_PER_CAMERA * perCameraNorm);
        }
    }

    return result;
}

interface SearchResult extends GalleryNotification {
    score: number;
}

export async function semanticSearch(
    query: string,
    notifications: StoredNotification[],
    embeddings: Map<string, { embedding: string; dimension: number }>,
    baseUrl?: string,
    retentionDays?: number,
    geminiConfig?: GeminiEmbeddingConfig,
): Promise<{ results: SearchResult[]; mode: 'semantic' | 'keyword' }> {
    if (!geminiConfig) {
        throw new Error('semanticSearch requires geminiConfig');
    }

    // Get query embedding
    let queryEmbedding: Float32Array;
    try {
        queryEmbedding = await generateQueryEmbedding(geminiConfig, query);
    } catch (error: any) {
        console.warn('[Gallery] Embedding generation failed, falling back to keyword search:', error?.message || error);
        // Fall back to keyword search
        const kwResults = keywordSearch(query, notifications);
        const base = baseUrl || '';
        return {
            results: kwResults.map(n => ({
                id: n.id,
                timestamp: n.timestamp,
                cameraId: n.cameraId,
                cameraName: n.cameraName,
                detectionType: n.detectionType,
                names: n.names,
                llmTitle: n.llmTitle,
                llmBody: n.llmBody,
                subtitle: n.llmSubtitle,
                detailedDescription: n.detailedDescription,
                thumbnailUrl: n.hasPoster ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '',
        // Search results render through the SAME card renderer as normal
        // browsing, so they need the seek anchor and the Story flag too —
        // omitting them silently fell back to our handling time.
        seekTimestamp: n.seekTimestamp,
        isSummary: n.isSummary,
                hasEmbedding: embeddings.has(n.id),
                llmIdentifiedName: n.llmIdentifiedName,
                llmIdentifiedNames: n.llmIdentifiedNames,
                score: 0,
            })),
            mode: 'keyword',
        };
    }

    // First pass: compute raw cosine similarities
    const MAX_RESULTS = 100;
    const now = Date.now();
    const maxAge = (retentionDays ?? 3) * 24 * 60 * 60 * 1000;
    const base = baseUrl || '';

    interface RawResult {
        notification: StoredNotification;
        rawSimilarity: number;
    }
    const rawResults: RawResult[] = [];

    let embeddingCount = 0;
    let dimMismatchCount = 0;
    for (const n of notifications) {
        const emb = embeddings.get(n.id);
        if (!emb) continue;
        embeddingCount++;
        if (emb.dimension !== queryEmbedding.length) { dimMismatchCount++; continue; }

        const storedVec = decodeEmbedding(emb.embedding);
        const similarity = cosineDistance(queryEmbedding, storedVec);
        if (similarity < MIN_SIMILARITY) continue;

        rawResults.push({ notification: n, rawSimilarity: similarity });
    }

    // Per-camera normalization: blend global + within-camera scores
    const normalizedScores = normalizeByCameraGroup(
        rawResults.map(r => ({ id: r.notification.id, cameraId: r.notification.cameraId, rawSimilarity: r.rawSimilarity }))
    );

    // Second pass: hybrid scoring with normalized similarity
    const scored: SearchResult[] = [];
    for (const { notification: n, rawSimilarity } of rawResults) {
        const similarity = normalizedScores.get(n.id) ?? rawSimilarity;
        const recencyBoost = 1 - Math.min((now - n.timestamp) / maxAge, 1);
        const textBonus = computeTextBonus(query, n);
        const finalScore = similarity * WEIGHT_SIMILARITY + recencyBoost * WEIGHT_RECENCY + textBonus * WEIGHT_TEXT;

        scored.push({
            id: n.id,
            timestamp: n.timestamp,
            cameraId: n.cameraId,
            cameraName: n.cameraName,
            detectionType: n.detectionType,
            names: n.names,
            llmTitle: n.llmTitle,
            llmBody: n.llmBody,
            subtitle: n.llmSubtitle,
            detailedDescription: n.detailedDescription,
            thumbnailUrl: n.hasPoster ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '',
        // Search results render through the SAME card renderer as normal
        // browsing, so they need the seek anchor and the Story flag too —
        // omitting them silently fell back to our handling time.
        seekTimestamp: n.seekTimestamp,
        isSummary: n.isSummary,
            hasEmbedding: true,
            llmIdentifiedName: n.llmIdentifiedName,
            llmIdentifiedNames: n.llmIdentifiedNames,
            score: finalScore,
        });
    }

    // Sort by score descending, limit results
    scored.sort((a, b) => b.score - a.score);

    return { results: scored.slice(0, MAX_RESULTS), mode: 'semantic' };
}

// ---- HTTP endpoint handlers ----

export async function handleGalleryDataRequest(
    url: string,
    store: NotificationStore,
    baseUrl: string,
): Promise<{ code: number; body: string; contentType: string }> {
    const urlObj = new URL(url, 'http://localhost');
    const rawPage = parseInt(urlObj.searchParams.get('page') || '1', 10);
    const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const rawPageSize = parseInt(urlObj.searchParams.get('pageSize') || '50', 10);
    const pageSize = Math.min(Math.max(isNaN(rawPageSize) ? 50 : rawPageSize, 1), 200);
    const camera = urlObj.searchParams.get('camera') || undefined;
    const type = urlObj.searchParams.get('type') || undefined;
    const name = urlObj.searchParams.get('name') || undefined;
    const groupId = urlObj.searchParams.get('groupId') || undefined;

    const notifications = store.getAll();
    const embeddings = store.getAllEmbeddings();
    const result = getGalleryPage(notifications, page, pageSize, { camera, type, name }, embeddings, baseUrl, groupId);

    return {
        code: 200,
        body: JSON.stringify(result),
        contentType: 'application/json',
    };
}

export async function handleGallerySearchRequest(
    body: string,
    store: NotificationStore,
    baseUrl: string,
    retentionDays?: number,
    geminiConfig?: GeminiEmbeddingConfig,
): Promise<{ code: number; body: string; contentType: string }> {
    let parsed: any;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { code: 400, body: JSON.stringify({ error: 'Invalid JSON' }), contentType: 'application/json' };
    }

    const query = parsed.query;
    if (!query || typeof query !== 'string') {
        return { code: 400, body: JSON.stringify({ error: 'Missing query' }), contentType: 'application/json' };
    }

    let notifications = store.getAll();
    const embeddings = store.getAllEmbeddings();

    // Apply optional filters before search
    if (parsed.camera) notifications = notifications.filter(n => n.cameraName === parsed.camera);
    if (parsed.type) notifications = notifications.filter(n => n.detectionType === parsed.type);
    if (parsed.name) notifications = notifications.filter(n => {
        const llmNames = n.llmIdentifiedNames || (n.llmIdentifiedName ? [n.llmIdentifiedName] : []);
        return n.names.includes(parsed.name) || llmNames.includes(parsed.name);
    });

    // Try semantic search if Gemini configured and embeddings exist
    if (geminiConfig && embeddings.size > 0) {
        const result = await semanticSearch(query, notifications, embeddings, baseUrl, retentionDays, geminiConfig);
        if (result.results.length > 0) {
            return {
                code: 200,
                body: JSON.stringify({ results: result.results, mode: result.mode, total: result.results.length }),
                contentType: 'application/json',
            };
        }
        // Fall through to keyword search if semantic returned nothing
    }

    // Keyword fallback
    const kwResults = keywordSearch(query, notifications);
    const base = baseUrl || '';
    const mapped = kwResults.map(n => ({
        id: n.id,
        timestamp: n.timestamp,
        cameraId: n.cameraId,
        cameraName: n.cameraName,
        detectionType: n.detectionType,
        names: n.names,
        llmTitle: n.llmTitle,
        llmBody: n.llmBody,
        subtitle: n.llmSubtitle,
        detailedDescription: n.detailedDescription,
        thumbnailUrl: n.hasPoster ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '',
        // Search results render through the SAME card renderer as normal
        // browsing, so they need the seek anchor and the Story flag too —
        // omitting them silently fell back to our handling time.
        seekTimestamp: n.seekTimestamp,
        isSummary: n.isSummary,
        hasEmbedding: embeddings.has(n.id),
        llmIdentifiedName: n.llmIdentifiedName,
        llmIdentifiedNames: n.llmIdentifiedNames,
        score: 0,
    }));

    return {
        code: 200,
        body: JSON.stringify({ results: mapped, mode: 'keyword', total: mapped.length }),
        contentType: 'application/json',
    };
}

// ---- People endpoint handlers ----

export async function handlePeopleRequest(
    personStore: PersonStore,
    featureEnabled: boolean,
    baseUrl: string,
): Promise<{ code: number; body: string; contentType: string }> {
    const people = await personStore.getAllPeople();
    const base = baseUrl || '';

    const mapped = people.map(p => ({
        name: p.name,
        clarityScore: p.clarityScore,
        faceReferenceScore: p.faceReferenceScore,
        cameraName: p.cameraName,
        updatedAt: p.updatedAt,
        photoUrl: `${base}/brief/people/photo?name=${encodeURIComponent(p.name)}`,
    }));

    return {
        code: 200,
        body: JSON.stringify({ people: mapped, total: mapped.length, featureEnabled }),
        contentType: 'application/json',
    };
}

export async function handlePeoplePhotoRequest(
    url: string,
    personStore: PersonStore,
): Promise<{ code: number; body: Buffer | string; contentType: string; cacheControl?: string }> {
    const urlObj = new URL(url, 'http://localhost');
    const name = urlObj.searchParams.get('name') || '';

    if (!name || name.length > 200) {
        return { code: 400, body: JSON.stringify({ error: 'Invalid name parameter' }), contentType: 'application/json' };
    }

    const photo = await personStore.getPhoto(name);
    if (!photo) {
        return { code: 404, body: JSON.stringify({ error: 'Person not found' }), contentType: 'application/json' };
    }

    return {
        code: 200,
        body: photo,
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=3600',
    };
}

export async function handlePeopleDeleteRequest(
    url: string,
    personStore: PersonStore,
): Promise<{ code: number; body: string; contentType: string }> {
    const urlObj = new URL(url, 'http://localhost');
    const name = urlObj.searchParams.get('name') || '';

    if (!name || name.length > 200) {
        return { code: 400, body: JSON.stringify({ error: 'Invalid name parameter' }), contentType: 'application/json' };
    }

    const removed = await personStore.remove(name);
    if (!removed) {
        return { code: 404, body: JSON.stringify({ error: 'Person not found' }), contentType: 'application/json' };
    }

    return { code: 200, body: JSON.stringify({ ok: true }), contentType: 'application/json' };
}
