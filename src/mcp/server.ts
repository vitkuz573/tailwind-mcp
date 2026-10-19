/**
 * MCP server assembly and the stdio entry point.
 *
 * stdout carries protocol frames only; every diagnostic goes to stderr.
 */

import path from "node:path";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { loadConfig, type AppConfig } from "../core/config.js";
import { isTailwindMcpError, TailwindMcpError } from "../core/errors.js";
import { createLogger, type Logger } from "../core/logger.js";
import { ProjectRegistry } from "../tailwind/registry.js";
import {
  canonicalizeClasses,
  checkContrast,
  diagnose,
  findConflicts,
  migrateClasses,
} from "./diagnostics.js";
import {
  listVariants,
  readTheme,
  searchClasses,
  validateCandidates,
  type ToolEnvelope,
} from "./tools.js";

export const SERVER_NAME = "tailwind";
export const SERVER_TITLE = "Tailwind CSS engine";

const INSTRUCTIONS = `
Ground truth about the Tailwind CSS project you are working in.

How to work with this server:
1. tailwind_diagnose — the main tool. Checks a class list for unknown classes, typos, arbitrary values that should be theme tokens, conflicting classes and v3 classes needing migration. Start here.
2. tailwind_validate — check specific classes and get the CSS they generate.
3. tailwind_search_classes — find the real class names when you know the intent but not the utility.
4. tailwind_theme — read design tokens (colors, spacing, breakpoints).
5. tailwind_variants — list available variants such as hover:, md: or dark:.
6. tailwind_conflicts — report which class wins when several set the same property.
7. tailwind_canonicalize — put a class list into Tailwind's canonical form and order.
8. tailwind_migrate — map v3 classes to their v4 equivalents.
9. tailwind_contrast — check WCAG contrast between two colours.

Guarantees:
- The class list and theme come from the project's own Tailwind installation, so custom theme values, plugins and the exact installed version are reflected.
- Config edits are picked up automatically; you do not need to restart anything.
- Invalid classes are reported as invalid, never silently accepted.
- Which of two conflicting classes wins is determined by Tailwind's own class order, not guessed.

Bounded by design: every result is paginated and capped.
`.trim();

export interface BuiltServer {
  readonly server: McpServer;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly registry: ProjectRegistry;
}

interface ToolResult extends CallToolResult {
  content: [{ type: "text"; text: string }];
}

/** Wrap a tool body so failures surface as MCP errors, never as crashes. */
async function guard<T>(
  logger: Logger,
  tool: string,
  body: () => Promise<ToolEnvelope<T>>,
): Promise<ToolResult> {
  try {
    const envelope = await body();
    return {
      content: [{ type: "text", text: envelope.summary }],
      structuredContent: { summary: envelope.summary, ...envelope.data },
    };
  } catch (error) {
    if (isTailwindMcpError(error)) {
      logger.warn("tool.failed", { tool, code: error.code, message: error.message });
      throw new TailwindMcpError(error.code, error.message, {
        details: error.details,
        retryable: error.retryable,
        hint: error.hint,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error("tool.crashed", { tool, message });
    throw new TailwindMcpError("INTERNAL", message);
  }
}

export function buildServer(options: { config?: AppConfig; logger?: Logger } = {}): BuiltServer {
  const config = options.config ?? loadConfig();
  const logger =
    options.logger ?? createLogger({ level: config.logLevel, base: { server: SERVER_NAME } });
  const registry = new ProjectRegistry(logger);

  const server = new McpServer(
    { name: SERVER_NAME, version: config.version, title: SERVER_TITLE },
    { instructions: INSTRUCTIONS },
  );

  registerTools(server, registry, logger, config);
  logger.info("server.built", { version: config.version, projectRoot: config.projectRoot });
  return { server, config, logger, registry };
}

/** Resolve the project a tool call refers to. */
function resolveProjectRoot(config: AppConfig, project: string | undefined): string {
  if (!project || project.trim() === "") return config.projectRoot;
  return path.resolve(project.trim());
}

/** The `project` argument shared by every tool. */
const projectArg = z
  .string()
  .optional()
  .describe(
    "Absolute path to the project to inspect. Defaults to the server's working directory. " +
      "Use it when the Tailwind project is not the current working directory.",
  );

function registerTools(
  server: McpServer,
  registry: ProjectRegistry,
  logger: Logger,
  config: AppConfig,
): void {
  server.registerTool(
    "tailwind_validate",
    {
      title: "Validate Tailwind classes",
      description:
        "Check whether candidate Tailwind classes exist in this project and return the CSS they generate. " +
        "Accepts variants (md:hover:bg-red-500) and arbitrary values (w-[37px]). " +
        "Use before writing markup to avoid emitting classes that do not exist.",
      inputSchema: z.object({
        candidates: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Tailwind class candidates to validate, e.g. ['p-4', 'bg-red-500', 'text-nope']",
          ),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ candidates, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_validate", () =>
        validateCandidates(holder.engine, {
          candidates: candidates.slice(0, config.maxCandidates),
        }),
      );
    },
  );

  server.registerTool(
    "tailwind_search_classes",
    {
      title: "Search Tailwind classes",
      description:
        "Search the project's real Tailwind class list. Use when you know the intent but not the exact " +
        "utility name. Returns utility names and the modifiers they accept.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring to match, e.g. 'rounded', 'shadow'"),
        prefix: z
          .string()
          .optional()
          .describe("Only return classes starting with this prefix, e.g. 'bg-'"),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum results to return"),
        offset: z.number().int().min(0).optional().describe("Number of results to skip"),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, prefix, limit, offset, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_search_classes", () =>
        searchClasses(holder.engine, {
          query,
          prefix,
          limit: Math.min(limit ?? config.maxResults, config.maxResults),
          offset: offset ?? 0,
        }),
      );
    },
  );

  server.registerTool(
    "tailwind_theme",
    {
      title: "Read Tailwind theme",
      description:
        "Read the project's design tokens: colors, spacing, breakpoints, fonts and any custom theme values. " +
        "Use the project's own token names instead of generic ones.",
      inputSchema: z.object({
        query: z.string().optional().describe("Substring to match, e.g. 'red' or 'primary'"),
        namespace: z
          .string()
          .optional()
          .describe("Restrict to a namespace, e.g. 'color', 'spacing', 'breakpoint'"),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum results to return"),
        offset: z.number().int().min(0).optional().describe("Number of results to skip"),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, namespace, limit, offset, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_theme", () =>
        readTheme(holder.engine, {
          query,
          namespace,
          limit: Math.min(limit ?? config.maxResults, config.maxResults),
          offset: offset ?? 0,
        }),
      );
    },
  );

  server.registerTool(
    "tailwind_variants",
    {
      title: "List Tailwind variants",
      description:
        "List the variants this project understands, such as hover:, md:, dark: or data-[state=open]. " +
        "Use this to check that a variant exists before using it.",
      inputSchema: z.object({
        query: z.string().optional().describe("Substring to match, e.g. 'hover'"),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum results to return"),
        offset: z.number().int().min(0).optional().describe("Number of results to skip"),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, offset, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_variants", () =>
        listVariants(holder.engine, {
          query,
          limit: Math.min(limit ?? config.maxResults, config.maxResults),
          offset: offset ?? 0,
        }),
      );
    },
  );

  server.registerTool(
    "tailwind_diagnose",
    {
      title: "Diagnose a Tailwind class list",
      description:
        "Check a class list for every problem at once: classes that do not exist (with spelling " +
        "suggestions), classes that use an arbitrary value where a theme token would do, classes that " +
        "override each other, and v3 classes that need migrating to v4. " +
        "This is the tool to call before writing or editing markup.",
      inputSchema: z.object({
        candidates: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "The class list to diagnose, e.g. ['p-4', 'bg-red-501', 'mt-[16px]', 'p-2 p-4']",
          ),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ candidates, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_diagnose", () =>
        diagnose(holder.engine, { candidates: candidates.slice(0, config.maxCandidates) }),
      );
    },
  );

  server.registerTool(
    "tailwind_conflicts",
    {
      title: "Find conflicting Tailwind classes",
      description:
        "Report which class wins when several set the same CSS property, and which ones are silently " +
        "overridden. The winner follows Tailwind's own class order.",
      inputSchema: z.object({
        candidates: z
          .array(z.string().min(1))
          .min(1)
          .describe("The class list to check, e.g. ['p-2', 'p-4', 'text-sm', 'text-lg']"),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ candidates, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_conflicts", () =>
        findConflicts(holder.engine, { candidates: candidates.slice(0, config.maxCandidates) }),
      );
    },
  );

  server.registerTool(
    "tailwind_canonicalize",
    {
      title: "Canonicalise a Tailwind class list",
      description:
        "Rewrite a class list into Tailwind's canonical form and order: arbitrary values that match a " +
        "theme token become that token, deprecated spellings are renamed, and the classes are sorted the " +
        "way prettier-plugin-tailwindcss would sort them.",
      inputSchema: z.object({
        candidates: z
          .array(z.string().min(1))
          .min(1)
          .describe("The class list to canonicalise, e.g. ['mt-[16px]', 'p-4', 'flex']"),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ candidates, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_canonicalize", () =>
        canonicalizeClasses(holder.engine, {
          candidates: candidates.slice(0, config.maxCandidates),
        }),
      );
    },
  );

  server.registerTool(
    "tailwind_migrate",
    {
      title: "Migrate Tailwind v3 classes to v4",
      description:
        "Map v3 class names to their v4 equivalents, including the scale renames whose meaning changed " +
        "silently (shadow-sm, rounded, blur and the rest). Use this when porting v3 code to v4.",
      inputSchema: z.object({
        candidates: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "The v3 class list to migrate, e.g. ['shadow-sm', 'bg-opacity-50', 'flex-shrink-0']",
          ),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ candidates, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_migrate", () =>
        migrateClasses(holder.engine, { candidates: candidates.slice(0, config.maxCandidates) }),
      );
    },
  );

  server.registerTool(
    "tailwind_contrast",
    {
      title: "Check Tailwind colour contrast",
      description:
        "Compute the WCAG contrast ratio of two colours and whether they pass AA or AAA. " +
        "Colours may be theme tokens such as 'red-500' or 'white', or literal CSS colours.",
      inputSchema: z.object({
        foreground: z
          .string()
          .min(1)
          .describe("The text colour, e.g. 'white' or 'red-500' or '#333'"),
        background: z
          .string()
          .min(1)
          .describe("The background colour, e.g. 'slate-900' or 'white' or '#fff'"),
        project: projectArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ foreground, background, project }) => {
      const holder = await registry.get(resolveProjectRoot(config, project));
      return guard(logger, "tailwind_contrast", () =>
        checkContrast(holder.engine, { foreground, background }),
      );
    },
  );
}

/** Entry point used by the `tailwind-mcp` binary. */
export function main(): void {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, base: { server: SERVER_NAME } });
  const built = buildServer({ config, logger });

  const handle = serveStdio(
    () => {
      logger.debug("connection.opened", {});
      return built.server;
    },
    {
      legacy: "serve",
      onerror: (error) => logger.error("transport.error", { message: error.message }),
    },
  );

  const shutdown = (signal: string): void => {
    logger.info("server.shutdown", { signal });
    void handle.close().finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("server.ready", {
    version: config.version,
    projectRoot: config.projectRoot,
    protocol: "auto (2026-07-28 + legacy)",
  });
}
