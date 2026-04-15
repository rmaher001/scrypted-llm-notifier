/**
 * Tests for NotificationGrouper — pure functions for LLM-based notification grouping.
 * Tests buildGroupingPrompt (pure), parseGroupingResponse (pure), and
 * groupNotifications (async with DI mock).
 */

import {
    buildGroupingPrompt,
    parseGroupingResponse,
    groupNotifications,
    NotificationGroup,
} from '../src/notification-grouper';
import { BufferedNotification } from '../src/notification-buffer';

function makeBuffered(id: string, overrides?: Partial<BufferedNotification>): BufferedNotification {
    return {
        id,
        timestamp: Date.now(),
        cameraName: 'Front Door',
        title: 'Person at Door',
        subtitle: 'Front Door',
        body: 'Adult approaching',
        detailedDescription: 'A person walks up to the door.',
        ...overrides,
    };
}

describe('buildGroupingPrompt', () => {
    it('returns messages array with system and user roles', () => {
        const notifications = [makeBuffered('n1'), makeBuffered('n2')];
        const result = buildGroupingPrompt(notifications);

        expect(result.messages).toBeDefined();
        expect(result.messages.length).toBeGreaterThanOrEqual(2);
        expect(result.messages[0].role).toBe('system');
        expect(result.messages[1].role).toBe('user');
    });

    it('includes notification IDs in the user prompt', () => {
        const notifications = [
            makeBuffered('abc-123'),
            makeBuffered('def-456'),
        ];
        const result = buildGroupingPrompt(notifications);
        const userContent = result.messages[1].content;

        expect(userContent).toContain('abc-123');
        expect(userContent).toContain('def-456');
    });

    it('includes camera name, title, and detailedDescription', () => {
        const notifications = [
            makeBuffered('n1', {
                cameraName: 'Driveway',
                title: 'Person on Drive',
                detailedDescription: 'Male in blue jacket walking on driveway',
            }),
        ];
        const result = buildGroupingPrompt(notifications);
        const userContent = result.messages[1].content;

        expect(userContent).toContain('Driveway');
        expect(userContent).toContain('Person on Drive');
        expect(userContent).toContain('Male in blue jacket walking on driveway');
    });

    it('includes subtitle in the prompt line', () => {
        const notifications = [
            makeBuffered('n1', { subtitle: 'Near garage' }),
        ];
        const result = buildGroupingPrompt(notifications);
        const userContent = result.messages[1].content;

        expect(userContent).toContain('Near garage');
    });

    it('includes response_format with json_schema', () => {
        const notifications = [makeBuffered('n1')];
        const result = buildGroupingPrompt(notifications);

        expect(result.response_format).toBeDefined();
        expect(result.response_format.type).toBe('json_schema');
        expect(result.response_format.json_schema.name).toBe('grouping_response');
    });

    it('appends user prompt to system message when provided', () => {
        const notifications = [makeBuffered('n1')];
        const result = buildGroupingPrompt(notifications, 'Extra instructions here');
        const systemContent = result.messages[0].content;

        expect(systemContent).toContain('Extra instructions here');
    });
});

describe('parseGroupingResponse', () => {
    it('parses valid grouping response', () => {
        const json = JSON.stringify({
            groups: [
                {
                    notificationIds: ['abc', 'def'],
                    title: 'Person at Front',
                    subtitle: 'Front Door, Driveway',
                    body: 'Male in blue jacket moving from driveway to front door',
                },
            ],
        });

        const result = parseGroupingResponse(json);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].notificationIds).toEqual(['abc', 'def']);
        expect(result.groups[0].title).toBe('Person at Front');
    });

    it('parses multiple groups', () => {
        const json = JSON.stringify({
            groups: [
                {
                    notificationIds: ['abc', 'def'],
                    title: 'Person at Front',
                    subtitle: 'Front Door',
                    body: 'Person approaching',
                },
                {
                    notificationIds: ['ghi'],
                    title: 'Cat in Yard',
                    subtitle: 'Side Yard',
                    body: 'Orange tabby passing through',
                },
            ],
        });

        const result = parseGroupingResponse(json);
        expect(result.groups).toHaveLength(2);
    });

    it('throws on invalid JSON', () => {
        expect(() => parseGroupingResponse('not json')).toThrow();
    });

    it('throws when groups array is missing', () => {
        expect(() => parseGroupingResponse(JSON.stringify({ foo: 'bar' }))).toThrow('missing groups array');
    });

    it('throws when a group is missing required fields', () => {
        const json = JSON.stringify({
            groups: [
                { notificationIds: ['abc'], title: 'Only title' },
            ],
        });
        expect(() => parseGroupingResponse(json)).toThrow('missing required fields');
    });

    it('throws when notificationIds is empty', () => {
        const json = JSON.stringify({
            groups: [
                { notificationIds: [], title: 'T', subtitle: 'S', body: 'B' },
            ],
        });
        expect(() => parseGroupingResponse(json)).toThrow('empty notificationIds');
    });

    it('strips ```json fences from response', () => {
        const inner = JSON.stringify({
            groups: [{
                notificationIds: ['abc'],
                title: 'Fenced',
                subtitle: 'Test',
                body: 'Body text',
            }],
        });
        const fenced = '```json\n' + inner + '\n```';

        const result = parseGroupingResponse(fenced);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].title).toBe('Fenced');
    });

    it('does not truncate JSON body containing backticks', () => {
        const inner = JSON.stringify({
            groups: [{
                notificationIds: ['abc'],
                title: 'Has Backticks',
                subtitle: 'Test',
                body: 'See ```code``` for details',
            }],
        });
        const fenced = '```json\n' + inner + '\n```';

        const result = parseGroupingResponse(fenced);
        expect(result.groups[0].body).toBe('See ```code``` for details');
    });

    it('handles opening fence with no closing fence', () => {
        const inner = JSON.stringify({
            groups: [{
                notificationIds: ['abc'],
                title: 'No Close',
                subtitle: 'Test',
                body: 'Body text',
            }],
        });
        const fenced = '```json\n' + inner;

        const result = parseGroupingResponse(fenced);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].title).toBe('No Close');
    });

    it('strips plain ``` fences from response', () => {
        const inner = JSON.stringify({
            groups: [{
                notificationIds: ['abc'],
                title: 'Plain Fence',
                subtitle: 'Test',
                body: 'Body text',
            }],
        });
        const fenced = '```\n' + inner + '\n```';

        const result = parseGroupingResponse(fenced);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].title).toBe('Plain Fence');
    });
});

describe('groupNotifications', () => {
    it('returns groups from LLM response', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            groups: [{
                                notificationIds: ['n1', 'n2'],
                                title: 'Grouped Title',
                                subtitle: 'Front Door, Driveway',
                                body: 'Combined description',
                            }],
                        }),
                    },
                }],
            }),
        };

        const notifications = [makeBuffered('n1'), makeBuffered('n2')];
        const result = await groupNotifications(notifications, mockProvider);

        expect(result).toHaveLength(1);
        expect(result[0].notificationIds).toEqual(['n1', 'n2']);
        expect(result[0].title).toBe('Grouped Title');
    });

    it('calls LLM provider with built prompt', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            groups: [{
                                notificationIds: ['n1'],
                                title: 'T',
                                subtitle: 'S',
                                body: 'B',
                            }],
                        }),
                    },
                }],
            }),
        };

        const notifications = [makeBuffered('n1')];
        await groupNotifications(notifications, mockProvider);

        expect(mockProvider.getChatCompletion).toHaveBeenCalledTimes(1);
        const callArg = mockProvider.getChatCompletion.mock.calls[0][0];
        expect(callArg.messages).toBeDefined();
        expect(callArg.response_format).toBeDefined();
    });

    it('throws when LLM returns empty content', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: '' } }],
            }),
        };

        await expect(groupNotifications([makeBuffered('n1')], mockProvider))
            .rejects.toThrow('Empty response');
    });

    it('throws when LLM returns invalid JSON', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{ message: { content: 'not json' } }],
            }),
        };

        await expect(groupNotifications([makeBuffered('n1')], mockProvider))
            .rejects.toThrow();
    });

    it('throws when LLM response omits notification IDs', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            groups: [{
                                notificationIds: ['n1'],
                                title: 'T',
                                subtitle: 'S',
                                body: 'B',
                            }],
                        }),
                    },
                }],
            }),
        };

        const notifications = [makeBuffered('n1'), makeBuffered('n2'), makeBuffered('n3')];
        await expect(groupNotifications(notifications, mockProvider))
            .rejects.toThrow('omitted notification IDs');
    });

    it('throws when LLM response contains unknown notification IDs', async () => {
        const mockProvider = {
            getChatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            groups: [{
                                notificationIds: ['n1', 'unknown-id'],
                                title: 'T',
                                subtitle: 'S',
                                body: 'B',
                            }],
                        }),
                    },
                }],
            }),
        };

        const notifications = [makeBuffered('n1')];
        await expect(groupNotifications(notifications, mockProvider))
            .rejects.toThrow('Unknown notification ID');
    });
});
