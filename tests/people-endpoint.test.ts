/**
 * Tests for /brief/people and /brief/people/photo endpoint handlers.
 */

import { handlePeopleRequest, handlePeoplePhotoRequest, handlePeopleDeleteRequest } from '../src/gallery';
import { PersonStore } from '../src/person-store';

// Mock PersonStore
function createMockPersonStore(people: Array<{ name: string; clarityScore: number; cameraName?: string; updatedAt: number }>, photos: Map<string, Buffer>): PersonStore {
    return {
        getAllPeople: jest.fn().mockResolvedValue(people),
        getPhoto: jest.fn().mockImplementation(async (name: string) => {
            return photos.get(name.trim().toLowerCase()) || null;
        }),
        normalizeName: (name: string) => name.trim().toLowerCase(),
    } as any;
}

describe('handlePeopleRequest', () => {
    const basePeople = [
        { name: 'Richard', clarityScore: 8, cameraName: 'Front Door', updatedAt: 1710100000000 },
        { name: 'Olesia', clarityScore: 6, cameraName: 'Driveway', updatedAt: 1710200000000 },
    ];

    it('returns correct JSON shape', async () => {
        const store = createMockPersonStore(basePeople, new Map());
        const result = await handlePeopleRequest(store, true, '/api/endpoint');

        expect(result.code).toBe(200);
        expect(result.contentType).toBe('application/json');

        const body = JSON.parse(result.body);
        expect(body.people).toHaveLength(2);
        expect(body.total).toBe(2);
        expect(body.featureEnabled).toBe(true);
    });

    it('each person has photoUrl constructed from baseUrl', async () => {
        const store = createMockPersonStore(basePeople, new Map());
        const result = await handlePeopleRequest(store, true, '/api/endpoint');
        const body = JSON.parse(result.body);

        expect(body.people[0].photoUrl).toContain('/api/endpoint/brief/people/photo?name=');
        expect(body.people[0].photoUrl).toContain('Richard');
    });

    it('includes person metadata fields', async () => {
        const store = createMockPersonStore(basePeople, new Map());
        const result = await handlePeopleRequest(store, true, '/base');
        const body = JSON.parse(result.body);

        const richard = body.people.find((p: any) => p.name === 'Richard');
        expect(richard.clarityScore).toBe(8);
        expect(richard.cameraName).toBe('Front Door');
        expect(richard.updatedAt).toBe(1710100000000);
    });

    it('returns featureEnabled: false when feature off, still returns people list', async () => {
        const store = createMockPersonStore(basePeople, new Map());
        const result = await handlePeopleRequest(store, false, '/base');
        const body = JSON.parse(result.body);

        expect(body.featureEnabled).toBe(false);
        expect(body.people).toHaveLength(2);
    });

    it('returns empty list when no people', async () => {
        const store = createMockPersonStore([], new Map());
        const result = await handlePeopleRequest(store, true, '/base');
        const body = JSON.parse(result.body);

        expect(body.people).toHaveLength(0);
        expect(body.total).toBe(0);
    });
});

describe('handlePeoplePhotoRequest', () => {
    const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG magic bytes

    it('returns JPEG Buffer for known name', async () => {
        const photos = new Map([['richard', jpegBuffer]]);
        const store = createMockPersonStore([], photos);
        const result = await handlePeoplePhotoRequest(
            'http://localhost/brief/people/photo?name=Richard',
            store,
        );

        expect(result.code).toBe(200);
        expect(result.contentType).toBe('image/jpeg');
        expect(Buffer.isBuffer(result.body)).toBe(true);
        expect(result.cacheControl).toBe('public, max-age=3600');
    });

    it('returns 404 for unknown name', async () => {
        const store = createMockPersonStore([], new Map());
        const result = await handlePeoplePhotoRequest(
            'http://localhost/brief/people/photo?name=Unknown',
            store,
        );

        expect(result.code).toBe(404);
    });

    it('returns 400 for missing name param', async () => {
        const store = createMockPersonStore([], new Map());
        const result = await handlePeoplePhotoRequest(
            'http://localhost/brief/people/photo',
            store,
        );

        expect(result.code).toBe(400);
    });
});

describe('handlePeopleDeleteRequest', () => {
    it('returns 200 and removes person', async () => {
        const store = {
            ...createMockPersonStore([], new Map()),
            remove: jest.fn().mockResolvedValue(true),
        } as any;
        const result = await handlePeopleDeleteRequest(
            'http://localhost/brief/people/delete?name=Richard',
            store,
        );
        expect(result.code).toBe(200);
        expect(store.remove).toHaveBeenCalledWith('Richard');
    });

    it('returns 404 when person not found', async () => {
        const store = {
            ...createMockPersonStore([], new Map()),
            remove: jest.fn().mockResolvedValue(false),
        } as any;
        const result = await handlePeopleDeleteRequest(
            'http://localhost/brief/people/delete?name=Unknown',
            store,
        );
        expect(result.code).toBe(404);
    });

    it('returns 400 for missing name param', async () => {
        const store = createMockPersonStore([], new Map()) as any;
        store.remove = jest.fn();
        const result = await handlePeopleDeleteRequest(
            'http://localhost/brief/people/delete',
            store,
        );
        expect(result.code).toBe(400);
        expect(store.remove).not.toHaveBeenCalled();
    });
});

describe('handleGalleryDataRequest NaN guards', () => {
    const { handleGalleryDataRequest } = require('../src/gallery');

    function createMockStore(notifications: any[]) {
        return {
            getAll: () => notifications,
            getAllIds: () => new Set(notifications.map((n: any) => n.id)),
            getById: (id: string) => notifications.find((n: any) => n.id === id),
            getAllEmbeddings: () => new Map(),
        };
    }

    it('returns 200 for non-numeric page/pageSize params', async () => {
        const store = createMockStore([]);
        const result = await handleGalleryDataRequest(
            'http://localhost/brief/gallery/data?page=abc&pageSize=xyz',
            store as any,
            '/base',
        );
        expect(result.code).toBe(200);
        const data = JSON.parse(result.body);
        expect(data.page).toBe(1);
    });

    it('returns 200 for pageSize=0', async () => {
        const store = createMockStore([]);
        const result = await handleGalleryDataRequest(
            'http://localhost/brief/gallery/data?pageSize=0',
            store as any,
            '/base',
        );
        expect(result.code).toBe(200);
    });

    it('returns notifications sorted newest first', async () => {
        const store = createMockStore([
            { id: 'old', timestamp: 1000, cameraId: 'c1', cameraName: 'Cam', detectionType: 'person', names: [], llmTitle: 'Old', llmBody: '', hasPoster: false },
            { id: 'new', timestamp: 3000, cameraId: 'c1', cameraName: 'Cam', detectionType: 'person', names: [], llmTitle: 'New', llmBody: '', hasPoster: false },
            { id: 'mid', timestamp: 2000, cameraId: 'c1', cameraName: 'Cam', detectionType: 'person', names: [], llmTitle: 'Mid', llmBody: '', hasPoster: false },
        ]);
        const result = await handleGalleryDataRequest(
            'http://localhost/brief/gallery/data',
            store as any,
            '/base',
        );
        const data = JSON.parse(result.body);
        expect(data.notifications[0].llmTitle).toBe('New');
        expect(data.notifications[1].llmTitle).toBe('Mid');
        expect(data.notifications[2].llmTitle).toBe('Old');
    });
});
