/**
 * Canonicalisation of utility classes.
 *
 * Two things are canonicalised:
 *
 * - an arbitrary value that happens to equal a theme token, such as
 *   `mt-[16px]` where the spacing scale makes `16px` equal to `mt-4`,
 * - a v3 spelling that v4 renamed, such as `overflow-ellipsis`.
 *
 * Tailwind's own canonicalizer can do this, but it builds an index of every
 * class the first time it runs, which takes seconds and blocks the event loop.
 * The rules are simple enough to implement here, against the project's own
 * theme, which keeps the server responsive.
 */

import { RENAMED_UTILITIES, REMOVED_UTILITIES } from "./migration.js";
import type { ThemeToken } from "../core/types.js";

/** A theme value that can be matched against an arbitrary value. */
interface Scale {
  /** The token name without the namespace prefix, e.g. `sm`. */
  readonly name: string;
  /** The namespace the token came from, e.g. `text` or `radius`. */
  readonly namespace: string;
  /** The value in rem, or undefined when the value is not a length. */
  readonly rem: number | undefined;
}

/** The utility prefixes that take a spacing value. */
const SPACING_UTILITIES = [
  "p",
  "px",
  "py",
  "pt",
  "pr",
  "pb",
  "pl",
  "m",
  "mx",
  "my",
  "mt",
  "mr",
  "mb",
  "ml",
  "gap",
  "gap-x",
  "gap-y",
  "space-x",
  "space-y",
  "w",
  "h",
  "size",
  "min-w",
  "min-h",
  "max-w",
  "max-h",
  "scroll-m",
  "scroll-p",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "translate-x",
  "translate-y",
];

/** Root font size in pixels, matching the browser default. */
const ROOT_FONT_SIZE = 16;

/**
 * Build the scales a value can be matched against.
 *
 * The spacing scale in v4 is a single multiplier (`--spacing: 0.25rem`), so
 * every integer multiple of it is a valid spacing token. The other namespaces
 * are enumerated from the theme.
 */
export function buildScales(theme: readonly ThemeToken[]): {
  spacing: number | undefined;
  named: Scale[];
} {
  let spacing: number | undefined;

  const named: Scale[] = [];
  for (const token of theme) {
    // `--spacing` is the multiplier itself, without a name.
    if (token.variable === "--spacing") {
      spacing = parseRem(token.value);
      continue;
    }

    // `--text-sm` is the name `sm` in the namespace `text`.
    const match = /^--([a-z][a-z0-9]*)-(.+)$/.exec(token.variable);
    if (!match) continue;
    const namespace = match[1]!;
    const name = match[2]!;

    // Only length-like namespaces can be matched against a length.
    if (!["text", "radius", "breakpoint", "container"].includes(namespace)) continue;
    const rem = parseRem(token.value);
    if (rem === undefined) continue;
    named.push({ name, namespace, rem });
  }

  return { spacing, named };
}

/**
 * Parse a CSS length into rem.
 *
 * @returns the value in rem, or undefined when it is not a length
 */
function parseRem(value: string): number | undefined {
  const trimmed = value.trim();

  const rem = /^(-?[\d.]+)rem$/.exec(trimmed);
  if (rem) {
    const parsed = Number.parseFloat(rem[1]!);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const px = /^(-?[\d.]+)px$/.exec(trimmed);
  if (px) {
    const parsed = Number.parseFloat(px[1]!);
    return Number.isFinite(parsed) ? parsed / ROOT_FONT_SIZE : undefined;
  }

  const em = /^(-?[\d.]+)em$/.exec(trimmed);
  if (em) {
    const parsed = Number.parseFloat(em[1]!);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

/**
 * An arbitrary value written in a class, e.g. `[16px]` in `mt-[16px]`.
 */
interface ArbitraryValue {
  /** The value as written, without the brackets. */
  readonly raw: string;
  /** The value in rem, when it is a length. */
  readonly rem: number | undefined;
}

/** Extract the arbitrary value from a candidate, if it has one. */
function arbitraryValue(candidate: string): ArbitraryValue | null {
  const open = candidate.lastIndexOf("[");
  if (open === -1) return null;
  const close = candidate.indexOf("]", open);
  if (close === -1) return null;

  const raw = candidate.slice(open + 1, close);
  // A modifier follows the value, as in `bg-red-500/50`.
  const withoutModifier = raw.split("/")[0]!;
  return { raw: withoutModifier, rem: parseRem(withoutModifier) };
}

/**
 * Rewrite a candidate into its canonical form.
 *
 * @param candidate the class as written
 * @param theme the project's theme, used to resolve arbitrary values
 * @returns the canonical spelling, which may equal the input
 */
export function canonicalizeCandidate(
  candidate: string,
  theme: readonly ThemeToken[],
  scales: { spacing: number | undefined; named: Scale[] },
): string {
  const separator = candidate.lastIndexOf(":");
  const prefix = separator > 0 ? candidate.slice(0, separator + 1) : "";
  const utility = separator > 0 ? candidate.slice(separator + 1) : candidate;

  // A v3 spelling that v4 renamed.
  const renamed = renameUtility(utility);
  if (renamed) return prefix + renamed;

  // An arbitrary value that equals a theme token.
  const arbitrary = arbitraryValue(utility);
  if (arbitrary && arbitrary.rem !== undefined) {
    const replacement = matchScale(utility, arbitrary.rem, scales);
    if (replacement) return prefix + replacement;
  }

  return candidate;
}

/**
 * Find the token that expresses the given value.
 *
 * @returns the replacement utility, or null when the value has no token
 */
function matchScale(
  utility: string,
  rem: number,
  scales: { spacing: number | undefined; named: Scale[] },
): string | null {
  const open = utility.lastIndexOf("[");
  const stem = utility.slice(0, open);
  const close = utility.indexOf("]", open);
  const modifier = close === -1 ? "" : utility.slice(close + 1);
  const suffix = modifier.startsWith("/") ? modifier : "";

  // The spacing multiplier: `mt-[16px]` becomes `mt-4`. Only the utilities
  // that take a spacing value qualify; `text-[16px]` is a font size.
  if (scales.spacing !== undefined && scales.spacing > 0 && takesSpacing(stem)) {
    const steps = rem / scales.spacing;
    if (Number.isInteger(steps) && steps > 0) {
      return `${stem}${steps}${suffix}`;
    }
  }

  // A named token, such as `text-[14px]` becoming `text-sm`. The namespace
  // has to match the utility, so a font size is not replaced by a radius.
  const namespace = namespaceOf(stem);
  for (const scale of scales.named) {
    if (scale.namespace !== namespace) continue;
    if (scale.rem === undefined) continue;
    if (Math.abs(scale.rem - rem) < 1e-6) {
      return `${stem}${scale.name}${suffix}`;
    }
  }

  return null;
}

/**
 * Whether a utility takes a value from the spacing scale.
 *
 * The stem still carries the trailing dash of the arbitrary value, so it is
 * removed before the lookup.
 */
function takesSpacing(stem: string): boolean {
  const name = stem.replace(/^-/, "").replace(/-$/, "");
  return SPACING_UTILITIES.includes(name);
}

/**
 * The theme namespace a utility draws its value from.
 *
 * `text-sm` draws from `--text-*`, `rounded-sm` from `--radius-*`.
 */
function namespaceOf(stem: string): string {
  const name = stem.replace(/^-/, "").replace(/-$/, "");

  if (name.startsWith("text-") || name === "text") return "text";
  if (name.startsWith("rounded") || name.startsWith("radius")) return "radius";
  if (name.startsWith("min-w") || name.startsWith("max-w")) return "container";
  if (name.startsWith("min-h") || name.startsWith("max-h")) return "container";

  return "spacing";
}

/**
 * Apply the v3-to-v4 renames to a utility.
 *
 * @returns the renamed utility, or null when it needs no rename
 */
function renameUtility(utility: string): string | null {
  const separator = utility.lastIndexOf(":");
  const prefix = separator > 0 ? utility.slice(0, separator + 1) : "";
  const bare = separator > 0 ? utility.slice(separator + 1) : utility;

  for (const renamed of RENAMED_UTILITIES) {
    const value = matchPattern(bare, renamed.v3);
    if (value === null) continue;
    return prefix + renamed.v4.replace("*", value);
  }

  for (const removed of REMOVED_UTILITIES) {
    const value = matchPattern(bare, removed.v3);
    if (value === null) continue;
    // A removed utility has no v4 equivalent; the migration tool reports it.
    return null;
  }

  return null;
}

/**
 * Match a utility against a pattern that may end in `*`.
 *
 * @returns the value part, or null when it does not match
 */
function matchPattern(utility: string, pattern: string): string | null {
  if (pattern.endsWith("*")) {
    const stem = pattern.slice(0, -1);
    if (utility.startsWith(stem) && utility.length > stem.length) {
      return utility.slice(stem.length);
    }
    return null;
  }
  return utility === pattern ? "" : null;
}
