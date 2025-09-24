import sdk, { 
    ChatCompletion,
    MediaObject, 
    MixinDeviceBase, 
    MixinProvider, 
    Notifier, 
    NotifierOptions,
    ScryptedDevice,
    ScryptedDeviceBase, 
    ScryptedDeviceType, 
    ScryptedInterface,
    Settings,
    SettingValue,
    WritableDeviceState 
} from '@scrypted/sdk';
const { StorageSettings } = require('@scrypted/sdk/storage-settings');

const { mediaManager } = sdk;
import jpeg from 'jpeg-js';

function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T> {
    let to: NodeJS.Timeout;
    const timeout = new Promise<T>((_, reject) => {
        to = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(to!)) as Promise<T>;
}

// Local JPEG resize (nearest-neighbor) for full-frame downscale
async function resizeJpegNearest(input: Buffer, targetWidth: number, quality = 60): Promise<Buffer> {
    const { data: src, width: sw, height: sh } = jpeg.decode(input, { useTArray: true });
    if (!sw || !sh)
        return input;
    const dw = Math.min(targetWidth, sw);
    if (dw === sw)
        return input;
    const dh = Math.max(1, Math.round((sh * dw) / sw));
    const dst = Buffer.allocUnsafe(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const sy = Math.floor((y * sh) / dh);
        for (let x = 0; x < dw; x++) {
            const sx = Math.floor((x * sw) / dw);
            const si = (sy * sw + sx) << 2;
            const di = (y * dw + x) << 2;
            dst[di] = src[si];
            dst[di + 1] = src[si + 1];
            dst[di + 2] = src[si + 2];
            dst[di + 3] = 255;
        }
    }
    const { data } = jpeg.encode({ data: dst, width: dw, height: dh }, quality);
    return Buffer.from(data);
}

function getJpegDimensions(input: Buffer): { width: number; height: number } {
    const { width, height } = jpeg.decode(input, { useTArray: true });
    return { width, height };
}

function buildImageList(mode: string, full?: string, cropped?: string): string[] {
    const list: string[] = [];
    if (mode === 'both') {
        if (full) list.push(full);
        if (cropped) list.push(cropped);
    } else if (mode === 'full') {
        if (full) list.push(full);
        else if (cropped) list.push(cropped);
    } else { // 'cropped'
        if (cropped) list.push(cropped);
        else if (full) list.push(full);
    }
    return list;
}

/**
 * LLM Notifier Plugin for Scrypted
 * Enhances notifications with images using LLM analysis
 * Preserves known person names from notifications
 */

function createMessageTemplate(userPrompt: string, imageUrls: string[], metadata: any) {
    // Hardcoded base prompt with structural requirements
    const basePrompt = `Analyze the security camera image and generate a notification.

CRITICAL RULES (DO NOT VIOLATE):
1. ONLY use names if metadata contains "Maybe: [name]" - use that EXACT name WITHOUT "Maybe:"
2. If NO name in metadata, use generic terms: Person, Man, Woman, Visitor
3. NEVER make up names like John, Sarah, etc. - only use names from metadata
4. NEVER include "Maybe:" in your response - only use the actual name
5. Title format MUST be: "[Person/Object] at [location]"
6. Some platforms only show title+body - put ALL critical info there
7. Each field MUST contain different information - no repetition between fields
8. Response MUST be valid JSON with exactly three fields: title, subtitle, body
9. If using a person's name in title, use the same name in body - never switch to generic terms`;

    const schema = "CRITICAL: The response must be in JSON format with a message 'title', 'subtitle', and 'body'. The title and subtitle must be EXACTLY 32 characters or less. The body must be EXACTLY 80 characters or less. Any response exceeding these limits is invalid.";

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
                        }
                    },
                    required: ["title", "subtitle", "body"],
                    additionalProperties: false
                }
            }
        }
    };
}

class LLMNotifier extends MixinDeviceBase<Notifier> implements Notifier {
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
        if (typeof media === 'string') {
            imageUrl = media;
        }
        else {
            const buffer = await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
            const b64 = buffer.toString('base64');
            imageUrl = `data:image/jpeg;base64,${b64}`;
            imageSizeKB = Math.round(buffer.length / 1024);
        }

        // Optionally fetch a downscaled full-frame snapshot for THIS EVENT (no fresh camera snapshot)
        try {
            const snapshotMode = (this.llmProvider.storageSettings.values as any).snapshotMode || 'cropped';
            if (snapshotMode !== 'cropped') {
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

        try {
            const device = this.llmProvider.selectProvider();

            const start = Date.now();
            const timeoutSec = (this.llmProvider.storageSettings.values as any).llmTimeoutMs ?? 90;
            const llmTimeout = Math.max(1, Number(timeoutSec)) * 1000;
            this.console.log(`Calling LLM (timeout ${llmTimeout}ms)...`);
            const data = await withTimeout(device.getChatCompletion(messageTemplate as any), llmTimeout, 'LLM request');
            const responseTime = Date.now() - start;
            const responseTimeSeconds = Math.round(responseTime / 1000);
            
            const content = data.choices[0].message.content;
            if (!content) {
                throw new Error('Empty response from LLM');
            }
            const json = JSON.parse(content);
            this.console.log('LLM response:', json);
            
            const { title: newTitle, subtitle, body } = json;

            if (typeof newTitle !== 'string' || typeof subtitle !== 'string' || typeof body !== 'string')
                throw new Error('Invalid response format from LLM');

            // Log all stats together
            this.console.log(`[${timestamp}] 📊 LLM Notification processed - Mode: ${snapshotMode}, Cropped: ${imageSizeKB || 'N/A'}KB, Inference: ${responseTimeSeconds}s, Total: ${this.notificationStats.total} (With: ${this.notificationStats.withSnapshot}, Without: ${this.notificationStats.withoutSnapshot})`);

            // Update options with LLM-generated content
            options ||= {};
            options.body = body;
            options.subtitle = subtitle;  // For iOS and Scrypted UI (not shown on Android HA)

            return await this.mixinDevice.sendNotification(newTitle, options, media, icon);
        }
        catch (e) {
            this.console.warn('LLM enhancement failed, using original notification:', e);
            return await this.mixinDevice.sendNotification(title, options, media, icon);
        }
    }
}

export default class LLMNotifierProvider extends ScryptedDeviceBase implements MixinProvider, Settings {
    private currentProviderIndex = 0;
    
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
            description: 'Customize how notifications describe detections. You can adjust locations, emphasis, and level of detail.',
            defaultValue: `STYLE PREFERENCES:

Title: Include person names ONLY when provided in metadata, otherwise use generic terms
- When name known: "Richard at front door"
- When name unknown: "Person at front door"
- For vehicles: Include license plate if clearly visible (e.g., "White Camry ABC123")

Subtitle: Category marker
- Format: "[Type] • [Area]"
- Examples: "Person • Indoor", "Vehicle • Street"

Body: Focus on actions and key visual details
- Describe what's happening in the scene
- Include relevant clothing, objects, or movements
- Include license plate in body if visible but not in title
- Examples:
  "Walking toward garage while checking phone and carrying a shopping bag"
  "White sedan with plate XYZ789 pulling slowly into space with headlights on"
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
        }
    });

    async getSettings() {
        const settings: any[] = await this.storageSettings.getSettings();
        const byKey = new Map<string, any>();
        for (const s of settings) {
            if (s?.key)
                byKey.set(s.key, s);
        }
        const orderedKeys = [
            // General first
            'chatCompletions',
            'userPrompt',
            // Options (Advanced)
            'enabled',
            'llmTimeoutMs',
            'snapshotMode',
            'includeOriginalMessage',
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

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
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
