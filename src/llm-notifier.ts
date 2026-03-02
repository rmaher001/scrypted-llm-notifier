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
import type LLMNotifierProvider from './main';

/**
 * LLM Notifier Plugin for Scrypted
 * Enhances notifications with images using LLM analysis
 * Preserves known person names from notifications
 */

export function createMessageTemplate(userPrompt: string, imageUrls: string[], metadata: any) {
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
11. detailedDescription: Write 2-3 detailed sentences for daily summaries. Include:
    - PEOPLE: clothing (color, pattern, type), items carried, activity, movement direction (arriving/leaving/passing)
    - VEHICLES: make, model, color when visible; delivery company if branded truck
    - ANIMALS: breed/type, color, leash/collar details, behavior
    - CONTEXT: interactions between subjects, notable objects, environment details
12. clarity: Assess the image clarity on a 1-10 scale with SPECIFIC criteria:
    - Score 1-2: UNUSABLE - Cannot identify what subject IS (blob, shadow, severe motion blur, too dark)
    - Score 3-4: POOR - Can identify subject TYPE only (person vs animal vs vehicle, but no other details)
    - Score 5-6: FAIR - Some details visible but uncertain (probably male, possibly dark clothing)
    - Score 7-8: GOOD - Most details clear (male wearing blue hoodie, carrying backpack)
    - Score 9-10: EXCELLENT - Face features visible, license plates readable, fine details clear
    Be STRICT and HONEST - if you're guessing what something is, score 5 or below.`;

    const schema = "CRITICAL CHARACTER LIMITS - STRICTLY ENFORCE:\n- Title: MAXIMUM 32 characters (count every letter, space, punctuation)\n- Subtitle: MAXIMUM 32 characters (count every letter, space, punctuation)\n- Body: MAXIMUM 75 characters (count every letter, space, punctuation)\n- detailedDescription: 2-3 sentences, no strict limit but be concise\n- clarity: object with score (1-10) and reason (brief explanation)\n\nYou MUST count characters before responding. Responses exceeding these limits will be REJECTED and cause system failure. If your description is too long, use shorter words and remove unnecessary details. The body character limit of 75 is ABSOLUTE and NON-NEGOTIABLE.";

    return {
        messages: [
            {
                role: "system",
                content: basePrompt + '\n\n' + userPrompt + '\n\n' + schema,
            },
            {
                role: "user",
                content: [
                    {
                        type: 'text',
                        text: `Original notification metadata: ${JSON.stringify(metadata, null, 2)}`,
                    },
                    ...imageUrls.map(url => ({
                        type: 'image_url',
                        image_url: { url }
                    }))
                ] as any
            }
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "notification_response",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        },
                        subtitle: {
                            type: "string"
                        },
                        body: {
                            type: "string"
                        },
                        detailedDescription: {
                            type: "string"
                        },
                        clarity: {
                            type: "object",
                            properties: {
                                score: { type: "number" },
                                reason: { type: "string" }
                            },
                            required: ["score", "reason"],
                            additionalProperties: false
                        }
                    },
                    required: ["title", "subtitle", "body", "detailedDescription", "clarity"],
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

        // Update stats
        this.notificationStats.total++;

        // Skip if no media or if disabled
        if (!media || !this.llmProvider.storageSettings.values.enabled) {
            this.notificationStats.withoutSnapshot++;
            this.console.log(`[${timestamp}] 📊 Notification without snapshot - Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot})`);
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
                    try {
                        const fullBuf = await mediaManager.convertMediaObjectToBuffer(fullMo, 'image/jpeg');
                        const { width: sw, height: sh } = getJpegDimensions(fullBuf);
                        // Automatic target width
                        let targetWidth = sw;
                        if (sw > 3000) targetWidth = 640;
                        else if (sw > 1500) targetWidth = 512;
                        else if (sw > 800) targetWidth = 384;
                        const dw = Math.min(targetWidth, sw);
                        const dh = Math.max(1, Math.round((sh * dw) / sw));
                        const beforeKB = Math.round(fullBuf.length / 1024);
                        const resized = await resizeJpegNearest(fullBuf, dw, 60);
                        const b64 = resized.toString('base64');
                        fullFrameUrl = `data:image/jpeg;base64,${b64}`;
                        const afterKB = Math.round(resized.length / 1024);
                        this.console.log(`[${timestamp}] 📐 Full frame resized ${sw}x${sh} ${beforeKB}KB -> ${dw}x${dh} ${afterKB}KB`);
                    } catch (resizeErr) {
                        this.console.warn('Full-frame local resize failed; using original full frame.', resizeErr);
                        const buf = await mediaManager.convertMediaObjectToBuffer(fullMo, 'image/jpeg');
                        const b64 = buf.toString('base64');
                        fullFrameUrl = `data:image/jpeg;base64,${b64}`;
                    }
                }
            }
        } catch (e) {
            this.console.warn('Full-frame (event) retrieval/rescale failed:', e);
        }

        this.console.log('=== LLM Notifier Debug ===');
        this.console.log('Original title:', title);
        this.console.log('Original subtitle:', options?.subtitle);
        this.console.log('Original body:', options?.body);

        // Build metadata for LLM
        const metadata: any = {};

        // Include original message if enabled
        if (this.llmProvider.storageSettings.values.includeOriginalMessage) {
            metadata.originalTitle = title;
            metadata.originalSubtitle = options?.subtitle;
            metadata.originalBody = options?.body;
            metadata.instruction = "Extract any 'Maybe: [name]' from the original text and use that name. Each field (title, subtitle, body) must contain DIFFERENT information - no repetition between fields.";
        }

        // Choose which image(s) to send
        const snapshotMode = (this.llmProvider.storageSettings.values as any).snapshotMode || 'cropped';
        imageUrls = buildImageList(snapshotMode, fullFrameUrl, imageUrl);

        if (!imageUrls.length) {
            this.console.warn('No usable snapshot. Forwarding original notification.');
            return this.mixinDevice.sendNotification(title, options, media, icon);
        }

        const messageTemplate = createMessageTemplate(
            this.llmProvider.storageSettings.values.userPrompt,
            imageUrls,
            metadata
        );

        // Track duplicate detections to analyze caching opportunities
        const re = (options as any)?.recordedEvent;
        const data = re?.data || {};
        const detectionId = data?.detectionId || data?.detections?.[0]?.id;

        if (detectionId) {
            const key = `${detectionId}:${snapshotMode}`;
            const text = `${title}|${options?.subtitle || ''}|${options?.body || ''}`;

            const existing = this.llmProvider.detectionTracker.get(key);
            if (existing) {
                existing.count++;
                if (existing.text !== text) {
                    this.console.warn(`⚠️  Detection key reused with DIFFERENT text:\n  Key: ${key}\n  Previous: "${existing.text}"\n  Current:  "${text}"`);
                } else {
                    this.console.log(`✓ Duplicate detection #${existing.count} (identical text): ${key}`);
                }
            } else {
                this.llmProvider.detectionTracker.set(key, {text, count: 1});
                this.console.log(`🔍 New detection: ${key}`);
            }
        }

        // Check response cache before calling LLM
        let newTitle: string;
        let subtitle: string;
        let body: string;
        let detailedDescription: string = '';
        let clarity: {score: number, reason: string} | undefined;
        let shouldStore = false; // Only store on first occurrence (cache miss)

        try {
            if (detectionId) {
            const cacheKey = `${detectionId}:${snapshotMode}`;
            const cached = this.llmProvider.responseCache.get(cacheKey);

            if (cached) {
                this.console.log(`💾 Cache HIT: ${cacheKey}`);
                newTitle = cached.title;
                subtitle = cached.subtitle;
                body = cached.body;
                detailedDescription = cached.detailedDescription;
                clarity = cached.clarity;
                // shouldStore remains false - duplicate
            } else {
                // Check if another request is already in-flight for this key
                const inFlight = this.llmProvider.inFlightRequests.get(cacheKey);

                if (inFlight) {
                    this.console.log(`⏳ Waiting for in-flight request: ${cacheKey}`);
                    const result = await inFlight;
                    newTitle = result.title;
                    subtitle = result.subtitle;
                    body = result.body;
                    detailedDescription = result.detailedDescription;
                    clarity = result.clarity;
                    // shouldStore remains false - the original request will store
                } else {
                    this.console.log(`❌ Cache MISS: ${cacheKey}`);
                    shouldStore = true; // First occurrence - will store

                    // Create and store the promise before starting the LLM call
                    const llmPromise = (async () => {
                        const start = Date.now();
                        const device = this.llmProvider.selectProvider();
                        const timeoutSec = (this.llmProvider.storageSettings.values as any).llmTimeoutMs ?? 90;
                        const llmTimeout = Math.max(1, Number(timeoutSec)) * 1000;
                        this.console.log(`Calling LLM (timeout ${llmTimeout}ms)...`);

                        try {
                            const llmData = await withTimeout(device.getChatCompletion(messageTemplate as any), llmTimeout, 'LLM request');
                            const responseTime = Date.now() - start;
                            const responseTimeSeconds = Math.round(responseTime / 1000);

                            const content = llmData.choices[0].message.content;
                            if (!content) {
                                throw new Error('Empty response from LLM');
                            }
                            const json = JSON.parse(content);
                            this.console.log('LLM response:', json);

                            const result = {
                                title: json.title,
                                subtitle: json.subtitle,
                                body: json.body,
                                detailedDescription: json.detailedDescription || '',
                                clarity: parseClarity(json.clarity, this.console)
                            };

                            if (typeof result.title !== 'string' || typeof result.subtitle !== 'string' ||
                                typeof result.body !== 'string' || typeof result.detailedDescription !== 'string') {
                                throw new Error('Invalid response format from LLM');
                            }

                            // Log clarity score for debugging
                            if (result.clarity) {
                                this.console.log(`🔍 Clarity score: ${result.clarity.score}/10 - ${result.clarity.reason}`);
                            }

                            // Store in cache
                            this.llmProvider.responseCache.set(cacheKey, result);

                            // Log all stats together
                            this.console.log(`[${timestamp}] 📊 LLM Notification processed - Mode: ${snapshotMode}, Cropped: ${imageSizeKB || 'N/A'}KB, Inference: ${responseTimeSeconds}s, Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot})`);

                            return result;
                        } finally {
                            // Clean up in-flight map
                            this.llmProvider.inFlightRequests.delete(cacheKey);
                        }
                    })();

                    // Store the promise immediately so other concurrent requests can await it
                    this.llmProvider.inFlightRequests.set(cacheKey, llmPromise);

                    // Await the result
                    const result = await llmPromise;
                    newTitle = result.title;
                    subtitle = result.subtitle;
                    body = result.body;
                    detailedDescription = result.detailedDescription;
                    clarity = result.clarity;
                }
            }
        } else {
            // No detectionId, must call LLM
            this.console.log(`⚠️  No detectionId, skipping cache`);
            shouldStore = true; // No way to dedupe, always store
            const start = Date.now();
            const device = this.llmProvider.selectProvider();
            const timeoutSec = (this.llmProvider.storageSettings.values as any).llmTimeoutMs ?? 90;
            const llmTimeout = Math.max(1, Number(timeoutSec)) * 1000;
            this.console.log(`Calling LLM (timeout ${llmTimeout}ms)...`);

            try {
                const llmData = await withTimeout(device.getChatCompletion(messageTemplate as any), llmTimeout, 'LLM request');
                const responseTime = Date.now() - start;
                const responseTimeSeconds = Math.round(responseTime / 1000);

                const content = llmData.choices[0].message.content;
                if (!content) {
                    throw new Error('Empty response from LLM');
                }
                const json = JSON.parse(content);
                this.console.log('LLM response:', json);

                newTitle = json.title;
                subtitle = json.subtitle;
                body = json.body;
                detailedDescription = json.detailedDescription || '';
                clarity = parseClarity(json.clarity, this.console);

                if (typeof newTitle !== 'string' || typeof subtitle !== 'string' ||
                    typeof body !== 'string' || typeof detailedDescription !== 'string') {
                    throw new Error('Invalid response format from LLM');
                }

                // Log clarity score for debugging
                if (clarity) {
                    this.console.log(`🔍 Clarity score: ${clarity.score}/10 - ${clarity.reason}`);
                }

                // Log all stats together
                this.console.log(`[${timestamp}] 📊 LLM Notification processed - Mode: ${snapshotMode}, Cropped: ${imageSizeKB || 'N/A'}KB, Inference: ${responseTimeSeconds}s, Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot})`);
            } catch (e) {
                throw e; // Re-throw to outer catch block
            }
            }

            // Update options with LLM-generated content
            options ||= {};
            options.body = body;
            options.subtitle = subtitle;  // For iOS and Scrypted UI (not shown on Android HA)
            options.bodyWithSubtitle = body;  // Required for iOS to display body when subtitle is present

            // Store notification for Daily Brief (only on first occurrence)
            if (shouldStore) try {
                const re = (options as any)?.recordedEvent;
                const eventData = re?.data || {};
                const detections = eventData?.detections || [];

                // Extract detection type
                let detectionType = 'motion';
                if (detections.length > 0) {
                    detectionType = detections[0]?.className || 'motion';
                }

                // Extract names from detections (face recognition)
                const names: string[] = [];
                for (const det of detections) {
                    if (det.label && det.className === 'face') {
                        names.push(det.label);
                    }
                }

                // Also check original title/body for "Maybe: Name" pattern
                const maybeMatch = (title + ' ' + (options?.body || '')).match(/Maybe:\s*(\w+)/gi);
                if (maybeMatch) {
                    for (const m of maybeMatch) {
                        const name = m.replace(/Maybe:\s*/i, '').trim();
                        if (name && !names.includes(name)) {
                            names.push(name);
                        }
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

                    // Use detectionId if available, otherwise generate fallback (#14)
                    let notificationId = detectionId;
                    if (!notificationId) {
                        notificationId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
                        this.console.warn(`[Storage] No detectionId available, using fallback ID: ${notificationId} - cache deduplication disabled for this notification`);
                    }

                    // Extract embedding from detections (computed by Scrypted, free)
                    let embedding: string | undefined;
                    let embeddingDimension: number | undefined;
                    for (const det of detections) {
                        if (det.embedding) {
                            embedding = det.embedding;
                            const buf = Buffer.from(det.embedding, 'base64');
                            embeddingDimension = buf.length / 4; // float32 = 4 bytes per element
                            break; // Use first detection with embedding
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
                        llmTitle: newTitle,
                        llmSubtitle: subtitle,
                        llmBody: body,
                        thumbnailB64,
                        hasPoster: hasPosterFlag,
                        detailedDescription,  // From the same LLM call - no extra cost
                        clarity  // Image clarity assessment from LLM
                    };
                    this.llmProvider.notificationStore.add(storedNotification);

                    // Store embedding separately (avoids bloating notification JSON)
                    if (embedding && embeddingDimension) {
                        this.llmProvider.notificationStore.addEmbedding(notificationId, embedding, embeddingDimension);
                    }
                }
            } catch (storeErr) {
                this.console.warn('Failed to store notification for Daily Brief:', storeErr);
            }

            return await this.mixinDevice.sendNotification(newTitle, options, media, icon);
        } catch (e) {
            this.console.warn('LLM enhancement failed, using original notification:', e);
            return await this.mixinDevice.sendNotification(title, options, media, icon);
        }
    }
}
