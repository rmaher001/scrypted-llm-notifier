/**
 * PosterDecisionLog — append-only JSONL of per-event poster decisions.
 *
 * Diagnostic-only. Records which path produced the poster (subjectCrop /
 * detectionInput / nvrSeek / none) plus diagnostic context: which interfaces
 * the camera had, what errors each path threw, byte sizes. Exposed via the
 * /brief/poster-decisions endpoint so operator can see why some events end
 * up without a poster.
 *
 * Per 2026-05-16 spec amendment §4.7 (v0.3.120 observability).
 */

import * as fsp from 'fs/promises';

// v0.3.172: 'notificationImage' added because a STORY now keeps Scrypted's
// composite as the poster. Without it this log would report the frame we
// fetched rather than the bytes actually written to disk — the same
// two-algorithms-disagreeing trap as the v0.3.83 hero/primary split.
export type PosterSource = 'posterBox' | 'subjectCrop' | 'detectionInput' | 'nvrSeek' | 'notificationImage' | 'none';

export interface PosterDecision {
    id: string;                           // notificationId
    ts: number;                           // epoch ms
    cameraId: string;
    cameraName: string;
    source: PosterSource;                 // which path produced the frame (or 'none')
    hasPoster: boolean;                   // did we write a poster to disk?
    cameraHasVideoRecorder: boolean;      // did the camera advertise VideoRecorder? (diagnostic only; NVR-seek is attempted regardless)
    hadDetectionId?: boolean;             // was a detectionId present in the event?
    hadBbox?: boolean;                    // was a detection bbox present?
    detectionInputError?: string;         // first-path error if any
    nvrSeekError?: string;                // second-path error if any
    fullFrameBytes?: number;              // raw fullFrame size before downscale
    cappedBytes?: number;                 // size after downscaleForStorage
    posterBytes?: number;                 // final stored bytes
    reason?: string;                      // when hasPoster=false, why
}

type PathResolver = () => Promise<string> | string;

export class PosterDecisionLog {
    constructor(private filePathOrResolver: string | PathResolver) {}

    private async getPath(): Promise<string> {
        return typeof this.filePathOrResolver === 'string'
            ? this.filePathOrResolver
            : await this.filePathOrResolver();
    }

    async append(d: PosterDecision): Promise<void> {
        const line = JSON.stringify(d) + '\n';
        await fsp.appendFile(await this.getPath(), line);
    }

    async loadRecent(limit: number): Promise<PosterDecision[]> {
        let text: string;
        try {
            text = await fsp.readFile(await this.getPath(), 'utf-8');
        } catch (e: any) {
            if (e?.code === 'ENOENT') return [];
            throw e;
        }
        const rows: PosterDecision[] = [];
        for (const line of text.split('\n')) {
            if (!line) continue;
            try {
                rows.push(JSON.parse(line) as PosterDecision);
            } catch {
                // skip corrupted lines
            }
        }
        rows.sort((a, b) => b.ts - a.ts);
        return rows.slice(0, limit);
    }
}
