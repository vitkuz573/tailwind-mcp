/**
 * Conflict detection.
 *
 * When two classes set the same CSS property, the one that appears later in
 * the generated stylesheet wins. Tailwind decides that order itself, so the
 * winner is determined by Tailwind's class order rather than by guessing.
 *
 * The rule is: a class with a higher class order is emitted later and
 * therefore wins.
 */

/** A property set by a class, and the class that won it. */
export interface PropertyClaim {
  /** The CSS property, e.g. `padding`. */
  readonly property: string;
  /** The class that wins for this property. */
  readonly winner: string;
  /** Classes that set the same property but lose. */
  readonly overridden: readonly string[];
  /** The value the winner produces. */
  readonly value?: string;
}

/** A conflict between classes in the same list. */
export interface Conflict {
  /** The CSS property both classes set. */
  readonly property: string;
  /** The class that wins. */
  readonly winner: string;
  /** The class that is overridden. */
  readonly loser: string;
  /** The value the winner produces. */
  readonly winnerValue?: string;
  /** The value the loser would have produced. */
  readonly loserValue?: string;
}

/** What a single class sets. */
export interface ClassProperties {
  readonly candidate: string;
  /** CSS properties the class sets, in order. */
  readonly properties: readonly string[];
  /** The class's value in Tailwind's order; higher wins. */
  readonly order: number | null;
  /** The declaration values, keyed by property. */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Properties that are set by a shorthand and therefore also affect the
 * longhand properties.
 *
 * `p-4` sets `padding`, which also overrides `padding-left` and friends.
 * Without this, `p-4` and `pl-2` would not be reported as conflicting even
 * though one of them silently wins.
 */
const SHORTHAND_EXPANSION: Readonly<Record<string, readonly string[]>> = {
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  "padding-inline": ["padding-left", "padding-right"],
  "padding-block": ["padding-top", "padding-bottom"],
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  "margin-inline": ["margin-left", "margin-right"],
  "margin-block": ["margin-top", "margin-bottom"],
  inset: ["top", "right", "bottom", "left"],
  "inset-inline": ["left", "right"],
  "inset-block": ["top", "bottom"],
  border: ["border-width", "border-style", "border-color"],
  "border-width": [
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
  ],
  "border-color": [
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
  ],
  "border-style": [
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
  ],
  "border-radius": [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
  ],
  overflow: ["overflow-x", "overflow-y"],
  overscroll: ["overscroll-x", "overscroll-y"],
  "scroll-margin": [
    "scroll-margin-top",
    "scroll-margin-right",
    "scroll-margin-bottom",
    "scroll-margin-left",
  ],
  "scroll-padding": [
    "scroll-padding-top",
    "scroll-padding-right",
    "scroll-padding-bottom",
    "scroll-padding-left",
  ],
  "font-variant-numeric": ["font-variant-numeric"],
  gap: ["gap-x", "gap-y"],
  place: ["place-items", "place-self", "place-content"],
  "text-decoration": [
    "text-decoration-line",
    "text-decoration-color",
    "text-decoration-style",
    "text-decoration-thickness",
  ],
  transition: ["transition-property"],
  "transition-color": ["transition-property"],
};

/**
 * Every concrete property a class affects.
 *
 * A shorthand contributes both itself and the longhands it expands to.
 */
export function affectedProperties(property: string): readonly string[] {
  const expansion = SHORTHAND_EXPANSION[property];
  return expansion ? [property, ...expansion] : [property];
}

/**
 * Whether a property is a real CSS property.
 *
 * Tailwind sets internal custom properties such as `--tw-bg-opacity` next to
 * the actual declaration. They are implementation details of one utility and
 * never conflict with each other in a way a user cares about.
 */
function isRealProperty(property: string): boolean {
  return !property.startsWith("--tw-");
}

/**
 * Find the conflicts in a set of classes.
 *
 * Two classes conflict when they affect a common property. The winner is the
 * class with the higher Tailwind order, because that is the one Tailwind
 * emits later in the stylesheet — and later wins at equal specificity.
 *
 * A shorthand conflicts with a longhand it contains: `p-4` sets `padding`,
 * which also sets `padding-left`, so `pl-2` and `p-4` fight over the left
 * side. The conflict is reported on the longhand, because that is where the
 * two actually overlap.
 */
export function detectConflicts(classes: readonly ClassProperties[]): Conflict[] {
  // Map every affected property to the classes that claim it.
  const claims = new Map<string, ClassProperties[]>();
  for (const entry of classes) {
    for (const property of entry.properties) {
      if (!isRealProperty(property)) continue;
      for (const affected of affectedProperties(property)) {
        const existing = claims.get(affected);
        if (existing) existing.push(entry);
        else claims.set(affected, [entry]);
      }
    }
  }

  // A pair of classes may overlap on several properties — `p-4` and `p-2`
  // overlap on `padding` and on each of its longhands. The pair is reported
  // once, on the most specific property both of them set.
  const pairs = new Map<
    string,
    { winner: ClassProperties; loser: ClassProperties; property: string }
  >();

  for (const [property, claimants] of claims) {
    if (claimants.length < 2) continue;

    // Sort by Tailwind's order; a higher order is emitted later and wins.
    const sorted = [...claimants].sort((a, b) => {
      if (a.order === b.order) return a.candidate.localeCompare(b.candidate);
      if (a.order === null) return 1;
      if (b.order === null) return -1;
      return a.order - b.order;
    });

    const winner = sorted[sorted.length - 1]!;
    for (const loser of sorted.slice(0, -1)) {
      // A class never conflicts with itself.
      if (winner.candidate === loser.candidate) continue;

      // Both must actually set the property, either directly or through a
      // shorthand that contains it.
      if (!setsProperty(winner, property)) continue;
      if (!setsProperty(loser, property)) continue;

      const key = `${winner.candidate}|${loser.candidate}`;
      const existing = pairs.get(key);
      if (existing) {
        // Prefer the more specific property: a longhand over a shorthand.
        if (existing.property.includes("-") && !property.includes("-")) continue;
        existing.property = property;
        continue;
      }
      pairs.set(key, { winner, loser, property });
    }
  }

  return [...pairs.values()].map(({ winner, loser, property }) => ({
    property,
    winner: winner.candidate,
    loser: loser.candidate,
    ...(winner.values[property] !== undefined ? { winnerValue: winner.values[property] } : {}),
    ...(loser.values[property] !== undefined ? { loserValue: loser.values[property] } : {}),
  }));
}

/**
 * Whether a class sets a property, directly or through a shorthand.
 */
function setsProperty(entry: ClassProperties, property: string): boolean {
  for (const own of entry.properties) {
    if (own === property) return true;
    if (affectedProperties(own).includes(property)) return true;
  }
  return false;
}

/**
 * Group classes by the properties they set, keeping the winner of each group.
 */
export function propertyClaims(classes: readonly ClassProperties[]): PropertyClaim[] {
  const claims = new Map<string, ClassProperties[]>();
  for (const entry of classes) {
    for (const property of entry.properties) {
      const existing = claims.get(property);
      if (existing) existing.push(entry);
      else claims.set(property, [entry]);
    }
  }

  const result: PropertyClaim[] = [];
  for (const [property, claimants] of claims) {
    if (claimants.length < 2) continue;
    const sorted = [...claimants].sort((a, b) => {
      if (a.order === b.order) return a.candidate.localeCompare(b.candidate);
      if (a.order === null) return 1;
      if (b.order === null) return -1;
      return a.order - b.order;
    });
    const winner = sorted[sorted.length - 1]!;
    result.push({
      property,
      winner: winner.candidate,
      overridden: sorted.slice(0, -1).map((entry) => entry.candidate),
      ...(winner.values[property] !== undefined ? { value: winner.values[property] } : {}),
    });
  }
  return result.sort((a, b) => a.property.localeCompare(b.property));
}
