#!/usr/bin/env node
import { Config } from '@grunnverk/core';
import { run } from '@grunnverk/git-tools';
import { PerformanceTimer } from '../util/performance';
import { getMcpAwareLogger } from '../util/mcpLogger';
import path from 'path';

/**
 * Execute precommit checks by running the package's precommit script.
 * Expects the package to have a "precommit" script in package.json.
 */
export const execute = async (runConfig: Config): Promise<string> => {
    const logger = getMcpAwareLogger();
    const isDryRun = runConfig.dryRun || false;
    const packageDir = process.cwd();
    const shouldFix = runConfig.precommit?.fix || false;

    // Verify precommit script exists
    const fs = await import('fs/promises');
    const packageJsonPath = path.join(packageDir, 'package.json');

    let packageName = packageDir;
    let packageJson: any;
    try {
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
        packageJson = JSON.parse(packageJsonContent);
        packageName = packageJson.name || packageDir;

        if (!packageJson.scripts?.precommit) {
            throw new Error(`Package "${packageName}" is missing a "precommit" script in package.json`);
        }
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            throw new Error(`No package.json found at ${packageJsonPath}`);
        }
        throw error;
    }

    // If --fix is enabled, try to run lint --fix before precommit
    if (shouldFix && packageJson.scripts?.lint) {
        const lintFixCommand = 'npm run lint -- --fix';
        if (isDryRun) {
            logger.info(`DRY RUN: Would execute: ${lintFixCommand}`);
        } else {
            try {
                logger.info(`🔧 Running lint --fix before precommit checks: ${lintFixCommand}`);
                await run(lintFixCommand, { cwd: packageDir });
                logger.info(`✅ Lint fixes applied`);
            } catch (error: any) {
                // Log warning but continue with precommit - lint --fix may fail on some issues
                logger.warn(`⚠️  Lint --fix had issues (continuing with precommit): ${error.message}`);
            }
        }
    }

    const commandToRun = 'npm run precommit';

    if (isDryRun) {
        logger.info(`DRY RUN: Would execute: ${commandToRun}`);
        return `DRY RUN: Would run precommit checks: ${commandToRun}`;
    }

    // Execute the precommit script
    const timer = PerformanceTimer.start(logger, 'Precommit checks');
    try {
        logger.info(`🔧 Running precommit checks: ${commandToRun}`);
        await run(commandToRun, { cwd: packageDir });

        const duration = timer.end('Precommit checks');
        const seconds = (duration / 1000).toFixed(1);
        logger.info(`✅ Precommit checks passed (${seconds}s)`);

        return `Precommit checks completed successfully in ${seconds}s`;
    } catch (error: any) {
        timer.end('Precommit checks');
        logger.error(`❌ Precommit checks failed: ${error.message}`);
        throw error;
    }
};

