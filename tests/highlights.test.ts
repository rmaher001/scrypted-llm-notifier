import { buildCachedHighlights } from '../src/daily-brief/highlights';
import { CandidateWithPriority, StoredNotification } from '../src/types';

function makeCandidate(id: string, overrides?: Partial<StoredNotification>): CandidateWithPriority {
    return {
        notification: {
            id,
            timestamp: Date.now(),
            cameraId: 'cam-1',
            cameraName: 'Front Door',
            detectionType: 'person',
            names: [],
            llmTitle: 'Person at Door',
            llmSubtitle: 'Front Door',
            llmBody: 'Adult approaching',
            ...overrides,
        },
        isPriority: false,
    };
}

describe('buildCachedHighlights name fields', () => {
    it('includes names from StoredNotification', () => {
        const candidates = [makeCandidate('n1', { names: ['Richard', 'Olesia'] })];
        const highlights = buildCachedHighlights(candidates, ['n1'], 'America/Los_Angeles');
        expect(highlights[0].names).toEqual(['Richard', 'Olesia']);
    });

    it('includes llmIdentifiedName from StoredNotification', () => {
        const candidates = [makeCandidate('n1', { llmIdentifiedName: 'Richard' })];
        const highlights = buildCachedHighlights(candidates, ['n1'], 'America/Los_Angeles');
        expect(highlights[0].llmIdentifiedName).toBe('Richard');
    });

    it('returns undefined names when notification has empty names array', () => {
        const candidates = [makeCandidate('n1', { names: [] })];
        const highlights = buildCachedHighlights(candidates, ['n1'], 'America/Los_Angeles');
        expect(highlights[0].names).toBeUndefined();
    });

    it('returns undefined llmIdentifiedName when not set on notification', () => {
        const candidates = [makeCandidate('n1')];
        const highlights = buildCachedHighlights(candidates, ['n1'], 'America/Los_Angeles');
        expect(highlights[0].llmIdentifiedName).toBeUndefined();
    });

    it('includes llmIdentifiedNames array from StoredNotification', () => {
        const candidates = [makeCandidate('n1', { llmIdentifiedNames: ['Richard', 'Olesia'] })];
        const highlights = buildCachedHighlights(candidates, ['n1'], 'America/Los_Angeles');
        expect(highlights[0].llmIdentifiedNames).toEqual(['Richard', 'Olesia']);
    });

    it('returns undefined llmIdentifiedNames when not set on notification', () => {
        const candidates = [makeCandidate('n1')];
        const highlights = buildCachedHighlights(candidates, ['n1'], 'America/Los_Angeles');
        expect(highlights[0].llmIdentifiedNames).toBeUndefined();
    });

    it('returns undefined llmIdentifiedNames when empty array on notification', () => {
        const candidates = [makeCandidate('n1', { llmIdentifiedNames: [] })];
        const highlights = buildCachedHighlights(candidates, ['n1'], 'America/Los_Angeles');
        expect(highlights[0].llmIdentifiedNames).toBeUndefined();
    });
});
