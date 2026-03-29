// ============================================================================
// Gemini Multimodal Embedding API client
// Pure module — no Scrypted SDK dependencies, fully testable
// ============================================================================

const DEFAULT_MODEL = 'gemini-embedding-2-preview';
const DEFAULT_DIMENSIONS = 768;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiEmbeddingConfig {
    apiKey: string;
    model?: string;
    dimensions?: number;
}

interface EmbeddingPart {
    text?: string;
    inline_data?: { mime_type: string; data: string };
}

interface EmbeddingResponse {
    embedding?: { values: number[] };
}

export function normalizeL2(values: number[]): number[] {
    const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return values;
    return values.map(v => v / magnitude);
}

async function callEmbeddingApi(
    config: GeminiEmbeddingConfig,
    parts: EmbeddingPart[],
    taskType?: string,
): Promise<number[]> {
    const model = config.model || DEFAULT_MODEL;
    const dimensions = config.dimensions || DEFAULT_DIMENSIONS;
    const url = `${API_BASE}/${model}:embedContent`;

    const body: Record<string, unknown> = {
        content: { parts },
        outputDimensionality: dimensions,
    };
    if (taskType) {
        body.taskType = taskType;
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errorBody = await resp.text();
        throw new Error(`Gemini embedding API error ${resp.status}: ${errorBody}`);
    }

    const data: EmbeddingResponse = await resp.json();
    if (!data.embedding?.values) {
        throw new Error('Gemini embedding response missing embedding values');
    }

    return data.embedding.values;
}

/**
 * Generate embedding from text + optional image.
 * Returns base64-encoded Float32Array + dimension.
 */
export async function generateEmbedding(
    config: GeminiEmbeddingConfig,
    text: string,
    imageJpeg?: Buffer,
): Promise<{ embedding: string; dimension: number }> {
    const parts: EmbeddingPart[] = [{ text }];
    if (imageJpeg) {
        parts.push({
            inline_data: {
                mime_type: 'image/jpeg',
                data: imageJpeg.toString('base64'),
            },
        });
    }

    const values = await callEmbeddingApi(config, parts, 'RETRIEVAL_DOCUMENT');
    const normalized = normalizeL2(values);
    const arr = new Float32Array(normalized);
    const buf = Buffer.from(arr.buffer);
    return { embedding: buf.toString('base64'), dimension: arr.length };
}

/**
 * Generate embedding from text only (for search queries).
 * Returns Float32Array ready for cosine similarity.
 */
export async function generateQueryEmbedding(
    config: GeminiEmbeddingConfig,
    query: string,
): Promise<Float32Array> {
    const values = await callEmbeddingApi(config, [{ text: query }], 'RETRIEVAL_QUERY');
    return new Float32Array(normalizeL2(values));
}
