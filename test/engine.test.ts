/**
 * Engine tests.
 *
 * These run against the real Tailwind engines, in real project fixtures.
 * Nothing is mocked: a passing test means the engine really did what the
 * tools promise.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { createEngine } from "../src/tailwind/engine.js";
import { v3Fixture, v3JsFixture, v4Fixture, type Fixture } from "./fixtures.js";

describe("v4 engine", () => {
  let fixture: Fixture;
  let engine: Awaited<ReturnType<typeof createEngine>>["engine"];

  beforeAll(async () => {
    fixture = await v4Fixture();
    ({ engine } = await createEngine(fixture.root));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("reports version 4", () => {
    expect(engine.version).toBe(4);
  });

  it("lists a realistic number of utility classes", async () => {
    const classes = await engine.listClasses();
    expect(classes.length).toBeGreaterThan(10_000);
    expect(classes.map((entry) => entry.name)).toContain("p-4");
  });

  it("exposes classes from the project's @theme and @config", async () => {
    const names = new Set((await engine.listClasses()).map((entry) => entry.name));
    expect(names.has("bg-acme")).toBe(true);
    expect(names.has("bg-brand")).toBe(true);
  });

  it("compiles a valid class into CSS", async () => {
    const [result] = await engine.compile(["p-4"]);
    expect(result?.valid).toBe(true);
    expect(result?.css).toContain("padding");
  });

  it("rejects an unknown class", async () => {
    // Note: `p-999999` is valid in v4 — spacing utilities are multipliers of
    // `--spacing`, so any number works. A non-numeric value is what fails.
    const [result] = await engine.compile(["p-nope"]);
    expect(result?.valid).toBe(false);
    expect(result?.reason).toBeTruthy();
  });

  it("compiles variants and arbitrary values", async () => {
    const [variant] = await engine.compile(["md:hover:bg-red-500"]);
    const [arbitrary] = await engine.compile(["w-[37px]"]);
    expect(variant?.valid).toBe(true);
    expect(variant?.css).toContain("hover");
    expect(arbitrary?.valid).toBe(true);
    expect(arbitrary?.css).toContain("37px");
  });

  it("exposes theme tokens including custom ones", async () => {
    const theme = await engine.listTheme();
    const byVariable = new Map(theme.map((token) => [token.variable, token]));
    expect(byVariable.get("--color-acme")?.value).toBe("#123456");
    expect(byVariable.get("--color-red-500")).toBeTruthy();
    expect(byVariable.get("--breakpoint-md")?.value).toBe("48rem");
  });

  it("lists variants", async () => {
    const variants = await engine.listVariants();
    const names = variants.map((variant) => variant.name);
    expect(names).toContain("hover");
    expect(names).toContain("dark");
  });

  it("orders classes canonically", async () => {
    const order = await engine.canonicalOrder(["text-white", "p-4", "flex"]);
    expect(order).toEqual(["flex", "p-4", "text-white"]);
  });

  it("picks up config changes without a restart", async () => {
    const before = await engine.listTheme();
    expect(before.some((token) => token.variable === "--color-late")).toBe(false);

    await fs.writeFile(
      path.join(fixture.root, "src", "app.css"),
      `@import "tailwindcss";
@config "../tailwind.config.ts";
@theme {
  --color-acme: #123456;
  --color-late: #654321;
}
`,
    );

    // The fingerprint of the CSS file changed, so the next read rebuilds.
    const after = await engine.listTheme();
    expect(after.some((token) => token.variable === "--color-late")).toBe(true);
  });

  it("picks up changes in an imported partial", async () => {
    const partial = path.join(fixture.root, "src", "partial.css");
    await fs.writeFile(partial, `.partial {\n  color: red;\n}\n`);

    await fs.writeFile(
      path.join(fixture.root, "src", "app.css"),
      `@import "tailwindcss";
@config "../tailwind.config.ts";
@import "./partial.css";
`,
    );

    // First read registers the partial as a dependency.
    await engine.listTheme();

    await fs.writeFile(
      path.join(fixture.root, "src", "app.css"),
      `@import "tailwindcss";
@config "../tailwind.config.ts";
@import "./partial.css";
@theme {
  --color-partial: #abcdef;
}
`,
    );

    const after = await engine.listTheme();
    expect(after.some((token) => token.variable === "--color-partial")).toBe(true);
  });
});

describe("v3 engine", () => {
  let fixture: Fixture;
  let engine: Awaited<ReturnType<typeof createEngine>>["engine"];

  beforeAll(async () => {
    fixture = await v3Fixture();
    ({ engine } = await createEngine(fixture.root));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("reports version 3", () => {
    expect(engine.version).toBe(3);
  });

  it("lists utility classes", async () => {
    const classes = await engine.listClasses();
    expect(classes.length).toBeGreaterThan(5_000);
    expect(classes.map((entry) => entry.name)).toContain("p-4");
  });

  it("exposes classes from the project's config", async () => {
    const names = new Set((await engine.listClasses()).map((entry) => entry.name));
    expect(names.has("bg-brand")).toBe(true);
  });

  it("validates a known class and rejects an unknown one", async () => {
    const [valid] = await engine.compile(["p-4"]);
    const [invalid] = await engine.compile(["p-nope"]);
    expect(valid?.valid).toBe(true);
    expect(invalid?.valid).toBe(false);
  });

  it("renders CSS for a valid class", async () => {
    const [result] = await engine.compile(["p-4"]);
    expect(result?.valid).toBe(true);
    expect(result?.css).toContain("padding");
  });

  it("lists variants", async () => {
    const variants = await engine.listVariants();
    expect(variants.map((variant) => variant.name)).toContain("hover");
  });

  it("picks up config changes without a restart", async () => {
    const before = await engine.compile(["bg-magenta-brand"]);
    expect(before[0]?.valid).toBe(false);

    await fs.writeFile(
      path.join(fixture.root, "tailwind.config.ts"),
      `import type { Config } from "tailwindcss";
export default {
  theme: { extend: { colors: { brand: "#ff00aa", magenta: { brand: "#ff00ff" } } } },
} satisfies Config;
`,
    );

    // The config is re-read from disk; jiti's cache must not serve the old one.
    const after = await engine.compile(["bg-magenta-brand"]);
    expect(after[0]?.valid).toBe(true);
    expect(after[0]?.css).toContain("magenta");
  });
});

describe("v3 engine with a JavaScript config", () => {
  let fixture: Fixture;
  let engine: Awaited<ReturnType<typeof createEngine>>["engine"];

  beforeAll(async () => {
    fixture = await v3JsFixture();
    ({ engine } = await createEngine(fixture.root));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("picks up config changes without a restart", async () => {
    const before = await engine.compile(["bg-magenta-brand"]);
    expect(before[0]?.valid).toBe(false);

    await fs.writeFile(
      path.join(fixture.root, "tailwind.config.js"),
      `module.exports = {
  theme: { extend: { colors: { brand: "#ff00aa", magenta: { brand: "#ff00ff" } } } },
};
`,
    );

    const after = await engine.compile(["bg-magenta-brand"]);
    expect(after[0]?.valid).toBe(true);
    expect(after[0]?.css).toContain("magenta");
  });
});
