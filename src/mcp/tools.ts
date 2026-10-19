/**
 * Tool implementations.
 *
 * The tools are deliberately few and answer the questions a coding agent
 * actually has: "does this class exist", "what does it compile to", "what is
 * in the theme", "what is the canonical order".
 *
 * Every tool returns the same envelope so the model can parse results
 * uniformly: a human-readable `summary` plus a machine-readable `data`.
 */

import type { ClassEntry, TailwindEngine, ThemeToken, VariantEntry } from "../core/types.js";
import { splitCandidates } from "./diagnostics.js";

export interface ToolEnvelope<T> {
  readonly summary: string;
  readonly data: T;
}

/** Result of validating a list of candidate classes. */
export interface ValidationData {
  readonly total: number;
  readonly valid: readonly string[];
  readonly invalid: readonly { candidate: string; reason: string }[];
  readonly compiled: readonly { candidate: string; css: string }[];
  readonly canonicalOrder: readonly string[];
}

export interface ValidateInput {
  readonly candidates: readonly string[];
}

/**
 * Check candidates against the project's Tailwind and compile the valid ones.
 */
export async function validateCandidates(
  engine: TailwindEngine,
  input: ValidateInput,
): Promise<ToolEnvelope<ValidationData>> {
  const candidates = splitCandidates(input.candidates);
  const results = await engine.compile(candidates);
  const valid: string[] = [];
  const invalid: { candidate: string; reason: string }[] = [];
  const compiled: { candidate: string; css: string }[] = [];

  for (const result of results) {
    if (result.valid) {
      valid.push(result.candidate);
      if (result.css) compiled.push({ candidate: result.candidate, css: result.css });
    } else {
      invalid.push({ candidate: result.candidate, reason: result.reason ?? "Invalid class" });
    }
  }

  const canonicalOrder = await engine.canonicalOrder(input.candidates);

  const summary =
    invalid.length === 0
      ? `All ${valid.length} candidates are valid.`
      : `${valid.length} valid, ${invalid.length} invalid: ${invalid
          .map((entry) => entry.candidate)
          .join(", ")}`;

  return {
    summary,
    data: { total: results.length, valid, invalid, compiled, canonicalOrder },
  };
}

/** Filters for the class list. */
export interface ClassSearchInput {
  /** Case-insensitive substring the class name must contain. */
  readonly query?: string | undefined;
  /** Only return classes starting with this prefix. */
  readonly prefix?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}
export interface ClassSearchData {
  readonly total: number;
  readonly returned: number;
  readonly offset: number;
  readonly classes: { name: string; modifiers: string[] }[];
  /** Total number of classes matching the filter, ignoring pagination. */
  readonly matched: number;
}

/**
 * Search the project's real class list.
 *
 * The list comes from the installed Tailwind, so it contains exactly the
 * utilities this project can build — including custom theme values.
 */
export async function searchClasses(
  engine: TailwindEngine,
  input: ClassSearchInput,
): Promise<ToolEnvelope<ClassSearchData>> {
  const all = await engine.listClasses();
  const query = input.query?.trim().toLowerCase();
  const prefix = input.prefix?.trim().toLowerCase();

  const matched = all.filter((entry) => {
    const name = entry.name.toLowerCase();
    if (prefix && !name.startsWith(prefix)) return false;
    if (query && !name.includes(query)) return false;
    return true;
  });

  const page = matched.slice(input.offset, input.offset + input.limit);
  const summary =
    matched.length === 0
      ? "No classes matched."
      : `${page.length} of ${matched.length} matching classes (offset ${input.offset}).`;

  return {
    summary,
    data: {
      total: all.length,
      returned: page.length,
      offset: input.offset,
      matched: matched.length,
      classes: page.map((entry) => ({ name: entry.name, modifiers: [...entry.modifiers] })),
    },
  };
}

/** Filters for the theme lookup. */
export interface ThemeInput {
  /** Case-insensitive substring the variable must contain. */
  readonly query?: string | undefined;
  /** Only return variables in this namespace, e.g. `color`. */
  readonly namespace?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface ThemeData {
  readonly total: number;
  readonly matched: number;
  readonly offset: number;
  readonly tokens: { variable: string; value: string; resolved: string }[];
}

/**
 * Read the project's design tokens.
 */
export async function readTheme(
  engine: TailwindEngine,
  input: ThemeInput,
): Promise<ToolEnvelope<ThemeData>> {
  const all = await engine.listTheme();
  const query = input.query?.trim().toLowerCase();
  const namespace = input.namespace?.trim().toLowerCase();

  const matched = all.filter((token) => {
    const variable = token.variable.toLowerCase();
    if (namespace) {
      const tokenNamespace = namespaceOf(token.variable);
      if (!tokenNamespace.includes(namespace)) return false;
    }
    if (query && !variable.includes(query)) return false;
    return true;
  });

  const page = matched.slice(input.offset, input.offset + input.limit);
  const summary = `${page.length} of ${matched.length} matching theme tokens.`;

  return {
    summary,
    data: {
      total: all.length,
      matched: matched.length,
      offset: input.offset,
      tokens: page.map((token) => ({
        variable: token.variable,
        value: token.value,
        resolved: token.resolved,
      })),
    },
  };
}

/** Filters for the variant lookup. */
export interface VariantInput {
  readonly query?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface VariantData {
  readonly total: number;
  readonly matched: number;
  readonly offset: number;
  readonly variants: { name: string; values: string[] }[];
}

/**
 * List the variants the project understands.
 */
export async function listVariants(
  engine: TailwindEngine,
  input: VariantInput,
): Promise<ToolEnvelope<VariantData>> {
  const all = await engine.listVariants();
  const query = input.query?.trim().toLowerCase();
  const matched = query ? all.filter((variant) => variant.name.toLowerCase().includes(query)) : all;

  const page = matched.slice(input.offset, input.offset + input.limit);
  const summary = `${page.length} of ${matched.length} matching variants.`;

  return {
    summary,
    data: {
      total: all.length,
      matched: matched.length,
      offset: input.offset,
      variants: page.map((variant) => ({ name: variant.name, values: [...variant.values] })),
    },
  };
}

/** Namespace of a CSS custom property, e.g. `--color-red-500` → `color`. */
function namespaceOf(variable: string): string {
  const withoutPrefix = variable.replace(/^--/, "");
  const dash = withoutPrefix.indexOf("-");
  return dash === -1 ? withoutPrefix : withoutPrefix.slice(0, dash);
}

export type { ClassEntry, ThemeToken, VariantEntry };
