/**
 * Tests for the gallery JSON projection — specifically that subtitle and
 * detailedDescription are exposed alongside title/body.
 *
 * Motivation: extracting bursts via /brief/gallery/data needs the same text
 * the grouping LLM sees in production. Today the projection only returns
 * llmTitle + llmBody; subtitle and detailedDescription live on the record but
 * never reach the API surface.
 */

import { getGalleryPage } from '../src/gallery';
import { StoredNotification } from '../src/types';

function makeNotif(
    id: string,
    overrides?: Partial<StoredNotification>,
): StoredNotification {
    return {
        id,
        timestamp: Date.now(),
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: [],
        llmTitle: 'Person Detected',
        llmSubtitle: 'Person • Indoor',
        llmBody: 'Someone at the door',
        detailedDescription: 'A man in a blue jacket walks toward the front door carrying a package.',
        ...overrides,
    };
}

describe('GalleryNotification subtitle field', () => {
    it('returns llmSubtitle as subtitle when present', () => {
        const ns = [makeNotif('n1', { llmSubtitle: 'Person • Driveway' })];
        const result = getGalleryPage(ns, 1, 50, {});
        expect(result.notifications[0].subtitle).toBe('Person • Driveway');
    });

    it('returns empty string subtitle when llmSubtitle is empty', () => {
        const ns = [makeNotif('n1', { llmSubtitle: '' })];
        const result = getGalleryPage(ns, 1, 50, {});
        expect(result.notifications[0].subtitle).toBe('');
    });
});

describe('GalleryNotification detailedDescription field', () => {
    it('returns detailedDescription verbatim when present', () => {
        const ns = [
            makeNotif('n1', {
                detailedDescription: 'A small white dog walking across the floor.',
            }),
        ];
        const result = getGalleryPage(ns, 1, 50, {});
        expect(result.notifications[0].detailedDescription)
            .toBe('A small white dog walking across the floor.');
    });

    it('returns undefined or empty when source detailedDescription is missing', () => {
        const ns = [makeNotif('n1', { detailedDescription: undefined })];
        const result = getGalleryPage(ns, 1, 50, {});
        const v = result.notifications[0].detailedDescription;
        // Either undefined or '' — both are acceptable; the field must EXIST in the type
        // so consumers don't crash on access. The point is no crash, no false text.
        expect(v === undefined || v === '').toBe(true);
    });
});

describe('drill-down (groupId) projection retains subtitle + detailedDescription', () => {
    it('exposes both fields for each member of a group page', () => {
        const ns = [
            makeNotif('a', { groupId: 'g1', llmSubtitle: 'Person • Yard', detailedDescription: 'A lengthy description A.' }),
            makeNotif('b', { groupId: 'g1', llmSubtitle: 'Person • Driveway', detailedDescription: 'A lengthy description B.' }),
        ];
        const result = getGalleryPage(ns, 1, 50, {}, undefined, '', 'g1');
        const ids = result.notifications.map(n => n.id).sort();
        expect(ids).toEqual(['a', 'b']);
        const byId = Object.fromEntries(result.notifications.map(n => [n.id, n]));
        expect(byId['a'].subtitle).toBe('Person • Yard');
        expect(byId['a'].detailedDescription).toBe('A lengthy description A.');
        expect(byId['b'].subtitle).toBe('Person • Driveway');
        expect(byId['b'].detailedDescription).toBe('A lengthy description B.');
    });
});
