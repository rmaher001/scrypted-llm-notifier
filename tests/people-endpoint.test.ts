/**
 * Tests for /brief/people and /brief/people/photo endpoint handlers.
 */

import { handlePeopleRequest, handlePeoplePhotoRequest } from '../src/gallery';
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
