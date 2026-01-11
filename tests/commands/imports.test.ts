import { describe, it, expect } from 'vitest';

describe('command imports and basic validation', () => {
    it('should import commit command', async () => {
        const module = await import('../../src/index');
        expect(module.commit).toBeDefined();
        expect(typeof module.commit).toBe('function');
    });

    it('should import precommit command', async () => {
        const module = await import('../../src/index');
        expect(module.precommit).toBeDefined();
        expect(typeof module.precommit).toBe('function');
    });

    it('should import clean command', async () => {
        const module = await import('../../src/index');
        expect(module.clean).toBeDefined();
        expect(typeof module.clean).toBe('function');
    });

    it('should import review command', async () => {
        const module = await import('../../src/index');
        expect(module.review).toBeDefined();
        expect(typeof module.review).toBe('function');
    });

    it('should import utility functions', async () => {
        const module = await import('../../src/index');
        expect(module.findAllPackageJsonFiles).toBeDefined();
    });
});

