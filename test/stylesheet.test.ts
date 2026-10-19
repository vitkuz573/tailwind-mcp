/**
 * Tests for stylesheet resolution.
 *
 * A Tailwind v4 stylesheet imports more than itself: the framework's own
 * sheet, packages that ship utilities, and sub-paths of packages. Getting
 * any of them wrong makes the whole design system fail to load, so these
 * cases are covered directly.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveStylesheet } from "../src/tailwind/stylesheet.js";
import { createEngine } from "../src/tailwind/engine.js";
import { projectRequire, v4PackageImportsFixture, type Fixture } from "./fixtures.js";

describe("stylesheet resolution", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await v4PackageImportsFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  /** Resolve a specifier against the fixture's project. */
  const resolve = (id: string) => {
    const { require, tailwindDir } = projectRequire(fixture.root);
    return resolveStylesheet(
      id,
      path.join(fixture.root, "src"),
      tailwindDir,
      fixture.root,
      require,
    );
  };

  it("resolves the framework's own stylesheet", async () => {
    const resolved = await resolve("tailwindcss");
    expect(resolved.path.endsWith("index.css")).toBe(true);
    expect(resolved.content).toContain("@layer");
  });

  it("resolves a package that ships CSS under the style condition", async () => {
    const resolved = await resolve("pkg-animations");
    expect(resolved.path).toContain("pkg-animations");
    expect(resolved.content).toContain("--animate-fade-in");
  });

  it("resolves a package sub-path", async () => {
    const resolved = await resolve("pkg-preset/preset.css");
    expect(resolved.path).toContain("preset.css");
    expect(resolved.content).toContain("--color-preset");
  });

  it("resolves a relative import", async () => {
    const partial = path.join(fixture.root, "src", "partial.css");
    await fs.writeFile(partial, ".partial { color: red; }\n");

    const resolved = await resolve("./partial.css");
    expect(resolved.path).toBe(partial);
  });

  it("reports an unresolvable specifier", async () => {
    await expect(resolve("not-installed-anywhere")).rejects.toThrow(/Cannot resolve/);
  });
});

describe("engine with package imports", () => {
  let fixture: Fixture;
  let engine: Awaited<ReturnType<typeof createEngine>>["engine"];

  beforeAll(async () => {
    fixture = await v4PackageImportsFixture();
    ({ engine } = await createEngine(fixture.root));
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("loads a design system whose entry imports packages", async () => {
    const classes = await engine.listClasses();
    expect(classes.length).toBeGreaterThan(10_000);
  });

  it("sees the theme a package contributed", async () => {
    const theme = await engine.listTheme();
    expect(theme.some((token) => token.variable === "--color-preset")).toBe(true);
  });

  it("sees a utility a plugin package added", async () => {
    const classes = await engine.listClasses();
    expect(classes.some((entry) => entry.name === "pkg-utility")).toBe(true);
  });
});
