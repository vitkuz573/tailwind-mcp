/**
 * Tailwind v3 engine.
 *
 * v3 is config-driven: the class list and theme come from the resolved
 * config, not from a stylesheet. The project's own `tailwindcss` package is
 * used so plugins and `theme.extend` behave exactly as they do at build time.
 *
 * The class list and variants come from Tailwind's own context, which is the
 * same source the v3 language server used. CSS is produced by running the
 * real PostCSS pipeline over a safelist, so the output is what the project
 * would actually ship.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { loadFailed } from "../core/errors.js";
import type {
  ClassEntry,
  CompiledClass,
  TailwindEngine,
  ThemeToken,
  VariantEntry,
} from "../core/types.js";
import { fingerprint, fingerprintsEqual, type Fingerprint } from "./fingerprint.js";
import { collectDependencies } from "./dependencies.js";
import type { ResolvedProject, TailwindInstall } from "./project.js";

/** The parts of Tailwind v3's context that this engine uses. */
interface V3Context {
  getClassList(): string[];
  getVariants(): { name: string; values: string[]; isArbitrary: boolean; hasDash: boolean }[];
  getClassOrder(classes: string[]): [string, bigint | null][];
}

/** A resolved v3 theme, grouped the way `resolveConfig` returns it. */
type ResolvedTheme = Record<string, unknown>;

export interface V3EngineOptions {
  readonly project: ResolvedProject;
}

export class V3Engine implements TailwindEngine {
  readonly version = 3 as const;
  readonly source: string;

  private readonly project: ResolvedProject;
  private context: V3Context | null = null;
  private theme: ResolvedTheme | null = null;
  private resolvedConfig: Record<string, unknown> | null = null;
  private fingerprint: Fingerprint | null = null;
  private loading: Promise<void> | null = null;

  /** The PostCSS pipeline used to render CSS for the safelist. */
  private processor: PostcssProcessor | null = null;
  /** The PostCSS factory, kept so the output can be parsed back. */
  private postcss: PostcssFactory | null = null;
  /** The safelist handed to the pipeline; mutated between runs. */
  private safelist: string[] = [];

  constructor(options: V3EngineOptions) {
    this.project = options.project;
    this.source = options.project.configFile
      ? `v3 (${path.relative(options.project.root, options.project.configFile)})`
      : "v3 (default config)";
  }

  private async watchedFiles(): Promise<string[]> {
    return collectDependencies([this.project.configFile]);
  }

  private async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.loadUncached().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadUncached(): Promise<void> {
    const { install, configFile, root } = this.project;

    let rawConfig: unknown = {};
    if (configFile) {
      try {
        rawConfig = loadConfigFresh(install, configFile);
      } catch (cause) {
        throw loadFailed(
          `Failed to load Tailwind config ${configFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
          { configFile },
        );
      }
    }

    try {
      const resolveConfig = install.require("tailwindcss/resolveConfig") as (config: unknown) => {
        theme: ResolvedTheme;
      };
      const resolved = resolveConfig(rawConfig);
      this.theme = resolved.theme;
      // The resolved config is kept so the PostCSS pipeline renders the same
      // theme the class list came from. Without it, custom colors and radii
      // would compile against the default theme.
      this.resolvedConfig = resolved;

      const { createContext } = install.require("tailwindcss/lib/lib/setupContextUtils.js") as {
        createContext: (config: unknown) => V3Context;
      };
      this.context = createContext(resolved);
      this.fingerprint = await fingerprint(await this.watchedFiles());
    } catch (cause) {
      throw loadFailed(
        `Failed to build the Tailwind v3 context: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
        { root },
      );
    }
  }

  private async fresh(): Promise<V3Context> {
    const current = await fingerprint(await this.watchedFiles());
    if (this.context && this.fingerprint && fingerprintsEqual(current, this.fingerprint)) {
      return this.context;
    }
    this.context = null;
    this.theme = null;
    this.resolvedConfig = null;
    this.fingerprint = null;
    this.processor = null;
    await this.load();
    if (!this.context) throw loadFailed("Tailwind v3 context could not be created");
    return this.context;
  }

  async listClasses(): Promise<readonly ClassEntry[]> {
    const context = await this.fresh();
    return context.getClassList().map((name) => ({ name, modifiers: [] }));
  }

  async listVariants(): Promise<readonly VariantEntry[]> {
    const context = await this.fresh();
    return context.getVariants().map((variant) => ({
      name: variant.name,
      values: [...variant.values],
      isArbitrary: variant.isArbitrary,
      hasDash: variant.hasDash,
    }));
  }

  async listTheme(): Promise<readonly ThemeToken[]> {
    await this.fresh();
    if (!this.theme) return [];
    const tokens: ThemeToken[] = [];
    for (const [variable, value] of flattenTheme(this.theme)) {
      tokens.push({ variable, value, resolved: value });
    }
    return tokens;
  }

  async compile(candidates: readonly string[]): Promise<readonly CompiledClass[]> {
    const context = await this.fresh();
    const known = new Set(context.getClassList());
    const list = [...candidates];

    // Only candidates whose base utility exists can produce CSS. Arbitrary
    // values and variants are not in the class list, so the base is checked.
    const plausible = list.filter((candidate) => {
      const base = stripVariants(candidate);
      return known.has(candidate) || known.has(base);
    });

    const rendered =
      plausible.length > 0 ? await this.render(plausible) : new Map<string, string>();

    return list.map((candidate) => {
      const base = stripVariants(candidate);
      const exists = known.has(candidate) || known.has(base);
      if (!exists) {
        return {
          candidate,
          valid: false,
          css: "",
          reason: "Not a valid utility class",
        };
      }
      const css = rendered.get(candidate) ?? "";
      return {
        candidate,
        valid: true,
        css,
        ...(css ? {} : { reason: "Utility has no effect for these inputs" }),
      };
    });
  }

  /**
   * Render the safelisted candidates with the real PostCSS pipeline.
   *
   * Returns a map from candidate to the CSS rule that was produced.
   */
  private async render(candidates: readonly string[]): Promise<Map<string, string>> {
    const { install } = this.project;

    if (!this.processor) {
      // PostCSS ships as a dependency of Tailwind, so it is resolved from
      // Tailwind's own directory rather than the project root. A project that
      // only depends on `tailwindcss` therefore still works.
      const tailwindRequire = createRequire(path.join(install.packageDir, "package.json"));
      const postcss = tailwindRequire("postcss") as PostcssFactory;
      const tailwindcss = install.require("tailwindcss") as (config: unknown) => PostcssPlugin;
      this.safelist = [];
      this.postcss = postcss;
      this.processor = postcss([
        tailwindcss({
          ...(this.resolvedConfig ?? {}),
          content: [{ raw: "tailwind-mcp", extension: "html" }],
          safelist: this.safelist,
        }),
      ]);
    }

    this.safelist.length = 0;
    this.safelist.push(...candidates);

    let css: string;
    try {
      const result = await this.processor.process("@tailwind utilities;", { from: undefined });
      css = result.css;
    } catch (cause) {
      throw loadFailed(
        `Failed to compile Tailwind CSS: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      );
    }

    return extractRules(css, this.postcss as PostcssFactory);
  }

  async canonicalOrder(candidates: readonly string[]): Promise<readonly string[]> {
    const context = await this.fresh();
    const order = new Map(context.getClassOrder([...candidates]));
    return candidates
      .map((candidate, index) => ({
        candidate,
        index,
        weight: order.get(candidate) ?? null,
      }))
      .sort((a, b) => {
        if (a.weight === b.weight) return a.index - b.index;
        if (a.weight === null) return 1;
        if (b.weight === null) return -1;
        return a.weight < b.weight ? -1 : 1;
      })
      .map((entry) => entry.candidate);
  }
}

/** Minimal PostCSS surface used by this engine. */
interface PostcssPlugin {
  (options: unknown): unknown;
}
interface PostcssProcessor {
  process(css: string, options: { from: undefined }): Promise<{ css: string }>;
}
interface PostcssNode {
  type: string;
  selector?: string;
  params?: string;
  toString(): string;
  parent?: PostcssNode;
}
interface PostcssFactory {
  (plugins: unknown[]): PostcssProcessor;
  parse(css: string): { walkRules(callback: (rule: PostcssNode) => void): void };
}

/**
 * Extract the CSS rule for each class in a stylesheet.
 *
 * The stylesheet is parsed with PostCSS so that rules nested in `@media`
 * blocks are found as well. A rule is attributed to the first class in its
 * selector, unescaped, so `md\:hover\:px-2:hover` maps to `md:hover:px-2`.
 */
function extractRules(css: string, postcss: PostcssFactory): Map<string, string> {
  const rules = new Map<string, string>();
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return rules;
  }

  root.walkRules((rule) => {
    const selector = rule.selector;
    if (!selector) return;
    const className = firstClassIn(selector);
    if (!className || rules.has(className)) return;

    // Include the enclosing at-rule, e.g. `@media (min-width: 768px)`, so the
    // caller sees the rule exactly as it would be shipped.
    const parent = rule.parent;
    if (parent && parent.type === "atrule" && parent.params) {
      rules.set(className, `${parent.toString()}`);
      return;
    }
    rules.set(className, rule.toString());
  });

  return rules;
}

/**
 * The class name of a selector, unescaped.
 *
 * `md\:hover\:px-2:hover` yields `md:hover:px-2`.
 */
function firstClassIn(selector: string): string | null {
  const start = selector.indexOf(".");
  if (start === -1) return null;
  let out = "";
  for (let index = start + 1; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === undefined) break;
    if (char === "\\") {
      const next = selector[index + 1];
      if (next === undefined) break;
      out += next;
      index += 1;
      continue;
    }
    if (": ,>+~[{".includes(char)) break;
    out += char;
  }
  return out.length > 0 ? out : null;
}

/**
 * Flatten a resolved v3 theme into `variable → value` pairs.
 *
 * v3 names are nested (`colors.red.500`); v4 exposes CSS custom properties.
 * The v3 shape is preserved here so the caller sees the real config.
 */
function flattenTheme(theme: ResolvedTheme): [string, string][] {
  const out: [string, string][] = [];
  const walk = (value: unknown, prefix: string[]): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...prefix, String(index)]));
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        walk(item, [...prefix, key]);
      }
      return;
    }
    out.push([prefix.join("."), String(value)]);
  };
  walk(theme, []);
  return out;
}

/** Remove variant prefixes (`md:hover:`) from a candidate. */
function stripVariants(candidate: string): string {
  const parts = candidate.split(":");
  return parts[parts.length - 1] ?? candidate;
}

/** Resolve a module from the project's own node_modules. */
export function requireFrom(base: string, id: string): unknown {
  return createRequire(path.join(base, "package.json"))(id);
}

/**
 * Load a Tailwind config file, bypassing every cache.
 *
 * Tailwind's own `loadConfig` goes through jiti, which for plain JavaScript
 * falls back to Node's `require` and therefore keeps serving the first version
 * of the file it ever read. A config edit would then be invisible, which is
 * exactly what this server must not do.
 *
 * The native require cache is cleared for the config and jiti is created with
 * its own caches disabled, so the file is always read from disk.
 */
function loadConfigFresh(install: TailwindInstall, configFile: string): unknown {
  // Clear the native require cache for the config and anything it pulled in.
  const nativeRequire = createRequire(import.meta.url);
  const configDir = path.dirname(configFile);
  for (const key of Object.keys(nativeRequire.cache)) {
    if (key.startsWith(configDir + path.sep)) {
      delete nativeRequire.cache[key];
    }
  }

  // jiti ships as a dependency of Tailwind v3, so it is resolved from
  // Tailwind's own directory rather than the project root.
  const tailwindRequire = createRequire(path.join(install.packageDir, "package.json"));
  const jiti = tailwindRequire("jiti") as (
    filename: string,
    options: Record<string, unknown>,
  ) => (id: string) => unknown;

  const loader = jiti(path.join(install.packageDir, "package.json"), {
    interopDefault: true,
    cache: false,
    requireCache: false,
  });

  const loaded = loader(configFile) as { default?: unknown } | undefined;
  return loaded && "default" in loaded ? loaded.default : loaded;
}
