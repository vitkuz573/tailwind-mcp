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
  ClassEntry,
  CompiledClass,
  TailwindEngine,
  ThemeToken,
  VariantEntry,
} from "../core/types.js";
import { fingerprint, fingerprintsEqual, type Fingerprint } from "./fingerprint.js";
import { collectDependencies } from "./dependencies.js";
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
  getClassOrder(classes: string[]): [string, bigint | null][];
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
    const resolved = this.resolveStylesheet(id, base);
    const content = await fs.readFile(resolved, "utf-8");
    return { path: resolved, base: path.dirname(resolved), content };
  }

  private resolveStylesheet(id: string, base: string): string {
    if (id.startsWith(".")) {
      const candidate = path.resolve(base, id);
      return withCssExtension(candidate);
    }
    if (id === "tailwindcss" || id.startsWith("tailwindcss/")) {
      const relative = id === "tailwindcss" ? "index.css" : id.slice("tailwindcss/".length);
      return path.join(this.project.install.packageDir, relative);
    }
    // A bare specifier that is not Tailwind itself: try the project first.
    try {
      return this.project.install.require.resolve(id);
    } catch {
      throw loadFailed(`Cannot resolve stylesheet '${id}' from ${base}`, undefined, { id, base });
    }
  }

  /** Load a JS/TS module referenced by `@config` or `@plugin`. */
  private async loadModule(
    id: string,
    base: string,
  ): Promise<{ path: string; base: string; module: unknown }> {
    const resolved = path.isAbsolute(id) ? id : path.resolve(base, id);
    const module = await import(pathToFileUrl(resolved));
    return { path: resolved, base: path.dirname(resolved), module: module.default ?? module };
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
}

function withCssExtension(candidate: string): string {
  if (path.extname(candidate)) return candidate;
  return `${candidate}.css`;
}

function pathToFileUrl(filePath: string): string {
  return new URL(`file://${path.resolve(filePath)}`).href;
}
