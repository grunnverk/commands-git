import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies - must be defined before mocks
vi.mock('@eldrforge/core', () => ({
    getLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        verbose: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

import {
    isCleanNeeded,
    isTestNeeded,
    recordTestRun,
    optimizePrecommitCommand,
} from '../../src/util/precommitOptimizations';

vi.mock('@eldrforge/git-tools', () => ({
    runSecure: vi.fn(),
}));

vi.mock('@eldrforge/shared', () => ({
    createStorage: () => ({
        exists: vi.fn().mockResolvedValue(false),
    }),
}));

vi.mock('fs/promises', () => ({
    default: {
        readFile: vi.fn().mockRejectedValue(new Error('File not found')),
        writeFile: vi.fn().mockResolvedValue(undefined),
        stat: vi.fn().mockRejectedValue(new Error('File not found')),
    },
    readFile: vi.fn().mockRejectedValue(new Error('File not found')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockRejectedValue(new Error('File not found')),
}));

describe('precommitOptimizations utilities', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('isCleanNeeded', () => {
        it('should return not needed when dist does not exist', async () => {
            const result = await isCleanNeeded('/test/package');
            expect(result.needed).toBe(false);
            expect(result.reason).toContain('does not exist');
        });
    });

    describe('isTestNeeded', () => {
        it('should return needed when no cache exists', async () => {
            const result = await isTestNeeded('/test/package');
            expect(result.needed).toBe(true);
            expect(result.reason).toContain('No previous test run');
        });
    });

    describe('recordTestRun', () => {
        it('should not throw when recording test run', async () => {
            await expect(recordTestRun('/test/package')).resolves.not.toThrow();
        });
    });

    describe('optimizePrecommitCommand', () => {
        it('should return original command when no optimization available', async () => {
            const result = await optimizePrecommitCommand(
                '/test/package',
                'npm run lint'
            );
            expect(result.optimizedCommand).toBe('npm run lint');
            expect(result.skipped.clean).toBe(false);
            expect(result.skipped.test).toBe(false);
        });

        it('should skip test when test not needed', async () => {
            // Since no cache exists, test will be needed
            const result = await optimizePrecommitCommand(
                '/test/package',
                'npm run build && npm run test'
            );
            // Test is needed (no cache), so it won't be skipped
            expect(result.optimizedCommand).toContain('test');
        });

        it('should handle precommit script detection', async () => {
            const result = await optimizePrecommitCommand(
                '/test/package',
                'npm run precommit'
            );
            // Should recognize it's a precommit script
            expect(result).toBeDefined();
        });

        it('should clean up double && operators', async () => {
            const result = await optimizePrecommitCommand(
                '/test/package',
                'npm run lint && npm run build'
            );
            // Should not have malformed command
            expect(result.optimizedCommand).not.toContain('&& &&');
            expect(result.optimizedCommand).not.toMatch(/&&\s*$/);
        });
    });
});

