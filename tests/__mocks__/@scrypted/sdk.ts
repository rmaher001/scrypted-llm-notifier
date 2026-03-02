// Minimal mock for @scrypted/sdk to allow Jest to import modules that depend on it.
// Only the symbols actually used in tests need real behavior; the rest are stubs.

export class MixinDeviceBase {
    mixinDevice: any;
    mixinDeviceInterfaces: any[] = [];
    console = { log: () => {}, warn: () => {}, error: () => {} };
    storage: any = { getItem: () => null, setItem: () => {} };
    constructor(..._args: any[]) {}
}

export class ScryptedDeviceBase {
    console = { log: () => {}, warn: () => {}, error: () => {} };
    storage: any = { getItem: () => null, setItem: () => {} };
}

export const ScryptedInterface = {
    Notifier: 'Notifier',
    Camera: 'Camera',
    VideoCamera: 'VideoCamera',
    ObjectDetector: 'ObjectDetector',
    Settings: 'Settings',
};

export const ScryptedDeviceType = {
    Notifier: 'Notifier',
    Camera: 'Camera',
};

export const ScryptedMimeTypes = {
    RTCSignalingChannel: 'x-scrypted/x-scrypted-rtc-signaling-channel',
    LocalUrl: 'text/x-uri',
    Url: 'text/x-uri',
};

const sdk = {
    systemManager: {
        getDeviceById: () => null,
        getDeviceByName: () => null,
    },
    mediaManager: {
        convertMediaObjectToBuffer: async () => Buffer.from(''),
        convertMediaObjectToLocalUrl: async () => '',
        convertMediaObject: async () => ({}),
    },
    endpointManager: {
        getPublicCloudEndpoint: async () => '',
    },
};

export default sdk;
