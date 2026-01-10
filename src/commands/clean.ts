#!/usr/bin/env node
import { DEFAULT_OUTPUT_DIRECTORY, getDryRunLogger, getLogger, Config } from '@eldrforge/core';
import { FileOperationError, createStorage } from '@eldrforge/shared';

const executeInternal = async (runConfig: Config): Promise<void> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);
    const storage = createStorage();

    const outputDirectory = runConfig.outputDirectory || DEFAULT_OUTPUT_DIRECTORY;

    if (isDryRun) {
        logger.info(`CLEAN_DRY_RUN: Would remove output directory | Mode: dry-run | Directory: ${outputDirectory} | Action: Would delete if exists`);
        logger.info(`CLEAN_CHECK_DRY_RUN: Would check directory existence | Mode: dry-run | Directory: ${outputDirectory}`);
        logger.info('CLEAN_REMOVE_DRY_RUN: Would remove directory if present | Mode: dry-run | Action: Delete');
        return;
    }

    logger.info(`CLEAN_STARTING: Removing output directory | Directory: ${outputDirectory} | Action: Delete | Purpose: Clean generated files`);

    try {
        if (await storage.exists(outputDirectory)) {
            await storage.removeDirectory(outputDirectory);
            logger.info(`CLEAN_SUCCESS: Successfully removed output directory | Directory: ${outputDirectory} | Status: deleted`);
        } else {
            logger.info(`CLEAN_NOT_EXISTS: Output directory does not exist | Directory: ${outputDirectory} | Status: nothing-to-clean`);
        }
    } catch (error: any) {
        logger.error(`CLEAN_FAILED: Failed to clean output directory | Directory: ${outputDirectory} | Error: ${error.message}`);
        throw new FileOperationError('Failed to remove output directory', outputDirectory, error);
    }
};

export const execute = async (runConfig: Config): Promise<void> => {
    try {
        await executeInternal(runConfig);
    } catch (error: any) {
        const logger = getLogger();

        if (error instanceof FileOperationError) {
            logger.error(`CLEAN_COMMAND_FAILED: Clean command failed | Error: ${error.message}`);
            if (error.cause && typeof error.cause === 'object' && 'message' in error.cause) {
                logger.debug(`Caused by: ${(error.cause as Error).message}`);
            }
            throw error;
        }

        // Unexpected errors
        logger.error(`CLEAN_UNEXPECTED_ERROR: Clean encountered unexpected error | Error: ${error.message} | Type: unexpected`);
        throw error;
    }
};
