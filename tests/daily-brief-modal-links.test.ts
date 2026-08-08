import { generateDailyBriefHTML } from '../src/daily-brief/html-generator';

// v0.3.161: the per-event video modal's NVR link adopts the Stories-detail
// treatment — a single prominent "Open in NVR" button (replacing the two small
// "View in NVR Timeline →" / "View in HA NVR Timeline →" text links). HA-vs-cloud
// routing is decided at click time by the shared openNvrTimeline() router using
// the injected haNvrTimelinePath, so a single button works in every config.
describe('Daily Brief modal — "Open in NVR" button (Stories-style treatment)', () => {
    it('renders a single prominent "Open in NVR" button in the video modal', () => {
        const html = generateDailyBriefHTML(
            0, null, [], null, 'America/Los_Angeles',
            undefined, undefined, '0.0.0', undefined, '',
        );
        expect(html).toMatch(/id="modalNvrBtn"/);
        expect(html).toMatch(/Open in NVR/);
    });

    it('renders the button whether or not haNvrTimelinePath is set (route chosen at click time)', () => {
        const withHa = generateDailyBriefHTML(
            0, null, [], null, 'America/Los_Angeles',
            undefined, undefined, '0.0.0', undefined, '/scrypted',
        );
        const noHa = generateDailyBriefHTML(
            0, null, [], null, 'America/Los_Angeles',
            undefined, undefined, '0.0.0', undefined, '',
        );
        expect(withHa).toMatch(/id="modalNvrBtn"/);
        expect(noHa).toMatch(/id="modalNvrBtn"/);
    });

    it('drops the old text-link treatment (modalTimeline / modalHaTimeline anchors)', () => {
        const html = generateDailyBriefHTML(
            0, null, [], null, 'America/Los_Angeles',
            undefined, undefined, '0.0.0', undefined, '/scrypted',
        );
        expect(html).not.toMatch(/id="modalTimeline"/);
        expect(html).not.toMatch(/id="modalHaTimeline"/);
        expect(html).not.toMatch(/View in NVR Timeline/);
        expect(html).not.toMatch(/View in HA NVR Timeline/);
    });

    it('still injects haNvrTimelinePath so the click handler can route in-HA vs cloud', () => {
        const html = generateDailyBriefHTML(
            0, null, [], null, 'America/Los_Angeles',
            undefined, undefined, '0.0.0', undefined, '/scrypted',
        );
        // Server injects the path so client JS can build the deep-link URL
        expect(html).toMatch(/haNvrTimelinePath\s*=\s*["'\\]/);
    });

    it('wires the button to the shared openNvrTimeline router (same path Stories uses)', () => {
        const html = generateDailyBriefHTML(
            0, null, [], null, 'America/Los_Angeles',
            undefined, undefined, '0.0.0', undefined, '/scrypted',
        );
        expect(html).toMatch(/openNvrTimeline\(/);
    });

    it('applies a -5000ms pre-roll so the NVR scrubber lands at the lead-up, not the late detection epoch', () => {
        // The in-modal video preview anchors at notification.timestamp - 5000
        // (main.ts). The NVR deep-link must match that anchor, not the analyzer's
        // late-firing detection epoch (which sits near the end of the clip).
        const html = generateDailyBriefHTML(
            0, null, [], null, 'America/Los_Angeles',
            undefined, undefined, '0.0.0', undefined, '/scrypted',
        );
        expect(html).toMatch(/preRollMs\s*=\s*5000/);
        expect(html).toMatch(/Number\(currentTimestamp\)\s*-\s*preRollMs/);
    });
});
