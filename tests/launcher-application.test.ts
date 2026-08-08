/**
 * The plugin appears on the Scrypted launcher page.
 *
 * Scrypted's launcher lists any plugin that declares the `LauncherApplication`
 * interface and exposes an `applicationInfo` property — that is how facematch
 * gets its entry alongside "Management Console" and "Cameras and Recordings".
 * The launcher keys off the INTERFACE, not the device type, so this plugin can
 * stay a Provider (it is a MixinProvider) and still appear.
 *
 * Without this the Daily Brief is only reachable by copying a URL out of the
 * settings panel.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf-8');

/** The source right after `applicationInfo = {`, enough to cover the literal. */
function assignmentWindow(): string {
    const at = MAIN.indexOf('applicationInfo = {');
    expect(at).toBeGreaterThan(-1);
    return MAIN.slice(at, at + 500);
}

describe('launcher registration', () => {
    it('declares LauncherApplication in the plugin manifest', () => {
        expect(PKG.scrypted.interfaces).toContain('LauncherApplication');
    });

    it('keeps the interfaces it already had', () => {
        // Adding the launcher must not displace the mixin/settings/http roles.
        for (const i of ['MixinProvider', 'Settings', 'HttpRequestHandler']) {
            expect(PKG.scrypted.interfaces).toContain(i);
        }
    });

    it('stays a Provider — the launcher keys off the interface, not the type', () => {
        expect(PKG.scrypted.type).toBe('Provider');
    });

    it('sets applicationInfo on the provider', () => {
        expect(MAIN).toMatch(/applicationInfo\s*=\s*\{/);
    });

    it('points the launcher entry at the Daily Brief, not the bare endpoint', () => {
        // href must land on /brief; the endpoint root serves no UI.
        // Read a fixed window rather than brace-matching — the href is a
        // template literal, so a non-greedy /\{...\}/ stops at the `}` closing
        // its `${...}` and cuts the value off mid-expression.
        expect(assignmentWindow()).toMatch(/href:[^\n]*\/brief/);
    });

    it('gives the entry a name and an icon', () => {
        const w = assignmentWindow();
        expect(w).toMatch(/name:/);
        expect(w).toMatch(/icon:/);
    });
});
