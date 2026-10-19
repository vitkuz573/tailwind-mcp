/**
 * Integration tests for the diagnostic tools.
 *
 * These run against real Tailwind installations, so a passing test means the
 * diagnosis matches what Tailwind itself would do.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canonicalizeClasses,
  checkContrast,
  diagnose,
  findConflicts,
  migrateClasses,
} from "../src/mcp/diagnostics.js";
import { createEngine } from "../src/tailwind/engine.js";
import { v3Fixture, v4Fixture, type Fixture } from "./fixtures.js";

describe("diagnostics on v4", () => {
  let fixture: Fixture;
  let engine: Awaited<ReturnType<typeof createEngine>>["engine"];

  beforeAll(async () => {
    fixture = await v4Fixture();
    ({ engine } = await createEngine(fixture.root));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  describe("diagnose", () => {
    it("reports valid classes as valid", async () => {
      const result = await diagnose(engine, { candidates: ["p-4", "bg-brand"] });
      expect(result.data.valid).toEqual(["p-4", "bg-brand"]);
      expect(result.data.typos).toHaveLength(0);
    });

    it("suggests a correction for a typo", async () => {
      const result = await diagnose(engine, { candidates: ["bg-red-501"] });
      expect(result.data.typos).toHaveLength(1);
      const suggestions = result.data.typos[0]?.suggestions.map((entry) => entry.class) ?? [];
      expect(suggestions).toContain("bg-red-500");
    });

    it("reports an arbitrary value that has a token", async () => {
      const result = await diagnose(engine, { candidates: ["mt-[16px]"] });
      expect(result.data.arbitrary).toHaveLength(1);
      expect(result.data.arbitrary[0]?.canonical).toBe("mt-4");
    });

    it("reports a conflict and names the winner", async () => {
      const result = await diagnose(engine, { candidates: ["p-2", "p-4"] });
      expect(result.data.conflicts).toHaveLength(1);
      expect(result.data.conflicts[0]?.winner).toBe("p-4");
      expect(result.data.conflicts[0]?.loser).toBe("p-2");
    });

    it("splits a class attribute into single classes", async () => {
      const result = await diagnose(engine, { candidates: ["p-4 flex items-center"] });
      expect(result.data.total).toBe(3);
      expect(result.data.valid).toEqual(["p-4", "flex", "items-center"]);
    });

    it("reports nothing for a clean class list", async () => {
      const result = await diagnose(engine, { candidates: ["flex", "items-center", "gap-2"] });
      expect(result.data.typos).toHaveLength(0);
      expect(result.data.arbitrary).toHaveLength(0);
      expect(result.data.conflicts).toHaveLength(0);
    });
  });

  describe("findConflicts", () => {
    it("names the winner by Tailwind's own order", async () => {
      const result = await findConflicts(engine, { candidates: ["p-2", "p-4"] });
      expect(result.data.conflicts).toHaveLength(1);
      expect(result.data.conflicts[0]?.winner).toBe("p-4");
    });

    it("finds no conflict between unrelated properties", async () => {
      const result = await findConflicts(engine, { candidates: ["p-4", "m-2"] });
      expect(result.data.conflicts).toHaveLength(0);
    });

    it("detects that a longhand overrides a shorthand", async () => {
      const result = await findConflicts(engine, { candidates: ["p-4", "pl-2"] });
      expect(result.data.conflicts.length).toBeGreaterThan(0);
      expect(result.data.conflicts.some((c) => c.winner === "pl-2")).toBe(true);
    });
  });

  describe("canonicalizeClasses", () => {
    it("rewrites an arbitrary value into a token", async () => {
      const result = await canonicalizeClasses(engine, { candidates: ["mt-[16px]"] });
      expect(result.data.canonical[0]?.canonical).toBe("mt-4");
      expect(result.data.canonical[0]?.changed).toBe(true);
    });

    it("sorts into Tailwind's canonical order", async () => {
      const result = await canonicalizeClasses(engine, {
        candidates: ["text-white", "p-4", "flex"],
      });
      expect(result.data.ordered).toEqual(["flex", "p-4", "text-white"]);
    });

    it("leaves an already canonical class alone", async () => {
      const result = await canonicalizeClasses(engine, { candidates: ["flex"] });
      expect(result.data.canonical[0]?.changed).toBe(false);
    });
  });

  describe("migrateClasses", () => {
    it("maps a removed utility", async () => {
      const result = await migrateClasses(engine, { candidates: ["bg-opacity-50"] });
      expect(result.data.findings[0]?.replacement).toBe("bg-black/50");
      expect(result.data.findings[0]?.kind).toBe("removed");
    });

    it("flags a scale rename whose meaning changed", async () => {
      const result = await migrateClasses(engine, { candidates: ["shadow-sm"] });
      expect(result.data.findings[0]?.replacement).toBe("shadow-xs");
      expect(result.data.findings[0]?.kind).toBe("meaning-changed");
    });

    it("verifies that the replacement exists in the project", async () => {
      const result = await migrateClasses(engine, { candidates: ["shadow-sm", "bg-opacity-50"] });
      expect(result.data.verified).toContain("shadow-xs");
      expect(result.data.verified).toContain("bg-black/50");
    });

    it("reports nothing for v4-native classes", async () => {
      const result = await migrateClasses(engine, { candidates: ["p-4", "flex"] });
      expect(result.data.findings).toHaveLength(0);
    });
  });

  describe("checkContrast", () => {
    it("computes the ratio of two theme colours", async () => {
      const result = await checkContrast(engine, { foreground: "white", background: "slate-900" });
      expect(result.data.ratio).toBeGreaterThan(7);
      expect(result.data.aaa).toBe(true);
    });

    it("reports a failure for low contrast", async () => {
      const result = await checkContrast(engine, { foreground: "white", background: "red-500" });
      expect(result.data.aa).toBe(false);
      expect(result.data.aaLarge).toBe(true);
    });

    it("accepts literal CSS colours", async () => {
      const result = await checkContrast(engine, { foreground: "#000", background: "#fff" });
      expect(result.data.ratio).toBe(21);
    });

    it("accepts a utility colour name", async () => {
      const result = await checkContrast(engine, {
        foreground: "text-white",
        background: "bg-slate-900",
      });
      expect(result.data.ratio).toBeGreaterThan(7);
    });
  });
});

describe("diagnostics on v3", () => {
  let fixture: Fixture;
  let engine: Awaited<ReturnType<typeof createEngine>>["engine"];

  beforeAll(async () => {
    fixture = await v3Fixture();
    ({ engine } = await createEngine(fixture.root));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("validates classes against the project config", async () => {
    const result = await diagnose(engine, { candidates: ["p-4", "bg-brand"] });
    expect(result.data.valid).toEqual(["p-4", "bg-brand"]);
  });

  it("finds a conflict", async () => {
    const result = await findConflicts(engine, { candidates: ["p-2", "p-4"] });
    expect(result.data.conflicts).toHaveLength(1);
    expect(result.data.conflicts[0]?.winner).toBe("p-4");
  });

  it("computes contrast from hex theme colours", async () => {
    const result = await checkContrast(engine, { foreground: "white", background: "gray-500" });
    expect(result.data.ratio).toBeGreaterThan(3);
  });
});
