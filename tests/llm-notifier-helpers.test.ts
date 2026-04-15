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
} from '../src/llm-notifier';
import { StoredNotification } from '../src/types';
import { collapseByGroup, getGalleryPage } from '../src/gallery';
import { cropJpeg, parseFaceReferenceQuality } from '../src/utils';
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
            { className: 'face', label: 'Richard' },
            { className: 'face', label: 'Zoia' },
            { className: 'person' },
        ];
        const result = extractDetectionData(detections, 'title', '');
        expect(result.names).toEqual(['Richard', 'Zoia']);
    });

    it('does not extract names from non-face detections', () => {
        const detections = [
            { className: 'person', label: 'SomeLabel' },
        ];
        const result = extractDetectionData(detections, 'title', '');
        expect(result.names).toEqual([]);
    });

    it('extracts Maybe: names from title and body', () => {
        const result = extractDetectionData([], 'Maybe: Richard at door', 'Maybe: Zoia nearby');
        expect(result.names).toContain('Richard');
        expect(result.names).toContain('Zoia');
    });

    it('deduplicates names from detections and Maybe: patterns', () => {
        const detections = [{ className: 'face', label: 'Richard' }];
        const result = extractDetectionData(detections, 'Maybe: Richard at door', '');
        expect(result.names).toEqual(['Richard']);
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
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('user prompt', ['detection-img'], {}, refs);

        const systemMsg = result.messages[0].content;
        expect(systemMsg).toContain('PERSON IDENTIFICATION');
        expect(systemMsg).toContain('identifiedPersons');
    });

    it('adds reference photos to user message content', () => {
        const refs = new Map([
            ['Richard', 'data:image/jpeg;base64,richard123'],
            ['Olesia', 'data:image/jpeg;base64,olesia456'],
        ]);
        const result = createMessageTemplate('prompt', ['det-img'], {}, refs);

        const userContent = result.messages[1].content as any[];
        // Should have: "Reference photos" text, "Known person: Richard", Richard image,
        // "Known person: Olesia", Olesia image, detection image, metadata text
        expect(userContent).toHaveLength(1 + 2 * 2 + 1 + 1); // 7 items

        // Check reference photo labels
        const textItems = userContent.filter((c: any) => c.type === 'text').map((c: any) => c.text);
        expect(textItems).toContain('Reference photos of known people:');
        expect(textItems).toContain('Known person: "Richard"');
        expect(textItems).toContain('Known person: "Olesia"');

        // Check reference images
        const imageItems = userContent.filter((c: any) => c.type === 'image_url');
        expect(imageItems).toHaveLength(3); // 1 detection + 2 references

        // Detection images must come BEFORE metadata text (images before text for better vision grounding)
        const detImgIdx = userContent.findIndex((c: any) => c.type === 'image_url' && c.image_url.url === 'det-img');
        const metadataIdx = userContent.findIndex((c: any) => c.type === 'text' && c.text.includes('metadata'));
        expect(detImgIdx).toBeLessThan(metadataIdx);
    });

    it('includes identifiedPersons array in JSON schema when referenceImages provided', () => {
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);

        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPersons).toBeDefined();
        expect(schema.properties.identifiedPersons.anyOf).toBeDefined();
        expect(schema.required).toContain('identifiedPersons');
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
                            identifiedPerson: 'Richard',
                        }),
                    },
                }],
            }),
        };

        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPerson).toBe('Richard');
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
        names: ['Richard'],
        llmTitle: 'Richard at Door',
        llmSubtitle: 'Front Door',
        llmBody: 'Richard approaching',
    };

    it('accepts llmIdentifiedName as optional string', () => {
        const notif: StoredNotification = { ...baseNotification, llmIdentifiedName: 'Richard' };
        expect(notif.llmIdentifiedName).toBe('Richard');
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
});

describe('shouldLoadReferenceImages', () => {
    it('returns false when feature disabled', () => {
        const detections = [{ className: 'person' }];
        expect(shouldLoadReferenceImages(false, detections)).toBe(false);
    });

    it('returns false when no person detection', () => {
        const detections = [{ className: 'car' }];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('returns false when face detection has label (already identified)', () => {
        const detections = [
            { className: 'person' },
            { className: 'face', label: 'Richard' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('returns false when person detected but no face detected (too far/small)', () => {
        const detections = [{ className: 'person' }];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('returns true when person + face WITHOUT label and score >= 0.7', () => {
        const detections = [
            { className: 'person' },
            { className: 'face', score: 0.85 },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(true);
    });

    it('returns false when person + face WITHOUT label but score < 0.7', () => {
        const detections = [
            { className: 'person' },
            { className: 'face', score: 0.4 },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('returns true when face has no score field (defaults to eligible)', () => {
        const detections = [
            { className: 'person' },
            { className: 'face' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(true);
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

    it('returns false when 2 persons + 1 labeled face but no unlabeled face', () => {
        const detections = [
            { className: 'person' },
            { className: 'person' },
            { className: 'face', label: 'Richard' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });

    it('returns true when 2 persons + 1 labeled face + 1 unlabeled face with high score', () => {
        const detections = [
            { className: 'person' },
            { className: 'person' },
            { className: 'face', label: 'Richard' },
            { className: 'face', score: 0.9 },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(true);
    });

    it('returns false when 2 persons + 2 labeled faces (all identified)', () => {
        const detections = [
            { className: 'person' },
            { className: 'person' },
            { className: 'face', label: 'Richard' },
            { className: 'face', label: 'Olesia' },
        ];
        expect(shouldLoadReferenceImages(true, detections)).toBe(false);
    });
});

describe('shouldCurateReference', () => {
    const jpegUrl = 'data:image/jpeg;base64,/9j/abc123';

    it('returns false when feature disabled', () => {
        expect(shouldCurateReference(false, ['Richard'], 7, jpegUrl)).toBe(false);
    });

    it('returns false when names is empty', () => {
        expect(shouldCurateReference(true, [], 7, jpegUrl)).toBe(false);
    });

    it('returns false when clarity < 5', () => {
        expect(shouldCurateReference(true, ['Richard'], 4, jpegUrl)).toBe(false);
    });

    it('returns false when clarity is null', () => {
        expect(shouldCurateReference(true, ['Richard'], null as any, jpegUrl)).toBe(false);
    });

    it('returns false when clarity is undefined', () => {
        expect(shouldCurateReference(true, ['Richard'], undefined as any, jpegUrl)).toBe(false);
    });

    it('returns false when imageUrl is not JPEG data URL', () => {
        expect(shouldCurateReference(true, ['Richard'], 7, 'https://example.com/img.jpg')).toBe(false);
        expect(shouldCurateReference(true, ['Richard'], 7, 'data:image/png;base64,abc')).toBe(false);
        expect(shouldCurateReference(true, ['Richard'], 7, undefined as any)).toBe(false);
    });

    it('returns true when all conditions met', () => {
        expect(shouldCurateReference(true, ['Richard'], 7, jpegUrl)).toBe(true);
    });

    it('returns true when clarity is exactly 5', () => {
        expect(shouldCurateReference(true, ['Richard'], 5, jpegUrl)).toBe(true);
    });

    // faceReferenceQuality-based gating
    const goodFaceRef = { score: 8, frontFacing: true, unobstructed: true, singleSubject: true };

    it('returns true when faceRef passes all checks', () => {
        expect(shouldCurateReference(true, ['Richard'], undefined, jpegUrl, goodFaceRef)).toBe(true);
    });

    it('rejects when faceRef.frontFacing is false', () => {
        expect(shouldCurateReference(true, ['Richard'], undefined, jpegUrl,
            { ...goodFaceRef, frontFacing: false })).toBe(false);
    });

    it('rejects when faceRef.unobstructed is false', () => {
        expect(shouldCurateReference(true, ['Richard'], undefined, jpegUrl,
            { ...goodFaceRef, unobstructed: false })).toBe(false);
    });

    it('rejects when faceRef.score < 7', () => {
        expect(shouldCurateReference(true, ['Richard'], undefined, jpegUrl,
            { ...goodFaceRef, score: 6 })).toBe(false);
    });

    it('accepts when faceRef.score is exactly 7', () => {
        expect(shouldCurateReference(true, ['Richard'], undefined, jpegUrl,
            { ...goodFaceRef, score: 7 })).toBe(true);
    });

    it('accepts when singleSubject is false (soft signal)', () => {
        expect(shouldCurateReference(true, ['Richard'], undefined, jpegUrl,
            { ...goodFaceRef, singleSubject: false })).toBe(true);
    });

    it('falls back to clarity when faceRef is null', () => {
        expect(shouldCurateReference(true, ['Richard'], 7, jpegUrl, null)).toBe(true);
        expect(shouldCurateReference(true, ['Richard'], 4, jpegUrl, null)).toBe(false);
    });

    it('falls back to clarity when faceRef is undefined', () => {
        expect(shouldCurateReference(true, ['Richard'], 7, jpegUrl, undefined)).toBe(true);
    });
});


describe('createMessageTemplate identifiedPersons confidence and prompt', () => {
    it('includes identifiedPersons with confidence in schema when referenceImages provided', () => {
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
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
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const systemMsg = result.messages[0].content;
        expect(systemMsg).toContain('Confidence scale');
        expect(systemMsg).toMatch(/far|distant/i);
    });

    it('prompt requires face visibility for identification', () => {
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const systemMsg = result.messages[0].content as string;
        expect(systemMsg).toContain('FACE');
        expect(systemMsg).toContain('face-visibility');
    });

    it('prompt rejects hair-color-only identification', () => {
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const systemMsg = result.messages[0].content as string;
        expect(systemMsg).toMatch(/hair color/i);
        expect(systemMsg).toContain('NEVER sufficient');
    });

    it('prompt prohibits names in free-text fields without face visibility', () => {
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const systemMsg = result.messages[0].content as string;
        expect(systemMsg).toMatch(/Do NOT use a person's name in title/);
        expect(systemMsg).toContain('Describe unidentified people generically');
    });
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
                            identifiedPerson: 'Richard',
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
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
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
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
        const result = createMessageTemplate('prompt', ['img'], {}, refs);
        const schema = result.response_format.json_schema.schema;
        expect(schema.properties.identifiedPerson).toBeUndefined();
        expect(schema.properties.identifiedPersonConfidence).toBeUndefined();
    });

    it('prompt mentions MULTIPLE people identification', () => {
        const refs = new Map([['Richard', 'data:image/jpeg;base64,abc']]);
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
                                { name: 'Richard', confidence: 8 },
                                { name: 'Olesia', confidence: 7 },
                            ],
                        }),
                    },
                }],
            }),
        };
        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPersons).toEqual([
            { name: 'Richard', confidence: 8 },
            { name: 'Olesia', confidence: 7 },
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
                            identifiedPerson: 'Richard',
                            identifiedPersonConfidence: 8,
                        }),
                    },
                }],
            }),
        };
        const result = await callLlm(mockProvider as any, {} as any, 90000, mockConsole as any);
        expect(result.identifiedPersons).toEqual([{ name: 'Richard', confidence: 8 }]);
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
            { name: 'Richard', confidence: 8 },
            { name: 'Olesia', confidence: 5 },
        ];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual(['Richard']);
    });

    it('returns empty array for null input', () => {
        expect(filterAcceptedPersons(null, THRESHOLD)).toEqual([]);
    });

    it('returns empty array for undefined input', () => {
        expect(filterAcceptedPersons(undefined, THRESHOLD)).toEqual([]);
    });

    it('rejects NaN confidence', () => {
        const persons = [{ name: 'Richard', confidence: NaN }];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual([]);
    });

    it('rejects empty name', () => {
        const persons = [{ name: '', confidence: 9 }];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual([]);
    });

    it('accepts exactly at threshold', () => {
        const persons = [{ name: 'Richard', confidence: 7 }];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual(['Richard']);
    });

    it('returns multiple accepted persons', () => {
        const persons = [
            { name: 'Richard', confidence: 9 },
            { name: 'Olesia', confidence: 8 },
        ];
        expect(filterAcceptedPersons(persons, THRESHOLD)).toEqual(['Richard', 'Olesia']);
    });
});

describe('mergeIdentifiedPersons', () => {
    it('deduplicates names already in base list', () => {
        expect(mergeIdentifiedPersons(['Richard'], ['Richard'])).toEqual(['Richard']);
    });

    it('appends new names', () => {
        expect(mergeIdentifiedPersons(['Richard'], ['Olesia'])).toEqual(['Richard', 'Olesia']);
    });

    it('merges multiple new names', () => {
        expect(mergeIdentifiedPersons([], ['Richard', 'Olesia'])).toEqual(['Richard', 'Olesia']);
    });

    it('returns copy of base when identifiedNames is empty', () => {
        const base = ['Richard'];
        const result = mergeIdentifiedPersons(base, []);
        expect(result).toEqual(['Richard']);
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
        const result = buildNameBadges(['Richard'], undefined);
        expect(result).toEqual([{ label: 'Richard', cssClass: 'name-scrypted', icon: '\uD83D\uDC64' }]);
    });

    it('returns single teal badge for LLM-only name', () => {
        const result = buildNameBadges([], ['Olesia']);
        expect(result).toEqual([{ label: 'Olesia', cssClass: 'name-llm', icon: '\u2728' }]);
    });

    it('returns single purple badge for name in both', () => {
        const result = buildNameBadges(['Richard'], ['Richard']);
        expect(result).toEqual([{ label: 'Richard', cssClass: 'name-both', icon: '\uD83D\uDC64\u2728' }]);
    });

    it('returns two badges for two different people (one Scrypted, one LLM)', () => {
        const result = buildNameBadges(['Richard'], ['Olesia']);
        expect(result).toHaveLength(2);
        expect(result).toContainEqual({ label: 'Richard', cssClass: 'name-scrypted', icon: '\uD83D\uDC64' });
        expect(result).toContainEqual({ label: 'Olesia', cssClass: 'name-llm', icon: '\u2728' });
    });

    it('returns empty array when no names', () => {
        expect(buildNameBadges([], undefined)).toEqual([]);
        expect(buildNameBadges([], [])).toEqual([]);
        expect(buildNameBadges(undefined, undefined)).toEqual([]);
    });

    it('handles backward-compat llmIdentifiedName singular string', () => {
        const result = buildNameBadges([], undefined, 'Richard');
        expect(result).toEqual([{ label: 'Richard', cssClass: 'name-llm', icon: '\u2728' }]);
    });

    it('prefers llmIdentifiedNames array over singular llmIdentifiedName', () => {
        const result = buildNameBadges([], ['Olesia'], 'Richard');
        expect(result).toEqual([{ label: 'Olesia', cssClass: 'name-llm', icon: '\u2728' }]);
    });

    it('handles mixed: 2 Scrypted + 1 LLM with overlap', () => {
        const result = buildNameBadges(['Richard', 'Olesia'], ['Richard']);
        expect(result).toHaveLength(2);
        expect(result).toContainEqual({ label: 'Richard', cssClass: 'name-both', icon: '\uD83D\uDC64\u2728' });
        expect(result).toContainEqual({ label: 'Olesia', cssClass: 'name-scrypted', icon: '\uD83D\uDC64' });
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
            { className: 'face', label: 'Richard', score: 0.95, boundingBox: [0.3, 0.2, 0.15, 0.2] },
        ];
        expect(extractFaceBoundingBox(detections, 'Richard')).toEqual([0.3, 0.2, 0.15, 0.2]);
    });

    it('returns undefined when name does not match', () => {
        const detections = [
            { className: 'face', label: 'Olesia', score: 0.9, boundingBox: [0.3, 0.2, 0.15, 0.2] },
        ];
        expect(extractFaceBoundingBox(detections, 'Richard')).toBeUndefined();
    });

    it('returns undefined when detection has no boundingBox', () => {
        const detections = [
            { className: 'face', label: 'Richard', score: 0.9 },
        ];
        expect(extractFaceBoundingBox(detections, 'Richard')).toBeUndefined();
    });

    it('returns undefined for empty detections', () => {
        expect(extractFaceBoundingBox([], 'Richard')).toBeUndefined();
    });

    it('ignores non-face detections even with matching label', () => {
        const detections = [
            { className: 'person', label: 'Richard', boundingBox: [0.1, 0.1, 0.8, 0.9] },
        ];
        expect(extractFaceBoundingBox(detections, 'Richard')).toBeUndefined();
    });

    it('returns undefined when face bbox is too small (< minSize pixels)', () => {
        const detections = [
            { className: 'face', label: 'Richard', boundingBox: [400, 400, 20, 25] },
        ];
        // With minSize=50, a 20x25 face is too small
        expect(extractFaceBoundingBox(detections, 'Richard', 50)).toBeUndefined();
    });

    it('returns bbox when face meets minimum size', () => {
        const detections = [
            { className: 'face', label: 'Richard', boundingBox: [300, 300, 100, 120] },
        ];
        expect(extractFaceBoundingBox(detections, 'Richard', 50)).toEqual([300, 300, 100, 120]);
    });
});
