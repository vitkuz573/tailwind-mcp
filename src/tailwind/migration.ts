/**
 * Migration data from Tailwind CSS v3 to v4.
 *
 * The table mirrors the official upgrade guide
 * (https://tailwindcss.com/docs/upgrade-guide). Entries are applied only when
 * the class would otherwise be rejected or would silently change meaning.
 */

/** A v3 class and its v4 replacement. */
export interface RenamedUtility {
  readonly v3: string;
  readonly v4: string;
  /** Why the rename happened, shown to the model. */
  readonly note: string;
}

/**
 * Utilities removed in v4, with their modern replacement.
 *
 * Unlike renames, these have no v4 equivalent at all: using them in a v4
 * project silently does nothing.
 */
export interface RemovedUtility {
  readonly v3: string;
  readonly replacement: string;
  readonly note: string;
}

/**
 * Utilities that were renamed, or whose meaning changed because the whole
 * scale was shifted.
 *
 * The scale renames are the dangerous ones: `shadow-sm` still exists in v4 but
 * means what `shadow-xs` meant in v3, so old code keeps compiling and quietly
 * looks different.
 */
export const RENAMED_UTILITIES: readonly RenamedUtility[] = [
  { v3: "overflow-ellipsis", v4: "text-ellipsis", note: "Moved to the text utilities." },
  { v3: "flex-shrink-*", v4: "shrink-*", note: "Renamed to the grow/shrink utilities." },
  { v3: "flex-grow-*", v4: "grow-*", note: "Renamed to the grow/shrink utilities." },
  {
    v3: "decoration-slice",
    v4: "box-decoration-slice",
    note: "Renamed to box-decoration utilities.",
  },
  {
    v3: "decoration-clone",
    v4: "box-decoration-clone",
    note: "Renamed to box-decoration utilities.",
  },
  {
    v3: "shadow-sm",
    v4: "shadow-xs",
    note: "The shadow scale was shifted; old value is now shadow-xs.",
  },
  {
    v3: "shadow",
    v4: "shadow-sm",
    note: "The shadow scale was shifted; old value is now shadow-sm.",
  },
  { v3: "drop-shadow-sm", v4: "drop-shadow-xs", note: "The drop-shadow scale was shifted." },
  { v3: "drop-shadow", v4: "drop-shadow-sm", note: "The drop-shadow scale was shifted." },
  { v3: "blur-sm", v4: "blur-xs", note: "The blur scale was shifted." },
  { v3: "blur", v4: "blur-sm", note: "The blur scale was shifted." },
  { v3: "backdrop-blur-sm", v4: "backdrop-blur-xs", note: "The backdrop-blur scale was shifted." },
  { v3: "backdrop-blur", v4: "backdrop-blur-sm", note: "The backdrop-blur scale was shifted." },
  { v3: "rounded-sm", v4: "rounded-xs", note: "The radius scale was shifted." },
  { v3: "rounded", v4: "rounded-sm", note: "The radius scale was shifted." },
  {
    v3: "outline-none",
    v4: "outline-hidden",
    note: "outline-none now really removes the outline style.",
  },
  { v3: "ring", v4: "ring-3", note: "The default ring width changed from 3px to 1px." },
  { v3: "break-words", v4: "wrap-break-word", note: "Renamed to the wrap utilities." },
  { v3: "order-none", v4: "order-0", note: "The order scale was renumbered." },
];

/** Utilities that were removed in v4 and no longer do anything. */
export const REMOVED_UTILITIES: readonly RemovedUtility[] = [
  { v3: "bg-opacity-*", replacement: "bg-black/50", note: "Use the opacity modifier." },
  { v3: "text-opacity-*", replacement: "text-black/50", note: "Use the opacity modifier." },
  { v3: "border-opacity-*", replacement: "border-black/50", note: "Use the opacity modifier." },
  { v3: "divide-opacity-*", replacement: "divide-black/50", note: "Use the opacity modifier." },
  { v3: "ring-opacity-*", replacement: "ring-black/50", note: "Use the opacity modifier." },
  {
    v3: "placeholder-opacity-*",
    replacement: "placeholder-black/50",
    note: "Use the opacity modifier.",
  },
];

/**
 * A migration finding for one class.
 */
export interface MigrationFinding {
  /** The class as it was written. */
  readonly candidate: string;
  /** The class to use instead. */
  readonly replacement: string;
  /** What kind of change this is. */
  readonly kind: "renamed" | "removed" | "meaning-changed";
  /** Explanation of the change. */
  readonly note: string;
}

/**
 * Find the v4 replacement for a class written the v3 way.
 *
 * @param candidate the class as written
 * @param existsInV4 whether the class still exists in the v4 project
 */
export function findMigration(candidate: string, existsInV4: boolean): MigrationFinding | null {
  const separator = candidate.lastIndexOf(":");
  const prefix = separator > 0 ? candidate.slice(0, separator + 1) : "";
  const utility = separator > 0 ? candidate.slice(separator + 1) : candidate;

  for (const removed of REMOVED_UTILITIES) {
    if (matchesPattern(utility, removed.v3)) {
      const value = extractValue(utility, removed.v3);
      return {
        candidate,
        replacement: prefix + removed.replacement.replace("*", value),
        kind: "removed",
        note: removed.note,
      };
    }
  }

  for (const renamed of RENAMED_UTILITIES) {
    if (!matchesPattern(utility, renamed.v3)) continue;

    const value = extractValue(utility, renamed.v3);
    const replacement = renamed.v4.replace("*", value);

    if (existsInV4) {
      // The class still exists in v4, but it now means something else.
      return {
        candidate,
        replacement: prefix + replacement,
        kind: "meaning-changed",
        note: renamed.note,
      };
    }
    return {
      candidate,
      replacement: prefix + replacement,
      kind: "renamed",
      note: renamed.note,
    };
  }

  return null;
}

/**
 * Match a utility against a pattern that may end in `*`.
 *
 * `bg-opacity-*` matches `bg-opacity-50`.
 */
function matchesPattern(utility: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const stem = pattern.slice(0, -1);
    return utility.startsWith(stem) && utility.length > stem.length;
  }
  return utility === pattern;
}

/** The value part of `bg-opacity-50` for the pattern `bg-opacity-*`. */
function extractValue(utility: string, pattern: string): string {
  if (!pattern.endsWith("*")) return "";
  const stem = pattern.slice(0, -1);
  return utility.slice(stem.length);
}
