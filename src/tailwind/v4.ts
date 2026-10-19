/**
 * Tailwind v4 engine.
 *
 * Uses the project's own `tailwindcss` package. The `__unstable__loadDesignSystem`
 * entry point is the same one Tailwind's own language server uses, so the
 * class list and theme match the editor exactly.
 *
 * Module and stylesheet resolution is done here rather than through
 * `@tailwindcss/node` so that the project's local dependencies are used, and
 * so a missing optional dependency degrades instead of crashing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadFailed } from "../core/errors.js";
import type {
  CandidateDescription,
  CanonicalCandidate,
  ClassEntry,
  CompiledClass,
  TailwindEngine,
  ThemeToken,
  VariantEntry,
} from "../core/types.js";
import { fingerprint, fingerprintsEqual, type Fingerprint } from "./fingerprint.js";
import { collectDependencies } from "./dependencies.js";
import { buildScales, canonicalizeCandidate } from "./canonicalize.js";
import { resolveStylesheet } from "./stylesheet.js";
import type { ResolvedProject } from "./project.js";

/** The subset of Tailwind v4's design system that this engine uses. */
interface V4DesignSystem {
  getClassList(): [string, { modifiers?: string[] }][];
  getVariants(): {
    name: string;
    values: string[];
    isArbitrary: boolean;
    hasDash: boolean;
  }[];
  readonly theme: {
    readonly values: Map<string, { value: string; options?: number; src?: string }>;
  };
  resolveThemeValue(path: string, forceInline?: boolean): string | undefined;
  candidatesToCss(classes: string[]): (string | null)[];
  candidatesToAst(classes: string[]): AstNode[][];
  getClassOrder(classes: string[]): [string, bigint | null][];
  canonicalizeCandidates(candidates: string[], options?: { rem?: number }): string[];
}

/** A node of Tailwind's CSS AST, as far as this engine needs it. */
interface AstNode {
  kind: string;
  selector?: string;
  property?: string;
  value?: string;
  nodes?: AstNode[];
}

interface V4TailwindModule {
  __unstable__loadDesignSystem(
    css: string,
    options: {
      base: string;
      loadStylesheet: (
        id: string,
        base: string,
      ) => Promise<{ path: string; base: string; content: string }>;
      loadModule: (
        id: string,
        base: string,
      ) => Promise<{ path: string; base: string; module: unknown }>;
    },
  ): Promise<V4DesignSystem>;
}

export interface V4EngineOptions {
  readonly project: ResolvedProject;
}

export class V4Engine implements TailwindEngine {
  readonly version = 4 as const;
  readonly source: string;

  private readonly project: ResolvedProject;
  private designSystem: V4DesignSystem | null = null;
  private fingerprint: Fingerprint | null = null;
  private loading: Promise<V4DesignSystem> | null = null;

  constructor(options: V4EngineOptions) {
    this.project = options.project;
    this.source = options.project.cssFile
      ? `v4 (${path.relative(options.project.root, options.project.cssFile)})`
      : "v4 (default theme)";
  }

  /**
   * Files whose contents can change the design system.
   *
   * The CSS entry point is the root, but it usually imports partials and
   * points at a config through `@config`. All of those are followed, so an
   * edit anywhere in the chain is noticed.
   */
  private async watchedFiles(): Promise<string[]> {
    return collectDependencies([this.project.cssFile, this.project.configFile]);
  }

  private async load(): Promise<V4DesignSystem> {
    if (this.loading) return this.loading;
    this.loading = this.loadUncached().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadUncached(): Promise<V4DesignSystem> {
    const { install, cssFile, root } = this.project;
    const tailwind = install.require("tailwindcss") as unknown as V4TailwindModule;
    if (typeof tailwind.__unstable__loadDesignSystem !== "function") {
      throw loadFailed(
        `Tailwind ${install.version} does not expose __unstable__loadDesignSystem`,
        undefined,
        { version: install.version },
      );
    }

    const css = cssFile ? await fs.readFile(cssFile, "utf-8") : '@import "tailwindcss";';
    const base = cssFile ? path.dirname(cssFile) : root;

    try {
      const designSystem = await tailwind.__unstable__loadDesignSystem(css, {
        base,
        loadStylesheet: (id, from) => this.loadStylesheet(id, from),
        loadModule: (id, from) => this.loadModule(id, from),
      });
      this.designSystem = designSystem;
      this.fingerprint = await fingerprint(await this.watchedFiles());

      return designSystem;
    } catch (cause) {
      throw loadFailed(
        `Failed to load the Tailwind design system: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
        { cssFile, base },
      );
    }
  }

  /** Resolve a stylesheet import relative to the importing file. */
  private async loadStylesheet(
    id: string,
    base: string,
  ): Promise<{ path: string; base: string; content: string }> {
    try {
      return await resolveStylesheet(
        id,
        base,
        this.project.install.packageDir,
        this.project.root,
        this.project.install.require,
      );
    } catch (cause) {
      throw loadFailed(
        `Cannot resolve stylesheet '${id}' from ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
        { id, base },
      );
    }
  }

  /**
   * Load a JS/TS module referenced by `@config` or `@plugin`.
   *
   * A specifier may be a path relative to the importing file, or a package
   * name such as `@tailwindcss/typography`.
   */
  private async loadModule(
    id: string,
    base: string,
  ): Promise<{ path: string; base: string; module: unknown }> {
    const resolved = this.resolveModule(id, base);
    const module = await import(pathToFileUrl(resolved));
    return { path: resolved, base: path.dirname(resolved), module: module.default ?? module };
  }

  /**
   * Resolve a module specifier to an absolute path.
   */
  private resolveModule(id: string, base: string): string {
    if (path.isAbsolute(id)) return id;

    // A relative path, resolved against the importing file.
    if (id.startsWith(".")) {
      return path.resolve(base, id);
    }

    // A package: resolve it the way Node would, then let the caller load it.
    try {
      return this.project.install.require.resolve(id);
    } catch {
      throw loadFailed(`Cannot resolve module '${id}' from ${base}`, undefined, { id, base });
    }
  }

  /**
   * Return the design system, rebuilding it when the config changed.
   *
   * This is what makes config edits visible without restarting the server.
   */
  private async designSystemFresh(): Promise<V4DesignSystem> {
    const current = await fingerprint(await this.watchedFiles());
    if (this.designSystem && this.fingerprint && fingerprintsEqual(current, this.fingerprint)) {
      return this.designSystem;
    }
    this.designSystem = null;
    this.fingerprint = null;
    return this.load();
  }

  async listClasses(): Promise<readonly ClassEntry[]> {
    const designSystem = await this.designSystemFresh();
    return designSystem.getClassList().map(([name, meta]) => ({
      name,
      modifiers: meta.modifiers ? [...meta.modifiers] : [],
    }));
  }

  async listVariants(): Promise<readonly VariantEntry[]> {
    const designSystem = await this.designSystemFresh();
    return designSystem.getVariants().map((variant) => ({
      name: variant.name,
      values: [...variant.values],
      isArbitrary: variant.isArbitrary,
      hasDash: variant.hasDash,
    }));
  }

  async listTheme(): Promise<readonly ThemeToken[]> {
    const designSystem = await this.designSystemFresh();
    const tokens: ThemeToken[] = [];
    for (const [variable, entry] of designSystem.theme.values) {
      const resolved = designSystem.resolveThemeValue(variable) ?? entry.value;
      tokens.push({
        variable,
        value: entry.value,
        resolved,
        ...(entry.src ? { source: entry.src } : {}),
      });
    }
    return tokens;
  }

  async compile(candidates: readonly string[]): Promise<readonly CompiledClass[]> {
    const designSystem = await this.designSystemFresh();
    const results = designSystem.candidatesToCss([...candidates]);
    return candidates.map((candidate, index) => {
      const css = results[index];
      if (css === null || css === undefined) {
        return { candidate, valid: false, css: "", reason: "Not a valid utility class" };
      }
      return { candidate, valid: true, css };
    });
  }

  async canonicalOrder(candidates: readonly string[]): Promise<readonly string[]> {
    const designSystem = await this.designSystemFresh();
    const order = new Map(designSystem.getClassOrder([...candidates]));
    return candidates
      .map((candidate, index) => ({
        candidate,
        index,
        weight: order.get(candidate) ?? null,
      }))
      .sort((a, b) => {
        // Unknown candidates keep their original relative position at the end.
        if (a.weight === b.weight) return a.index - b.index;
        if (a.weight === null) return 1;
        if (b.weight === null) return -1;
        return a.weight < b.weight ? -1 : 1;
      })
      .map((entry) => entry.candidate);
  }

  /**
   * Report the CSS properties each candidate sets.
   *
   * The AST is used rather than the generated CSS, because the CSS wraps
   * rules in at-rules and mixes in a Tailwind banner, which would make the
   * properties hard to attribute to a candidate.
   */
  async describe(candidates: readonly string[]): Promise<readonly CandidateDescription[]> {
    const designSystem = await this.designSystemFresh();
    const list = [...candidates];
    const asts = designSystem.candidatesToAst(list);
    const order = new Map(designSystem.getClassOrder(list));

    return list.map((candidate, index) => {
      const properties: string[] = [];
      const values: Record<string, string> = {};

      for (const node of asts[index] ?? []) {
        // Only style rules carry the utility's own declarations. The AST also
        // contains `@property` rules that Tailwind emits for its custom
        // properties; those are not part of the utility.
        if (node.kind !== "rule") continue;
        for (const declaration of node.nodes ?? []) {
          if (declaration.kind !== "declaration") continue;
          if (!declaration.property) continue;
          properties.push(declaration.property);
          values[declaration.property] = declaration.value ?? "";
        }
      }

      const weight = order.get(candidate) ?? null;
      return {
        candidate,
        properties,
        values,
        order: weight === null ? null : Number(weight),
      };
    });
  }

  /**
   * Rewrite candidates into their canonical form.
   *
   * Tailwind's own canonicalizer is used, which knows both the theme of this
   * project and the v3-to-v4 renames. The root font size is assumed to be
   * 16px, matching the browser default and `prettier-plugin-tailwindcss`.
   *
   * The canonicalizer builds an internal cache on first use, which takes
   * several seconds. The cache is keyed by the options, so the same options
   * object is always reused and the cost is paid once per design system.
   */
  async canonicalize(candidates: readonly string[]): Promise<readonly CanonicalCandidate[]> {
    const designSystem = await this.designSystemFresh();
    const list = [...candidates];

    // Tailwind's own canonicalizer builds an index of every class the first
    // time it runs, which takes seconds and blocks the event loop. The rules
    // are simple enough to apply here, against the project's own theme.
    const theme = await this.listTheme();
    const scales = buildScales(theme);

    return list.map((candidate) => {
      const canonical = canonicalizeCandidate(candidate, theme, scales);
      return {
        candidate,
        canonical,
        changed: canonical !== candidate,
      };
    });
  }
}

function withCssExtension(candidate: string): string {
  if (path.extname(candidate)) return candidate;
  return `${candidate}.css`;
}

function pathToFileUrl(filePath: string): string {
  return new URL(`file://${path.resolve(filePath)}`).href;
}
