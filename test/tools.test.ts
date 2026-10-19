/**
 * Tool tests.
 *
 * The tools are the surface the model sees, so they are tested end to end
 * against a real Tailwind project.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listVariants, readTheme, searchClasses, validateCandidates } from "../src/mcp/tools.js";
import { createEngine } from "../src/tailwind/engine.js";
import { v4Fixture, type Fixture } from "./fixtures.js";

describe("tools", () => {
  let fixture: Fixture;
  let engine: Awaited<ReturnType<typeof createEngine>>["engine"];

  beforeAll(async () => {
    fixture = await v4Fixture();
    ({ engine } = await createEngine(fixture.root));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  describe("validateCandidates", () => {
    it("separates valid from invalid candidates", async () => {
      const result = await validateCandidates(engine, {
        candidates: ["p-4", "bg-red-500", "p-nope", "text-nope"],
      });

      expect(result.data.valid).toEqual(["p-4", "bg-red-500"]);
      expect(result.data.invalid.map((entry) => entry.candidate)).toEqual(["p-nope", "text-nope"]);
      expect(result.data.invalid[0]?.reason).toBeTruthy();
    });

    it("returns the generated CSS for valid candidates", async () => {
      const result = await validateCandidates(engine, { candidates: ["p-4"] });
      expect(result.data.compiled).toHaveLength(1);
      expect(result.data.compiled[0]?.css).toContain("padding");
    });

    it("returns a canonical order", async () => {
      const result = await validateCandidates(engine, {
        candidates: ["text-white", "p-4", "flex"],
      });
      expect(result.data.canonicalOrder).toEqual(["flex", "p-4", "text-white"]);
    });

    it("summarises the outcome", async () => {
      const ok = await validateCandidates(engine, { candidates: ["p-4"] });
      expect(ok.summary).toContain("All 1 candidates are valid");

      const mixed = await validateCandidates(engine, { candidates: ["p-4", "p-nope"] });
      expect(mixed.summary).toContain("1 valid, 1 invalid");
    });
  });

  describe("searchClasses", () => {
    it("finds classes by substring", async () => {
      const result = await searchClasses(engine, { query: "rounded", limit: 50, offset: 0 });
      expect(result.data.matched).toBeGreaterThan(0);
      expect(result.data.classes.every((entry) => entry.name.includes("rounded"))).toBe(true);
    });

    it("finds classes by prefix", async () => {
      const result = await searchClasses(engine, { prefix: "bg-acme", limit: 50, offset: 0 });
      expect(result.data.classes.map((entry) => entry.name)).toContain("bg-acme");
    });

    it("paginates", async () => {
      const first = await searchClasses(engine, { query: "rounded", limit: 2, offset: 0 });
      const second = await searchClasses(engine, { query: "rounded", limit: 2, offset: 2 });
      expect(first.data.classes).toHaveLength(2);
      expect(second.data.classes).toHaveLength(2);
      expect(first.data.classes[0]?.name).not.toBe(second.data.classes[0]?.name);
    });

    it("returns modifiers for color classes", async () => {
      const result = await searchClasses(engine, { prefix: "bg-red-500", limit: 5, offset: 0 });
      const entry = result.data.classes.find((item) => item.name === "bg-red-500");
      expect(entry?.modifiers.length).toBeGreaterThan(0);
    });

    it("returns nothing for a query that matches nothing", async () => {
      const result = await searchClasses(engine, { query: "zzzznotathing", limit: 10, offset: 0 });
      expect(result.data.matched).toBe(0);
      expect(result.data.classes).toHaveLength(0);
    });
  });

  describe("readTheme", () => {
    it("returns theme tokens", async () => {
      const result = await readTheme(engine, { query: "red", limit: 20, offset: 0 });
      expect(result.data.tokens.length).toBeGreaterThan(0);
    });

    it("filters by namespace", async () => {
      const result = await readTheme(engine, { namespace: "breakpoint", limit: 20, offset: 0 });
      expect(result.data.tokens.length).toBeGreaterThan(0);
      for (const token of result.data.tokens) {
        expect(token.variable.startsWith("--breakpoint-")).toBe(true);
      }
    });

    it("includes custom theme values", async () => {
      const result = await readTheme(engine, { query: "acme", limit: 10, offset: 0 });
      expect(result.data.tokens[0]?.variable).toBe("--color-acme");
      expect(result.data.tokens[0]?.value).toBe("#123456");
    });
  });

  describe("listVariants", () => {
    it("lists variants", async () => {
      const result = await listVariants(engine, { limit: 100, offset: 0 });
      const names = result.data.variants.map((variant) => variant.name);
      expect(names).toContain("hover");
      expect(names).toContain("md");
    });

    it("filters by query", async () => {
      const result = await listVariants(engine, { query: "hover", limit: 100, offset: 0 });
      expect(result.data.variants.every((variant) => variant.name.includes("hover"))).toBe(true);
    });
  });
});
