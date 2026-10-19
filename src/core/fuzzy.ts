/**
 * Fuzzy matching for typo suggestions.
 *
 * When a class is rejected, the useful answer is not "invalid" but "did you
 * mean". This module finds the closest real class names using a bounded
 * Levenshtein distance.
 *
 * The class list of a real project holds more than twenty thousand entries, so
 * two things keep this fast:
 *
 * - a length pre-filter rejects candidates that cannot possibly be close,
 * - the distance itself is computed with a banded matrix, so the cost is
 *   proportional to the distance limit rather than to the string lengths.
 */

export interface Suggestion {
  /** The real class name. */
  readonly class: string;
  /** Edit distance from the rejected input. */
  readonly distance: number;
}

export interface SuggestionOptions {
  /** Maximum edit distance to consider. Defaults to 3. */
  readonly maxDistance?: number;
  /** Maximum number of suggestions to return. Defaults to 5. */
  readonly limit?: number;
}

/**
 * Levenshtein distance, abandoned as soon as it exceeds `maxDistance`.
 *
 * @returns the distance, or `maxDistance + 1` when the strings are farther apart
 */
export function boundedLevenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  const m = a.length;
  const n = b.length;
  let previous = new Array<number>(n + 1);
  let current = new Array<number>(n + 1);

  for (let j = 0; j <= n; j += 1) previous[j] = j;

  for (let i = 1; i <= m; i += 1) {
    current[0] = i;
    let best = i;
    const from = Math.max(1, i - maxDistance);
    const to = Math.min(n, i + maxDistance);

    for (let j = 1; j <= n; j += 1) {
      if (j < from || j > to) {
        current[j] = maxDistance + 1;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current[j] = value;
      if (value < best) best = value;
    }

    if (best > maxDistance) return maxDistance + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[n]!;
}

/**
 * Find the class names closest to `input`.
 *
 * Results are ordered by distance. Ties are broken by length, because a
 * candidate of the same length was reached by substituting a character while
 * a shorter one was reached by deleting one — and a mistyped character is the
 * far more common mistake. The remaining ties are broken alphabetically so
 * the output is deterministic.
 */
export function suggestClosest(
  input: string,
  candidates: readonly string[],
  options: SuggestionOptions = {},
): Suggestion[] {
  const maxDistance = options.maxDistance ?? 3;
  const limit = options.limit ?? 5;
  if (input.length === 0 || candidates.length === 0) return [];

  const matches: Suggestion[] = [];
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - input.length) > maxDistance) continue;
    const distance = boundedLevenshtein(input, candidate, maxDistance);
    if (distance <= maxDistance) matches.push({ class: candidate, distance });
  }

  matches.sort(
    (a, b) =>
      a.distance - b.distance ||
      Math.abs(a.class.length - input.length) - Math.abs(b.class.length - input.length) ||
      a.class.localeCompare(b.class),
  );
  return matches.slice(0, limit);
}

/**
 * Suggest a class for a rejected candidate.
 *
 * A candidate may carry variants (`md:hover:bg-red-501`). The mistake can be
 * in either part, so both are considered:
 *
 * - when the utility is real and the variant is not, the variant is corrected,
 * - otherwise the utility is corrected and the variant is kept.
 */
export function suggestForCandidate(
  candidate: string,
  classList: readonly string[],
  options: SuggestionOptions = {},
): Suggestion[] {
  const maxDistance = options.maxDistance ?? 3;
  const limit = options.limit ?? 5;

  const separator = candidate.lastIndexOf(":");
  const hasVariant = separator > 0;
  const prefix = hasVariant ? candidate.slice(0, separator + 1) : "";
  const utility = hasVariant ? candidate.slice(separator + 1) : candidate;

  // The utility is fine but the variant is not: correct the variant.
  if (hasVariant) {
    const known = new Set(classList);
    if (known.has(utility)) {
      const variant = prefix.slice(0, -1);
      const corrected = suggestClosest(variant, VARIANT_NAMES, {
        maxDistance: 1,
        limit: 1,
      });
      if (corrected.length > 0) {
        return [{ class: corrected[0]!.class + ":" + utility, distance: 1 }];
      }
    }
  }

  const byDistance = suggestClosest(utility, classList, options).map((suggestion) => ({
    class: prefix + suggestion.class,
    distance: suggestion.distance,
  }));

  // A scale needs its shade: `bg-brand` is not a class, but `bg-brand-500` is.
  // Such a candidate is a prefix of real classes, which the edit distance
  // would rank far below a near-miss on an unrelated class.
  const byScale = suggestScale(utility, classList, limit).map((entry) => ({
    class: prefix + entry,
    distance: 1,
  }));

  const seen = new Set(byDistance.map((entry) => entry.class));
  const merged = [...byScale.filter((entry) => !seen.has(entry.class)), ...byDistance];

  // The scale suggestions are the most precise, so they come first.
  merged.sort((a, b) => a.distance - b.distance || a.class.length - b.class.length);
  return merged.slice(0, limit);
}

/**
 * Find the classes that extend a candidate with a scale value.
 *
 * `bg-brand` yields `bg-brand-500` and `bg-brand-600` when the project
 * defines that colour scale.
 */
function suggestScale(utility: string, classList: readonly string[], limit: number): string[] {
  const matches: string[] = [];
  for (const candidate of classList) {
    if (!candidate.startsWith(utility + "-")) continue;
    const rest = candidate.slice(utility.length + 1);
    // Only a plain scale value qualifies, not another utility.
    if (!/^[a-z0-9]+$/.test(rest)) continue;
    matches.push(candidate);
    if (matches.length >= limit) break;
  }
  return matches;
}

/**
 * Variant names that are common enough to be worth correcting towards.
 *
 * The full list is available from the engine, but for a spelling suggestion
 * only the widely used ones matter; a rare variant is better corrected by
 * the model itself.
 */
const VARIANT_NAMES: readonly string[] = [
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "visited",
  "target",
  "disabled",
  "enabled",
  "checked",
  "first",
  "last",
  "odd",
  "even",
  "first-of-type",
  "last-of-type",
  "only-of-type",
  "empty",
  "group",
  "peer",
  "dark",
  "motion-safe",
  "motion-reduce",
  "portrait",
  "landscape",
  "ltr",
  "rtl",
  "print",
  "open",
  "indeterminate",
  "default",
  "required",
  "valid",
  "invalid",
  "in-range",
  "out-of-range",
  "read-only",
  "placeholder-shown",
  "autofill",
  "before",
  "after",
  "file",
  "marker",
  "selection",
  "first-letter",
  "first-line",
  "backdrop",
  "details-content",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
  "max-sm",
  "max-md",
  "max-lg",
  "max-xl",
  "max-2xl",
  "min-sm",
  "min-md",
  "min-lg",
  "min-xl",
  "min-2xl",
];
