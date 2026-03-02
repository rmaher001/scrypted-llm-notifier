// ============================================================================
// Gallery: Search, filtering, pagination, and thumbnail delivery
// ============================================================================

import { StoredNotification } from './types';
import { NotificationStore } from './notification-store';

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
    const q = query.toLowerCase();
    return notifications.filter(n => {
        const searchFields = [
            n.llmTitle,
            n.llmSubtitle,
            n.llmBody,
            n.detailedDescription || '',
            n.cameraName,
            ...n.names,
        ].join(' ').toLowerCase();
        return searchFields.includes(q);
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
    thumbnailUrl: string;
    hasEmbedding: boolean;
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
}

export function getGalleryPage(
    notifications: StoredNotification[],
    page: number,
    pageSize: number,
    filters: GalleryFilters,
    embeddings?: Map<string, { embedding: string; dimension: number }>,
    baseUrl?: string,
): GalleryPageResult {
    // Collect filter options from ALL notifications (before filtering)
    const cameraSet = new Set<string>();
    const typeSet = new Set<string>();
    const nameSet = new Set<string>();
    for (const n of notifications) {
        cameraSet.add(n.cameraName);
        typeSet.add(n.detectionType);
        for (const name of n.names) nameSet.add(name);
    }

    // Apply filters
    let filtered = notifications;
    if (filters.camera) {
        filtered = filtered.filter(n => n.cameraName === filters.camera);
    }
    if (filters.type) {
        filtered = filtered.filter(n => n.detectionType === filters.type);
    }
    if (filters.name) {
        filtered = filtered.filter(n => n.names.includes(filters.name!));
    }

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);

    const base = baseUrl || '';
    const galleryNotifications: GalleryNotification[] = paged.map(n => ({
        id: n.id,
        timestamp: n.timestamp,
        cameraId: n.cameraId,
        cameraName: n.cameraName,
        detectionType: n.detectionType,
        names: n.names,
        llmTitle: n.llmTitle,
        llmBody: n.llmBody,
        thumbnailUrl: (n.hasPoster || n.thumbnailB64) ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '',
        hasEmbedding: embeddings ? embeddings.has(n.id) : false,
    }));

    return {
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
}

// ---- TextEmbedding provider auto-discovery ----

interface TextEmbeddingDevice {
    getTextEmbedding(input: string): Promise<Buffer>;
}

interface SystemManagerLike {
    getDeviceById(id: string): any;
    getSystemState(): Record<string, any>;
}

export async function findTextEmbeddingProvider(
    configuredProviderIds: string[],
    systemManager: SystemManagerLike,
): Promise<TextEmbeddingDevice | null> {
    // 1. Check configured chatCompletion providers for TextEmbedding interface
    for (const id of configuredProviderIds) {
        try {
            const device = systemManager.getDeviceById(id);
            if (device && device.interfaces?.includes?.('TextEmbedding')) {
                return device as TextEmbeddingDevice;
            }
        } catch {
            // skip
        }
    }

    // 2. Fall back to any device with TextEmbedding interface
    try {
        const state = systemManager.getSystemState();
        for (const [id, deviceState] of Object.entries(state)) {
            const ifaces = (deviceState as any)?.interfaces?.value;
            if (Array.isArray(ifaces) && ifaces.includes('TextEmbedding')) {
                const device = systemManager.getDeviceById(id);
                if (device) return device as TextEmbeddingDevice;
            }
        }
    } catch {
        // skip
    }

    return null;
}

// ---- Semantic search with hybrid ranking ----

interface SearchResult extends GalleryNotification {
    score: number;
}

export async function semanticSearch(
    query: string,
    notifications: StoredNotification[],
    embeddings: Map<string, { embedding: string; dimension: number }>,
    textEmbeddingProvider: TextEmbeddingDevice,
    baseUrl?: string,
    retentionDays?: number,
): Promise<{ results: SearchResult[]; mode: 'semantic' | 'keyword' }> {
    // Get query embedding
    let queryEmbedding: Float32Array;
    try {
        const queryBuffer = await textEmbeddingProvider.getTextEmbedding(query);
        queryEmbedding = new Float32Array(queryBuffer.buffer, queryBuffer.byteOffset, queryBuffer.length / 4);
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
                thumbnailUrl: (n.hasPoster || n.thumbnailB64) ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '',
                hasEmbedding: embeddings.has(n.id),
                score: 0,
            })),
            mode: 'keyword',
        };
    }

    // Check dimension compatibility
    const firstEmbedding = embeddings.values().next().value;
    if (firstEmbedding && firstEmbedding.dimension !== queryEmbedding.length) {
        console.warn(`[Gallery] Dimension mismatch: query=${queryEmbedding.length}, stored=${firstEmbedding.dimension}. Falling back to keyword search.`);
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
                thumbnailUrl: (n.hasPoster || n.thumbnailB64) ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '',
                hasEmbedding: embeddings.has(n.id),
                score: 0,
            })),
            mode: 'keyword',
        };
    }

    // Compute scores: cosine similarity * 0.8 + recency * 0.2
    const MAX_RESULTS = 100;
    const now = Date.now();
    const maxAge = (retentionDays ?? 3) * 24 * 60 * 60 * 1000;
    const scored: SearchResult[] = [];
    const base = baseUrl || '';

    for (const n of notifications) {
        const emb = embeddings.get(n.id);
        if (!emb) continue; // Skip notifications without embeddings

        const storedVec = decodeEmbedding(emb.embedding);
        const similarity = cosineDistance(queryEmbedding, storedVec);
        const recencyBoost = 1 - Math.min((now - n.timestamp) / maxAge, 1);
        const finalScore = similarity * 0.8 + recencyBoost * 0.2;

        scored.push({
            id: n.id,
            timestamp: n.timestamp,
            cameraId: n.cameraId,
            cameraName: n.cameraName,
            detectionType: n.detectionType,
            names: n.names,
            llmTitle: n.llmTitle,
            llmBody: n.llmBody,
            thumbnailUrl: (n.hasPoster || n.thumbnailB64) ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '',
            hasEmbedding: true,
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
    const page = parseInt(urlObj.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(urlObj.searchParams.get('pageSize') || '50', 10);
    const camera = urlObj.searchParams.get('camera') || undefined;
    const type = urlObj.searchParams.get('type') || undefined;
    const name = urlObj.searchParams.get('name') || undefined;

    const notifications = store.getAll();
    const embeddings = store.getAllEmbeddings();
    const result = getGalleryPage(notifications, page, pageSize, { camera, type, name }, embeddings, baseUrl);

    return {
        code: 200,
        body: JSON.stringify(result),
        contentType: 'application/json',
    };
}

export async function handleGallerySearchRequest(
    body: string,
    store: NotificationStore,
    textEmbeddingProvider: TextEmbeddingDevice | null,
    baseUrl: string,
    retentionDays?: number,
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
    if (parsed.name) notifications = notifications.filter(n => n.names.includes(parsed.name));

    // Try semantic search if provider available and embeddings exist
    if (textEmbeddingProvider && embeddings.size > 0) {
        const result = await semanticSearch(query, notifications, embeddings, textEmbeddingProvider, baseUrl, retentionDays);
        return {
            code: 200,
            body: JSON.stringify({ results: result.results, mode: result.mode, total: result.results.length }),
            contentType: 'application/json',
        };
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
        thumbnailUrl: (n.hasPoster || n.thumbnailB64) ? `${base}/brief/snapshot?id=${encodeURIComponent(n.id)}` : '',
        hasEmbedding: embeddings.has(n.id),
        score: 0,
    }));

    return {
        code: 200,
        body: JSON.stringify({ results: mapped, mode: 'keyword', total: mapped.length }),
        contentType: 'application/json',
    };
}

export async function handleThumbnailRequest(
    url: string,
    store: NotificationStore,
): Promise<{ code: number; body: Buffer | string; contentType: string; cacheControl?: string }> {
    const urlObj = new URL(url, 'http://localhost');
    const id = urlObj.searchParams.get('id') || '';

    if (!id || id.length > 200) {
        return { code: 400, body: JSON.stringify({ error: 'Invalid id' }), contentType: 'application/json' };
    }

    const notification = store.getById(id);
    if (!notification || !notification.thumbnailB64) {
        return { code: 404, body: JSON.stringify({ error: 'Thumbnail not found' }), contentType: 'application/json' };
    }

    const jpegBuffer = Buffer.from(notification.thumbnailB64, 'base64');

    // Safety check for oversized thumbnails
    if (jpegBuffer.length > 1024 * 1024) {
        return { code: 413, body: JSON.stringify({ error: 'Thumbnail too large' }), contentType: 'application/json' };
    }
    return {
        code: 200,
        body: jpegBuffer,
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=3600',
    };
}
