import {
    StoredNotification,
    TimeBucket,
    CandidateWithPriority
} from '../types';

// ============================================================================
// Time Bucketing for Highlight Selection
// ============================================================================

export function createTimeBuckets(
    notifications: StoredNotification[],
    windowStart: number,
    windowEnd: number,
    bucketCount: number = 8,
    timezone: string = 'America/Los_Angeles'
): TimeBucket[] {
    const bucketDuration = (windowEnd - windowStart) / bucketCount;
    const buckets: TimeBucket[] = [];

    for (let i = 0; i < bucketCount; i++) {
        const start = windowStart + (i * bucketDuration);
        const end = start + bucketDuration;

        // Format bucket label (e.g., "Dec 21 6AM-12PM")
        const startDate = new Date(start);
        const endDate = new Date(end);
        const label = `${startDate.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: timezone
        })} ${startDate.toLocaleTimeString('en-US', {
            hour: 'numeric',
            hour12: true,
            timeZone: timezone
        })}-${endDate.toLocaleTimeString('en-US', {
            hour: 'numeric',
            hour12: true,
            timeZone: timezone
        })}`;

        buckets.push({
            start,
            end,
            label,
            notifications: notifications.filter(n =>
                n.timestamp >= start && n.timestamp < end
            )
        });
    }
    return buckets;
}

// Helper to identify vehicle-related notifications (used for both priority selection and post-LLM cap)
export function isVehicleNotification(n: StoredNotification): boolean {
    const title = (n.llmTitle || '').toLowerCase();
    const subtitle = (n.llmSubtitle || '').toLowerCase();
    return (
        title.includes('vehicle') ||
        title.includes('delivery') ||
        title.includes('car') ||
        title.includes('truck') ||
        subtitle.includes('vehicle') ||
        subtitle.includes('delivery')
    );
}

export function prioritySelectFromBucket(
    notifications: StoredNotification[],
    count: number
): CandidateWithPriority[] {
    if (notifications.length === 0) return [];

    // Filter to group primaries and ungrouped (avoid wasting slots on duplicates)
    const groupAware = notifications.filter(n => !n.groupId || n.isGroupPrimary);

    // If we have fewer than count, return all as priority (they're all we have)
    if (groupAware.length <= count) {
        return groupAware.map(n => ({ notification: n, isPriority: true }));
    }

    const selected: CandidateWithPriority[] = [];
    const used = new Set<string>();

    const tryAddPriority = (n: StoredNotification) => {
        if (!used.has(n.id) && selected.length < count) {
            selected.push({ notification: n, isPriority: true });
            used.add(n.id);
        }
    };

    const tryAddRandom = (n: StoredNotification) => {
        if (!used.has(n.id) && selected.length < count) {
            selected.push({ notification: n, isPriority: false });
            used.add(n.id);
        }
    };

    // Priority 1: Named people (not generic "Person", "Man", "Woman")
    // Match names like "Richard in garage" or "Zoia at kitchen" - capitalized name followed by space or end
    const namedPeople = groupAware.filter(n =>
        n.llmTitle &&
        /^[A-Z][a-z]+(\s|$)/.test(n.llmTitle) &&
        !n.llmTitle.startsWith('Person') &&
        !n.llmTitle.startsWith('Man') &&
        !n.llmTitle.startsWith('Woman')
    );
    namedPeople.forEach(tryAddPriority);

    // Priority 2: Animal detections
    const animals = groupAware.filter(n =>
        n.llmTitle?.toLowerCase().includes('animal') ||
        n.llmTitle?.toLowerCase().includes('dog') ||
        n.llmTitle?.toLowerCase().includes('cat') ||
        n.llmTitle?.toLowerCase().includes('bird') ||
        n.llmSubtitle?.toLowerCase().includes('animal')
    );
    animals.forEach(tryAddPriority);

    // Priority 3: Vehicle/delivery detections
    const vehicles = groupAware.filter(isVehicleNotification);
    vehicles.forEach(tryAddPriority);

    // Fill remaining with random sample (marked as non-priority)
    const remaining = groupAware.filter(n => !used.has(n.id));
    const shuffled = [...remaining].sort(() => Math.random() - 0.5);
    shuffled.slice(0, count - selected.length).forEach(tryAddRandom);

    return selected;
}

export function selectCandidatesFromBuckets(
    buckets: TimeBucket[],
    candidatesPerBucket: number = 8
): CandidateWithPriority[] {
    const candidates: CandidateWithPriority[] = [];

    for (const bucket of buckets) {
        const selected = prioritySelectFromBucket(bucket.notifications, candidatesPerBucket);
        candidates.push(...selected);
    }

    // Sort candidates chronologically
    return candidates.sort((a, b) => a.notification.timestamp - b.notification.timestamp);
}
