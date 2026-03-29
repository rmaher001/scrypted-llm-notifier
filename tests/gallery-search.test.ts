import { computeTextBonus, MIN_SIMILARITY, WEIGHT_SIMILARITY, WEIGHT_RECENCY, WEIGHT_TEXT, WEIGHT_GLOBAL, WEIGHT_PER_CAMERA, normalizeByCameraGroup, keywordSearch, semanticSearch, cosineDistance, decodeEmbedding } from '../src/gallery';
import { StoredNotification } from '../src/types';
import { GeminiEmbeddingConfig } from '../src/gemini-embedding';

// ============================================================================
// computeTextBonus
// ============================================================================

function makeNotification(overrides: Partial<StoredNotification> = {}): StoredNotification {
    return {
        id: 'test-1',
        timestamp: Date.now(),
        cameraId: 'cam1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: ['John'],
        llmTitle: 'Person at front door',
        llmSubtitle: '',
        llmBody: 'A person was detected at the front door',
        ...overrides,
    };
}

describe('computeTextBonus', () => {
    test('returns 1.0 when all query terms match', () => {
        const n = makeNotification({
            llmTitle: 'Person at front door',
            llmBody: 'A person was detected walking to the front door',
            cameraName: 'Front Door',
            names: ['John'],
        });
        const score = computeTextBonus('person front door', n);
        expect(score).toBe(1.0);
    });

    test('returns 0 when no query terms match', () => {
        const n = makeNotification({
            llmTitle: 'Cat on porch',
            llmBody: 'A cat was seen on the porch',
            cameraName: 'Backyard',
            names: [],
        });
        const score = computeTextBonus('car garage driveway', n);
        expect(score).toBe(0);
    });

    test('returns partial score for partial match', () => {
        const n = makeNotification({
            llmTitle: 'Person at front door',
            llmBody: 'A person was detected',
            cameraName: 'Front Door',
            names: [],
        });
        // "person" and "door" match, "garage" does not → 2/3
        const score = computeTextBonus('person garage door', n);
        expect(score).toBeCloseTo(2 / 3);
    });

    test('returns 0 for empty query', () => {
        const n = makeNotification();
        expect(computeTextBonus('', n)).toBe(0);
    });

    test('returns 0 for query with only short terms (length <= 1)', () => {
        const n = makeNotification();
        expect(computeTextBonus('a b c', n)).toBe(0);
    });

    test('matches against detailedDescription', () => {
        const n = makeNotification({
            llmTitle: 'Detection',
            llmBody: 'Something happened',
            detailedDescription: 'A UPS delivery truck parked in the driveway',
        });
        const score = computeTextBonus('UPS truck', n);
        expect(score).toBe(1.0);
    });

    test('matches against llmIdentifiedNames', () => {
        const n = makeNotification({
            llmTitle: 'Person detected',
            llmBody: 'Someone at the door',
            names: [],
            llmIdentifiedNames: ['Alice', 'Bob'],
        });
        const score = computeTextBonus('Alice', n);
        expect(score).toBe(1.0);
    });

    test('is case insensitive', () => {
        const n = makeNotification({
            llmTitle: 'PERSON AT FRONT DOOR',
        });
        const score = computeTextBonus('person door', n);
        expect(score).toBe(1.0);
    });
});

// ============================================================================
// Hybrid scoring weights
// ============================================================================

describe('hybrid scoring weights', () => {
    test('weights sum to 1.0', () => {
        expect(WEIGHT_SIMILARITY + WEIGHT_RECENCY + WEIGHT_TEXT).toBeCloseTo(1.0);
    });

    test('keyword match outranks cosine gap for same-camera notifications', () => {
        // Two notifications from same camera with compressed cosine scores
        // n1: lower cosine but perfect keyword match
        // n2: slightly higher cosine but no keyword match
        const cosineGap = 0.05; // typical same-camera spread
        const baseSimilarity = 0.60;
        const midRecency = 0.5;

        const n1Score = baseSimilarity * WEIGHT_SIMILARITY + midRecency * WEIGHT_RECENCY + 1.0 * WEIGHT_TEXT;
        const n2Score = (baseSimilarity + cosineGap) * WEIGHT_SIMILARITY + midRecency * WEIGHT_RECENCY + 0.0 * WEIGHT_TEXT;
        expect(n1Score).toBeGreaterThan(n2Score);
    });
});

// ============================================================================
// normalizeByCameraGroup
// ============================================================================

describe('normalizeByCameraGroup', () => {
    test('reduces gap between high-baseline and low-baseline cameras', () => {
        const items = [
            { id: 'garage-1', cameraId: 'garage', rawSimilarity: 0.66 },
            { id: 'garage-2', cameraId: 'garage', rawSimilarity: 0.64 },
            { id: 'sidewalk-1', cameraId: 'sidewalk', rawSimilarity: 0.55 },
            { id: 'sidewalk-2', cameraId: 'sidewalk', rawSimilarity: 0.40 },
        ];
        const result = normalizeByCameraGroup(items);

        const rawGap = 0.66 - 0.55; // 0.11
        const blendedGap = result.get('garage-1')! - result.get('sidewalk-1')!;
        expect(blendedGap).toBeLessThan(rawGap);
    });

    test('single notification per camera uses rawSimilarity as perCameraNorm', () => {
        const items = [
            { id: 'a', cameraId: 'cam1', rawSimilarity: 0.50 },
            { id: 'b', cameraId: 'cam2', rawSimilarity: 0.70 },
        ];
        const result = normalizeByCameraGroup(items);

        // Singletons use raw score for both components — no artificial boost
        expect(result.get('a')).toBeCloseTo(WEIGHT_GLOBAL * 0.50 + WEIGHT_PER_CAMERA * 0.50);
        expect(result.get('b')).toBeCloseTo(WEIGHT_GLOBAL * 0.70 + WEIGHT_PER_CAMERA * 0.70);
    });

    test('equal scores within camera avoid division by zero', () => {
        const items = [
            { id: 'a', cameraId: 'cam1', rawSimilarity: 0.55 },
            { id: 'b', cameraId: 'cam1', rawSimilarity: 0.55 },
        ];
        const result = normalizeByCameraGroup(items);

        // Equal scores: range=0, uses rawSimilarity as perCameraNorm
        expect(result.get('a')).toBeCloseTo(WEIGHT_GLOBAL * 0.55 + WEIGHT_PER_CAMERA * 0.55);
        expect(result.get('b')).toBeCloseTo(WEIGHT_GLOBAL * 0.55 + WEIGHT_PER_CAMERA * 0.55);
    });

    test('singleton does not outrank strong result from multi-item camera', () => {
        const items = [
            { id: 'weak-singleton', cameraId: 'cam1', rawSimilarity: 0.20 },
            { id: 'strong-a', cameraId: 'cam2', rawSimilarity: 0.80 },
            { id: 'strong-b', cameraId: 'cam2', rawSimilarity: 0.79 },
        ];
        const result = normalizeByCameraGroup(items);

        // The weak singleton must not outrank either strong result
        expect(result.get('strong-a')!).toBeGreaterThan(result.get('weak-singleton')!);
        expect(result.get('strong-b')!).toBeGreaterThan(result.get('weak-singleton')!);
    });

    test('empty input returns empty map', () => {
        const result = normalizeByCameraGroup([]);
        expect(result.size).toBe(0);
    });

    test('within-camera ranking is preserved', () => {
        const items = [
            { id: 'g1', cameraId: 'garage', rawSimilarity: 0.66 },
            { id: 'g2', cameraId: 'garage', rawSimilarity: 0.64 },
            { id: 'g3', cameraId: 'garage', rawSimilarity: 0.62 },
        ];
        const result = normalizeByCameraGroup(items);
        expect(result.get('g1')!).toBeGreaterThan(result.get('g2')!);
        expect(result.get('g2')!).toBeGreaterThan(result.get('g3')!);
    });

    test('WEIGHT_GLOBAL + WEIGHT_PER_CAMERA equals 1.0', () => {
        expect(WEIGHT_GLOBAL + WEIGHT_PER_CAMERA).toBeCloseTo(1.0);
    });
});

// ============================================================================
// semanticSearch — mock Gemini for all semantic tests
// ============================================================================

// Mock fetch to return a known query embedding
const originalFetch = global.fetch;

function mockGeminiFetch(returnValues: number[]) {
    global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ embedding: { values: returnValues } }),
    })) as any;
}

const geminiConfig: GeminiEmbeddingConfig = { apiKey: 'test-key' };

afterEach(() => {
    global.fetch = originalFetch;
});

// ============================================================================
// semanticSearch — MIN_SIMILARITY threshold
// ============================================================================

describe('semanticSearch threshold filtering', () => {
    test('filters out results below MIN_SIMILARITY threshold', async () => {
        const n1 = makeNotification({ id: 'high-sim', timestamp: Date.now() });
        const n2 = makeNotification({ id: 'low-sim', timestamp: Date.now() });

        // Query embedding: all 1s (returned by mocked Gemini)
        const queryValues = new Array(768).fill(1);
        mockGeminiFetch(queryValues);

        // High similarity: same direction as query
        const highSimVec = new Float32Array(768);
        highSimVec.fill(1);
        const highSimEmb = Buffer.from(highSimVec.buffer).toString('base64');

        // Low similarity: alternating +1/-1 gives ~0 cosine with all-1s
        const lowSimVec = new Float32Array(768);
        for (let i = 0; i < 768; i++) lowSimVec[i] = i % 2 === 0 ? 1 : -1;
        const lowSimEmb = Buffer.from(lowSimVec.buffer).toString('base64');

        // Verify the low-sim vector actually has near-zero cosine
        const queryVec = new Float32Array(768);
        queryVec.fill(1);
        const lowCosine = cosineDistance(queryVec, lowSimVec);
        expect(Math.abs(lowCosine)).toBeLessThan(MIN_SIMILARITY);

        const embeddings = new Map([
            ['high-sim', { embedding: highSimEmb, dimension: 768 }],
            ['low-sim', { embedding: lowSimEmb, dimension: 768 }],
        ]);

        const result = await semanticSearch('test query', [n1, n2], embeddings, '', 3, geminiConfig);

        expect(result.mode).toBe('semantic');
        const ids = result.results.map(r => r.id);
        expect(ids).toContain('high-sim');
        expect(ids).not.toContain('low-sim');
    });
});

// ============================================================================
// semanticSearch — hybrid scoring includes text bonus
// ============================================================================

describe('semanticSearch hybrid scoring', () => {
    test('text bonus boosts score for notifications with matching text', async () => {
        const n1 = makeNotification({
            id: 'text-match',
            timestamp: Date.now(),
            llmTitle: 'Package delivery at front door',
            llmBody: 'A delivery person left a package',
        });
        const n2 = makeNotification({
            id: 'no-text-match',
            timestamp: Date.now(),
            llmTitle: 'Cat on fence',
            llmBody: 'A cat was spotted on the fence',
        });

        const queryValues = new Array(768).fill(1);
        mockGeminiFetch(queryValues);

        const vec = new Float32Array(768);
        vec.fill(1);
        const emb = Buffer.from(vec.buffer).toString('base64');

        const embeddings = new Map([
            ['text-match', { embedding: emb, dimension: 768 }],
            ['no-text-match', { embedding: emb, dimension: 768 }],
        ]);

        const result = await semanticSearch('package delivery', [n1, n2], embeddings, '', 3, geminiConfig);

        expect(result.results.length).toBe(2);
        const textMatchResult = result.results.find(r => r.id === 'text-match')!;
        const noTextMatchResult = result.results.find(r => r.id === 'no-text-match')!;
        expect(textMatchResult.score).toBeGreaterThan(noTextMatchResult.score);
    });
});

// ============================================================================
// semanticSearch — dimension mismatch guard
// ============================================================================

describe('semanticSearch dimension mismatch', () => {
    test('skips embeddings with mismatched dimensions', async () => {
        const n1 = makeNotification({ id: 'match-dim', timestamp: Date.now() });
        const n2 = makeNotification({ id: 'wrong-dim', timestamp: Date.now() });

        const queryValues = new Array(768).fill(1);
        mockGeminiFetch(queryValues);

        // n1: 768-dim (matches query)
        const vec768 = new Float32Array(768);
        vec768.fill(1);
        const emb768 = Buffer.from(vec768.buffer).toString('base64');

        // n2: 512-dim (mismatched)
        const vec512 = new Float32Array(512);
        vec512.fill(1);
        const emb512 = Buffer.from(vec512.buffer).toString('base64');

        const embeddings = new Map([
            ['match-dim', { embedding: emb768, dimension: 768 }],
            ['wrong-dim', { embedding: emb512, dimension: 512 }],
        ]);

        const result = await semanticSearch('test', [n1, n2], embeddings, '', 3, geminiConfig);

        const ids = result.results.map(r => r.id);
        expect(ids).toContain('match-dim');
        expect(ids).not.toContain('wrong-dim');
    });
});

// ============================================================================
// handleGallerySearchRequest — semantic → keyword fallback
// ============================================================================

import { handleGallerySearchRequest } from '../src/gallery';
import { NotificationStore } from '../src/notification-store';

describe('handleGallerySearchRequest fallback', () => {
    test('falls back to keyword search when semantic returns no results', async () => {
        // Notification with "Lexus" in text but no embedding
        const n = makeNotification({
            id: 'lexus-1',
            llmTitle: 'Person in garage',
            llmBody: 'Walking past two grey Lexus SUVs',
            detailedDescription: 'A person walking past two grey Lexus SUVs in the garage',
        });

        // Mock store with notification but no embeddings
        const mockStore = {
            getAll: () => [n],
            getAllEmbeddings: () => new Map(),
        } as unknown as NotificationStore;

        // With Gemini config but no embeddings → should fall through to keyword
        const geminiCfg = { apiKey: 'test-key' };
        const result = await handleGallerySearchRequest(
            JSON.stringify({ query: 'Lexus garage' }),
            mockStore, '', 3, geminiCfg,
        );
        const parsed = JSON.parse(result.body);
        expect(parsed.mode).toBe('keyword');
        expect(parsed.results.length).toBeGreaterThan(0);
        expect(parsed.results[0].id).toBe('lexus-1');
    });

    test('falls back to keyword when semantic results are empty due to no matching embeddings', async () => {
        // Two notifications: one with embedding, one without
        const n1 = makeNotification({
            id: 'no-emb',
            llmTitle: 'Lexus in garage',
            llmBody: 'Grey Lexus SUV parked',
        });
        const n2 = makeNotification({
            id: 'has-emb',
            llmTitle: 'Cat on fence',
            llmBody: 'A cat was spotted',
        });

        // Only n2 has an embedding (and it won't match "Lexus")
        const vec = new Float32Array(768);
        vec.fill(0.5);
        const emb = Buffer.from(vec.buffer).toString('base64');

        const mockStore = {
            getAll: () => [n1, n2],
            getAllEmbeddings: () => new Map([
                ['has-emb', { embedding: emb, dimension: 768 }],
            ]),
        } as unknown as NotificationStore;

        // Mock Gemini to return a query embedding that won't match n2
        const queryVec = new Array(768).fill(0);
        queryVec[0] = 1; // orthogonal-ish to the stored embedding
        mockGeminiFetch(queryVec);

        const geminiCfg = { apiKey: 'test-key' };
        const result = await handleGallerySearchRequest(
            JSON.stringify({ query: 'Lexus garage' }),
            mockStore, '', 3, geminiCfg,
        );
        const parsed = JSON.parse(result.body);
        // Should fall back to keyword and find n1
        expect(parsed.mode).toBe('keyword');
        expect(parsed.results.some((r: any) => r.id === 'no-emb')).toBe(true);
    });
});
