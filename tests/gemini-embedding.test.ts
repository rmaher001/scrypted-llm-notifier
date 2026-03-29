import { generateEmbedding, generateQueryEmbedding, normalizeL2, GeminiEmbeddingConfig } from '../src/gemini-embedding';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Mock fetch
// ============================================================================

const originalFetch = global.fetch;
let mockFetchResponse: any;
let lastFetchUrl: string;
let lastFetchBody: any;
let lastFetchHeaders: any;

beforeEach(() => {
    lastFetchUrl = '';
    lastFetchBody = null;
    lastFetchHeaders = null;
    mockFetchResponse = {
        ok: true,
        json: async () => ({
            embedding: { values: [0.1, 0.2, 0.3, 0.4] },
        }),
    };
    global.fetch = jest.fn(async (url: any, opts: any) => {
        lastFetchUrl = url.toString();
        lastFetchBody = JSON.parse(opts.body);
        lastFetchHeaders = opts.headers;
        return mockFetchResponse;
    }) as any;
});

afterEach(() => {
    global.fetch = originalFetch;
});

const config: GeminiEmbeddingConfig = {
    apiKey: 'test-api-key',
};

// ============================================================================
// generateEmbedding
// ============================================================================

describe('generateEmbedding', () => {
    test('returns base64 embedding and dimension from API response', async () => {
        const result = await generateEmbedding(config, 'A person at the front door');

        expect(result.embedding).toBeTruthy();
        expect(result.dimension).toBe(4);

        // Decode and verify values
        const buf = Buffer.from(result.embedding, 'base64');
        const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        // After L2 normalization of [0.1, 0.2, 0.3, 0.4]: magnitude = sqrt(0.30) ≈ 0.5477
        expect(arr[0]).toBeCloseTo(0.1 / Math.sqrt(0.30));
        expect(arr[1]).toBeCloseTo(0.2 / Math.sqrt(0.30));
    });

    test('sends text-only request when no image provided', async () => {
        await generateEmbedding(config, 'A cat on the fence');

        expect(lastFetchBody.content.parts).toHaveLength(1);
        expect(lastFetchBody.content.parts[0]).toEqual({ text: 'A cat on the fence' });
    });

    test('sends multimodal request with image + text', async () => {
        const imageJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]); // fake JPEG header
        await generateEmbedding(config, 'Package delivery', imageJpeg);

        expect(lastFetchBody.content.parts).toHaveLength(2);
        expect(lastFetchBody.content.parts[0]).toEqual({ text: 'Package delivery' });
        expect(lastFetchBody.content.parts[1]).toEqual({
            inline_data: {
                mime_type: 'image/jpeg',
                data: imageJpeg.toString('base64'),
            },
        });
    });

    test('sends outputDimensionality in request body', async () => {
        await generateEmbedding({ ...config, dimensions: 768 }, 'test');

        expect(lastFetchBody.outputDimensionality).toBe(768);
    });

    test('defaults to 768 dimensions', async () => {
        await generateEmbedding(config, 'test');

        expect(lastFetchBody.outputDimensionality).toBe(768);
    });

    test('sends taskType RETRIEVAL_DOCUMENT', async () => {
        await generateEmbedding(config, 'test');

        expect(lastFetchBody.taskType).toBe('RETRIEVAL_DOCUMENT');
    });

    test('returns L2-normalized embedding (magnitude ≈ 1.0)', async () => {
        const result = await generateEmbedding(config, 'test');
        const buf = Buffer.from(result.embedding, 'base64');
        const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);

        const magnitude = Math.sqrt(Array.from(arr).reduce((sum, v) => sum + v * v, 0));
        expect(magnitude).toBeCloseTo(1.0, 5);
    });

    test('uses correct API endpoint URL', async () => {
        await generateEmbedding(config, 'test');

        expect(lastFetchUrl).toContain('generativelanguage.googleapis.com');
        expect(lastFetchUrl).toContain('gemini-embedding-2-preview');
        expect(lastFetchUrl).toContain('embedContent');
    });

    test('sends API key in header', async () => {
        await generateEmbedding(config, 'test');

        expect(lastFetchHeaders['x-goog-api-key']).toBe('test-api-key');
    });

    test('allows custom model name', async () => {
        await generateEmbedding({ ...config, model: 'gemini-embedding-001' }, 'test');

        expect(lastFetchUrl).toContain('gemini-embedding-001');
        expect(lastFetchUrl).not.toContain('gemini-embedding-2-preview');
    });

    test('throws on API error response', async () => {
        mockFetchResponse = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => 'Invalid API key',
        };

        await expect(generateEmbedding(config, 'test'))
            .rejects.toThrow(/Gemini embedding API error.*401/);
    });

    test('throws on missing embedding in response', async () => {
        mockFetchResponse = {
            ok: true,
            json: async () => ({ something: 'else' }),
        };

        await expect(generateEmbedding(config, 'test'))
            .rejects.toThrow(/embedding/i);
    });
});

// ============================================================================
// generateQueryEmbedding
// ============================================================================

describe('generateQueryEmbedding', () => {
    test('returns Float32Array from text-only request', async () => {
        const result = await generateQueryEmbedding(config, 'red car');

        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(4);
        // After L2 normalization of [0.1, 0.2, 0.3, 0.4]
        expect(result[0]).toBeCloseTo(0.1 / Math.sqrt(0.30));
    });

    test('sends text-only request (no image)', async () => {
        await generateQueryEmbedding(config, 'delivery person');

        expect(lastFetchBody.content.parts).toHaveLength(1);
        expect(lastFetchBody.content.parts[0]).toEqual({ text: 'delivery person' });
    });

    test('sends taskType RETRIEVAL_QUERY', async () => {
        await generateQueryEmbedding(config, 'red car');

        expect(lastFetchBody.taskType).toBe('RETRIEVAL_QUERY');
    });

    test('returns L2-normalized Float32Array (magnitude ≈ 1.0)', async () => {
        const result = await generateQueryEmbedding(config, 'test');

        const magnitude = Math.sqrt(Array.from(result).reduce((sum, v) => sum + v * v, 0));
        expect(magnitude).toBeCloseTo(1.0, 5);
    });
});

// ============================================================================
// normalizeL2
// ============================================================================

describe('normalizeL2', () => {
    test('normalizes [3, 4] to unit length [0.6, 0.8]', () => {
        const result = normalizeL2([3, 4]);
        expect(result[0]).toBeCloseTo(0.6);
        expect(result[1]).toBeCloseTo(0.8);
        const magnitude = Math.sqrt(Array.from(result).reduce((sum: number, v: number) => sum + v * v, 0));
        expect(magnitude).toBeCloseTo(1.0, 10);
    });

    test('handles zero vector safely', () => {
        const result = normalizeL2([0, 0, 0]);
        expect(result).toEqual([0, 0, 0]);
    });
});

// ============================================================================
// Integration: settings and wiring
// ============================================================================

// ============================================================================
// detailedDescription prompt
// ============================================================================

describe('detailedDescription prompt', () => {
    const ROOT = path.resolve(__dirname, '..');

    test('uses open-ended prompt instead of prescriptive categories', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/llm-notifier.ts'), 'utf-8');
        expect(src).toContain('THIS moment unique');
        expect(src).not.toContain('PEOPLE:');
        expect(src).not.toContain('VEHICLES:');
        expect(src).not.toContain('ANIMALS:');
        expect(src).not.toContain('CONTEXT:');
    });
});

describe('embedding text includes title', () => {
    const ROOT = path.resolve(__dirname, '..');

    test('generateEmbedding call includes enriched.title for richer embeddings', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/llm-notifier.ts'), 'utf-8');
        const embeddingCall = src.match(/generateEmbedding\(\s*geminiConfig,\s*([\s\S]*?),\s*posterBuf/);
        expect(embeddingCall).not.toBeNull();
        expect(embeddingCall![1]).toContain('enriched.title');
        expect(embeddingCall![1]).toContain('detailedDescription');
    });
});

describe('Gemini embedding integration', () => {
    const ROOT = path.resolve(__dirname, '..');

    test('main.ts has geminiEmbeddingApiKey setting with password type', () => {
        const mainTs = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf-8');
        expect(mainTs).toContain('geminiEmbeddingApiKey');
        expect(mainTs).toMatch(/group:\s*['"]Search['"]/);
        // API key should be masked in UI
        const settingBlock = mainTs.match(/geminiEmbeddingApiKey:\s*\{[\s\S]*?\}/);
        expect(settingBlock).not.toBeNull();
        expect(settingBlock![0]).toContain("type: 'password'");
    });

    test('llm-notifier.ts imports and uses generateEmbedding', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/llm-notifier.ts'), 'utf-8');
        expect(src).toContain("from './gemini-embedding'");
        expect(src).toContain('generateEmbedding');
        expect(src).toContain('geminiEmbeddingApiKey');
    });

    test('gallery.ts imports and uses generateQueryEmbedding', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/gallery.ts'), 'utf-8');
        expect(src).toContain("from './gemini-embedding'");
        expect(src).toContain('generateQueryEmbedding');
        expect(src).toContain('geminiConfig');
    });

    test('gallery.ts falls back to keyword search when no Gemini config', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/gallery.ts'), 'utf-8');
        expect(src).toContain('keywordSearch');
        // Should not reference old TextEmbedding interface
        expect(src).not.toContain('findTextEmbeddingProvider');
        expect(src).not.toContain('TextEmbeddingDevice');
    });
});
