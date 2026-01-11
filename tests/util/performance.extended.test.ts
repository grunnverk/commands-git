import { describe, it, expect, vi } from 'vitest';
import { PerformanceTimer, batchReadPackageJsonFiles, findAllPackageJsonFiles, scanDirectoryForPackages, findPackagesByScope, collectAllDependencies, checkForFileDependencies } from '../../src/util/performance';

const mockLogger = { info: vi.fn(), warn: vi.fn(), verbose: vi.fn(), debug: vi.fn(), error: vi.fn(), silly: vi.fn() };

vi.mock('@eldrforge/core', () => ({ getLogger: () => mockLogger }));
vi.mock('@eldrforge/git-tools', () => ({ safeJsonParse: (content: string) => JSON.parse(content), validatePackageJson: (parsed: any) => parsed }));

describe('performance utils extended', () => {
    describe('PerformanceTimer', () => {
        it('creates and ends timer', () => {
            const timer = PerformanceTimer.start(mockLogger, 'op');
            expect(timer).toBeDefined();
            const duration = timer.end('op');
            expect(duration).toBeGreaterThanOrEqual(0);
        });
    });

    describe('batchReadPackageJsonFiles', () => {
        it('reads files in batch', async () => {
            const storage = { readFile: vi.fn().mockResolvedValue('{"name":"test"}') };
            const result = await batchReadPackageJsonFiles(['/test/package.json'], storage, '/test');
            expect(result).toHaveLength(1);
        });

        it('handles errors', async () => {
            const storage = { readFile: vi.fn().mockRejectedValue(new Error('fail')) };
            const result = await batchReadPackageJsonFiles(['/test/package.json'], storage, '/test');
            expect(result).toHaveLength(0);
        });

        it('handles empty array', async () => {
            const storage = { readFile: vi.fn() };
            const result = await batchReadPackageJsonFiles([], storage, '/test');
            expect(result).toEqual([]);
        });
    });

    describe('findAllPackageJsonFiles', () => {
        it('finds packages', async () => {
            const storage = {
                readFile: vi.fn().mockResolvedValue('{"name":"test"}'),
                exists: vi.fn().mockResolvedValue(true),
                readdir: vi.fn().mockResolvedValue([]),
                stat: vi.fn().mockResolvedValue({ isDirectory: () => true })
            };
            const result = await findAllPackageJsonFiles('/test', storage);
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('scanDirectoryForPackages', () => {
        it('scans directory', async () => {
            const storage = {
                exists: vi.fn().mockResolvedValue(true),
                readdir: vi.fn().mockResolvedValue(['package.json']),
                stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
                readFile: vi.fn().mockResolvedValue('{"name":"test"}')
            };
            const result = await scanDirectoryForPackages('/test', storage);
            expect(result instanceof Map).toBe(true);
        });
    });

    describe('findPackagesByScope', () => {
        it('finds scoped packages', async () => {
            const storage = {
                readFile: vi.fn().mockResolvedValue('{"name":"@scope/pkg"}'),
                exists: vi.fn().mockResolvedValue(true),
                readdir: vi.fn().mockResolvedValue([]),
                stat: vi.fn().mockResolvedValue({ isDirectory: () => true })
            };
            const dependencies = { '@scope/pkg': '^1.0.0' };
            const scopeRoots = { '@scope': '/test' };
            const result = await findPackagesByScope(dependencies, scopeRoots, storage);
            expect(result).toBeDefined();
        });
    });

    describe('collectAllDependencies', () => {
        it('collects deps', () => {
            const pkgs = [{ path: '/test', packageJson: { dependencies: { 'a': '1.0.0' }, devDependencies: { 'b': '1.0.0' } }, relativePath: '.' }];
            const result = collectAllDependencies(pkgs);
            expect(result).toHaveProperty('a');
            expect(result).toHaveProperty('b');
        });

        it('handles empty', () => {
            const result = collectAllDependencies([]);
            expect(result).toEqual({});
        });
    });

    describe('checkForFileDependencies', () => {
        it('detects file deps', () => {
            const pkgs = [{ path: '/test', packageJson: { dependencies: { 'a': 'file:../a' } }, relativePath: '.' }];
            expect(() => checkForFileDependencies(pkgs)).not.toThrow();
        });

        it('handles registry deps', () => {
            const pkgs = [{ path: '/test', packageJson: { dependencies: { 'a': '^1.0.0' } }, relativePath: '.' }];
            expect(() => checkForFileDependencies(pkgs)).not.toThrow();
        });
    });
});

