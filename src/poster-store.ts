// ============================================================================
// PosterStore: Persistent disk storage for poster-quality JPEG images
// ============================================================================

import * as fsp from 'fs/promises';
import * as path from 'path';

export class PosterStore {
    private getFilesPath: () => Promise<string>;
    private dirReady: Promise<string> | null = null;

    constructor(getFilesPath: () => Promise<string>) {
        this.getFilesPath = getFilesPath;
    }

    private sanitizeId(id: string): string {
        // Replace any non-alphanumeric characters (except hyphen and underscore) with underscore
        // This prevents path traversal and filesystem-unsafe characters
        return id.replace(/[^a-zA-Z0-9\-_]/g, '_');
    }

    private async ensureDir(): Promise<string> {
        if (!this.dirReady) {
            this.dirReady = (async () => {
                const base = await this.getFilesPath();
                const dir = path.join(base, 'posters');
                await fsp.mkdir(dir, { recursive: true });
                return dir;
            })().catch(e => {
                this.dirReady = null;  // allow retry on next call
                throw e;
            });
        }
        return this.dirReady;
    }

    private async filePath(id: string): Promise<string> {
        const dir = await this.ensureDir();
        return path.join(dir, `${this.sanitizeId(id)}.jpg`);
    }

    async put(id: string, jpeg: Buffer): Promise<void> {
        const fp = await this.filePath(id);
        await fsp.writeFile(fp, jpeg);
    }

    async get(id: string): Promise<Buffer | null> {
        const fp = await this.filePath(id);
        try {
            return await fsp.readFile(fp);
        } catch (e: any) {
            if (e.code === 'ENOENT') return null;
            throw e;
        }
    }

    async has(id: string): Promise<boolean> {
        const fp = await this.filePath(id);
        try {
            await fsp.access(fp);
            return true;
        } catch {
            return false;
        }
    }

    async prune(validIds: Set<string>): Promise<number> {
        let dir: string;
        try {
            dir = await this.ensureDir();
        } catch {
            return 0;
        }

        let files: string[];
        try {
            files = await fsp.readdir(dir);
        } catch {
            return 0;
        }

        // Build a set of sanitized valid IDs for matching
        const validSanitized = new Set<string>();
        for (const id of validIds) {
            validSanitized.add(`${this.sanitizeId(id)}.jpg`);
        }

        let pruned = 0;
        for (const file of files) {
            if (!file.endsWith('.jpg')) continue;
            if (!validSanitized.has(file)) {
                try {
                    await fsp.unlink(path.join(dir, file));
                    pruned++;
                } catch {
                    // Skip files that can't be deleted
                }
            }
        }

        return pruned;
    }
}
