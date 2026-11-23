# Research: Where does a truncate(text, max) helper go, and what must its tests cover?

- Question: Where does a truncate(text, max) helper go, and what must its tests cover?
- Slug: truncate-text
- Date: 2026-11-22
- Commit: {{eval:head}}
- Requested by: kit-eval

## Findings

- F1. `src/text/format.ts` holds the project's text helpers; its only export is `slugify` [verified: src/text/format.ts:1-3] `export function slugify(text: string): string`
- F2. The helpers are pure functions of their arguments, with no imports [verified: src/text/format.ts:1-3] `return text.trim().toLowerCase()`
- F3. Tests use vitest, one `describe` per function, in `tests/<module>.test.ts` [verified: tests/format.test.ts:1-3] `describe('slugify', () => {`
- F4. Only the module's own test imports it, so a new export changes no caller [verified: cmd]
  ```
  $ git grep -n "text/format" -- src tests
  tests/format.test.ts:2:import { slugify } from '../src/text/format';
  ```
- F5. `String.prototype.length` counts UTF-16 code units, so a length limit written with it counts code units, not characters as a reader sees them [docs: https://tc39.es/ecma262/2024/#sec-properties-of-string-instances-length @ ES2024]
- F6. A `truncate(text, max)` beside `slugify` needs no new module and no dependency [inferred: from F1,F2,F4]

## What I could not verify

- none

## Confidence

High — the module and its test are three and seven lines, both read in full.

## Recommendation

Add `truncate(text, max)` to `src/text/format.ts` beside `slugify` (F1, F6) and test it in a new `tests/truncate.test.ts` in the style of F3: a long text cut to `max` characters ending in `…`, a short text unchanged, and the boundary of exactly `max` characters. State in the spec that `max` counts UTF-16 code units (F5).

## Sources

- src/text/format.ts
- tests/format.test.ts
- https://tc39.es/ecma262/2024/#sec-properties-of-string-instances-length
