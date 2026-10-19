/**
 * Unit tests for the pure analysis modules.
 *
 * These have no dependency on a Tailwind installation, so they cover the
 * rules themselves rather than the engine integration.
 */

import { describe, expect, it } from "vitest";

import { boundedLevenshtein, suggestClosest, suggestForCandidate } from "../src/core/fuzzy.js";
import { contrastRatio, parseColor, relativeLuminance } from "../src/core/color.js";
import {
  affectedProperties,
  detectConflicts,
  propertyClaims,
  type ClassProperties,
} from "../src/tailwind/conflicts.js";
import { findMigration, RENAMED_UTILITIES, REMOVED_UTILITIES } from "../src/tailwind/migration.js";
import { splitCandidates } from "../src/mcp/diagnostics.js";

describe("fuzzy", () => {
  it("computes the edit distance", () => {
    expect(boundedLevenshtein("kitten", "sitting", 10)).toBe(3);
    expect(boundedLevenshtein("same", "same", 10)).toBe(0);
    expect(boundedLevenshtein("", "abc", 10)).toBe(3);
  });

  it("gives up beyond the limit", () => {
    expect(boundedLevenshtein("a", "bbbbbbbb", 2)).toBe(3);
  });

  it("finds the closest class names", () => {
    const classes = ["bg-red-500", "bg-red-50", "bg-blue-500", "text-red-500"];
    const result = suggestClosest("bg-red-501", classes);
    expect(result[0]?.class).toBe("bg-red-500");
    expect(result[0]?.distance).toBe(1);
  });

  it("prefers a same-length candidate over a shorter one", () => {
    const classes = ["bg-red-500", "bg-red-50"];
    const result = suggestClosest("bg-red-501", classes);
    // Both are one edit away, but "bg-red-500" has the same length, so it
    // was reached by substituting a character rather than deleting one.
    expect(result.map((entry) => entry.class)).toEqual(["bg-red-500", "bg-red-50"]);
  });

  it("respects the limit", () => {
    const classes = ["aa1", "aa2", "aa3", "aa4"];
    expect(suggestClosest("aa9", classes, { limit: 2 })).toHaveLength(2);
  });

  it("keeps the variant prefix when suggesting", () => {
    const classes = ["bg-red-500", "bg-blue-500"];
    const result = suggestForCandidate("md:hover:bg-red-501", classes);
    expect(result[0]?.class).toBe("md:hover:bg-red-500");
  });

  it("suggests a corrected variant", () => {
    const classes = ["bg-red-500", "hover:bg-red-500"];
    const result = suggestForCandidate("hovr:bg-red-500", classes);
    expect(result[0]?.class).toBe("hover:bg-red-500");
  });

  it("suggests the shades of a scale", () => {
    const classes = ["bg-brand-500", "bg-brand-600", "bg-black"];
    const result = suggestForCandidate("bg-brand", classes);
    expect(result[0]?.class).toBe("bg-brand-500");
    expect(result.map((entry) => entry.class)).toContain("bg-brand-600");
  });
});

describe("colour", () => {
  it("parses hex colours", () => {
    expect(parseColor("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor("#ef4444")?.r).toBeCloseTo(239 / 255, 5);
    expect(parseColor("#00000080")?.a).toBeCloseTo(128 / 255, 5);
  });

  it("parses rgb colours", () => {
    expect(parseColor("rgb(255, 0, 0)")?.g).toBe(0);
    expect(parseColor("rgba(0, 0, 0, 0.5)")?.a).toBe(0.5);
  });

  it("parses hsl colours", () => {
    expect(parseColor("hsl(0, 100%, 50%)")?.r).toBeCloseTo(1, 5);
  });

  it("parses oklch colours", () => {
    const color = parseColor("oklch(63.7% 0.237 25.331)");
    expect(color).toBeTruthy();
    // Tailwind v4's red-500 renders as #fb2c36.
    expect(Math.round(color!.r * 255)).toBe(251);
    expect(Math.round(color!.g * 255)).toBe(44);
    expect(Math.round(color!.b * 255)).toBe(54);
  });

  it("returns null for unsupported input", () => {
    expect(parseColor("not-a-color")).toBeNull();
    expect(parseColor("")).toBeNull();
  });

  it("computes the WCAG ratio for black on white", () => {
    const result = contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 1, g: 1, b: 1, a: 1 });
    expect(result.ratio).toBe(21);
    expect(result.aaa).toBe(true);
  });

  it("computes the WCAG ratio for white on red-500", () => {
    const red = parseColor("oklch(63.7% 0.237 25.331)")!;
    const result = contrastRatio({ r: 1, g: 1, b: 1, a: 1 }, red);
    // White on Tailwind's red-500 does not reach AA for normal text.
    expect(result.ratio).toBeGreaterThan(3);
    expect(result.ratio).toBeLessThan(4.5);
    expect(result.aa).toBe(false);
    expect(result.aaLarge).toBe(true);
  });

  it("composites a translucent foreground over the background", () => {
    const result = contrastRatio({ r: 0, g: 0, b: 0, a: 0 }, { r: 1, g: 1, b: 1, a: 1 });
    expect(result.ratio).toBe(1);
  });

  it("computes relative luminance", () => {
    expect(relativeLuminance({ r: 1, g: 1, b: 1, a: 1 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBeCloseTo(0, 5);
  });
});

describe("conflicts", () => {
  const entry = (
    candidate: string,
    properties: string[],
    order: number,
    values: Record<string, string> = {},
  ): ClassProperties => ({ candidate, properties, order, values });

  it("expands shorthands", () => {
    expect(affectedProperties("padding")).toContain("padding-left");
    expect(affectedProperties("margin")).toContain("margin-top");
    expect(affectedProperties("color")).toEqual(["color"]);
  });

  it("detects a conflict and names the winner", () => {
    const conflicts = detectConflicts([
      entry("p-2", ["padding"], 0, { padding: "2" }),
      entry("p-4", ["padding"], 1, { padding: "4" }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.winner).toBe("p-4");
    expect(conflicts[0]?.loser).toBe("p-2");
  });

  it("ignores classes that set different properties", () => {
    const conflicts = detectConflicts([entry("p-4", ["padding"], 0), entry("m-2", ["margin"], 1)]);
    expect(conflicts).toHaveLength(0);
  });

  it("never reports a class as conflicting with itself", () => {
    const conflicts = detectConflicts([entry("p-4", ["padding"], 0), entry("p-4", ["padding"], 0)]);
    expect(conflicts).toHaveLength(0);
  });

  it("reports a shorthand against a longhand it contains", () => {
    const conflicts = detectConflicts([
      entry("p-4", ["padding"], 0),
      entry("pl-2", ["padding-left"], 1),
    ]);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((c) => c.property === "padding-left")).toBe(true);
  });

  it("ignores Tailwind's internal custom properties", () => {
    const conflicts = detectConflicts([
      entry("bg-red-500", ["--tw-bg-opacity", "background-color"], 0),
      entry("bg-blue-500", ["--tw-bg-opacity", "background-color"], 1),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.property).toBe("background-color");
  });

  it("groups claims by property", () => {
    const claims = propertyClaims([
      entry("text-sm", ["font-size"], 3),
      entry("text-lg", ["font-size"], 2),
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.winner).toBe("text-sm");
    expect(claims[0]?.overridden).toEqual(["text-lg"]);
  });
});

describe("migration", () => {
  it("maps a removed utility to its replacement", () => {
    const finding = findMigration("bg-opacity-50", false);
    expect(finding?.kind).toBe("removed");
    expect(finding?.replacement).toBe("bg-black/50");
  });

  it("maps a renamed utility", () => {
    const finding = findMigration("overflow-ellipsis", false);
    expect(finding?.replacement).toBe("text-ellipsis");
  });

  it("flags a scale rename whose meaning changed", () => {
    const finding = findMigration("shadow-sm", true);
    expect(finding?.kind).toBe("meaning-changed");
    expect(finding?.replacement).toBe("shadow-xs");
  });

  it("keeps the variant prefix", () => {
    const finding = findMigration("md:hover:overflow-ellipsis", false);
    expect(finding?.replacement).toBe("md:hover:text-ellipsis");
  });

  it("leaves unrelated classes alone", () => {
    expect(findMigration("p-4", false)).toBeNull();
  });

  it("has a non-empty table", () => {
    expect(RENAMED_UTILITIES.length).toBeGreaterThan(10);
    expect(REMOVED_UTILITIES.length).toBeGreaterThan(3);
  });
});

describe("splitCandidates", () => {
  it("splits a class attribute into single classes", () => {
    expect(splitCandidates(["p-4 flex items-center"])).toEqual(["p-4", "flex", "items-center"]);
  });

  it("removes duplicates", () => {
    expect(splitCandidates(["p-4 p-4"])).toEqual(["p-4"]);
  });

  it("ignores extra whitespace", () => {
    expect(splitCandidates(["  p-4   flex  "])).toEqual(["p-4", "flex"]);
  });
});
