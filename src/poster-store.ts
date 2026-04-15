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

    async pruneOlderThan(maxAgeDays: number): Promise<number> {
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

        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        let pruned = 0;
        for (const file of files) {
            if (!file.endsWith('.jpg')) continue;
            const fp = path.join(dir, file);
            const stat = await fsp.stat(fp);
            if (stat.mtimeMs < cutoff) {
                try {
                    await fsp.unlink(fp);
                    pruned++;
                } catch (e: any) {
                    if (e.code !== 'ENOENT') throw e;
                }
            }
        }

        return pruned;
    }
}
