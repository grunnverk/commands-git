/**
 * MCP-aware logger wrapper
 *
 * When running in MCP server mode (KODRDRIV_MCP_SERVER=true),
 * console output must be suppressed to avoid polluting the JSON-RPC stream.
 * This module provides a logger wrapper that respects MCP mode.
 */
import { getLogger as getCoreLogger } from '@eldrforge/core';

/**
 * Simple logger interface - avoids exposing winston types
 */
export interface SimpleLogger {
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    debug: (message: string, ...args: unknown[]) => void;
    verbose: (message: string, ...args: unknown[]) => void;
    silly: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}

/**
 * Check if running in MCP server mode
 */
export const isMcpMode = (): boolean => process.env.KODRDRIV_MCP_SERVER === 'true';

/**
 * Get an MCP-aware logger that suppresses info/warn/debug output in MCP mode.
 * Errors are always logged since they indicate problems that need attention.
 */
export const getMcpAwareLogger = (): SimpleLogger => {
    const coreLogger = getCoreLogger();

    if (!isMcpMode()) {
        // In normal mode, just return the core logger
        return coreLogger;
    }

    // In MCP mode, wrap the logger to suppress non-error output
    return {
        info: (_message: string, ..._args: unknown[]) => { /* suppressed in MCP mode */ },
        warn: (_message: string, ..._args: unknown[]) => { /* suppressed in MCP mode */ },
        debug: (_message: string, ..._args: unknown[]) => { /* suppressed in MCP mode */ },
        verbose: (_message: string, ..._args: unknown[]) => { /* suppressed in MCP mode */ },
        silly: (_message: string, ..._args: unknown[]) => { /* suppressed in MCP mode */ },
        // Always log errors - they indicate real problems
        error: (message: string, ...args: unknown[]) => coreLogger.error(message, ...args),
    };
};
