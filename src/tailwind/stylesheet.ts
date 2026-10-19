/**
 * Stylesheet resolution.
 *
 * A Tailwind v4 stylesheet imports more than itself: it pulls in `tailwindcss`
 * itself, packages that ship utilities (`tw-animate-css`), and sub-paths of
 * packages (`shadcn/tailwind.css`). Each of those is found differently:
 *
 * - `tailwindcss` resolves to the package's own `index.css`,
 * - a bare package specifier resolves through the package's `exports` map,
 *   preferring the `style` condition, because that is the condition CSS
 *   bundlers use,
 * - a package sub-path resolves through `exports` as well,
 * - a relative path resolves against the importing file.
 *
 * Resolution follows Node's rules closely enough for stylesheets: the
 * `exports` map is honoured, including the `style` and `default` conditions,
 * and a package without `exports` falls back to its `style` or `main` field.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

/** How a stylesheet specifier was resolved. */
export interface ResolvedStylesheet {
  /** Absolute path of the file. */
  readonly path: string;
  /** The directory the file lives in, used as the base for its own imports. */
  readonly base: string;
  /** The content of the file. */
  readonly content: string;
}

/** The result of looking a specifier up in a package. */
interface PackageEntry {
  /** The file the specifier points at, relative to the package root. */
  readonly file: string | undefined;
  /** The package root, when the specifier named a package. */
  readonly packageRoot: string | undefined;
}

/**
 * Resolve a stylesheet specifier.
 *
 * @param id the specifier as written in the `@import`
 * @param base the directory of the importing file
 * @param tailwindPackageDir the directory of the `tailwindcss` package
 * @param projectRoot the project root, used to find installed packages
 * @param requireFrom a `require` bound to the project, for package lookup
 */
export async function resolveStylesheet(
  id: string,
  base: string,
  tailwindPackageDir: string,
  projectRoot: string,
  requireFrom: NodeRequire,
): Promise<ResolvedStylesheet> {
  const resolved = await resolvePath(id, base, tailwindPackageDir, projectRoot, requireFrom);
  const content = await fs.readFile(resolved, "utf-8");
  return { path: resolved, base: path.dirname(resolved), content };
}

/**
 * Resolve a specifier to an absolute file path.
 */
async function resolvePath(
  id: string,
  base: string,
  tailwindPackageDir: string,
  projectRoot: string,
  requireFrom: NodeRequire,
): Promise<string> {
  // Tailwind itself: the package's entry stylesheet.
  if (id === "tailwindcss") {
    return path.join(tailwindPackageDir, "index.css");
  }
  if (id.startsWith("tailwindcss/")) {
    return path.join(tailwindPackageDir, id.slice("tailwindcss/".length));
  }

  // A relative path, resolved against the importing file.
  if (id.startsWith(".") || path.isAbsolute(id)) {
    return resolveFile(path.resolve(base, id));
  }

  // A package specifier, possibly with a sub-path.
  const entry = await resolvePackageEntry(id, projectRoot, requireFrom);
  if (entry?.file && entry.packageRoot) {
    return resolveFile(path.join(entry.packageRoot, entry.file));
  }

  throw new Error(
    `Cannot resolve '${id}' from '${base}'. ` +
      "Install the package that provides it, or import it by relative path.",
  );
}

/**
 * Find the file a specifier points at.
 *
 * A specifier without an extension may name a directory with an `index.css`.
 */
async function resolveFile(candidate: string): Promise<string> {
  const attempts = [candidate, `${candidate}.css`, path.join(candidate, "index.css")];
  for (const attempt of attempts) {
    try {
      const stat = await fs.stat(attempt);
      if (stat.isFile()) return attempt;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`Cannot find the file '${candidate}'`);
}

/**
 * Look a package specifier up in the `exports` map of its package.
 *
 * The `style` condition is preferred, then `default`, because a package that
 * ships CSS usually declares it under `style` while its JavaScript entry is
 * something else entirely.
 *
 * The package's own `package.json` is read directly rather than resolved
 * through Node, because a package need not export it.
 */
async function resolvePackageEntry(
  id: string,
  projectRoot: string,
  requireFrom: NodeRequire,
): Promise<PackageEntry | null> {
  // Split the specifier into the package name and the sub-path.
  const parts = id.split("/");
  const packageName = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const subPath = id.slice(packageName.length).replace(/^\//, "");

  const packageJsonPath = await findPackageJson(packageName, projectRoot, requireFrom);
  if (!packageJsonPath) return null;
  const packageRoot = path.dirname(packageJsonPath);

  let manifest: {
    exports?: unknown;
    style?: string;
    main?: string;
  };
  try {
    manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf-8")) as typeof manifest;
  } catch {
    return null;
  }

  // A sub-path is an exact key in the exports map.
  if (subPath) {
    const direct = manifest.exports as Record<string, unknown> | undefined;
    if (direct && typeof direct === "object") {
      const target = pickExport(direct[`./${subPath}`]);
      if (target) return { file: target, packageRoot };
    }
    // Without an exports entry, the sub-path is a plain file.
    return { file: subPath, packageRoot };
  }

  // The package root.
  const direct = manifest.exports as Record<string, unknown> | undefined;
  if (direct && typeof direct === "object") {
    const target = pickExport(direct["."]);
    if (target) return { file: target, packageRoot };
  }
  if (manifest.style) return { file: manifest.style, packageRoot };
  if (manifest.main && manifest.main.endsWith(".css")) {
    return { file: manifest.main, packageRoot };
  }
  return null;
}

/**
 * Find the `package.json` of a package.
 *
 * Node's own resolution is tried first, because it follows the `exports`
 * map and the `node_modules` layout. When the package does not export its
 * manifest, the file is looked up in `node_modules` directly.
 */
async function findPackageJson(
  packageName: string,
  projectRoot: string,
  requireFrom: NodeRequire,
): Promise<string | null> {
  try {
    return requireFrom.resolve(`${packageName}/package.json`);
  } catch {
    // The package may not export its manifest; look it up directly.
  }

  // Walk up from the project, checking each `node_modules` directory.
  let current = projectRoot;
  for (;;) {
    const candidate = path.join(current, "node_modules", packageName, "package.json");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Not here; keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
/**
 * Pick the file from an exports entry.
 *
 * The entry may be a string, or an object of conditions. The `style` condition
 * comes first, then `default`, then `require`/`import`.
 */
function pickExport(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;

  const conditions = entry as Record<string, unknown>;
  for (const condition of ["style", "default", "import", "require"]) {
    const value = conditions[condition];
    if (value === undefined) continue;
    const picked = pickExport(value);
    if (picked) return picked;
  }
  return null;
}

/**
 * A `require` bound to a directory, used to look packages up.
 */
export function requireFrom(base: string): NodeRequire {
  return createRequire(path.join(base, "package.json"));
}
