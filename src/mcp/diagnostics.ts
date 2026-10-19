/**
 * Diagnostic tools.
 *
 * These answer the questions a coding agent cannot answer on its own:
 * "does this class exist", "what did I mean", "which of these two wins",
 * "should this be a token instead of an arbitrary value", "is this text
 * readable on that background".
 */

import { contrastRatio, parseColor, type ContrastResult } from "../core/color.js";
import { suggestForCandidate, type Suggestion } from "../core/fuzzy.js";
import type { TailwindEngine } from "../core/types.js";
import { detectConflicts, propertyClaims, type ClassProperties } from "../tailwind/conflicts.js";
import { findMigration, type MigrationFinding } from "../tailwind/migration.js";

/**
 * Split a class list into individual candidates.
 *
 * A class attribute is a whitespace-separated string, and a model may pass
 * either that string or an array. Both are accepted, and an array element may
 * itself contain several classes.
 */
export function splitCandidates(candidates: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of candidates) {
    for (const part of entry.split(/\s+/)) {
      if (part === "") continue;
      // The same class twice in one list is not a conflict with itself.
      if (seen.has(part)) continue;
      seen.add(part);
      result.push(part);
    }
  }
  return result;
}

/** A class that does not exist, with a suggestion for what was meant. */
export interface TypoFinding {
  /** The class as it was written. */
  readonly candidate: string;
  /** Closest real class names. */
  readonly suggestions: readonly Suggestion[];
}

/** A class that uses an arbitrary value where a theme token would do. */
export interface ArbitraryFinding {
  /** The class as it was written. */
  readonly candidate: string;
  /** The same class expressed with a theme token. */
  readonly canonical: string;
  /** What the canonical form is worth. */
  readonly reason: string;
}

/** A v3 class used in a v4 project. */
export interface MigrationToolFinding {
  readonly candidate: string;
  readonly replacement: string;
  readonly kind: MigrationFinding["kind"];
  readonly note: string;
}

/** Result of the combined diagnostic tool. */
export interface DiagnoseData {
  readonly total: number;
  /** Classes that exist. */
  readonly valid: readonly string[];
  /** Classes that do not exist, with suggestions. */
  readonly typos: readonly TypoFinding[];
  /** Classes that should use a theme token instead of an arbitrary value. */
  readonly arbitrary: readonly ArbitraryFinding[];
  /** Classes where one overrides another. */
  readonly conflicts: readonly {
    property: string;
    winner: string;
    loser: string;
    winnerValue?: string;
    loserValue?: string;
  }[];
  /** v3 classes that need to change. */
  readonly migration: readonly MigrationToolFinding[];
}

export interface DiagnoseInput {
  readonly candidates: readonly string[];
}

/**
 * Diagnose a class list in one pass.
 *
 * Every problem is reported together, so a model can fix a whole class
 * attribute with a single call instead of discovering issues one at a time.
 */
export async function diagnose(
  engine: TailwindEngine,
  input: DiagnoseInput,
): Promise<{ summary: string; data: DiagnoseData }> {
  const candidates = splitCandidates(input.candidates);
  const compiled = await engine.compile(candidates);
  const classList = (await engine.listClasses()).map((entry) => entry.name);

  const valid: string[] = [];
  const typos: TypoFinding[] = [];
  const invalidSet = new Set<string>();

  for (const result of compiled) {
    if (result.valid) {
      valid.push(result.candidate);
      continue;
    }
    invalidSet.add(result.candidate);
    typos.push({
      candidate: result.candidate,
      suggestions: suggestForCandidate(result.candidate, classList),
    });
  }

  // A class can be valid yet still be the wrong way to express a value.
  const canonical = await engine.canonicalize(candidates);
  const arbitrary: ArbitraryFinding[] = [];
  for (const entry of canonical) {
    if (!entry.changed) continue;
    if (!entry.candidate.includes("[")) continue;
    arbitrary.push({
      candidate: entry.candidate,
      canonical: entry.canonical,
      reason: "A theme token expresses this value; an arbitrary value ignores the design system.",
    });
  }

  // Conflicts are only meaningful between classes that actually exist.
  const descriptions = await engine.describe(candidates);
  const properties: ClassProperties[] = descriptions.map((entry) => ({
    candidate: entry.candidate,
    properties: entry.properties,
    order: entry.order,
    values: entry.values,
  }));
  const conflicts = detectConflicts(properties).filter(
    (conflict) => !invalidSet.has(conflict.winner) && !invalidSet.has(conflict.loser),
  );

  // Migration matters only when the class would otherwise work.
  const migration: MigrationToolFinding[] = [];
  for (const candidate of candidates) {
    if (invalidSet.has(candidate)) continue;
    const finding = findMigration(candidate, true);
    if (finding) {
      migration.push({
        candidate: finding.candidate,
        replacement: finding.replacement,
        kind: finding.kind,
        note: finding.note,
      });
    }
  }

  const issues = typos.length + arbitrary.length + conflicts.length + migration.length;
  const summary =
    issues === 0
      ? `All ${valid.length} classes are valid and free of conflicts.`
      : `${valid.length} valid; ${typos.length} unknown, ${arbitrary.length} arbitrary, ` +
        `${conflicts.length} conflicting, ${migration.length} needing migration.`;

  return {
    summary,
    data: {
      total: candidates.length,
      valid,
      typos,
      arbitrary,
      conflicts,
      migration,
    },
  };
}

/** Result of the conflict tool. */
export interface ConflictData {
  readonly total: number;
  readonly conflicts: readonly {
    property: string;
    winner: string;
    loser: string;
    winnerValue?: string;
    loserValue?: string;
  }[];
  /** Which class wins for each contested property. */
  readonly claims: readonly {
    property: string;
    winner: string;
    overridden: readonly string[];
    value?: string;
  }[];
}

/**
 * Report which class wins when several set the same property.
 */
export async function findConflicts(
  engine: TailwindEngine,
  input: DiagnoseInput,
): Promise<{ summary: string; data: ConflictData }> {
  const candidates = splitCandidates(input.candidates);
  const descriptions = await engine.describe(candidates);
  const properties: ClassProperties[] = descriptions.map((entry) => ({
    candidate: entry.candidate,
    properties: entry.properties,
    order: entry.order,
    values: entry.values,
  }));

  const conflicts = detectConflicts(properties);
  const claims = propertyClaims(properties);

  const summary =
    conflicts.length === 0
      ? "No conflicting properties among the given classes."
      : `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} found.`;

  return {
    summary,
    data: { total: candidates.length, conflicts, claims },
  };
}

/** Result of the canonicalization tool. */
export interface CanonicalizeData {
  readonly total: number;
  /** The classes in Tailwind's canonical order. */
  readonly ordered: readonly string[];
  /** The classes with their canonical spelling, in canonical order. */
  readonly canonical: readonly {
    candidate: string;
    canonical: string;
    changed: boolean;
  }[];
}

/**
 * Put a class list into Tailwind's canonical form and order.
 */
export async function canonicalizeClasses(
  engine: TailwindEngine,
  input: DiagnoseInput,
): Promise<{ summary: string; data: CanonicalizeData }> {
  const candidates = splitCandidates(input.candidates);
  const canonical = await engine.canonicalize(candidates);
  const ordered = await engine.canonicalOrder(candidates);

  const byCandidate = new Map(canonical.map((entry) => [entry.candidate, entry]));
  const orderedCanonical = ordered.map(
    (candidate) =>
      byCandidate.get(candidate) ?? { candidate, canonical: candidate, changed: false },
  );

  const changed = orderedCanonical.filter((entry) => entry.changed);
  const summary =
    changed.length === 0
      ? `${candidates.length} classes are already canonical.`
      : `${changed.length} of ${candidates.length} classes have a canonical form.`;

  return {
    summary,
    data: { total: candidates.length, ordered, canonical: orderedCanonical },
  };
}

/** Result of the migration tool. */
export interface MigrationData {
  readonly total: number;
  readonly findings: readonly MigrationToolFinding[];
  /** The v4 class list, so the model can verify a replacement. */
  readonly verified: readonly string[];
}

/**
 * Find v3 classes that need to change for a v4 project.
 */
export async function migrateClasses(
  engine: TailwindEngine,
  input: DiagnoseInput,
): Promise<{ summary: string; data: MigrationData }> {
  const candidates = splitCandidates(input.candidates);
  const classList = await engine.listClasses();
  const known = new Set(classList.map((entry) => entry.name));
  const modifiers = new Map(classList.map((entry) => [entry.name, entry.modifiers]));

  const findings: MigrationToolFinding[] = [];
  const verified: string[] = [];

  for (const candidate of candidates) {
    const separator = candidate.lastIndexOf(":");
    const utility = separator > 0 ? candidate.slice(separator + 1) : candidate;
    const finding = findMigration(candidate, known.has(utility));
    if (!finding) continue;

    findings.push({
      candidate: finding.candidate,
      replacement: finding.replacement,
      kind: finding.kind,
      note: finding.note,
    });

    // Only report a replacement as usable when the project really has it.
    // A replacement may carry an opacity modifier, e.g. `bg-black/50`, in
    // which case the base class and the modifier are checked separately.
    const replacementUtility = finding.replacement.slice(finding.replacement.lastIndexOf(":") + 1);
    const slash = replacementUtility.indexOf("/");
    if (slash === -1) {
      if (known.has(replacementUtility)) verified.push(finding.replacement);
      continue;
    }

    const base = replacementUtility.slice(0, slash);
    const modifier = replacementUtility.slice(slash + 1);
    const allowed = modifiers.get(base);
    if (allowed && allowed.includes(modifier)) verified.push(finding.replacement);
  }

  const summary =
    findings.length === 0
      ? "No v3 classes found that need migrating."
      : `${findings.length} class${findings.length === 1 ? "" : "es"} need migrating to v4.`;

  return { summary, data: { total: candidates.length, findings, verified } };
}

/** A pair of colours to compare. */
export interface ContrastInput {
  /** The text colour: a theme token such as `red-500` or a CSS colour. */
  readonly foreground: string;
  /** The background colour: a theme token such as `white` or a CSS colour. */
  readonly background: string;
}

/** Result of the contrast tool. */
export interface ContrastToolData {
  readonly foreground: string;
  readonly background: string;
  readonly foregroundValue: string;
  readonly backgroundValue: string;
  readonly ratio: number;
  readonly aa: boolean;
  readonly aaLarge: boolean;
  readonly aaa: boolean;
  readonly aaaLarge: boolean;
  readonly foregroundLuminance: number;
  readonly backgroundLuminance: number;
}

/**
 * Compute the WCAG contrast ratio of two colours.
 *
 * Colours may be given as theme tokens (`red-500`, `--color-red-500`) or as
 * any CSS colour the parser understands.
 */
export async function checkContrast(
  engine: TailwindEngine,
  input: ContrastInput,
): Promise<{ summary: string; data: ContrastToolData }> {
  const theme = await engine.listTheme();

  const foreground = resolveColor(input.foreground, theme);
  const background = resolveColor(input.background, theme);

  const foregroundColor = parseColor(foreground);
  const backgroundColor = parseColor(background);

  if (!foregroundColor) {
    return {
      summary: `Cannot parse the foreground colour '${input.foreground}' (resolved to '${foreground}').`,
      data: {
        foreground: input.foreground,
        background: input.background,
        foregroundValue: foreground,
        backgroundValue: background,
        ratio: 0,
        aa: false,
        aaLarge: false,
        aaa: false,
        aaaLarge: false,
        foregroundLuminance: 0,
        backgroundLuminance: 0,
      },
    };
  }

  if (!backgroundColor) {
    return {
      summary: `Cannot parse the background colour '${input.background}' (resolved to '${background}').`,
      data: {
        foreground: input.foreground,
        background: input.background,
        foregroundValue: foreground,
        backgroundValue: background,
        ratio: 0,
        aa: false,
        aaLarge: false,
        aaa: false,
        aaaLarge: false,
        foregroundLuminance: 0,
        backgroundLuminance: 0,
      },
    };
  }

  const result: ContrastResult = contrastRatio(foregroundColor, backgroundColor);
  const level = result.aaa
    ? "AAA"
    : result.aa
      ? "AA"
      : result.aaLarge
        ? "AA for large text only"
        : "fails WCAG AA";

  return {
    summary: `Contrast ratio ${result.ratio}:1 — ${level}.`,
    data: {
      foreground: input.foreground,
      background: input.background,
      foregroundValue: foreground,
      backgroundValue: background,
      ratio: result.ratio,
      aa: result.aa,
      aaLarge: result.aaLarge,
      aaa: result.aaa,
      aaaLarge: result.aaaLarge,
      foregroundLuminance: result.foregroundLuminance,
      backgroundLuminance: result.backgroundLuminance,
    },
  };
}

/**
 * Resolve a colour reference to a CSS value.
 *
 * A reference may be a theme token (`red-500`), a CSS custom property
 * (`--color-red-500`), a v3 theme path (`colors.red.500`), a colour utility
 * name (`bg-red-500`), or a literal CSS colour.
 */
function resolveColor(
  reference: string,
  theme: readonly { variable: string; value: string; resolved: string }[],
): string {
  const value = reference.trim();
  if (value === "") return value;

  const byVariable = new Map(theme.map((token) => [token.variable, token]));

  // A full custom property or theme path.
  const direct = byVariable.get(value);
  if (direct) return direct.resolved;

  // A bare token name such as `red-500` or `white`. v4 stores these as CSS
  // custom properties, v3 as nested theme paths.
  const dotted = value.replace(/-/g, ".");
  const candidates = [
    `--color-${value}`,
    `--color-${value}-500`,
    `colors.${value}`,
    `colors.${dotted}`,
    `colors.${value}-500`,
  ];
  for (const candidate of candidates) {
    const token = byVariable.get(candidate);
    if (token) return token.resolved;
  }

  // A colour utility name such as `bg-red-500`.
  const utilityMatch =
    /^(?:bg|text|border|fill|stroke|ring|from|via|to|decoration|divide|outline|shadow|accent|caret|placeholder)-(.+)$/.exec(
      value,
    );
  if (utilityMatch) {
    const name = utilityMatch[1]!;
    for (const candidate of [
      `--color-${name}`,
      `colors.${name}`,
      `colors.${name.replace(/-/g, ".")}`,
    ]) {
      const token = byVariable.get(candidate);
      if (token) return token.resolved;
    }
  }

  // Fall back to the literal value, which may be a CSS colour.
  return value;
}
