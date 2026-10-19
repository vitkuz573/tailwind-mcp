/**
 * Shared domain types.
 *
 * The server talks to two different Tailwind generations (v3 and v4). Both
 * expose the same three facts we care about — the class list, the theme, and
 * the ability to turn a candidate into CSS — but through completely different
 * APIs. `TailwindEngine` is the seam: every implementation normalises to it,
 * so nothing above this layer knows which generation is in play.
 */

/** A single utility class name, without variants. */
export type UtilityName = string;

/**
 * One entry of the class list.
 *
 * `modifiers` are the colour-space/opacity style suffixes a class accepts
 * (e.g. `bg-red-500/50` has modifier `50`). Empty for classes that take no
 * modifier.
 */
export interface ClassEntry {
  readonly name: UtilityName;
  readonly modifiers: readonly string[];
}

/** A variant such as `hover`, `md` or `dark`. */
export interface VariantEntry {
  readonly name: string;
  readonly values: readonly string[];
  /** True when the variant accepts arbitrary values, e.g. `data-[state=open]`. */
  readonly isArbitrary: boolean;
  /** True when the variant name contains a dash, e.g. `min-[320px]`. */
  readonly hasDash: boolean;
}

/** A design token as defined by the project's theme. */
export interface ThemeToken {
  /** The CSS custom property, e.g. `--color-red-500`. */
  readonly variable: string;
  /** Raw value as written in the theme, e.g. `oklch(63.7% 0.237 25.331)`. */
  readonly value: string;
  /**
   * The resolved value with references substituted where possible.
   * Equals `value` when the token cannot be resolved further.
   */
  readonly resolved: string;
  /** Where the token came from, e.g. `default` or a project CSS file path. */
  readonly source?: string;
}

/** Result of compiling a single candidate class. */
export interface CompiledClass {
  /** The candidate exactly as it was handed in, e.g. `md:hover:bg-red-500`. */
  readonly candidate: string;
  /** False when Tailwind produced no rule for this candidate. */
  readonly valid: boolean;
  /** Generated CSS rule, empty when the candidate is invalid. */
  readonly css: string;
  /**
   * Reason the candidate was rejected. Tailwind does not always explain
   * itself, so this may be a generic message.
   */
  readonly reason?: string;
}

/**
 * The abstraction every Tailwind generation is adapted to.
 *
 * Implementations are expected to be lazy: constructing the engine must not
 * read the filesystem, and the underlying design system is built on first use.
 */
export interface TailwindEngine {
  /** Which Tailwind generation backs this engine. */
  readonly version: 3 | 4;
  /** Human-readable description of where the configuration came from. */
  readonly source: string;
  /** Every utility class the project can use, sorted by name. */
  listClasses(): Promise<readonly ClassEntry[]>;
  /** Every variant the project understands. */
  listVariants(): Promise<readonly VariantEntry[]>;
  /** Design tokens of the project's theme. */
  listTheme(): Promise<readonly ThemeToken[]>;
  /**
   * Turn candidates into CSS.
   *
   * Candidates may carry variants (`md:hover:bg-red-500`) and arbitrary values
   * (`w-[37px]`). Unknown candidates come back as `valid: false` rather than
   * throwing.
   */
  compile(candidates: readonly string[]): Promise<readonly CompiledClass[]>;
  /**
   * Sort candidates into Tailwind's canonical order, which is the order
   * `prettier-plugin-tailwindcss` produces. Useful for producing class lists
   * that match what a human would write.
   */
  canonicalOrder(candidates: readonly string[]): Promise<readonly string[]>;
  /**
   * The CSS properties each candidate sets.
   *
   * This is what makes conflict detection possible: two classes that set the
   * same property fight each other, and the one emitted later in the
   * stylesheet wins.
   */
  describe(candidates: readonly string[]): Promise<readonly CandidateDescription[]>;
  /**
   * Rewrite candidates into Tailwind's canonical form.
   *
   * Arbitrary values that match a theme value are replaced with the utility
   * that expresses them (`mt-[16px]` → `mt-4`), and deprecated v3 spellings
   * are renamed (`overflow-ellipsis` → `text-ellipsis`).
   */
  canonicalize(candidates: readonly string[]): Promise<readonly CanonicalCandidate[]>;
}

/** What a single candidate sets in CSS. */
export interface CandidateDescription {
  /** The candidate as it was handed in. */
  readonly candidate: string;
  /** CSS properties the candidate sets, in order. */
  readonly properties: readonly string[];
  /** The declaration values, keyed by property. */
  readonly values: Readonly<Record<string, string>>;
  /**
   * The candidate's position in Tailwind's class order.
   *
   * A higher number means the class is emitted later in the stylesheet and
   * therefore wins against classes that set the same property.
   */
  readonly order: number | null;
}

/** A candidate in Tailwind's canonical form. */
export interface CanonicalCandidate {
  /** The candidate as it was handed in. */
  readonly candidate: string;
  /** The canonical spelling, which may differ from the input. */
  readonly canonical: string;
  /** True when the canonical form differs from the input. */
  readonly changed: boolean;
}
