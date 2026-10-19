/**
 * Project discovery.
 *
 * A "project" is a directory that contains a Tailwind installation. The
 * server prefers the project's own Tailwind over its bundled copy, so the
 * answers reflect the exact version, config and plugins the user actually
 * builds with.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { projectNotFound, noTailwind } from "../core/errors.js";

/** A resolved Tailwind installation inside a project. */
export interface TailwindInstall {
  /** Absolute path of the project root that owns the installation. */
  readonly projectRoot: string;
  /** Absolute path of the `tailwindcss` package directory. */
  readonly packageDir: string;
  /** Installed version, e.g. `4.3.3`. */
  readonly version: string;
  /** Major generation: 3 or 4. */
  readonly major: 3 | 4;
  /** `require` bound to the project, so subpath imports resolve locally. */
  readonly require: NodeRequire;
}

const CSS_ENTRY_CANDIDATES = [
  "src/app/globals.css",
  "app/globals.css",
  "src/globals.css",
  "src/index.css",
  "src/styles/globals.css",
  "src/styles/index.css",
  "app.css",
  "styles.css",
  "src/app.css",
  "src/styles.css",
  "tailwind.css",
  "src/tailwind.css",
];

const CONFIG_CANDIDATES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.cts",
  "tailwind.config.mts",
];

/** How deep to search for a CSS entry point when the well-known paths miss. */
const MAX_SEARCH_DEPTH = 4;

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Walk up from `start` looking for a directory that owns a Tailwind install.
 *
 * The project root is the directory containing `node_modules/tailwindcss`.
 * If none is found within the filesystem root, the start directory itself is
 * returned so the caller can report a precise error.
 */
export async function findProjectRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  for (;;) {
    if (await pathExists(path.join(current, "node_modules", "tailwindcss"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

/**
 * Resolve the Tailwind installation that belongs to `projectRoot`.
 *
 * @throws when the project has no Tailwind installed.
 */
export async function resolveTailwindInstall(projectRoot: string): Promise<TailwindInstall> {
  const root = path.resolve(projectRoot);
  const requireFromProject = createRequire(path.join(root, "package.json"));
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromProject.resolve("tailwindcss/package.json");
  } catch {
    throw noTailwind(
      `No Tailwind CSS installation found in ${root}. ` +
        "Pass the 'project' argument with the path to a directory that has tailwindcss installed.",
    );
  }

  const packageDir = path.dirname(packageJsonPath);
  const raw = JSON.parse(await fs.readFile(packageJsonPath, "utf-8")) as { version?: string };
  const version = raw.version ?? "0.0.0";
  const major = Number.parseInt(version, 10) >= 4 ? 4 : 3;

  return { projectRoot: root, packageDir, version, major, require: requireFromProject };
}

/**
 * Find the CSS file that pulls Tailwind in.
 *
 * For v4 the entry point is a stylesheet containing `@import "tailwindcss"`.
 * For v3 there is no such file, so `null` is returned and the config file is
 * used instead.
 */
export async function findCssEntry(
  projectRoot: string,
  install: TailwindInstall,
): Promise<string | null> {
  const root = path.resolve(projectRoot);
  for (const relative of CSS_ENTRY_CANDIDATES) {
    const candidate = path.join(root, relative);
    if (!(await isFile(candidate))) continue;
    const content = await fs.readFile(candidate, "utf-8");
    if (install.major === 4 && /@import\s+["']tailwindcss["']/.test(content)) return candidate;
  }

  if (install.major === 4) {
    const found = await searchForCssEntry(root, 0);
    if (found) return found;
  }
  return null;
}

/** Bounded recursive search for a stylesheet that imports Tailwind. */
async function searchForCssEntry(dir: string, depth: number): Promise<string | null> {
  if (depth > MAX_SEARCH_DEPTH) return null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".css")) {
      const full = path.join(dir, entry.name);
      const content = await fs.readFile(full, "utf-8").catch(() => "");
      if (/@import\s+["']tailwindcss["']/.test(content)) return full;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const found = await searchForCssEntry(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/** Find the Tailwind config file, if the project has one. */
export async function findConfigFile(projectRoot: string): Promise<string | null> {
  const root = path.resolve(projectRoot);
  for (const relative of CONFIG_CANDIDATES) {
    const candidate = path.join(root, relative);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve everything needed to serve a project: its root, its Tailwind
 * installation, and the entry points the engine should watch for changes.
 */
export interface ResolvedProject {
  readonly root: string;
  readonly install: TailwindInstall;
  readonly cssFile: string | null;
  readonly configFile: string | null;
}

export async function resolveProject(startDir: string): Promise<ResolvedProject> {
  const root = await findProjectRoot(startDir);
  if (
    root === path.resolve(startDir) &&
    !(await pathExists(path.join(root, "node_modules", "tailwindcss")))
  ) {
    throw projectNotFound(
      `No Tailwind CSS project found at or above ${path.resolve(startDir)}. ` +
        "Pass the 'project' argument with the path to a directory that has tailwindcss installed.",
    );
  }

  const install = await resolveTailwindInstall(root);
  const cssFile = await findCssEntry(root, install);
  const configFile = await findConfigFile(root);

  return { root, install, cssFile, configFile };
}
