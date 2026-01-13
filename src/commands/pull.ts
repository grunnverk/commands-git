#!/usr/bin/env node
/**
 * Smart Pull Command - Intelligently pull from remote with auto-conflict resolution
 *
 * This command provides a smarter alternative to `git pull` that:
 * - Stashes uncommitted changes before pulling
 * - Tries fast-forward first, then rebase
 * - Auto-resolves common conflicts (package-lock.json, version bumps, etc.)
 * - Provides clear reporting of what was auto-resolved vs what needs manual attention
 *
 * Examples:
 *   kodrdriv pull                    # Pull from origin/current-branch
 *   kodrdriv pull --remote upstream  # Pull from upstream
 *   kodrdriv pull --branch main      # Pull from origin/main
 *   kodrdriv tree pull               # Pull all projects in tree
 */

import { getDryRunLogger, getLogger, Config } from '@eldrforge/core';
import { run, runSecure, getGitStatusSummary, getCurrentBranch } from '@eldrforge/git-tools';
import { createStorage } from '@eldrforge/shared';

// Types for pull operation
interface PullResult {
    success: boolean;
    hadConflicts: boolean;
    autoResolved: string[];
    manualRequired: string[];
    stashApplied: boolean;
    strategy: 'fast-forward' | 'rebase' | 'merge' | 'failed';
    message: string;
}

interface ConflictResolution {
    file: string;
    resolved: boolean;
    strategy: string;
    error?: string;
}

// Patterns for files that can be auto-resolved
const AUTO_RESOLVABLE_PATTERNS = {
    // Package lock files - just regenerate
    packageLock: /^package-lock\.json$/,
    yarnLock: /^yarn\.lock$/,
    pnpmLock: /^pnpm-lock\.yaml$/,

    // Generated files - take theirs and regenerate
    dist: /^dist\//,
    coverage: /^coverage\//,
    nodeModules: /^node_modules\//,

    // Build artifacts
    buildOutput: /\.(js\.map|d\.ts)$/,
};

/**
 * Check if a file can be auto-resolved
 */
function canAutoResolve(filename: string): { canResolve: boolean; strategy: string } {
    if (AUTO_RESOLVABLE_PATTERNS.packageLock.test(filename)) {
        return { canResolve: true, strategy: 'regenerate-lock' };
    }
    if (AUTO_RESOLVABLE_PATTERNS.yarnLock.test(filename)) {
        return { canResolve: true, strategy: 'regenerate-lock' };
    }
    if (AUTO_RESOLVABLE_PATTERNS.pnpmLock.test(filename)) {
        return { canResolve: true, strategy: 'regenerate-lock' };
    }
    if (AUTO_RESOLVABLE_PATTERNS.dist.test(filename)) {
        return { canResolve: true, strategy: 'take-theirs-regenerate' };
    }
    if (AUTO_RESOLVABLE_PATTERNS.coverage.test(filename)) {
        return { canResolve: true, strategy: 'take-theirs' };
    }
    if (AUTO_RESOLVABLE_PATTERNS.nodeModules.test(filename)) {
        return { canResolve: true, strategy: 'take-theirs' };
    }
    if (AUTO_RESOLVABLE_PATTERNS.buildOutput.test(filename)) {
        return { canResolve: true, strategy: 'take-theirs-regenerate' };
    }

    return { canResolve: false, strategy: 'manual' };
}

/**
 * Check if this is a package.json version conflict that can be auto-resolved
 */
async function tryResolvePackageJsonConflict(
    filepath: string,
    logger: any
): Promise<{ resolved: boolean; error?: string }> {
    const storage = createStorage();

    try {
        const content = await storage.readFile(filepath, 'utf-8');

        // Check if this is actually a conflict file
        if (!content.includes('<<<<<<<') || !content.includes('>>>>>>>')) {
            return { resolved: false, error: 'Not a conflict file' };
        }

        // Try to parse ours and theirs versions
        const oursMatch = content.match(/<<<<<<< .*?\n([\s\S]*?)=======\n/);
        const theirsMatch = content.match(/=======\n([\s\S]*?)>>>>>>> /);

        if (!oursMatch || !theirsMatch) {
            return { resolved: false, error: 'Cannot parse conflict markers' };
        }

        // For package.json, if only version differs, take the higher version
        // This is a simplified heuristic - real conflicts may need more logic
        const oursPart = oursMatch[1];
        const theirsPart = theirsMatch[1];

        // Check if this is just a version conflict
        const versionPattern = /"version":\s*"([^"]+)"/;
        const oursVersion = oursPart.match(versionPattern);
        const theirsVersion = theirsPart.match(versionPattern);

        if (oursVersion && theirsVersion) {
            // Both have versions - take higher one
            const semver = await import('semver');
            const higher = semver.gt(
                oursVersion[1].replace(/-.*$/, ''), // Strip prerelease
                theirsVersion[1].replace(/-.*$/, '')
            ) ? oursVersion[1] : theirsVersion[1];

            // Replace the conflicted version with the higher one
            let resolvedContent = content;

            // Simple approach: take theirs but use higher version
            // Remove conflict markers and use theirs as base
            resolvedContent = content.replace(
                /<<<<<<< .*?\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> .*?\n/g,
                '$1'
            );

            // Update version to higher one
            resolvedContent = resolvedContent.replace(
                /"version":\s*"[^"]+"/,
                `"version": "${higher}"`
            );

            await storage.writeFile(filepath, resolvedContent, 'utf-8');
            logger.info(`PULL_RESOLVED_VERSION: Auto-resolved version conflict | File: ${filepath} | Version: ${higher}`);
            return { resolved: true };
        }

        return { resolved: false, error: 'Complex conflict - not just version' };
    } catch (error: any) {
        return { resolved: false, error: error.message };
    }
}

/**
 * Resolve a single conflict file
 */
async function resolveConflict(
    filepath: string,
    strategy: string,
    logger: any,
    isDryRun: boolean
): Promise<ConflictResolution> {
    if (isDryRun) {
        logger.info(`PULL_RESOLVE_DRY_RUN: Would resolve conflict | File: ${filepath} | Strategy: ${strategy}`);
        return { file: filepath, resolved: true, strategy };
    }

    try {
        switch (strategy) {
            case 'regenerate-lock': {
                // Accept theirs and regenerate
                await runSecure('git', ['checkout', '--theirs', filepath]);
                await runSecure('git', ['add', filepath]);
                logger.info(`PULL_CONFLICT_RESOLVED: Accepted remote lock file | File: ${filepath} | Strategy: ${strategy} | Note: Will regenerate after pull`);
                return { file: filepath, resolved: true, strategy };
            }

            case 'take-theirs':
            case 'take-theirs-regenerate': {
                await runSecure('git', ['checkout', '--theirs', filepath]);
                await runSecure('git', ['add', filepath]);
                logger.info(`PULL_CONFLICT_RESOLVED: Accepted remote version | File: ${filepath} | Strategy: ${strategy}`);
                return { file: filepath, resolved: true, strategy };
            }

            case 'version-bump': {
                const result = await tryResolvePackageJsonConflict(filepath, logger);
                if (result.resolved) {
                    await runSecure('git', ['add', filepath]);
                    return { file: filepath, resolved: true, strategy };
                }
                return { file: filepath, resolved: false, strategy, error: result.error };
            }

            default:
                return { file: filepath, resolved: false, strategy, error: 'Unknown resolution strategy' };
        }
    } catch (error: any) {
        return { file: filepath, resolved: false, strategy, error: error.message };
    }
}

/**
 * Get list of conflicted files
 */
async function getConflictedFiles(): Promise<string[]> {
    try {
        const { stdout } = await runSecure('git', ['diff', '--name-only', '--diff-filter=U']);
        return stdout.trim().split('\n').filter(f => f.trim());
    } catch {
        return [];
    }
}

/**
 * Try to auto-resolve all conflicts
 */
async function autoResolveConflicts(
    logger: any,
    isDryRun: boolean
): Promise<{ resolved: string[]; manual: string[] }> {
    const conflictedFiles = await getConflictedFiles();
    const resolved: string[] = [];
    const manual: string[] = [];

    for (const file of conflictedFiles) {
        const { canResolve, strategy } = canAutoResolve(file);

        // Special handling for package.json
        if (file === 'package.json' || file.endsWith('/package.json')) {
            const result = await resolveConflict(file, 'version-bump', logger, isDryRun);
            if (result.resolved) {
                resolved.push(file);
            } else {
                manual.push(file);
            }
            continue;
        }

        if (canResolve) {
            const result = await resolveConflict(file, strategy, logger, isDryRun);
            if (result.resolved) {
                resolved.push(file);
            } else {
                manual.push(file);
            }
        } else {
            manual.push(file);
        }
    }

    return { resolved, manual };
}

/**
 * Stash local changes if any
 */
async function stashIfNeeded(logger: any, isDryRun: boolean): Promise<boolean> {
    const status = await getGitStatusSummary();

    if (status.hasUncommittedChanges || status.hasUnstagedFiles) {
        const changeCount = status.uncommittedCount + status.unstagedCount;
        logger.info(`PULL_STASHING: Stashing ${changeCount} local changes before pull | Staged: ${status.uncommittedCount} | Unstaged: ${status.unstagedCount}`);

        if (!isDryRun) {
            await runSecure('git', ['stash', 'push', '-m', `kodrdriv-pull-auto-stash-${Date.now()}`]);
        }
        return true;
    }
    return false;
}

/**
 * Apply stash if we created one
 */
async function applyStashIfNeeded(didStash: boolean, logger: any, isDryRun: boolean): Promise<boolean> {
    if (!didStash) return false;

    logger.info('PULL_STASH_POP: Restoring stashed changes');

    if (!isDryRun) {
        try {
            await runSecure('git', ['stash', 'pop']);
            return true;
        } catch (error: any) {
            logger.warn(`PULL_STASH_CONFLICT: Stash pop had conflicts | Error: ${error.message} | Action: Stash preserved, manual intervention needed`);
            // Don't fail - user can manually resolve stash conflicts
            return false;
        }
    }
    return true;
}

/**
 * Regenerate lock files after pull
 */
async function regenerateLockFiles(resolvedFiles: string[], logger: any, isDryRun: boolean): Promise<void> {
    const needsRegenerate = resolvedFiles.some(f =>
        f === 'package-lock.json' || f.endsWith('/package-lock.json')
    );

    if (needsRegenerate) {
        logger.info('PULL_REGENERATE_LOCK: Regenerating package-lock.json');
        if (!isDryRun) {
            try {
                await run('npm install');
                logger.info('PULL_REGENERATE_SUCCESS: Lock file regenerated successfully');
            } catch (error: any) {
                logger.warn(`PULL_REGENERATE_FAILED: Failed to regenerate lock file | Error: ${error.message}`);
            }
        }
    }
}

/**
 * Main pull execution
 */
async function executePull(
    remote: string,
    branch: string | undefined,
    logger: any,
    isDryRun: boolean
): Promise<PullResult> {
    const currentBranch = await getCurrentBranch();
    const targetBranch = branch || currentBranch;

    logger.info(`PULL_STARTING: Pulling changes | Remote: ${remote} | Branch: ${targetBranch} | Current: ${currentBranch}`);

    // Step 1: Stash any local changes
    const didStash = await stashIfNeeded(logger, isDryRun);

    // Step 2: Fetch first to see what's coming
    logger.info(`PULL_FETCH: Fetching from ${remote}`);
    if (!isDryRun) {
        try {
            await runSecure('git', ['fetch', remote, targetBranch]);
        } catch (error: any) {
            logger.error(`PULL_FETCH_FAILED: Failed to fetch | Error: ${error.message}`);
            if (didStash) await applyStashIfNeeded(true, logger, isDryRun);
            return {
                success: false,
                hadConflicts: false,
                autoResolved: [],
                manualRequired: [],
                stashApplied: didStash,
                strategy: 'failed',
                message: `Fetch failed: ${error.message}`,
            };
        }
    }

    // Step 3: Try fast-forward first
    logger.info('PULL_STRATEGY: Attempting fast-forward merge');
    if (!isDryRun) {
        try {
            await runSecure('git', ['merge', '--ff-only', `${remote}/${targetBranch}`]);
            await applyStashIfNeeded(didStash, logger, isDryRun);
            logger.info('PULL_SUCCESS: Fast-forward merge successful');
            return {
                success: true,
                hadConflicts: false,
                autoResolved: [],
                manualRequired: [],
                stashApplied: didStash,
                strategy: 'fast-forward',
                message: 'Fast-forward merge successful',
            };
        } catch {
            logger.info('PULL_FF_FAILED: Fast-forward not possible, trying rebase');
        }
    }

    // Step 4: Try rebase
    logger.info('PULL_STRATEGY: Attempting rebase');
    if (!isDryRun) {
        try {
            await runSecure('git', ['rebase', `${remote}/${targetBranch}`]);
            await applyStashIfNeeded(didStash, logger, isDryRun);
            logger.info('PULL_SUCCESS: Rebase successful');
            return {
                success: true,
                hadConflicts: false,
                autoResolved: [],
                manualRequired: [],
                stashApplied: didStash,
                strategy: 'rebase',
                message: 'Rebase successful',
            };
        } catch {
            // Check if rebase is in progress with conflicts
            const conflictedFiles = await getConflictedFiles();
            if (conflictedFiles.length > 0) {
                logger.info(`PULL_CONFLICTS: Rebase has ${conflictedFiles.length} conflicts, attempting auto-resolution`);

                // Step 5: Try to auto-resolve conflicts
                const { resolved, manual } = await autoResolveConflicts(logger, isDryRun);

                if (manual.length === 0) {
                    // All conflicts resolved, continue rebase
                    logger.info('PULL_ALL_RESOLVED: All conflicts auto-resolved, continuing rebase');
                    try {
                        await runSecure('git', ['rebase', '--continue']);
                        await regenerateLockFiles(resolved, logger, isDryRun);
                        await applyStashIfNeeded(didStash, logger, isDryRun);
                        return {
                            success: true,
                            hadConflicts: true,
                            autoResolved: resolved,
                            manualRequired: [],
                            stashApplied: didStash,
                            strategy: 'rebase',
                            message: `Rebase successful with ${resolved.length} auto-resolved conflicts`,
                        };
                    } catch (continueError: any) {
                        logger.warn(`PULL_CONTINUE_FAILED: Rebase continue failed | Error: ${continueError.message}`);
                    }
                } else {
                    // Some conflicts need manual resolution
                    logger.warn(`PULL_MANUAL_REQUIRED: ${manual.length} conflicts require manual resolution`);
                    logger.warn('PULL_MANUAL_FILES: Files needing manual resolution:');
                    manual.forEach(f => logger.warn(`  - ${f}`));
                    logger.info('PULL_HINT: After resolving conflicts manually, run: git rebase --continue');

                    // Keep rebase in progress so user can finish
                    return {
                        success: false,
                        hadConflicts: true,
                        autoResolved: resolved,
                        manualRequired: manual,
                        stashApplied: false, // Don't apply stash when manual resolution needed
                        strategy: 'rebase',
                        message: `Rebase paused: ${manual.length} files need manual conflict resolution`,
                    };
                }
            } else {
                // Rebase failed for other reason, abort and try merge
                logger.info('PULL_REBASE_ABORT: Rebase failed, aborting and trying merge');
                try {
                    await runSecure('git', ['rebase', '--abort']);
                } catch {
                    // Ignore abort errors
                }
            }
        }
    }

    // Step 6: Fall back to regular merge
    logger.info('PULL_STRATEGY: Attempting merge');
    if (!isDryRun) {
        try {
            await runSecure('git', ['merge', `${remote}/${targetBranch}`]);
            await applyStashIfNeeded(didStash, logger, isDryRun);
            logger.info('PULL_SUCCESS: Merge successful');
            return {
                success: true,
                hadConflicts: false,
                autoResolved: [],
                manualRequired: [],
                stashApplied: didStash,
                strategy: 'merge',
                message: 'Merge successful',
            };
        } catch {
            // Check for merge conflicts
            const conflictedFiles = await getConflictedFiles();
            if (conflictedFiles.length > 0) {
                logger.info(`PULL_CONFLICTS: Merge has ${conflictedFiles.length} conflicts, attempting auto-resolution`);

                const { resolved, manual } = await autoResolveConflicts(logger, isDryRun);

                if (manual.length === 0) {
                    // All conflicts resolved, commit the merge
                    logger.info('PULL_ALL_RESOLVED: All conflicts auto-resolved, completing merge');
                    try {
                        await runSecure('git', ['commit', '-m', `Merge ${remote}/${targetBranch} (auto-resolved by kodrdriv)`]);
                        await regenerateLockFiles(resolved, logger, isDryRun);
                        await applyStashIfNeeded(didStash, logger, isDryRun);
                        return {
                            success: true,
                            hadConflicts: true,
                            autoResolved: resolved,
                            manualRequired: [],
                            stashApplied: didStash,
                            strategy: 'merge',
                            message: `Merge successful with ${resolved.length} auto-resolved conflicts`,
                        };
                    } catch (commitError: any) {
                        logger.error(`PULL_COMMIT_FAILED: Merge commit failed | Error: ${commitError.message}`);
                    }
                } else {
                    logger.warn(`PULL_MANUAL_REQUIRED: ${manual.length} conflicts require manual resolution`);
                    manual.forEach(f => logger.warn(`  - ${f}`));
                    logger.info('PULL_HINT: After resolving conflicts manually, run: git commit');

                    return {
                        success: false,
                        hadConflicts: true,
                        autoResolved: resolved,
                        manualRequired: manual,
                        stashApplied: false,
                        strategy: 'merge',
                        message: `Merge paused: ${manual.length} files need manual conflict resolution`,
                    };
                }
            }
        }
    }

    // If we got here, something went wrong
    if (didStash) {
        logger.warn('PULL_STASH_PRESERVED: Local changes still stashed, use "git stash pop" to restore');
    }

    return {
        success: false,
        hadConflicts: false,
        autoResolved: [],
        manualRequired: [],
        stashApplied: false,
        strategy: 'failed',
        message: 'Pull failed - unable to merge or rebase',
    };
}

/**
 * Internal execution
 */
const executeInternal = async (runConfig: Config): Promise<string> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);

    // Get pull configuration
    const pullConfig = runConfig.pull || {};
    const remote = pullConfig.remote || 'origin';
    const branch = pullConfig.branch;

    // Execute pull
    const result = await executePull(remote, branch, logger, isDryRun);

    // Format output
    const lines: string[] = [];
    lines.push('');
    lines.push('═'.repeat(60));
    lines.push(result.success ? '✅ PULL COMPLETE' : '⚠️  PULL NEEDS ATTENTION');
    lines.push('═'.repeat(60));
    lines.push('');
    lines.push(`Strategy: ${result.strategy}`);
    lines.push(`Message: ${result.message}`);

    if (result.hadConflicts) {
        lines.push('');
        lines.push(`Conflicts detected: ${result.autoResolved.length + result.manualRequired.length}`);

        if (result.autoResolved.length > 0) {
            lines.push(`✓ Auto-resolved: ${result.autoResolved.length}`);
            result.autoResolved.forEach(f => lines.push(`   - ${f}`));
        }

        if (result.manualRequired.length > 0) {
            lines.push(`✗ Manual resolution needed: ${result.manualRequired.length}`);
            result.manualRequired.forEach(f => lines.push(`   - ${f}`));
        }
    }

    if (result.stashApplied) {
        lines.push('');
        lines.push('ℹ️  Local changes have been restored from stash');
    }

    lines.push('');
    lines.push('═'.repeat(60));

    const output = lines.join('\n');
    logger.info(output);

    return output;
};

/**
 * Execute pull command
 */
export const execute = async (runConfig: Config): Promise<string> => {
    try {
        return await executeInternal(runConfig);
    } catch (error: any) {
        const logger = getLogger();
        logger.error(`PULL_COMMAND_FAILED: Pull command failed | Error: ${error.message}`);
        throw error;
    }
};

