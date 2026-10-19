# tailwind-mcp

<!-- prettier-ignore -->
> **A Model Context Protocol server that asks Tailwind itself.**
> No hand-written class lists, no stale snapshots — the server loads your project's own
> `tailwindcss` and queries the real engine, so every answer matches the code you actually build.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-5FA04E.svg)](https://nodejs.org)
[![protocol](https://img.shields.io/badge/MCP-2026--07--28%20%2B%20legacy-8A2BE2.svg)](https://modelcontextprotocol.io)
[![types](https://img.shields.io/badge/types-strict-informational.svg)](src)
[![tests](https://img.shields.io/badge/tests-101%20passing-success.svg)](test)

|                  |                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------- |
| **Tools**        | 9 read-only tools (`tailwind_diagnose`, `tailwind_validate`, `tailwind_conflicts`, …)         |
| **Engine**       | your project's own `tailwindcss` — v3 **and** v4, with your theme, your plugins, your version |
| **Class list**   | 23 000+ real utilities, straight from the engine that generates them                          |
| **Latency**      | 13–340 ms per call, no network, no database                                                   |
| **Dependencies** | one runtime dependency tree from the official SDK                                             |
| **Reload**       | config edits are picked up automatically — no restart, ever                                   |

---

## Why this exists

An LLM writing Tailwind makes three mistakes, all of them the same mistake: **it invents classes
that do not exist.**

```html
<div class="bg-gray-600 p-4 shadow-lg">
  <!-- does this class exist in THIS project? -->
  <div class="bg-red-550 mt-[16px]">
    <!-- typo, and a magic number instead of a token -->
    <div class="p-2 p-4 text-sm text-lg"><!-- which of these two actually wins? --></div>
  </div>
</div>
```

Every existing "Tailwind MCP" answers this by shipping a class list copied from a documentation
snapshot. That list is wrong the moment you use a custom theme, a plugin, or a version newer than
the copy — and it cannot tell you which of two conflicting classes wins, because that depends on
your project's own configuration.

This server has no list. It loads the `tailwindcss` package **from your `node_modules`** and asks
the engine:

```
your project → your tailwindcss → the real engine → the real answer
```

- the class list contains exactly the utilities **your** project can build, including custom theme
  values, `@utility` blocks and plugin classes;
- the version is **yours**, so v3 and v4 projects each get the truth for their own generation;
- which class wins a conflict is decided by Tailwind's own class order, not by a guess;
- when you edit your config, the server notices and rebuilds itself — no restart.

## Install

Requires **Node.js ≥ 20**.

```sh
git clone https://github.com/vitkuz573/tailwind-mcp.git
cd tailwind-mcp
npm ci
npm run build
```

## Connect a host

### OpenCode

```sh
opencode mcp add tailwind -- node /absolute/path/to/tailwind-mcp/dist/index.js
```

Or by hand:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "tailwind": {
        "type": "local",
        "command": ["node", "/absolute/path/to/tailwind-mcp/dist/index.js"],
        "timeout": { "startup": 60000, "execution": 120000 },
      },
    },
  },
}
```

The server finds the project by walking up from its working directory until it finds a
`node_modules/tailwindcss`. Every tool also takes an optional `project` argument with an absolute
path, for when the Tailwind project is not the current directory.

### Claude Code

```sh
claude mcp add tailwind -- node /absolute/path/to/tailwind-mcp/dist/index.js
```

### Any other MCP client

```sh
node dist/index.js                 # stdio transport
```

## The tool surface

### `tailwind_diagnose` — start here

One call, every problem with a class list.

```json
{ "candidates": ["p-4 flex bg-red-501 mt-[16px] p-2 p-4 shadow-sm"] }
```

| Finding         | Meaning                                             | Example                                         |
| --------------- | --------------------------------------------------- | ----------------------------------------------- |
| **unknown**     | the class does not exist, with spelling suggestions | `bg-red-501` → `bg-red-500`, `bg-red-50`        |
| **arbitrary**   | an arbitrary value where a theme token would do     | `mt-[16px]` → `mt-4`, `text-[14px]` → `text-sm` |
| **conflicting** | one class silently overrides another                | `p-4` beats `p-2`                               |
| **migration**   | a v3 class whose meaning changed in v4              | `shadow-sm` → `shadow-xs`                       |

Suggestions come from the real class list, so a missing shade is completed too: `bg-brand` becomes
`bg-brand-500` when your project defines that scale.

### The rest

| Tool                      | Answers                                               |
| ------------------------- | ----------------------------------------------------- |
| `tailwind_validate`       | Do these classes exist, and what CSS do they produce? |
| `tailwind_search_classes` | What is the exact name of the utility I need?         |
| `tailwind_theme`          | Which design tokens does this project define?         |
| `tailwind_variants`       | Which variants does this project understand?          |
| `tailwind_conflicts`      | Which of these two classes wins?                      |
| `tailwind_canonicalize`   | How should this class list be written?                |
| `tailwind_migrate`        | What does this v3 class become in v4?                 |
| `tailwind_contrast`       | Is this text readable on that background?             |

## Details worth knowing

**Which class wins.** Tailwind sorts the utilities it generates, and at equal specificity the later
rule wins. The server asks the engine for that order rather than guessing, so `p-4` beating `p-2`
is a fact, not a heuristic. Shorthands are expanded, so `p-4` and `pl-2` are correctly seen to
fight over the left padding.

**The v3 trap.** In v4 the whole shadow, radius and blur scale shifted. `shadow-sm` still exists —
and now means what `shadow-xs` used to mean. The server flags that as `meaning-changed`, because the
class compiles and the bug is silent.

**Contrast.** Tailwind v4 stores colours as `oklch()`. The server converts to sRGB following
CSS Color 4, including the chroma reduction needed for colours outside the sRGB gamut, and reports
the WCAG AA and AAA verdicts.

**Reloading.** The set of files that feed the design system is discovered by following `@import`,
`@config` and `@plugin`, and a size/mtime fingerprint of those files decides whether the engine
has to be rebuilt. Edit any of them and the next call sees the change.

**Package imports.** A real stylesheet imports more than itself: the framework's own sheet,
packages that ship utilities (`tw-animate-css`), and sub-paths of packages (`shadcn/tailwind.css`).
All three are resolved through the package's `exports` map, preferring the `style` condition, and
plugins are loaded from packages too (`@plugin "@tailwindcss/typography"`). Nothing has to be
rewritten or stubbed out.

## Performance

Measured against a real project with a custom theme, on the first call after a server start:

| Tool                      | Latency |
| ------------------------- | ------- |
| `tailwind_conflicts`      | 13 ms   |
| `tailwind_canonicalize`   | 16 ms   |
| `tailwind_contrast`       | 17 ms   |
| `tailwind_theme`          | 21 ms   |
| `tailwind_validate`       | 126 ms  |
| `tailwind_diagnose`       | 305 ms  |
| `tailwind_search_classes` | 344 ms  |

There is no network call, no database and no cache to go stale. The engine is rebuilt when your
configuration changes, so the first call after an edit pays the reload cost once.

> Tailwind's own `canonicalizeCandidates` is deliberately **not** used: it builds an index of every
> class on first use, which takes seconds and blocks the event loop. The same two rules are applied
> locally against your theme instead, which answers in milliseconds.

## Development

```sh
npm run verify   # format check, typecheck, tests, build
npm test         # vitest
npm run inspect  # MCP inspector
```

The tests run against **real Tailwind installations** in temporary project fixtures — v3 and v4, with
custom themes, TypeScript configs and plugins. Nothing is mocked.

## Status

Tailwind Labs does not ship an official Tailwind MCP server. This is an independent implementation
built on the official MCP SDK and Tailwind's own public engine API.

## License

MIT
