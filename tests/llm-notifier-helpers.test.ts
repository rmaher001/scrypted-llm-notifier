/**
 * Tests for extracted helper functions from sendNotification.
 * These test the pure logic that was previously inline in the 400-line monolith.
 */

import {
    extractDetectionId,
    extractDetectionData,
    buildMetadata,
    callLlm,
    createMessageTemplate,
    EnrichmentResult,
    shouldLoadReferenceImages,
    shouldCurateReference,
    mergeIdentifiedPersons,
    filterAcceptedPersons,
    buildNameBadges,
    processFullFrame,
    buildStoredNotification,
    extractFaceBoundingBox,
    buildPerEventClickData,
    normalizeNotificationClickUrl,
    sanitizeHaClickUrl,
} from '../src/llm-notifier';
import { StoredNotification } from '../src/types';
import { collapseByGroup, getGalleryPage } from '../src/gallery';
import { cropJpeg, parseFaceReferenceQuality } from '../src/utils';
import { summarizeDetectionsForFaceProbe } from '../src/llm-notifier';
import { prioritySelectFromBucket } from '../src/daily-brief/candidate-selection';

describe('extractDetectionId', () => {
    it('returns detectionId from recordedEvent.data', () => {
        const options = {
            recordedEvent: { data: { detectionId: 'det-123' } },
        };
        expect(extractDetectionId(options)).toBe('det-123');
    });

    it('falls back to first detection id when no detectionId', () => {
        const options = {
            recordedEvent: { data: { detections: [{ id: 'fallback-id' }] } },
        };
        expect(extractDetectionId(options)).toBe('fallback-id');
    });

    it('returns undefined when no recordedEvent', () => {
        expect(extractDetectionId({})).toBeUndefined();
        expect(extractDetectionId(undefined)).toBeUndefined();
    });

    it('returns undefined when recordedEvent has no data', () => {
        const options = { recordedEvent: {} };
        expect(extractDetectionId(options)).toBeUndefined();
    });

    it('prefers detectionId over detections[0].id', () => {
        const options = {
            recordedEvent: {
                data: {
                    detectionId: 'preferred',
                    detections: [{ id: 'fallback' }],
                },
            },
        };
        expect(extractDetectionId(options)).toBe('preferred');
    });
});

describe('extractDetectionData', () => {
    it('returns motion as default detectionType', () => {
        const result = extractDetectionData([], 'title', '');
        expect(result.detectionType).toBe('motion');
    });

    it('extracts detectionType from first detection className', () => {
        const detections = [{ className: 'person' }, { className: 'face' }];
        const result = extractDetectionData(detections, 'title', '');
        expect(result.detectionType).toBe('person');
    });

    it('extracts names from face detections with labels', () => {
        const detections = [
            { className: 'face', label: 'Alex' },
            { className: 'face', label: 'Casey' },
            { className: 'person' },
        ];
        const result = extractDetectionData(detections, 'title', '');
        expect(result.names).toEqual(['Alex', 'Casey']);
    });

    it('does not extract names from non-face detections', () => {
        const detections = [
            { className: 'person', label: 'SomeLabel' },
        ];
        const result = extractDetectionData(detections, 'title', '');
        expect(result.names).toEqual([]);
    });

    it('extracts Maybe: names from title and body', () => {
        const result = extractDetectionData([], 'Maybe: Alex at door', 'Maybe: Casey nearby');
        expect(result.names).toContain('Alex');
        expect(result.names).toContain('Casey');
    });

    it('deduplicates names from detections and Maybe: patterns', () => {
        const detections = [{ className: 'face', label: 'Alex' }];
        const result = extractDetectionData(detections, 'Maybe: Alex at door', '');
        expect(result.names).toEqual(['Alex']);
    });

    it('handles empty detections array', () => {
        const result = extractDetectionData([], 'title', 'body');
        expect(result.detectionType).toBe('motion');
        expect(result.names).toEqual([]);
    });
});

describe('buildMetadata', () => {
    it('returns empty object when includeOriginal is false', () => {
        const result = buildMetadata('Title', 'Subtitle', 'Body', false);
        expect(result).toEqual({});
    });

    it('includes original message fields when includeOriginal is true', () => {
        const result = buildMetadata('Title', 'Subtitle', 'Body', true);
        expect(result.originalTitle).toBe('Title');
        expect(result.originalSubtitle).toBe('Subtitle');
        expect(result.originalBody).toBe('Body');
        expect(result.instruction).toBeDefined();
    });

    it('handles undefined subtitle and body', () => {
        const result = buildMetadata('Title', undefined, undefined, true);
        expect(result.originalTitle).toBe('Title');
        expect(result.originalSubtitle).toBeUndefined();
        expect(result.originalBody).toBeUndefined();
    });
});

describe('callLlm', () => {
    const mockConsole = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns parsed LLM response on success', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'Person at Door',
                            subtitle: 'Front Door',
                            body: 'Adult male approaching',
                            detailedDescription: 'A man walks up.',
                            clarity: { score: 7, reason: 'clear image' },
                        }),
                    },
                }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.title).toBe('Person at Door');
        expect(result.subtitle).toBe('Front Door');
        expect(result.body).toBe('Adult male approaching');
        expect(result.detailedDescription).toBe('A man walks up.');
        expect(result.clarity?.score).toBe(7);
    });

    it('throws on empty LLM response', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: '' } }],
            }),
        };

        await expect(callLlm(mockProvider as any, {} as any, 90000, mockConsole as any))
            .rejects.toThrow('Empty response from LLM');
    });

    it('throws on invalid JSON response', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: 'not json' } }],
            }),
        };

        await expect(callLlm(mockProvider as any, {} as any, 90000, mockConsole as any))
            .rejects.toThrow();
    });

    it('strips markdown json fences from response', async () => {
        const inner = JSON.stringify({
            title: 'Fenced Response',
            subtitle: 'Test',
            body: 'Body text',
            detailedDescription: 'Detailed',
            clarity: { score: 7, reason: 'clear' },
        });
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: '```json\n' + inner + '\n```' } }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.title).toBe('Fenced Response');
    });

    it('throws on missing required fields', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({ title: 'Only title' }),
                    },
                }],
            }),
        };

        await expect(callLlm(mockProvider as any, {} as any, 90000, mockConsole as any))
            .rejects.toThrow('Invalid response format');
    });

    it('defaults detailedDescription to empty string when missing', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'T', subtitle: 'S', body: 'B',
                            clarity: { score: 5, reason: 'ok' },
                        }),
                    },
                }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.detailedDescription).toBe('');
    });

    it('parses faceReferenceQuality from LLM response', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'T', subtitle: 'S', body: 'B',
                            detailedDescription: 'D',
                            clarity: { score: 8, reason: 'clear' },
                            faceReferenceQuality: {
                                score: 9, frontFacing: true, unobstructed: true, singleSubject: true,
                            },
                        }),
                    },
                }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.faceReferenceQuality).toEqual({
            score: 9, frontFacing: true, unobstructed: true, singleSubject: true,
        });
    });

    it('sets faceReferenceQuality to null when not in LLM response', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'T', subtitle: 'S', body: 'B',
                            detailedDescription: 'D',
                            clarity: { score: 5, reason: 'ok' },
                        }),
                    },
                }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.faceReferenceQuality).toBeNull();
    });
});

describe('createMessageTemplate with referenceImages', () => {
    it('produces unchanged output when no referenceImages provided', () => {
        const result = createMessageTemplate('user prompt', ['data:image/jpeg;base64,abc'], { key: 'val' });
        const systemMsg = result.messages[0].content;
        expect(systemMsg).not.toContain('PERSON IDENTIFICATION');
        // Schema should NOT have identifiedPerson
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPerson).toBeUndefined();
        expect(schema.required).not.toContain('identifiedPerson');
    });

    it('includes faceReferenceQuality in schema', () => {
        const result = createMessageTemplate('prompt', ['img'], {});
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.faceReferenceQuality).toBeDefined();
        expect(schema.required).toContain('faceReferenceQuality');
    });

    it('faceReferenceQuality prompt mentions frontFacing and unobstructed', () => {
        const result = createMessageTemplate('prompt', ['img'], {});
        const systemMsg = result.messages[0].content as string;
        expect(systemMsg).toMatch(/faceReferenceQuality/);
        expect(systemMsg).toMatch(/front.?facing/i);
        expect(systemMsg).toMatch(/unobstructed/i);
    });

    it('produces unchanged output when referenceImages is undefined', () => {
        const result = createMessageTemplate('user prompt', ['img1'], {}, undefined);
        const systemMsg = result.messages[0].content;
        expect(systemMsg).not.toContain('PERSON IDENTIFICATION');
    });

    it('produces unchanged output when referenceImages is empty Map', () => {
        const result = createMessageTemplate('user prompt', ['img1'], {}, new Map());
        const systemMsg = result.messages[0].content;
        expect(systemMsg).not.toContain('PERSON IDENTIFICATION');
    });

    it('adds person identification prompt when referenceImages provided', () => {
        const refs = new Map([['Alex', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('user prompt', ['detection-img'], {}, refs);

        const systemMsg = result.messages[0].content;
        expect(systemMsg).toContain('PERSON IDENTIFICATION');
        expect(systemMsg).toContain('identifiedPersons');
    });

    it('adds reference photos to user message content', () => {
        const refs = new Map([
            ['Alex', 'data:image/jpeg;base64,alex123'],
            ['Blake', 'data:image/jpeg;base64,blake456'],
        ]);
        const result = createMessageTemplate('prompt', ['det-img'], {}, refs);

        const userContent = result.messages[1].content as any[];
        // Should have: "Reference photos" text, "Known person: Alex", Alex image,
        // "Known person: Blake", Blake image, detection image, metadata text
        expect(userContent).toHaveLength(1 + 2 * 2 + 1 + 1); // 7 items

        // Check reference photo labels
        const textItems = userContent.filter((c: any) => c.type === 'text').map((c: any) => c.text);
        expect(textItems).toContain('Reference photos of known people:');
        expect(textItems).toContain('Known person: "Alex"');
        expect(textItems).toContain('Known person: "Blake"');

        // Check reference images
        const imageItems = userContent.filter((c: any) => c.type === 'image_url');
        expect(imageItems).toHaveLength(3); // 1 detection + 2 references

        // Detection images must come BEFORE metadata text (images before text for better vision grounding)
        const detImgIdx = userContent.findIndex((c: any) => c.type === 'image_url' && c.image_url.url === 'det-img');
        const metadataIdx = userContent.findIndex((c: any) => c.type === 'text' && c.text.includes('metadata'));
        expect(detImgIdx).toBeLessThan(metadataIdx);
    });

    it('includes identifiedPersons array in JSON schema when referenceImages provided', () => {
        const refs = new Map([['Alex', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);

        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPersons).toBeDefined();
        expect(schema.properties.identifiedPersons.anyOf).toBeDefined();
        expect(schema.required).toContain('identifiedPersons');
    });
});

describe('callLlm with telemetry sink', () => {
    const mockConsole = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    beforeEach(() => jest.clearAllMocks());

    it('emits an ok row on success with quality fields populated', async () => {
        const responseContent = JSON.stringify({
            title: 'Person at Door',
            subtitle: 'Front Door',
            body: 'Adult male approaching',
            detailedDescription: 'A man in blue walks up the steps.',
            clarity: { score: 7, reason: 'clear' },
            faceReferenceQuality: { score: 6, frontFacing: true, unobstructed: true, singleSubject: true },
            identifiedPersons: [{ name: 'Alex', confidence: 8 }],
        });
        const mockProvider: any = {
            name: 'gemma-test',
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: responseContent } }],
            }),
        };
        const rows: any[] = [];
        const result = await callLlm(mockProvider, {} as any, 90000, mockConsole as any, false, {
            sink: { record: (r: any) => { rows.push(r); } },
            role: 'notification',
            promptBytes: 2048,
            imageCount: 2,
        });
        expect(result).toBeTruthy();
        expect(rows).toHaveLength(1);
        const r = rows[0];
        expect(r.outcome).toBe('ok');
        expect(r.providerName).toBe('gemma-test');
        expect(r.role).toBe('notification');
        expect(r.promptBytes).toBe(2048);
        expect(r.imageCount).toBe(2);
        expect(r.clarityScore).toBe(7);
        expect(r.faceRefScore).toBe(6);
        expect(r.identifiedPersonCount).toBe(1);
        expect(typeof r.latencyMs).toBe('number');
        expect(typeof r.id).toBe('string');
        expect(r.id.length).toBeGreaterThan(0);
    });

    it('returns telemetryId on the EnrichmentResult that matches the emitted row', async () => {
        const responseContent = JSON.stringify({
            title: 't', subtitle: 's', body: 'b', detailedDescription: 'd',
        });
        const mockProvider: any = {
            name: 'p',
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: responseContent } }],
            }),
        };
        const rows: any[] = [];
        const result = await callLlm(mockProvider, {} as any, 90000, mockConsole as any, false, {
            sink: { record: (r: any) => { rows.push(r); } },
            role: 'notification',
            promptBytes: 100,
        });
        expect(result.telemetryId).toBeTruthy();
        expect(result.telemetryId).toBe(rows[0].id);
    });

    it('emits a timeout row when the underlying call times out', async () => {
        const mockProvider: any = {
            name: 'slow',
            getChatCompletion: () => new Promise(() => { /* never */ }),
        };
        const rows: any[] = [];
        await expect(
            callLlm(mockProvider, {} as any, 20, mockConsole as any, false, {
                sink: { record: (r: any) => { rows.push(r); } },
                role: 'notification',
                promptBytes: 100,
            }),
        ).rejects.toThrow();
        expect(rows).toHaveLength(1);
        expect(rows[0].outcome).toBe('timeout');
    });

    it('emits an error row on provider rejection', async () => {
        const mockProvider: any = {
            name: 'broken',
            getChatCompletion: jest.fn().mockRejectedValue(new Error('upstream 500')),
        };
        const rows: any[] = [];
        await expect(
            callLlm(mockProvider, {} as any, 5000, mockConsole as any, false, {
                sink: { record: (r: any) => { rows.push(r); } },
                role: 'notification',
                promptBytes: 100,
            }),
        ).rejects.toThrow('upstream 500');
        expect(rows).toHaveLength(1);
        expect(rows[0].outcome).toBe('error');
        expect(rows[0].errorMsg).toContain('500');
    });

    it('emits a parse_error row when the response is not valid JSON', async () => {
        const mockProvider: any = {
            name: 'garbage',
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: 'not json at all' } }],
            }),
        };
        const rows: any[] = [];
        await expect(
            callLlm(mockProvider, {} as any, 5000, mockConsole as any, false, {
                sink: { record: (r: any) => { rows.push(r); } },
                role: 'notification',
                promptBytes: 100,
            }),
        ).rejects.toThrow();
        expect(rows).toHaveLength(1);
        expect(rows[0].outcome).toBe('parse_error');
    });

    it('never throws from telemetry sink failures', async () => {
        const mockProvider: any = {
            name: 'p',
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: JSON.stringify({
                    title: 't', subtitle: 's', body: 'b', detailedDescription: 'd',
                }) } }],
            }),
        };
        // A sink that always throws should not break the caller.
        await expect(
            callLlm(mockProvider, {} as any, 5000, mockConsole as any, false, {
                sink: { record: () => { throw new Error('disk full'); } },
                role: 'notification',
                promptBytes: 100,
            }),
        ).resolves.toBeTruthy();
    });
});

describe('callLlm with identifiedPerson', () => {
    const mockConsole = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('extracts identifiedPerson from response', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'Person at Door',
                            subtitle: 'Front Door',
                            body: 'Adult approaching',
                            detailedDescription: 'A person walks up.',
                            clarity: { score: 7, reason: 'clear' },
                            identifiedPerson: 'Alex',
                        }),
                    },
                }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPerson).toBe('Alex');
    });

    it('returns null when LLM returns identifiedPerson as null', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'Person at Door',
                            subtitle: 'Front Door',
                            body: 'Adult approaching',
                            detailedDescription: 'A person walks up.',
                            clarity: { score: 5, reason: 'ok' },
                            identifiedPerson: null,
                        }),
                    },
                }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPerson).toBeNull();
    });

    it('returns null when identifiedPerson field is missing (backward compat)', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'T', subtitle: 'S', body: 'B',
                            detailedDescription: 'D',
                            clarity: { score: 5, reason: 'ok' },
                        }),
                    },
                }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPerson).toBeNull();
    });
});

describe('StoredNotification llmIdentifiedName field', () => {
    const baseNotification: StoredNotification = {
        id: 'test-1',
        timestamp: Date.now(),
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: ['Alex'],
        llmTitle: 'Alex at Door',
        llmSubtitle: 'Front Door',
        llmBody: 'Alex approaching',
    };

    it('accepts llmIdentifiedName as optional string', () => {
        const notif: StoredNotification = { ...baseNotification, llmIdentifiedName: 'Alex' };
        expect(notif.llmIdentifiedName).toBe('Alex');
    });

    it('defaults llmIdentifiedName to undefined when not set', () => {
        expect(baseNotification.llmIdentifiedName).toBeUndefined();
    });
});

describe('StoredNotification grouping fields', () => {
    const baseNotification: StoredNotification = {
        id: 'test-1',
        timestamp: Date.now(),
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: [],
        llmTitle: 'Person at Door',
        llmSubtitle: 'Front Door',
        llmBody: 'Adult approaching',
    };

    it('accepts groupId as optional string', () => {
        const grouped: StoredNotification = { ...baseNotification, groupId: 'group-abc' };
        expect(grouped.groupId).toBe('group-abc');
    });

    it('accepts isGroupPrimary as optional boolean', () => {
        const primary: StoredNotification = { ...baseNotification, isGroupPrimary: true };
        expect(primary.isGroupPrimary).toBe(true);
    });

    it('defaults groupId to undefined when not set', () => {
        expect(baseNotification.groupId).toBeUndefined();
    });

    it('defaults isGroupPrimary to undefined when not set', () => {
        expect(baseNotification.isGroupPrimary).toBeUndefined();
    });
});

describe('collapseByGroup', () => {
    function makeNotif(id: string, groupId?: string, isGroupPrimary?: boolean): StoredNotification {
        return {
            id,
            timestamp: Date.now(),
            cameraId: 'cam-1',
            cameraName: 'Front Door',
            detectionType: 'person',
            names: [],
            llmTitle: 'Title',
            llmSubtitle: 'Sub',
            llmBody: 'Body',
            groupId,
            isGroupPrimary,
        };
    }

    it('returns all ungrouped notifications', () => {
        const notifications = [makeNotif('n1'), makeNotif('n2'), makeNotif('n3')];
        const result = collapseByGroup(notifications);
        expect(result).toHaveLength(3);
    });

    it('returns only the primary for a group', () => {
        const notifications = [
            makeNotif('n1', 'g1', true),
            makeNotif('n2', 'g1', false),
            makeNotif('n3', 'g1', false),
        ];
        const result = collapseByGroup(notifications);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('n1');
    });

    it('mixes ungrouped and grouped notifications', () => {
        const notifications = [
            makeNotif('n1'),                       // ungrouped
            makeNotif('n2', 'g1', true),           // primary of g1
            makeNotif('n3', 'g1', false),          // secondary of g1
            makeNotif('n4'),                       // ungrouped
            makeNotif('n5', 'g2', true),           // primary of g2
        ];
        const result = collapseByGroup(notifications);
        expect(result).toHaveLength(4);
        expect(result.map(n => n.id)).toEqual(['n1', 'n2', 'n4', 'n5']);
    });

    it('returns empty array for empty input', () => {
        expect(collapseByGroup([])).toEqual([]);
    });

    it('hides non-primary group members', () => {
        const notifications = [
            makeNotif('n1', 'g1', false),
            makeNotif('n2', 'g1', false),
        ];
        const result = collapseByGroup(notifications);
        expect(result).toHaveLength(0);
    });
});

describe('prioritySelectFromBucket group-awareness', () => {
    function makeNotif(id: string, overrides?: Partial<StoredNotification>): StoredNotification {
        return {
            id,
            timestamp: Date.now(),
            cameraId: 'cam-1',
            cameraName: 'Front Door',
            detectionType: 'person',
            names: [],
            llmTitle: 'Person at Door',
            llmSubtitle: 'Front Door',
            llmBody: 'Adult approaching',
            ...overrides,
        };
    }

    it('excludes non-primary group members from selection', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true }),
            makeNotif('n2', { groupId: 'g1', isGroupPrimary: false }),
            makeNotif('n3', { groupId: 'g1', isGroupPrimary: false }),
            makeNotif('n4'), // ungrouped
        ];

        const result = prioritySelectFromBucket(notifications, 10);

        const selectedIds = result.map(r => r.notification.id);
        expect(selectedIds).toContain('n1');
        expect(selectedIds).toContain('n4');
        expect(selectedIds).not.toContain('n2');
        expect(selectedIds).not.toContain('n3');
    });

    it('includes all ungrouped notifications', () => {
        const notifications = [
            makeNotif('n1'),
            makeNotif('n2'),
            makeNotif('n3'),
        ];

        const result = prioritySelectFromBucket(notifications, 10);
        expect(result).toHaveLength(3);
    });

    it('limits to count after group filtering', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true }),
            makeNotif('n2', { groupId: 'g1', isGroupPrimary: false }),
            makeNotif('n3'),
            makeNotif('n4'),
            makeNotif('n5'),
        ];

        const result = prioritySelectFromBucket(notifications, 2);
        expect(result).toHaveLength(2);
        // Should not include n2 (non-primary group member)
        const selectedIds = result.map(r => r.notification.id);
        expect(selectedIds).not.toContain('n2');
    });
});

describe('getGalleryPage groupId drill-down', () => {
    function makeNotif(id: string, overrides?: Partial<StoredNotification>): StoredNotification {
        return {
            id,
            timestamp: Date.now(),
            cameraId: 'cam-1',
            cameraName: 'Front Door',
            detectionType: 'person',
            names: [],
            llmTitle: 'Person at Door',
            llmSubtitle: 'Front Door',
            llmBody: 'Adult approaching',
            ...overrides,
        };
    }

    it('returns all group members when groupId filter is present', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true }),
            makeNotif('n2', { groupId: 'g1', isGroupPrimary: false }),
            makeNotif('n3', { groupId: 'g1', isGroupPrimary: false }),
            makeNotif('n4'),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'g1');
        expect(result.notifications).toHaveLength(3);
        expect(result.notifications.map(n => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
    });

    it('does not include groupSize in drill-down view', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true }),
            makeNotif('n2', { groupId: 'g1', isGroupPrimary: false }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'g1');
        for (const n of result.notifications) {
            expect(n.groupSize).toBeUndefined();
        }
    });

    it('returns empty when groupId does not match any notifications', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'no-match');
        expect(result.notifications).toHaveLength(0);
        expect(result.total).toBe(0);
    });

    it('skips collapseByGroup when groupId is present', () => {
        // Without groupId filter, only the primary shows
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true }),
            makeNotif('n2', { groupId: 'g1', isGroupPrimary: false }),
            makeNotif('n3', { groupId: 'g1', isGroupPrimary: false }),
        ];
        const collapsed = getGalleryPage(notifications, 1, 50, {});
        expect(collapsed.notifications).toHaveLength(1);

        // With groupId filter, all members show
        const drillDown = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'g1');
        expect(drillDown.notifications).toHaveLength(3);
    });

    it('returns groupTitle from the primary notification', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true, llmTitle: 'Primary Title' }),
            makeNotif('n2', { groupId: 'g1', isGroupPrimary: false }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'g1');
        expect(result.groupTitle).toBe('Primary Title');
        expect(result.groupMemberCount).toBe(2);
    });

    it('returns persisted group LLM title/body when set on primary, falling back to llmTitle/llmBody', () => {
        const notifications = [
            makeNotif('n1', {
                groupId: 'g1',
                isGroupPrimary: true,
                llmTitle: 'Primary Title',
                llmBody: 'Primary body',
                llmGroupTitle: 'Persons in Yard',
                llmGroupBody: 'Three people moved through the yard.',
            }),
            makeNotif('n2', { groupId: 'g1', isGroupPrimary: false }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'g1');
        // groupTitle prefers persisted llmGroupTitle when present.
        expect(result.groupTitle).toBe('Persons in Yard');
        expect(result.groupBody).toBe('Three people moved through the yard.');
    });

    it('groupHeroUrl points to the primary record\'s per-event poster (composite endpoint deleted with grouping pipeline)', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'group-xyz', isGroupPrimary: true, hasPoster: true }),
            makeNotif('n2', { groupId: 'group-xyz', isGroupPrimary: false, hasPoster: true }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'group-xyz');
        expect(result.groupHeroUrl).toBe('/brief/snapshot?id=n1');
    });

    it('groupHeroUrl is empty when the primary record has no per-event poster', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'group-abc', isGroupPrimary: true, hasPoster: false }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'group-abc');
        expect(result.groupHeroUrl).toBe('');
    });

    it('echoes the groupId in the response so the client can construct fallback URLs', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'g1');
        expect(result.groupId).toBe('g1');
    });

    it('groupStartMs and groupDurationMs reflect member timestamps', () => {
        const notifications = [
            makeNotif('n1', { groupId: 'g1', isGroupPrimary: true, timestamp: 100_000 }),
            makeNotif('n2', { groupId: 'g1', isGroupPrimary: false, timestamp: 250_000 }),
            makeNotif('n3', { groupId: 'g1', isGroupPrimary: false, timestamp: 175_000 }),
        ];
        const result = getGalleryPage(notifications, 1, 50, {}, undefined, '', 'g1');
        expect(result.groupStartMs).toBe(100_000);
        expect(result.groupDurationMs).toBe(150_000);
    });
});

describe('shouldLoadReferenceImages', () => {
    it('returns false when feature disabled', () => {
        const detections = [{ className: 'person' }];
        expect(shouldLoadReferenceImages(false, detections)).toBe(false);
    });

    it('returns false when no face detection (e.g., vehicle only)', () => {
        const detections = [{ className: 'car' }];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('v0.3.138: returns FALSE when the only face is already labeled by Scrypted (trust the matcher)', () => {
        const detections = [
            { className: 'person' },
            { className: 'face', label: 'Alex' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('v0.3.137: returns FALSE on person-only detection (no face means LLM-ID has nothing to do)', () => {
        // v0.3.130 broadened the gate to ANY person detection because operator
        // observed Scrypted often missed the face sub-detection. v0.3.136
        // FaceID-Probe instrumented production for 24h; data (132 samples)
        // showed unlabeled `face` entries DO reach the detections array at
        // top level whenever a face is actually visible. The 50% of events
        // that are person-only have no face geometry — running LLM-ID on
        // them was wasted compute. v0.3.137 narrows back to face-only.
        const detections = [{ className: 'person' }];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('v0.3.138: returns FALSE on person + labeled face (Scrypted ID is trusted)', () => {
        const detections = [
            { className: 'person' },
            { className: 'face', label: 'Blake' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('returns true when person + face WITHOUT label and score >= 0.7', () => {
        const detections = [
            { className: 'person' },
            { className: 'face', score: 0.85 },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(true);
    });

    it('returns true on person + low-score face — face-score gate has not applied since v0.3.130', () => {
        // Pre-v0.3.130: face score < 0.7 → return false.
        // v0.3.130-v0.3.136: any person detection fires LLM-ID.
        // v0.3.137: face-only gate; score is not a factor at this layer.
        const detections = [
            { className: 'person' },
            { className: 'face', score: 0.4 },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(true);
    });

    it('returns true when face has no score field (defaults to eligible)', () => {
        const detections = [
            { className: 'person' },
            { className: 'face' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(true);
    });

    it('returns true on a standalone face detection (no person sibling)', () => {
        // Scrypted can emit a face detection without an enclosing person
        // detection (e.g., NVR face-match event). face-only gate fires here.
        expect(shouldLoadReferenceImages(true, [{ className: 'face' }])).toBe(true);
    });

    it('handles empty detections array', () => {
        expect(shouldLoadReferenceImages(true, [])).toBe(false);
    });

    it('handles undefined detections', () => {
        expect(shouldLoadReferenceImages(true, undefined as any)).toBe(false);
    });

    it('handles null detections', () => {
        expect(shouldLoadReferenceImages(true, null as any)).toBe(false);
    });

    it('v0.3.138: returns FALSE on 2 persons + 1 labeled face (only labeled faces present)', () => {
        // Scrypted matched 1 person; the 2nd person has no face entry at all
        // (face not visible). v0.3.138 trusts Scrypted's label and skips
        // the ref-photo load. If the 2nd person had a visible-but-unmatched
        // face, an unlabeled face entry would be present and the gate would
        // fire (see the mixed-labels test below).
        const detections = [
            { className: 'person' },
            { className: 'person' },
            { className: 'face', label: 'Alex' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('returns true when 2 persons + 1 labeled face + 1 unlabeled face with high score', () => {
        const detections = [
            { className: 'person' },
            { className: 'person' },
            { className: 'face', label: 'Alex' },
            { className: 'face', score: 0.9 },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(true);
    });

    it('v0.3.138: returns FALSE when all faces are labeled by Scrypted', () => {
        // v0.3.130-v0.3.137 fired LLM-ID even when Scrypted labeled
        // everyone, as a verification pass against matcher false-positives.
        // v0.3.138 drops that under operator decision (2026-05-25) due to
        // mlx_vlm.server burst-overload — labeled faces are now trusted.
        // 'Maybe: <Name>' in upstream Scrypted notification text gives
        // operator a low-confidence signal even without LLM verification.
        const detections = [
            { className: 'person' },
            { className: 'person' },
            { className: 'face', label: 'Alex' },
            { className: 'face', label: 'Blake' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('v0.3.138: returns true when mixed labels (Scrypted labeled some but missed others)', () => {
        // Multi-person scene where Scrypted's matcher caught Alex but
        // missed Blake (face visible, no label). LLM-ID must still attempt
        // the missing one — the labeled face acts as a known-not-the-target.
        const detections = [
            { className: 'person' },
            { className: 'person' },
            { className: 'face', label: 'Alex' },
            { className: 'face' /* unlabeled */ },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(true);
    });
});

describe('shouldCurateReference', () => {
    const jpegUrl = 'data:image/jpeg;base64,/9j/abc123';

    it('returns false when feature disabled', () => {
        expect(shouldCurateReference(false, ['Alex'], 7, jpegUrl)).toBe(false);
    });

    it('returns false when names is empty', () => {
        expect(shouldCurateReference(true, [], 7, jpegUrl)).toBe(false);
    });

    it('returns false when clarity < 5', () => {
        expect(shouldCurateReference(true, ['Alex'], 4, jpegUrl)).toBe(false);
    });

    it('returns false when clarity is null', () => {
        expect(shouldCurateReference(true, ['Alex'], null as any, jpegUrl)).toBe(false);
    });

    it('returns false when clarity is undefined', () => {
        expect(shouldCurateReference(true, ['Alex'], undefined as any, jpegUrl)).toBe(false);
    });

    it('returns false when imageUrl is not JPEG data URL', () => {
        expect(shouldCurateReference(true, ['Alex'], 7, 'https://example.com/img.jpg')).toBe(false);
        expect(shouldCurateReference(true, ['Alex'], 7, 'data:image/png;base64,abc')).toBe(false);
        expect(shouldCurateReference(true, ['Alex'], 7, undefined as any)).toBe(false);
    });

    it('returns true when all conditions met', () => {
        expect(shouldCurateReference(true, ['Alex'], 7, jpegUrl)).toBe(true);
    });

    it('returns true when clarity is exactly 5', () => {
        expect(shouldCurateReference(true, ['Alex'], 5, jpegUrl)).toBe(true);
    });

    // faceReferenceQuality-based gating
    const goodFaceRef = { score: 8, frontFacing: true, unobstructed: true, singleSubject: true };

    it('returns true when faceRef passes all checks', () => {
        expect(shouldCurateReference(true, ['Alex'], undefined, jpegUrl, goodFaceRef)).toBe(true);
    });

    it('rejects when faceRef.frontFacing is false', () => {
        expect(shouldCurateReference(true, ['Alex'], undefined, jpegUrl,
            { ...goodFaceRef, frontFacing: false })).toBe(false);
    });

    it('rejects when faceRef.unobstructed is false', () => {
        expect(shouldCurateReference(true, ['Alex'], undefined, jpegUrl,
            { ...goodFaceRef, unobstructed: false })).toBe(false);
    });

    it('rejects when faceRef.score < 7', () => {
        expect(shouldCurateReference(true, ['Alex'], undefined, jpegUrl,
            { ...goodFaceRef, score: 6 })).toBe(false);
    });

    it('accepts when faceRef.score is exactly 7', () => {
        expect(shouldCurateReference(true, ['Alex'], undefined, jpegUrl,
            { ...goodFaceRef, score: 7 })).toBe(true);
    });

    it('accepts when singleSubject is false (soft signal)', () => {
        expect(shouldCurateReference(true, ['Alex'], undefined, jpegUrl,
            { ...goodFaceRef, singleSubject: false })).toBe(true);
    });

    it('falls back to clarity when faceRef is null', () => {
        expect(shouldCurateReference(true, ['Alex'], 7, jpegUrl, null)).toBe(true);
        expect(shouldCurateReference(true, ['Alex'], 4, jpegUrl, null)).toBe(false);
    });

    it('falls back to clarity when faceRef is undefined', () => {
        expect(shouldCurateReference(true, ['Alex'], 7, jpegUrl, undefined)).toBe(true);
    });
});


describe('createMessageTemplate identifiedPersons confidence and prompt', () => {
    it('includes identifiedPersons with confidence in schema when referenceImages provided', () => {
        const refs = new Map([['Alex', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPersons).toBeDefined();
        const arrayVariant = schema.properties.identifiedPersons.anyOf.find((v: any) => v.type === 'array');
        expect(arrayVariant.items.properties.confidence).toBeDefined();
        expect(schema.required).toContain('identifiedPersons');
    });

    it('does not include identifiedPersons without referenceImages', () => {
        const result = createMessageTemplate('prompt', ['img'], {});
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPersons).toBeUndefined();
    });

    it('prompt mentions confidence scale for identification', () => {
        const refs = new Map([['Alex', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const systemMsg = result.messages[0].content;
        expect(systemMsg).toContain('Confidence scale');
        expect(systemMsg).toMatch(/far|distant/i);
    });

    // Obsolete as of v0.3.78: the strict "must clearly see face, NEVER
    // sufficient" policy these tests pinned was reversed after 20 real
    // gallery samples showed the MoE declining ~5/11 names Scrypted had
    // confidently labeled. The new policy (trust Scrypted's Maybe ID unless
    // clear mismatch) is pinned by tests/prompt-compliance.test.ts.
});

describe('callLlm with identifiedPersonConfidence', () => {
    const mockConsole = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    beforeEach(() => jest.clearAllMocks());

    it('extracts identifiedPersonConfidence from response', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'Person at Door', subtitle: 'Front Door', body: 'Adult approaching',
                            detailedDescription: 'A person walks up.',
                            clarity: { score: 7, reason: 'clear' },
                            identifiedPerson: 'Alex',
                            identifiedPersonConfidence: 8,
                        }),
                    },
                }],
            }),
        };
        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPersonConfidence).toBe(8);
    });

    it('defaults identifiedPersonConfidence to null when missing', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'T', subtitle: 'S', body: 'B',
                            detailedDescription: 'D',
                            clarity: { score: 5, reason: 'ok' },
                        }),
                    },
                }],
            }),
        };
        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPersonConfidence).toBeNull();
    });
});

// ============================================================================
// Step 2: Multi-person LLM schema + extraction
// ============================================================================

describe('createMessageTemplate with identifiedPersons (multi-person)', () => {
    it('includes identifiedPersons array schema when referenceImages provided', () => {
        const refs = new Map([['Alex', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPersons).toBeDefined();
        // Uses anyOf for cross-provider compatibility (OpenAI strict mode requires anyOf, not type array)
        const anyOf = schema.properties.identifiedPersons.anyOf;
        expect(anyOf).toHaveLength(2);
        const arrayVariant = anyOf.find((v: any) => v.type === 'array');
        const nullVariant = anyOf.find((v: any) => v.type === 'null');
        expect(arrayVariant).toBeDefined();
        expect(nullVariant).toBeDefined();
        expect(arrayVariant.items.type).toBe('object');
        expect(arrayVariant.items.properties.name).toBeDefined();
        expect(arrayVariant.items.properties.confidence).toBeDefined();
        expect(schema.required).toContain('identifiedPersons');
    });

    it('does NOT include identifiedPersons without referenceImages', () => {
        const result = createMessageTemplate('prompt', ['img'], {});
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPersons).toBeUndefined();
    });

    it('no longer includes singular identifiedPerson in schema', () => {
        const refs = new Map([['Alex', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPerson).toBeUndefined();
        expect(schema.properties.identifiedPersonConfidence).toBeUndefined();
    });

    it('prompt mentions MULTIPLE people identification', () => {
        const refs = new Map([['Alex', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const systemMsg = result.messages[0].content as string;
        expect(systemMsg).toMatch(/MULTIPLE|multiple/);
        expect(systemMsg).toContain('identifiedPersons');
    });
});

describe('callLlm with identifiedPersons (multi-person)', () => {
    const mockConsole = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    beforeEach(() => jest.clearAllMocks());

    it('extracts array of identifiedPersons from response', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'People at Door', subtitle: 'Front Door', body: 'Two people approaching',
                            detailedDescription: 'Two people walk up.',
                            clarity: { score: 7, reason: 'clear' },
                            identifiedPersons: [
                                { name: 'Alex', confidence: 8 },
                                { name: 'Blake', confidence: 7 },
                            ],
                        }),
                    },
                }],
            }),
        };
        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPersons).toEqual([
            { name: 'Alex', confidence: 8 },
            { name: 'Blake', confidence: 7 },
        ]);
    });

    it('returns null when identifiedPersons is null', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'T', subtitle: 'S', body: 'B',
                            detailedDescription: 'D',
                            clarity: { score: 5, reason: 'ok' },
                            identifiedPersons: null,
                        }),
                    },
                }],
            }),
        };
        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPersons).toBeNull();
    });

    it('backward compat: converts legacy identifiedPerson to identifiedPersons array', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'T', subtitle: 'S', body: 'B',
                            detailedDescription: 'D',
                            clarity: { score: 7, reason: 'clear' },
                            identifiedPerson: 'Alex',
                            identifiedPersonConfidence: 8,
                        }),
                    },
                }],
            }),
        };
        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPersons).toEqual([{ name: 'Alex', confidence: 8 }]);
    });

    it('backward compat: returns null for legacy null identifiedPerson', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'T', subtitle: 'S', body: 'B',
                            detailedDescription: 'D',
                            clarity: { score: 5, reason: 'ok' },
                            identifiedPerson: null,
                            identifiedPersonConfidence: null,
                        }),
                    },
                }],
            }),
        };
        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPersons).toBeNull();
    });
});

// ============================================================================
// Step 3: filterAcceptedPersons + mergeIdentifiedPersons
// ============================================================================

describe('filterAcceptedPersons', () => {
    const THRESHOLD = 7;

    it('filters persons by confidence threshold', () => {
        const persons = [
            { name: 'Alex', confidence: 8 },
            { name: 'Blake', confidence: 5 },
        ];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual(['Alex']);
    });

    it('returns empty array for null input', () => {
        expect(filterAcceptedPersons(null, THRESHOLD)).toEqual([]);
    });

    it('returns empty array for undefined input', () => {
        expect(filterAcceptedPersons(undefined, THRESHOLD)).toEqual([]);
    });

    it('rejects NaN confidence', () => {
        const persons = [{ name: 'Alex', confidence: NaN }];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual([]);
    });

    it('rejects empty name', () => {
        const persons = [{ name: '', confidence: 9 }];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual([]);
    });

    it('accepts exactly at threshold', () => {
        const persons = [{ name: 'Alex', confidence: 7 }];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual(['Alex']);
    });

    it('returns multiple accepted persons', () => {
        const persons = [
            { name: 'Alex', confidence: 9 },
            { name: 'Blake', confidence: 8 },
        ];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual(['Alex', 'Blake']);
    });
});

describe('mergeIdentifiedPersons', () => {
    it('deduplicates names already in base list', () => {
        expect(mergeIdentifiedPersons(['Alex'], ['Alex'])).toEqual(['Alex']);
    });

    it('appends new names', () => {
        expect(mergeIdentifiedPersons(['Alex'], ['Blake'])).toEqual(['Alex', 'Blake']);
    });

    it('merges multiple new names', () => {
        expect(mergeIdentifiedPersons([], ['Alex', 'Blake'])).toEqual(['Alex', 'Blake']);
    });

    it('returns copy of base when identifiedNames is empty', () => {
        const base = ['Alex'];
        const result = mergeIdentifiedPersons(base, []);
        expect(result).toEqual(['Alex']);
        expect(result).not.toBe(base);
    });

    it('handles both arrays empty', () => {
        expect(mergeIdentifiedPersons([], [])).toEqual([]);
    });
});

// ============================================================================
// Step 4: buildNameBadges
// ============================================================================

describe('buildNameBadges', () => {
    it('returns single green badge for Scrypted-only name', () => {
        const result = buildNameBadges(['Alex'], undefined);
        expect(result).toEqual([{ label: 'Alex', cssClass: 'name-scrypted', icon: '\uD83D\uDC64' }]);
    });

    it('returns single teal badge for LLM-only name', () => {
        const result = buildNameBadges([], ['Blake']);
        expect(result).toEqual([{ label: 'Blake', cssClass: 'name-llm', icon: '\u2728' }]);
    });

    it('returns single purple badge for name in both', () => {
        const result = buildNameBadges(['Alex'], ['Alex']);
        expect(result).toEqual([{ label: 'Alex', cssClass: 'name-both', icon: '\uD83D\uDC64\u2728' }]);
    });

    it('returns two badges for two different people (one Scrypted, one LLM)', () => {
        const result = buildNameBadges(['Alex'], ['Blake']);
        expect(result).toHaveLength(2);
        expect(result).toContainEqual({ label: 'Alex', cssClass: 'name-scrypted', icon: '\uD83D\uDC64' });
        expect(result).toContainEqual({ label: 'Blake', cssClass: 'name-llm', icon: '\u2728' });
    });

    it('returns empty array when no names', () => {
        expect(buildNameBadges([], undefined)).toEqual([]);
        expect(buildNameBadges([], [])).toEqual([]);
        expect(buildNameBadges(undefined, undefined)).toEqual([]);
    });

    it('handles backward-compat llmIdentifiedName singular string', () => {
        const result = buildNameBadges([], undefined, 'Alex');
        expect(result).toEqual([{ label: 'Alex', cssClass: 'name-llm', icon: '\u2728' }]);
    });

    it('prefers llmIdentifiedNames array over singular llmIdentifiedName', () => {
        const result = buildNameBadges([], ['Blake'], 'Alex');
        expect(result).toEqual([{ label: 'Blake', cssClass: 'name-llm', icon: '\u2728' }]);
    });

    it('handles mixed: 2 Scrypted + 1 LLM with overlap', () => {
        const result = buildNameBadges(['Alex', 'Blake'], ['Alex']);
        expect(result).toHaveLength(2);
        expect(result).toContainEqual({ label: 'Alex', cssClass: 'name-both', icon: '\uD83D\uDC64\u2728' });
        expect(result).toContainEqual({ label: 'Blake', cssClass: 'name-scrypted', icon: '\uD83D\uDC64' });
    });
});

// ============================================================================
// processFullFrame
// ============================================================================

describe('processFullFrame', () => {
    function makeJpeg(width: number, height: number): Buffer {
        const jpeg = require('jpeg-js');
        const data = Buffer.alloc(width * height * 4, 128); // grey pixels
        return Buffer.from(jpeg.encode({ data, width, height }, 50).data);
    }

    const mockConsole = { warn: jest.fn() };

    beforeEach(() => {
        mockConsole.warn.mockClear();
    });

    test('returns base64 data URL for valid JPEG buffer', async () => {
        const jpeg = makeJpeg(640, 360);
        const result = await processFullFrame(jpeg, mockConsole);
        expect(result).toBeDefined();
        expect(result).toMatch(/^data:image\/jpeg;base64,/);
    });

    test('throws on invalid buffer (no retry with broken data)', async () => {
        const broken = Buffer.from([0x00, 0x01, 0x02]);
        await expect(processFullFrame(broken, mockConsole)).rejects.toThrow();
    });
});

describe('buildStoredNotification', () => {
    it('uses detectionEpoch as timestamp, not current time', () => {
        const detectionEpoch = Date.now() - 15000; // 15 seconds ago (simulates LLM delay)
        const result = buildStoredNotification({
            id: 'det-abc',
            detectionEpoch,
            cameraId: 'cam-1',
            cameraName: 'Front Door',
            detectionType: 'person',
            names: ['Alice'],
            enriched: {
                title: 'Person Detected',
                subtitle: 'Front Door',
                body: 'Alice at the door',
            },
            hasPoster: true,
        });

        expect(result.timestamp).toBe(detectionEpoch);
        expect(result.id).toBe('det-abc');
        expect(result.cameraId).toBe('cam-1');
        expect(result.llmTitle).toBe('Person Detected');
        expect(result.hasPoster).toBe(true);
    });

    it('includes optional fields when provided', () => {
        const detectionEpoch = Date.now();
        const result = buildStoredNotification({
            id: 'det-xyz',
            detectionEpoch,
            cameraId: 'cam-2',
            cameraName: 'Backyard',
            detectionType: 'animal',
            names: [],
            enriched: {
                title: 'Animal',
                subtitle: 'Backyard',
                body: 'Cat spotted',
                detailedDescription: 'Orange tabby near fence',
                clarity: { score: 8, reason: 'clear' },
            },
            hasPoster: false,
            llmIdentifiedNames: ['Whiskers'],
        });

        expect(result.timestamp).toBe(detectionEpoch);
        expect(result.detailedDescription).toBe('Orange tabby near fence');
        expect(result.clarity).toEqual({ score: 8, reason: 'clear' });
        expect(result.llmIdentifiedNames).toEqual(['Whiskers']);
    });

    it('omits llmIdentifiedNames when not provided', () => {
        const result = buildStoredNotification({
            id: 'det-none',
            detectionEpoch: Date.now(),
            cameraId: 'cam-1',
            cameraName: 'Garage',
            detectionType: 'vehicle',
            names: [],
            enriched: { title: 'Car', subtitle: 'Garage', body: 'Vehicle detected' },
            hasPoster: false,
        });

        expect(result.llmIdentifiedNames).toBeUndefined();
    });
});

describe('cropJpeg', () => {
    function makeJpeg(width: number, height: number): Buffer {
        const jpegLib = require('jpeg-js');
        // Create a gradient so we can verify crop region
        const data = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                data[i] = Math.round((x / width) * 255);     // R = x gradient
                data[i + 1] = Math.round((y / height) * 255); // G = y gradient
                data[i + 2] = 0;
                data[i + 3] = 255;
            }
        }
        return Buffer.from(jpegLib.encode({ data, width, height }, 90).data);
    }

    it('crops to the specified pixel bbox region', () => {
        const input = makeJpeg(100, 100);
        // Crop center 50x50 with no padding
        const cropped = cropJpeg(input, [25, 25, 50, 50], 0);
        const jpegLib = require('jpeg-js');
        const { width, height } = jpegLib.decode(cropped);
        expect(width).toBe(50);
        expect(height).toBe(50);
    });

    it('applies padding around the face bbox', () => {
        const input = makeJpeg(200, 200);
        // Face at center: [80, 80, 40, 40] = 40x40px
        // With 0.5 padding: expand by 50% of face size each side = 20px each side
        // Result: 80x80px
        const cropped = cropJpeg(input, [80, 80, 40, 40], 0.5);
        const jpegLib = require('jpeg-js');
        const { width, height } = jpegLib.decode(cropped);
        expect(width).toBe(80);
        expect(height).toBe(80);
    });

    it('clamps to image bounds when padding exceeds edges', () => {
        const input = makeJpeg(100, 100);
        // Face at top-left corner with large padding
        const cropped = cropJpeg(input, [0, 0, 20, 20], 1.0);
        const jpegLib = require('jpeg-js');
        const { width, height } = jpegLib.decode(cropped);
        // Should not exceed image bounds
        expect(width).toBeLessThanOrEqual(100);
        expect(height).toBeLessThanOrEqual(100);
        expect(width).toBeGreaterThan(20); // padded beyond face
    });

    it('returns valid JPEG buffer', () => {
        const input = makeJpeg(100, 100);
        const cropped = cropJpeg(input, [10, 10, 30, 30], 0.3);
        // JPEG magic bytes
        expect(cropped[0]).toBe(0xFF);
        expect(cropped[1]).toBe(0xD8);
    });

    it('handles pixel coordinate bounding boxes (not normalized)', () => {
        const input = makeJpeg(1920, 1080);
        // Face at pixel coords: x=500, y=200, w=150, h=200
        const cropped = cropJpeg(input, [500, 200, 150, 200], 0.5);
        const jpegLib = require('jpeg-js');
        const { width, height } = jpegLib.decode(cropped);
        // With 0.5 padding: 150 + 2*75 = 300 wide, 200 + 2*100 = 400 tall
        expect(width).toBe(300);
        expect(height).toBe(400);
    });
});

describe('parseFaceReferenceQuality', () => {
    it('parses valid input', () => {
        const result = parseFaceReferenceQuality({
            score: 8, frontFacing: true, unobstructed: true, singleSubject: true,
        });
        expect(result).toEqual({
            score: 8, frontFacing: true, unobstructed: true, singleSubject: true,
        });
    });

    it('returns null for null input', () => {
        expect(parseFaceReferenceQuality(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(parseFaceReferenceQuality(undefined)).toBeNull();
    });

    it('clamps score to 1-10 range', () => {
        const result = parseFaceReferenceQuality({
            score: 15, frontFacing: true, unobstructed: false, singleSubject: true,
        });
        expect(result!.score).toBe(10);
    });

    it('returns null for invalid structure (missing fields)', () => {
        const mockConsole = { warn: jest.fn() };
        const result = parseFaceReferenceQuality({ score: 5 }, mockConsole);
        expect(result).toBeNull();
        expect(mockConsole.warn).toHaveBeenCalled();
    });

    it('returns null when score is not a number', () => {
        const result = parseFaceReferenceQuality({
            score: 'high', frontFacing: true, unobstructed: true, singleSubject: true,
        });
        expect(result).toBeNull();
    });
});

describe('extractFaceBoundingBox', () => {
    it('returns boundingBox for matching labeled face', () => {
        const detections = [
            { className: 'person', boundingBox: [0.1, 0.1, 0.8, 0.9] },
            { className: 'face', label: 'Alex', score: 0.95, boundingBox: [0.3, 0.2, 0.15, 0.2] },
        ];
        expect(extractFaceBoundingBox(detections, 'Alex')).toEqual([0.3, 0.2, 0.15, 0.2]);
    });

    it('returns undefined when name does not match', () => {
        const detections = [
            { className: 'face', label: 'Blake', score: 0.9, boundingBox: [0.3, 0.2, 0.15, 0.2] },
        ];
        expect(extractFaceBoundingBox(detections, 'Alex')).toBeUndefined();
    });

    it('returns undefined when detection has no boundingBox', () => {
        const detections = [
            { className: 'face', label: 'Alex', score: 0.9 },
        ];
        expect(extractFaceBoundingBox(detections, 'Alex')).toBeUndefined();
    });

    it('returns undefined for empty detections', () => {
        expect(extractFaceBoundingBox([], 'Alex')).toBeUndefined();
    });

    it('ignores non-face detections even with matching label', () => {
        const detections = [
            { className: 'person', label: 'Alex', boundingBox: [0.1, 0.1, 0.8, 0.9] },
        ];
        expect(extractFaceBoundingBox(detections, 'Alex')).toBeUndefined();
    });

    it('returns undefined when face bbox is too small (< minSize pixels)', () => {
        const detections = [
            { className: 'face', label: 'Alex', boundingBox: [400, 400, 20, 25] },
        ];
        // With minSize=50, a 20x25 face is too small
        expect(extractFaceBoundingBox(detections, 'Alex', 50)).toBeUndefined();
    });

    it('returns bbox when face meets minimum size', () => {
        const detections = [
            { className: 'face', label: 'Alex', boundingBox: [300, 300, 100, 120] },
        ];
        expect(extractFaceBoundingBox(detections, 'Alex', 50)).toEqual([300, 300, 100, 120]);
    });
});

describe('buildPerEventClickData', () => {
    const notifId = 'det-abc-123';

    it('returns existing data unchanged when disabled', () => {
        const data = { ha: { url: '/camera/1', clickAction: '/camera/1' } };
        const out = buildPerEventClickData(data, '@scrypted/homeassistant', notifId, { enabled: false });
        expect(out).toBe(data);
    });

    it('returns existing data unchanged when HA notifier but no haDailyBriefPath', () => {
        const data = { ha: { url: '/camera/1', clickAction: '/camera/1' } };
        const out = buildPerEventClickData(data, '@scrypted/homeassistant', notifId, { enabled: true });
        expect(out).toBe(data);
    });

    it('HA: overrides data.ha.url and data.ha.clickAction with haDailyBriefPath?id=<notifId>', () => {
        const data = { ha: { url: '/camera/1', clickAction: '/camera/1', message: 'old' } };
        const out = buildPerEventClickData(data, '@scrypted/homeassistant', notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
        });
        expect(out).not.toBe(data);
        expect(out.ha.url).toBe('/daily-brief/0?id=det-abc-123');
        expect(out.ha.clickAction).toBe('/daily-brief/0?id=det-abc-123');
        // Other data.ha keys preserved
        expect(out.ha.message).toBe('old');
    });

    it('HA: appends id with & when haDailyBriefPath already contains ?', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: true,
            haDailyBriefPath: '/lovelace/dash?foo=bar',
        });
        expect(out.ha.url).toBe('/lovelace/dash?foo=bar&id=det-abc-123');
    });

    it('HA: creates data.ha when input has no ha key', () => {
        const out = buildPerEventClickData(undefined, '@scrypted/homeassistant', notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
        });
        expect(out.ha.url).toBe('/daily-brief/0?id=det-abc-123');
        expect(out.ha.clickAction).toBe('/daily-brief/0?id=det-abc-123');
    });

    it('non-HA notifier: returns existing data unchanged (HA-only feature)', () => {
        const data = { url: '/camera/1' };
        const out = buildPerEventClickData(data, '@scrypted/core', notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
        });
        expect(out).toBe(data);
    });

    it('unknown pluginId: returns existing data unchanged', () => {
        const data = { hash: '#/timeline/123' };
        const out = buildPerEventClickData(data, undefined, notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
        });
        expect(out).toBe(data);
    });

    it('encodes notification id (query-safe)', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', 'id with spaces & sym=bol', {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
        });
        expect(out.ha.url).toBe('/daily-brief/0?id=id%20with%20spaces%20%26%20sym%3Dbol');
    });

    it('never mutates the caller\'s data object (HA path)', () => {
        const original = { ha: { url: '/camera/1', clickAction: '/camera/1', foo: 'bar' }, other: 'keep' };
        const snapshot = JSON.parse(JSON.stringify(original));
        const out = buildPerEventClickData(original, '@scrypted/homeassistant', notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
        });
        // Original must be unchanged — the returned object is a fresh copy.
        expect(original).toEqual(snapshot);
        expect(out).not.toBe(original);
        expect(out.ha).not.toBe(original.ha);
    });

});

// v0.3.163: per-event tap can route to the in-HA iframed Scrypted NVR timeline
// dashboard (haNvrTimelinePath), mirroring the Story path's rung 2. Preferred
// over the upstream direct Scrypted deep link, which fails in HA's WKWebView
// (WebKitErrorDomain Code 102 "Frame load interrupted").
describe('buildPerEventClickData — NVR timeline rung', () => {
    const notifId = 'det-abc-123';
    const cam = 'cam-42';

    it('HA: routes to haNvrTimelinePath?camera=<cam>&time=<ms> when cameraId + eventTimeMs present', () => {
        const data = { ha: { url: '/scrypted_x?url=old', clickAction: '/scrypted_x?url=old', message: 'old' } };
        const out = buildPerEventClickData(data, '@scrypted/homeassistant', notifId, {
            enabled: false,
            haNvrTimelinePath: '/scrypted',
            cameraId: cam,
            eventTimeMs: 1710000000000,
        });
        expect(out).not.toBe(data);
        expect(out.ha.url).toBe('/scrypted?camera=cam-42&time=1710000000000');
        expect(out.ha.clickAction).toBe('/scrypted?camera=cam-42&time=1710000000000');
        // Other data.ha keys preserved
        expect(out.ha.message).toBe('old');
    });

    it('fires even when enablePerEventBriefClick (enabled) is false — haNvrTimelinePath is its own opt-in', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: false,
            haNvrTimelinePath: '/lovelace/scrypted/0',
            cameraId: cam,
            eventTimeMs: 42,
        });
        expect(out.ha.url).toBe('/lovelace/scrypted/0?camera=cam-42&time=42');
    });

    it('WINS over the Daily Brief gallery rung when both are configured', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
            haNvrTimelinePath: '/scrypted',
            cameraId: cam,
            eventTimeMs: 99,
        });
        expect(out.ha.url).toBe('/scrypted?camera=cam-42&time=99');
    });

    it('appends camera/time with & when haNvrTimelinePath already contains ?', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: false,
            haNvrTimelinePath: '/lovelace/dash?view=nvr',
            cameraId: cam,
            eventTimeMs: 7,
        });
        expect(out.ha.url).toBe('/lovelace/dash?view=nvr&camera=cam-42&time=7');
    });

    it('encodes the camera id (query-safe)', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: false,
            haNvrTimelinePath: '/scrypted',
            cameraId: 'cam/weird id',
            eventTimeMs: 5,
        });
        expect(out.ha.url).toBe('/scrypted?camera=cam%2Fweird%20id&time=5');
    });

    it('accepts eventTimeMs of 0 (epoch) — number check, not truthiness', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: false,
            haNvrTimelinePath: '/scrypted',
            cameraId: cam,
            eventTimeMs: 0,
        });
        expect(out.ha.url).toBe('/scrypted?camera=cam-42&time=0');
    });

    it('falls through to the gallery rung when haNvrTimelinePath is set but cameraId is missing', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
            haNvrTimelinePath: '/scrypted',
            cameraId: undefined,
            eventTimeMs: 5,
        });
        expect(out.ha.url).toBe('/daily-brief/0?id=det-abc-123');
    });

    it('falls through to the gallery rung when haNvrTimelinePath is set but eventTimeMs is missing', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
            haNvrTimelinePath: '/scrypted',
            cameraId: cam,
            eventTimeMs: undefined,
        });
        expect(out.ha.url).toBe('/daily-brief/0?id=det-abc-123');
    });

    it('ignores a blank/whitespace haNvrTimelinePath (falls through to gallery)', () => {
        const out = buildPerEventClickData({}, '@scrypted/homeassistant', notifId, {
            enabled: true,
            haDailyBriefPath: '/daily-brief/0',
            haNvrTimelinePath: '   ',
            cameraId: cam,
            eventTimeMs: 5,
        });
        expect(out.ha.url).toBe('/daily-brief/0?id=det-abc-123');
    });

    it('no-op when NVR rung unavailable, gallery disabled, and no daily-brief path', () => {
        const data = { ha: { url: '/scrypted_x', clickAction: '/scrypted_x' } };
        const out = buildPerEventClickData(data, '@scrypted/homeassistant', notifId, {
            enabled: false,
            haNvrTimelinePath: '   ',
            cameraId: cam,
            eventTimeMs: 5,
        });
        expect(out).toBe(data);
    });

    it('non-HA notifier: no NVR override even with haNvrTimelinePath', () => {
        const data = { url: '/camera/1' };
        const out = buildPerEventClickData(data, '@scrypted/core', notifId, {
            enabled: false,
            haNvrTimelinePath: '/scrypted',
            cameraId: cam,
            eventTimeMs: 5,
        });
        expect(out).toBe(data);
    });

    it('never mutates the caller\'s data object (NVR path)', () => {
        const original = { ha: { url: '/camera/1', foo: 'bar' }, other: 'keep' };
        const snapshot = JSON.parse(JSON.stringify(original));
        const out = buildPerEventClickData(original, '@scrypted/homeassistant', notifId, {
            enabled: false,
            haNvrTimelinePath: '/scrypted',
            cameraId: cam,
            eventTimeMs: 5,
        });
        expect(original).toEqual(snapshot);
        expect(out).not.toBe(original);
        expect(out.ha).not.toBe(original.ha);
    });
});

// Issue #9: iOS HA companion app received group-notification URLs from the
// upstream Scrypted plugin where the first separator after the path was `&`
// instead of `?`. WKWebView interprets `/scrypted_<hash>&url=...` as part of
// the path (no query) and aborts the load with WebKitErrorDomain Code 102.
describe('normalizeNotificationClickUrl', () => {
    it('replaces first & with ? when no ? precedes it (URL shape from issue #9)', () => {
        // Values are SYNTHETIC. This package is published publicly, so no real
        // Scrypted access token, serverId or camera id may appear here — the
        // assertion is about the separator fix, so the values are irrelevant to
        // what is being tested. Only the URL SHAPE matters.
        const TOKEN = '0123456789abcdef0123456789abcdef';
        const SERVER = 'deadbeef00000000';
        const tail = `/endpoint/@scrypted/nvr/public/#/timeline/100?time=1700000000000&from=notification&serverId=${SERVER}&disableTransition=true`;
        const bad = `/scrypted_${TOKEN}&url=/api/scrypted/${TOKEN}${tail}`;
        const expected = `/scrypted_${TOKEN}?url=/api/scrypted/${TOKEN}${tail}`;
        expect(normalizeNotificationClickUrl(bad)).toBe(expected);
    });

    it('replaces first & with ? in a simple path-only URL', () => {
        expect(normalizeNotificationClickUrl('/path&foo=bar')).toBe('/path?foo=bar');
    });

    it('leaves URL unchanged when ? already precedes the first &', () => {
        const url = '/path?foo=bar&baz=qux';
        expect(normalizeNotificationClickUrl(url)).toBe(url);
    });

    it('leaves URL unchanged when the only & is in the fragment', () => {
        const url = '/path#frag&foo=bar';
        expect(normalizeNotificationClickUrl(url)).toBe(url);
    });

    it('leaves URL unchanged when no & is present', () => {
        const url = '/path?foo=bar';
        expect(normalizeNotificationClickUrl(url)).toBe(url);
    });

    it('leaves URL unchanged when both ? and # precede the first &', () => {
        const url = '/path?a=1#frag&b=2';
        expect(normalizeNotificationClickUrl(url)).toBe(url);
    });

    it('leaves URL unchanged when the URL begins with a fragment containing &', () => {
        const url = '#frag&foo=bar';
        expect(normalizeNotificationClickUrl(url)).toBe(url);
    });

    it('returns input unchanged for non-string values', () => {
        expect(normalizeNotificationClickUrl(undefined)).toBe(undefined);
        expect(normalizeNotificationClickUrl(null)).toBe(null);
    });
});

describe('sanitizeHaClickUrl', () => {
    it('fixes data.ha.url and data.ha.clickAction when first separator is &', () => {
        const data = {
            ha: {
                url: '/scrypted_abc&url=/api/foo',
                clickAction: '/scrypted_abc&url=/api/foo',
            },
        };
        const out = sanitizeHaClickUrl(data);
        expect(out).not.toBe(data);
        expect(out.ha.url).toBe('/scrypted_abc?url=/api/foo');
        expect(out.ha.clickAction).toBe('/scrypted_abc?url=/api/foo');
    });

    it('returns input by reference when no change is needed (well-formed URL)', () => {
        const data = { ha: { url: '/path?id=1', clickAction: '/path?id=1' } };
        expect(sanitizeHaClickUrl(data)).toBe(data);
    });

    it('returns input by reference when data is null/undefined', () => {
        expect(sanitizeHaClickUrl(null)).toBe(null);
        expect(sanitizeHaClickUrl(undefined)).toBe(undefined);
    });

    it('returns input by reference when data has no ha key', () => {
        const data = { foo: 'bar' };
        expect(sanitizeHaClickUrl(data)).toBe(data);
    });

    it('preserves other data.ha keys (only url and clickAction are touched)', () => {
        const data = {
            ha: {
                url: '/p&q=1',
                clickAction: '/p&q=1',
                message: 'hello',
                tag: 'cam-1',
            },
            outside: 'keep',
        };
        const out = sanitizeHaClickUrl(data);
        expect(out.ha.message).toBe('hello');
        expect(out.ha.tag).toBe('cam-1');
        expect(out.outside).toBe('keep');
    });

    it('does not mutate the input data', () => {
        const data = { ha: { url: '/p&q=1', clickAction: '/p&q=1' } };
        const snapshot = JSON.parse(JSON.stringify(data));
        sanitizeHaClickUrl(data);
        expect(data).toEqual(snapshot);
    });

    it('handles ha with only url set (no clickAction)', () => {
        const data = { ha: { url: '/p&q=1' } };
        const out = sanitizeHaClickUrl(data);
        expect(out.ha.url).toBe('/p?q=1');
        expect(out.ha.clickAction).toBeUndefined();
    });
});


describe('summarizeDetectionsForFaceProbe', () => {
    it('returns "empty" for null/undefined/empty arrays', () => {
        expect(summarizeDetectionsForFaceProbe([])).toBe('empty');
        expect(summarizeDetectionsForFaceProbe(null as any)).toBe('empty');
        expect(summarizeDetectionsForFaceProbe(undefined as any)).toBe('empty');
    });

    it('summarizes a person+labeled-face event (Casey recognized)', () => {
        const s = summarizeDetectionsForFaceProbe([
            { className: 'person' },
            { className: 'face', label: 'Casey' },
        ]);
        expect(s).toBe('classes=face×1,person×1 | labels=Casey | nested-face=0');
    });

    it('summarizes a person+unlabeled-face event (target signal we want)', () => {
        const s = summarizeDetectionsForFaceProbe([
            { className: 'person' },
            { className: 'face' /* no label — matcher failed to identify */ },
        ]);
        expect(s).toBe('classes=face×1,person×1 | labels=(none) | nested-face=0');
    });

    it('summarizes a person-only event (no face emitted)', () => {
        const s = summarizeDetectionsForFaceProbe([{ className: 'person' }]);
        expect(s).toBe('classes=person×1 | labels=(no-face-entries) | nested-face=0');
    });

    it('counts multiple persons and faces with mixed labels', () => {
        const s = summarizeDetectionsForFaceProbe([
            { className: 'person' },
            { className: 'person' },
            { className: 'face', label: 'Casey' },
            { className: 'face' },
        ]);
        expect(s).toBe('classes=face×2,person×2 | labels=Casey,(none) | nested-face=0');
    });

    it('counts nested face entries inside a top-level person detection', () => {
        const s = summarizeDetectionsForFaceProbe([
            {
                className: 'person',
                detections: [
                    { className: 'face' },
                    { className: 'face', label: 'Casey' },
                ],
            },
        ]);
        expect(s).toBe('classes=person×1 | labels=(no-face-entries) | nested-face=2');
    });

    it('handles entries with missing className field', () => {
        const s = summarizeDetectionsForFaceProbe([
            { score: 0.9 },
            { className: 'person' },
        ]);
        expect(s).toMatch(/<no-className>×1/);
        expect(s).toMatch(/person×1/);
    });
});

// v0.3.164: posterBox — the VLM returns which region of the full frame its
// description centers on, so the notification poster crop matches the text.
describe('createMessageTemplate posterBox', () => {
    it('includes posterBox in the schema (anyOf object/null) + required when includePosterBox=true', () => {
        const result = createMessageTemplate('prompt', ['fullframe'], {}, undefined, true);
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.posterBox).toBeDefined();
        const anyOf = schema.properties.posterBox.anyOf;
        expect(anyOf).toHaveLength(2);
        const objVariant = anyOf.find((v: any) => v.type === 'object');
        const nullVariant = anyOf.find((v: any) => v.type === 'null');
        expect(nullVariant).toBeDefined();
        expect(objVariant.properties.x).toBeDefined();
        expect(objVariant.properties.y).toBeDefined();
        expect(objVariant.properties.width).toBeDefined();
        expect(objVariant.properties.height).toBeDefined();
        expect(objVariant.required).toEqual(['x', 'y', 'width', 'height']);
        expect(schema.required).toContain('posterBox');
    });

    it('does NOT include posterBox when includePosterBox is falsy/omitted', () => {
        const omitted = createMessageTemplate('prompt', ['img'], {});
        expect(omitted.response_format.json_schema.schema.properties.posterBox).toBeUndefined();
        expect(omitted.response_format.json_schema.schema.required).not.toContain('posterBox');

        const explicitFalse = createMessageTemplate('prompt', ['img'], {}, undefined, false);
        expect(explicitFalse.response_format.json_schema.schema.properties.posterBox).toBeUndefined();
    });

    it('prompt instructs the model on the normalized posterBox when enabled', () => {
        const result = createMessageTemplate('prompt', ['fullframe'], {}, undefined, true);
        const systemMsg = result.messages[0].content as string;
        expect(systemMsg).toMatch(/posterBox/);
        expect(systemMsg).toMatch(/normalized|fraction|0 and 1|0-1/i);
    });

    it('posterBox coexists with identifiedPersons (both conditional additions)', () => {
        const refs = new Map([['Alex', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['fullframe'], {}, refs, true);
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.posterBox).toBeDefined();
        expect(schema.properties.identifiedPersons).toBeDefined();
        expect(schema.required).toContain('posterBox');
        expect(schema.required).toContain('identifiedPersons');
    });
});

describe('callLlm posterBox extraction', () => {
    const mockConsole = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    beforeEach(() => jest.clearAllMocks());

    function providerReturning(extra: any) {
        return {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: JSON.stringify({
                    title: 'T', subtitle: 'S', body: 'B', detailedDescription: 'D',
                    clarity: { score: 7, reason: 'clear' },
                    ...extra,
                }) } }],
            }),
        };
    }

    it('extracts a valid posterBox onto the result', async () => {
        const provider = providerReturning({ posterBox: { x: 0.2, y: 0.3, width: 0.4, height: 0.25 } });
        const result = await callLlm(provider as any, {} as any, 90000, mockConsole as any);
        expect(result.posterBox).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.25 });
    });

    it('returns null posterBox when the field is missing', async () => {
        const provider = providerReturning({});
        const result = await callLlm(provider as any, {} as any, 90000, mockConsole as any);
        expect(result.posterBox).toBeNull();
    });

    it('returns null posterBox when the model returns an explicit null', async () => {
        const provider = providerReturning({ posterBox: null });
        const result = await callLlm(provider as any, {} as any, 90000, mockConsole as any);
        expect(result.posterBox).toBeNull();
    });

    it('returns null posterBox when the model returns a degenerate box', async () => {
        const provider = providerReturning({ posterBox: { x: 0.2, y: 0.3, width: 0, height: 0.25 } });
        const result = await callLlm(provider as any, {} as any, 90000, mockConsole as any);
        expect(result.posterBox).toBeNull();
    });
});
