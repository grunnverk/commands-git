#!/usr/bin/env node
import { getLogger, Config } from '@eldrforge/core';
import { run } from '@eldrforge/git-tools';
import { optimizePrecommitCommand, recordTestRun } from '../util/precommitOptimizations';
import { PerformanceTimer } from '../util/performance';
import path from 'path';

/**
 * Execute precommit checks: lint -> build -> test
 * Skips clean step (clean should be run separately if needed)
 * Uses optimization to skip steps when unchanged
 */
export const execute = async (runConfig: Config): Promise<string> => {
    const logger = getLogger();
    const isDryRun = runConfig.dryRun || false;
    const packageDir = process.cwd();

    // Default command: lint -> build -> test (no clean)
    const defaultCommand = 'npm run lint && npm run build && npm run test';

    // Check if package.json has a precommit script
    let commandToRun = defaultCommand;
    try {
        const fs = await import('fs/promises');
        const packageJsonPath = path.join(packageDir, 'package.json');
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent);

        // If there's a precommit script, check what it does
        if (packageJson.scripts?.precommit) {
            const precommitScript = packageJson.scripts.precommit;
            // If it includes clean, we'll optimize it out
            // Otherwise, use the precommit script directly
            if (!precommitScript.includes('clean')) {
                commandToRun = `npm run precommit`;
            } else {
                // Use default command (lint -> build -> test) if precommit includes clean
                commandToRun = defaultCommand;
            }
        }
    } catch (error: any) {
        logger.debug(`Could not read package.json, using default command: ${error.message}`);
    }

    if (isDryRun) {
        logger.info(`DRY RUN: Would execute: ${commandToRun}`);
        return `DRY RUN: Would run precommit checks: ${commandToRun}`;
    }

    // Optimize the command (skip clean/test if unchanged)
    let optimizedCommand = commandToRun;
    let optimizationInfo: { skipped: { clean: boolean; test: boolean }; reasons: { clean?: string; test?: string } } | null = null;

    try {
        const optimization = await optimizePrecommitCommand(packageDir, commandToRun);
        optimizedCommand = optimization.optimizedCommand;
        optimizationInfo = { skipped: optimization.skipped, reasons: optimization.reasons };

        if (optimization.skipped.clean || optimization.skipped.test) {
            const skippedParts: string[] = [];
            if (optimization.skipped.clean) {
                skippedParts.push(`clean (${optimization.reasons.clean})`);
            }
            if (optimization.skipped.test) {
                skippedParts.push(`test (${optimization.reasons.test})`);
            }
            logger.info(`⚡ Optimized: Skipped ${skippedParts.join(', ')}`);
            if (runConfig.verbose || runConfig.debug) {
                logger.info(`   Original: ${commandToRun}`);
                logger.info(`   Optimized: ${optimizedCommand}`);
            }
        }
    } catch (error: any) {
        logger.debug(`Precommit optimization failed: ${error.message}`);
    }

    // Execute the optimized command
    const timer = PerformanceTimer.start(logger, 'Precommit checks');
    try {
        logger.info(`🔧 Running precommit checks: ${optimizedCommand}`);
        await run(optimizedCommand, { cwd: packageDir });

        const duration = timer.end('Precommit checks');
        const seconds = (duration / 1000).toFixed(1);
        logger.info(`✅ Precommit checks passed (${seconds}s)`);

        // Record test run if tests were executed (not skipped)
        if (optimizedCommand.includes('test') && (!optimizationInfo || !optimizationInfo.skipped.test)) {
            try {
                await recordTestRun(packageDir);
            } catch (error: any) {
                logger.debug(`Failed to record test run: ${error.message}`);
            }
        }

        return `Precommit checks completed successfully in ${seconds}s`;
    } catch (error: any) {
        timer.end('Precommit checks');
        logger.error(`❌ Precommit checks failed: ${error.message}`);
        throw error;
    }
};

