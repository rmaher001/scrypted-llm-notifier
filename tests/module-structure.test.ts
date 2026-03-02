import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const mainTs = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf-8');
const videoPlayerJs = fs.readFileSync(path.join(ROOT, 'ha-card/video-player.js'), 'utf-8');

// ============================================================================
// Phase 1: Types extraction
// ============================================================================

describe('Phase 1: types.ts extraction', () => {
    test('src/types.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/types.ts'))).toBe(true);
    });

    test('types.ts exports StoredNotification', () => {
        const types = fs.readFileSync(path.join(ROOT, 'src/types.ts'), 'utf-8');
        expect(types).toMatch(/export interface StoredNotification/);
    });

    test('types.ts exports all 10 interfaces', () => {
        const types = fs.readFileSync(path.join(ROOT, 'src/types.ts'), 'utf-8');
        const expectedInterfaces = [
            'StoredNotification', 'DailyStats', 'CachedHighlight',
            'NarrativeSegment', 'CachedSummary', 'DailyBriefData',
            'NaturalPeriod', 'FrozenSegment', 'TimeBucket', 'CandidateWithPriority'
        ];
        for (const iface of expectedInterfaces) {
            expect(types).toMatch(new RegExp(`export interface ${iface}`));
        }
    });

    test('main.ts does not define any of the 10 extracted interfaces', () => {
        const extractedInterfaces = [
            'StoredNotification', 'DailyStats', 'CachedHighlight',
            'NarrativeSegment', 'CachedSummary', 'DailyBriefData',
            'NaturalPeriod', 'FrozenSegment', 'TimeBucket', 'CandidateWithPriority'
        ];
        for (const iface of extractedInterfaces) {
            expect(mainTs).not.toMatch(new RegExp(`^interface ${iface}`, 'm'));
        }
    });

    test('main.ts imports from ./types', () => {
        expect(mainTs).toMatch(/from\s+['"]\.\/types['"]/);
    });

    test('StoredNotification has optional hasPoster boolean field', () => {
        const types = fs.readFileSync(path.join(ROOT, 'src/types.ts'), 'utf-8');
        // Extract StoredNotification interface block
        const match = types.match(/export interface StoredNotification\s*\{[\s\S]*?\n\}/);
        expect(match).not.toBeNull();
        expect(match![0]).toMatch(/hasPoster\?:\s*boolean/);
    });
});

// ============================================================================
// Phase 2: Utils and WebRTC extraction
// ============================================================================

describe('Phase 2: utils.ts extraction', () => {
    test('src/utils.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/utils.ts'))).toBe(true);
    });

    test('utils.ts exports escapeHtml', () => {
        const utils = fs.readFileSync(path.join(ROOT, 'src/utils.ts'), 'utf-8');
        expect(utils).toMatch(/export function escapeHtml/);
    });

    test('utils.ts exports all 6 functions', () => {
        const utils = fs.readFileSync(path.join(ROOT, 'src/utils.ts'), 'utf-8');
        const expectedFunctions = [
            'escapeHtml', 'parseClarity', 'withTimeout',
            'resizeJpegNearest', 'getJpegDimensions', 'buildImageList'
        ];
        for (const fn of expectedFunctions) {
            expect(utils).toMatch(new RegExp(`export (async )?function ${fn}`));
        }
    });

    test('main.ts does not define escapeHtml', () => {
        expect(mainTs).not.toMatch(/^function escapeHtml/m);
    });

    test('main.ts does not define parseClarity', () => {
        expect(mainTs).not.toMatch(/^function parseClarity/m);
    });

    test('main.ts does not define withTimeout', () => {
        expect(mainTs).not.toMatch(/^function withTimeout/m);
    });

    test('main.ts does not define resizeJpegNearest', () => {
        expect(mainTs).not.toMatch(/^async function resizeJpegNearest/m);
    });

    test('main.ts does not define getJpegDimensions', () => {
        expect(mainTs).not.toMatch(/^function getJpegDimensions/m);
    });

    test('main.ts does not define buildImageList', () => {
        expect(mainTs).not.toMatch(/^function buildImageList/m);
    });

    test('main.ts imports from ./utils', () => {
        expect(mainTs).toMatch(/from\s+['"]\.\/utils['"]/);
    });

    // Functional tests
    test('escapeHtml escapes angle brackets', () => {
        const { escapeHtml } = require('../src/utils');
        expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    test('parseClarity returns undefined for null input', () => {
        const { parseClarity } = require('../src/utils');
        expect(parseClarity(null)).toBeUndefined();
    });

    test('parseClarity clamps score to 1-10', () => {
        const { parseClarity } = require('../src/utils');
        expect(parseClarity({ score: 15, reason: 'test' })?.score).toBe(10);
        expect(parseClarity({ score: -5, reason: 'test' })?.score).toBe(1);
    });

    test('withTimeout rejects on timeout', async () => {
        const { withTimeout } = require('../src/utils');
        const slow = new Promise(resolve => setTimeout(resolve, 5000));
        await expect(withTimeout(slow, 10, 'test')).rejects.toThrow('test timed out after 10ms');
    });

    test('buildImageList returns correct list for each mode', () => {
        const { buildImageList } = require('../src/utils');
        expect(buildImageList('both', 'full', 'cropped')).toEqual(['full', 'cropped']);
        expect(buildImageList('full', 'full', 'cropped')).toEqual(['full']);
        expect(buildImageList('cropped', 'full', 'cropped')).toEqual(['cropped']);
        expect(buildImageList('full', undefined, 'cropped')).toEqual(['cropped']);
    });
});

describe('Phase 2: webrtc.ts extraction', () => {
    test('src/webrtc.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/webrtc.ts'))).toBe(true);
    });

    test('webrtc.ts exports Deferred', () => {
        const webrtc = fs.readFileSync(path.join(ROOT, 'src/webrtc.ts'), 'utf-8');
        expect(webrtc).toMatch(/export class Deferred/);
    });

    test('webrtc.ts exports WebRTCSignalingSession', () => {
        const webrtc = fs.readFileSync(path.join(ROOT, 'src/webrtc.ts'), 'utf-8');
        expect(webrtc).toMatch(/export class WebRTCSignalingSession/);
    });

    test('main.ts does not define class Deferred', () => {
        expect(mainTs).not.toMatch(/^class Deferred/m);
    });

    test('main.ts does not define class WebRTCSignalingSession', () => {
        expect(mainTs).not.toMatch(/^class WebRTCSignalingSession/m);
    });

    test('main.ts imports from ./webrtc', () => {
        expect(mainTs).toMatch(/from\s+['"]\.\/webrtc['"]/);
    });
});

// ============================================================================
// Phase 3: NotificationStore extraction
// ============================================================================

describe('Phase 3: notification-store.ts extraction', () => {
    test('src/notification-store.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/notification-store.ts'))).toBe(true);
    });

    test('notification-store.ts exports NotificationStore class', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/notification-store.ts'), 'utf-8');
        expect(src).toMatch(/export class NotificationStore/);
    });

    test('main.ts does not define class NotificationStore', () => {
        expect(mainTs).not.toMatch(/^class NotificationStore/m);
    });

    test('main.ts imports NotificationStore from ./notification-store', () => {
        expect(mainTs).toMatch(/from\s+['"]\.\/notification-store['"]/);
    });

    // Functional tests with mock storage
    test('NotificationStore add and getById', () => {
        const { NotificationStore } = require('../src/notification-store');
        const mockStorage = {
            _data: {} as Record<string, string>,
            getItem(key: string) { return this._data[key] || null; },
            setItem(key: string, value: string) { this._data[key] = value; },
        };
        const store = new NotificationStore(mockStorage);
        store.add({
            id: 'test-1',
            timestamp: Date.now(),
            cameraId: 'cam-1',
            cameraName: 'Front Door',
            detectionType: 'person',
            names: [],
            llmTitle: 'Person at door',
            llmSubtitle: 'Person',
            llmBody: 'Walking toward door',
        });
        expect(store.getById('test-1')).toBeDefined();
        expect(store.getById('test-1')!.cameraName).toBe('Front Door');
    });

    test('NotificationStore prevents duplicate IDs', () => {
        const { NotificationStore } = require('../src/notification-store');
        const mockStorage = {
            _data: {} as Record<string, string>,
            getItem(key: string) { return this._data[key] || null; },
            setItem(key: string, value: string) { this._data[key] = value; },
        };
        const store = new NotificationStore(mockStorage);
        const notification = {
            id: 'dup-1',
            timestamp: Date.now(),
            cameraId: 'cam-1',
            cameraName: 'Camera',
            detectionType: 'person',
            names: [],
            llmTitle: 'Test',
            llmSubtitle: 'Test',
            llmBody: 'Test',
        };
        store.add(notification);
        store.add(notification); // duplicate
        expect(store.getAll().length).toBe(1);
    });

    test('NotificationStore clear removes all', () => {
        const { NotificationStore } = require('../src/notification-store');
        const mockStorage = {
            _data: {} as Record<string, string>,
            getItem(key: string) { return this._data[key] || null; },
            setItem(key: string, value: string) { this._data[key] = value; },
        };
        const store = new NotificationStore(mockStorage);
        store.add({
            id: 'clear-1', timestamp: Date.now(), cameraId: 'c', cameraName: 'C',
            detectionType: 'p', names: [], llmTitle: 'T', llmSubtitle: 'S', llmBody: 'B',
        });
        expect(store.getAll().length).toBe(1);
        store.clear();
        expect(store.getAll().length).toBe(0);
    });

    test('NotificationStore getAllIds returns Set of all notification IDs', () => {
        const { NotificationStore } = require('../src/notification-store');
        const mockStorage = {
            _data: {} as Record<string, string>,
            getItem(key: string) { return this._data[key] || null; },
            setItem(key: string, value: string) { this._data[key] = value; },
        };
        const store = new NotificationStore(mockStorage);
        store.add({
            id: 'id-a', timestamp: Date.now(), cameraId: 'c', cameraName: 'C',
            detectionType: 'p', names: [], llmTitle: 'T', llmSubtitle: 'S', llmBody: 'B',
        });
        store.add({
            id: 'id-b', timestamp: Date.now() - 1000, cameraId: 'c', cameraName: 'C',
            detectionType: 'p', names: [], llmTitle: 'T', llmSubtitle: 'S', llmBody: 'B',
        });
        const ids = store.getAllIds();
        expect(ids).toBeInstanceOf(Set);
        expect(ids.size).toBe(2);
        expect(ids.has('id-a')).toBe(true);
        expect(ids.has('id-b')).toBe(true);
    });
});

// ============================================================================
// Phase 4: Daily Brief helpers extraction
// ============================================================================

describe('Phase 4: candidate-selection.ts extraction', () => {
    test('src/daily-brief/candidate-selection.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/daily-brief/candidate-selection.ts'))).toBe(true);
    });

    test('candidate-selection.ts exports createTimeBuckets', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/daily-brief/candidate-selection.ts'), 'utf-8');
        expect(src).toMatch(/export function createTimeBuckets/);
    });

    test('candidate-selection.ts exports all 4 functions', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/daily-brief/candidate-selection.ts'), 'utf-8');
        const expected = ['createTimeBuckets', 'isVehicleNotification', 'prioritySelectFromBucket', 'selectCandidatesFromBuckets'];
        for (const fn of expected) {
            expect(src).toMatch(new RegExp(`export function ${fn}`));
        }
    });

    test('main.ts does not define createTimeBuckets', () => {
        expect(mainTs).not.toMatch(/^function createTimeBuckets/m);
    });

    test('main.ts does not define isVehicleNotification', () => {
        expect(mainTs).not.toMatch(/^function isVehicleNotification/m);
    });

    test('main.ts does not define selectCandidatesFromBuckets', () => {
        expect(mainTs).not.toMatch(/^function selectCandidatesFromBuckets/m);
    });

    // Functional tests
    test('createTimeBuckets creates correct number of buckets', () => {
        const { createTimeBuckets } = require('../src/daily-brief/candidate-selection');
        const now = Date.now();
        const buckets = createTimeBuckets([], now - 86400000, now, 8, 'America/Los_Angeles');
        expect(buckets).toHaveLength(8);
    });

    test('isVehicleNotification detects vehicle keywords', () => {
        const { isVehicleNotification } = require('../src/daily-brief/candidate-selection');
        expect(isVehicleNotification({ llmTitle: 'Vehicle in driveway', llmSubtitle: '' })).toBe(true);
        expect(isVehicleNotification({ llmTitle: 'Person at door', llmSubtitle: '' })).toBe(false);
        expect(isVehicleNotification({ llmTitle: 'Delivery truck', llmSubtitle: '' })).toBe(true);
    });

    test('selectCandidatesFromBuckets returns sorted candidates', () => {
        const { createTimeBuckets, selectCandidatesFromBuckets } = require('../src/daily-brief/candidate-selection');
        const now = Date.now();
        const notifications = [
            { id: '1', timestamp: now - 3600000, llmTitle: 'Person', llmSubtitle: '', names: [] },
            { id: '2', timestamp: now - 1800000, llmTitle: 'Vehicle', llmSubtitle: '', names: [] },
        ];
        const buckets = createTimeBuckets(notifications, now - 86400000, now, 8, 'America/Los_Angeles');
        const candidates = selectCandidatesFromBuckets(buckets, 8);
        expect(candidates.length).toBeGreaterThanOrEqual(0);
        // Verify sorted chronologically
        for (let i = 1; i < candidates.length; i++) {
            expect(candidates[i].notification.timestamp).toBeGreaterThanOrEqual(candidates[i-1].notification.timestamp);
        }
    });
});

describe('Phase 4: prompts.ts extraction', () => {
    test('src/daily-brief/prompts.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/daily-brief/prompts.ts'))).toBe(true);
    });

    test('prompts.ts exports PERIOD_NAMES', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/daily-brief/prompts.ts'), 'utf-8');
        expect(src).toMatch(/export const PERIOD_NAMES/);
    });

    test('prompts.ts exports all 4 functions', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/daily-brief/prompts.ts'), 'utf-8');
        const expected = ['getNaturalPeriods', 'matchSegmentToPeriod', 'buildFrozenContext', 'createSummaryPrompt'];
        for (const fn of expected) {
            expect(src).toMatch(new RegExp(`export function ${fn}`));
        }
    });

    test('main.ts does not define createSummaryPrompt', () => {
        expect(mainTs).not.toMatch(/^function createSummaryPrompt/m);
    });

    test('main.ts does not define PERIOD_NAMES', () => {
        expect(mainTs).not.toMatch(/^const PERIOD_NAMES/m);
    });

    // Functional tests
    test('buildFrozenContext returns empty string for empty array', () => {
        const { buildFrozenContext } = require('../src/daily-brief/prompts');
        expect(buildFrozenContext([])).toBe('');
    });

    test('createSummaryPrompt returns messages and response_format', () => {
        const { createSummaryPrompt } = require('../src/daily-brief/prompts');
        const result = createSummaryPrompt([], '2025-01-01', 'America/Los_Angeles');
        expect(result).toHaveProperty('messages');
        expect(result).toHaveProperty('response_format');
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
    });

    test('getNaturalPeriods returns periods overlapping window', () => {
        const { getNaturalPeriods } = require('../src/daily-brief/prompts');
        const now = Date.now();
        const periods = getNaturalPeriods(now - 86400000, now, 'America/Los_Angeles');
        expect(periods.length).toBeGreaterThan(0);
        for (const p of periods) {
            expect(p).toHaveProperty('key');
            expect(p).toHaveProperty('label');
            expect(p).toHaveProperty('start');
            expect(p).toHaveProperty('end');
        }
    });
});

describe('Phase 4: highlights.ts extraction', () => {
    test('src/daily-brief/highlights.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/daily-brief/highlights.ts'))).toBe(true);
    });

    test('highlights.ts exports buildCachedHighlights', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/daily-brief/highlights.ts'), 'utf-8');
        expect(src).toMatch(/export function buildCachedHighlights/);
    });

    test('main.ts does not define buildCachedHighlights', () => {
        expect(mainTs).not.toMatch(/^function buildCachedHighlights/m);
    });

    test('main.ts imports from ./daily-brief/', () => {
        expect(mainTs).toMatch(/from\s+['"]\.\/daily-brief\//);
    });

    // Functional test
    test('buildCachedHighlights returns empty array for empty inputs', () => {
        const { buildCachedHighlights } = require('../src/daily-brief/highlights');
        const result = buildCachedHighlights([], [], 'America/Los_Angeles');
        expect(result).toEqual([]);
    });

    test('buildCachedHighlights maps highlight IDs to full objects', () => {
        const { buildCachedHighlights } = require('../src/daily-brief/highlights');
        const candidates = [
            { notification: { id: 'n1', cameraId: 'c1', cameraName: 'Front', timestamp: 1000, llmTitle: 'Person', llmSubtitle: 'Sub', llmBody: 'Body' } },
            { notification: { id: 'n2', cameraId: 'c2', cameraName: 'Back', timestamp: 2000, llmTitle: 'Vehicle', llmSubtitle: 'Sub2', llmBody: 'Body2' } },
        ];
        const result = buildCachedHighlights(candidates, ['n1'], 'America/Los_Angeles');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('n1');
        expect(result[0].cameraName).toBe('Front');
        expect(result[0].title).toBe('Person');
    });
});

// ============================================================================
// Phase 5: HTML Generator and LLMNotifier extraction
// ============================================================================

describe('Phase 5: html-generator.ts extraction', () => {
    test('src/daily-brief/html-generator.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/daily-brief/html-generator.ts'))).toBe(true);
    });

    test('html-generator.ts exports generateDailyBriefHTML', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/daily-brief/html-generator.ts'), 'utf-8');
        expect(src).toMatch(/export function generateDailyBriefHTML/);
    });

    test('html-generator.ts exports getHACardBundle', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/daily-brief/html-generator.ts'), 'utf-8');
        expect(src).toMatch(/export function getHACardBundle/);
    });

    test('main.ts does not define generateDailyBriefHTML', () => {
        expect(mainTs).not.toMatch(/^function generateDailyBriefHTML/m);
    });

    test('main.ts does not define getHACardBundle', () => {
        expect(mainTs).not.toMatch(/^function getHACardBundle/m);
    });

    test('main.ts imports from ./daily-brief/html-generator', () => {
        expect(mainTs).toMatch(/from\s+['"]\.\/daily-brief\/html-generator['"]/);
    });

    // Functional test
    test('generateDailyBriefHTML returns valid HTML', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(0, null, [], null, '/refresh', 'America/Los_Angeles');
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('</html>');
    });
});

describe('Phase 5: llm-notifier.ts extraction', () => {
    test('src/llm-notifier.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/llm-notifier.ts'))).toBe(true);
    });

    test('llm-notifier.ts exports createMessageTemplate', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/llm-notifier.ts'), 'utf-8');
        expect(src).toMatch(/export function createMessageTemplate/);
    });

    test('llm-notifier.ts exports LLMNotifier class', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/llm-notifier.ts'), 'utf-8');
        expect(src).toMatch(/export class LLMNotifier/);
    });

    test('main.ts does not define class LLMNotifier', () => {
        expect(mainTs).not.toMatch(/^class LLMNotifier /m);
    });

    test('main.ts does not define createMessageTemplate', () => {
        expect(mainTs).not.toMatch(/^function createMessageTemplate/m);
    });

    test('main.ts imports from ./llm-notifier', () => {
        expect(mainTs).toMatch(/from\s+['"]\.\/llm-notifier['"]/);
    });

    // Functional test
    test('createMessageTemplate returns messages and response_format', () => {
        const { createMessageTemplate } = require('../src/llm-notifier');
        const result = createMessageTemplate('prompt', ['data:image/jpeg;base64,abc'], {});
        expect(result).toHaveProperty('messages');
        expect(result).toHaveProperty('response_format');
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].role).toBe('system');
    });
});

// ============================================================================
// Feature 1: Reverse Chronological Order
// ============================================================================

describe('Feature 1: Reverse chronological sort toggle', () => {
    test('generateDailyBriefHTML includes a sort-order toggle button', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview text', [
            { timeRange: 'Morning', text: 'Something happened', highlightIds: [] }
        ]);
        expect(html).toContain('briefSortOrder');
        // Should have a toggle button with sort-related title or class
        expect(html).toMatch(/sort-btn|sort-order|sortOrder/i);
    });

    test('generateDailyBriefHTML includes JS for reading briefSortOrder from localStorage', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toContain("localStorage.getItem('briefSortOrder')");
        expect(html).toContain("localStorage.setItem('briefSortOrder'");
    });

    test('generateDailyBriefHTML includes JS that reverses timeline-segment elements', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toContain('timeline-segment');
        // The JS should manipulate .timeline-segment order
        expect(html).toMatch(/applySortOrder|applySortorder|sortOrder/);
    });

    test('buildCachedHighlights still returns chronological order (regression)', () => {
        const { buildCachedHighlights } = require('../src/daily-brief/highlights');
        const candidates = [
            { notification: { id: 'n1', cameraId: 'c1', cameraName: 'Front', timestamp: 2000, llmTitle: 'Later', llmSubtitle: 'S', llmBody: 'B' } },
            { notification: { id: 'n2', cameraId: 'c2', cameraName: 'Back', timestamp: 1000, llmTitle: 'Earlier', llmSubtitle: 'S', llmBody: 'B' } },
        ];
        const result = buildCachedHighlights(candidates, ['n1', 'n2'], 'America/Los_Angeles');
        expect(result).toHaveLength(2);
        // Should be sorted chronologically (oldest first) - data layer unchanged
        expect(result[0].id).toBe('n2');
        expect(result[1].id).toBe('n1');
    });

    // Bug fix tests: sort toggle icon and ordering
    test('sort-oldest-icon SVG has no inline style attribute', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        // Inline style="display:none" overrides CSS - must not exist on sort icons
        expect(html).not.toMatch(/sort-oldest-icon[^>]*style=/);
    });

    test('timeline segments have data-index for stable sort ordering', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Morning text', highlightIds: [] },
            { timeRange: 'Evening', text: 'Evening text', highlightIds: [] }
        ]);
        expect(html).toMatch(/timeline-segment[^>]*data-index="0"/);
        expect(html).toMatch(/timeline-segment[^>]*data-index="1"/);
    });

    test('applySortOrder JS sorts by data-index attribute', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toContain('data-index');
        expect(html).toContain("getAttribute('data-index')");
    });

    test('timeline-snapshots uses flex-wrap instead of overflow-x scroll', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toMatch(/\.timeline-snapshots\s*\{[^}]*flex-wrap:\s*wrap/);
        expect(html).not.toMatch(/\.timeline-snapshots\s*\{[^}]*overflow-x/);
    });

    test('timeline-item uses flex-grow to fill row width', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        // Items should grow (flex: 1) not stay fixed (flex: 0 0 auto)
        expect(html).toMatch(/\.timeline-item\s*\{[^}]*flex:\s*1\s+1/);
        expect(html).not.toMatch(/\.timeline-item\s*\{[^}]*flex:\s*0\s+0/);
    });

    test('page content is centered with max-width container', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toMatch(/\.content-wrapper\s*\{[^}]*max-width/);
        expect(html).toMatch(/\.content-wrapper\s*\{[^}]*margin:\s*0 auto/);
    });

    test('HA card timeline-snapshots uses CSS grid for uniform item sizing', () => {
        const haCard = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
        expect(haCard).toMatch(/\.timeline-snapshots\s*\{[^}]*display:\s*grid/);
        expect(haCard).toMatch(/\.timeline-snapshots\s*\{[^}]*grid-template-columns/);
    });

    test('HA card uses loader pattern: loader at card.js, bundle at bundle.js, version endpoint', () => {
        // The loader is served at the registered URL so users never change it
        expect(mainTs).toMatch(/assets\/daily-brief-card\.js/);
        // A separate bundle endpoint serves the real card JS with long cache
        expect(mainTs).toMatch(/assets\/daily-brief-card-bundle\.js/);
        // A version endpoint lets the loader know when to bust cache
        expect(mainTs).toMatch(/assets\/card-version/);
    });

    test('HA card loader contains dynamic import with version param', () => {
        // The loader served at /assets/daily-brief-card.js should be a small script
        // that fetches the version and dynamically imports the bundle
        const loaderBlock = mainTs.match(/assets\/daily-brief-card\.js[\s\S]{0,2000}/);
        expect(loaderBlock).not.toBeNull();
        // Loader must use dynamic import()
        expect(loaderBlock![0]).toMatch(/import\s*\(/);
        // Loader must reference the version endpoint
        expect(loaderBlock![0]).toMatch(/card-version/);
        // Loader must reference the bundle URL
        expect(loaderBlock![0]).toMatch(/daily-brief-card-bundle/);
    });

    test('HA card loader uses import.meta.url (not querySelectorAll) for base URL', () => {
        // HA loads custom cards via import(), not <script> tags.
        // querySelectorAll('script[src]') finds nothing in that context.
        // import.meta.url reliably gives the module's own URL.
        const loaderBlock = mainTs.match(/assets\/daily-brief-card\.js[\s\S]{0,2000}/);
        expect(loaderBlock).not.toBeNull();
        expect(loaderBlock![0]).toMatch(/import\.meta\.url/);
        expect(loaderBlock![0]).not.toMatch(/querySelectorAll/);
    });

    test('HA card loader logs error when base URL detection fails', () => {
        const loaderBlock = mainTs.match(/assets\/daily-brief-card\.js[\s\S]{0,2000}/);
        expect(loaderBlock).not.toBeNull();
        expect(loaderBlock![0]).toMatch(/console\.error.*(?:daily-brief-card|base URL|Could not)/);
    });

    test('HA card version endpoint returns JSON with no-cache headers', () => {
        const versionBlock = mainTs.match(/path === '\/assets\/card-version'[\s\S]{0,600}/);
        expect(versionBlock).not.toBeNull();
        expect(versionBlock![0]).toMatch(/no-cache/);
        expect(versionBlock![0]).toMatch(/application\/json/);
        expect(versionBlock![0]).toMatch(/pluginVersion/);
    });

    test('HA card CARD_VERSION matches package.json version', () => {
        const pkg = require('../package.json');
        const haCard = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
        const match = haCard.match(/CARD_VERSION\s*=\s*'([^']+)'/);
        expect(match).not.toBeNull();
        expect(match![1]).toBe(pkg.version);
    });

    test('HA card bundle endpoint uses long-lived cache headers', () => {
        // Match the actual endpoint handler, not the loader string
        const bundleBlock = mainTs.match(/path === '\/assets\/daily-brief-card-bundle\.js'[\s\S]{0,800}/);
        expect(bundleBlock).not.toBeNull();
        expect(bundleBlock![0]).toMatch(/max-age/);
        expect(bundleBlock![0]).toContain('application/javascript');
    });
});

// ============================================================================
// Phase 6: Final module inventory and size gate
// ============================================================================

describe('Final module structure', () => {
    const expectedFiles = [
        'src/types.ts',
        'src/utils.ts',
        'src/webrtc.ts',
        'src/notification-store.ts',
        'src/daily-brief/candidate-selection.ts',
        'src/daily-brief/prompts.ts',
        'src/daily-brief/highlights.ts',
        'src/daily-brief/html-generator.ts',
        'src/llm-notifier.ts',
        'src/main.ts',
    ];

    for (const file of expectedFiles) {
        test(`${file} exists`, () => {
            expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
        });
    }

    test('main.ts is under 1800 lines', () => {
        const lines = mainTs.split('\n').length;
        expect(lines).toBeLessThan(1800);
    });

    test('main.ts contains only LLMNotifierProvider', () => {
        expect(mainTs).toMatch(/export default class LLMNotifierProvider/);
        expect(mainTs).not.toMatch(/^class NotificationStore/m);
        expect(mainTs).not.toMatch(/^class LLMNotifier /m);
        expect(mainTs).not.toMatch(/^function escapeHtml/m);
        expect(mainTs).not.toMatch(/^function generateDailyBriefHTML/m);
        expect(mainTs).not.toMatch(/^interface StoredNotification/m);
    });

    test('main.ts has no unused local definitions', () => {
        // Verify no standalone function/class definitions remain (only class methods inside LLMNotifierProvider)
        expect(mainTs).not.toMatch(/^function /m);
        expect(mainTs).not.toMatch(/^async function /m);
        expect(mainTs).not.toMatch(/^class (?!LLMNotifierProvider)/m);
        expect(mainTs).not.toMatch(/^interface /m);
    });
});

// ============================================================================
// Bug Fix: Replay overlay after video ends (Issue #1)
// ============================================================================

// haCardJs: the card file only (no video logic — that's in VideoPlayer now)
const haCardJs = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
// haCardBundle: the full shipped bundle (VideoPlayer + card concatenated)
const haCardBundle = videoPlayerJs + '\n' + haCardJs;

describe('Bug Fix: Replay overlay after video ends', () => {
    test('HA card contains replay-overlay HTML element', () => {
        expect(haCardJs).toContain('replay-overlay');
    });

    test('HA card contains replay-btn element', () => {
        expect(haCardJs).toContain('replay-btn');
    });

    test('HA card has CSS styles for replay-overlay', () => {
        expect(haCardJs).toMatch(/\.replay-overlay\s*\{/);
    });

    test('HA card bundle listens for video ended event', () => {
        // Must have an ended event handler on the video element (in VideoPlayer)
        expect(haCardBundle).toMatch(/\bonended\b|\baddEventListener\s*\(\s*['"]ended['"]/);
    });

    test('VideoPlayer stores notification ID for replay', () => {
        // Must store the notification ID (not clip URL) for replay
        expect(videoPlayerJs).toMatch(/this\._currentNotificationId/);
    });

    test('VideoPlayer close hides replay overlay', () => {
        // The close method must hide the replay overlay
        expect(videoPlayerJs).toMatch(/close\s*\(\)\s*\{[\s\S]*?replay.*display[\s\S]*?none/);
    });

    test('VideoPlayer openVideo hides replay overlay when new video starts', () => {
        // In openVideo, replay overlay should be reset to none
        expect(videoPlayerJs).toMatch(/openVideo[\s\S]*?replayOverlay[\s\S]*?display[\s\S]*?none/);
    });
});

// ============================================================================
// Bug Fix: Stalled playback detector for WebRTC streams
// ============================================================================

describe('Bug Fix: Stalled playback detector for WebRTC streams', () => {
    // All stall detector logic now lives in the shared VideoPlayer class.
    // These tests verify it's present in the shipped bundles (HA card bundle + web UI HTML).

    test('HA card bundle contains startStallDetector', () => {
        expect(haCardBundle).toMatch(/startStallDetector/);
    });

    test('HA card bundle contains stopStallDetector', () => {
        expect(haCardBundle).toMatch(/stopStallDetector/);
    });

    test('VideoPlayer calls startStallDetector in video onplaying handler', () => {
        expect(videoPlayerJs).toMatch(/onplaying[\s\S]*?startStallDetector/);
    });

    test('VideoPlayer calls stopStallDetector in close method', () => {
        expect(videoPlayerJs).toMatch(/close\s*\(\)\s*\{[\s\S]*?stopStallDetector/);
    });

    test('VideoPlayer calls stopStallDetector in replay method', () => {
        expect(videoPlayerJs).toMatch(/replay\s*\(\)\s*\{[\s\S]*?stopStallDetector/);
    });

    test('VideoPlayer stall detector uses requestVideoFrameCallback for frame-based detection', () => {
        expect(videoPlayerJs).toMatch(/requestVideoFrameCallback/);
    });

    test('VideoPlayer stall detector checks video.paused to avoid false triggers', () => {
        expect(videoPlayerJs).toMatch(/\.paused/);
    });

    test('VideoPlayer stall detector uses cancelVideoFrameCallback for cleanup', () => {
        expect(videoPlayerJs).toMatch(/cancelVideoFrameCallback/);
    });

    test('VideoPlayer stall detector declares stallFrameReceived flag', () => {
        expect(videoPlayerJs).toMatch(/stallFrameReceived/);
    });

    test('VideoPlayer stall detector only triggers stall when stallFrameReceived is true', () => {
        expect(videoPlayerJs).toMatch(/stallFrameReceived\s*&&/);
    });

    test('VideoPlayer stall detector resets stallFrameReceived in stopStallDetector', () => {
        const stopBlock = videoPlayerJs.match(/stopStallDetector\s*\(\)\s*\{[\s\S]{0,500}/);
        expect(stopBlock).not.toBeNull();
        expect(stopBlock![0]).toMatch(/stallFrameReceived\s*=\s*false/);
    });

    test('VideoPlayer stall detector wraps requestVideoFrameCallback in try-catch', () => {
        const startBlock = videoPlayerJs.match(/startStallDetector\s*\(\)\s*\{[\s\S]{0,600}/);
        expect(startBlock).not.toBeNull();
        expect(startBlock![0]).toMatch(/try\s*\{[\s\S]*?requestVideoFrameCallback/);
    });

    test('web UI HTML embeds stall detector via VideoPlayer', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toMatch(/startStallDetector/);
        expect(html).toMatch(/stopStallDetector/);
        expect(html).toMatch(/requestVideoFrameCallback/);
        expect(html).toMatch(/cancelVideoFrameCallback/);
        expect(html).toMatch(/stallFrameReceived/);
    });
});

// ============================================================================
// Bug Fix: Replay button race condition (pc.close() fires track ended)
// ============================================================================

describe('Bug Fix: Replay race condition (track ended re-shows overlay)', () => {
    test('VideoPlayer track ended handler guards on _currentPC with instance comparison', () => {
        // When replay closes PC, track ended fires async. Must compare against specific pc instance.
        const trackEndedBlock = videoPlayerJs.match(/track\.addEventListener\('ended'[\s\S]{0,300}/);
        expect(trackEndedBlock).not.toBeNull();
        expect(trackEndedBlock![0]).toMatch(/_currentPC\s*!==\s*pc/);
    });

    test('VideoPlayer replay nulls _currentPC before calling close()', () => {
        // Must null _currentPC before close() so the async track ended handler sees null
        const replayBlock = videoPlayerJs.match(/async replay\s*\(\)\s*\{[\s\S]{0,600}/);
        expect(replayBlock).not.toBeNull();
        const nullIdx = replayBlock![0].indexOf('_currentPC = null');
        const closeIdx = replayBlock![0].indexOf('.close()');
        expect(nullIdx).toBeGreaterThan(-1);
        expect(closeIdx).toBeGreaterThan(-1);
        expect(nullIdx).toBeLessThan(closeIdx);
    });

    test('web UI embeds VideoPlayer with track ended guard via shared code', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        const trackEndedBlock = html.match(/track\.addEventListener\('ended'[\s\S]{0,300}/);
        expect(trackEndedBlock).not.toBeNull();
        expect(trackEndedBlock![0]).toMatch(/_currentPC/);
    });
});

// ============================================================================
// Bug Fix: Video clip duration (Issue #2)
// ============================================================================

describe('Bug Fix: Video clip duration increased to 30s', () => {
    test('HTTP video endpoint uses 10s preroll (startTime = timestamp - 10000)', () => {
        // Find the /brief/video handler and check startTime calculation
        const videoSection = mainTs.match(/path === '\/brief\/video'[\s\S]*?(?=\/\/ High-resolution|\/\/ WebRTC|if \(path ===)/);
        expect(videoSection).not.toBeNull();
        expect(videoSection![0]).toMatch(/notification\.timestamp\s*-\s*10000/);
    });

    test('HTTP video endpoint uses 30s duration', () => {
        const videoSection = mainTs.match(/path === '\/brief\/video'[\s\S]*?(?=\/\/ High-resolution|\/\/ WebRTC|if \(path ===)/);
        expect(videoSection).not.toBeNull();
        expect(videoSection![0]).toMatch(/duration\s*=\s*30000/);
    });

    test('WebRTC endpoint uses 10s preroll (startTime = timestamp - 10000)', () => {
        const webrtcSection = mainTs.match(/path === '\/brief\/webrtc-signal'[\s\S]*?(?=if \(path ===|$)/);
        expect(webrtcSection).not.toBeNull();
        expect(webrtcSection![0]).toMatch(/notification\.timestamp\s*-\s*10000/);
    });

    test('WebRTC endpoint uses 30s duration', () => {
        const webrtcSection = mainTs.match(/path === '\/brief\/webrtc-signal'[\s\S]*?(?=if \(path ===|$)/);
        expect(webrtcSection).not.toBeNull();
        expect(webrtcSection![0]).toMatch(/duration\s*=\s*30000/);
    });
});

// ============================================================================
// Bug Fix: HTTP video URL construction (HA card + web UI dedup)
// ============================================================================

describe('Bug Fix: HTTP video URL construction', () => {
    test('VideoPlayer _loadHttpVideo builds URL via buildUrl with /brief/video path', () => {
        const loadHttpBlock = videoPlayerJs.match(/_loadHttpVideo[\s\S]{0,600}/);
        expect(loadHttpBlock).not.toBeNull();
        expect(loadHttpBlock![0]).toMatch(/buildUrl.*\/brief\/video/);
        // Must NOT use new URL(clipUrl, ...) pattern
        expect(loadHttpBlock![0]).not.toMatch(/new URL\(clipUrl/);
    });

    test('VideoPlayer _loadHttpVideo takes notificationId as first parameter', () => {
        expect(videoPlayerJs).toMatch(/_loadHttpVideo\s*\(\s*notificationId\b/);
    });

    test('HA card does not reference _currentClipUrl anywhere', () => {
        expect(haCardJs).not.toMatch(/_currentClipUrl/);
    });

    test('VideoPlayer does not reference _currentClipUrl anywhere', () => {
        expect(videoPlayerJs).not.toMatch(/_currentClipUrl/);
    });

    test('web UI uses VideoPlayer (which has _loadHttpVideo built in)', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        // VideoPlayer contains _loadHttpVideo
        expect(html).toMatch(/_loadHttpVideo/);
    });

    test('web UI replayVideo delegates to player.replay()', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        const replayBlock = html.match(/function replayVideo[\s\S]{0,300}/);
        expect(replayBlock).not.toBeNull();
        expect(replayBlock![0]).toMatch(/player\.replay/);
    });

    test('VideoPlayer openVideo falls back to HTTP on WebRTC failure', () => {
        // openVideo should call _tryWebRTC then _loadHttpVideo on failure
        const openBlock = videoPlayerJs.match(/async openVideo[\s\S]*?_loadHttpVideo/);
        expect(openBlock).not.toBeNull();
    });

    test('web UI uses currentNotificationId (via VideoPlayer) instead of currentClipUrl', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toMatch(/currentNotificationId/);
        expect(html).not.toMatch(/currentClipUrl/);
    });
});

// ============================================================================
// Streaming video endpoint (sendStream instead of full buffering)
// ============================================================================

describe('Streaming video endpoint', () => {
    test('/brief/video handler uses response.sendStream() instead of Buffer.concat', () => {
        // Must use sendStream for progressive delivery
        expect(mainTs).toMatch(/response\.sendStream\s*\(/);
        // Must NOT buffer the entire MP4 before sending
        expect(mainTs).not.toMatch(/Buffer\.concat\s*\(\s*chunks\s*\)/);
    });

    test('/brief/video handler does not use +faststart flag (incompatible with streaming)', () => {
        // +faststart requires seeking back to rewrite moov atom, incompatible with pipe streaming
        // The movflags should use frag_keyframe+empty_moov but NOT faststart
        const videoHandlerBlock = mainTs.match(/if\s*\(path\s*===\s*'\/brief\/video'\)[\s\S]*?(?=if\s*\(path\s*===|$)/);
        expect(videoHandlerBlock).toBeTruthy();
        expect(videoHandlerBlock![0]).not.toMatch(/faststart/);
    });

    test('/brief/video handler uses frag_keyframe+empty_moov for streaming-compatible MP4', () => {
        const videoHandlerBlock = mainTs.match(/if\s*\(path\s*===\s*'\/brief\/video'\)[\s\S]*?(?=if\s*\(path\s*===|$)/);
        expect(videoHandlerBlock).toBeTruthy();
        expect(videoHandlerBlock![0]).toMatch(/frag_keyframe/);
        expect(videoHandlerBlock![0]).toMatch(/empty_moov/);
    });

    test('/brief/video handler uses async generator to yield FFmpeg chunks', () => {
        // The sendStream pattern requires an async generator function
        expect(mainTs).toMatch(/async\s+function\s*\*|async\s*\*/);
    });

    test('/brief/video handler sets Content-Type video/mp4 in sendStream options', () => {
        // sendStream takes HttpResponseOptions with headers
        const videoHandlerBlock = mainTs.match(/if\s*\(path\s*===\s*'\/brief\/video'\)[\s\S]*?(?=if\s*\(path\s*===|$)/);
        expect(videoHandlerBlock).toBeTruthy();
        expect(videoHandlerBlock![0]).toMatch(/sendStream[\s\S]*?video\/mp4/);
    });

    test('/brief/video handler does not collect chunks into an array', () => {
        const videoHandlerBlock = mainTs.match(/if\s*\(path\s*===\s*'\/brief\/video'\)[\s\S]*?(?=if\s*\(path\s*===|$)/);
        expect(videoHandlerBlock).toBeTruthy();
        // Should not have const chunks: Buffer[] = [] pattern
        expect(videoHandlerBlock![0]).not.toMatch(/const\s+chunks\s*[=:]/);
    });
});

// ============================================================================
// Bug Fix: WebRTC replay, fullscreen replay, audio
// ============================================================================

describe('Bug Fix: WebRTC replay, fullscreen replay, audio', () => {
    // All video logic now lives in VideoPlayer. These tests verify correctness there.

    test('VideoPlayer replay calls _tryWebRTC with _loadHttpVideo fallback', () => {
        const replayBlock = videoPlayerJs.match(/async replay\s*\(\)\s*\{[\s\S]{0,800}/);
        expect(replayBlock).not.toBeNull();
        expect(replayBlock![0]).toMatch(/_tryWebRTC/);
        expect(replayBlock![0]).toMatch(/_loadHttpVideo/);
    });

    test('VideoPlayer _tryWebRTC does not set video.muted = true', () => {
        const tryBlock = videoPlayerJs.match(/_tryWebRTC[\s\S]*?catch/);
        expect(tryBlock).not.toBeNull();
        expect(tryBlock![0]).not.toMatch(/\.muted\s*=\s*true/);
    });

    test('VideoPlayer _loadHttpVideo does not set video.muted = true', () => {
        const loadBlock = videoPlayerJs.match(/_loadHttpVideo[\s\S]{0,800}/);
        expect(loadBlock).not.toBeNull();
        expect(loadBlock![0]).not.toMatch(/\.muted\s*=\s*true/);
    });

    test('VideoPlayer _loadHttpVideo sets video.controls = true before play', () => {
        const loadBlock = videoPlayerJs.match(/_loadHttpVideo[\s\S]{0,800}/);
        expect(loadBlock).not.toBeNull();
        expect(loadBlock![0]).toMatch(/controls\s*=\s*true/);
    });

    test('VideoPlayer openVideo re-enables video controls', () => {
        const openBlock = videoPlayerJs.match(/async openVideo[\s\S]*?_tryWebRTC/);
        expect(openBlock).not.toBeNull();
        expect(openBlock![0]).toContain('.controls = true');
    });

    test('VideoPlayer replay re-enables video controls', () => {
        const replayBlock = videoPlayerJs.match(/async replay\s*\(\)\s*\{[\s\S]{0,400}/);
        expect(replayBlock).not.toBeNull();
        expect(replayBlock![0]).toContain('.controls = true');
    });

    test('VideoPlayer listens for fullscreenchange', () => {
        expect(videoPlayerJs).toMatch(/fullscreenchange/);
    });

    test('web UI replayVideo delegates to player.replay (not inline WebRTC)', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        const replayBlock = html.match(/function replayVideo[\s\S]{0,300}/);
        expect(replayBlock).not.toBeNull();
        expect(replayBlock![0]).toMatch(/player\.replay/);
    });

    test('web UI embeds fullscreenchange listener via VideoPlayer', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toMatch(/fullscreenchange/);
    });
});

// ============================================================================
// Fix: Initial sort order renders newest-first + audio playback
// ============================================================================

describe('Fix: Initial sort order renders newest-first', () => {
    test('timeline segments are rendered newest-first (first data-index is highest)', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Morning text', highlightIds: [] },
            { timeRange: 'Afternoon', text: 'Afternoon text', highlightIds: [] },
            { timeRange: 'Evening', text: 'Evening text', highlightIds: [] }
        ]);
        // Extract all data-index values from timeline-segment elements in order
        const segmentIndices = [...html.matchAll(/class="timeline-segment"\s+data-index="(\d+)"/g)]
            .map(m => parseInt(m[1], 10));
        expect(segmentIndices.length).toBe(3);
        // First segment in HTML should have highest index (newest-first)
        expect(segmentIndices[0]).toBe(2);
        expect(segmentIndices[1]).toBe(1);
        expect(segmentIndices[2]).toBe(0);
    });

    test('highlights are rendered newest-first (first data-index is highest)', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const highlights = [
            { id: 'a', title: 'First', body: 'b1', time: '8:00 AM', snapshotUrl: '' },
            { id: 'b', title: 'Second', body: 'b2', time: '12:00 PM', snapshotUrl: '' },
            { id: 'c', title: 'Third', body: 'b3', time: '6:00 PM', snapshotUrl: '' }
        ];
        // Pass summary to trigger the highlights grid (requires !hasNarrative && summary)
        const html = generateDailyBriefHTML(3, 'Daily summary', highlights, null, '/refresh', 'America/Los_Angeles');
        // Extract data-index values from event-item elements (highlight items) in order
        const highlightIndices = [...html.matchAll(/class="event-item"\s*data-index="(\d+)"/g)]
            .map(m => parseInt(m[1], 10));
        expect(highlightIndices.length).toBe(3);
        // First highlight in HTML should have highest index (newest-first)
        expect(highlightIndices[0]).toBe(2);
        expect(highlightIndices[1]).toBe(1);
        expect(highlightIndices[2]).toBe(0);
    });
});

describe('Fix: Audio playback - video.play() before first await', () => {
    test('VideoPlayer _tryWebRTC calls video.play() before createOffer', () => {
        const between = videoPlayerJs.match(/addTransceiver\('audio'[\s\S]*?createOffer/);
        expect(between).not.toBeNull();
        expect(between![0]).toContain('video.play()');
    });

    test('web UI embeds VideoPlayer with video.play() before createOffer', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        const between = html.match(/addTransceiver\('audio'[\s\S]*?createOffer/);
        expect(between).not.toBeNull();
        expect(between![0]).toContain('video.play()');
    });

    test('VideoPlayer ontrack handler does NOT contain video.play()', () => {
        // Extract the ontrack handler block (ends with closing }; at appropriate indentation)
        const ontrackMatch = videoPlayerJs.match(/pc\.ontrack\s*=\s*function\s*\(event\)\s*\{[\s\S]*?\n\s{4}\};/);
        if (ontrackMatch) {
            expect(ontrackMatch[0]).not.toContain('video.play()');
        } else {
            // Fallback: just verify video.play() is NOT between ontrack and createOffer
            // (it should be AFTER addTransceiver, BEFORE createOffer, at top level)
            const ontrackSection = videoPlayerJs.match(/pc\.ontrack[\s\S]*?pc\.oniceconnectionstatechange/);
            expect(ontrackSection).not.toBeNull();
            expect(ontrackSection![0]).not.toContain('video.play()');
        }
    });

    test('VideoPlayer openVideo re-enables video controls', () => {
        const openBlock = videoPlayerJs.match(/async openVideo[\s\S]*?_tryWebRTC/);
        expect(openBlock).not.toBeNull();
        expect(openBlock![0]).toContain('.controls = true');
    });

    test('VideoPlayer track ended handler guards against stale PC by comparing instance', () => {
        expect(videoPlayerJs).toMatch(/track\.addEventListener\('ended',\s*function\s*\(\)\s*\{[^}]*_currentPC\s*!==\s*pc/);
    });
});

// ============================================================================
// Shared VideoPlayer module
// ============================================================================

describe('Shared VideoPlayer class (ha-card/video-player.js)', () => {
    test('ha-card/video-player.js exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'ha-card/video-player.js'))).toBe(true);
    });

    test('defines class VideoPlayer', () => {
        expect(videoPlayerJs).toMatch(/class VideoPlayer\s*\{/);
    });

    test('VideoPlayer has openVideo method', () => {
        expect(videoPlayerJs).toMatch(/async openVideo\s*\(/);
    });

    test('VideoPlayer has replay method', () => {
        expect(videoPlayerJs).toMatch(/async replay\s*\(/);
    });

    test('VideoPlayer has close method', () => {
        expect(videoPlayerJs).toMatch(/close\s*\(\)\s*\{/);
    });

    test('VideoPlayer has startStallDetector method', () => {
        expect(videoPlayerJs).toMatch(/startStallDetector\s*\(\)\s*\{/);
    });

    test('VideoPlayer has stopStallDetector method', () => {
        expect(videoPlayerJs).toMatch(/stopStallDetector\s*\(\)\s*\{/);
    });

    test('VideoPlayer has destroy method for cleanup', () => {
        expect(videoPlayerJs).toMatch(/destroy\s*\(\)\s*\{/);
    });

    test('VideoPlayer constructor accepts options object', () => {
        expect(videoPlayerJs).toMatch(/constructor\s*\(\s*options\s*\)/);
    });

    test('VideoPlayer stores buildUrl from options', () => {
        expect(videoPlayerJs).toMatch(/this\._buildUrl\s*=\s*options\.buildUrl/);
    });

    test('VideoPlayer stores logPrefix from options', () => {
        expect(videoPlayerJs).toMatch(/this\._logPrefix/);
    });

    // Stall detector internals
    test('VideoPlayer stall detector uses requestVideoFrameCallback', () => {
        expect(videoPlayerJs).toMatch(/requestVideoFrameCallback/);
    });

    test('VideoPlayer stall detector uses cancelVideoFrameCallback', () => {
        expect(videoPlayerJs).toMatch(/cancelVideoFrameCallback/);
    });

    test('VideoPlayer stall detector checks video.paused', () => {
        expect(videoPlayerJs).toMatch(/\.paused/);
    });

    test('VideoPlayer stall detector declares stallFrameReceived', () => {
        expect(videoPlayerJs).toMatch(/stallFrameReceived/);
    });

    test('VideoPlayer stall detector only triggers stall when stallFrameReceived is true', () => {
        expect(videoPlayerJs).toMatch(/stallFrameReceived\s*&&/);
    });

    test('VideoPlayer stopStallDetector resets stallFrameReceived to false', () => {
        const stopBlock = videoPlayerJs.match(/stopStallDetector\s*\(\)\s*\{[\s\S]{0,500}/);
        expect(stopBlock).not.toBeNull();
        expect(stopBlock![0]).toMatch(/stallFrameReceived\s*=\s*false/);
    });

    test('VideoPlayer stall detector wraps requestVideoFrameCallback in try-catch', () => {
        const startBlock = videoPlayerJs.match(/startStallDetector\s*\(\)\s*\{[\s\S]{0,600}/);
        expect(startBlock).not.toBeNull();
        expect(startBlock![0]).toMatch(/try\s*\{[\s\S]*?requestVideoFrameCallback/);
    });

    // WebRTC internals
    test('VideoPlayer _tryWebRTC creates RTCPeerConnection', () => {
        expect(videoPlayerJs).toMatch(/new RTCPeerConnection/);
    });

    test('VideoPlayer _tryWebRTC adds video and audio transceivers', () => {
        expect(videoPlayerJs).toMatch(/addTransceiver\('video'/);
        expect(videoPlayerJs).toMatch(/addTransceiver\('audio'/);
    });

    test('VideoPlayer _tryWebRTC calls video.play() before createOffer', () => {
        const between = videoPlayerJs.match(/addTransceiver\('audio'[\s\S]*?createOffer/);
        expect(between).not.toBeNull();
        expect(between![0]).toContain('video.play()');
    });

    test('VideoPlayer track ended handler guards on _currentPC with instance comparison', () => {
        const trackEndedBlock = videoPlayerJs.match(/track\.addEventListener\('ended'[\s\S]{0,300}/);
        expect(trackEndedBlock).not.toBeNull();
        expect(trackEndedBlock![0]).toMatch(/_currentPC\s*!==\s*pc/);
    });

    // Replay internals
    test('VideoPlayer replay nulls _currentPC before calling close()', () => {
        const replayBlock = videoPlayerJs.match(/async replay\s*\(\)\s*\{[\s\S]{0,600}/);
        expect(replayBlock).not.toBeNull();
        const nullIdx = replayBlock![0].indexOf('_currentPC = null');
        const closeIdx = replayBlock![0].indexOf('.close()');
        expect(nullIdx).toBeGreaterThan(-1);
        expect(closeIdx).toBeGreaterThan(-1);
        expect(nullIdx).toBeLessThan(closeIdx);
    });

    // HTTP fallback internals
    test('VideoPlayer _loadHttpVideo builds URL via buildUrl', () => {
        const loadHttpBlock = videoPlayerJs.match(/_loadHttpVideo[\s\S]{0,600}/);
        expect(loadHttpBlock).not.toBeNull();
        expect(loadHttpBlock![0]).toMatch(/buildUrl.*\/brief\/video/);
    });

    test('VideoPlayer _loadHttpVideo sets video.controls = true', () => {
        const loadHttpBlock = videoPlayerJs.match(/_loadHttpVideo[\s\S]{0,600}/);
        expect(loadHttpBlock).not.toBeNull();
        expect(loadHttpBlock![0]).toMatch(/controls\s*=\s*true/);
    });

    test('VideoPlayer _loadHttpVideo does not set video.muted = true', () => {
        const loadHttpBlock = videoPlayerJs.match(/_loadHttpVideo[\s\S]{0,800}/);
        expect(loadHttpBlock).not.toBeNull();
        expect(loadHttpBlock![0]).not.toMatch(/\.muted\s*=\s*true/);
    });

    test('VideoPlayer _tryWebRTC does not set video.muted = true', () => {
        const tryBlock = videoPlayerJs.match(/_tryWebRTC[\s\S]*?catch/);
        expect(tryBlock).not.toBeNull();
        expect(tryBlock![0]).not.toMatch(/\.muted\s*=\s*true/);
    });
});

describe('VideoPlayer embed pipeline', () => {
    test('HA card bundle contains VideoPlayer class', () => {
        const embedded = fs.readFileSync(path.join(ROOT, 'src/ha-card-embedded.ts'), 'utf-8');
        expect(embedded).toContain('class VideoPlayer');
    });

    test('HA card bundle contains DailyBriefCard class', () => {
        const embedded = fs.readFileSync(path.join(ROOT, 'src/ha-card-embedded.ts'), 'utf-8');
        expect(embedded).toContain('class DailyBriefCard');
    });

    test('video-player-embedded.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/video-player-embedded.ts'))).toBe(true);
    });

    test('video-player-embedded.ts exports VIDEO_PLAYER_JS', () => {
        const embedded = fs.readFileSync(path.join(ROOT, 'src/video-player-embedded.ts'), 'utf-8');
        expect(embedded).toMatch(/export const VIDEO_PLAYER_JS/);
    });

    test('video-player-embedded.ts contains VideoPlayer class', () => {
        const embedded = fs.readFileSync(path.join(ROOT, 'src/video-player-embedded.ts'), 'utf-8');
        expect(embedded).toContain('class VideoPlayer');
    });

    test('web UI HTML embeds VideoPlayer class', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toContain('class VideoPlayer');
    });

    test('HA card daily-brief-card.js uses VideoPlayer (no inline _tryWebRTC)', () => {
        const card = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
        // Card should instantiate VideoPlayer, not define its own _tryWebRTC
        expect(card).toContain('new VideoPlayer');
        expect(card).not.toMatch(/async _tryWebRTC/);
    });

    test('HA card daily-brief-card.js uses VideoPlayer (no inline _loadHttpVideo)', () => {
        const card = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
        expect(card).not.toMatch(/async _loadHttpVideo/);
    });

    test('HA card daily-brief-card.js does not define stall detector functions', () => {
        const card = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
        expect(card).not.toMatch(/function startStallDetector/);
        expect(card).not.toMatch(/function stopStallDetector/);
    });

    test('web UI does not define inline stall detector functions', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        // The VideoPlayer class embeds them, but there should be no standalone function definitions
        // outside the class
        const scriptContent = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
        const allScripts = scriptContent.join('\n');
        // Count occurrences of "function startStallDetector" - should be 0 outside VideoPlayer
        const standaloneStallDefs = allScripts.match(/^(\s*)function startStallDetector/gm);
        // If VideoPlayer is embedded, the method is inside the class, not a standalone function
        // The class defines it as startStallDetector() { ... } not function startStallDetector
        expect(allScripts).not.toMatch(/^\s*function startStallDetector\b/m);
    });

    test('web UI uses VideoPlayer for video playback', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ]);
        expect(html).toContain('new VideoPlayer');
    });

    test('both environments share identical VideoPlayer code', () => {
        // Both embedded files should contain the same VideoPlayer class code
        const haEmbedded = fs.readFileSync(path.join(ROOT, 'src/ha-card-embedded.ts'), 'utf-8');
        const vpEmbedded = fs.readFileSync(path.join(ROOT, 'src/video-player-embedded.ts'), 'utf-8');
        // Both should contain the VideoPlayer class definition
        expect(haEmbedded).toContain('class VideoPlayer');
        expect(vpEmbedded).toContain('class VideoPlayer');
        // Both should contain the same key methods
        expect(haEmbedded).toContain('async openVideo');
        expect(vpEmbedded).toContain('async openVideo');
        expect(haEmbedded).toContain('startStallDetector');
        expect(vpEmbedded).toContain('startStallDetector');
    });
});

// ============================================================================
// Code Review Fixes: embed script safety, blob URL cleanup, snapshot validation
// ============================================================================

// ============================================================================
// Feature: Catch Me Up - Incremental Refresh
// ============================================================================

describe('Catch me up - incremental refresh mode', () => {
    const mainTsCatchUp = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf-8');
    const htmlGen = fs.readFileSync(path.join(ROOT, 'src/daily-brief/html-generator.ts'), 'utf-8');
    const haCardCatchUp = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');

    test('getDailyBriefData accepts mode parameter instead of forceRefresh boolean', () => {
        expect(mainTsCatchUp).toMatch(/mode:\s*['"]normal['"]\s*\|\s*['"]incremental['"]\s*\|\s*['"]full['"]/);
    });

    test('ha-card endpoint parses mode query param', () => {
        expect(mainTsCatchUp).toMatch(/searchParams.*get\s*\(\s*['"]mode['"]\s*\)/);
    });

    test('incremental mode calls generateDailyBriefInBackground(false)', () => {
        // The mode === 'full' check determines forceFullRegeneration = true vs false
        expect(mainTsCatchUp).toMatch(/mode\s*===\s*['"]full['"]/);
        expect(mainTsCatchUp).toMatch(/mode\s*!==\s*['"]normal['"]/);
    });

    test('web UI has catch-up button', () => {
        expect(htmlGen).toMatch(/catchMeUp/);
    });

    test('web UI generateDailyBriefHTML accepts catchUpUrl parameter', () => {
        expect(htmlGen).toMatch(/catchUpUrl/);
    });

    test('web UI refresh button labeled as full regeneration', () => {
        expect(htmlGen).toMatch(/[Ff]ull\s*[Rr]e(generation|fresh)/);
    });

    test('HA card supports mode parameter in _loadData', () => {
        expect(haCardCatchUp).toMatch(/options\.mode|mode.*incremental/);
    });

    test('HA card has catch-up button', () => {
        expect(haCardCatchUp).toMatch(/[Cc]atch.*[Uu]p/);
    });

    test('HA card catch-up sends mode=incremental', () => {
        expect(haCardCatchUp).toMatch(/mode.*['"]incremental['"]/);
    });

    test('HA card refresh sends mode=full', () => {
        expect(haCardCatchUp).toMatch(/mode.*['"]full['"]/);
    });

    test('backward compat: refresh=true still maps to full mode', () => {
        // The endpoint should check refresh=true and map to full mode
        expect(mainTsCatchUp).toMatch(/refresh.*===.*['"]true['"][\s\S]*?['"]full['"]/);
    });

    test('generateDailyBriefHTML functional: catch-up button appears in output', () => {
        const { generateDailyBriefHTML } = require('../src/daily-brief/html-generator');
        const html = generateDailyBriefHTML(5, null, [], null, '/refresh', 'America/Los_Angeles', 'Overview', [
            { timeRange: 'Morning', text: 'Text', highlightIds: [] }
        ], '/catchup');
        expect(html).toContain('catchMeUp');
        expect(html).toContain('/catchup');
        expect(html).toContain('Catch Me Up');
        expect(html).toContain('catchup-btn');
    });

    test('web UI catch-up uses page navigation pattern', () => {
        // catchMeUp reads URL from data attribute and navigates
        expect(htmlGen).toMatch(/window\.location\.href\s*=\s*catchUpUrl/);
    });
});

describe('Code review fix: embed script source file validation', () => {
    test('embed script checks source files exist before reading', () => {
        const embedScript = fs.readFileSync(path.join(ROOT, 'scripts/embed-ha-card.js'), 'utf-8');
        // Should validate both source files exist before reading them
        expect(embedScript).toMatch(/existsSync\(videoPlayerPath\)/);
        expect(embedScript).toMatch(/existsSync\(haCardPath\)/);
        // Should exit with error if missing
        expect(embedScript).toMatch(/process\.exit\(1\)/);
    });
});

// ============================================================================
// Fix: cameraId from media.sourceId (not options.recordedEvent.data.sourceId)
// ============================================================================

describe('cameraId extraction from media.sourceId', () => {
    const llmNotifier = fs.readFileSync(path.join(ROOT, 'src/llm-notifier.ts'), 'utf-8');

    test('extracts cameraId from media.sourceId early in sendNotification', () => {
        // Should extract sourceId from the media object parameter (authoritative source)
        expect(llmNotifier).toMatch(/media\b.*\.sourceId/);
    });

    test('does not use name-based camera lookup fallback', () => {
        // The old pattern: iterating systemState to find camera by deviceName === title
        // This should be completely removed
        expect(llmNotifier).not.toMatch(/deviceName\s*===\s*title/);
    });

    test('does not fall back to unknown for cameraId', () => {
        // Should never use 'unknown' as a fallback cameraId value
        expect(llmNotifier).not.toMatch(/\|\|\s*['"]unknown['"]/);
    });

    test('skips notification storage when cameraId is not available', () => {
        // Should have a guard that checks cameraId before storing
        expect(llmNotifier).toMatch(/!cameraId[\s\S]*?skip.*storage/i);
    });

    test('looks up cameraName from device, not from title', () => {
        // cameraName should come from the device object, not the title parameter
        // The old pattern was: const cameraName = title || 'Unknown Camera'
        expect(llmNotifier).not.toMatch(/cameraName\s*=\s*title/);
    });

    test('looks up camera device by cameraId to get name', () => {
        expect(llmNotifier).toMatch(/getDeviceById\(cameraId\)/);
        expect(llmNotifier).toMatch(/cameraDevice\?\.name/);
    });
});

// ============================================================================
// Fix: Daily Brief scheduled notification + default time
// ============================================================================

describe('Daily Brief notification scheduling', () => {
    const mainTsScheduling = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf-8');

    test('default notification hour is 20 (8 PM)', () => {
        expect(mainTsScheduling).toMatch(/dailyBriefHour[\s\S]*?defaultValue:\s*20/);
    });

    test('uses nullish coalescing for hour (supports midnight)', () => {
        expect(mainTsScheduling).toMatch(/dailyBriefHour\s*\?\?\s*20/);
    });

    test('has test notification method', () => {
        expect(mainTsScheduling).toMatch(/sendTestNotification/);
    });

    test('has test notification button setting', () => {
        expect(mainTsScheduling).toMatch(/dailyBriefTestNotification/);
    });

    test('has test notification endpoint', () => {
        expect(mainTsScheduling).toMatch(/brief\/test-notification/);
    });

    test('logs when scheduled notification triggers', () => {
        expect(mainTsScheduling).toMatch(/Scheduled notification triggered/);
    });

    test('putSetting handles dailyBriefTestNotification', () => {
        expect(mainTsScheduling).toMatch(/key\s*===\s*['"]dailyBriefTestNotification['"]/);
    });

    test('notifier is retrieved directly from storageSettings (not via getDeviceById)', () => {
        // type:'device' (non-multiple) returns device object directly from storageSettings.values
        // Using getDeviceById on it passes the device object as a string, which fails
        expect(mainTsScheduling).toMatch(/dailyBriefNotifier\s*as\s*\(/);
        // sendDailyBriefNotification should NOT use getDeviceById for the notifier
        const sendBlock = mainTsScheduling.match(/sendDailyBriefNotification[\s\S]*?catch/);
        expect(sendBlock).not.toBeNull();
        expect(sendBlock![0]).not.toMatch(/getDeviceById.*dailyBriefNotifier/);
    });

    test('test notification delegates to generateAndNotifySummary (real content)', () => {
        // sendTestNotification method definition should call the full pipeline
        const testBlock = mainTsScheduling.match(/private async sendTestNotification\(\)[\s\S]*?\n    \}/);
        expect(testBlock).not.toBeNull();
        expect(testBlock![0]).toMatch(/generateAndNotifySummary/);
        // Should NOT contain a hardcoded test message
        expect(testBlock![0]).not.toMatch(/Daily Brief Test/);
    });

    test('has notification URL setting', () => {
        expect(mainTsScheduling).toMatch(/dailyBriefNotificationUrl/);
        expect(mainTsScheduling).toMatch(/Notification Click URL/);
    });

    test('HTTP test-notification endpoint delegates to generateAndNotifySummary', () => {
        const endpointBlock = mainTsScheduling.match(/brief\/test-notification[\s\S]*?return;\s*\}/);
        expect(endpointBlock).not.toBeNull();
        expect(endpointBlock![0]).toMatch(/generateAndNotifySummary/);
    });

    test('notification data includes both url (iOS) and clickAction (Android)', () => {
        // sendDailyBriefNotification must send both fields for cross-platform support
        const sendBlock = mainTsScheduling.match(/sendDailyBriefNotification[\s\S]*?Daily Brief notification sent/);
        expect(sendBlock).not.toBeNull();
        // HA plugin only passes options.data.ha.* to the HA notification service
        expect(sendBlock![0]).toMatch(/data:\s*\{\s*ha:\s*\{/);
        expect(sendBlock![0]).toMatch(/url:/);
        expect(sendBlock![0]).toMatch(/clickAction:/);
    });

    test('notification URL setting defaults to /daily-brief/0', () => {
        expect(mainTsScheduling).toMatch(/dailyBriefNotificationUrl[\s\S]*?defaultValue:\s*['"]\/daily-brief\/0['"]/);
    });
});

// ============================================================================
// Catch Me Up loading spinner
// ============================================================================

describe('Catch Me Up loading spinner', () => {
    const haCard = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
    const htmlGen = fs.readFileSync(path.join(ROOT, 'src/daily-brief/html-generator.ts'), 'utf-8');

    test('HA card has .catchup-btn.loading::after spinner CSS', () => {
        expect(haCard).toMatch(/\.catchup-btn\.loading::after\s*\{[^}]*border-radius:\s*50%/);
    });

    test('web UI has .catchup-btn.loading::after spinner CSS', () => {
        expect(htmlGen).toMatch(/\.catchup-btn\.loading::after\s*\{[^}]*border-radius:\s*50%/);
    });

    test('HA card has @keyframes spin', () => {
        expect(haCard).toMatch(/@keyframes\s+spin/);
    });

    test('web UI has @keyframes spin', () => {
        expect(htmlGen).toMatch(/@keyframes\s+spin/);
    });

    test('HA card button text is Updating (no ellipsis)', () => {
        // Should use 'Updating' not 'Updating...' — spinner replaces ellipsis
        expect(haCard).toMatch(/textContent\s*=\s*['"]Updating['"]/);
        expect(haCard).not.toMatch(/textContent\s*=\s*['"]Updating\.\.\.['"]/);
    });

    test('web UI button text is Updating (no ellipsis)', () => {
        expect(htmlGen).toMatch(/['"]Updating['"]/);
        expect(htmlGen).not.toMatch(/['"]Updating\.\.\.['"]/);
    });

    test('web UI has Scrypted favicon', () => {
        expect(htmlGen).toMatch(/link rel="icon".*data:image\/png;base64,/);
    });
});

// ============================================================================
// Catch Me Up animated gradient border
// ============================================================================

describe('Catch Me Up animated gradient border', () => {
    const haCard = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
    const htmlGen = fs.readFileSync(path.join(ROOT, 'src/daily-brief/html-generator.ts'), 'utf-8');

    test('HA card registers --border-angle via CSS.registerProperty', () => {
        expect(haCard).toMatch(/CSS\.registerProperty\(\s*\{[^}]*name:\s*['"]--border-angle['"]/);
    });

    test('web UI registers --border-angle via CSS.registerProperty', () => {
        expect(htmlGen).toMatch(/CSS\.registerProperty\(\s*\{[^}]*name:\s*['"]--border-angle['"]/);
    });

    test('HA card has conic-gradient in .catchup-btn', () => {
        expect(haCard).toMatch(/conic-gradient\(from var\(--border-angle\)/);
    });

    test('web UI has conic-gradient in .catchup-btn', () => {
        expect(htmlGen).toMatch(/conic-gradient\(from var\(--border-angle\)/);
    });

    test('HA card has @keyframes rotate-border', () => {
        expect(haCard).toMatch(/@keyframes\s+rotate-border/);
    });

    test('web UI has @keyframes rotate-border', () => {
        expect(htmlGen).toMatch(/@keyframes\s+rotate-border/);
    });

    test('HA card .catchup-btn:hover has drop-shadow', () => {
        expect(haCard).toMatch(/\.catchup-btn:hover\s*\{[^}]*drop-shadow/);
    });

    test('web UI .catchup-btn:hover has drop-shadow', () => {
        expect(htmlGen).toMatch(/\.catchup-btn:hover\s*\{[^}]*drop-shadow/);
    });

    test('HA card .catchup-btn.loading has animation-name: none', () => {
        expect(haCard).toMatch(/\.catchup-btn\.loading\s*\{[^}]*animation-name:\s*none/);
    });

    test('web UI .catchup-btn.loading has animation-name: none', () => {
        expect(htmlGen).toMatch(/\.catchup-btn\.loading\s*\{[^}]*animation-name:\s*none/);
    });

    test('HA card .catchup-btn has transparent border', () => {
        expect(haCard).toMatch(/\.catchup-btn\s*\{[^}]*border:\s*2px\s+solid\s+transparent/);
    });

    test('web UI .catchup-btn has transparent border', () => {
        expect(htmlGen).toMatch(/\.catchup-btn\s*\{[^}]*border:\s*2px\s+solid\s+transparent/);
    });
});

// ============================================================================
// Video muted by default
// ============================================================================

describe('Video muted by default', () => {
    test('VideoPlayer.openVideo sets video.muted = true', () => {
        expect(videoPlayerJs).toMatch(/video\.muted\s*=\s*true/);
    });
});

// ============================================================================
// Gallery Phase 1: Data Layer — Embeddings
// ============================================================================

describe('Gallery Phase 1: StoredNotification embedding fields', () => {
    const typesTs = fs.readFileSync(path.join(ROOT, 'src/types.ts'), 'utf-8');

    test('StoredNotification has optional embedding field (string)', () => {
        expect(typesTs).toMatch(/embedding\?\s*:\s*string/);
    });

    test('StoredNotification has optional embeddingDimension field (number)', () => {
        expect(typesTs).toMatch(/embeddingDimension\?\s*:\s*number/);
    });
});

describe('Gallery Phase 1: Separate embedding storage', () => {
    const storeTs = fs.readFileSync(path.join(ROOT, 'src/notification-store.ts'), 'utf-8');

    test('NotificationStore has embeddings Map field', () => {
        expect(storeTs).toMatch(/private\s+embeddings\s*:\s*Map/);
    });

    test('NotificationStore uses separate storage key for embeddings', () => {
        expect(storeTs).toMatch(/dailyBriefEmbeddings/);
    });

    test('NotificationStore.addEmbedding method exists', () => {
        expect(storeTs).toMatch(/addEmbedding\s*\(/);
    });

    test('NotificationStore.getEmbedding method exists', () => {
        expect(storeTs).toMatch(/getEmbedding\s*\(/);
    });

    test('NotificationStore.getAllEmbeddings method exists', () => {
        expect(storeTs).toMatch(/getAllEmbeddings\s*\(/);
    });

    test('Embedding pruning syncs with notification pruning', () => {
        // prune() should also clean up stale embeddings
        expect(storeTs).toMatch(/this\.pruneEmbeddings\(\)|this\.embeddings\.delete/);
    });
});

describe('Gallery Phase 1: Embedding extraction in llm-notifier.ts', () => {
    const llmNotifier = fs.readFileSync(path.join(ROOT, 'src/llm-notifier.ts'), 'utf-8');

    test('llm-notifier.ts extracts embedding from detections', () => {
        expect(llmNotifier).toMatch(/det\.embedding/);
    });

    test('llm-notifier.ts computes embeddingDimension from base64 float32', () => {
        // float32 = 4 bytes per element, so dimension = buffer.length / 4
        expect(llmNotifier).toMatch(/\.length\s*\/\s*4/);
    });

    test('llm-notifier.ts calls addEmbedding after storing notification', () => {
        expect(llmNotifier).toMatch(/addEmbedding\s*\(/);
    });
});

describe('Gallery Phase 1: Embedding storage unit tests', () => {
    let store: any;
    const mockStorage: Record<string, string> = {};

    beforeEach(() => {
        // Clear mock storage
        Object.keys(mockStorage).forEach(k => delete mockStorage[k]);
        const storageMock = {
            getItem: (key: string) => mockStorage[key] || null,
            setItem: (key: string, value: string) => { mockStorage[key] = value; },
        };
        const { NotificationStore } = require('../src/notification-store');
        store = new NotificationStore(storageMock);
    });

    test('addEmbedding stores embedding and dimension', () => {
        // Create a float32 array with 3 elements, convert to base64
        const arr = new Float32Array([1.0, 2.0, 3.0]);
        const b64 = Buffer.from(arr.buffer).toString('base64');
        store.addEmbedding('test-id', b64, 3);
        const result = store.getEmbedding('test-id');
        expect(result).toBeDefined();
        expect(result.embedding).toBe(b64);
        expect(result.dimension).toBe(3);
    });

    test('getEmbedding returns undefined for missing id', () => {
        expect(store.getEmbedding('nonexistent')).toBeUndefined();
    });

    test('getAllEmbeddings returns all stored embeddings', () => {
        const arr = new Float32Array([1.0]);
        const b64 = Buffer.from(arr.buffer).toString('base64');
        store.addEmbedding('id1', b64, 1);
        store.addEmbedding('id2', b64, 1);
        const all = store.getAllEmbeddings();
        expect(all.size).toBe(2);
        expect(all.has('id1')).toBe(true);
        expect(all.has('id2')).toBe(true);
    });

    test('embeddings persist to storage on add', () => {
        const arr = new Float32Array([1.0]);
        const b64 = Buffer.from(arr.buffer).toString('base64');
        store.addEmbedding('test-id', b64, 1);
        expect(mockStorage['dailyBriefEmbeddings']).toBeDefined();
        const parsed = JSON.parse(mockStorage['dailyBriefEmbeddings']);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(1);
        expect(parsed[0][0]).toBe('test-id');
    });

    test('embeddings load from storage on construction', () => {
        const arr = new Float32Array([1.0, 2.0]);
        const b64 = Buffer.from(arr.buffer).toString('base64');
        // Pre-populate storage
        mockStorage['dailyBriefEmbeddings'] = JSON.stringify([['preloaded-id', { embedding: b64, dimension: 2 }]]);
        const { NotificationStore } = require('../src/notification-store');
        const store2 = new NotificationStore({
            getItem: (key: string) => mockStorage[key] || null,
            setItem: (key: string, value: string) => { mockStorage[key] = value; },
        });
        const result = store2.getEmbedding('preloaded-id');
        expect(result).toBeDefined();
        expect(result.dimension).toBe(2);
    });

    test('embeddings pruned when notification is pruned', () => {
        // Add a notification and embedding
        const notification = {
            id: 'old-notif',
            timestamp: Date.now() - (4 * 24 * 60 * 60 * 1000), // 4 days ago (> 3 day retention)
            cameraId: 'cam1', cameraName: 'Test', detectionType: 'person',
            names: [], llmTitle: 'T', llmSubtitle: 'S', llmBody: 'B'
        };
        store.add(notification);
        const arr = new Float32Array([1.0]);
        const b64 = Buffer.from(arr.buffer).toString('base64');
        store.addEmbedding('old-notif', b64, 1);

        // Also add a current notification + embedding
        const currentNotif = {
            id: 'new-notif',
            timestamp: Date.now(),
            cameraId: 'cam1', cameraName: 'Test', detectionType: 'person',
            names: [], llmTitle: 'T', llmSubtitle: 'S', llmBody: 'B'
        };
        store.add(currentNotif);
        store.addEmbedding('new-notif', b64, 1);

        // Old notification should be pruned (> 3 days), so embedding should be gone too
        expect(store.getEmbedding('old-notif')).toBeUndefined();
        // New notification embedding should still exist
        expect(store.getEmbedding('new-notif')).toBeDefined();
    });
});

// ============================================================================
// Gallery Phase 2: Search & Gallery Backend
// ============================================================================

describe('Gallery Phase 2: gallery.ts exists and exports', () => {
    const galleryPath = path.join(ROOT, 'src/gallery.ts');

    test('src/gallery.ts exists', () => {
        expect(fs.existsSync(galleryPath)).toBe(true);
    });

    test('gallery.ts exports cosineDistance function', () => {
        const gallery = fs.readFileSync(galleryPath, 'utf-8');
        expect(gallery).toMatch(/export function cosineDistance/);
    });

    test('gallery.ts exports decodeEmbedding function', () => {
        const gallery = fs.readFileSync(galleryPath, 'utf-8');
        expect(gallery).toMatch(/export function decodeEmbedding/);
    });

    test('gallery.ts exports findTextEmbeddingProvider function', () => {
        const gallery = fs.readFileSync(galleryPath, 'utf-8');
        expect(gallery).toMatch(/export async function findTextEmbeddingProvider/);
    });

    test('gallery.ts exports handleGalleryDataRequest function', () => {
        const gallery = fs.readFileSync(galleryPath, 'utf-8');
        expect(gallery).toMatch(/export async function handleGalleryDataRequest/);
    });

    test('gallery.ts exports handleGallerySearchRequest function', () => {
        const gallery = fs.readFileSync(galleryPath, 'utf-8');
        expect(gallery).toMatch(/export async function handleGallerySearchRequest/);
    });

    test('gallery.ts exports handleThumbnailRequest function', () => {
        const gallery = fs.readFileSync(galleryPath, 'utf-8');
        expect(gallery).toMatch(/export async function handleThumbnailRequest/);
    });
});

describe('Gallery Phase 2: cosineDistance unit tests', () => {
    let cosineDistance: (a: Float32Array, b: Float32Array) => number;
    let decodeEmbedding: (base64: string) => Float32Array;

    beforeAll(() => {
        const gallery = require('../src/gallery');
        cosineDistance = gallery.cosineDistance;
        decodeEmbedding = gallery.decodeEmbedding;
    });

    test('identical vectors return 1.0', () => {
        const v = new Float32Array([1, 2, 3]);
        expect(cosineDistance(v, v)).toBeCloseTo(1.0, 5);
    });

    test('orthogonal vectors return 0.0', () => {
        const a = new Float32Array([1, 0]);
        const b = new Float32Array([0, 1]);
        expect(cosineDistance(a, b)).toBeCloseTo(0.0, 5);
    });

    test('opposite vectors return -1.0', () => {
        const a = new Float32Array([1, 0]);
        const b = new Float32Array([-1, 0]);
        expect(cosineDistance(a, b)).toBeCloseTo(-1.0, 5);
    });

    test('similar vectors return value between 0 and 1', () => {
        const a = new Float32Array([1, 1]);
        const b = new Float32Array([1, 0.5]);
        const result = cosineDistance(a, b);
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThan(1);
    });

    test('zero vector returns 0', () => {
        const a = new Float32Array([0, 0, 0]);
        const b = new Float32Array([1, 2, 3]);
        expect(cosineDistance(a, b)).toBe(0);
    });
});

describe('Gallery Phase 2: decodeEmbedding unit tests', () => {
    let decodeEmbedding: (base64: string) => Float32Array;

    beforeAll(() => {
        const gallery = require('../src/gallery');
        decodeEmbedding = gallery.decodeEmbedding;
    });

    test('correctly converts base64 to Float32Array', () => {
        const original = new Float32Array([1.0, 2.0, 3.0]);
        const b64 = Buffer.from(original.buffer).toString('base64');
        const decoded = decodeEmbedding(b64);
        expect(decoded.length).toBe(3);
        expect(decoded[0]).toBeCloseTo(1.0);
        expect(decoded[1]).toBeCloseTo(2.0);
        expect(decoded[2]).toBeCloseTo(3.0);
    });

    test('handles single-element embedding', () => {
        const original = new Float32Array([42.5]);
        const b64 = Buffer.from(original.buffer).toString('base64');
        const decoded = decodeEmbedding(b64);
        expect(decoded.length).toBe(1);
        expect(decoded[0]).toBeCloseTo(42.5);
    });
});

describe('Gallery Phase 2: keywordSearch unit tests', () => {
    let keywordSearch: (query: string, notifications: any[]) => any[];

    beforeAll(() => {
        const gallery = require('../src/gallery');
        keywordSearch = gallery.keywordSearch;
    });

    test('matches on llmTitle', () => {
        const notifs = [
            { id: '1', llmTitle: 'Person at door', llmSubtitle: '', llmBody: '', cameraName: '', names: [] },
            { id: '2', llmTitle: 'Cat in garden', llmSubtitle: '', llmBody: '', cameraName: '', names: [] },
        ];
        const results = keywordSearch('person', notifs);
        expect(results.length).toBe(1);
        expect(results[0].id).toBe('1');
    });

    test('matches on cameraName', () => {
        const notifs = [
            { id: '1', llmTitle: 'Motion', llmSubtitle: '', llmBody: '', cameraName: 'Front Door', names: [] },
            { id: '2', llmTitle: 'Motion', llmSubtitle: '', llmBody: '', cameraName: 'Backyard', names: [] },
        ];
        const results = keywordSearch('front', notifs);
        expect(results.length).toBe(1);
        expect(results[0].id).toBe('1');
    });

    test('matches on names array', () => {
        const notifs = [
            { id: '1', llmTitle: 'Person', llmSubtitle: '', llmBody: '', cameraName: '', names: ['Richard'] },
            { id: '2', llmTitle: 'Person', llmSubtitle: '', llmBody: '', cameraName: '', names: ['Sarah'] },
        ];
        const results = keywordSearch('richard', notifs);
        expect(results.length).toBe(1);
        expect(results[0].id).toBe('1');
    });

    test('case-insensitive matching', () => {
        const notifs = [
            { id: '1', llmTitle: 'PERSON AT DOOR', llmSubtitle: '', llmBody: '', cameraName: '', names: [] },
        ];
        const results = keywordSearch('person at door', notifs);
        expect(results.length).toBe(1);
    });

    test('matches on detailedDescription', () => {
        const notifs = [
            { id: '1', llmTitle: 'Motion', llmSubtitle: '', llmBody: '', cameraName: '', names: [], detailedDescription: 'A blue car parked in driveway' },
        ];
        const results = keywordSearch('blue car', notifs);
        expect(results.length).toBe(1);
    });

    test('returns empty for no matches', () => {
        const notifs = [
            { id: '1', llmTitle: 'Person', llmSubtitle: '', llmBody: '', cameraName: '', names: [] },
        ];
        const results = keywordSearch('elephant', notifs);
        expect(results.length).toBe(0);
    });
});

describe('Gallery Phase 2: getGalleryPage unit tests', () => {
    let getGalleryPage: (notifications: any[], page: number, pageSize: number, filters: any, embeddings?: Map<string, any>, baseUrl?: string) => any;

    beforeAll(() => {
        const gallery = require('../src/gallery');
        getGalleryPage = gallery.getGalleryPage;
    });

    const makeNotif = (id: string, overrides: any = {}) => ({
        id,
        timestamp: Date.now(),
        cameraId: 'cam1',
        cameraName: 'Front Door',
        detectionType: 'person',
        names: [],
        llmTitle: 'Person detected',
        llmSubtitle: 'Person • Front',
        llmBody: 'Walking toward door',
        ...overrides,
    });

    test('returns correct page of results', () => {
        const notifs = Array.from({ length: 10 }, (_, i) => makeNotif(`n${i}`));
        const result = getGalleryPage(notifs, 1, 5, {});
        expect(result.notifications.length).toBe(5);
        expect(result.total).toBe(10);
        expect(result.page).toBe(1);
        expect(result.hasMore).toBe(true);
    });

    test('last page has hasMore=false', () => {
        const notifs = Array.from({ length: 8 }, (_, i) => makeNotif(`n${i}`));
        const result = getGalleryPage(notifs, 2, 5, {});
        expect(result.notifications.length).toBe(3);
        expect(result.hasMore).toBe(false);
    });

    test('filters by camera', () => {
        const notifs = [
            makeNotif('1', { cameraName: 'Front Door' }),
            makeNotif('2', { cameraName: 'Backyard' }),
            makeNotif('3', { cameraName: 'Front Door' }),
        ];
        const result = getGalleryPage(notifs, 1, 50, { camera: 'Front Door' });
        expect(result.notifications.length).toBe(2);
        expect(result.total).toBe(2);
    });

    test('filters by detection type', () => {
        const notifs = [
            makeNotif('1', { detectionType: 'person' }),
            makeNotif('2', { detectionType: 'vehicle' }),
            makeNotif('3', { detectionType: 'person' }),
        ];
        const result = getGalleryPage(notifs, 1, 50, { type: 'person' });
        expect(result.notifications.length).toBe(2);
    });

    test('filters by name', () => {
        const notifs = [
            makeNotif('1', { names: ['Richard'] }),
            makeNotif('2', { names: [] }),
            makeNotif('3', { names: ['Sarah', 'Richard'] }),
        ];
        const result = getGalleryPage(notifs, 1, 50, { name: 'Richard' });
        expect(result.notifications.length).toBe(2);
    });

    test('returns filter options from all notifications', () => {
        const notifs = [
            makeNotif('1', { cameraName: 'Front Door', detectionType: 'person', names: ['Richard'] }),
            makeNotif('2', { cameraName: 'Backyard', detectionType: 'vehicle', names: [] }),
        ];
        const result = getGalleryPage(notifs, 1, 50, {});
        expect(result.filters.cameras).toContain('Front Door');
        expect(result.filters.cameras).toContain('Backyard');
        expect(result.filters.types).toContain('person');
        expect(result.filters.types).toContain('vehicle');
        expect(result.filters.names).toContain('Richard');
    });

    test('returns thumbnailUrl instead of inline base64', () => {
        const notifs = [makeNotif('1', { thumbnailB64: 'abc123' })];
        const result = getGalleryPage(notifs, 1, 50, {});
        expect(result.notifications[0].thumbnailUrl).toBeDefined();
        expect(result.notifications[0].thumbnailB64).toBeUndefined();
    });

    test('includes hasEmbedding flag', () => {
        const notifs = [makeNotif('1')];
        const embeddings = new Map([['1', { embedding: 'b64', dimension: 3 }]]);
        const result = getGalleryPage(notifs, 1, 50, {}, embeddings);
        expect(result.notifications[0].hasEmbedding).toBe(true);
    });
});

describe('Gallery Phase 2: main.ts routes gallery endpoints', () => {
    test('main.ts imports from ./gallery', () => {
        expect(mainTs).toMatch(/from\s+['"]\.\/gallery['"]/);
    });

    test('main.ts routes /brief/gallery/data', () => {
        expect(mainTs).toMatch(/\/brief\/gallery\/data/);
    });

    test('main.ts routes /brief/gallery/search', () => {
        expect(mainTs).toMatch(/\/brief\/gallery\/search/);
    });

    test('main.ts routes /brief/thumbnail', () => {
        expect(mainTs).toMatch(/\/brief\/thumbnail/);
    });
});

// ============================================================================
// Gallery Phase 3: Shared Gallery UI
// ============================================================================

describe('Gallery Phase 3: gallery.js exists and structure', () => {
    const galleryJsPath = path.join(ROOT, 'ha-card/gallery.js');

    test('ha-card/gallery.js exists', () => {
        expect(fs.existsSync(galleryJsPath)).toBe(true);
    });

    test('gallery.js defines Gallery class', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/class Gallery\s*\{/);
    });

    test('Gallery has constructor accepting options', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/constructor\s*\(\s*options\s*\)/);
    });

    test('Gallery has init method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/async\s+init\s*\(/);
    });

    test('Gallery has search method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/async\s+search\s*\(/);
    });

    test('Gallery has applyFilters method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/async\s+applyFilters\s*\(/);
    });

    test('Gallery has loadMore method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/async\s+loadMore\s*\(/);
    });

    test('Gallery has destroy method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/destroy\s*\(/);
    });

    test('Gallery has _renderShell method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/_renderShell\s*\(/);
    });

    test('Gallery has _renderCards method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/_renderCards\s*\(/);
    });

    test('Gallery has _onSearchInput method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/_onSearchInput\s*\(/);
    });

    test('Gallery has _onCardClick method', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/_onCardClick\s*\(/);
    });

    test('Gallery uses CSS theme variables', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/--bg-primary|--bg-secondary|--text-primary|--accent/);
    });

    test('Gallery uses responsive grid', () => {
        const js = fs.readFileSync(galleryJsPath, 'utf-8');
        expect(js).toMatch(/auto-fill.*minmax.*160px/);
    });
});

describe('Gallery Phase 3: gallery-embedded.ts build output', () => {
    test('src/gallery-embedded.ts exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'src/gallery-embedded.ts'))).toBe(true);
    });

    test('gallery-embedded.ts exports GALLERY_JS', () => {
        const embedded = fs.readFileSync(path.join(ROOT, 'src/gallery-embedded.ts'), 'utf-8');
        expect(embedded).toMatch(/export const GALLERY_JS/);
    });

    test('gallery-embedded.ts contains Gallery class', () => {
        const embedded = fs.readFileSync(path.join(ROOT, 'src/gallery-embedded.ts'), 'utf-8');
        expect(embedded).toMatch(/class Gallery/);
    });
});

describe('Gallery Phase 3: embed script updated', () => {
    const embedScript = fs.readFileSync(path.join(ROOT, 'scripts/embed-ha-card.js'), 'utf-8');

    test('embed script reads gallery.js', () => {
        expect(embedScript).toMatch(/gallery\.js/);
    });

    test('embed script outputs gallery-embedded.ts', () => {
        expect(embedScript).toMatch(/gallery-embedded\.ts/);
    });
});

// ============================================================================
// Gallery Phase 4: Web UI Integration
// ============================================================================

describe('Gallery Phase 4: html-generator tab bar', () => {
    const htmlGen = fs.readFileSync(path.join(ROOT, 'src/daily-brief/html-generator.ts'), 'utf-8');

    test('html-generator imports GALLERY_JS', () => {
        expect(htmlGen).toMatch(/import.*GALLERY_JS.*from.*gallery-embedded/);
    });

    test('html-generator has tab bar HTML', () => {
        expect(htmlGen).toMatch(/tab-bar/);
    });

    test('html-generator has Brief tab button', () => {
        expect(htmlGen).toMatch(/data-tab=.*brief/);
    });

    test('html-generator has Gallery tab button', () => {
        expect(htmlGen).toMatch(/data-tab=.*gallery/);
    });

    test('html-generator has brief tab content container', () => {
        expect(htmlGen).toMatch(/id=.*brief-tab/);
    });

    test('html-generator has gallery tab content container', () => {
        expect(htmlGen).toMatch(/id=.*gallery-tab/);
    });

    test('gallery tab hidden by default', () => {
        expect(htmlGen).toMatch(/gallery-tab.*display:\s*none|gallery-tab.*hidden/);
    });

    test('html-generator embeds GALLERY_JS', () => {
        expect(htmlGen).toMatch(/\$\{GALLERY_JS\}/);
    });

    test('html-generator has Gallery CSS injection', () => {
        expect(htmlGen).toMatch(/Gallery\.CSS/);
    });

    test('html-generator has tab switching logic', () => {
        expect(htmlGen).toMatch(/tab.*onclick|querySelectorAll.*\.tab/);
    });

    test('html-generator supports ?tab=gallery URL param', () => {
        expect(htmlGen).toMatch(/tab=gallery|searchParams.*tab/);
    });

    test('html-generator lazy-inits gallery on first tab click', () => {
        expect(htmlGen).toMatch(/gallery\.init|galleryInitialized/);
    });

    test('Gallery shares VideoPlayer with Brief via openVideoModal', () => {
        expect(htmlGen).toMatch(/openVideoModal/);
    });
});

// ============================================================================
// Gallery Phase 5: HA Card Link + Polish
// ============================================================================

describe('Gallery Phase 5: HA Card Gallery tab', () => {
    const haCard = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');

    test('HA card has Gallery tab (not external link)', () => {
        expect(haCard).toMatch(/data-tab="gallery"/);
        expect(haCard).not.toMatch(/gallery-link/);
    });

    test('Gallery tab initializes Gallery class', () => {
        expect(haCard).toMatch(/new Gallery\(/);
    });
});

describe('Gallery Phase 5: Gallery UI polish', () => {
    const galleryJs = fs.readFileSync(path.join(ROOT, 'ha-card/gallery.js'), 'utf-8');

    test('Gallery has loading state', () => {
        expect(galleryJs).toMatch(/_showLoading|Loading\.\.\./);
    });

    test('Gallery has empty state', () => {
        expect(galleryJs).toMatch(/_renderEmpty/);
    });

    test('Gallery has search mode indicator', () => {
        expect(galleryJs).toMatch(/_renderSearchMode|mode-indicator/);
    });

    test('Gallery has debounced search (400ms)', () => {
        expect(galleryJs).toMatch(/400/);
    });

    test('Gallery has Escape key to clear search', () => {
        expect(galleryJs).toMatch(/Escape/);
    });

    test('Gallery card has hover effect', () => {
        expect(galleryJs).toMatch(/hover.*transform|scale/);
    });
});

// ============================================================================
// Poster Store: Disk-based poster storage (replaces in-memory snapshotCache)
// ============================================================================

describe('Poster Store: No in-memory image caching', () => {
    test('main.ts does NOT declare snapshotCache LRU', () => {
        // HARD RULE: No in-memory caching of images
        expect(mainTs).not.toMatch(/snapshotCache\s*=\s*new\s+LRUCache/);
    });

    test('main.ts declares posterStore property', () => {
        expect(mainTs).toMatch(/posterStore:\s*PosterStore/);
    });

    test('main.ts imports PosterStore', () => {
        expect(mainTs).toMatch(/import.*PosterStore.*from\s+['"]\.\/poster-store['"]/);
    });
});

describe('Poster Store: Write poster to disk at detection time', () => {
    const llmNotifier = fs.readFileSync(path.join(ROOT, 'src/llm-notifier.ts'), 'utf-8');

    test('llm-notifier writes poster via posterStore.put()', () => {
        expect(llmNotifier).toMatch(/posterStore\.put\(/);
    });

    test('llm-notifier does NOT use snapshotCache', () => {
        expect(llmNotifier).not.toMatch(/snapshotCache/);
    });

    test('llm-notifier prefers fullFrameUrl over imageUrl for poster', () => {
        expect(llmNotifier).toMatch(/fullFrameUrl\s*\|\|\s*imageUrl/);
    });

    test('llm-notifier sets hasPoster on stored notification', () => {
        // The storedNotification object should include the hasPoster field
        expect(llmNotifier).toMatch(/hasPoster:\s*hasPosterFlag/);
    });
});

describe('Poster Store: Serve from disk in /brief/snapshot', () => {
    test('/brief/snapshot checks posterStore first', () => {
        const snapshotHandlerStart = mainTs.indexOf("path === '/brief/snapshot'");
        const posterGet = mainTs.indexOf('posterStore.get', snapshotHandlerStart);
        expect(snapshotHandlerStart).toBeGreaterThan(-1);
        expect(posterGet).toBeGreaterThan(snapshotHandlerStart);
    });

    test('/brief/snapshot does NOT use snapshotCache', () => {
        const snapshotHandlerStart = mainTs.indexOf("path === '/brief/snapshot'");
        const handlerBlock = mainTs.substring(snapshotHandlerStart, snapshotHandlerStart + 5000);
        expect(handlerBlock).not.toMatch(/snapshotCache/);
    });
});

// ============================================================================
// Poster Image Quality: Brief & Gallery use /brief/snapshot instead of thumbnails
// ============================================================================

describe('Snapshot endpoint: fallback chain ordering', () => {
    // The /brief/snapshot handler must check posterStore BEFORE checking VideoRecorder
    // so disk-cached posters are served instantly without requiring a camera lookup.

    // Helper: extract the /brief/snapshot handler block from main.ts
    function getSnapshotBlock(): string {
        const startMarker = "if (path === '/brief/snapshot')";
        const startIdx = mainTs.indexOf(startMarker);
        expect(startIdx).toBeGreaterThan(-1);
        // Grab enough to cover the handler; ends at next top-level path check
        const slice = mainTs.substring(startIdx, startIdx + 5000);
        const endMatch = slice.match(/\n        \/\/ \w[\s\S]*?\n        if \(path === /);
        return slice.substring(0, endMatch ? endMatch.index! : slice.length);
    }

    test('posterStore.get() is first check in snapshot handler', () => {
        const block = getSnapshotBlock();
        const posterGetPos = block.indexOf('posterStore.get(');
        expect(posterGetPos).toBeGreaterThan(-1);
    });

    test('thumbnailB64 fallback exists before 404 in snapshot endpoint', () => {
        const block = getSnapshotBlock();

        // Should have a thumbnailB64 fallback path
        expect(block).toMatch(/thumbnailB64/);
        // The fallback should decode base64 to buffer
        expect(block).toMatch(/Buffer\.from\(.*thumbnailB64.*['"]base64['"]/);
    });
});

describe('Gallery uses /brief/snapshot for images', () => {
    const galleryTs = fs.readFileSync(path.join(ROOT, 'src/gallery.ts'), 'utf-8');

    test('getGalleryPage builds thumbnailUrl with /brief/snapshot', () => {
        const fnBlock = galleryTs.match(/function getGalleryPage[\s\S]*?^}/m);
        expect(fnBlock).not.toBeNull();
        expect(fnBlock![0]).toMatch(/\/brief\/snapshot\?id=/);
    });

    test('semanticSearch builds thumbnailUrl with /brief/snapshot', () => {
        const fnBlock = galleryTs.match(/function semanticSearch[\s\S]*?^}/m);
        expect(fnBlock).not.toBeNull();
        expect(fnBlock![0]).toMatch(/\/brief\/snapshot\?id=/);
    });

    test('handleGallerySearchRequest keyword fallback uses /brief/snapshot', () => {
        const fnBlock = galleryTs.match(/function handleGallerySearchRequest[\s\S]*?^}/m);
        expect(fnBlock).not.toBeNull();
        expect(fnBlock![0]).toMatch(/\/brief\/snapshot\?id=/);
    });

    test('no /brief/thumbnail references remain in gallery.ts', () => {
        expect(galleryTs).not.toMatch(/\/brief\/thumbnail/);
    });

    test('gallery thumbnail URLs check hasPoster in addition to thumbnailB64', () => {
        // All 5 thumbnail URL conditionals should use (n.hasPoster || n.thumbnailB64) pattern
        const matches = galleryTs.match(/n\.hasPoster\s*\|\|\s*n\.thumbnailB64/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(5);
    });
});

describe('highlights.ts uses hasPoster for thumbnail marker', () => {
    const highlightsTs = fs.readFileSync(path.join(ROOT, 'src/daily-brief/highlights.ts'), 'utf-8');

    test('buildCachedHighlights checks hasPoster for thumbnail field', () => {
        // Should use (n.hasPoster || n.thumbnailB64) pattern for the thumbnail field
        expect(highlightsTs).toMatch(/n\.hasPoster\s*\|\|\s*n\.thumbnailB64/);
    });

    test('buildCachedHighlights uses poster marker for poster-only notifications', () => {
        // When hasPoster is true but no thumbnailB64, should use a truthy marker string
        expect(highlightsTs).toMatch(/'poster'/);
    });
});

describe('getDailyBriefData rewrites thumbnail URLs at serve time', () => {
    test('thumbnail is rewritten to /brief/snapshot URL when baseUrl is available', () => {
        // Find the highlights .map() block inside getDailyBriefData
        const mapStart = mainTs.indexOf('// Build highlights with optional video clip and poster-quality snapshot URLs');
        expect(mapStart).toBeGreaterThan(-1);
        const mapBlock = mainTs.substring(mapStart, mapStart + 500);

        // Should rewrite thumbnail to /brief/snapshot URL
        expect(mapBlock).toMatch(/thumbnail:.*\/brief\/snapshot/);
    });
});

describe('Web UI /brief endpoint passes baseUrl to getDailyBriefData', () => {
    test('/brief endpoint passes request.rootPath as baseUrl', () => {
        // Find the web UI /brief handler block that calls getDailyBriefData
        const marker = '// Use shared helper for data fetching';
        const markerIdx = mainTs.indexOf(marker);
        expect(markerIdx).toBeGreaterThan(-1);
        const callBlock = mainTs.substring(markerIdx, markerIdx + 200);

        // Should include rootPath as the 5th argument
        expect(callBlock).toMatch(/getDailyBriefData\([^)]*request\.rootPath/);
    });
});

// ============================================================================
// Configurable Gallery Retention
// ============================================================================

const notificationStoreTs = fs.readFileSync(path.join(ROOT, 'src/notification-store.ts'), 'utf-8');
const galleryTs = fs.readFileSync(path.join(ROOT, 'src/gallery.ts'), 'utf-8');

describe('NotificationStore configurable retention', () => {
    test('has setRetentionDays method', () => {
        expect(notificationStoreTs).toMatch(/setRetentionDays\s*\(/);
    });

    test('has retentionDays private field', () => {
        expect(notificationStoreTs).toMatch(/private\s+retentionDays/);
    });

    test('prune() uses this.retentionDays instead of hardcoded 3', () => {
        // Should NOT have the hardcoded 3 * 24 * 60 * 60 * 1000
        expect(notificationStoreTs).not.toMatch(/3\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
        // Should reference this.retentionDays in the maxAge calculation
        expect(notificationStoreTs).toMatch(/this\.retentionDays\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    });

    test('setRetentionDays clamps to minimum of 1', () => {
        // The setter should use Math.max(1, ...) or equivalent clamping
        expect(notificationStoreTs).toMatch(/Math\.max\s*\(\s*1/);
    });

    test('setRetentionDays guards against NaN', () => {
        expect(notificationStoreTs).toMatch(/isNaN/);
    });

    test('has public pruneNow method', () => {
        expect(notificationStoreTs).toMatch(/pruneNow\s*\(/);
    });

    test('putSetting calls pruneNow after changing retentionDays', () => {
        const putSettingStart = mainTs.indexOf('async putSetting');
        expect(putSettingStart).toBeGreaterThan(-1);
        const putSettingBlock = mainTs.substring(putSettingStart, putSettingStart + 800);
        expect(putSettingBlock).toContain('pruneNow');
    });
});

describe('Gallery configurable retention', () => {
    test('semanticSearch accepts retentionDays parameter', () => {
        expect(galleryTs).toMatch(/semanticSearch\s*\([^)]*retentionDays/);
    });

    test('handleGallerySearchRequest accepts retentionDays parameter', () => {
        expect(galleryTs).toMatch(/handleGallerySearchRequest\s*\([^)]*retentionDays/);
    });

    test('gallery.ts does not have hardcoded 3 * 24 * 60 * 60 * 1000', () => {
        expect(galleryTs).not.toMatch(/3\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    });

    test('semanticSearch uses retentionDays in recency calculation', () => {
        expect(galleryTs).toMatch(/retentionDays.*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    });
});

describe('main.ts Gallery retention wiring', () => {
    test('storageSettings defines retentionDays setting', () => {
        expect(mainTs).toMatch(/retentionDays\s*:\s*\{/);
        expect(mainTs).toMatch(/Gallery Retention/);
    });

    test('retentionDays is in orderedKeys', () => {
        const orderedStart = mainTs.indexOf('const orderedKeys');
        expect(orderedStart).toBeGreaterThan(-1);
        const orderedBlock = mainTs.substring(orderedStart, mainTs.indexOf('];', orderedStart) + 2);
        expect(orderedBlock).toContain("'retentionDays'");
    });

    test('constructor wires retentionDays to notificationStore', () => {
        expect(mainTs).toMatch(/setRetentionDays/);
    });

    test('putSetting handles retentionDays changes', () => {
        const putSettingStart = mainTs.indexOf('async putSetting');
        expect(putSettingStart).toBeGreaterThan(-1);
        const putSettingBlock = mainTs.substring(putSettingStart, putSettingStart + 800);
        expect(putSettingBlock).toContain('retentionDays');
    });

    test('handleGallerySearchRequest call passes retentionDays', () => {
        const searchCallIdx = mainTs.indexOf('handleGallerySearchRequest(');
        expect(searchCallIdx).toBeGreaterThan(-1);
        const searchCall = mainTs.substring(searchCallIdx, searchCallIdx + 200);
        expect(searchCall).toMatch(/retentionDays/);
    });

    test('has periodic prune timer', () => {
        expect(mainTs).toMatch(/pruneIntervalTimer/);
        expect(mainTs).toMatch(/startPruneTimer/);
    });

    test('snapshot endpoint does not use NVR fallback (removed for performance)', () => {
        const snapshotIdx = mainTs.indexOf("path === '/brief/snapshot'");
        expect(snapshotIdx).toBeGreaterThan(-1);
        const afterSnapshot = mainTs.substring(snapshotIdx, snapshotIdx + 3000);
        expect(afterSnapshot).not.toMatch(/Disk MISS/);
        expect(afterSnapshot).not.toMatch(/getRecordingStreamThumbnail/);
    });
});

// ============================================================================
// Gallery Performance: Remove in-memory snapshot cache & NVR fallback
// ============================================================================

describe('Gallery Performance: no in-memory snapshot cache', () => {
    const galleryJs = fs.readFileSync(path.join(ROOT, 'ha-card/gallery.js'), 'utf-8');

    test('video-player.js does not have _snapshotCache property', () => {
        expect(videoPlayerJs).not.toMatch(/_snapshotCache/);
    });

    test('video-player.js does not have prefetchSnapshot method', () => {
        expect(videoPlayerJs).not.toMatch(/prefetchSnapshot/);
    });

    test('video-player.js does not have getCachedSnapshot method', () => {
        expect(videoPlayerJs).not.toMatch(/getCachedSnapshot/);
    });

    test('video-player.js does not create blob URLs for snapshots', () => {
        expect(videoPlayerJs).not.toMatch(/URL\.createObjectURL/);
        expect(videoPlayerJs).not.toMatch(/URL\.revokeObjectURL/);
    });

    test('gallery.js _renderCards does not call prefetchSnapshot', () => {
        expect(galleryJs).not.toMatch(/prefetchSnapshot/);
    });

    test('video-player.js openVideo sets poster src via URL, not blob cache', () => {
        // openVideo should build a snapshot URL and assign it to poster.src directly
        expect(videoPlayerJs).toMatch(/buildUrl.*snapshot/);
        expect(videoPlayerJs).toMatch(/poster\.src\s*=/);
    });
});

describe('Gallery Performance: no NVR fallback in snapshot endpoint', () => {
    test('snapshot endpoint does not call getRecordingStreamThumbnail', () => {
        // Extract the snapshot handler block from main.ts
        const snapshotIdx = mainTs.indexOf("path === '/brief/snapshot'");
        expect(snapshotIdx).toBeGreaterThan(-1);
        // Check from snapshot handler to the next endpoint (next path === check)
        const afterSnapshot = mainTs.substring(snapshotIdx, snapshotIdx + 3000);
        expect(afterSnapshot).not.toMatch(/getRecordingStreamThumbnail/);
    });

    test('snapshot endpoint does not reference VideoRecorder', () => {
        const snapshotIdx = mainTs.indexOf("path === '/brief/snapshot'");
        const afterSnapshot = mainTs.substring(snapshotIdx, snapshotIdx + 3000);
        expect(afterSnapshot).not.toMatch(/VideoRecorder/);
    });

    test('snapshot endpoint does not call resizeJpegNearest', () => {
        const snapshotIdx = mainTs.indexOf("path === '/brief/snapshot'");
        const afterSnapshot = mainTs.substring(snapshotIdx, snapshotIdx + 3000);
        expect(afterSnapshot).not.toMatch(/resizeJpegNearest/);
    });

    test('snapshot endpoint fallback chain is disk -> thumbnailB64 -> 404', () => {
        const snapshotIdx = mainTs.indexOf("path === '/brief/snapshot'");
        const afterSnapshot = mainTs.substring(snapshotIdx, snapshotIdx + 5000);
        // Should still have posterStore.get (disk check)
        expect(afterSnapshot).toMatch(/posterStore\.get/);
        // Should still have thumbnailB64 fallback
        expect(afterSnapshot).toMatch(/thumbnailB64/);
        // Should have 404 response
        expect(afterSnapshot).toMatch(/404/);
    });
});

// ============================================================================
// HA Card: thumbnail auth & cleanup
// ============================================================================

describe('HA Card: thumbnail authentication', () => {
    const cardJs = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');

    test('daily-brief-card.js does not call prefetchSnapshot', () => {
        expect(cardJs).not.toMatch(/prefetchSnapshot/);
    });

    test('thumbnail img src uses _buildUrl for correct proxy path and auth', () => {
        // Thumbnail img tags should use _buildUrl (not raw h.thumbnail URLs)
        // to ensure URLs go through the HA proxy path with scryptedToken
        const imgSrcMatches = cardJs.match(/src="\$\{[^"]+\}"/g) || [];
        const snapshotSrcs = imgSrcMatches.filter(m => m.includes('snapshot'));
        expect(snapshotSrcs.length).toBeGreaterThan(0);
        for (const src of snapshotSrcs) {
            expect(src).toMatch(/_buildUrl/);
        }
    });

    test('thumbnail img src does not use raw h.thumbnail URL', () => {
        // h.thumbnail uses server rootPath which is the wrong base for HA proxy
        const cardJs = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
        const imgSrcMatches = cardJs.match(/src="\$\{[^"]+\}"/g) || [];
        const rawThumbnailSrcs = imgSrcMatches.filter(m => m.includes('h.thumbnail'));
        expect(rawThumbnailSrcs.length).toBe(0);
    });
});

describe('HA Card: Gallery tab integration', () => {
    const cardJs = fs.readFileSync(path.join(ROOT, 'ha-card/daily-brief-card.js'), 'utf-8');
    const embedJs = fs.readFileSync(path.join(ROOT, 'scripts/embed-ha-card.js'), 'utf-8');

    test('HA card bundle includes gallery.js', () => {
        expect(embedJs).toMatch(/galleryJs/);
        // Bundle line should include galleryJs between videoPlayerJs and haCardJs
        expect(embedJs).toMatch(/videoPlayerJs.*galleryJs.*haCardJs/);
    });

    test('daily-brief-card has gallery tab', () => {
        expect(cardJs).toMatch(/data-tab="gallery"/);
    });

    test('daily-brief-card has brief tab', () => {
        expect(cardJs).toMatch(/data-tab="brief"/);
    });

    test('daily-brief-card instantiates Gallery class', () => {
        expect(cardJs).toMatch(/new Gallery\(/);
    });

    test('daily-brief-card does not have external gallery link', () => {
        expect(cardJs).not.toMatch(/gallery-link/);
    });

    test('daily-brief-card includes Gallery.CSS in styles', () => {
        expect(cardJs).toMatch(/Gallery\.CSS/);
    });

    test('daily-brief-card has tab-bar CSS', () => {
        expect(cardJs).toMatch(/\.tab-bar/);
        expect(cardJs).toMatch(/\.tab\.active/);
    });

    test('gallery container has CSS variable mappings', () => {
        expect(cardJs).toMatch(/\.gallery-container/);
        expect(cardJs).toMatch(/--bg-secondary/);
        expect(cardJs).toMatch(/--text-primary/);
    });
});

describe('Gallery: thumbnail URLs use buildUrl', () => {
    const galleryJs = fs.readFileSync(path.join(ROOT, 'ha-card/gallery.js'), 'utf-8');

    test('gallery _renderCards uses _buildUrl for thumbnail src', () => {
        // Find the _renderCards method definition (not a call to it)
        const methodDef = '  _renderCards(';
        const renderStart = galleryJs.indexOf(methodDef);
        expect(renderStart).toBeGreaterThan(-1);
        const renderSection = galleryJs.substring(renderStart, renderStart + 2000);
        // img src should use _buildUrl, not raw thumbnailUrl
        expect(renderSection).toMatch(/_buildUrl.*snapshot/);
    });

    test('gallery does not use raw thumbnailUrl as img src', () => {
        const methodDef = '  _renderCards(';
        const renderStart = galleryJs.indexOf(methodDef);
        const renderSection = galleryJs.substring(renderStart, renderStart + 2000);
        // Should NOT have img src set directly from thumbnailUrl
        expect(renderSection).not.toMatch(/src=".*thumbnailUrl/);
    });
});
