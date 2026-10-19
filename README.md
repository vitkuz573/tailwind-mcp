# tailwind-mcp

Model Context Protocol server that exposes the **real** Tailwind CSS engine of your project.

Most "Tailwind MCP" servers ship a hand-written list of class names copied from some
documentation snapshot. That list is wrong the moment you use a custom theme, a plugin,
or a version newer than the copy. This server does not keep a list: it loads the
project's own `tailwindcss` package and asks the engine itself.

## What it gives you

| Tool                      | Answers                                               |
| ------------------------- | ----------------------------------------------------- |
| `tailwind_validate`       | Do these classes exist, and what CSS do they produce? |
| `tailwind_search_classes` | What is the exact name of the utility I need?         |
| `tailwind_theme`          | Which design tokens does this project define?         |
| `tailwind_variants`       | Which variants does this project understand?          |

The answers come from the project's own installation, so they include:

- the exact installed Tailwind version (v3 and v4 are both supported),
- custom theme values from `@theme`, `theme.extend` or a config file,
- classes contributed by plugins,
- utilities that only exist in newer or older Tailwind releases.

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
