/**
 * Tests for NotificationStore.updateGroup() method.
 * Verifies that grouping metadata (groupId, isGroupPrimary) is correctly
 * applied to stored notifications.
 */

import { NotificationStore } from '../src/notification-store';
import { StoredNotification } from '../src/types';

function makeNotification(id: string, overrides?: Partial<StoredNotification>): StoredNotification {
    return {
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
    };
}

function makeStorage(): any {
    const data: Record<string, string> = {};
    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: (key: string, value: string) => { data[key] = value; },
    };
}

describe('NotificationStore.updateGroup', () => {
    let store: NotificationStore;
    let storage: any;

    beforeEach(() => {
        storage = makeStorage();
        store = new NotificationStore(storage);
    });

    it('sets groupId on all matching notification IDs', () => {
        store.add(makeNotification('n1'));
        store.add(makeNotification('n2'));
        store.add(makeNotification('n3'));

        store.updateGroup(['n1', 'n2'], 'group-abc', 'n1');

        expect(store.getById('n1')!.groupId).toBe('group-abc');
        expect(store.getById('n2')!.groupId).toBe('group-abc');
        expect(store.getById('n3')!.groupId).toBeUndefined();
    });

    it('sets isGroupPrimary=true only for primaryId', () => {
        store.add(makeNotification('n1'));
        store.add(makeNotification('n2'));

        store.updateGroup(['n1', 'n2'], 'group-abc', 'n2');

        expect(store.getById('n1')!.isGroupPrimary).toBe(false);
        expect(store.getById('n2')!.isGroupPrimary).toBe(true);
    });

    it('persists changes to storage', () => {
        store.add(makeNotification('n1'));
        store.add(makeNotification('n2'));

        store.updateGroup(['n1', 'n2'], 'group-xyz', 'n1');

        // Reload from storage
        const store2 = new NotificationStore(storage);
        expect(store2.getById('n1')!.groupId).toBe('group-xyz');
        expect(store2.getById('n1')!.isGroupPrimary).toBe(true);
        expect(store2.getById('n2')!.groupId).toBe('group-xyz');
        expect(store2.getById('n2')!.isGroupPrimary).toBe(false);
    });

    it('ignores notification IDs that do not exist in store', () => {
        store.add(makeNotification('n1'));

        // 'n999' does not exist — should not throw
        store.updateGroup(['n1', 'n999'], 'group-abc', 'n1');

        expect(store.getById('n1')!.groupId).toBe('group-abc');
    });

    it('handles empty notificationIds array without error', () => {
        store.add(makeNotification('n1'));

        expect(() => store.updateGroup([], 'group-abc', 'n1')).not.toThrow();
        expect(store.getById('n1')!.groupId).toBeUndefined();
    });
});

describe('NotificationStore.getByGroupId', () => {
    let store: NotificationStore;
    let storage: any;

    beforeEach(() => {
        storage = makeStorage();
        store = new NotificationStore(storage);
    });

    it('returns all notifications with matching groupId', () => {
        store.add(makeNotification('n1'));
        store.add(makeNotification('n2'));
        store.add(makeNotification('n3'));
        store.updateGroup(['n1', 'n2'], 'group-123', 'n1');

        const result = store.getByGroupId('group-123');
        expect(result).toHaveLength(2);
        expect(result.map(n => n.id).sort()).toEqual(['n1', 'n2']);
    });

    it('returns empty array for unknown groupId', () => {
        store.add(makeNotification('n1'));
        store.updateGroup(['n1'], 'group-abc', 'n1');

        const result = store.getByGroupId('group-unknown');
        expect(result).toHaveLength(0);
    });

    it('returns empty array when called with empty string', () => {
        store.add(makeNotification('n1', { groupId: 'group-abc' }));
        const result = store.getByGroupId('');
        expect(result).toHaveLength(0);
    });

    it('does not include ungrouped notifications', () => {
        store.add(makeNotification('n1'));
        store.add(makeNotification('n2'));
        store.updateGroup(['n1'], 'group-abc', 'n1');

        const result = store.getByGroupId('group-abc');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('n1');
    });
});
