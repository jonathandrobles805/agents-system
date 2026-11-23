# Spec: Truncate text

- Slug: truncate-text
- Date: 2026-11-22
- Commit: {{eval:head}}
- Research: none (one function in one module; the two files it touches were read directly)
- Risk: low
- Status: approved

## Summary

- Goal: `src/text/format.ts` exports `truncate(text, max)`, which shortens long text to `max` characters ending in `…`.
- Files changed: 1 (`src/text/format.ts`), 1 created (`tests/truncate.test.ts`)
- Risks: none beyond the new export; `slugify` must stay as it is.
- Done when: D1 `truncate` returns text of at most `max` characters unchanged, and cuts longer text to `max` characters ending in `…`.
- Open questions: none

## Goal

Titles shown in lists overflow their column. Add a `truncate(text, max)` function beside `slugify` in
`src/text/format.ts`: text of at most `max` characters comes back unchanged; longer text is cut to its first `max - 1`
characters followed by `…`, so the result is exactly `max` characters long.

## Non-goals

- Word-aware cutting, a configurable ellipsis, or any change to `slugify`.
- Counting grapheme clusters: `max` counts UTF-16 code units, as `String.prototype.length` does.

## Files to read first

- `src/text/format.ts` — the module the new function joins, beside `slugify` [verified: src/text/format.ts:1-3]
- `tests/format.test.ts` — the test style to match (vitest, one `describe` per function) [verified: tests/format.test.ts:1-7]

## Files to change

- `src/text/format.ts` — add `export function truncate(text: string, max: number): string` after `slugify` [verified: src/text/format.ts:1-3]

## Files to create

- `tests/truncate.test.ts` — the test for D1

## Impact analysis

- `src/text/format.ts` is imported only by its own test; a new export changes no importer [verified: cmd]
  ```
  $ git grep -n "text/format" -- src tests
  tests/format.test.ts:2:import { slugify } from '../src/text/format';
  ```

## Approach

Add one exported function after `slugify`. The test calls `truncate('hello world', 5)` and expects `'hell…'`, and
`truncate('hi', 5)` and expects `'hi'`. Red and green runs use the project's test command with a reporter that names
every test, passing ones included, so the log shows which test ran: `npx vitest run --reporter=tap tests/truncate.test.ts`.

## Data changes

- none

## New dependencies

- none

## Done-criteria

| # | Criterion | Test (or artifact + checklist) |
|---|---|---|
| D1 | `truncate` returns text of at most `max` characters unchanged, and cuts longer text to `max` characters ending in `…` | `tests/truncate.test.ts::shortens text longer than max to max characters ending in an ellipsis` |

## Assumptions

- A1. `slugify` is the module's only export today [verified: src/text/format.ts:1-1]

## Open questions

- none

## Architecture checklist

- [x] The function is pure and lives in the text module beside `slugify` — no new module, no dependency

## Critique

<!-- Written by spec-critic. Numbered gaps and contradictions. The planner answers each inline. -->

## Approval

Approved by: kit-eval on 2026-11-22 at {{eval:head}}
