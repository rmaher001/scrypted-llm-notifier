/**
 * supportsRecordingStream — decides whether a Scrypted camera device can serve
 * a recording seek/clip based on METHOD PRESENCE, not the 'VideoRecorder'
 * interface flag. UniFi Protect cameras expose a working getRecordingStream but
 * may not advertise the VideoRecorder interface string, so gating on the
 * interface array 400'd clip playback on cameras that could actually serve it
 * (same class of bug as the v0.3.166 full-frame poster fix). Callers still wrap
 * the actual call in try/catch, so a present-but-unusable method fails cleanly.
 */

import { supportsRecordingStream } from '../src/utils';

describe('supportsRecordingStream', () => {
    it('returns true when getRecordingStream exists, regardless of the interfaces array', () => {
        expect(supportsRecordingStream({ getRecordingStream: () => {}, interfaces: ['Camera'] })).toBe(true);
        expect(supportsRecordingStream({ getRecordingStream: () => {} })).toBe(true);
        expect(supportsRecordingStream({ getRecordingStream: () => {}, interfaces: ['VideoRecorder'] })).toBe(true);
    });

    it('returns false when the method is absent even if VideoRecorder is advertised', () => {
        expect(supportsRecordingStream({ interfaces: ['VideoRecorder'] })).toBe(false);
    });

    it('returns false for null/undefined/empty devices', () => {
        expect(supportsRecordingStream(undefined)).toBe(false);
        expect(supportsRecordingStream(null)).toBe(false);
        expect(supportsRecordingStream({})).toBe(false);
    });
});
