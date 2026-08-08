// ============================================================================
// LlmTelemetry — Per-call LLM telemetry log + aggregation.
// Pure filesystem + math module. No Scrypted imports.
// Append-only JSONL (reuses the shape of NotificationLog but adds time-based
// helpers and aggregation tailored to LLM reliability/latency/quality).
// ============================================================================

import * as fsp from 'fs/promises';

// ---- Types -----------------------------------------------------------------

export type LlmRole = 'notification' | 'daily-brief' | 'grouping' | 'reviewer';

// Common sink shape used by callers that want to record telemetry without
// importing the full LlmTelemetryLog class. Both notification-grouper and
// notification-cross-bucket accept this shape via dependency injection.
export interface TelemetrySink {
    record(row: TelemetryRow): void | Promise<void>;
}

export type LlmOutcome = 'ok' | 'timeout' | 'error' | 'parse_error';

export interface TelemetryRow {
    id: string;
    ts: number;
    providerName: string;
    role: LlmRole;
    outcome: LlmOutcome;
    latencyMs: number;
    timeoutMs: number;
    promptBytes: number;
    imageCount?: number;
    responseBytes?: number;
    clarityScore?: number;
    faceRefScore?: number;
    detailedDescLen?: number;
    identifiedPersonCount?: number;
    // role='reviewer' only: count of reassignments accepted vs filtered as
    // hallucinated. Visibility into reviewer behavior — if hallucinatedCount
    // becomes a significant fraction of (reassignmentCount + hallucinatedCount)
    // after a model swap, the prompt may need tightening.
    reassignmentCount?: number;
    hallucinatedCount?: number;
    errorMsg?: string;
}

export interface JudgeRow {
    subjectId: string;               // joins to TelemetryRow.id
    ts: number;
    judgeProviderName: string;
    latencyMs: number;
    accuracyScore: number;           // 1–10
    completenessScore: number;       // 1–10
    personIdCorrect: boolean | null; // null = no person id claimed
    notes?: string;
}

export interface ProviderAggregate {
    providerName: string;
    role: LlmRole;
    count: number;
    okRate: number;
    timeoutRate: number;
    errorRate: number;
    latencyP50: number;
    latencyP95: number;
    latencyP99: number;
    meanClarity?: number;
    meanFaceRef?: number;
    meanDescLen?: number;
    meanIdentifiedPersons?: number;
    judgeSampleSize?: number;
    meanJudgeAccuracy?: number;
    meanJudgeCompleteness?: number;
    personIdCorrectRate?: number;
    // role='reviewer' only — visibility into whether the cross-bucket reviewer
    // is actually merging sibling-bucket events or always returning empty.
    // `callsWithMerge` (count of ok rows where reassignmentCount > 0) is the
    // single most useful signal: "of N reviewer calls, how many produced at
    // least one merge". Means/totals are over the ok rows that reported the
    // field, so absence (older rows pre-dating the field) is preserved.
    meanReassignments?: number;
    totalReassignments?: number;
    callsWithMerge?: number;
    meanHallucinated?: number;
    totalHallucinated?: number;
}

export interface AggregatedStats {
    providers: ProviderAggregate[];
}

// ---- Helpers ---------------------------------------------------------------

export function makeTelemetryId(): string {
    // 12 bytes of entropy, timestamp prefix keeps ids roughly sortable.
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function truncateError(err: unknown): string | undefined {
    if (err === undefined || err === null) return undefined;
    let msg: string;
    if (err instanceof Error) msg = err.message || String(err);
    else if (typeof err === 'string') msg = err;
    else {
        try { msg = JSON.stringify(err); } catch { msg = String(err); }
    }
    return msg.length > 200 ? msg.slice(0, 200) : msg;
}

export function percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    if (values.length === 1) return values[0];
    const sorted = [...values].sort((a, b) => a - b);
    // linear interpolation between closest ranks
    const rank = p * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    const frac = rank - lo;
    return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export function pruneRows<T extends { ts: number }>(
    rows: T[],
    retentionDays: number,
    nowMs: number = Date.now(),
): T[] {
    const cutoff = nowMs - retentionDays * 86400_000;
    return rows.filter(r => r.ts >= cutoff);
}

// ---- Log -------------------------------------------------------------------

export type FilePathLike = string | (() => string | Promise<string>);

async function resolvePath(fp: FilePathLike): Promise<string> {
    return typeof fp === 'string' ? fp : await fp();
}

export class LlmTelemetryLog {
    constructor(private filePath: FilePathLike) {}

    async append(row: TelemetryRow): Promise<void> {
        const fp = await resolvePath(this.filePath);
        await fsp.appendFile(fp, JSON.stringify(row) + '\n');
    }

    async loadAll(): Promise<TelemetryRow[]> {
        const fp = await resolvePath(this.filePath);
        let content: string;
        try {
            content = await fsp.readFile(fp, 'utf-8');
        } catch (e: any) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }
        if (!content.trim()) return [];
        const out: TelemetryRow[] = [];
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line) as TelemetryRow); } catch { /* skip */ }
        }
        return out;
    }

    async loadSince(sinceMs: number): Promise<TelemetryRow[]> {
        const all = await this.loadAll();
        return all.filter(r => r.ts >= sinceMs);
    }

    async compact(rows: TelemetryRow[]): Promise<void> {
        const fp = await resolvePath(this.filePath);
        const content = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
        await fsp.writeFile(fp, content);
    }
}

export class LlmJudgeLog {
    constructor(private filePath: FilePathLike) {}

    async append(row: JudgeRow): Promise<void> {
        const fp = await resolvePath(this.filePath);
        await fsp.appendFile(fp, JSON.stringify(row) + '\n');
    }

    async loadAll(): Promise<JudgeRow[]> {
        const fp = await resolvePath(this.filePath);
        let content: string;
        try {
            content = await fsp.readFile(fp, 'utf-8');
        } catch (e: any) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }
        if (!content.trim()) return [];
        const out: JudgeRow[] = [];
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line) as JudgeRow); } catch { /* skip */ }
        }
        return out;
    }

    async compact(rows: JudgeRow[]): Promise<void> {
        const fp = await resolvePath(this.filePath);
        const content = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
        await fsp.writeFile(fp, content);
    }
}

// ---- Aggregation -----------------------------------------------------------

function mean(values: number[]): number | undefined {
    if (!values.length) return undefined;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

export function aggregateTelemetry(
    rows: TelemetryRow[],
    _nowMs: number = Date.now(),
    judgeRows: JudgeRow[] = [],
): AggregatedStats {
    // Group by (providerName, role).
    const groups = new Map<string, TelemetryRow[]>();
    for (const r of rows) {
        const key = `${r.providerName}\u0000${r.role}`;
        const arr = groups.get(key);
        if (arr) arr.push(r); else groups.set(key, [r]);
    }

    // Index judge rows by subjectId for O(1) lookup.
    const judgeBySubject = new Map<string, JudgeRow[]>();
    for (const j of judgeRows) {
        const arr = judgeBySubject.get(j.subjectId);
        if (arr) arr.push(j); else judgeBySubject.set(j.subjectId, [j]);
    }

    const providers: ProviderAggregate[] = [];

    for (const [key, groupRows] of groups) {
        const [providerName, role] = key.split('\u0000') as [string, LlmRole];
        const count = groupRows.length;
        const okRows = groupRows.filter(r => r.outcome === 'ok');
        const okCount = okRows.length;
        const timeoutCount = groupRows.filter(r => r.outcome === 'timeout').length;
        const errorCount = groupRows.filter(r => r.outcome === 'error' || r.outcome === 'parse_error').length;

        const okLatencies = okRows.map(r => r.latencyMs);
        const clarities = okRows.filter(r => typeof r.clarityScore === 'number').map(r => r.clarityScore!);
        const faceRefs = okRows.filter(r => typeof r.faceRefScore === 'number').map(r => r.faceRefScore!);
        const descLens = okRows.filter(r => typeof r.detailedDescLen === 'number').map(r => r.detailedDescLen!);
        const identifiedPersons = okRows
            .filter(r => typeof r.identifiedPersonCount === 'number')
            .map(r => r.identifiedPersonCount!);
        const reassignments = okRows
            .filter(r => typeof r.reassignmentCount === 'number')
            .map(r => r.reassignmentCount!);
        const hallucinations = okRows
            .filter(r => typeof r.hallucinatedCount === 'number')
            .map(r => r.hallucinatedCount!);

        // Fold judge rows matching ok telemetry ids in this group.
        const judgeForGroup: JudgeRow[] = [];
        for (const r of okRows) {
            const js = judgeBySubject.get(r.id);
            if (js) judgeForGroup.push(...js);
        }
        const judgeAccuracy = judgeForGroup.map(j => j.accuracyScore);
        const judgeCompleteness = judgeForGroup.map(j => j.completenessScore);
        const personIdDecisions = judgeForGroup.filter(j => j.personIdCorrect !== null) as Array<JudgeRow & { personIdCorrect: boolean }>;

        const agg: ProviderAggregate = {
            providerName,
            role,
            count,
            okRate: count ? okCount / count : 0,
            timeoutRate: count ? timeoutCount / count : 0,
            errorRate: count ? errorCount / count : 0,
            latencyP50: percentile(okLatencies, 0.5),
            latencyP95: percentile(okLatencies, 0.95),
            latencyP99: percentile(okLatencies, 0.99),
            meanClarity: mean(clarities),
            meanFaceRef: mean(faceRefs),
            meanDescLen: mean(descLens),
            meanIdentifiedPersons: mean(identifiedPersons),
        };

        if (judgeForGroup.length) {
            agg.judgeSampleSize = judgeForGroup.length;
            agg.meanJudgeAccuracy = mean(judgeAccuracy);
            agg.meanJudgeCompleteness = mean(judgeCompleteness);
            if (personIdDecisions.length) {
                const correct = personIdDecisions.filter(j => j.personIdCorrect === true).length;
                agg.personIdCorrectRate = correct / personIdDecisions.length;
            }
        }

        if (reassignments.length) {
            agg.meanReassignments = mean(reassignments);
            agg.totalReassignments = reassignments.reduce((a, b) => a + b, 0);
            agg.callsWithMerge = reassignments.filter(n => n > 0).length;
        }
        if (hallucinations.length) {
            agg.meanHallucinated = mean(hallucinations);
            agg.totalHallucinated = hallucinations.reduce((a, b) => a + b, 0);
        }

        providers.push(agg);
    }

    return { providers };
}
