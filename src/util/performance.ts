/* eslint-disable @typescript-eslint/no-unused-vars */
import path from 'path';
import { getLogger } from '@grunnverk/core';
import { safeJsonParse, validatePackageJson } from '@grunnverk/git-tools';

// Performance timing helper
export class PerformanceTimer {
    private startTime: number;
    private logger: any;

    constructor(logger: any) {
        this.logger = logger;
        this.startTime = Date.now();
    }

    static start(logger: any, operation: string): PerformanceTimer {
        logger.verbose(`⏱️  Starting: ${operation}`);
        return new PerformanceTimer(logger);
    }

    end(operation: string): number {
        const duration = Date.now() - this.startTime;
        this.logger.verbose(`⏱️  Completed: ${operation} (${duration}ms)`);
        return duration;
    }
}

export interface PackageJson {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
}

export interface PackageJsonLocation {
    path: string;
    packageJson: PackageJson;
    relativePath: string;
}

const EXCLUDED_DIRECTORIES = [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.git',
    '.next',
    '.nuxt',
    'out',
    'public',
    'static',
    'assets'
];

// Batch read multiple package.json files in parallel
export const batchReadPackageJsonFiles = async (
    packageJsonPaths: string[],
    storage: any,
    rootDir: string
): Promise<PackageJsonLocation[]> => {
    const logger = getLogger();
    const timer = PerformanceTimer.start(logger, `Batch reading ${packageJsonPaths.length} package.json files`);

    const readPromises = packageJsonPaths.map(async (packageJsonPath): Promise<PackageJsonLocation | null> => {
        try {
            const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
            const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
            const packageJson = validatePackageJson(parsed, packageJsonPath, false);
            const relativePath = path.relative(rootDir, path.dirname(packageJsonPath));

            return {
                path: packageJsonPath,
                packageJson,
                relativePath: relativePath || '.'
            };
        } catch (error: any) {
            logger.debug(`Skipped invalid package.json at ${packageJsonPath}: ${error.message}`);
            return null;
        }
    });

    const results = await Promise.all(readPromises);
    const validResults = results.filter((result): result is PackageJsonLocation => result !== null);

    timer.end(`Successfully read ${validResults.length}/${packageJsonPaths.length} package.json files`);
    return validResults;
};

// Optimized recursive package.json finder with parallel processing
export const findAllPackageJsonFiles = async (rootDir: string, storage: any): Promise<PackageJsonLocation[]> => {
    const logger = getLogger();
    const timer = PerformanceTimer.start(logger, 'Optimized scanning for package.json files');

    // Phase 1: Find all package.json file paths in parallel
    const packageJsonPaths: string[] = [];

    const scanForPaths = async (currentDir: string, depth: number = 0): Promise<string[]> => {
        // Prevent infinite recursion and overly deep scanning
        if (depth > 5) {
            return [];
        }

        try {
            if (!await storage.exists(currentDir) || !await storage.isDirectory(currentDir)) {
                return [];
            }

            const items = await storage.listFiles(currentDir);
            const foundPaths: string[] = [];

            // Check for package.json in current directory
            if (items.includes('package.json')) {
                const packageJsonPath = path.join(currentDir, 'package.json');
                foundPaths.push(packageJsonPath);
            }

            // Process subdirectories in parallel
            const subdirPromises: Promise<string[]>[] = [];
            for (const item of items) {
                if (EXCLUDED_DIRECTORIES.includes(item)) {
                    continue;
                }

                const itemPath = path.join(currentDir, item);
                subdirPromises.push(
                    (async () => {
                        try {
                            if (await storage.isDirectory(itemPath)) {
                                return await scanForPaths(itemPath, depth + 1);
                            }
                        } catch (error: any) {
                            logger.debug(`Skipped directory ${itemPath}: ${error.message}`);
                        }
                        return [];
                    })()
                );
            }

            if (subdirPromises.length > 0) {
                const subdirResults = await Promise.all(subdirPromises);
                for (const subdirPaths of subdirResults) {
                    foundPaths.push(...subdirPaths);
                }
            }

            return foundPaths;
        } catch (error: any) {
            logger.debug(`Failed to scan directory ${currentDir}: ${error.message}`);
            return [];
        }
    };

    const pathsTimer = PerformanceTimer.start(logger, 'Finding all package.json paths');
    const allPaths = await scanForPaths(rootDir);
    pathsTimer.end(`Found ${allPaths.length} package.json file paths`);

    // Phase 2: Batch read all package.json files in parallel
    const packageJsonFiles = await batchReadPackageJsonFiles(allPaths, storage, rootDir);

    timer.end(`Found ${packageJsonFiles.length} valid package.json files`);
    return packageJsonFiles;
};

// Optimized package scanning with parallel processing
export const scanDirectoryForPackages = async (rootDir: string, storage: any): Promise<Map<string, string>> => {
    const logger = getLogger();
    const timer = PerformanceTimer.start(logger, `Optimized package scanning: ${rootDir}`);
    const packageMap = new Map<string, string>(); // packageName -> relativePath

    const absoluteRootDir = path.resolve(process.cwd(), rootDir);
    logger.verbose(`Scanning directory for packages: ${absoluteRootDir}`);

    try {
        // Quick existence and directory check
        const existsTimer = PerformanceTimer.start(logger, `Checking directory: ${absoluteRootDir}`);
        if (!await storage.exists(absoluteRootDir) || !await storage.isDirectory(absoluteRootDir)) {
            existsTimer.end(`Directory not found or not a directory: ${absoluteRootDir}`);
            timer.end(`Directory invalid: ${rootDir}`);
            return packageMap;
        }
        existsTimer.end(`Directory verified: ${absoluteRootDir}`);

        // Get all items and process in parallel
        const listTimer = PerformanceTimer.start(logger, `Listing contents: ${absoluteRootDir}`);
        const items = await storage.listFiles(absoluteRootDir);
        listTimer.end(`Listed ${items.length} items`);

        // Create batched promises for better performance
        const BATCH_SIZE = 10; // Process directories in batches to avoid overwhelming filesystem
        const batches = [];

        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const batch = items.slice(i, i + BATCH_SIZE);
            batches.push(batch);
        }

        const processTimer = PerformanceTimer.start(logger, `Processing ${batches.length} batches of directories`);

        for (const batch of batches) {
            const batchPromises = batch.map(async (item: string) => {
                const itemPath = path.join(absoluteRootDir, item);
                try {
                    if (await storage.isDirectory(itemPath)) {
                        const packageJsonPath = path.join(itemPath, 'package.json');

                        if (await storage.exists(packageJsonPath)) {
                            const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
                            const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
                            const packageJson = validatePackageJson(parsed, packageJsonPath);

                            if (packageJson.name) {
                                const relativePath = path.relative(process.cwd(), itemPath);
                                return { name: packageJson.name, path: relativePath };
                            }
                        }
                    }
                } catch (error: any) {
                    logger.debug(`Skipped ${itemPath}: ${error.message || error}`);
                }
                return null;
            });

            const batchResults = await Promise.all(batchPromises);

            for (const result of batchResults) {
                if (result) {
                    packageMap.set(result.name, result.path);
                    logger.debug(`Found package: ${result.name} at ${result.path}`);
                }
            }
        }

        processTimer.end(`Processed ${items.length} directories in ${batches.length} batches`);
        logger.verbose(`Found ${packageMap.size} packages in ${items.length} subdirectories`);
    } catch (error) {
        logger.warn(`PERFORMANCE_DIR_READ_FAILED: Unable to read directory | Directory: ${absoluteRootDir} | Error: ${error}`);
    }

    timer.end(`Found ${packageMap.size} packages in: ${rootDir}`);
    return packageMap;
};

// Parallel scope processing for better performance
export const findPackagesByScope = async (
    dependencies: Record<string, string>,
    scopeRoots: Record<string, string>,
    storage: any
): Promise<Map<string, string>> => {
    const logger = getLogger();
    const timer = PerformanceTimer.start(logger, 'Finding packages by scope (optimized)');
    const workspacePackages = new Map<string, string>();

    logger.silly(`Checking dependencies against scope roots: ${JSON.stringify(scopeRoots)}`);

    // Process all scopes in parallel for maximum performance
    const scopeTimer = PerformanceTimer.start(logger, 'Parallel scope scanning');
    const scopePromises = Object.entries(scopeRoots).map(async ([scope, rootDir]) => {
        logger.verbose(`Scanning scope ${scope} at root directory: ${rootDir}`);
        const scopePackages = await scanDirectoryForPackages(rootDir, storage);

        // Filter packages that match the scope
        const matchingPackages: Array<[string, string]> = [];
        for (const [packageName, packagePath] of scopePackages) {
            if (packageName.startsWith(scope)) {
                matchingPackages.push([packageName, packagePath]);
                logger.debug(`Registered package: ${packageName} -> ${packagePath}`);
            }
        }
        return { scope, packages: matchingPackages };
    });

    const allScopeResults = await Promise.all(scopePromises);

    // Aggregate all packages from all scopes
    const allPackages = new Map<string, string>();
    for (const { scope, packages } of allScopeResults) {
        for (const [packageName, packagePath] of packages) {
            allPackages.set(packageName, packagePath);
        }
    }

    scopeTimer.end(`Scanned ${Object.keys(scopeRoots).length} scope roots, found ${allPackages.size} packages`);

    // Match dependencies to available packages
    const matchTimer = PerformanceTimer.start(logger, 'Matching dependencies to packages');
    for (const [depName, depVersion] of Object.entries(dependencies)) {
        logger.debug(`Processing dependency: ${depName}@${depVersion}`);

        if (allPackages.has(depName)) {
            const packagePath = allPackages.get(depName)!;
            workspacePackages.set(depName, packagePath);
            logger.verbose(`Found sibling package: ${depName} at ${packagePath}`);
        }
    }
    matchTimer.end(`Matched ${workspacePackages.size} dependencies to workspace packages`);

    timer.end(`Found ${workspacePackages.size} packages to link`);
    return workspacePackages;
};

// Utility to collect all dependencies from package.json files efficiently
export const collectAllDependencies = (packageJsonFiles: PackageJsonLocation[]): Record<string, string> => {
    const logger = getLogger();
    const timer = PerformanceTimer.start(logger, 'Collecting all dependencies');

    const allDependencies: Record<string, string> = {};
    for (const { packageJson } of packageJsonFiles) {
        Object.assign(allDependencies, packageJson.dependencies);
        Object.assign(allDependencies, packageJson.devDependencies);
        Object.assign(allDependencies, packageJson.peerDependencies);
    }

    timer.end(`Collected ${Object.keys(allDependencies).length} unique dependencies`);
    return allDependencies;
};

// Utility to check for file: dependencies
export const checkForFileDependencies = (packageJsonFiles: PackageJsonLocation[]): void => {
    const logger = getLogger();
    const timer = PerformanceTimer.start(logger, 'Checking for file: dependencies');
    const filesWithFileDepedencies: Array<{path: string, dependencies: string[]}> = [];

    for (const { path: packagePath, packageJson, relativePath } of packageJsonFiles) {
        const fileDeps: string[] = [];

        // Check all dependency types for file: paths
        const allDeps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
            ...packageJson.peerDependencies
        };

        for (const [name, version] of Object.entries(allDeps)) {
            if (version.startsWith('file:')) {
                fileDeps.push(`${name}: ${version}`);
            }
        }

        if (fileDeps.length > 0) {
            filesWithFileDepedencies.push({
                path: relativePath,
                dependencies: fileDeps
            });
        }
    }

    if (filesWithFileDepedencies.length > 0) {
        logger.warn('FILE_DEPS_WARNING: Found file: dependencies that should not be committed | Count: ' + filesWithFileDepedencies.length + ' | Impact: May cause build issues');
        for (const file of filesWithFileDepedencies) {
            logger.warn(`FILE_DEPS_PACKAGE: Package with file dependencies | Path: ${file.path}`);
            for (const dep of file.dependencies) {
                logger.warn(`FILE_DEPS_DETAIL: File dependency detected | Dependency: ${dep}`);
            }
        }
        logger.warn('');
        logger.warn('FILE_DEPS_RESOLUTION: Action required before committing | Command: kodrdriv unlink | Purpose: Restore registry versions');
        logger.warn('FILE_DEPS_PREVENTION: Alternative option | Action: Add pre-commit hook | Purpose: Prevent accidental commits of linked dependencies');
    }

    timer.end(`Checked ${packageJsonFiles.length} files, found ${filesWithFileDepedencies.length} with file: dependencies`);
};
