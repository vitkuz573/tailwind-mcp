/**
 * Tests for the canonicalizer.
 *
 * The canonicalizer replaces Tailwind's own, which is far too slow to use in
 * a request path, so these tests pin the behaviour it has to reproduce.
 */

import { describe, expect, it } from "vitest";

import { buildScales, canonicalizeCandidate } from "../src/tailwind/canonicalize.js";
import type { ThemeToken } from "../src/core/types.js";

const theme: ThemeToken[] = [
  { variable: "--spacing", value: "0.25rem", resolved: "0.25rem" },
  { variable: "--text-sm", value: "0.875rem", resolved: "0.875rem" },
  { variable: "--text-base", value: "1rem", resolved: "1rem" },
  { variable: "--text-lg", value: "1.125rem", resolved: "1.125rem" },
  { variable: "--radius-xs", value: "0.125rem", resolved: "0.125rem" },
  { variable: "--radius-sm", value: "0.25rem", resolved: "0.25rem" },
  { variable: "--breakpoint-md", value: "48rem", resolved: "48rem" },
];

const scales = buildScales(theme);
const canonical = (candidate: string): string => canonicalizeCandidate(candidate, theme, scales);

describe("buildScales", () => {
  it("finds the spacing multiplier", () => {
    expect(scales.spacing).toBe(0.25);
  });

  it("keeps namespaces apart", () => {
    const text = scales.named.filter((scale) => scale.namespace === "text");
    const radius = scales.named.filter((scale) => scale.namespace === "radius");
    expect(text.map((scale) => scale.name)).toContain("sm");
    expect(radius.map((scale) => scale.name)).toContain("xs");
  });
});

describe("canonicalizeCandidate", () => {
  it("replaces an arbitrary spacing value with a token", () => {
    expect(canonical("mt-[16px]")).toBe("mt-4");
    expect(canonical("p-[1rem]")).toBe("p-4");
    expect(canonical("gap-[8px]")).toBe("gap-2");
  });

  it("replaces an arbitrary font size with a token", () => {
    expect(canonical("text-[14px]")).toBe("text-sm");
    expect(canonical("text-[16px]")).toBe("text-base");
  });

  it("does not confuse namespaces", () => {
    // 0.25rem is both --radius-sm and four spacing steps; the utility
    // decides which scale applies.
    expect(canonical("rounded-[2px]")).toBe("rounded-xs");
    expect(canonical("p-[4px]")).toBe("p-1");
  });

  it("leaves a value that has no token alone", () => {
    // 37px is not a whole step of the spacing scale.
    expect(canonical("w-[37px]")).toBe("w-[37px]");
  });

  it("leaves a colour alone", () => {
    expect(canonical("bg-[#123456]")).toBe("bg-[#123456]");
  });

  it("renames a v3 spelling", () => {
    expect(canonical("overflow-ellipsis")).toBe("text-ellipsis");
    expect(canonical("flex-shrink-0")).toBe("shrink-0");
  });

  it("keeps the variant prefix", () => {
    expect(canonical("md:hover:mt-[16px]")).toBe("md:hover:mt-4");
    expect(canonical("md:hover:overflow-ellipsis")).toBe("md:hover:text-ellipsis");
  });

  it("leaves a canonical class alone", () => {
    expect(canonical("flex")).toBe("flex");
    expect(canonical("p-4")).toBe("p-4");
  });

  it("keeps a modifier on an arbitrary value", () => {
    expect(canonical("bg-red-500/50")).toBe("bg-red-500/50");
  });
});
