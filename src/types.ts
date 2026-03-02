// ============================================================================
// Shared Types for LLM Notifier Plugin
// ============================================================================

export interface StoredNotification {
    id: string;
    timestamp: number;
    cameraId: string;
    cameraName: string;
    detectionType: string;
    names: string[];
    llmTitle: string;
    llmSubtitle: string;
    llmBody: string;
    thumbnailB64?: string;
    hasPoster?: boolean;           // True when a poster-quality JPEG exists on disk
    detailedDescription?: string;  // Async-generated detailed description for better summaries
    clarity?: {
        score: number;  // 1-10 clarity score
        reason: string; // Why this score was given
    };
    embedding?: string;           // base64 float32 from ObjectDetectionResult
    embeddingDimension?: number;  // vector length for compatibility checks
}

export interface DailyStats {
    total: number;
    byType: Record<string, number>;
    byCamera: Record<string, number>;
    byHour: Record<number, number>;
    names: string[];
}

export interface CachedHighlight {
    id: string;
    cameraId: string;
    cameraName: string;
    timestamp: number;
    date: string;           // formatted date string (e.g., "December 19")
    time: string;           // formatted time string
    title: string;          // llmTitle
    subtitle: string;       // llmSubtitle
    body: string;           // llmBody
    thumbnail: string;      // image URL (endpoint URL at serve time, base64 in storage)
    index?: number;         // Original index in candidates array (for narrative linking)
}

export interface NarrativeSegment {
    timeRange: string;      // "Sunday morning", "Monday afternoon"
    text: string;           // Narrative paragraph describing the journey
    highlightIds: number[]; // Indices of highlights in this segment
}

export interface CachedSummary {
    date: string; // YYYY-MM-DD
    summary: string;        // Legacy: simple summary text
    overview?: string;      // New: brief 1-2 sentence overview
    narrative?: NarrativeSegment[];  // New: narrative segments with linked highlights
    generatedAt: number;
    notificationCount: number;
    highlights: CachedHighlight[];  // Complete highlight objects (not IDs)
    windowStart: number;            // Timestamp of window start (midnight yesterday)
    windowEnd: number;              // Timestamp of window end (generation time)
    frozenSegments?: FrozenSegment[];  // Incremental: completed periods that won't be regenerated
}

// Data structure returned by getDailyBriefData helper for unified endpoint responses
export interface DailyBriefData {
    date: string;                    // YYYY-MM-DD format
    dateFormatted: string;           // Human-readable generation timestamp
    summary: string;                 // Summary text (or placeholder)
    overview?: string;               // Brief 1-2 sentence overview
    narrative?: NarrativeSegment[];  // Narrative segments with linked highlights
    highlights: CachedHighlight[];   // Highlights with optional clip URLs
    eventCount: number;              // Number of notifications in the period
    hasDailyBrief: boolean;          // Whether a brief has been generated
    generatedAt: number | null;      // Timestamp of generation (for HTML)
}

export interface NaturalPeriod {
    key: string;        // "2026-02-04-morning"
    label: string;      // "Tuesday morning"
    start: number;      // timestamp
    end: number;        // timestamp
}

export interface FrozenSegment {
    periodKey: string;
    periodStart: number;
    periodEnd: number;
    narrative: NarrativeSegment;    // the frozen text + original highlightIds
    highlights: CachedHighlight[];  // resolved highlight objects
    highlightNotificationIds: string[];  // notification IDs for re-indexing across runs
}

export interface TimeBucket {
    start: number;
    end: number;
    label: string;
    notifications: StoredNotification[];
}

export interface CandidateWithPriority {
    notification: StoredNotification;
    isPriority: boolean;  // true for named/animal/vehicle, false for random fill
}
