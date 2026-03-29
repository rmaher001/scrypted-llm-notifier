// ============================================================================
// NotificationGrouper — Pure functions for LLM-based notification grouping
//
// No Scrypted imports. Framework-agnostic. LLM provider injected via DI.
// ============================================================================

import { BufferedNotification } from './notification-buffer';

export interface NotificationGroup {
    notificationIds: string[];
    title: string;
    subtitle: string;
    body: string;
}

export interface GroupingResult {
    groups: NotificationGroup[];
}

/**
 * Builds the text-only LLM prompt for grouping notifications.
 * Pure function — no side effects, fully testable.
 */
export function buildGroupingPrompt(
    notifications: BufferedNotification[],
    userPrompt?: string,
): { messages: { role: string; content: string }[]; response_format: any } {
    const systemPrompt = `You are a notification grouping assistant for a security camera system.
You will receive a list of recent detection notifications. Your job is to group related events
and write a single consolidated notification for each group.

RULES:
1. Group notifications that describe the SAME subject/event across cameras or timestamps
2. Do NOT group unrelated events (e.g., a person and a cat are separate groups)
3. Each group must include ALL notification IDs that belong to it
4. Every notification ID must appear in exactly ONE group
5. Write a consolidated title (max 32 chars), subtitle (max 32 chars), and body (max 75 chars)
6. The subtitle should mention which cameras were involved
7. The body should summarize the combined event description
8. Preserve person names if present — never replace a name with a generic term${userPrompt ? '\n\nAdditional instructions: ' + userPrompt : ''}`;

    // Format each notification as a numbered line
    const lines = notifications.map((n, i) => {
        const time = new Date(n.timestamp).toLocaleTimeString('en-US', { hour12: false });
        return `${i + 1}. [id:${n.id}] ${time} | ${n.cameraName} | "${n.title}" | "${n.detailedDescription || n.body}"`;
    });

    const userContent = `Group these ${notifications.length} notifications from the last window:\n\n${lines.join('\n')}`;

    return {
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'grouping_response',
                strict: true,
                schema: {
                    type: 'object',
                    properties: {
                        groups: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    notificationIds: {
                                        type: 'array',
                                        items: { type: 'string' },
                                    },
                                    title: { type: 'string' },
                                    subtitle: { type: 'string' },
                                    body: { type: 'string' },
                                },
                                required: ['notificationIds', 'title', 'subtitle', 'body'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['groups'],
                    additionalProperties: false,
                },
            },
        },
    };
}

/**
 * Parses and validates the LLM grouping response.
 * Pure function — throws on invalid input.
 */
export function parseGroupingResponse(content: string): GroupingResult {
    const json = JSON.parse(content);

    if (!json.groups || !Array.isArray(json.groups)) {
        throw new Error('Invalid grouping response: missing groups array');
    }

    for (const group of json.groups) {
        if (!group.notificationIds || !Array.isArray(group.notificationIds) || group.notificationIds.length === 0) {
            throw new Error('Invalid grouping response: empty notificationIds');
        }
        if (typeof group.title !== 'string' || typeof group.subtitle !== 'string' || typeof group.body !== 'string') {
            throw new Error('Invalid grouping response: missing required fields (title, subtitle, body)');
        }
    }

    return { groups: json.groups };
}

/**
 * Orchestrator: build prompt -> call LLM -> parse response.
 * LLM provider is injected for testability.
 */
export async function groupNotifications(
    notifications: BufferedNotification[],
    llmProvider: { getChatCompletion(messages: any): Promise<any> },
    userPrompt?: string,
): Promise<NotificationGroup[]> {
    const prompt = buildGroupingPrompt(notifications, userPrompt);
    const response = await llmProvider.getChatCompletion(prompt);

    const content = response.choices[0].message.content;
    if (!content) {
        throw new Error('Empty response from grouping LLM');
    }

    const result = parseGroupingResponse(content);

    // Validate: every buffered notification must appear in exactly one group
    const inputIds = new Set(notifications.map(n => n.id));
    const coveredIds = new Set<string>();
    for (const group of result.groups) {
        for (const id of group.notificationIds) {
            if (!inputIds.has(id)) {
                throw new Error(`Unknown notification ID in group response: ${id}`);
            }
            coveredIds.add(id);
        }
    }
    if (coveredIds.size < inputIds.size) {
        const missing = [...inputIds].filter(id => !coveredIds.has(id));
        throw new Error(`LLM response omitted notification IDs: ${missing.join(', ')}`);
    }

    return result.groups;
}
