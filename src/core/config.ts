/**
 * Configuration.
 *
 * Everything is read from the environment so the server can be dropped into
 * any MCP client configuration without a config file.
 */

import path from "node:path";
import type { LogLevel } from "./logger.js";

export interface AppConfig {
  /** Directory the server treats as the project root when no path is given. */
  readonly projectRoot: string;
  /** Explicit CSS entry file, overriding auto-detection. */
  readonly cssFile: string | undefined;
  readonly logLevel: LogLevel;
  /** Maximum number of rows a single tool result may contain. */
  readonly maxResults: number;
  /** Maximum number of candidates accepted in one `compile` call. */
  readonly maxCandidates: number;
  readonly version: string;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error", "silent"];

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function readLogLevel(): LogLevel {
  const raw = process.env.TAILWIND_MCP_LOG_LEVEL?.toLowerCase();
  return LOG_LEVELS.find((level) => level === raw) ?? "info";
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const projectRoot =
    overrides.projectRoot ?? path.resolve(process.env.TAILWIND_MCP_PROJECT ?? process.cwd());
  return {
    projectRoot,
    cssFile: overrides.cssFile ?? process.env.TAILWIND_MCP_CSS_FILE,
    logLevel: overrides.logLevel ?? readLogLevel(),
    maxResults: overrides.maxResults ?? readInt("TAILWIND_MCP_MAX_RESULTS", 200, 1, 5000),
    maxCandidates: overrides.maxCandidates ?? readInt("TAILWIND_MCP_MAX_CANDIDATES", 100, 1, 1000),
    version: overrides.version ?? "0.1.0",
  };
}
