# Contributing

Thanks for taking the time. This server is small on purpose, so contributions are judged on
whether they make it more correct, not on how much they add.

## The one rule

**The engine decides, not the server.**

Every answer this server gives must come from Tailwind itself: the class list from
`getClassList()`, the theme from the project's own tokens, the CSS from the compiler, the
conflict winner from Tailwind's class order. If you find yourself writing a list of class names
in this codebase, stop — that list will be wrong for somebody's project.

When a rule is needed that Tailwind does not expose, implement it against the project's own
theme and prove it with a test against a real Tailwind installation.

## Getting set up

```sh
npm ci
npm run verify   # format check, typecheck, tests, build
```

`npm run verify` must pass before you open a pull request. It runs a format check, the typechecker,
the test suite and the build.

## Tests

Tests run against **real Tailwind installations** in temporary project fixtures. Nothing is mocked —
a passing test means Tailwind really did what the test claims.

```sh
npm test                    # everything
npx vitest run test/engine.test.ts   # one file
```

When you add behaviour, add a test that would fail without it. When you fix a bug, add the test
that was missing.

Two things to keep in mind:

- a fixture that depends on the project's own `node_modules` must use the symlink helper in
  `test/fixtures.ts`, so the engine loads the _project's_ Tailwind rather than the server's;
- a test that needs a specific Tailwind version should use the fixture for that version, not a
  hand-written class list.

## Style

- TypeScript with `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`;
- `zod` schemas for every tool input, because the model sees them;
- comments explain _why_, not _what_ — the code already says what;
- `prettier` decides formatting: run `npm run format`.

## Adding a tool

A tool earns its place by answering a question an agent cannot answer on its own. Before adding
one, check that the answer cannot be derived from an existing tool.

If it does earn its place:

- give it a name that starts with `tailwind_`;
- give it a `project` argument, like every other tool;
- return the same envelope: a `summary` for the model and a `data` object;
- keep the output bounded and paginated;
- add it to the server instructions in `src/mcp/server.ts`;
- add it to the tool table in the README and to the protocol test.

## Reporting a bug

Include your Tailwind version, the class list you passed, what you expected and what you got. The
issue template asks for all of it.

## License

By contributing you agree that your work is licensed under the MIT License of this repository.
