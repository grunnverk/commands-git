import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@grunnverk/core';

// Mock ALL dependencies
vi.mock('@riotprompt/riotprompt', () => ({
    Formatter: { create: vi.fn(() => ({ formatPrompt: vi.fn(() => ({ messages: [] })) })) },
    Model: {}
}));

vi.mock('dotenv/config', () => ({}));

vi.mock('@grunnverk/core', () => ({
    DEFAULT_EXCLUDED_PATTERNS: ['node_modules'],
    DEFAULT_OUTPUT_DIRECTORY: 'output',
    DEFAULT_MAX_DIFF_BYTES: 500000,
    Diff: {
        create: vi.fn(() => ({ get: vi.fn(() => 'diff content') })),
        hasStagedChanges: vi.fn(() => true),
    },
    Log: { create: vi.fn(() => ({ get: vi.fn(() => 'log content') })) },
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    Config: {},
    toAIConfig: vi.fn(() => ({ model: 'gpt-4o', commands: {} })),
    createStorageAdapter: vi.fn(() => ({})),
    createLoggerAdapter: vi.fn(() => ({})),
    getOutputPath: vi.fn((d, f) => `${d}/${f}`),
    getTimestampedRequestFilename: vi.fn(() => 'request.json'),
    getTimestampedResponseFilename: vi.fn(() => 'response.json'),
    filterContent: vi.fn((content) => ({ filtered: content, removed: [] })),
}));

vi.mock('@grunnverk/shared', () => ({
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
    })),
}));

vi.mock('@grunnverk/git-tools', () => ({
    run: vi.fn(() => ({ stdout: '', stderr: '' })),
    getCurrentBranch: vi.fn(() => 'feature-branch'),
    getDefaultFromRef: vi.fn(() => 'main'),
}));

vi.mock('@grunnverk/ai-service', () => ({
    createCompletionWithRetry: vi.fn(() => ({ content: 'review content' })),
    runAgenticReview: vi.fn(() => ({
        review: 'Code looks good overall',
        iterations: 1,
        toolCallsExecuted: 2,
        toolMetrics: [],
        conversationHistory: []
    })),
    generateReflectionReport: vi.fn(() => 'reflection report'),
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('review command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/review');
        const result = await execute(createConfig({ dryRun: true }));
        expect(result).toBeDefined();
    });

    it('handles custom output directory', async () => {
        const { execute } = await import('../../src/commands/review');
        const result = await execute(createConfig({
            dryRun: true,
            outputDirectory: '/tmp/review'
        }));
        expect(result).toBeDefined();
    });

    it('handles excluded patterns', async () => {
        const { execute } = await import('../../src/commands/review');
        const result = await execute(createConfig({
            dryRun: true,
            excludedPatterns: ['*.test.ts']
        }));
        expect(result).toBeDefined();
    });

    it('handles debug mode', async () => {
        const { execute } = await import('../../src/commands/review');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true
        }));
        expect(result).toBeDefined();
    });
});
