import {
    NarrativeSegment,
    NaturalPeriod,
    FrozenSegment,
    CandidateWithPriority
} from '../types';

// ============================================================================
// Natural Period Helpers (for Incremental Narrative Generation)
// ============================================================================

export const PERIOD_NAMES: [number, string][] = [
    [0, 'night'],      // 12am-6am
    [6, 'morning'],    // 6am-12pm
    [12, 'afternoon'], // 12pm-6pm
    [18, 'evening'],   // 6pm-12am
];

// Display names. 'night' stays the internal name — it is baked into persisted
// frozen-segment keys — but "Thursday night" READS as Thursday evening, so the
// 12am-6am block shows as "early morning" (UX report 2026-08-06).
const PERIOD_DISPLAY: Record<string, string> = {
    night: 'early morning',
};

/**
 * Heals a persisted timeRange for display. Frozen segments written before the
 * rename carry "Thursday night" verbatim and the renderer reuses them as-is,
 * so without this the upgrade looks like it failed until the period ages out.
 * Word-bounded and case-insensitive ("Night" appears in capitalized headers);
 * "nightly"/"midnight" are left alone.
 */
export function toDisplayTimeRange(timeRange: string): string {
    return timeRange.replace(/\bnight\b/gi, PERIOD_DISPLAY.night);
}

/**
 * Consolidates a period's narrative segments into exactly ONE segment — total
 * over any input, including an EMPTY array.
 *
 * Issue #12: the caller did `periodNarrative[0]` and dereferenced the result.
 * Empty input is a live condition (JSON parse-failure fallback carries no
 * narrative; the segment validator can filter everything out), and the
 * resulting TypeError aborted the entire generation run — every remaining
 * period, not just this one. Empty input now degrades to the same empty-period
 * shape the no-candidates path produces, so downstream `.text` filters treat
 * both identically and the loop continues.
 */
export function consolidatePeriodNarrative(
    segments: NarrativeSegment[],
    periodLabel: string,
): NarrativeSegment {
    if (segments.length === 0)
        return { timeRange: periodLabel, text: '', highlightIds: [] };
    if (segments.length === 1)
        return segments[0];
    return {
        timeRange: periodLabel,
        text: segments.map(s => s.text).join(' '),
        highlightIds: [...new Set(segments.flatMap(s => s.highlightIds))],
    };
}

/**
 * Returns all 6-hour natural periods that overlap [windowStart, windowEnd].
 * Periods are aligned to midnight in the given timezone.
 */
export function getNaturalPeriods(windowStart: number, windowEnd: number, timezone: string): NaturalPeriod[] {
    const periods: NaturalPeriod[] = [];

    // Find the start of the day (midnight) containing windowStart in the user's timezone
    const startDate = new Date(windowStart);
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(startDate);
    const getPart = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');
    const tzHour = getPart('hour');
    const tzMinute = getPart('minute');
    const tzSecond = getPart('second');
    const msSinceMidnight = ((tzHour * 60 + tzMinute) * 60 + tzSecond) * 1000;
    // Start from midnight of the day containing windowStart (in the user's timezone)
    // The while loop's periodEnd > windowStart check skips periods before the window
    let cursor = windowStart - msSinceMidnight;

    while (cursor < windowEnd) {
        const periodEnd = cursor + 6 * 3600_000;

        // Only include periods that actually overlap the window
        if (periodEnd > windowStart) {
            // Determine the period label from the cursor timestamp
            const cursorDate = new Date(cursor);
            const cursorParts = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                weekday: 'long',
                hour: '2-digit',
                hour12: false
            }).formatToParts(cursorDate);
            const dayName = cursorParts.find(p => p.type === 'weekday')?.value || '';
            const hour = parseInt(cursorParts.find(p => p.type === 'hour')?.value || '0');
            const periodName = PERIOD_NAMES.reduce((name, [h, n]) => hour >= h ? n : name, 'night');

            // Build date key: YYYY-MM-DD-periodname
            const dateKey = cursorDate.toLocaleDateString('en-CA', { timeZone: timezone });

            periods.push({
                key: `${dateKey}-${periodName}`,
                label: `${dayName} ${PERIOD_DISPLAY[periodName] ?? periodName}`,
                start: cursor,
                end: periodEnd,
            });
        }

        cursor = periodEnd;
    }

    return periods;
}

/**
 * Match a narrative segment to a natural period using the median timestamp
 * of its highlighted candidates. More robust than parsing free-text timeRange.
 */
export function matchSegmentToPeriod(
    segment: NarrativeSegment,
    periods: NaturalPeriod[],
    candidates: CandidateWithPriority[]
): NaturalPeriod | undefined {
    if (!segment.highlightIds || segment.highlightIds.length === 0) return undefined;

    // Collect timestamps for this segment's highlights
    const timestamps: number[] = [];
    for (const idx of segment.highlightIds) {
        if (idx >= 0 && idx < candidates.length) {
            timestamps.push(candidates[idx].notification.timestamp);
        }
    }
    if (timestamps.length === 0) return undefined;

    // Use median timestamp
    timestamps.sort((a, b) => a - b);
    const median = timestamps[Math.floor(timestamps.length / 2)];

    // Find the period containing the median
    return periods.find(p => median >= p.start && median < p.end);
}

/**
 * Build a context string summarizing frozen segments for the LLM prompt.
 * Tells the LLM what has already been narrated so it doesn't repeat.
 */
export function buildFrozenContext(frozenSegments: FrozenSegment[]): string {
    if (frozenSegments.length === 0) return '';

    // Heal persisted timeRanges here too: this text is the model's own
    // history, and a stale "Thursday night" in it invites the model to echo
    // the retired vocabulary into fresh prose under a corrected header.
    const lines = frozenSegments.map(fs =>
        `${toDisplayTimeRange(fs.narrative.timeRange)}: ${fs.narrative.text} (${fs.highlights.length} highlights)`
    );
    return lines.join('\n');
}

// ============================================================================
// Daily Summary LLM Generation
// ============================================================================

export function createSummaryPrompt(candidates: CandidateWithPriority[], dateStr: string, timezone: string, customInstructions?: string, frozenContext?: string, periodLabel?: string) {
    // Calculate highlight count: 8-24 highlights based on candidate pool size
    const highlightCount = Math.min(24, Math.max(8, Math.round(candidates.length * 0.3)));

    // Build event list with date AND time (events span 48 hours)
    // Include camera name for journey tracking
    const eventList = candidates.map((c, idx) => {
        const n = c.notification;
        const dateTime = new Date(n.timestamp).toLocaleString('en-US', {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: timezone
        });
        const names = n.names.length > 0 ? ` (${n.names.join(', ')})` : '';
        const description = n.detailedDescription || n.llmBody || '';
        const camera = n.cameraName ? ` [${n.cameraName}]` : '';
        // Format: [idx] Day Time [Camera]: Title (Names) - Description
        return `[${idx}] ${dateTime}${camera}: ${n.llmTitle}${names} - ${description}`;
    }).join('\n');

    // Build optional user context section
    const userContextSection = customInstructions?.trim()
        ? `\n<user_context>\n${customInstructions.trim()}\n</user_context>\n`
        : '';

    // Build optional frozen context section (incremental generation)
    const frozenSection = frozenContext?.trim()
        ? `\n<previously_narrated>
These time periods are already written. Continue the narrative from where they left off.
Do NOT repeat these events. Write segments for the NEW events only.

${frozenContext.trim()}
</previously_narrated>\n`
        : '';

    // Per-period context: tells the LLM it's generating for a specific time window
    const periodSection = periodLabel
        ? `\n<time_period>
You are writing about: ${periodLabel}
All events below fall within this time period. Write a single narrative segment for this period.
</time_period>\n`
        : '';

    const taskInstructions = periodLabel
        ? `<task>
1. Select up to ${highlightCount} events that tell a coherent story
2. Write a single narrative segment for this time period describing ONLY the selected events
3. Show JOURNEYS - multiple snapshots of the same person moving through the house IS GOOD
</task>`
        : `<task>
1. Select up to ${highlightCount} events that tell a coherent story
2. Group into time-based segments (morning, afternoon, evening)
3. Write a narrative for each segment describing ONLY the selected events
4. Show JOURNEYS - multiple snapshots of the same person moving through the house IS GOOD
</task>`;

    const timeFraming = periodLabel
        ? `You are creating a narrative for security camera events during ${periodLabel}.`
        : `You are creating a narrative timeline of security camera events from the past 48 hours.`;

    const promptText = `${timeFraming}
${userContextSection}${frozenSection}${periodSection}
<events>
${eventList}
</events>

${taskInstructions}

<output_format>
{
  "overview": "1-2 sentence summary of overall activity",
  "narrative": [
    {
      "timeRange": "Sunday morning",
      "text": "Descriptive paragraph telling the story of these events...",
      "highlightIds": [0, 2, 5, 7, 8]
    }
  ]
}
</output_format>

<guidelines>
JOURNEYS (sequences of same subject moving through house):
- Definition: ONE subject moving through multiple locations within a SHORT time span
- Time rules:
  * Events within 5 minutes of each other = likely SAME journey, group together
  * Events 15+ minutes apart = SEPARATE journeys, can be in different segments
- Location rules:
  * Same subject at DIFFERENT cameras = movement through house = INCLUDE ALL
  * Same camera + same time = same moment = pick ONE only
  * Same time + different cameras = same moment different angles = pick BEST one
- Examples of ONE journey (include all):
  * "Casey enters walkway [2:00] → opens gate [2:01] → front door [2:02] → living room [2:03]"
- Examples of SEPARATE events (not one journey):
  * "Casey at garage [2:00]" + "Casey at garage [2:30]" = 30 min gap, separate events
  * "Casey at garage [2:00]" + "Alex at bedroom [2:05]" = different people, separate

Narrative style:
- Write naturally, like telling a friend what happened at home
- Describe what people were doing, where they went, what they carried
- Mention people by name when recognized
- Focus narrative on events in highlightIds - you can mention brief transitions ("then walked to") but main descriptions MUST match the indexed events
- Do NOT invent events that are not in the list

Time segments:
- timeRange format examples: "Sunday morning", "Monday afternoon", "Sunday early morning to Monday morning" (for midnight crossings)
- Periods: early morning (12am-6am), morning (6am-12pm), afternoon (12pm-6pm), evening (6pm-12am)
- If ALL events fall in one period, create just ONE segment
- If events span multiple periods, create multiple segments
- Minimum 1 segment required, even for a single event

Limits:
- Maximum 3 vehicles total (unless delivery/visitor-related)
- Prefer named people over generic "Person"
- Each segment MUST have at least 1 highlightId

SKIP These Events:
- Titles starting with "Unidentified" or "Object"
- Mundane items: slippers, shoes, random objects
- Insects and small creatures
</guidelines>`;

    return {
        messages: [
            {
                role: "user" as const,
                content: promptText
            }
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "daily_narrative",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        overview: { type: "string" },
                        narrative: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    timeRange: { type: "string" },
                                    text: { type: "string" },
                                    highlightIds: {
                                        type: "array",
                                        items: { type: "number" }
                                    }
                                },
                                required: ["timeRange", "text", "highlightIds"],
                                additionalProperties: false
                            }
                        }
                    },
                    required: ["overview", "narrative"],
                    additionalProperties: false
                }
            }
        }
    };
}
