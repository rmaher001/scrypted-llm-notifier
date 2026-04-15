// ============================================================================
// NotificationBuffer — Timer-based buffer for notification grouping
//
// Pure data structure. No knowledge of LLM, delivery, or Scrypted.
// Deduplicates notifications by ID, tracks delivery targets separately.
// ============================================================================

export interface BufferedNotification {
    id: string;                                     // notificationId (detectionId)
    timestamp: number;
    cameraName: string;
    title: string;                                  // enriched title from Stage 1
    subtitle: string;
    body: string;
    detailedDescription: string;
    clarity?: { score: number; reason: string };
}

export interface DeliveryTarget {
    notificationId: string;                         // which detection this target is for
    notifier: any;                                  // underlying notifier device (opaque)
    options: any;                                   // per-target NotifierOptions (opaque)
    media: any;                                     // per-target media for delivery (opaque)
    icon?: any;                                     // per-target icon for delivery (opaque)
}

export type FlushHandler = (
    notifications: BufferedNotification[],
    targets: DeliveryTarget[],
) => Promise<void>;

export const MAX_BUFFERED_NOTIFICATIONS = 100;

export class NotificationBuffer {
    private notifications = new Map<string, BufferedNotification>();
    private targets: DeliveryTarget[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private windowMs: number,
        private onFlush: FlushHandler,
    ) {}

    add(notification: BufferedNotification, notifier: any, options: any, media: any, icon?: any): void {
        // Store notification (deduped by id), cap at max to prevent unbounded growth
        if (!this.notifications.has(notification.id)) {
            if (this.notifications.size >= MAX_BUFFERED_NOTIFICATIONS) return;
            this.notifications.set(notification.id, notification);
        }

        // Always track the delivery target with its own delivery payload
        this.targets.push({
            notificationId: notification.id,
            notifier,
            options,
            media,
            icon,
        });

        // Start timer on first add
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.flush();
            }, this.windowMs);
        }
    }

    async flush(): Promise<void> {
        if (this.notifications.size === 0) return;

        // Cancel pending timer
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        // Snapshot and clear before calling handler (prevents re-entrancy issues)
        const notifications = Array.from(this.notifications.values());
        const targets = [...this.targets];
        this.notifications.clear();
        this.targets = [];

        await this.onFlush(notifications, targets);
    }

    clear(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.notifications.clear();
        this.targets = [];
    }

    get size(): number {
        return this.notifications.size;
    }
}
