import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@grunnverk/core';

// Mock ALL dependencies
vi.mock('@grunnverk/core', () => ({
    DEFAULT_EXCLUDED_PATTERNS: ['node_modules'],
    DEFAULT_OUTPUT_DIRECTORY: 'output',
    Diff: {
        create: vi.fn(() => ({ get: vi.fn(() => 'diff content') })),
        hasStagedChanges: vi.fn(() => true),
    },
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    Config: {},
    getOutputPath: vi.fn((d, f) => `${d}/${f}`),
}));

vi.mock('@grunnverk/shared', () => ({
    ValidationError: class ValidationError extends Error {},
    ExternalDependencyError: class ExternalDependencyError extends Error {},
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{"version": "1.0.0"}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
        fileExists: vi.fn(() => true),
    })),
    checkForFileDependencies: vi.fn(() => []),
}));

vi.mock('@grunnverk/git-tools', () => ({
    run: vi.fn(() => ({ stdout: '', stderr: '' })),
    validateString: vi.fn((s) => s),
    safeJsonParse: vi.fn((s) => JSON.parse(s)),
    validatePackageJson: vi.fn((p) => p),
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('precommit command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/precommit');
        const result = await execute(createConfig({ dryRun: true }));
        expect(result).toBeDefined();
    });

    it('handles debug mode', async () => {
        const { execute } = await import('../../src/commands/precommit');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true
        }));
        expect(result).toBeDefined();
    });
});
