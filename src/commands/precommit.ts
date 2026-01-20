#!/usr/bin/env node
import { Config } from '@eldrforge/core';
import { run } from '@eldrforge/git-tools';
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

    // Verify precommit script exists
    const fs = await import('fs/promises');
    const packageJsonPath = path.join(packageDir, 'package.json');

    let packageName = packageDir;
    try {
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent);
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

