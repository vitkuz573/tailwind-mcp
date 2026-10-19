/**
 * Dependency discovery.
 *
 * A Tailwind project's configuration rarely lives in one file: the CSS entry
 * imports partials, `@config` points at a JS/TS config, and that config may
 * import helpers of its own. To notice every edit without a restart, the
 * server has to know the full set of local files that feed the design system.
 *
 * The scan is deliberately conservative: it follows only relative imports,
 * never crosses into `node_modules`, and stops at a fixed depth. A missing
 * file is recorded rather than treated as an error, so an in-progress edit
 * never breaks the server.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** How deep to follow local imports. */
const MAX_DEPTH = 4;

/** Extensions tried when an import has no extension. */
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".css"];

const CSS_IMPORT = /@import\s+(?:url\()?["']([^"')]+)["']/g;
const CSS_CONFIG = /@config\s+["']([^"']+)["']/g;
const CSS_PLUGIN = /@plugin\s+["']([^"']+)["']/g;
const JS_IMPORT =
  /(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

async function fileExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Resolve a relative import to an existing file, trying common extensions. */
async function resolveLocal(from: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (await fileExists(candidate)) return candidate;
  }
  for (const extension of EXTENSIONS) {
    if (!extension) continue;
    const candidate = path.join(base, `index${extension}`);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

/** Local files referenced by a stylesheet. */
async function stylesheetDependencies(file: string): Promise<string[]> {
  const content = await fs.readFile(file, "utf-8").catch(() => "");
  const found: string[] = [];

  for (const pattern of [CSS_IMPORT, CSS_CONFIG, CSS_PLUGIN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1];
      if (!specifier) continue;
      const resolved = await resolveLocal(file, specifier);
      if (resolved) found.push(resolved);
    }
  }
  return found;
}

/** Local files referenced by a JS/TS module. */
async function moduleDependencies(file: string): Promise<string[]> {
  const content = await fs.readFile(file, "utf-8").catch(() => "");
  const found: string[] = [];

  JS_IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JS_IMPORT.exec(content)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    const resolved = await resolveLocal(file, specifier);
    if (resolved) found.push(resolved);
  }
  return found;
}

/**
 * Collect the local files that a project depends on.
 *
 * @param roots entry files to start from
 * @returns absolute paths, deduplicated, in discovery order
 */
export async function collectDependencies(roots: readonly (string | null)[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];

  const queue: { file: string; depth: number }[] = [];
  for (const root of roots) {
    if (!root) continue;
    const absolute = path.resolve(root);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    result.push(absolute);
    queue.push({ file: absolute, depth: 0 });
  }

  while (queue.length > 0) {
    const { file, depth } = queue.shift() as { file: string; depth: number };
    if (depth >= MAX_DEPTH) continue;

    const isCss = file.endsWith(".css");
    const dependencies = isCss
      ? await stylesheetDependencies(file)
      : await moduleDependencies(file);

    for (const dependency of dependencies) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      result.push(dependency);
      queue.push({ file: dependency, depth: depth + 1 });
    }
  }

  return result;
}
