import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    PerformanceTimer,
    collectAllDependencies,
    checkForFileDependencies,
    PackageJsonLocation,
} from '../../src/util/performance';

// Mock the logger
const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    silly: vi.fn(),
};

vi.mock('@grunnverk/core', () => ({
    getLogger: () => mockLogger,
}));

vi.mock('@grunnverk/git-tools', () => ({
    safeJsonParse: (content: string) => JSON.parse(content),
    validatePackageJson: (parsed: any) => parsed,
}));

describe('performance utilities', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('PerformanceTimer', () => {
        it('should create a timer with start method', () => {
            const timer = PerformanceTimer.start(mockLogger, 'test operation');
            expect(timer).toBeInstanceOf(PerformanceTimer);
            expect(mockLogger.verbose).toHaveBeenCalledWith(expect.stringContaining('Starting'));
        });

        it('should return duration on end', async () => {
            const timer = PerformanceTimer.start(mockLogger, 'test operation');
            // Small delay to ensure some time passes
            await new Promise(resolve => setTimeout(resolve, 10));
            const duration = timer.end('test operation');
            expect(duration).toBeGreaterThanOrEqual(0);
            expect(mockLogger.verbose).toHaveBeenCalledWith(expect.stringContaining('Completed'));
        });

        it('should include operation name in logs', () => {
            const timer = PerformanceTimer.start(mockLogger, 'my-operation');
            timer.end('my-operation');
            expect(mockLogger.verbose).toHaveBeenCalledWith(expect.stringContaining('my-operation'));
        });
    });

    describe('collectAllDependencies', () => {
        it('should collect dependencies from multiple package.json files', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package1/package.json',
                    relativePath: 'package1',
                    packageJson: {
                        name: 'package1',
                        dependencies: { 'dep-a': '1.0.0', 'dep-b': '2.0.0' },
                    },
                },
                {
                    path: '/path/to/package2/package.json',
                    relativePath: 'package2',
                    packageJson: {
                        name: 'package2',
                        devDependencies: { 'dep-c': '3.0.0' },
                    },
                },
            ];

            const result = collectAllDependencies(packageJsonFiles);
            expect(result['dep-a']).toBe('1.0.0');
            expect(result['dep-b']).toBe('2.0.0');
            expect(result['dep-c']).toBe('3.0.0');
        });

        it('should handle empty package.json files', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package/package.json',
                    relativePath: 'package',
                    packageJson: {
                        name: 'empty-package',
                    },
                },
            ];

            const result = collectAllDependencies(packageJsonFiles);
            expect(Object.keys(result).length).toBe(0);
        });

        it('should merge dependencies from all dependency types', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package/package.json',
                    relativePath: 'package',
                    packageJson: {
                        name: 'full-package',
                        dependencies: { 'prod-dep': '1.0.0' },
                        devDependencies: { 'dev-dep': '2.0.0' },
                        peerDependencies: { 'peer-dep': '3.0.0' },
                    },
                },
            ];

            const result = collectAllDependencies(packageJsonFiles);
            expect(result['prod-dep']).toBe('1.0.0');
            expect(result['dev-dep']).toBe('2.0.0');
            expect(result['peer-dep']).toBe('3.0.0');
        });

        it('should handle later packages overwriting earlier ones', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package1/package.json',
                    relativePath: 'package1',
                    packageJson: {
                        name: 'package1',
                        dependencies: { 'shared-dep': '1.0.0' },
                    },
                },
                {
                    path: '/path/to/package2/package.json',
                    relativePath: 'package2',
                    packageJson: {
                        name: 'package2',
                        dependencies: { 'shared-dep': '2.0.0' },
                    },
                },
            ];

            const result = collectAllDependencies(packageJsonFiles);
            // Later package should overwrite
            expect(result['shared-dep']).toBe('2.0.0');
        });
    });

    describe('checkForFileDependencies', () => {
        it('should not warn when no file: dependencies exist', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package/package.json',
                    relativePath: 'package',
                    packageJson: {
                        name: 'clean-package',
                        dependencies: { 'normal-dep': '^1.0.0' },
                    },
                },
            ];

            checkForFileDependencies(packageJsonFiles);
            expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('FILE_DEPS_WARNING'));
        });

        it('should warn when file: dependencies exist', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package/package.json',
                    relativePath: 'package',
                    packageJson: {
                        name: 'linked-package',
                        dependencies: { 'local-dep': 'file:../local-dep' },
                    },
                },
            ];

            checkForFileDependencies(packageJsonFiles);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('FILE_DEPS_WARNING'));
        });

        it('should detect file: dependencies in devDependencies', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package/package.json',
                    relativePath: 'package',
                    packageJson: {
                        name: 'dev-linked-package',
                        devDependencies: { 'local-dev-dep': 'file:../local-dev-dep' },
                    },
                },
            ];

            checkForFileDependencies(packageJsonFiles);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('FILE_DEPS_WARNING'));
        });

        it('should detect file: dependencies in peerDependencies', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package/package.json',
                    relativePath: 'package',
                    packageJson: {
                        name: 'peer-linked-package',
                        peerDependencies: { 'local-peer-dep': 'file:../local-peer-dep' },
                    },
                },
            ];

            checkForFileDependencies(packageJsonFiles);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('FILE_DEPS_WARNING'));
        });

        it('should handle empty package.json gracefully', () => {
            const packageJsonFiles: PackageJsonLocation[] = [
                {
                    path: '/path/to/package/package.json',
                    relativePath: 'package',
                    packageJson: {
                        name: 'empty-package',
                    },
                },
            ];

            expect(() => checkForFileDependencies(packageJsonFiles)).not.toThrow();
        });
    });
});

