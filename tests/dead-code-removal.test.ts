import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const mainTs = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf-8');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

// ============================================================================
// Dead code absence tests — these FAIL before cleanup, PASS after
// ============================================================================

describe('Dead code removal', () => {
    test('webpack.browser.config.js should not exist', () => {
        expect(fs.existsSync(path.join(ROOT, 'webpack.browser.config.js'))).toBe(false);
    });

    test('package.json should not have build:browser script', () => {
        expect(packageJson.scripts['build:browser']).toBeUndefined();
    });

    test('build script should not reference build:browser', () => {
        expect(packageJson.scripts.build).not.toContain('build:browser');
    });

    test('main.ts should not contain browserClientBundle variable', () => {
        expect(mainTs).not.toMatch(/let\s+browserClientBundle/);
    });

    test('main.ts should not contain getBrowserClientBundle function', () => {
        expect(mainTs).not.toMatch(/function\s+getBrowserClientBundle/);
    });

    test('main.ts should not contain /brief/client.js endpoint', () => {
        expect(mainTs).not.toContain("'/brief/client.js'");
    });

    test('main.ts should not import fs module', () => {
        expect(mainTs).not.toMatch(/import\s+\*\s+as\s+fs\s+from\s+['"]fs['"]/);
    });

    test('main.ts should not import path module', () => {
        expect(mainTs).not.toMatch(/import\s+\*\s+as\s+path\s+from\s+['"]path['"]/);
    });
});

// ============================================================================
// Endpoint preservation tests — these PASS before and after cleanup
// ============================================================================

describe('Remaining endpoints are preserved', () => {
    test('/assets/daily-brief-card.js endpoint exists', () => {
        expect(mainTs).toContain("'/assets/daily-brief-card.js'");
    });

    test('/brief/cloud-url endpoint exists', () => {
        expect(mainTs).toContain("'/brief/cloud-url'");
    });

    test('/brief/set-timezone endpoint exists', () => {
        expect(mainTs).toContain("'/brief/set-timezone'");
    });

    test('/brief/clear endpoint exists', () => {
        expect(mainTs).toContain("'/brief/clear'");
    });

    test('/brief/ha-card endpoint exists', () => {
        expect(mainTs).toContain("'/brief/ha-card'");
    });

    test('/brief/video endpoint exists', () => {
        expect(mainTs).toContain("'/brief/video'");
    });

    test('/brief/snapshot endpoint exists', () => {
        expect(mainTs).toContain("'/brief/snapshot'");
    });

    test('/brief/webrtc-signal endpoint exists', () => {
        expect(mainTs).toContain("'/brief/webrtc-signal'");
    });
});

// ============================================================================
// Build integrity test — PASS after cleanup
// ============================================================================

describe('Build integrity', () => {
    test('out/scrypted-client.browser.js should not exist', () => {
        expect(fs.existsSync(path.join(ROOT, 'out/scrypted-client.browser.js'))).toBe(false);
    });
});
