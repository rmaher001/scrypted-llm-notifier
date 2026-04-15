import {
    CachedHighlight,
    CandidateWithPriority
} from '../types';

// Helper to convert highlight IDs to complete CachedHighlight objects
export function buildCachedHighlights(
    candidates: CandidateWithPriority[],
    highlightIds: string[],
    timezone: string
): CachedHighlight[] {
    // Create maps for both ID lookup and index tracking
    const notificationMap = new Map(candidates.map(c => [c.notification.id, c.notification]));
    const indexMap = new Map(candidates.map((c, idx) => [c.notification.id, idx]));

    const highlights: CachedHighlight[] = [];

    for (const id of highlightIds) {
        const n = notificationMap.get(id);
        if (!n) continue;

        const highlight: CachedHighlight = {
            id: n.id,
            cameraId: n.cameraId,
            cameraName: n.cameraName,
            timestamp: n.timestamp,
            date: new Date(n.timestamp).toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                timeZone: timezone
            }),
            time: new Date(n.timestamp).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZone: timezone
            }),
            title: n.llmTitle,
            subtitle: n.llmSubtitle,
            body: n.llmBody,
            thumbnail: n.hasPoster ? 'poster' : '',
            index: indexMap.get(id),  // Store the original index for narrative linking
            names: n.names?.length > 0 ? n.names : undefined,
            llmIdentifiedName: n.llmIdentifiedName,
            llmIdentifiedNames: n.llmIdentifiedNames?.length ? n.llmIdentifiedNames : undefined,
        };

        highlights.push(highlight);
    }

    // Sort chronologically
    return highlights.sort((a, b) => a.timestamp - b.timestamp);
}
