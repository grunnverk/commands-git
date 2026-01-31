#!/usr/bin/env node
import { Formatter, Model } from '@kjerneverk/riotprompt';
import 'dotenv/config';
import type { ChatCompletionMessageParam } from 'openai/resources';
import shellescape from 'shell-escape';
import {
    DEFAULT_EXCLUDED_PATTERNS,
    DEFAULT_OUTPUT_DIRECTORY,
    DEFAULT_MAX_DIFF_BYTES,
    Diff,
    Log,
    Files,
    getDryRunLogger,
    Config,
    sanitizeDirection,
    filterContent,
    getOutputPath,
    getTimestampedRequestFilename,
    getTimestampedResponseFilename,
    getTimestampedCommitFilename,
    improveContentWithLLM,
    type LLMImprovementConfig,
    toAIConfig,
    createStorageAdapter,
    createLoggerAdapter,
} from '@grunnverk/core';
import { CommandError, ValidationError, ExternalDependencyError, checkForFileDependencies, logFileDependencyWarning, logFileDependencySuggestions, createStorage } from '@grunnverk/shared';
import { run, validateString, stageFiles, unstageAll, verifyStagedFiles, safeJsonParse, validatePackageJson } from '@grunnverk/git-tools';
import { getRecentClosedIssuesForCommit } from '@grunnverk/github-tools';
import {
    createCompletionWithRetry,
    getUserChoice,
    editContentInEditor,
    getLLMFeedbackInEditor,
    requireTTY,
    STANDARD_CHOICES,
    CommitContent,
    CommitContext,
    runAgenticCommit,
    generateReflectionReport,
    createCommitPrompt,
} from '@grunnverk/ai-service';

// Helper function to read context files
async function readContextFiles(contextFiles: string[] | undefined, logger: any): Promise<string> {
    if (!contextFiles || contextFiles.length === 0) {
        return '';
    }

    const storage = createStorage();
    const contextParts: string[] = [];

    for (const filePath of contextFiles) {
        try {
            const content = await storage.readFile(filePath, 'utf8');
            contextParts.push(`## Context from ${filePath}\n\n${content}\n`);
            logger.debug(`Read context from file: ${filePath}`);
        } catch (error: any) {
            logger.warn(`Failed to read context file ${filePath}: ${error.message}`);
        }
    }

    return contextParts.join('\n---\n\n');
}

// Helper function to generate self-reflection output using observability module
async function generateSelfReflection(
    agenticResult: any,
    outputDirectory: string,
    storage: any,
    logger: any
): Promise<void> {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
        const reflectionPath = getOutputPath(outputDirectory, `agentic-reflection-commit-${timestamp}.md`);

        // Use new observability reflection generator
        const report = await generateReflectionReport({
            iterations: agenticResult.iterations || 0,
            toolCallsExecuted: agenticResult.toolCallsExecuted || 0,
            maxIterations: agenticResult.maxIterations || 10,
            toolMetrics: agenticResult.toolMetrics || [],
            conversationHistory: agenticResult.conversationHistory || [],
            commitMessage: agenticResult.commitMessage,
            suggestedSplits: agenticResult.suggestedSplits || [],
            logger
        });

        // Save the report to output directory
        await storage.writeFile(reflectionPath, report, 'utf8');

        logger.info('');
        logger.info('═'.repeat(80));
        logger.info('📊 SELF-REFLECTION REPORT GENERATED');
        logger.info('═'.repeat(80));
        logger.info('');
        logger.info('📁 Location: %s', reflectionPath);
        logger.info('');
        logger.info('📈 Report Summary:');
        const iterations = agenticResult.iterations || 0;
        const toolCalls = agenticResult.toolCallsExecuted || 0;
        const uniqueTools = new Set((agenticResult.toolMetrics || []).map((m: any) => m.name)).size;
        logger.info(`   • ${iterations} iterations completed`);
        logger.info(`   • ${toolCalls} tool calls executed`);
        logger.info(`   • ${uniqueTools} unique tools used`);
        logger.info('');
        logger.info('💡 Use this report to:');
        logger.info('   • Understand which tools were most effective');
        logger.info('   • Identify performance bottlenecks');
        logger.info('   • Review the complete agentic conversation');
        logger.info('   • Improve tool implementation based on metrics');
        logger.info('');
        logger.info('═'.repeat(80));

    } catch (error: any) {
        logger.warn('Failed to generate self-reflection output: %s', error.message);
        logger.debug('Self-reflection error details:', error);
    }
}

// Helper function to get current version from package.json
async function getCurrentVersion(storage: any): Promise<string | undefined> {
    try {
        const packageJsonContents = await storage.readFile('package.json', 'utf-8');
        const packageJson = safeJsonParse(packageJsonContents, 'package.json');
        const validated = validatePackageJson(packageJson, 'package.json');
        return validated.version;
    } catch {
        // Return undefined if we can't read the version (not a critical failure)
        return undefined;
    }
}

// Helper function to edit commit message using editor
async function editCommitMessageInteractively(commitMessage: string): Promise<string> {
    const templateLines = [
        '# Edit your commit message below. Lines starting with "#" will be ignored.',
        '# Save and close the editor when you are done.'
    ];

    const result = await editContentInEditor(commitMessage, templateLines, '.txt');
    return result.content;
}

// Helper function to improve commit message using LLM
async function improveCommitMessageWithLLM(
    commitMessage: string,
    runConfig: Config,
    promptConfig: any,
    promptContext: any,
    outputDirectory: string,
    diffContent: string
): Promise<string> {
    // Get user feedback on what to improve using the editor
    const userFeedback = await getLLMFeedbackInEditor('commit message', commitMessage);

    // Create AI config from kodrdriv config
    const aiConfig = toAIConfig(runConfig);
    const aiStorageAdapter = createStorageAdapter(outputDirectory);
    const aiLogger = createLoggerAdapter(false);

    const improvementConfig: LLMImprovementConfig = {
        contentType: 'commit message',
        createImprovedPrompt: async (promptConfig, currentMessage, promptContext) => {
            const improvementPromptContent: CommitContent = {
                diffContent: diffContent, // Include the original diff for context
                userDirection: `Please improve this commit message based on the user's feedback: "${userFeedback}".

Current commit message: "${currentMessage}"

Please revise the commit message according to the user's feedback while maintaining accuracy and following conventional commit standards if appropriate.`,
            };
            const prompt = await createCommitPrompt(promptConfig, improvementPromptContent, promptContext);
            // Format the prompt into a proper request with messages
            const modelToUse = aiConfig.commands?.commit?.model || aiConfig.model || 'gpt-4o-mini';
            return Formatter.create({ logger: getDryRunLogger(false) }).formatPrompt(modelToUse as Model, prompt);
        },
        callLLM: async (request, runConfig, outputDirectory) => {
            return await createCompletionWithRetry(
                request.messages as ChatCompletionMessageParam[],
                {
                    model: aiConfig.commands?.commit?.model || aiConfig.model,
                    openaiReasoning: aiConfig.commands?.commit?.reasoning || aiConfig.reasoning,
                    debug: runConfig.debug,
                    debugRequestFile: getOutputPath(outputDirectory, getTimestampedRequestFilename('commit-improve')),
                    debugResponseFile: getOutputPath(outputDirectory, getTimestampedResponseFilename('commit-improve')),
                    storage: aiStorageAdapter,
                    logger: aiLogger,
                }
            );
        }
    };

    return await improveContentWithLLM(
        commitMessage,
        runConfig,
        promptConfig,
        promptContext,
        outputDirectory,
        improvementConfig
    );
}

// Interactive feedback loop for commit message
async function handleInteractiveCommitFeedback(
    commitMessage: string,
    runConfig: Config,
    promptConfig: any,
    promptContext: any,
    outputDirectory: string,
    storage: any,
    diffContent: string,
    hasActualChanges: boolean,
    cached: boolean
): Promise<{ action: 'commit' | 'skip', finalMessage: string }> {
    const logger = getDryRunLogger(false);
    let currentMessage = commitMessage;

    // Determine what the confirm action will do based on configuration
    const senditEnabled = runConfig.commit?.sendit;
    const willActuallyCommit = senditEnabled && hasActualChanges && cached;

    // Create dynamic confirm choice based on configuration
    const isAmendMode = runConfig.commit?.amend;
    const confirmChoice = willActuallyCommit
        ? { key: 'c', label: isAmendMode ? 'Amend last commit with this message (sendit enabled)' : 'Commit changes with this message (sendit enabled)' }
        : { key: 'c', label: 'Accept message (you will need to commit manually)' };

    while (true) {
        // Display the current commit message
        logger.info('\n📝 Generated Commit Message:');
        logger.info('─'.repeat(50));
        logger.info(currentMessage);
        logger.info('─'.repeat(50));

        // Show configuration status
        if (senditEnabled) {
            if (willActuallyCommit) {
                logger.info('\nSENDIT_MODE_ACTIVE: SendIt mode enabled | Action: Commit choice will execute git commit automatically | Staged Changes: Available');
            } else {
                logger.info('\nSENDIT_MODE_NO_CHANGES: SendIt mode configured but no staged changes | Action: Only message save available | Staged Changes: None');
            }
        } else {
            logger.info('\nSENDIT_MODE_INACTIVE: SendIt mode not active | Action: Accept choice will only save message | Commit: Manual');
        }

        // Get user choice
        const userChoice = await getUserChoice(
            '\nWhat would you like to do with this commit message?',
            [
                confirmChoice,
                STANDARD_CHOICES.EDIT,
                STANDARD_CHOICES.SKIP,
                STANDARD_CHOICES.IMPROVE
            ],
            {
                nonTtyErrorSuggestions: ['Use --sendit flag to auto-commit without review']
            }
        );

        switch (userChoice) {
            case 'c':
                return { action: 'commit', finalMessage: currentMessage };

            case 'e':
                try {
                    currentMessage = await editCommitMessageInteractively(currentMessage);
                } catch (error: any) {
                    logger.error(`Failed to edit commit message: ${error.message}`);
                    // Continue the loop to show options again
                }
                break;

            case 's':
                return { action: 'skip', finalMessage: currentMessage };

            case 'i':
                try {
                    currentMessage = await improveCommitMessageWithLLM(
                        currentMessage,
                        runConfig,
                        promptConfig,
                        promptContext,
                        outputDirectory,
                        diffContent
                    );
                } catch (error: any) {
                    logger.error(`Failed to improve commit message: ${error.message}`);
                    // Continue the loop to show options again
                }
                break;

            default:
                // This shouldn't happen, but continue the loop
                break;
        }
    }
}

// Helper function to check if there are any commits in the repository
const hasCommits = async (): Promise<boolean> => {
    try {
        await run('git rev-parse HEAD');
        return true;
    } catch {
        // No commits found or not a git repository
        return false;
    }
};

// Helper function to push the commit
const pushCommit = async (pushConfig: boolean | string | undefined, logger: any, isDryRun: boolean): Promise<void> => {
    if (!pushConfig) {
        return; // No push requested
    }

    // Determine the remote to push to
    let remote = 'origin';
    if (typeof pushConfig === 'string') {
        remote = pushConfig;
    }

    const pushCommand = `git push ${remote}`;

    if (isDryRun) {
        logger.info('Would push to %s with: %s', remote, pushCommand);
    } else {
        logger.info('🚀 Pushing to %s...', remote);
        try {
            await run(pushCommand);
            logger.info('✅ Push successful!');
        } catch (error: any) {
            logger.error('Failed to push to %s: %s', remote, error.message);
            throw new ExternalDependencyError(`Failed to push to ${remote}`, 'git', error);
        }
    }
};

// Simplified cached determination with single check
const determineCachedState = async (config: Config): Promise<boolean> => {
    // If amend is used, we use staged changes (since we're amending the last commit)
    if (config.commit?.amend) {
        // For amend mode, check that there's a previous commit to amend
        const hasAnyCommits = await hasCommits();
        if (!hasAnyCommits) {
            throw new ValidationError('Cannot use --amend: no commits found in repository. Create an initial commit first.');
        }
        return true;
    }

    // If add is used, we always look at staged changes after add
    if (config.commit?.add) {
        return true;
    }

    // If explicitly set, use that value
    if (config.commit?.cached !== undefined) {
        return config.commit.cached;
    }

    // Otherwise, check if there are staged changes
    return await Diff.hasStagedChanges();
};

// Single validation of sendit + cached state
const validateSenditState = (config: Config, cached: boolean, isDryRun: boolean, logger: any): boolean => {
    if (config.commit?.sendit && !cached && !isDryRun) {
        const message = 'SendIt mode enabled, but no changes to commit.';
        logger.warn(message);
        return false; // Return false to indicate no changes to commit
    }
    return true; // Return true to indicate we can proceed
};

// Better file save handling with fallbacks
const saveCommitMessage = async (outputDirectory: string, summary: string, storage: any, logger: any): Promise<void> => {
    const timestampedFilename = getTimestampedCommitFilename();
    const primaryPath = getOutputPath(outputDirectory, timestampedFilename);

    try {
        await storage.writeFile(primaryPath, summary, 'utf-8');
        logger.debug('Saved timestamped commit message: %s', primaryPath);
        return; // Success, no fallback needed
    } catch (error: any) {
        logger.warn('Failed to save commit message to primary location (%s): %s', primaryPath, error.message);
        logger.debug('Primary save error details:', error);

        // First fallback: try output directory root (in case subdirectory has issues)
        try {
            const outputRootPath = getOutputPath('output', timestampedFilename);
            await storage.writeFile(outputRootPath, summary, 'utf-8');
            logger.info('COMMIT_MESSAGE_SAVED_FALLBACK: Saved commit message to fallback location | Path: %s | Purpose: Preserve message for later use', outputRootPath);
            return;
        } catch (outputError: any) {
            logger.warn('Failed to save to output directory fallback: %s', outputError.message);
        }

        // Last resort fallback: save to current directory (this creates the clutter!)
        try {
            const fallbackPath = `commit-message-${Date.now()}.txt`;
            await storage.writeFile(fallbackPath, summary, 'utf-8');
            logger.warn('⚠️  Saved commit message to current directory as last resort: %s', fallbackPath);
            logger.warn('⚠️  This file should be moved to the output directory and may clutter your workspace');
        } catch (fallbackError: any) {
            logger.error('Failed to save commit message anywhere: %s', fallbackError.message);
            logger.error('Commit message will only be available in console output');
            // Continue execution - commit message is still returned
        }
    }
};

// ===================================================================
// COMMIT SPLITTING TYPES AND FUNCTIONS
// ===================================================================

interface CommitSplit {
    files: string[];
    message: string;
    rationale: string;
}

interface SplitCommitOptions {
    splits: CommitSplit[];
    runConfig: Config;
    isDryRun: boolean;
    interactive: boolean;
    logger: any;
    storage: any;
}

interface SplitCommitResult {
    success: boolean;
    commitsCreated: number;
    commits: Array<{
        message: string;
        files: string[];
        sha?: string;
    }>;
    error?: Error;
    skipped: number;
}

/**
 * Deduplicate files across splits - each file can only be in one split
 * Later splits lose files that were already claimed by earlier splits
 * Returns filtered splits with empty splits removed
 */
function deduplicateSplits(
    splits: CommitSplit[],
    logger: any
): CommitSplit[] {
    const claimedFiles = new Set<string>();
    const result: CommitSplit[] = [];

    for (const split of splits) {
        // Find files in this split that haven't been claimed yet
        const uniqueFiles: string[] = [];
        const duplicates: string[] = [];

        for (const file of split.files) {
            if (claimedFiles.has(file)) {
                duplicates.push(file);
            } else {
                uniqueFiles.push(file);
                claimedFiles.add(file);
            }
        }

        // Log if duplicates were found
        if (duplicates.length > 0) {
            logger.warn(`Removing duplicate files from split "${split.message.split('\n')[0]}": ${duplicates.join(', ')}`);
        }

        // Only include split if it has files
        if (uniqueFiles.length > 0) {
            result.push({
                ...split,
                files: uniqueFiles
            });
        } else {
            logger.warn(`Skipping empty split after deduplication: "${split.message.split('\n')[0]}"`);
        }
    }

    return result;
}

/**
 * Interactive review of a single split before committing
 */
async function reviewSplitInteractively(
    split: CommitSplit,
    index: number,
    total: number,
    logger: any
): Promise<{
    action: 'commit' | 'edit' | 'skip' | 'stop';
    modifiedMessage?: string;
}> {
    logger.info('');
    logger.info('═'.repeat(80));
    logger.info(`📋 Commit ${index + 1} of ${total}`);
    logger.info('═'.repeat(80));
    logger.info('');
    logger.info('Files (%d):', split.files.length);
    split.files.forEach((f: string) => logger.info(`  - ${f}`));
    logger.info('');
    logger.info('Rationale:');
    logger.info(`  ${split.rationale}`);
    logger.info('');
    logger.info('Proposed Message:');
    logger.info('─'.repeat(50));
    logger.info(split.message);
    logger.info('─'.repeat(50));
    logger.info('');

    const choices = [
        { key: 'c', label: 'Commit with this message' },
        { key: 'e', label: 'Edit message before committing' },
        { key: 's', label: 'Skip this commit' },
        { key: 't', label: 'Stop - no more commits' }
    ];

    const choice = await getUserChoice(
        'What would you like to do?',
        choices,
        { nonTtyErrorSuggestions: ['Use --sendit to auto-commit without review'] }
    );

    if (choice === 'e') {
        // Edit the message
        const edited = await editCommitMessageInteractively(split.message);
        return { action: 'commit', modifiedMessage: edited };
    } else if (choice === 'c') {
        return { action: 'commit' };
    } else if (choice === 's') {
        return { action: 'skip' };
    } else {
        return { action: 'stop' };
    }
}

/**
 * Create a single commit from a split
 */
async function createSingleSplitCommit(
    split: CommitSplit,
    commitMessage: string,
    isDryRun: boolean,
    logger: any
): Promise<string | undefined> {
    // Stage the files for this split
    if (isDryRun) {
        logger.debug(`[DRY RUN] Would stage: ${split.files.join(', ')}`);
    } else {
        await stageFiles(split.files);

        // Verify files were staged correctly
        const verification = await verifyStagedFiles(split.files);
        if (!verification.allPresent) {
            throw new ValidationError(
                `Stage verification failed. Missing: ${verification.missing.join(', ')}. ` +
                `Unexpected: ${verification.unexpected.join(', ')}`
            );
        }
    }

    // Create the commit
    if (isDryRun) {
        logger.debug(`[DRY RUN] Would commit with message: ${commitMessage}`);
        return undefined;
    } else {
        const validatedMessage = validateString(commitMessage, 'commit message');
        const escapedMessage = shellescape([validatedMessage]);
        await run(`git commit -m ${escapedMessage}`);

        // Get the SHA of the commit we just created
        const result = await run('git rev-parse HEAD');
        const sha = (typeof result === 'string' ? result : result.stdout).trim();

        logger.debug(`Created commit: ${sha}`);
        return sha;
    }
}

/**
 * Execute a series of split commits
 */
async function executeSplitCommits(
    options: SplitCommitOptions
): Promise<SplitCommitResult> {
    const { splits, isDryRun, interactive, logger } = options;

    const result: SplitCommitResult = {
        success: false,
        commitsCreated: 0,
        commits: [],
        skipped: 0
    };

    try {
        logger.debug('Preparing to create split commits...');

        logger.info('');
        logger.info('═'.repeat(80));
        logger.info(`🔀 Creating ${splits.length} commits from staged changes`);
        logger.info('═'.repeat(80));

        // Process each split
        for (let i = 0; i < splits.length; i++) {
            const split = splits[i];

            logger.info('');
            logger.info(`Processing commit ${i + 1} of ${splits.length}...`);

            // Interactive review if enabled
            let commitMessage = split.message;
            if (interactive && !isDryRun) {
                const review = await reviewSplitInteractively(split, i, splits.length, logger);

                if (review.action === 'stop') {
                    logger.info('User stopped split commit process');
                    logger.info(`Created ${result.commitsCreated} commits before stopping`);
                    result.success = false;
                    return result;
                } else if (review.action === 'skip') {
                    logger.info(`Skipped commit ${i + 1}`);
                    result.skipped++;
                    continue;
                } else if (review.action === 'edit') {
                    commitMessage = review.modifiedMessage!;
                }
            }

            try {
                // Unstage everything first
                if (!isDryRun) {
                    await unstageAll();
                }

                // Create this split's commit
                const sha = await createSingleSplitCommit(
                    split,
                    commitMessage,
                    isDryRun,
                    logger
                );

                result.commits.push({
                    message: commitMessage,
                    files: split.files,
                    sha
                });
                result.commitsCreated++;

                if (isDryRun) {
                    logger.info(`[DRY RUN] Would create commit ${i + 1}: ${commitMessage.split('\n')[0]}`);
                } else {
                    logger.info(`✅ Created commit ${i + 1}: ${sha?.substring(0, 7)} - ${commitMessage.split('\n')[0]}`);
                }

            } catch (error: any) {
                logger.error(`Failed to create commit ${i + 1}: ${error.message}`);
                logger.info(`Successfully created ${result.commitsCreated} commits before error`);

                // Re-stage remaining files for user
                if (!isDryRun) {
                    const remainingFiles = splits.slice(i).flatMap((s: CommitSplit) => s.files);
                    try {
                        await stageFiles(remainingFiles);
                        logger.info(`Remaining ${remainingFiles.length} files are staged for manual commit`);
                    } catch (restageError: any) {
                        logger.error(`Failed to re-stage remaining files: ${restageError.message}`);
                    }
                }

                result.success = false;
                result.error = error;
                return result;
            }
        }

        result.success = true;
        return result;

    } catch (error: any) {
        logger.error(`Split commit process failed: ${error.message}`);
        result.success = false;
        result.error = error;
        return result;
    }
}

/**
 * Format a summary message for split commits
 */
function formatSplitCommitSummary(result: SplitCommitResult): string {
    const lines: string[] = [];

    lines.push('');
    lines.push('═'.repeat(80));
    lines.push('✅ COMMIT SPLITTING COMPLETE');
    lines.push('═'.repeat(80));
    lines.push('');
    lines.push(`Total commits created: ${result.commitsCreated}`);
    if (result.skipped > 0) {
        lines.push(`Commits skipped: ${result.skipped}`);
    }
    lines.push('');

    if (result.commits.length > 0) {
        lines.push('Commits:');
        lines.push('');
        result.commits.forEach((commit, idx) => {
            const sha = commit.sha ? `${commit.sha.substring(0, 7)} ` : '';
            const firstLine = commit.message.split('\n')[0];
            lines.push(`  ${idx + 1}. ${sha}${firstLine}`);
            lines.push(`     Files: ${commit.files.length}`);
        });
    }

    lines.push('');
    lines.push('═'.repeat(80));

    return lines.join('\n');
}

const executeInternal = async (runConfig: Config) => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);

    logger.info('COMMIT_START: Starting commit message generation | Mode: %s', isDryRun ? 'dry-run' : 'live');

    // Track if user explicitly chose to skip in interactive mode
    let userSkippedCommit = false;

    if (runConfig.commit?.add) {
        if (isDryRun) {
            logger.info('GIT_ADD_DRY_RUN: Would stage all changes | Mode: dry-run | Command: git add -A');
        } else {
            logger.info('GIT_ADD_STAGING: Adding all changes to index | Command: git add -A | Scope: all files | Purpose: Stage for commit');
            await run('git add -A');
            logger.info('GIT_ADD_SUCCESS: Successfully staged all changes | Command: git add -A | Status: completed');
        }
    }

    // Determine cached state with single, clear logic
    logger.info('COMMIT_CHECK_STAGED: Checking for staged changes | Action: Analyzing git status');
    const cached = await determineCachedState(runConfig);
    logger.info('COMMIT_STAGED_STATUS: Staged changes detected: %s | Cached: %s', cached ? 'yes' : 'no', cached);

    // Validate sendit state early - now returns boolean instead of throwing
    validateSenditState(runConfig, cached, isDryRun, logger);

    logger.info('COMMIT_GENERATE_DIFF: Generating diff content | Max bytes: %d', runConfig.commit?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES);
    let diffContent = '';
    const maxDiffBytes = runConfig.commit?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
    const options = {
        cached,
        excludedPatterns: runConfig.excludedPatterns ?? DEFAULT_EXCLUDED_PATTERNS,
        maxDiffBytes
    };
    const diff = await Diff.create(options);
    diffContent = await diff.get();
    logger.info('COMMIT_DIFF_GENERATED: Diff content generated | Size: %d bytes | Has changes: %s', diffContent.length, diffContent.trim().length > 0 ? 'yes' : 'no');

    // Check if there are actually any changes in the diff
    let hasActualChanges = diffContent.trim().length > 0;

    // If no changes found with current patterns, check for critical excluded files
    if (!hasActualChanges) {
        const criticalChanges = await Diff.hasCriticalExcludedChanges();

        if (criticalChanges.hasChanges) {
            logger.info('CRITICAL_FILES_DETECTED: No changes with exclusion patterns, but critical files modified | Files: %s | Action: May need to include critical files',
                criticalChanges.files.join(', '));

            if (runConfig.commit?.sendit && !isDryRun) {
                // In sendit mode, automatically include critical files
                logger.info('SENDIT_INCLUDING_CRITICAL: SendIt mode including critical files in diff | Purpose: Ensure all important changes are captured');
                const minimalPatterns = Diff.getMinimalExcludedPatterns(runConfig.excludedPatterns ?? DEFAULT_EXCLUDED_PATTERNS);
                const updatedOptions = { ...options, excludedPatterns: minimalPatterns };
                const updatedDiff = await Diff.create(updatedOptions);
                diffContent = await updatedDiff.get();

                if (diffContent.trim().length > 0) {
                    logger.info('CRITICAL_FILES_INCLUDED: Successfully added critical files to diff | Status: ready for commit message generation');
                    // Update hasActualChanges since we now have content after including critical files
                    hasActualChanges = true;
                } else {
                    logger.warn('No changes detected even after including critical files.');
                    return 'No changes to commit.';
                }
            } else {
                // In non-sendit mode, suggest including the files
                logger.warn('Consider including these files by using:');
                logger.warn('  kodrdriv commit --excluded-paths %s',
                    (runConfig.excludedPatterns ?? DEFAULT_EXCLUDED_PATTERNS)
                        .filter(p => !criticalChanges.files.some(f => p.includes(f.split('/').pop() || '')))
                        .map(p => `"${p}"`)
                        .join(' '));
                logger.warn('Or run with --sendit to automatically include critical files.');

                if (!isDryRun) {
                    return 'No changes to commit. Use suggestions above to include critical files.';
                } else {
                    logger.info('Generating commit message template for future use...');
                }
            }
        } else {
            // No changes at all - try fallback to file content for new repositories
            logger.info('NO_CHANGES_DETECTED: No changes found in working directory | Status: clean | Action: Nothing to commit');

            if (runConfig.commit?.sendit && !isDryRun) {
                logger.warn('No changes detected to commit. Skipping commit operation.');
                return 'No changes to commit.';
            } else {
                logger.info('NO_DIFF_FALLBACK: No diff content available | Action: Attempting to generate commit message from file content | Strategy: fallback');

                // Create file content collector as fallback
                const fileOptions = {
                    excludedPatterns: runConfig.excludedPatterns ?? DEFAULT_EXCLUDED_PATTERNS,
                    maxTotalBytes: maxDiffBytes * 5, // Allow more content since we're not looking at diffs
                    workingDirectory: process.cwd()
                };
                const files = await Files.create(fileOptions);
                const fileContent = await files.get();

                if (fileContent && fileContent.trim().length > 0) {
                    logger.info('FILE_CONTENT_USING: Using file content for commit message generation | Content Length: %d characters | Source: file content', fileContent.length);
                    diffContent = fileContent;
                    hasActualChanges = true; // We have content to work with
                } else {
                    if (runConfig.commit?.sendit) {
                        logger.info('COMMIT_SKIPPED: Skipping commit operation | Reason: No changes detected | Action: None');
                        return 'No changes to commit.';
                    } else {
                        logger.info('COMMIT_TEMPLATE_GENERATING: Creating commit message template for future use | Reason: No changes | Purpose: Provide template');
                    }
                }
            }
        }
    }

    const logOptions = {
        limit: runConfig.commit?.messageLimit,
    };
    const log = await Log.create(logOptions);
    const logContext = await log.get();

    // Always ensure output directory exists for request/response files and GitHub issues lookup
    const outputDirectory = runConfig.outputDirectory || DEFAULT_OUTPUT_DIRECTORY;
    const storage = createStorage();
    await storage.ensureDirectory(outputDirectory);

    // Get GitHub issues context for large commits [[memory:5887795]]
    let githubIssuesContext = '';
    try {
        const currentVersion = await getCurrentVersion(storage);
        if (currentVersion) {
            logger.debug(`Found current version: ${currentVersion}, fetching related GitHub issues...`);
            githubIssuesContext = await getRecentClosedIssuesForCommit(currentVersion, 10);
            if (githubIssuesContext) {
                logger.debug(`Fetched GitHub issues context (${githubIssuesContext.length} characters)`);
            } else {
                logger.debug('No relevant GitHub issues found for commit context');
            }
        } else {
            logger.debug('Could not determine current version, fetching recent issues without milestone filtering...');
            githubIssuesContext = await getRecentClosedIssuesForCommit(undefined, 10);
            if (githubIssuesContext) {
                logger.debug(`Fetched general GitHub issues context (${githubIssuesContext.length} characters)`);
            }
        }
    } catch (error: any) {
        logger.debug(`Failed to fetch GitHub issues for commit context: ${error.message}`);
        // Continue without GitHub context - this shouldn't block commit generation
    }

    const promptConfig = {
        overridePaths: (runConfig as any).discoveredConfigDirs || [],
        overrides: runConfig.overrides || false,
    };
    const userDirection = sanitizeDirection(runConfig.commit?.direction);
    if (userDirection) {
        logger.debug('Using user direction: %s', userDirection);
    }

    // Create adapters for ai-service
    const aiConfig = toAIConfig(runConfig);
    const aiStorageAdapter = createStorageAdapter(outputDirectory);
    const aiLogger = createLoggerAdapter(isDryRun);

    // Read context from files if provided
    const contextFromFiles = await readContextFiles(runConfig.commit?.contextFiles, logger);

    // Combine file context with existing context
    const combinedContext = [
        runConfig.commit?.context,
        contextFromFiles
    ].filter(Boolean).join('\n\n---\n\n');

    // Define promptContext for use in interactive improvements
    const promptContext: CommitContext = {
        logContext,
        context: combinedContext || undefined,
        directories: runConfig.contextDirectories,
    };

    // Announce self-reflection if enabled
    if (runConfig.commit?.selfReflection) {
        logger.info('📊 Self-reflection enabled - detailed analysis will be generated');
    }

    // Get list of changed files
    const changedFilesResult = await run(`git diff --name-only ${cached ? '--cached' : ''}`);
    const changedFilesOutput = typeof changedFilesResult === 'string' ? changedFilesResult : changedFilesResult.stdout;
    const changedFiles = changedFilesOutput.split('\n').filter((f: string) => f.trim().length > 0);

    logger.debug('Changed files for analysis: %d files', changedFiles.length);

    // Run agentic commit generation
    logger.info('COMMIT_AI_GENERATION: Starting AI-powered commit message generation | Model: %s | Reasoning: %s | Files: %d',
        aiConfig.commands?.commit?.model || aiConfig.model || 'gpt-4o-mini',
        aiConfig.commands?.commit?.reasoning || aiConfig.reasoning || 'low',
        changedFiles.length);
    const agenticResult = await runAgenticCommit({
        changedFiles,
        diffContent,
        userDirection,
        logContext,
        model: aiConfig.commands?.commit?.model || aiConfig.model,
        maxIterations: runConfig.commit?.maxAgenticIterations || 10,
        debug: runConfig.debug,
        debugRequestFile: getOutputPath(outputDirectory, getTimestampedRequestFilename('commit')),
        debugResponseFile: getOutputPath(outputDirectory, getTimestampedResponseFilename('commit')),
        storage: aiStorageAdapter,
        logger: aiLogger,
        openaiReasoning: aiConfig.commands?.commit?.reasoning || aiConfig.reasoning,
    });

    const iterations = agenticResult.iterations || 0;
    const toolCalls = agenticResult.toolCallsExecuted || 0;
    logger.info(`🔍 Analysis complete: ${iterations} iterations, ${toolCalls} tool calls`);

    // Generate self-reflection output if enabled
    if (runConfig.commit?.selfReflection) {
        await generateSelfReflection(agenticResult, outputDirectory, storage, logger);
    }

    // Check for suggested splits
    if (agenticResult.suggestedSplits.length > 1 && runConfig.commit?.allowCommitSplitting) {
        logger.info('\n📋 AI suggests splitting this into %d commits:', agenticResult.suggestedSplits.length);

        for (let i = 0; i < agenticResult.suggestedSplits.length; i++) {
            const split = agenticResult.suggestedSplits[i];
            logger.info('\nCommit %d (%d files):', i + 1, split.files.length);
            logger.info('  Files: %s', split.files.join(', '));
            logger.info('  Rationale: %s', split.rationale);
            logger.info('  Message: %s', split.message);
        }

        // NEW: Check if auto-split is enabled (defaults to true if not specified)
        const autoSplitEnabled = runConfig.commit?.autoSplit !== false; // Default to true
        if (autoSplitEnabled) {
            logger.info('\n🔄 Auto-split enabled - creating separate commits...\n');

            // Deduplicate files across splits to prevent staging errors
            // (AI sometimes suggests the same file in multiple splits)
            const deduplicatedSplits = deduplicateSplits(agenticResult.suggestedSplits, logger);

            if (deduplicatedSplits.length === 0) {
                throw new CommandError(
                    'All splits were empty after deduplication - no files to commit',
                    'SPLIT_EMPTY',
                    false
                );
            }

            const splitResult = await executeSplitCommits({
                splits: deduplicatedSplits,
                runConfig,
                isDryRun,
                interactive: !!(runConfig.commit?.interactive && !runConfig.commit?.sendit),
                logger,
                storage
            });

            if (splitResult.success) {
                // Push if requested (all commits)
                if (runConfig.commit?.push && !isDryRun) {
                    await pushCommit(runConfig.commit.push, logger, isDryRun);
                }

                return formatSplitCommitSummary(splitResult);
            } else {
                const errorMessage = splitResult.error?.message || 'Unknown error';
                throw new CommandError(
                    `Failed to create split commits: ${errorMessage}`,
                    'SPLIT_COMMIT_FAILED',
                    false,
                    splitResult.error
                );
            }
        } else {
            logger.info('\n⚠️  Commit splitting is not automated. Please stage and commit files separately.');
            logger.info('Using combined message for now...\n');
            logger.info('💡 To enable automatic splitting, add autoSplit: true to your commit configuration');
        }
    } else if (agenticResult.suggestedSplits.length > 1) {
        logger.debug('AI suggested %d splits but commit splitting is not enabled', agenticResult.suggestedSplits.length);
    }

    const rawSummary = agenticResult.commitMessage;

    // Apply stop-context filtering to commit message
    const filterResult = filterContent(rawSummary, runConfig.stopContext);
    const summary = filterResult.filtered;

    // Save timestamped copy of commit message with better error handling
    await saveCommitMessage(outputDirectory, summary, storage, logger);

    // 🛡️ Universal Safety Check: Run before ANY commit operation
    // This protects both direct commits (--sendit) and automated commits (publish, etc.)
    const willCreateCommit = runConfig.commit?.sendit && hasActualChanges && cached;
    if (willCreateCommit && !runConfig.commit?.skipFileCheck && !isDryRun) {
        logger.debug('Checking for file: dependencies before commit operation...');

        try {
            const fileDependencyIssues = await checkForFileDependencies(storage, process.cwd());

            if (fileDependencyIssues.length > 0) {
                logger.error('🚫 COMMIT BLOCKED: Found file: dependencies that should not be committed!');
                logger.error('');

                logFileDependencyWarning(fileDependencyIssues, 'commit');
                logFileDependencySuggestions(true);

                logger.error('Generated commit message was:');
                logger.error('%s', summary);
                logger.error('');

                if (runConfig.commit?.sendit) {
                    logger.error('To bypass this check, use: kodrdriv commit --skip-file-check --sendit');
                } else {
                    logger.error('To bypass this check, add skipFileCheck: true to your commit configuration');
                }

                throw new ValidationError('Found file: dependencies that should not be committed. Use --skip-file-check to bypass.');
            }

            logger.debug('✅ No file: dependencies found, proceeding with commit');
        } catch (error: any) {
            logger.warn('Warning: Could not check for file: dependencies: %s', error.message);
            logger.warn('Proceeding with commit...');
        }
    } else if (runConfig.commit?.skipFileCheck && willCreateCommit) {
        logger.warn('⚠️  Skipping file: dependency check as requested');
    }

    // Handle interactive mode
    if (runConfig.commit?.interactive && !isDryRun) {
        requireTTY('Interactive mode requires a terminal. Use --sendit or --dry-run instead.');

        const interactiveResult = await handleInteractiveCommitFeedback(
            summary,
            runConfig,
            promptConfig,
            promptContext,
            outputDirectory,
            storage,
            diffContent,
            hasActualChanges,
            cached
        );

        if (interactiveResult.action === 'skip') {
            logger.info('COMMIT_ABORTED: User aborted commit operation | Reason: User choice | Action: No commit performed');
            logger.info('COMMIT_NO_ACTION: No commit will be performed | Status: aborted | Next: User can retry or modify changes');
            userSkippedCommit = true;
            return interactiveResult.finalMessage;
        }

        // User chose to commit - check if sendit is enabled to determine what action to take
        const senditEnabled = runConfig.commit?.sendit;
        const willActuallyCommit = senditEnabled && hasActualChanges && cached;

        if (willActuallyCommit) {
            const commitAction = runConfig.commit?.amend ? 'amending last commit' : 'committing';
            logger.info('SENDIT_EXECUTING: SendIt enabled, executing commit action | Action: %s | Message Length: %d | Final Message: \n\n%s\n\n', commitAction.charAt(0).toUpperCase() + commitAction.slice(1), interactiveResult.finalMessage.length, interactiveResult.finalMessage);
            try {
                const validatedSummary = validateString(interactiveResult.finalMessage, 'commit summary');
                const escapedSummary = shellescape([validatedSummary]);
                const commitCommand = runConfig.commit?.amend ?
                    `git commit --amend -m ${escapedSummary}` :
                    `git commit -m ${escapedSummary}`;
                await run(commitCommand);
                logger.info('COMMIT_SUCCESS: Commit operation completed successfully | Status: committed | Action: Changes saved to repository');

                // Push if requested
                await pushCommit(runConfig.commit?.push, logger, isDryRun);
            } catch (error: any) {
                logger.error('Failed to commit:', error);
                throw new ExternalDependencyError('Failed to create commit', 'git', error);
            }
        } else if (senditEnabled && (!hasActualChanges || !cached)) {
            logger.info('📝 SendIt enabled but no staged changes available. Final message saved: \n\n%s\n\n', interactiveResult.finalMessage);
            if (!hasActualChanges) {
                logger.info('💡 No changes detected to commit');
            } else if (!cached) {
                logger.info('💡 No staged changes found. Use "git add" to stage changes or configure add: true in commit settings');
            }
        } else {
            logger.info('📝 Message accepted (SendIt not enabled). Use this commit message manually: \n\n%s\n\n', interactiveResult.finalMessage);
            logger.info('💡 To automatically commit, add sendit: true to your commit configuration');
        }

        return interactiveResult.finalMessage;
    }

    // Safety check: Never commit if user explicitly skipped in interactive mode
    if (userSkippedCommit) {
        logger.debug('Skipping sendit logic because user chose to skip in interactive mode');
        return summary;
    }

    if (runConfig.commit?.sendit) {
        if (isDryRun) {
            logger.info('Would commit with message: \n\n%s\n\n', summary);
            const commitAction = runConfig.commit?.amend ? 'git commit --amend -m <generated-message>' : 'git commit -m <generated-message>';
            logger.info('Would execute: %s', commitAction);

            // Show push command in dry run if requested
            if (runConfig.commit?.push) {
                const remote = typeof runConfig.commit.push === 'string' ? runConfig.commit.push : 'origin';
                logger.info('Would push to %s with: git push %s', remote, remote);
            }
        } else if (hasActualChanges && cached) {
            const commitAction = runConfig.commit?.amend ? 'amending commit' : 'committing';
            logger.info('SendIt mode enabled. %s with message: \n\n%s\n\n', commitAction.charAt(0).toUpperCase() + commitAction.slice(1), summary);
            try {
                const validatedSummary = validateString(summary, 'commit summary');
                const escapedSummary = shellescape([validatedSummary]);
                const commitCommand = runConfig.commit?.amend ?
                    `git commit --amend -m ${escapedSummary}` :
                    `git commit -m ${escapedSummary}`;
                await run(commitCommand);
                logger.info('Commit successful!');

                // Push if requested
                await pushCommit(runConfig.commit?.push, logger, isDryRun);
            } catch (error: any) {
                logger.error('Failed to commit:', error);
                throw new ExternalDependencyError('Failed to create commit', 'git', error);
            }
        } else {
            logger.info('SendIt mode enabled, but no changes to commit. Generated message: \n\n%s\n\n', summary);
        }
    } else if (isDryRun) {
        logger.info('Generated commit message: \n\n%s\n\n', summary);
    } else {
        // Default behavior when neither --interactive nor --sendit is specified
        logger.info('Generated commit message: \n\n%s\n\n', summary);
    }

    return summary;
}

export const execute = async (runConfig: Config): Promise<string> => {
    try {
        return await executeInternal(runConfig);
    } catch (error: any) {
        // Import getLogger for error handling
        const { getLogger } = await import('@grunnverk/core');
        const standardLogger = getLogger();

        if (error instanceof ValidationError || error instanceof ExternalDependencyError || error instanceof CommandError) {
            standardLogger.error(`commit failed: ${error.message}`);
            if (error.cause && typeof error.cause === 'object' && 'message' in error.cause) {
                standardLogger.debug(`Caused by: ${(error.cause as Error).message}`);
            } else if (error.cause) {
                standardLogger.debug(`Caused by: ${error.cause}`);
            }
            throw error;
        }

        // Unexpected errors
        standardLogger.error(`commit encountered unexpected error: ${error.message}`);
        throw error;
    }
};
