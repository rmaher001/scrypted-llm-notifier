// ============================================================================
// PersonStore: Disk-based reference photo storage for LLM person identification
// ============================================================================

import * as fsp from 'fs/promises';
import * as path from 'path';

export interface PersonReference {
    name: string;           // Original casing ("Richard")
    clarityScore: number;   // Clarity score of the stored reference photo
    updatedAt: number;      // Timestamp when reference was last updated
    cameraName?: string;    // Which camera captured it
}

export class PersonStore {
    private getFilesPath: () => Promise<string>;
    private dirReady: Promise<string> | null = null;

    constructor(getFilesPath: () => Promise<string>) {
        this.getFilesPath = getFilesPath;
    }

    normalizeName(name: string): string {
        return name.trim().toLowerCase();
    }

    private sanitizeName(name: string): string {
        return this.normalizeName(name).replace(/[^a-z0-9\-_]/g, '_');
    }

    private async ensureDir(): Promise<string> {
        if (!this.dirReady) {
            this.dirReady = (async () => {
                const base = await this.getFilesPath();
                const dir = path.join(base, 'people');
                await fsp.mkdir(dir, { recursive: true });
                return dir;
            })().catch(e => {
                this.dirReady = null;
                throw e;
            });
        }
        return this.dirReady;
    }

    private async photoPath(name: string): Promise<string> {
        const dir = await this.ensureDir();
        return path.join(dir, `${this.sanitizeName(name)}.jpg`);
    }

    private async metadataPath(): Promise<string> {
        const dir = await this.ensureDir();
        return path.join(dir, 'metadata.json');
    }

    private async readMetadata(): Promise<PersonReference[]> {
        const mp = await this.metadataPath();
        try {
            const data = await fsp.readFile(mp, 'utf-8');
            return JSON.parse(data);
        } catch (e: any) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }
    }

    private async writeMetadata(refs: PersonReference[]): Promise<void> {
        const mp = await this.metadataPath();
        await fsp.writeFile(mp, JSON.stringify(refs, null, 2));
    }

    async curate(name: string, jpeg: Buffer, clarityScore: number, cameraName?: string): Promise<boolean> {
        const normalized = this.normalizeName(name);
        const refs = await this.readMetadata();
        const existing = refs.find(r => this.normalizeName(r.name) === normalized);

        if (existing && clarityScore <= existing.clarityScore) {
            return false;
        }

        // Write photo to disk first (must succeed before updating metadata)
        const fp = await this.photoPath(name);
        await fsp.writeFile(fp, jpeg);

        // Update metadata
        const newRef: PersonReference = {
            name: existing ? existing.name : name,
            clarityScore,
            updatedAt: Date.now(),
            cameraName,
        };

        if (existing) {
            const idx = refs.indexOf(existing);
            refs[idx] = newRef;
        } else {
            refs.push(newRef);
        }

        await this.writeMetadata(refs);
        return true;
    }

    async getPhoto(name: string): Promise<Buffer | null> {
        const fp = await this.photoPath(name);
        try {
            return await fsp.readFile(fp);
        } catch (e: any) {
            if (e.code === 'ENOENT') return null;
            throw e;
        }
    }

    async getMetadata(name: string): Promise<PersonReference | undefined> {
        const normalized = this.normalizeName(name);
        const refs = await this.readMetadata();
        return refs.find(r => this.normalizeName(r.name) === normalized);
    }

    async getAllPeople(): Promise<PersonReference[]> {
        return this.readMetadata();
    }

    async getAllReferenceImages(): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        const refs = await this.readMetadata();

        for (const ref of refs) {
            const photo = await this.getPhoto(ref.name);
            if (photo) {
                result.set(ref.name, `data:image/jpeg;base64,${photo.toString('base64')}`);
            }
        }

        return result;
    }

    async remove(name: string): Promise<boolean> {
        const normalized = this.normalizeName(name);
        const refs = await this.readMetadata();
        const idx = refs.findIndex(r => this.normalizeName(r.name) === normalized);

        if (idx === -1) return false;

        // Delete photo file
        try {
            const fp = await this.photoPath(name);
            await fsp.unlink(fp);
        } catch {
            // File may already be missing
        }

        // Update metadata
        refs.splice(idx, 1);
        await this.writeMetadata(refs);
        return true;
    }

    async prune(knownNames: Set<string>): Promise<number> {
        let refs: PersonReference[];
        try {
            refs = await this.readMetadata();
        } catch {
            return 0;
        }

        if (refs.length === 0) return 0;

        const normalizedKnown = new Set<string>();
        for (const name of knownNames) {
            normalizedKnown.add(this.normalizeName(name));
        }

        const toRemove = refs.filter(r => !normalizedKnown.has(this.normalizeName(r.name)));
        if (toRemove.length === 0) return 0;

        for (const ref of toRemove) {
            try {
                const fp = await this.photoPath(ref.name);
                await fsp.unlink(fp);
            } catch {
                // Skip files that can't be deleted
            }
        }

        const remaining = refs.filter(r => normalizedKnown.has(this.normalizeName(r.name)));
        await this.writeMetadata(remaining);
        return toRemove.length;
    }
}
