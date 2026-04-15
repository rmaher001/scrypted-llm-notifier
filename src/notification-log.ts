// ============================================================================
// NotificationLog — Append-only JSONL file for notification persistence.
// Pure filesystem module. No Scrypted imports.
// ============================================================================

import * as fs from 'fs';
import * as fsp from 'fs/promises';

export interface LogEntry {
    id: string;
    [key: string]: any;
}

export class NotificationLog<T extends LogEntry> {
    constructor(private filePath: string) {}

    async append(entry: T): Promise<void> {
        await fsp.appendFile(this.filePath, JSON.stringify(entry) + '\n');
    }

    async loadAll(): Promise<T[]> {
        let content: string;
        try {
            content = await fsp.readFile(this.filePath, 'utf-8');
        } catch (e: any) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }

        if (!content.trim()) return [];

        const byId = new Map<string, T>();
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line) as T;
                byId.set(entry.id, entry);
            } catch {
                // skip malformed lines
            }
        }
        return Array.from(byId.values());
    }

    async compact(entries: T[]): Promise<void> {
        const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
        await fsp.writeFile(this.filePath, content);
    }

    appendSync(entry: T): void {
        fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    }

    compactSync(entries: T[]): void {
        const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
        fs.writeFileSync(this.filePath, content);
    }
}
