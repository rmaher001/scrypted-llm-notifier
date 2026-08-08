/**
 * Tests for buildGroupNamesIndex — the per-group union of identified
 * names (Scrypted face + LLM) used to render name badges on the
 * gallery card for a grouped primary.
 *
 * v0.3.129 fix: the gallery card's name badges came from the PRIMARY
 * notification only. If the primary didn't ID a face but another
 * group member did, the card showed no badge — operator-visible bug
 * (Blake clearly in the composite, no "Blake" badge).
 */

import { buildGroupNamesIndex, getGalleryPage } from '../src/gallery';
import { StoredNotification } from '../src/types';

function n(overrides: Partial<StoredNotification> = {}): StoredNotification {
    return {
        id: overrides.id ?? 'evt-1',
        timestamp: overrides.timestamp ?? 1_700_000_000_000,
        cameraId: overrides.cameraId ?? 'cam-1',
        cameraName: overrides.cameraName ?? 'Test Camera',
        detectionType: overrides.detectionType ?? 'person',
        names: overrides.names ?? [],
        llmTitle: '',
        llmBody: '',
        llmSubtitle: '',
        detailedDescription: '',
        hasPoster: true,
        ...overrides,
    };
}

describe('buildGroupNamesIndex', () => {
    it('returns an empty index when no notifications are grouped', () => {
        const idx = buildGroupNamesIndex([n({ id: 'a' }), n({ id: 'b' })]);
        expect(idx.size).toBe(0);
    });

    it('unions Scrypted face names across all members of a group', () => {
        const notes = [
            n({ id: 'a', groupId: 'g1', names: ['Blake'] }),
            n({ id: 'b', groupId: 'g1', names: [] }),
            n({ id: 'c', groupId: 'g1', names: ['Casey'] }),
        ];
        const idx = buildGroupNamesIndex(notes);
        const entry = idx.get('g1');
        expect(entry).toBeDefined();
        expect(entry!.names.sort()).toEqual(['Blake', 'Casey']);
    });

    it('unions LLM-identified names across group members', () => {
        const notes = [
            n({ id: 'a', groupId: 'g1', llmIdentifiedNames: ['Blake'] }),
            n({ id: 'b', groupId: 'g1', llmIdentifiedNames: ['Drew'] }),
            n({ id: 'c', groupId: 'g1', llmIdentifiedName: 'Casey' }),  // legacy singular
        ];
        const idx = buildGroupNamesIndex(notes);
        const entry = idx.get('g1');
        expect(entry!.llmIdentifiedNames.sort()).toEqual(['Blake', 'Casey', 'Drew']);
    });

    it('deduplicates names appearing in multiple members', () => {
        const notes = [
            n({ id: 'a', groupId: 'g1', names: ['Blake'] }),
            n({ id: 'b', groupId: 'g1', names: ['Blake'] }),
            n({ id: 'c', groupId: 'g1', llmIdentifiedNames: ['Blake'] }),
        ];
        const idx = buildGroupNamesIndex(notes);
        const entry = idx.get('g1');
        expect(entry!.names).toEqual(['Blake']);
        expect(entry!.llmIdentifiedNames).toEqual(['Blake']);
    });

    it('keeps groups independent', () => {
        const notes = [
            n({ id: 'a', groupId: 'g1', names: ['Blake'] }),
            n({ id: 'b', groupId: 'g2', names: ['Drew'] }),
        ];
        const idx = buildGroupNamesIndex(notes);
        expect(idx.get('g1')!.names).toEqual(['Blake']);
        expect(idx.get('g2')!.names).toEqual(['Drew']);
    });

    it('ignores ungrouped notifications (no groupId)', () => {
        const notes = [
            n({ id: 'a', names: ['Blake'] }),                       // ungrouped
            n({ id: 'b', groupId: 'g1', names: ['Drew'] }),
        ];
        const idx = buildGroupNamesIndex(notes);
        expect(idx.size).toBe(1);
        expect(idx.get('g1')!.names).toEqual(['Drew']);
    });
});

describe('getGalleryPage — group name union end-to-end', () => {
    const primary = (overrides: Partial<StoredNotification> = {}) => n({
        isGroupPrimary: true, ...overrides,
    });

    it('grouped primary card surfaces union names in the projected payload', () => {
        // Primary has no face; member has Blake. Card should show Blake badge.
        const notes = [
            primary({ id: 'p', groupId: 'g1', timestamp: 2000, names: [] }),
            n({ id: 'm', groupId: 'g1', timestamp: 1000, names: ['Blake'] }),
        ];
        const res = getGalleryPage(notes, 1, 50, {});
        const card = res.notifications.find(x => x.id === 'p');
        expect(card).toBeDefined();
        expect(card!.names).toEqual(['Blake']);
    });

    it('filtering by name catches grouped primaries whose match is in a non-primary member', () => {
        // Pre-fix bug: filter 'Blake' would drop the primary because the
        // predicate ran against raw StoredNotification.names, not the union.
        const notes = [
            primary({ id: 'p', groupId: 'g1', timestamp: 2000, names: [] }),
            n({ id: 'm', groupId: 'g1', timestamp: 1000, names: ['Blake'] }),
            primary({ id: 'unrelated', timestamp: 500, names: ['Drew'] }),
        ];
        const res = getGalleryPage(notes, 1, 50, { name: 'Blake' });
        const ids = res.notifications.map(x => x.id).sort();
        expect(ids).toContain('p');
        expect(ids).not.toContain('unrelated');
    });

    it('filter options include names that only appear in non-primary members of a group', () => {
        const notes = [
            primary({ id: 'p', groupId: 'g1', timestamp: 2000, names: [] }),
            n({ id: 'm', groupId: 'g1', timestamp: 1000, names: ['Blake'] }),
        ];
        const res = getGalleryPage(notes, 1, 50, {});
        expect(res.filters.names).toContain('Blake');
    });

    it('drill-down view shows the per-member names (NOT the union)', () => {
        const notes = [
            primary({ id: 'p', groupId: 'g1', timestamp: 2000, names: [] }),
            n({ id: 'm', groupId: 'g1', timestamp: 1000, names: ['Blake'] }),
        ];
        const res = getGalleryPage(notes, 1, 50, {}, undefined, undefined, 'g1');
        const pCard = res.notifications.find(x => x.id === 'p');
        const mCard = res.notifications.find(x => x.id === 'm');
        expect(pCard!.names).toEqual([]);                    // primary in drill-down = its own names
        expect(mCard!.names).toEqual(['Blake']);
    });
});
