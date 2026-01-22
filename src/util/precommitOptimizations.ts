import path from 'path';
import fs from 'fs/promises';
import { getLogger } from '@grunnverk/core';
import { runSecure } from '@grunnverk/git-tools';
import { createStorage } from '@grunnverk/shared';

const logger = getLogger();

// Cache file to store test run timestamps per package
const TEST_CACHE_FILE = '.kodrdriv-test-cache.json';

interface TestCache {
    [packagePath: string]: {
        lastTestRun: number; // timestamp
        lastCommitHash: string; // git commit hash when tests last ran
    };
}

/**
 * Load test cache from disk
 */
async function loadTestCache(packageDir: string): Promise<TestCache> {
    const cachePath = path.join(packageDir, TEST_CACHE_FILE);
    try {
        const content = await fs.readFile(cachePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return {};
    }
}

/**
 * Save test cache to disk
 */
async function saveTestCache(packageDir: string, cache: TestCache): Promise<void> {
    const cachePath = path.join(packageDir, TEST_CACHE_FILE);
    try {
        await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error: any) {
        logger.debug(`Failed to save test cache: ${error.message}`);
    }
}

/**
 * Get the current git commit hash
 */
async function getCurrentCommitHash(packageDir: string): Promise<string | null> {
    try {
        const { stdout } = await runSecure('git', ['rev-parse', 'HEAD'], { cwd: packageDir });
        return stdout.trim();
    } catch {
        return null;
    }
}

/**
 * Check if source files have changed since the last test run
 */
async function hasSourceFilesChanged(
    packageDir: string,
    lastCommitHash: string | null
): Promise<{ changed: boolean; reason: string }> {
    if (!lastCommitHash) {
        return { changed: true, reason: 'No previous test run recorded' };
    }

    try {
        // Get current commit hash
        const currentCommitHash = await getCurrentCommitHash(packageDir);
        if (!currentCommitHash) {
            return { changed: true, reason: 'Not in a git repository' };
        }

        // If commit hash changed, files definitely changed
        if (currentCommitHash !== lastCommitHash) {
            return { changed: true, reason: `Commit hash changed: ${lastCommitHash.substring(0, 7)} -> ${currentCommitHash.substring(0, 7)}` };
        }

        // Check if there are any uncommitted changes to source files
        const { stdout } = await runSecure('git', ['status', '--porcelain'], { cwd: packageDir });
        const changedFiles = stdout.split('\n')
            .filter(line => line.trim())
            .map(line => line.substring(3).trim())
            .filter(file => {
                // Only consider source files, not build artifacts or config files
                const ext = path.extname(file);
                return (
                    // TypeScript/JavaScript source files
                    ['.ts', '.tsx', '.js', '.jsx'].includes(ext) ||
                    // Test files
                    file.includes('.test.') || file.includes('.spec.') ||
                    // Config files that affect build/test
                    ['tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'package.json'].includes(path.basename(file))
                );
            });

        if (changedFiles.length > 0) {
            return { changed: true, reason: `Uncommitted changes in: ${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? '...' : ''}` };
        }

        return { changed: false, reason: 'No source file changes detected' };
    } catch (error: any) {
        logger.debug(`Error checking for source file changes: ${error.message}`);
        // Conservative: assume changed if we can't verify
        return { changed: true, reason: `Could not verify changes: ${error.message}` };
    }
}

/**
 * Check if dist directory needs to be cleaned (is outdated compared to source files)
 */
export async function isCleanNeeded(packageDir: string): Promise<{ needed: boolean; reason: string }> {
    const storage = createStorage();
    const distPath = path.join(packageDir, 'dist');

    try {
        // Check if dist directory exists
        const distExists = await storage.exists('dist');
        if (!distExists) {
            return { needed: false, reason: 'dist directory does not exist' };
        }

        // Get dist directory modification time
        const distStats = await fs.stat(distPath);
        const distMtime = distStats.mtimeMs;

        // Use git to find source files that are newer than dist
        try {
            // Get all tracked source files
            const { stdout: trackedFiles } = await runSecure('git', ['ls-files'], { cwd: packageDir });
            const files = trackedFiles.split('\n').filter(Boolean);

            // Check if any source files are newer than dist
            for (const file of files) {
                const ext = path.extname(file);
                if (!['.ts', '.tsx', '.js', '.jsx', '.json'].includes(ext)) {
                    continue;
                }

                // Skip dist files
                if (file.startsWith('dist/')) {
                    continue;
                }

                try {
                    const filePath = path.join(packageDir, file);
                    const fileStats = await fs.stat(filePath);
                    if (fileStats.mtimeMs > distMtime) {
                        return { needed: true, reason: `${file} is newer than dist directory` };
                    }
                } catch {
                    // File might not exist or be inaccessible, skip it
                    continue;
                }
            }

            return { needed: false, reason: 'dist directory is up to date with source files' };
        } catch (error: any) {
            // If git check fails, fall back to checking common source directories
            logger.debug(`Git-based check failed, using fallback: ${error.message}`);

            const sourceDirs = ['src', 'tests'];
            for (const dir of sourceDirs) {
                const dirPath = path.join(packageDir, dir);
                try {
                    const dirStats = await fs.stat(dirPath);
                    if (dirStats.mtimeMs > distMtime) {
                        return { needed: true, reason: `${dir} directory is newer than dist` };
                    }
                } catch {
                    // Directory doesn't exist, skip it
                    continue;
                }
            }

            // Conservative: if we can't verify, assume clean is needed
            return { needed: true, reason: 'Could not verify dist freshness, cleaning to be safe' };
        }
    } catch (error: any) {
        logger.debug(`Error checking if clean is needed: ${error.message}`);
        // Conservative: assume clean is needed if we can't check
        return { needed: true, reason: `Could not verify: ${error.message}` };
    }
}

/**
 * Check if tests need to be run (source files changed since last test run)
 */
export async function isTestNeeded(packageDir: string): Promise<{ needed: boolean; reason: string }> {
    try {
        // Load test cache
        const cache = await loadTestCache(packageDir);
        const cacheKey = packageDir;

        // Check if we have a cached test run for this package
        const cached = cache[cacheKey];
        if (!cached) {
            return { needed: true, reason: 'No previous test run recorded' };
        }

        // Check if source files have changed since last test run
        const changeCheck = await hasSourceFilesChanged(packageDir, cached.lastCommitHash);
        if (changeCheck.changed) {
            return { needed: true, reason: changeCheck.reason };
        }

        return { needed: false, reason: 'No source file changes since last test run' };
    } catch (error: any) {
        logger.debug(`Error checking if test is needed: ${error.message}`);
        // Conservative: assume test is needed if we can't check
        return { needed: true, reason: `Could not verify: ${error.message}` };
    }
}

/**
 * Record that tests were run for this package
 */
export async function recordTestRun(packageDir: string): Promise<void> {
    try {
        const cache = await loadTestCache(packageDir);
        const cacheKey = packageDir;
        const commitHash = await getCurrentCommitHash(packageDir);

        cache[cacheKey] = {
            lastTestRun: Date.now(),
            lastCommitHash: commitHash || 'unknown'
        };

        await saveTestCache(packageDir, cache);
    } catch (error: any) {
        logger.debug(`Failed to record test run: ${error.message}`);
    }
}

/**
 * Optimize a precommit command by skipping unnecessary steps
 * Returns the optimized command and information about what was skipped
 */
export async function optimizePrecommitCommand(
    packageDir: string,
    originalCommand: string,
    options: { skipClean?: boolean; skipTest?: boolean } = {}
): Promise<{
    optimizedCommand: string;
    skipped: {
        clean: boolean;
        test: boolean;
    };
    reasons: {
        clean?: string;
        test?: string;
    };
}> {
    const { skipClean = true, skipTest = true } = options;

    // Parse the original command to extract individual scripts
    // Common patterns: "npm run precommit", "npm run clean && npm run build && npm run lint && npm run test"
    const isPrecommitScript = originalCommand.includes('precommit') || originalCommand.includes('pre-commit');

    let optimizedCommand = originalCommand;
    const skipped = { clean: false, test: false };
    const reasons: { clean?: string; test?: string } = {};

    // If it's a precommit script, we need to check what it actually runs
    // For now, we'll optimize the common pattern: clean && build && lint && test
    if (isPrecommitScript || originalCommand.includes('clean')) {
        if (skipClean) {
            const cleanCheck = await isCleanNeeded(packageDir);
            if (!cleanCheck.needed) {
                // Remove clean from the command
                optimizedCommand = optimizedCommand
                    .replace(/npm\s+run\s+clean\s+&&\s*/g, '')
                    .replace(/npm\s+run\s+clean\s+/g, '')
                    .replace(/\s*&&\s*npm\s+run\s+clean/g, '')
                    .trim();
                skipped.clean = true;
                reasons.clean = cleanCheck.reason;
            }
        }
    }

    if (isPrecommitScript || originalCommand.includes('test')) {
        if (skipTest) {
            const testCheck = await isTestNeeded(packageDir);
            if (!testCheck.needed) {
                // Remove test from the command
                optimizedCommand = optimizedCommand
                    .replace(/\s*&&\s*npm\s+run\s+test\s*/g, '')
                    .replace(/\s*&&\s*npm\s+run\s+test$/g, '')
                    .replace(/npm\s+run\s+test\s+&&\s*/g, '')
                    .trim();
                skipped.test = true;
                reasons.test = testCheck.reason;
            }
        }
    }

    // Clean up any double && or trailing &&
    optimizedCommand = optimizedCommand.replace(/\s*&&\s*&&/g, ' && ').replace(/&&\s*$/, '').trim();

    return { optimizedCommand, skipped, reasons };
}

