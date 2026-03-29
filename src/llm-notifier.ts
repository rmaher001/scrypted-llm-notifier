import sdk, {
    MediaObject,
    MixinDeviceBase,
    Notifier,
    NotifierOptions,
    ScryptedMimeTypes,
} from '@scrypted/sdk';
const { mediaManager } = sdk;
import { StoredNotification } from './types';
import { parseClarity, withTimeout, resizeJpegNearest, getJpegDimensions, buildImageList } from './utils';
import { generateEmbedding, GeminiEmbeddingConfig } from './gemini-embedding';
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



export function shouldLoadReferenceImages(enableLlmFaceId: boolean, detections: any[]): boolean {
    if (!enableLlmFaceId || !detections || !detections.length) return false;
    const personCount = detections.filter((d: any) => d.className === 'person').length;
    const labeledFaceCount = detections.filter((d: any) => d.className === 'face' && d.label).length;
    return personCount > 0 && personCount > labeledFaceCount;
}

export function shouldCurateReference(enableLlmFaceId: boolean, names: string[], clarityScore: number | undefined, imageUrl: string | undefined): boolean {
    if (!enableLlmFaceId || !names.length) return false;
    if (clarityScore == null || clarityScore < 5) return false;
    if (!imageUrl?.startsWith('data:image/jpeg;base64,')) return false;
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

export function buildMetadata(
    title: string,
    subtitle?: string,
    body?: string,
    includeOriginal: boolean = false,
): any {
    if (!includeOriginal) return {};
    return {
        originalTitle: title,
        originalSubtitle: subtitle,
        originalBody: body,
        instruction: "Extract any 'Maybe: [name]' from the original text and use that name. Each field (title, subtitle, body) must contain DIFFERENT information - no repetition between fields.",
    };
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
}

export async function callLlm(
    provider: { getChatCompletion(messages: any): Promise<any> },
    messageTemplate: any,
    timeoutMs: number,
    console: { log(...args: any[]): void; warn(...args: any[]): void },
    verbose: boolean = false,
): Promise<EnrichmentResult> {
    const start = Date.now();
    if (verbose) console.log(`Calling LLM (timeout ${timeoutMs}ms)...`);

    const llmData = await withTimeout(provider.getChatCompletion(messageTemplate), timeoutMs, 'LLM request');
    const responseTime = Date.now() - start;
    const responseTimeSeconds = Math.round(responseTime / 1000);

    const content = llmData.choices[0].message.content;
    if (!content) {
        throw new Error('Empty response from LLM');
    }

    const json = JSON.parse(content);
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
    };

    if (typeof result.title !== 'string' || typeof result.subtitle !== 'string' ||
        typeof result.body !== 'string' || typeof result.detailedDescription !== 'string') {
        throw new Error('Invalid response format from LLM');
    }

    if (json.identifiedPerson !== undefined && json.identifiedPerson !== null
        && typeof json.identifiedPerson !== 'string') {
        throw new Error('Invalid response format from LLM');
    }

    if (verbose) console.log(`[LLM] detailedDescription: ${result.detailedDescription ? result.detailedDescription.substring(0, 100) : '(empty)'}`);
    if (verbose && result.clarity) {
        console.log(`🔍 Clarity score: ${result.clarity.score}/10 - ${result.clarity.reason}`);
    }

    return result;
}

export function createMessageTemplate(userPrompt: string, imageUrls: string[], metadata: any, referenceImages?: Map<string, string>) {
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
9. Response MUST be valid JSON with exactly five fields: title, subtitle, body, detailedDescription, clarity
10. If using a person's name in title, use the same name in body - never switch to generic terms
11. detailedDescription: Write 2-3 detailed sentences focusing on what makes THIS moment unique. Prioritize: specific actions (slicing fruit, opening a box, ironing a shirt), interactions between people, items being carried or used, temporary objects (packages, food, tools), expressions, posture, and anything unusual. Include people's appearance (hair, build, clothing, footwear) and vehicle details (make, model, color, plate) when visible. Briefly note the setting but don't dwell on permanent fixtures — focus more on what is happening than on the room itself. These details power search and daily summaries.
12. clarity: Assess the image clarity on a 1-10 scale with SPECIFIC criteria:
    - Score 1-2: UNUSABLE - Cannot identify what subject IS (blob, shadow, severe motion blur, too dark)
    - Score 3-4: POOR - Can identify subject TYPE only (person vs animal vs vehicle, but no other details)
    - Score 5-6: FAIR - Some details visible but uncertain (probably male, possibly dark clothing)
    - Score 7-8: GOOD - Most details clear (male wearing blue hoodie, carrying backpack)
    - Score 9-10: EXCELLENT - Face features visible, license plates readable, fine details clear
    Be STRICT and HONEST - if you're guessing what something is, score 5 or below.`;

    // Add person identification instructions when reference images are provided
    let personIdPrompt = '';
    if (referenceImages && referenceImages.size > 0) {
        personIdPrompt = `\n\nPERSON IDENTIFICATION:
Reference photos of known household members are provided below.
- You MUST be able to clearly see each person's FACE to identify them.
- Hair color, body type, clothing, or back-of-head view is NEVER sufficient for identification.
- If you can clearly see MULTIPLE people's faces matching references, include ALL of them.
- Return identifiedPersons as an array of {name, confidence} objects, or null if no one is identified.
- Each person must independently meet the face-visibility requirement.
- Only use the exact names from the reference photo labels.
- Do NOT use a person's name in title, subtitle, or body unless you can clearly see their face. Describe unidentified people generically (e.g., "a person", "someone").
- Confidence scale (1-10) for each person:
  - 1-3: Face not visible, too far away, or too blurry to identify anyone
  - 4-6: Face partially visible but uncertain (distant, angled, poor lighting)
  - 7-8: Face clearly visible with strong match to a reference photo
  - 9-10: Unmistakable face match at close range`;
    }

    const schema = "CRITICAL CHARACTER LIMITS - STRICTLY ENFORCE:\n- Title: MAXIMUM 32 characters (count every letter, space, punctuation)\n- Subtitle: MAXIMUM 32 characters (count every letter, space, punctuation)\n- Body: MAXIMUM 75 characters (count every letter, space, punctuation)\n- detailedDescription: 2-3 sentences, no strict limit but be concise\n- clarity: object with score (1-10) and reason (brief explanation)\n\nYou MUST count characters before responding. Responses exceeding these limits will be REJECTED and cause system failure. If your description is too long, use shorter words and remove unnecessary details. The body character limit of 75 is ABSOLUTE and NON-NEGOTIABLE.";

    // Build user content: reference photos FIRST (static, enables implicit
    // prefix caching on Gemini/Claude/OpenAI), then dynamic detection content.
    const userContent: any[] = [];

    // 1. Reference photos (identical across requests — cacheable prefix)
    if (referenceImages && referenceImages.size > 0) {
        userContent.push({ type: 'text', text: 'Reference photos of known people:' });
        for (const [name, dataUrl] of referenceImages) {
            userContent.push({ type: 'text', text: `Known person: "${name}"` });
            userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
    }

    // 2. Dynamic content (changes every request)
    userContent.push({
        type: 'text',
        text: `Original notification metadata: ${JSON.stringify(metadata, null, 2)}`,
    });
    for (const url of imageUrls) {
        userContent.push({ type: 'image_url', image_url: { url } });
    }

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
    const requiredFields = ["title", "subtitle", "body", "detailedDescription", "clarity"];

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

    return {
        messages: [
            {
                role: "system",
                content: basePrompt + personIdPrompt + '\n\n' + userPrompt + '\n\n' + schema,
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
        total: 0
    };

    async sendNotification(title: string, options?: NotifierOptions, media?: string | MediaObject, icon?: string | MediaObject) {
        const timestamp = new Date().toISOString();
        let imageSizeKB: number | undefined;
        const verbose = !!(this.llmProvider.storageSettings.values as any).verboseLogging;

        // Update stats
        this.notificationStats.total++;

        // Skip if no media or if disabled
        if (!media || !this.llmProvider.storageSettings.values.enabled) {
            this.notificationStats.withoutSnapshot++;
            if (verbose) this.console.log(`[${timestamp}] 📊 Notification without snapshot - Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot})`);
            return this.mixinDevice.sendNotification(title, options, media, icon);
        }

        this.notificationStats.withSnapshot++;

        let imageUrl: string | undefined;
        let fullFrameUrl: string | undefined;
        let imageUrls: string[] = [];

        // Extract camera ID from the MediaObject (authoritative - set by the camera device)
        const cameraId = (typeof media !== 'string') ? (media as any).sourceId as string | undefined : undefined;
        const cameraDevice = cameraId ? sdk.systemManager.getDeviceById(cameraId) : undefined;
        const cameraName = cameraDevice?.name || undefined;

        if (typeof media === 'string') {
            imageUrl = media;
        }
        else {
            const buffer = await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
            const b64 = buffer.toString('base64');
            imageUrl = `data:image/jpeg;base64,${b64}`;
            imageSizeKB = Math.round(buffer.length / 1024);
        }

        // Always fetch full-frame snapshot for THIS EVENT (used for poster cache + optionally LLM)
        // snapshotMode only controls what gets sent to the LLM, not the poster cache
        try {
            const re = (options as any)?.recordedEvent;
            const data = re?.data || {};
            const detectionId = data?.detectionId || data?.detections?.[0]?.id;
            const sourceId = data?.sourceId
                || (options as any)?.data?.sourceId
                || (typeof media !== 'string' ? (media as any)?.sourceId : undefined);
            if (detectionId && sourceId) {
                const objDet = sdk.systemManager.getDeviceById(sourceId) as any;
                if (objDet?.getDetectionInput) {
                    const fullMo = await objDet.getDetectionInput(detectionId, re?.eventId);
                    const fullBuf = await mediaManager.convertMediaObjectToBuffer(fullMo, 'image/jpeg');
                    fullFrameUrl = await processFullFrame(fullBuf, this.console);
                }
            }
        } catch (e) {
            this.console.warn('Full-frame (event) retrieval/rescale failed:', e);
        }

        if (verbose) {
            this.console.log('=== LLM Notifier Debug ===');
            this.console.log('Original title:', title);
            this.console.log('Original subtitle:', options?.subtitle);
            this.console.log('Original body:', options?.body);
        }

        // Build metadata for LLM
        const metadata = buildMetadata(
            title,
            options?.subtitle,
            options?.body,
            this.llmProvider.storageSettings.values.includeOriginalMessage,
        );

        // Choose which image(s) to send
        const snapshotMode = (this.llmProvider.storageSettings.values as any).snapshotMode || 'cropped';
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

        const messageTemplate = createMessageTemplate(
            this.llmProvider.storageSettings.values.userPrompt,
            imageUrls,
            metadata,
            referenceImages
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

                        const llmPromise = (async () => {
                            try {
                                const result = await callLlm(this.llmProvider.selectProvider(), messageTemplate, llmTimeout, this.console, verbose);
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
                enriched = await callLlm(this.llmProvider.selectProvider(), messageTemplate, llmTimeout, this.console, verbose);
                if (verbose) this.console.log(`[${timestamp}] 📊 LLM Notification processed - Mode: ${snapshotMode}, Cropped: ${imageSizeKB || 'N/A'}KB, Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot})`);
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

                const { detectionType, names: baseNames } = extractDetectionData(detections, title, options?.body);

                // Curate reference photo from identified face detections (cropped image = tighter subject crop)
                const clarityScore = enriched.clarity?.score;
                if (shouldCurateReference(enableFaceId, baseNames, clarityScore, imageUrl)) {
                    for (const name of baseNames) {
                        try {
                            const cropBuf = Buffer.from(imageUrl.replace('data:image/jpeg;base64,', ''), 'base64');
                            const stored = await this.llmProvider.personStore.curate(
                                name, cropBuf, clarityScore!, cameraName
                            );
                            if (stored) {
                                this.console.log(`[PersonID] Updated reference for "${name}" (clarity: ${clarityScore})`);
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
                    // Create small thumbnail for storage (max 100KB)
                    let thumbnailB64: string | undefined;
                    if (imageUrl && imageUrl.startsWith('data:image/jpeg;base64,')) {
                        const b64Data = imageUrl.replace('data:image/jpeg;base64,', '');
                        const buf = Buffer.from(b64Data, 'base64');
                        if (buf.length < 100 * 1024) {
                            thumbnailB64 = b64Data;
                        } else {
                            // Resize to smaller thumbnail
                            try {
                                const resized = await resizeJpegNearest(buf, 200, 50);
                                thumbnailB64 = resized.toString('base64');
                            } catch {
                                // Skip thumbnail if resize fails
                            }
                        }
                    }

                    // Persist poster-quality JPEG to disk before storing notification
                    const posterUrl = fullFrameUrl || imageUrl;
                    let hasPosterFlag = false;
                    if (posterUrl?.startsWith('data:image/jpeg;base64,')) {
                        const posterBuf = Buffer.from(posterUrl.replace('data:image/jpeg;base64,', ''), 'base64');
                        if (posterBuf.length <= 500 * 1024) {
                            try {
                                await this.llmProvider.posterStore.put(notificationId, posterBuf);
                                hasPosterFlag = true;
                            } catch (e) {
                                this.console.warn(`[Poster] Write failed: ${notificationId}`, e);
                            }
                        }
                    }

                    const storedNotification: StoredNotification = {
                        id: notificationId,
                        timestamp: Date.now(),
                        cameraId,
                        cameraName: cameraName || 'Unknown Camera',
                        detectionType,
                        names,
                        llmTitle: enriched.title,
                        llmSubtitle: enriched.subtitle,
                        llmBody: enriched.body,
                        thumbnailB64,
                        hasPoster: hasPosterFlag,
                        detailedDescription: enriched.detailedDescription,
                        clarity: enriched.clarity,
                        llmIdentifiedNames: acceptedLlmNames.length > 0 ? acceptedLlmNames : undefined,
                    };
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

            // Deliver or buffer based on groupingWindow setting
            const groupingWindow = (this.llmProvider.storageSettings.values as any).groupingWindow ?? 0;

            if (groupingWindow === 0 || !this.llmProvider.notificationBuffer) {
                // Instant delivery — today's behavior, zero overhead
                return await this.mixinDevice.sendNotification(enriched.title, options, media, icon);
            }

            // Deferred delivery — add to shared buffer for grouping
            // Each target carries its own options/media/icon so device-specific
            // metadata (e.g. data.ha) is preserved per-notifier at delivery time
            this.llmProvider.notificationBuffer.add({
                id: notificationId,
                timestamp: Date.now(),
                cameraName: cameraName || 'Unknown Camera',
                title: enriched.title,
                subtitle: enriched.subtitle,
                body: enriched.body,
                detailedDescription: enriched.detailedDescription,
                clarity: enriched.clarity,
            }, this.mixinDevice, options, media, icon);
            this.console.log(`[Grouping] Buffered: "${enriched.title}" from ${cameraName || 'Unknown Camera'} (${this.llmProvider.notificationBuffer.size} in window)`);
        } catch (e) {
            this.console.warn('LLM enhancement failed, using original notification:', e);
            return await this.mixinDevice.sendNotification(title, options, media, icon);
        }
    }
}
