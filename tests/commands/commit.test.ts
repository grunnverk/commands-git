import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@eldrforge/core';

// Mock ALL dependencies BEFORE importing the module
vi.mock('@riotprompt/riotprompt', () => ({
    Formatter: { create: vi.fn(() => ({ formatPrompt: vi.fn(() => ({ messages: [] })) })) },
    Model: {}
}));

vi.mock('dotenv/config', () => ({}));

vi.mock('shell-escape', () => ({ default: (args: string[]) => args.join(' ') }));

vi.mock('@eldrforge/core', () => ({
    DEFAULT_EXCLUDED_PATTERNS: ['node_modules', '.git'],
    DEFAULT_OUTPUT_DIRECTORY: 'output',
    DEFAULT_MAX_DIFF_BYTES: 500000,
    Diff: {
        create: vi.fn(() => ({ get: vi.fn(() => 'diff content') })),
        hasStagedChanges: vi.fn(() => true),
        hasCriticalExcludedChanges: vi.fn(() => ({ hasChanges: false, files: [] })),
        getMinimalExcludedPatterns: vi.fn((patterns) => patterns)
    },
    Log: { create: vi.fn(() => ({ get: vi.fn(() => 'log content') })) },
    Files: { create: vi.fn(() => ({ get: vi.fn(() => 'file content') })) },
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    Config: {},
    sanitizeDirection: vi.fn((d) => d),
    filterContent: vi.fn((content) => ({ filtered: content, removed: [] })),
    getOutputPath: vi.fn((dir, file) => `${dir}/${file}`),
    getTimestampedRequestFilename: vi.fn(() => 'request.json'),
    getTimestampedResponseFilename: vi.fn(() => 'response.json'),
    getTimestampedCommitFilename: vi.fn(() => 'commit.txt'),
    improveContentWithLLM: vi.fn(),
    toAIConfig: vi.fn(() => ({ model: 'gpt-4o', commands: {} })),
    createStorageAdapter: vi.fn(() => ({})),
    createLoggerAdapter: vi.fn(() => ({})),
}));

vi.mock('@eldrforge/shared', () => ({
    CommandError: class CommandError extends Error { code: string; constructor(m: string, c: string) { super(m); this.code = c; } },
    ValidationError: class ValidationError extends Error {},
    ExternalDependencyError: class ExternalDependencyError extends Error {},
    checkForFileDependencies: vi.fn(() => []),
    logFileDependencyWarning: vi.fn(),
    logFileDependencySuggestions: vi.fn(),
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{"version": "1.0.0"}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
    })),
}));

vi.mock('@eldrforge/git-tools', () => ({
    run: vi.fn(() => ({ stdout: '', stderr: '' })),
    validateString: vi.fn((s) => s),
    stageFiles: vi.fn(),
    unstageAll: vi.fn(),
    verifyStagedFiles: vi.fn(() => ({ allPresent: true, missing: [], unexpected: [] })),
    safeJsonParse: vi.fn((s) => JSON.parse(s)),
    validatePackageJson: vi.fn((p) => p),
}));

vi.mock('@eldrforge/github-tools', () => ({
    getRecentClosedIssuesForCommit: vi.fn(() => ''),
}));

vi.mock('@eldrforge/ai-service', () => ({
    createCompletionWithRetry: vi.fn(() => ({ content: 'test response' })),
    getUserChoice: vi.fn(() => 'c'),
    editContentInEditor: vi.fn((content) => ({ content })),
    getLLMFeedbackInEditor: vi.fn(() => 'feedback'),
    requireTTY: vi.fn(),
    STANDARD_CHOICES: { CONFIRM: { key: 'c' }, EDIT: { key: 'e' }, SKIP: { key: 's' }, IMPROVE: { key: 'i' } },
    CommitContent: {},
    CommitContext: {},
    runAgenticCommit: vi.fn(() => ({
        commitMessage: 'feat: test commit message',
        iterations: 1,
        toolCallsExecuted: 2,
        suggestedSplits: [],
        toolMetrics: [],
        conversationHistory: []
    })),
    generateReflectionReport: vi.fn(() => 'reflection report'),
    createCommitPrompt: vi.fn(() => ({ messages: [] })),
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('commit command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({ dryRun: true }));
        expect(result).toBeDefined();
        expect(typeof result).toBe('string');
    });

    it('handles sendit mode in dry run', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { sendit: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles add flag in dry run', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { add: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles amend mode', async () => {
        const { run } = await import('@eldrforge/git-tools');
        vi.mocked(run).mockResolvedValueOnce({ stdout: 'abc123', stderr: '' });

        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { amend: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles direction parameter', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { direction: 'focus on security' }
        }));
        expect(result).toBeDefined();
    });

    it('handles context files', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { contextFiles: ['README.md'] }
        }));
        expect(result).toBeDefined();
    });

    it('handles selfReflection mode', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { selfReflection: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles custom output directory', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            outputDirectory: '/tmp/output'
        }));
        expect(result).toBeDefined();
    });

    it('handles excluded patterns', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            excludedPatterns: ['*.log', '*.tmp']
        }));
        expect(result).toBeDefined();
    });

    it('handles max diff bytes config', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { maxDiffBytes: 1000000 }
        }));
        expect(result).toBeDefined();
    });

    it('handles message limit', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { messageLimit: 50 }
        }));
        expect(result).toBeDefined();
    });

    it('handles debug mode', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true
        }));
        expect(result).toBeDefined();
    });

    it('handles push config', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { sendit: true, push: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles push to custom remote', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { sendit: true, push: 'upstream' }
        }));
        expect(result).toBeDefined();
    });

    it('handles allowCommitSplitting', async () => {
        const { runAgenticCommit } = await import('@eldrforge/ai-service');
        vi.mocked(runAgenticCommit).mockResolvedValueOnce({
            commitMessage: 'feat: combined',
            iterations: 1,
            toolCallsExecuted: 2,
            suggestedSplits: [
                { files: ['a.ts'], message: 'feat: a', rationale: 'first' },
                { files: ['b.ts'], message: 'feat: b', rationale: 'second' }
            ],
            toolMetrics: [],
            conversationHistory: []
        });

        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            commit: { allowCommitSplitting: true, autoSplit: false }
        }));
        expect(result).toBeDefined();
    });

    it('handles overrides config', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            overrides: true
        }));
        expect(result).toBeDefined();
    });

    it('handles contextDirectories', async () => {
        const { execute } = await import('../../src/commands/commit');
        const result = await execute(createConfig({
            dryRun: true,
            contextDirectories: ['src', 'lib']
        }));
        expect(result).toBeDefined();
    });
});
