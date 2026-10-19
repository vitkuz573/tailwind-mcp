# tailwind-mcp

Model Context Protocol server that exposes the **real** Tailwind CSS engine of your project.

Most "Tailwind MCP" servers ship a hand-written list of class names copied from some
documentation snapshot. That list is wrong the moment you use a custom theme, a plugin,
or a version newer than the copy. This server does not keep a list: it loads the
project's own `tailwindcss` package and asks the engine itself.

## What it gives you

| Tool                      | Answers                                               |
| ------------------------- | ----------------------------------------------------- |
| `tailwind_diagnose`       | What is wrong with this class list? Start here.       |
| `tailwind_validate`       | Do these classes exist, and what CSS do they produce? |
| `tailwind_search_classes` | What is the exact name of the utility I need?         |
| `tailwind_theme`          | Which design tokens does this project define?         |
| `tailwind_variants`       | Which variants does this project understand?          |
| `tailwind_conflicts`      | Which of these two classes wins?                      |
| `tailwind_canonicalize`   | How should this class list be written?                |
| `tailwind_migrate`        | What does this v3 class become in v4?                 |
| `tailwind_contrast`       | Is this text readable on that background?             |

The answers come from the project's own installation, so they include:

- the exact installed Tailwind version (v3 and v4 are both supported),
- custom theme values from `@theme`, `theme.extend` or a config file,
- classes contributed by plugins,
- utilities that only exist in newer or older Tailwind releases.

### `tailwind_diagnose`

One call, every problem. This is the tool to use before writing markup.

```json
{ "candidates": ["p-4 flex bg-red-501 mt-[16px] p-2 p-4 shadow-sm"] }
```

reports four kinds of finding:

- **unknown** — the class does not exist, with spelling suggestions,
- **arbitrary** — the class uses an arbitrary value where a theme token would do,
- **conflicting** — one class silently overrides another,
- **migration** — a v3 class whose meaning changed in v4.

Spelling suggestions come from the real class list, so `bg-red-501` is corrected
to `bg-red-500`, and a missing shade is completed: `bg-brand` becomes
`bg-brand-500` when the project defines that scale.

Which class wins a conflict is not guessed. Tailwind decides the order of the
generated stylesheet, and the server asks it: the class with the higher class
order is the one emitted later, and later wins.

`tailwind_canonicalize` additionally rewrites `mt-[16px]` into `mt-4` and
`overflow-ellipsis` into `text-ellipsis`, and sorts the list the way
`prettier-plugin-tailwindcss` would.

### `tailwind_contrast`

Computes the WCAG ratio between two colours and whether they pass AA or AAA.
Colours may be theme tokens (`red-500`, `slate-900`), colour utility names
(`text-white`, `bg-slate-900`) or literal CSS colours.

Tailwind v4 stores colours as `oklch()`, which is converted to sRGB following
CSS Color 4, including the chroma reduction needed for colours outside the
sRGB gamut.

## Design principles

- **No hand-written class list.** The class list, the theme and the generated CSS are
  produced by Tailwind itself.
- **Never silently accept a bad class.** An unknown utility is reported as invalid
  with a reason.
- **No restart after a config edit.** The engine watches every file that feeds it —
  the CSS entry point, imported partials, the config file and its imports — and
  rebuilds itself when they change.
- **Bounded output.** Every result is paginated and capped.

## Install

```sh
npm install
npm run build
```

The server needs no configuration. It resolves the project from the working directory,
walking upwards until it finds a `node_modules/tailwindcss`.

### OpenCode

```sh
opencode mcp add tailwind -- node /path/to/tailwind-mcp/dist/index.js
```

Or by hand:

```jsonc
{
  "mcp": {
    "servers": {
      "tailwind": {
        "type": "local",
        "command": ["node", "/path/to/tailwind-mcp/dist/index.js"],
      },
    },
  },
}
```

### Claude Code

```sh
claude mcp add tailwind -- node /path/to/tailwind-mcp/dist/index.js
```

## Usage

Every tool takes an optional `project` argument with an absolute path. It is only
needed when the Tailwind project is not the current working directory:

```jsonc
{
  "candidates": ["p-4", "bg-brand-500", "text-nope"],
  "project": "/home/user/my-app",
}
```

## Environment

| Variable                      | Default           | Meaning                                    |
| ----------------------------- | ----------------- | ------------------------------------------ |
| `TAILWIND_MCP_PROJECT`        | working directory | Project root to resolve from               |
| `TAILWIND_MCP_CSS_FILE`       | auto-detected     | Explicit CSS entry point                   |
| `TAILWIND_MCP_LOG_LEVEL`      | `info`            | `debug`, `info`, `warn`, `error`, `silent` |
| `TAILWIND_MCP_MAX_RESULTS`    | `200`             | Maximum rows per result                    |
| `TAILWIND_MCP_MAX_CANDIDATES` | `100`             | Maximum candidates per validation          |

Logs are written to stderr as JSON lines. stdout carries the MCP protocol only.

## How it works

`src/tailwind/` holds one adapter per Tailwind generation:

- `v4.ts` uses `__unstable__loadDesignSystem`, the same entry point Tailwind's own
  language server uses. Stylesheet and module resolution is done locally, so the
  project's dependencies are used.
- `v3.ts` resolves the project config with `resolveConfig` and renders CSS through
  the real PostCSS pipeline with the project's own theme.

`src/tailwind/fingerprint.ts` and `dependencies.ts` implement the reload: the set of
local files that feed the design system is computed by following `@import`, `@config`
and `@plugin` directives, and a cheap size/mtime fingerprint of those files decides
whether the engine has to be rebuilt.

`src/core/fuzzy.ts` finds spelling suggestions with a bounded Levenshtein distance
over the real class list, with a banded matrix so the cost stays proportional to the
distance limit rather than to the length of the class list.

`src/tailwind/conflicts.ts` decides which class wins by comparing Tailwind's own
class order, expanding shorthands so that `p-4` and `pl-2` are seen to overlap.

`src/tailwind/canonicalize.ts` rewrites an arbitrary value into the theme token
that expresses it, and applies the v3-to-v4 renames. This is implemented here
rather than through Tailwind's own `canonicalizeCandidates`, which builds an index
of every class on first use — it takes seconds and blocks the event loop, so the
first request in a session stalled the whole server. The local implementation
answers in milliseconds.

`src/core/color.ts` parses the colour formats Tailwind uses and converts `oklch()` to
sRGB following CSS Color 4, reducing chroma for colours outside the sRGB gamut.

## Performance

Measured against a real project with a custom theme, on the first call after a
server start:

| Operation                 | Latency |
| ------------------------- | ------- |
| `tailwind_validate`       | ~130 ms |
| `tailwind_diagnose`       | ~300 ms |
| `tailwind_conflicts`      | ~15 ms  |
| `tailwind_canonicalize`   | ~15 ms  |
| `tailwind_contrast`       | ~20 ms  |
| `tailwind_theme`          | ~20 ms  |
| `tailwind_search_classes` | ~340 ms |

The engine is rebuilt when the project's configuration changes, so the first call
after an edit pays the reload cost once.

## Development

```sh
npm run verify   # format check, typecheck, tests, build
npm test         # vitest
npm run inspect  # MCP inspector
```

The tests run against real Tailwind installations in temporary project fixtures —
nothing is mocked.

## License

MIT
