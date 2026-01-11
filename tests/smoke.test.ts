import { describe, it, expect } from 'vitest';

describe('commands-git smoke', () => {
    it('loads commit', async () => { const m = await import('../src/commands/commit'); expect(m.execute).toBeDefined(); });
    it('loads precommit', async () => { const m = await import('../src/commands/precommit'); expect(m.execute).toBeDefined(); });
    it('loads clean', async () => { const m = await import('../src/commands/clean'); expect(m.execute).toBeDefined(); });
    it('loads review', async () => { const m = await import('../src/commands/review'); expect(m.execute).toBeDefined(); });
    it('loads performance', async () => { const m = await import('../src/util/performance'); expect(m.PerformanceTimer).toBeDefined(); });
    it('loads precommit opts', async () => { const m = await import('../src/util/precommitOptimizations'); expect(m).toBeDefined(); });
    it('loads index', async () => { const m = await import('../src/index'); expect(m.commit).toBeDefined(); });
    it('commit export', async () => { const m = await import('../src/index'); expect(typeof m.commit).toBe('function'); });
    it('precommit export', async () => { const m = await import('../src/index'); expect(typeof m.precommit).toBe('function'); });
    it('clean export', async () => { const m = await import('../src/index'); expect(typeof m.clean).toBe('function'); });
    it('review export', async () => { const m = await import('../src/index'); expect(typeof m.review).toBeDefined(); });
    it('timer export', async () => { const m = await import('../src/index'); expect(m.PerformanceTimer).toBeDefined(); });
    it('batch read export', async () => { const m = await import('../src/index'); expect(m.batchReadPackageJsonFiles).toBeDefined(); });
    it('find packages export', async () => { const m = await import('../src/index'); expect(m.findAllPackageJsonFiles).toBeDefined(); });
    it('scan directory export', async () => { const m = await import('../src/index'); expect(m.scanDirectoryForPackages).toBeDefined(); });
    it('find by scope export', async () => { const m = await import('../src/index'); expect(m.findPackagesByScope).toBeDefined(); });
    it('collect deps export', async () => { const m = await import('../src/index'); expect(m.collectAllDependencies).toBeDefined(); });
    it('check file deps export', async () => { const m = await import('../src/index'); expect(m.checkForFileDependencies).toBeDefined(); });
});

