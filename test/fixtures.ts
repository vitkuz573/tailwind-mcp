/**
 * Test fixtures.
 *
 * Each fixture is a self-contained Tailwind project with its own
 * `node_modules`, so the engine always loads the project's own Tailwind
 * rather than the server's bundled copy.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Absolute path of a package installed in this repo. */
export function packageDir(name: string): string {
  return path.dirname(require.resolve(`${name}/package.json`));
}

/**
 * A `require` bound to a fixture's project root, plus the directory of the
 * `tailwindcss` package it resolves.
 */
export function projectRequire(root: string): { require: NodeRequire; tailwindDir: string } {
  const bound = createRequire(path.join(root, "package.json"));
  return {
    require: bound,
    tailwindDir: path.dirname(bound.resolve("tailwindcss/package.json")),
  };
}

export interface Fixture {
  readonly root: string;
  readonly cssFile: string;
  readonly configFile: string;
  cleanup(): Promise<void>;
}

/** Create a temporary directory that is removed on cleanup. */
export async function tempDir(
  prefix: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `tailwind-mcp-${prefix}-`));
  return {
    path: dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Link a package directory into a fixture's `node_modules`.
 *
 * A symlink keeps the fixture small while still giving the engine a real
 * `node_modules/tailwindcss` to resolve against.
 */
async function linkPackage(root: string, name: string, target: string): Promise<void> {
  const modulesDir = path.join(root, "node_modules");
  await fs.mkdir(modulesDir, { recursive: true });
  const link = path.join(modulesDir, name);
  await fs.symlink(target, link, "dir").catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

/**
 * Write a fake package into a fixture's `node_modules`.
 *
 * The two shapes mirror what real packages do: one that ships CSS under the
 * `style` export condition, and one that exposes a CSS file as a sub-path.
 */
async function writePackage(
  root: string,
  name: string,
  files: Record<string, string>,
  manifest: Record<string, unknown>,
): Promise<void> {
  const packageDir = path.join(root, "node_modules", name);
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", ...manifest }, null, 2),
  );
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(packageDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

/**
 * A Tailwind v4 project that imports CSS from packages.
 *
 * This mirrors a real shadcn/ui setup: the entry stylesheet pulls in
 * `tailwindcss`, a package that ships utilities, and a sub-path of another
 * package. All three have to resolve for the design system to load at all.
 */
export async function v4PackageImportsFixture(): Promise<Fixture> {
  const { path: root, cleanup } = await tempDir("v4-pkg");
  await linkPackage(root, "tailwindcss", packageDir("tailwindcss"));

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture-v4-pkg", private: true, version: "1.0.0" }, null, 2),
  );

  // A package that ships its stylesheet under the `style` condition.
  await writePackage(
    root,
    "pkg-animations",
    {
      "dist/pkg-animations.css": `@theme { --animate-fade-in: fade-in 0.2s ease-in; }
@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
`,
    },
    {
      exports: {
        ".": {
          style: "./dist/pkg-animations.css",
          default: "./dist/pkg-animations.css",
        },
      },
    },
  );

  // A package that exposes a stylesheet as a sub-path.
  await writePackage(
    root,
    "pkg-preset",
    {
      "dist/preset.css": `@theme { --color-preset: oklch(0.5 0.1 250); }
`,
    },
    {
      exports: {
        ".": { default: "./dist/index.js" },
        "./preset.css": "./dist/preset.css",
      },
    },
  );

  // A plugin package, loaded through `@plugin`.
  await writePackage(
    root,
    "pkg-plugin",
    {
      "dist/plugin.js": `export default function ({ addUtilities }) {
  addUtilities({ ".pkg-utility": { color: "rebeccapurple" } });
}
`,
    },
    {
      exports: {
        ".": { default: "./dist/plugin.js" },
      },
    },
  );

  const cssFile = path.join(root, "src", "app.css");
  await fs.mkdir(path.dirname(cssFile), { recursive: true });
  await fs.writeFile(
    cssFile,
    `@import "tailwindcss";
@import "pkg-animations";
@import "pkg-preset/preset.css";
@plugin "pkg-plugin";
`,
  );

  return { root, cssFile, configFile: path.join(root, "tailwind.config.js"), cleanup };
}

/** A Tailwind v4 project with a custom theme and a `@config` file. */
export async function v4Fixture(): Promise<Fixture> {
  const { path: root, cleanup } = await tempDir("v4");
  await linkPackage(root, "tailwindcss", packageDir("tailwindcss"));

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture-v4", private: true, version: "1.0.0" }, null, 2),
  );

  const configFile = path.join(root, "tailwind.config.ts");
  await fs.writeFile(
    configFile,
    `import type { Config } from "tailwindcss";
export default {
  theme: { extend: { colors: { brand: "#ff00aa" } } },
} satisfies Config;
`,
  );

  const cssFile = path.join(root, "src", "app.css");
  await fs.mkdir(path.dirname(cssFile), { recursive: true });
  await fs.writeFile(
    cssFile,
    `@import "tailwindcss";
@config "../tailwind.config.ts";
@theme {
  --color-acme: #123456;
}
`,
  );

  return { root, cssFile, configFile, cleanup };
}

/** A Tailwind v3 project with a TypeScript config. */
export async function v3Fixture(): Promise<Fixture> {
  return v3FixtureWith("tailwind.config.ts");
}

/** A Tailwind v3 project with a plain JavaScript config. */
export async function v3JsFixture(): Promise<Fixture> {
  return v3FixtureWith("tailwind.config.js");
}

async function v3FixtureWith(configName: string): Promise<Fixture> {
  const { path: root, cleanup } = await tempDir("v3");
  await linkPackage(root, "tailwindcss", packageDir("tailwindcss-v3"));

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture-v3", private: true, version: "1.0.0" }, null, 2),
  );

  const configFile = path.join(root, configName);
  await fs.writeFile(
    configFile,
    configName.endsWith(".ts")
      ? `import type { Config } from "tailwindcss";
export default {
  theme: { extend: { colors: { brand: "#ff00aa" } } },
} satisfies Config;
`
      : `module.exports = {
  theme: { extend: { colors: { brand: "#ff00aa" } } },
};
`,
  );

  const cssFile = path.join(root, "src", "app.css");
  await fs.mkdir(path.dirname(cssFile), { recursive: true });
  await fs.writeFile(cssFile, `@tailwind base;\n@tailwind utilities;\n`);

  return { root, cssFile, configFile, cleanup };
}
