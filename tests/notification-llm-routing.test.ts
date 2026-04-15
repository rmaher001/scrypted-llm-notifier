/**
 * Tests for Notification LLM routing — per-detection enrichment to a
 * dedicated (local) model while Daily Brief and Person ID use cloud.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';

// Resolve source paths for structural tests
const mainTsPath = path.resolve(__dirname, '../src/main.ts');
const llmNotifierTsPath = path.resolve(__dirname, '../src/llm-notifier.ts');

// --- Round 1: Pure routing function ---

describe('resolveNotificationProvider', () => {
    // Import will fail until function is implemented
    let resolveNotificationProvider: any;

    beforeAll(async () => {
        const mod = await import('../src/main');
        resolveNotificationProvider = mod.resolveNotificationProvider;
    });

    it('returns notificationLlm when configured', () => {
        const localDevice = { id: 'local' };
        const cloudDevice = { id: 'cloud' };

        const result = resolveNotificationProvider(
            localDevice,
            () => cloudDevice,
        );

        expect(result).toBe(localDevice);
    });

    it('falls back to primary provider when notificationLlm not configured', () => {
        const cloudDevice = { id: 'cloud' };

        const result = resolveNotificationProvider(
            undefined,
            () => cloudDevice,
        );

        expect(result).toBe(cloudDevice);
    });
});

// --- Round 2: Setting + wiring structural tests ---

describe('notificationLlm setting', () => {
    let mainSrc: string;

    beforeAll(async () => {
        mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
    });

    it('exists in StorageSettings with device type, multiple, and ChatCompletion filter', () => {
        expect(mainSrc).toContain('notificationLlm');
        expect(mainSrc).toMatch(/notificationLlm.*deviceFilter.*ChatCompletion/s);
        // Must be multiple: true for round-robin and chip UI
        // Match within the notificationLlm setting block only (before next setting key)
        const settingBlock = mainSrc.match(/notificationLlm:\s*\{([^}]+)\}/s);
        expect(settingBlock).toBeTruthy();
        expect(settingBlock![1]).toMatch(/multiple:\s*true/);
    });

    it('is in orderedKeys after chatCompletions', () => {
        const orderedMatch = mainSrc.match(/orderedKeys\s*=\s*\[([^\]]+)\]/s);
        expect(orderedMatch).toBeTruthy();
        const keys = orderedMatch![1];
        const chatIdx = keys.indexOf("'chatCompletions'");
        const notifIdx = keys.indexOf("'notificationLlm'");
        expect(notifIdx).toBeGreaterThan(chatIdx);
    });
});

describe('selectNotificationProvider method', () => {
    let mainSrc: string;

    beforeAll(async () => {
        mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
    });

    it('exists and calls resolveNotificationProvider', () => {
        expect(mainSrc).toContain('selectNotificationProvider');
        expect(mainSrc).toContain('resolveNotificationProvider');
    });

    it('uses round-robin across notification LLM provider IDs', () => {
        // selectNotificationProvider should use currentNotificationProviderIndex
        // and getDeviceById for round-robin, same pattern as selectProvider
        expect(mainSrc).toContain('currentNotificationProviderIndex');
        expect(mainSrc).toMatch(/selectNotificationProvider[\s\S]*?getDeviceById/);
    });
});

// --- Round 3: Call site wiring ---

describe('llm-notifier.ts call site wiring', () => {
    let notifierSrc: string;

    beforeAll(async () => {
        notifierSrc = await fsp.readFile(llmNotifierTsPath, 'utf-8');
    });

    it('uses selectNotificationProvider for enrichment calls without hasReferenceImages', () => {
        // Both callLlm invocations should use selectNotificationProvider()
        const callLlmLines = notifierSrc.split('\n').filter(
            l => l.includes('callLlm(') && l.includes('selectNotificationProvider')
        );
        for (const line of callLlmLines) {
            expect(line).toContain('selectNotificationProvider()');
            expect(line).not.toContain('hasReferenceImages');
        }
        expect(callLlmLines.length).toBeGreaterThanOrEqual(2);
    });
});

describe('callLlm logs provider name', () => {
    let notifierSrc: string;

    beforeAll(async () => {
        notifierSrc = await fsp.readFile(llmNotifierTsPath, 'utf-8');
    });

    it('includes provider name in the LLM call log line', () => {
        // The "Calling LLM" log should include the provider/model name
        const logLine = notifierSrc.split('\n').find(l => l.includes('Calling LLM'));
        expect(logLine).toBeDefined();
        expect(logLine).toContain('providerName');
    });
});

describe('notification enrichment sets low temperature', () => {
    it('createMessageTemplate includes temperature: 0.1', async () => {
        const { createMessageTemplate } = await import('../src/llm-notifier');
        const template = createMessageTemplate('', [], {});
        expect(template.temperature).toBe(0.1);
    });
});

describe('Daily Brief and grouping still use selectProvider', () => {
    let mainSrc: string;

    beforeAll(async () => {
        mainSrc = await fsp.readFile(mainTsPath, 'utf-8');
    });

    it('generateDailySummary uses selectProvider (not selectNotificationProvider)', () => {
        // Find the generateDailySummary method and verify it uses selectProvider
        const dailyBriefSection = mainSrc.match(
            /generateDailySummary[\s\S]*?const device = this\.selectProvider/
        );
        expect(dailyBriefSection).toBeTruthy();
    });

    it('handleBufferFlush uses selectProvider for grouping', () => {
        const groupingSection = mainSrc.match(
            /handleBufferFlush[\s\S]*?this\.selectProvider\(\)/
        );
        expect(groupingSection).toBeTruthy();
    });
});
