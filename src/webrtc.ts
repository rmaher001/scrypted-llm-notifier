import {
    RTCAVSignalingSetup,
    RTCSignalingOptions,
    RTCSignalingSendIceCandidate,
    RTCSignalingSession,
} from '@scrypted/sdk';

// ============================================================================
// Deferred Promise Utility (for WebRTC signaling)
// ============================================================================

export class Deferred<T> {
    promise: Promise<T>;
    resolve!: (value: T) => void;
    reject!: (reason?: any) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

// ============================================================================
// WebRTC Signaling Session (for HTTP-based SDP exchange)
// Based on Google Home plugin pattern - proper class for RPC serialization
// ============================================================================

export class WebRTCSignalingSession implements RTCSignalingSession {
    __proxy_props: { options: RTCSignalingOptions };
    options: RTCSignalingOptions;
    deferred: Deferred<{ description: RTCSessionDescriptionInit; setup: RTCAVSignalingSetup }>;
    offer: RTCSessionDescriptionInit;

    constructor(browserOffer: RTCSessionDescriptionInit) {
        this.offer = browserOffer;
        this.options = {
            disableTrickle: true,
            proxy: true
        };
        this.__proxy_props = { options: this.options };
        this.deferred = new Deferred();
    }

    async createLocalDescription(
        type: 'offer' | 'answer',
        setup: RTCAVSignalingSetup,
        sendIceCandidate: RTCSignalingSendIceCandidate | undefined
    ): Promise<RTCSessionDescriptionInit> {
        if (type === 'offer') {
            // Return the browser's offer to the camera/WebRTC plugin
            return this.offer;
        }
        // For answer type, WebRTC plugin will create it
        return undefined as any;
    }

    async setRemoteDescription(
        description: RTCSessionDescriptionInit,
        setup: RTCAVSignalingSetup
    ): Promise<void> {
        if (description?.type === 'answer') {
            // Got the answer from camera, resolve our deferred promise
            this.deferred.resolve({ description, setup });
        }
    }

    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        // No-op when trickle is disabled
    }

    async getOptions(): Promise<RTCSignalingOptions> {
        return this.options;
    }
}
