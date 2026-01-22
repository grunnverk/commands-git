import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@grunnverk/core';

// Mock ALL dependencies
vi.mock('@grunnverk/core', () => ({
    DEFAULT_OUTPUT_DIRECTORY: 'output',
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    Config: {},
}));

vi.mock('@grunnverk/shared', () => ({
    FileOperationError: class FileOperationError extends Error {},
    createStorage: vi.fn(() => ({
        exists: vi.fn(() => false),
        removeDirectory: vi.fn(),
    })),
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('clean command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/clean');
        await expect(execute(createConfig({ dryRun: true }))).resolves.not.toThrow();
    });

    it('handles custom output directory', async () => {
        const { execute } = await import('../../src/commands/clean');
        await expect(execute(createConfig({
            dryRun: true,
            outputDirectory: '/tmp/output'
        }))).resolves.not.toThrow();
    });

    it('handles existing directory', async () => {
        const { createStorage } = await import('@grunnverk/shared');
        vi.mocked(createStorage).mockReturnValueOnce({
            exists: vi.fn(() => true),
            removeDirectory: vi.fn(),
        } as any);

        const { execute } = await import('../../src/commands/clean');
        await expect(execute(createConfig({ dryRun: false }))).resolves.not.toThrow();
    });

    it('handles non-dry-run mode', async () => {
        const { execute } = await import('../../src/commands/clean');
        await expect(execute(createConfig({ dryRun: false }))).resolves.not.toThrow();
    });

    it('handles debug mode', async () => {
        const { execute } = await import('../../src/commands/clean');
        await expect(execute(createConfig({
            dryRun: true,
            debug: true
        }))).resolves.not.toThrow();
    });
});
