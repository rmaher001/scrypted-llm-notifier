/**
 * Tests for NotificationBuffer — pure data structure with timer-based flushing.
 * The buffer deduplicates notifications by ID and tracks delivery targets.
 */

import {
    NotificationBuffer,
    BufferedNotification,
    DeliveryTarget,
    MAX_BUFFERED_NOTIFICATIONS,
} from '../src/notification-buffer';

function makeBuffered(id: string, overrides?: Partial<BufferedNotification>): BufferedNotification {
    return {
        id,
        timestamp: Date.now(),
        cameraName: 'Front Door',
        title: 'Person at Door',
        subtitle: 'Front Door',
        body: 'Adult approaching',
        detailedDescription: 'A person walks up to the door.',
        ...overrides,
    };
}

function makeTarget(notificationId: string, notifier?: any): DeliveryTarget {
    return {
        notificationId,
        notifier: notifier || { sendNotification: jest.fn() },
        options: {} as any,
        media: 'fake-media',
        icon: undefined,
    };
}

describe('NotificationBuffer', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('add', () => {
        it('stores a notification and its delivery target', () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');

            expect(buffer.size).toBe(1);
        });

        it('deduplicates notifications with the same ID', () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');
            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');

            expect(buffer.size).toBe(1);
        });

        it('tracks multiple delivery targets for the same notification ID', async () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            const notifier1 = { sendNotification: jest.fn() };
            const notifier2 = { sendNotification: jest.fn() };

            buffer.add(makeBuffered('n1'), notifier1 as any, { data: { ha: { url: '/ha' } } }, 'media1');
            buffer.add(makeBuffered('n1'), notifier2 as any, { data: {} }, 'media1');

            await buffer.flush();

            const [notifications, targets] = flushHandler.mock.calls[0];
            expect(notifications).toHaveLength(1);
            expect(targets).toHaveLength(2);
            expect(targets[0].notifier).toBe(notifier1);
            expect(targets[1].notifier).toBe(notifier2);
        });

        it('stores different notifications separately', () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');
            buffer.add(makeBuffered('n2'), { sendNotification: jest.fn() } as any, {} as any, 'media2');

            expect(buffer.size).toBe(2);
        });

        it('stores per-target options/media/icon on each DeliveryTarget', async () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            const notifier1 = { sendNotification: jest.fn() };
            const notifier2 = { sendNotification: jest.fn() };
            const haOptions = { data: { ha: { url: '/timeline' } } };
            const scryptedOptions = { data: {} };

            buffer.add(makeBuffered('n1'), notifier1 as any, haOptions, 'media1', 'icon1');
            buffer.add(makeBuffered('n1'), notifier2 as any, scryptedOptions, 'media1');

            await buffer.flush();

            const [, targets] = flushHandler.mock.calls[0];
            expect(targets[0].options).toBe(haOptions);
            expect(targets[0].media).toBe('media1');
            expect(targets[0].icon).toBe('icon1');
            expect(targets[1].options).toBe(scryptedOptions);
            expect(targets[1].icon).toBeUndefined();
        });

        it('does not store media/icon/options on BufferedNotification', async () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, { body: 'test' }, 'media1');

            await buffer.flush();

            const [notifications] = flushHandler.mock.calls[0];
            expect(notifications[0]).not.toHaveProperty('media');
            expect(notifications[0]).not.toHaveProperty('icon');
            expect(notifications[0]).not.toHaveProperty('options');
        });
    });

    describe('timer', () => {
        it('starts timer on first add', () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');

            expect(jest.getTimerCount()).toBe(1);
        });

        it('does not start additional timers on subsequent adds', () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');
            buffer.add(makeBuffered('n2'), { sendNotification: jest.fn() } as any, {} as any, 'media2');

            expect(jest.getTimerCount()).toBe(1);
        });

        it('calls flush handler when timer fires', async () => {
            const flushHandler = jest.fn().mockResolvedValue(undefined);
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');

            jest.advanceTimersByTime(60000);
            await Promise.resolve();

            expect(flushHandler).toHaveBeenCalledTimes(1);
        });

        it('passes notifications and targets to flush handler', async () => {
            const flushHandler = jest.fn().mockResolvedValue(undefined);
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');
            buffer.add(makeBuffered('n2'), { sendNotification: jest.fn() } as any, {} as any, 'media2');

            jest.advanceTimersByTime(60000);
            await Promise.resolve();

            const [notifications, targets] = flushHandler.mock.calls[0];
            expect(notifications).toHaveLength(2);
            expect(targets).toHaveLength(2);
        });

        it('clears buffer after flush', async () => {
            const flushHandler = jest.fn().mockResolvedValue(undefined);
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');

            jest.advanceTimersByTime(60000);
            await Promise.resolve();

            expect(buffer.size).toBe(0);
        });
    });

    describe('flush', () => {
        it('invokes flush handler immediately', async () => {
            const flushHandler = jest.fn().mockResolvedValue(undefined);
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');

            await buffer.flush();

            expect(flushHandler).toHaveBeenCalledTimes(1);
            expect(buffer.size).toBe(0);
        });

        it('cancels pending timer', async () => {
            const flushHandler = jest.fn().mockResolvedValue(undefined);
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');

            await buffer.flush();

            expect(jest.getTimerCount()).toBe(0);
        });

        it('is a no-op when buffer is empty', async () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            await buffer.flush();

            expect(flushHandler).not.toHaveBeenCalled();
        });
    });

    describe('clear', () => {
        it('discards all notifications and targets without flushing', () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');
            buffer.add(makeBuffered('n2'), { sendNotification: jest.fn() } as any, {} as any, 'media2');

            buffer.clear();

            expect(buffer.size).toBe(0);
            expect(flushHandler).not.toHaveBeenCalled();
        });

        it('cancels pending timer', () => {
            const flushHandler = jest.fn();
            const buffer = new NotificationBuffer(60000, flushHandler);

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');
            buffer.clear();

            expect(jest.getTimerCount()).toBe(0);
        });
    });

    describe('size', () => {
        it('returns 0 for empty buffer', () => {
            const buffer = new NotificationBuffer(60000, jest.fn());
            expect(buffer.size).toBe(0);
        });

        it('counts unique notifications, not targets', () => {
            const buffer = new NotificationBuffer(60000, jest.fn());

            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');
            buffer.add(makeBuffered('n1'), { sendNotification: jest.fn() } as any, {} as any, 'media1');

            expect(buffer.size).toBe(1);
        });
    });

    describe('buffer capacity limit', () => {
        it('caps notifications at MAX_BUFFERED_NOTIFICATIONS', () => {
            const buffer = new NotificationBuffer(60000, jest.fn());
            for (let i = 0; i < 150; i++) {
                buffer.add(makeBuffered(`n${i}`), { sendNotification: jest.fn() } as any, {} as any, `media${i}`);
            }
            expect(buffer.size).toBeLessThanOrEqual(100);
        });
    });
});
