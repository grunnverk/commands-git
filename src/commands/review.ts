#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Formatter, Model, Request } from '@kjerneverk/riotprompt';
import type { ChatCompletionMessageParam } from 'openai/resources';
import { ValidationError, FileOperationError, CommandError, createStorage } from '@grunnverk/shared';
import {
    getLogger,
    Config,
    Log,
    Diff,
    DEFAULT_EXCLUDED_PATTERNS,
    DEFAULT_OUTPUT_DIRECTORY,
    getOutputPath,
    getTimestampedRequestFilename,
    getTimestampedResponseFilename,
    getTimestampedReviewFilename,
    getTimestampedReviewNotesFilename,
    toAIConfig,
    createStorageAdapter,
    createLoggerAdapter,
    filterContent,
} from '@grunnverk/core';
import {
    createCompletion,
    getUserChoice,
    createReviewPrompt,
    ReviewContent,
    ReviewContext,
} from '@grunnverk/ai-service';
import { getReleaseNotesContent, getIssuesContent, handleIssueCreation, type Issue, type ReviewResult } from '@grunnverk/github-tools';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import fs from 'fs/promises';

// Utility function to read a review note from a file
const readReviewNoteFromFile = async (filePath: string): Promise<string> => {
    const logger = getLogger();

    try {
        logger.debug(`Reading review note from file: ${filePath}`);
        const content = await fs.readFile(filePath, 'utf8');

        if (!content.trim()) {
            throw new ValidationError(`Review file is empty: ${filePath}`);
        }

        logger.debug(`Successfully read review note from file: ${filePath} (${content.length} characters)`);
        return content.trim();
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            throw new FileOperationError(`Review file not found: ${filePath}`, filePath, error);
        }
        if (error instanceof ValidationError) {
            throw error;
        }
        throw new FileOperationError(`Failed to read review file: ${error.message}`, filePath, error);
    }
};

// Utility function to get all review files in a directory
const getReviewFilesInDirectory = async (directoryPath: string): Promise<string[]> => {
    const logger = getLogger();

    try {
        logger.debug(`Scanning directory for review files: ${directoryPath}`);
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });

        // Filter for regular files (not directories) and get full paths
        const files = entries
            .filter(entry => entry.isFile())
            .map(entry => path.join(directoryPath, entry.name))
            .sort(); // Sort alphabetically

        logger.debug(`Found ${files.length} files in directory: ${directoryPath}`);
        return files;
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            throw new FileOperationError(`Directory not found: ${directoryPath}`, directoryPath, error);
        }
        throw new FileOperationError(`Failed to read directory: ${directoryPath}`, directoryPath, error);
    }
};

// Utility function to confirm processing of individual files
const confirmFileProcessing = async (filePath: string, senditMode: boolean): Promise<boolean> => {
    const logger = getLogger();

    if (senditMode) {
        logger.info(`REVIEW_FILE_PROCESSING: Processing review file automatically | File: ${filePath} | Mode: sendit | Confirmation: auto`);
        return true;
    }

    // Check if we're in an interactive environment
    if (!isTTYSafe()) {
        logger.warn(`REVIEW_NON_INTERACTIVE: Non-interactive environment detected | File: ${filePath} | Action: Skipping confirmation | Mode: non-interactive`);
        return true;
    }

    // For interactive mode, we'll use a simple prompt
    // In a real implementation, you might want to use a more sophisticated prompt library
    logger.info(`\nREVIEW_FILE_PROMPT: Review file ready for processing | File: ${filePath}`);
    logger.info('REVIEW_FILE_ACTION: Press Enter to process or type "skip" to skip | Options: [Enter]=process, "skip"=skip');

    // This is a simplified confirmation - in practice you might want to use a proper prompt library
    return new Promise((resolve) => {
        process.stdin.once('data', (data) => {
            const input = data.toString().trim().toLowerCase();
            if (input === 'skip' || input === 'n' || input === 'no') {
                logger.info(`REVIEW_FILE_SKIPPED: User chose to skip file | File: ${filePath} | Action: skipped`);
                resolve(false);
            } else {
                logger.info(`REVIEW_FILE_PROCESSING: User confirmed file for processing | File: ${filePath} | Action: processing`);
                resolve(true);
            }
        });
    });
};

// New function for file selection phase
const selectFilesForProcessing = async (reviewFiles: string[], senditMode: boolean): Promise<string[]> => {
    const logger = getLogger();

    if (senditMode) {
        logger.info(`REVIEW_AUTO_SELECT: Auto-selecting all files for processing | Mode: sendit | File Count: ${reviewFiles.length} | Confirmation: automatic`);
        return reviewFiles;
    }

    // Check if we're in an interactive environment
    if (!isTTYSafe()) {
        logger.warn(`REVIEW_NON_INTERACTIVE_SELECT: Non-interactive environment detected | Action: Selecting all files | Mode: non-interactive`);
        return reviewFiles;
    }

    logger.info(`\nREVIEW_SELECTION_PHASE: Starting file selection phase | File Count: ${reviewFiles.length} | Purpose: Choose files to process`);
    logger.info(`REVIEW_SELECTION_FILES: Found files to review | Count: ${reviewFiles.length} | Action: Select files for processing`);
    logger.info(`REVIEW_SELECTION_OPTIONS: File selection options available | [c]=Confirm | [s]=Skip | [a]=Abort`);
    logger.info(``);

    const selectedFiles: string[] = [];
    let shouldAbort = false;

    for (let i = 0; i < reviewFiles.length; i++) {
        const filePath = reviewFiles[i];
        logger.info(`REVIEW_SELECTION_FILE: File for review | Progress: ${i + 1}/${reviewFiles.length} | File: ${filePath}`);

        const choice = await getUserChoice(
            `Select action for this file:`,
            [
                { key: 'c', label: 'Confirm and process' },
                { key: 's', label: 'Skip this file' },
                { key: 'a', label: 'Abort entire review' }
            ]
        );

        if (choice === 'a') {
            logger.info(`REVIEW_ABORTED: User aborted review process | Action: Aborting | Reason: User request`);
            shouldAbort = true;
            break;
        } else if (choice === 'c') {
            selectedFiles.push(filePath);
            logger.info(`REVIEW_FILE_SELECTED: File selected for processing | File: ${filePath} | Action: Will be processed`);
        } else if (choice === 's') {
            logger.info(`REVIEW_FILE_SKIPPED: File skipped during selection | File: ${filePath} | Action: Will not be processed`);
        }
    }

    if (shouldAbort) {
        throw new Error('Review process aborted by user');
    }

    if (selectedFiles.length === 0) {
        throw new Error('No files were selected for processing');
    }

    logger.info(`\n📋 File selection complete. ${selectedFiles.length} files selected for processing:`);
    selectedFiles.forEach((file, index) => {
        logger.info(`  ${index + 1}. ${file}`);
    });
    logger.info(``);

    return selectedFiles;
};

// Safe temp file handling with proper permissions and validation
const createSecureTempFile = async (): Promise<string> => {
    const logger = getLogger();
    const tmpDir = os.tmpdir();

    // Ensure temp directory exists and is writable
    try {
        // Use constant value directly to avoid import restrictions
        const W_OK = 2; // fs.constants.W_OK value
        await fs.access(tmpDir, W_OK);
    } catch (error: any) {
        logger.error(`TEMP_DIR_NOT_WRITABLE: Temporary directory is not writable | Directory: ${tmpDir} | Impact: Cannot create temp files`);
        throw new FileOperationError(`Temp directory not writable: ${error.message}`, tmpDir, error);
    }

    const tmpFilePath = path.join(tmpDir, `kodrdriv_review_${Date.now()}_${Math.random().toString(36).substring(7)}.md`);

    // Create file with restrictive permissions (owner read/write only)
    try {
        const fd = await fs.open(tmpFilePath, 'w', 0o600);
        await fd.close();
        logger.debug(`Created secure temp file: ${tmpFilePath}`);
        return tmpFilePath;
    } catch (error: any) {
        logger.error(`TEMP_FILE_CREATE_FAILED: Unable to create temporary file | Error: ${error.message} | Impact: Cannot proceed with review`);
        throw new FileOperationError(`Failed to create temp file: ${error.message}`, 'temporary file', error);
    }
};

// Safe file cleanup with proper error handling
const cleanupTempFile = async (filePath: string): Promise<void> => {
    const logger = getLogger();
    try {
        await fs.unlink(filePath);
        logger.debug(`Cleaned up temp file: ${filePath}`);
    } catch (error: any) {
        // Only ignore ENOENT (file not found) errors, log others
        if (error.code !== 'ENOENT') {
            logger.warn(`TEMP_FILE_CLEANUP_FAILED: Unable to cleanup temporary file | File: ${filePath} | Error: ${error.message} | Impact: File may remain`);
            // Don't throw here to avoid masking the main operation
        }
    }
};

// Editor with optional timeout and proper error handling
const openEditorWithTimeout = async (editorCmd: string, filePath: string, timeoutMs?: number): Promise<void> => {
    const logger = getLogger();

    return new Promise((resolve, reject) => {
        if (timeoutMs) {
            logger.debug(`Opening editor: ${editorCmd} ${filePath} (timeout: ${timeoutMs}ms)`);
        } else {
            logger.debug(`Opening editor: ${editorCmd} ${filePath} (no timeout)`);
        }

        const child = spawn(editorCmd, [filePath], {
            stdio: 'inherit',
            shell: false // Prevent shell injection
        });

        let timeout: NodeJS.Timeout | undefined;
        let timeoutCleared = false;

        const clearTimeoutSafely = () => {
            if (timeout && !timeoutCleared) {
                clearTimeout(timeout);
                timeoutCleared = true;
            }
        };

        if (timeoutMs) {
            timeout = setTimeout(() => {
                clearTimeoutSafely(); // Clear the timeout immediately when it fires
                logger.warn(`Editor timed out after ${timeoutMs}ms, terminating...`);
                child.kill('SIGTERM');

                // Give it a moment to terminate gracefully, then force kill
                setTimeout(() => {
                    if (!child.killed) {
                        logger.warn('Editor did not terminate gracefully, force killing...');
                        child.kill('SIGKILL');
                    }
                }, 5000);

                reject(new Error(`Editor '${editorCmd}' timed out after ${timeoutMs}ms. Consider using a different editor or increasing the timeout.`));
            }, timeoutMs);
        }

        child.on('exit', (code, signal) => {
            clearTimeoutSafely();
            logger.debug(`Editor exited with code ${code}, signal ${signal}`);

            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                reject(new Error(`Editor was terminated (${signal})`));
            } else if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Editor exited with non-zero code: ${code}`));
            }
        });

        child.on('error', (error) => {
            clearTimeoutSafely();
            logger.error(`Editor error: ${error.message}`);
            reject(new Error(`Failed to launch editor '${editorCmd}': ${error.message}`));
        });
    });
};

// Validate API response format before use
const validateReviewResult = (data: any): ReviewResult => {
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid API response: expected object, got ' + typeof data);
    }

    if (typeof data.summary !== 'string') {
        throw new Error('Invalid API response: missing or invalid summary field');
    }

    if (typeof data.totalIssues !== 'number' || data.totalIssues < 0) {
        throw new Error('Invalid API response: missing or invalid totalIssues field');
    }

    if (data.issues && !Array.isArray(data.issues)) {
        throw new Error('Invalid API response: issues field must be an array');
    }

    // Validate each issue if present
    if (data.issues) {
        for (let i = 0; i < data.issues.length; i++) {
            const issue = data.issues[i];
            if (!issue || typeof issue !== 'object') {
                throw new Error(`Invalid API response: issue ${i} is not an object`);
            }
            if (typeof issue.title !== 'string') {
                throw new Error(`Invalid API response: issue ${i} missing title`);
            }
            if (typeof issue.priority !== 'string') {
                throw new Error(`Invalid API response: issue ${i} missing priority`);
            }
        }
    }

    return data as ReviewResult;
};

// Enhanced TTY detection with fallback handling
const isTTYSafe = (): boolean => {
    try {
        // Primary check
        if (process.stdin.isTTY === false) {
            return false;
        }

        // Additional checks for edge cases
        if (process.stdin.isTTY === true) {
            return true;
        }

        // Handle undefined case (some environments)
        if (process.stdin.isTTY === undefined) {
            // Check if we can reasonably assume interactive mode
            return process.stdout.isTTY === true && process.stderr.isTTY === true;
        }

        return false;
    } catch (error) {
        // If TTY detection fails entirely, assume non-interactive
        getLogger().debug(`TTY detection failed: ${error}, assuming non-interactive`);
        return false;
    }
};

// Safe file write with disk space and permission validation
const safeWriteFile = async (filePath: string, content: string, encoding: BufferEncoding = 'utf-8'): Promise<void> => {
    const logger = getLogger();

    try {
        // Check if parent directory exists and is writable
        const parentDir = path.dirname(filePath);
        const W_OK = 2; // fs.constants.W_OK value
        await fs.access(parentDir, W_OK);

        // Check available disk space (basic check by writing a small test)
        const testFile = `${filePath}.test`;
        try {
            await fs.writeFile(testFile, 'test', encoding);
            await fs.unlink(testFile);
        } catch (error: any) {
            if (error.code === 'ENOSPC') {
                throw new Error(`Insufficient disk space to write file: ${filePath}`);
            }
            throw error;
        }

        // Write the actual file
        await fs.writeFile(filePath, content, encoding);
        logger.debug(`Successfully wrote file: ${filePath} (${content.length} characters)`);

    } catch (error: any) {
        logger.error(`Failed to write file ${filePath}: ${error.message}`);
        throw new Error(`Failed to write file ${filePath}: ${error.message}`);
    }
};

// Helper function to process a single review note
const processSingleReview = async (reviewNote: string, runConfig: Config, outputDirectory: string): Promise<ReviewResult> => {
    const logger = getLogger();

    // Gather additional context based on configuration with improved error handling
    let logContext = '';
    let diffContext = '';
    let releaseNotesContext = '';
    let issuesContext = '';
    const contextErrors: string[] = [];

    // Fetch commit history if enabled
    if (runConfig.review?.includeCommitHistory) {
        try {
            logger.debug('Fetching recent commit history...');
            const log = await Log.create({
                limit: runConfig.review.commitHistoryLimit
            });
            const logContent = await log.get();
            if (logContent.trim()) {
                logContext += `\n\n[Recent Commit History]\n${logContent}`;
                logger.debug('Added commit history to context (%d characters)', logContent.length);
            }
        } catch (error: any) {
            const errorMsg = `Failed to fetch commit history: ${error.message}`;
            logger.warn(errorMsg);
            contextErrors.push(errorMsg);
        }
    }

    // Fetch recent diffs if enabled
    if (runConfig.review?.includeRecentDiffs) {
        try {
            logger.debug('Fetching recent commit diffs...');
            const basePatterns = runConfig.excludedPatterns ?? DEFAULT_EXCLUDED_PATTERNS;
            const recentDiffs = await Diff.getRecentDiffsForReview({
                limit: runConfig.review.diffHistoryLimit,
                baseExcludedPatterns: basePatterns
            });
            diffContext += recentDiffs;
            if (recentDiffs.trim()) {
                logger.debug('Added recent diffs to context (%d characters)', recentDiffs.length);
            }
        } catch (error: any) {
            const errorMsg = `Failed to fetch recent diffs: ${error.message}`;
            logger.warn(errorMsg);
            contextErrors.push(errorMsg);
        }
    }

    // Fetch release notes if enabled
    if (runConfig.review?.includeReleaseNotes) {
        try {
            logger.debug('Fetching recent release notes from GitHub...');
            const releaseNotesContent = await getReleaseNotesContent({
                limit: runConfig.review.releaseNotesLimit || 3
            });
            if (releaseNotesContent.trim()) {
                releaseNotesContext += `\n\n[Recent Release Notes]\n${releaseNotesContent}`;
                logger.debug('Added release notes to context (%d characters)', releaseNotesContent.length);
            }
        } catch (error: any) {
            const errorMsg = `Failed to fetch release notes: ${error.message}`;
            logger.warn(errorMsg);
            contextErrors.push(errorMsg);
        }
    }

    // Fetch GitHub issues if enabled
    if (runConfig.review?.includeGithubIssues) {
        try {
            logger.debug('Fetching open GitHub issues...');
            issuesContext = await getIssuesContent({
                limit: runConfig.review.githubIssuesLimit || 20
            });
            if (issuesContext.trim()) {
                logger.debug('Added GitHub issues to context (%d characters)', issuesContext.length);
            }
        } catch (error: any) {
            const errorMsg = `Failed to fetch GitHub issues: ${error.message}`;
            logger.warn(errorMsg);
            contextErrors.push(errorMsg);
        }
    }

    // Report context gathering results
    if (contextErrors.length > 0) {
        logger.warn(`Context gathering completed with ${contextErrors.length} error(s):`);
        contextErrors.forEach(error => logger.warn(`  - ${error}`));

        // For critical operations, consider failing if too many context sources fail
        const maxContextErrors = runConfig.review?.maxContextErrors || contextErrors.length; // Default: allow all errors
        if (contextErrors.length > maxContextErrors) {
            throw new Error(`Too many context gathering errors (${contextErrors.length}), aborting review. Consider checking your configuration and network connectivity.`);
        }
    }

    // Analyze review note for issues using OpenAI
    logger.info('REVIEW_ANALYSIS_STARTING: Analyzing review note for project issues | Source: review note | Purpose: Identify actionable issues');
    logger.debug('Context summary:');
    logger.debug('  - Review note: %d chars', reviewNote.length);
    logger.debug('  - Log context: %d chars', logContext.length);
    logger.debug('  - Diff context: %d chars', diffContext.length);
    logger.debug('  - Release notes context: %d chars', releaseNotesContext.length);
    logger.debug('  - Issues context: %d chars', issuesContext.length);
    logger.debug('  - User context: %d chars', runConfig.review?.context?.length || 0);

    const promptConfig = {
        overridePaths: (runConfig as any).discoveredConfigDirs || [],
        overrides: runConfig.overrides || false,
    };
    // Create adapters for ai-service
    const aiConfig = toAIConfig(runConfig);
    const aiStorageAdapter = createStorageAdapter(outputDirectory);
    const aiLogger = createLoggerAdapter(runConfig.dryRun || false);

    const promptContent: ReviewContent = {
        notes: reviewNote,
    };
    const promptContext: ReviewContext = {
        context: runConfig.review?.context,
        logContext,
        diffContext,
        releaseNotesContext,
        issuesContext,
    };
    const prompt = await createReviewPrompt(promptConfig, promptContent, promptContext);

    const modelToUse = aiConfig.commands?.review?.model || aiConfig.model || 'gpt-4o-mini';
    const request: Request = Formatter.create({ logger }).formatPrompt(modelToUse as Model, prompt);

    let analysisResult: ReviewResult;
    try {
        const rawResult = await createCompletion(request.messages as ChatCompletionMessageParam[], {
            model: modelToUse,
            openaiReasoning: aiConfig.commands?.review?.reasoning || aiConfig.reasoning,
            responseFormat: { type: 'json_object' },
            debug: runConfig.debug,
            debugRequestFile: getOutputPath(outputDirectory, getTimestampedRequestFilename('review-analysis')),
            debugResponseFile: getOutputPath(outputDirectory, getTimestampedResponseFilename('review-analysis')),
            storage: aiStorageAdapter,
            logger: aiLogger,
        });

        // Validate the API response before using it
        const rawAnalysisResult = validateReviewResult(rawResult);

        // Apply stop-context filtering to issues
        analysisResult = {
            ...rawAnalysisResult,
            summary: filterContent(rawAnalysisResult.summary, runConfig.stopContext).filtered,
            issues: rawAnalysisResult.issues?.map(issue => ({
                ...issue,
                title: filterContent(issue.title, runConfig.stopContext).filtered,
                description: filterContent(issue.description || '', runConfig.stopContext).filtered,
            })),
        };

    } catch (error: any) {
        logger.error(`REVIEW_ANALYSIS_FAILED: Unable to analyze review note | Error: ${error.message} | Impact: Cannot identify issues`);
        throw new Error(`Review analysis failed: ${error.message}`);
    }

    logger.info('REVIEW_ANALYSIS_COMPLETE: Review note analysis completed successfully | Status: completed | Next: Issue creation if enabled');
    logger.debug('Analysis result summary: %s', analysisResult.summary);
    logger.debug('Total issues found: %d', analysisResult.totalIssues);
    logger.debug('Issues array length: %d', analysisResult.issues?.length || 0);
    if (analysisResult.issues && analysisResult.issues.length > 0) {
        analysisResult.issues.forEach((issue, index) => {
            logger.debug('  Issue %d: [%s] %s', index + 1, issue.priority, issue.title);
        });
    }

    // Save timestamped copy of analysis result to output directory
    try {
        const reviewFilename = getTimestampedReviewFilename();
        const reviewPath = getOutputPath(outputDirectory, reviewFilename);

        // Format the analysis result as markdown
        const reviewContent = `# Review Analysis Result\n\n` +
            `## Summary\n${analysisResult.summary}\n\n` +
            `## Total Issues Found\n${analysisResult.totalIssues}\n\n` +
            `## Issues\n\n${JSON.stringify(analysisResult.issues, null, 2)}\n\n` +
            `---\n\n*Analysis completed at ${new Date().toISOString()}*`;

        await safeWriteFile(reviewPath, reviewContent);
        logger.debug('Saved timestamped review analysis: %s', reviewPath);
    } catch (error: any) {
        logger.warn('Failed to save timestamped review analysis: %s', error.message);
        // Don't fail the entire operation for this
    }

    return analysisResult;
};

const executeInternal = async (runConfig: Config): Promise<string> => {
    const logger = getLogger();
    const isDryRun = runConfig.dryRun || false;

    // Show configuration even in dry-run mode
    logger.debug('Review context configuration:');
    logger.debug('  Include commit history: %s', runConfig.review?.includeCommitHistory);
    logger.debug('  Include recent diffs: %s', runConfig.review?.includeRecentDiffs);
    logger.debug('  Include release notes: %s', runConfig.review?.includeReleaseNotes);
    logger.debug('  Include GitHub issues: %s', runConfig.review?.includeGithubIssues);
    logger.debug('  Commit history limit: %d', runConfig.review?.commitHistoryLimit);
    logger.debug('  Diff history limit: %d', runConfig.review?.diffHistoryLimit);
    logger.debug('  Release notes limit: %d', runConfig.review?.releaseNotesLimit);
    logger.debug('  GitHub issues limit: %d', runConfig.review?.githubIssuesLimit);
    logger.debug('  Sendit mode (auto-create issues): %s', runConfig.review?.sendit);
    logger.debug('  File: %s', runConfig.review?.file || 'not specified');
    logger.debug('  Directory: %s', runConfig.review?.directory || 'not specified');

    if (isDryRun) {
        if (runConfig.review?.file) {
            logger.info('DRY RUN: Would read review note from file: %s', runConfig.review.file);
        } else if (runConfig.review?.directory) {
            logger.info('DRY RUN: Would process review files in directory: %s', runConfig.review.directory);
            logger.info('DRY RUN: Would first select which files to process, then analyze selected files');
        } else if (runConfig.review?.note) {
            logger.info('DRY RUN: Would analyze provided note for review');
        } else {
            logger.info('DRY RUN: Would open editor to capture review note');
        }

        logger.info('DRY RUN: Would gather additional context based on configuration above');
        logger.info('DRY RUN: Would analyze note and identify issues');

        if (runConfig.review?.sendit) {
            logger.info('DRY RUN: Would automatically create GitHub issues (sendit mode enabled)');
        } else {
            logger.info('DRY RUN: Would prompt for confirmation before creating GitHub issues');
        }

        // Show what exclusion patterns would be used in dry-run mode
        if (runConfig.review?.includeRecentDiffs) {
            const basePatterns = runConfig.excludedPatterns ?? DEFAULT_EXCLUDED_PATTERNS;
            const reviewExcluded = Diff.getReviewExcludedPatterns(basePatterns);
            logger.info('DRY RUN: Would use %d exclusion patterns for diff context', reviewExcluded.length);
            logger.debug('DRY RUN: Sample exclusions: %s', reviewExcluded.slice(0, 15).join(', ') +
                (reviewExcluded.length > 15 ? '...' : ''));
        }

        return 'DRY RUN: Review command would analyze note, gather context, and create GitHub issues';
    }

    // Enhanced TTY check with proper error handling
    const isInteractive = isTTYSafe();
    if (!isInteractive && !runConfig.review?.sendit) {
        logger.error('❌ STDIN is piped but --sendit flag is not enabled');
        logger.error('   Interactive prompts cannot be used when input is piped');
        logger.error('   Solutions:');
        logger.error('   • Add --sendit flag to auto-create all issues');
        logger.error('   • Use terminal input instead of piping');
        logger.error('   • Example: echo "note" | kodrdriv review --sendit');
        throw new ValidationError('Piped input requires --sendit flag for non-interactive operation');
    }

    // Get the review note from configuration
    let reviewNote = runConfig.review?.note;
    let reviewFiles: string[] = [];

    // Check if we should process a single file
    if (runConfig.review?.file) {
        logger.info(`📁 Reading review note from file: ${runConfig.review.file}`);
        reviewNote = await readReviewNoteFromFile(runConfig.review.file);
        reviewFiles = [runConfig.review.file];
    }
    // Check if we should process a directory
    else if (runConfig.review?.directory) {
        logger.info(`📁 Processing review files in directory: ${runConfig.review.directory}`);
        reviewFiles = await getReviewFilesInDirectory(runConfig.review.directory);

        if (reviewFiles.length === 0) {
            throw new ValidationError(`No review files found in directory: ${runConfig.review.directory}`);
        }

        logger.info(`📁 Found ${reviewFiles.length} files to process`);

        // Set a dummy reviewNote for directory mode to satisfy validation
        // The actual review notes will be read from each file during processing
        reviewNote = `Processing ${reviewFiles.length} files from directory`;

        // If not in sendit mode, explain the two-phase process
        if (!runConfig.review?.sendit) {
            logger.info(`📝 Interactive mode: You will first select which files to process, then they will be analyzed in order.`);
            logger.info(`📝 Use --sendit to process all files automatically without confirmation.`);
        }
    }
    // Otherwise, use the note from configuration or open editor
    else if (runConfig.review?.note) {
        reviewNote = runConfig.review.note;
        reviewFiles = ['provided note'];
    } else {
        // Open editor to capture review note
        const editor = process.env.EDITOR || process.env.VISUAL || 'vi';

        let tmpFilePath: string | null = null;
        try {
            // Create secure temporary file
            tmpFilePath = await createSecureTempFile();

            // Pre-populate the file with a helpful header so users know what to do.
            const templateContent = [
                '# Kodrdriv Review Note',
                '',
                '# Please enter your review note below. Lines starting with "#" will be ignored.',
                '# Save and close the editor when you are done.',
                '',
                '',
            ].join('\n');

            await safeWriteFile(tmpFilePath, templateContent);

            logger.info(`No review note provided – opening ${editor} to capture input...`);

            // Open the editor with optional timeout protection
            const editorTimeout = runConfig.review?.editorTimeout; // No default timeout - let user take their time
            await openEditorWithTimeout(editor, tmpFilePath, editorTimeout);

            // Read the file back in, stripping comment lines and whitespace.
            const fileContent = (await fs.readFile(tmpFilePath, 'utf8'))
                .split('\n')
                .filter(line => !line.trim().startsWith('#'))
                .join('\n')
                .trim();

            if (!fileContent) {
                throw new ValidationError('Review note is empty – aborting. Provide a note as an argument, via STDIN, or through the editor.');
            }

            reviewNote = fileContent;

            // If the original runConfig.review object exists, update it so downstream code has the note.
            if (runConfig.review) {
                runConfig.review.note = reviewNote;
            }

        } catch (error: any) {
            logger.error(`Failed to capture review note via editor: ${error.message}`);
            throw error;
        } finally {
            // Always clean up the temp file
            if (tmpFilePath) {
                await cleanupTempFile(tmpFilePath);
            }
        }

        reviewFiles = ['editor input'];
    }

    if (!reviewNote || !reviewNote.trim()) {
        throw new ValidationError('No review note provided or captured');
    }

    logger.info('📝 Starting review analysis...');
    logger.debug('Review note: %s', reviewNote);
    logger.debug('Review note length: %d characters', reviewNote.length);

    const outputDirectory = runConfig.outputDirectory || DEFAULT_OUTPUT_DIRECTORY;
    const storage = createStorage();
    await storage.ensureDirectory(outputDirectory);

    // Save timestamped copy of review notes to output directory
    try {
        const reviewNotesFilename = getTimestampedReviewNotesFilename();
        const reviewNotesPath = getOutputPath(outputDirectory, reviewNotesFilename);
        const reviewNotesContent = `# Review Notes\n\n${reviewNote}\n\n`;
        await safeWriteFile(reviewNotesPath, reviewNotesContent);
        logger.debug('Saved timestamped review notes: %s', reviewNotesPath);
    } catch (error: any) {
        logger.warn('Failed to save review notes: %s', error.message);
    }

    // Phase 1: File selection (only for directory mode)
    let selectedFiles: string[];
    if (runConfig.review?.directory) {
        selectedFiles = await selectFilesForProcessing(reviewFiles, runConfig.review?.sendit || false);
    } else {
        // For single note mode, just use the note directly
        selectedFiles = ['single note'];
    }

    // Phase 2: Process selected files in order
    logger.info(`\n📝 Starting analysis phase...`);
    const results: ReviewResult[] = [];
    const processedFiles: string[] = [];

    if (runConfig.review?.directory) {
        // Directory mode: process each selected file
        for (let i = 0; i < selectedFiles.length; i++) {
            const filePath = selectedFiles[i];
            try {
                logger.info(`📝 Processing file ${i + 1}/${selectedFiles.length}: ${filePath}`);
                const fileNote = await readReviewNoteFromFile(filePath);
                const fileResult = await processSingleReview(fileNote, runConfig, outputDirectory);
                results.push(fileResult);
                processedFiles.push(filePath);
            } catch (error: any) {
                // Check if this is a critical error that should be propagated
                if (error.message.includes('Too many context gathering errors')) {
                    throw error; // Propagate critical context errors
                }
                logger.warn(`Failed to process file ${filePath}: ${error.message}`);
                // Continue with other files for non-critical errors
            }
        }
    } else {
        // Single note mode: process the note directly
        try {
            logger.info(`📝 Processing single review note`);
            const fileResult = await processSingleReview(reviewNote, runConfig, outputDirectory);
            results.push(fileResult);
            processedFiles.push('single note');
        } catch (error: any) {
            logger.warn(`Failed to process review note: ${error.message}`);
            throw error; // Re-throw for single note mode since there's only one item
        }
    }

    if (results.length === 0) {
        throw new ValidationError('No files were processed successfully');
    }

    // Combine results if we processed multiple files
    let analysisResult: ReviewResult;
    if (results.length === 1) {
        analysisResult = results[0];
    } else {
        logger.info(`✅ Successfully processed ${results.length} review files`);

        // Create a combined summary
        const totalIssues = results.reduce((sum, result) => sum + result.totalIssues, 0);
        const allIssues = results.flatMap(result => result.issues || []);

        analysisResult = {
            summary: `Combined analysis of ${results.length} review files. Total issues found: ${totalIssues}`,
            totalIssues,
            issues: allIssues
        };

        // Save combined results
        try {
            const combinedFilename = getTimestampedReviewFilename();
            const combinedPath = getOutputPath(outputDirectory, combinedFilename);
            const combinedContent = `# Combined Review Analysis Result\n\n` +
                `## Summary\n${analysisResult.summary}\n\n` +
                `## Total Issues Found\n${totalIssues}\n\n` +
                `## Files Processed\n${processedFiles.join('\n')}\n\n` +
                `## Issues\n\n${JSON.stringify(allIssues, null, 2)}\n\n` +
                `---\n\n*Combined analysis completed at ${new Date().toISOString()}*`;

            await safeWriteFile(combinedPath, combinedContent);
            logger.debug('Saved combined review analysis: %s', combinedPath);
        } catch (error: any) {
            logger.warn('Failed to save combined review analysis: %s', error.message);
        }
    }

    // Handle GitHub issue creation using the issues module
    const senditMode = runConfig.review?.sendit || false;
    return await handleIssueCreation(analysisResult, senditMode);
};

export const execute = async (runConfig: Config): Promise<string> => {
    try {
        return await executeInternal(runConfig);
    } catch (error: any) {
        const logger = getLogger();

        if (error instanceof ValidationError) {
            logger.error(`review failed: ${error.message}`);
            throw error;
        }

        if (error instanceof FileOperationError) {
            logger.error(`review failed: ${error.message}`);
            if (error.cause && typeof error.cause === 'object' && 'message' in error.cause) {
                logger.debug(`Caused by: ${(error.cause as Error).message}`);
            }
            throw error;
        }

        if (error instanceof CommandError) {
            logger.error(`review failed: ${error.message}`);
            if (error.cause && typeof error.cause === 'object' && 'message' in error.cause) {
                logger.debug(`Caused by: ${(error.cause as Error).message}`);
            }
            throw error;
        }

        // Unexpected errors
        logger.error(`review encountered unexpected error: ${error.message}`);
        throw error;
    }
};
