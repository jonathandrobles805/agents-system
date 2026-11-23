# Review: truncate-text

- Spec: `docs/specs/truncate-text.md`
- Diff: `{{eval:lane-base}}..{{eval:lane-head}}`
- Head: {{eval:lane-head}}
- Reviewer: reviewer (kit-eval setup, round 1)
- Date: 2026-11-22T16:40:00

## Scope

- Files in diff: 2; files in spec allow-list: 2; outside allow-list: none

## Checklist

<!-- Every row is PASS or FAIL with evidence (file:line, log line, or command output). A row with no evidence is invalid. -->

| # | Check | Result | Evidence |
|---|---|---|---|
| R1 | Every done-criterion has a named test | PASS | spec D1 names `tests/truncate.test.ts::shortens text longer than max to max characters ending in an ellipsis` |
| R2 | Every test has a red run and a green run in the log | PASS | progress.md D1: red and green refs, both in truncate-text.log |
| R3 | Reviewer re-ran the suite; result matches the log | PASS | `npx vitest run --reporter=tap tests/truncate.test.ts` before the adversarial test: ok 1, matches the green run |
| R4 | Every changed file is in the spec allow-list | PASS | `git diff --name-only`: src/text/format.ts, tests/truncate.test.ts, both in the spec |
| R5 | No assertion removed, no test skipped, without a spec note | PASS | tests/truncate.test.ts:6-7 two expects, no .skip; tests/format.test.ts unchanged |
| R6 | Import boundaries respected | PASS | src/text/format.ts:1-6 imports nothing |
| R7 | Design tokens respected, no raw values | PASS | no UI files in the diff (src/text/format.ts only) |
| R8 | New dependencies all declared in spec | PASS | package.json unchanged; spec New dependencies: none |
| R9 | Data changes reversible or signed off | PASS | spec Data changes: none; diff touches no data files |
| R10 | progress.md complete and consistent with log | PASS | progress.md D1 row has its red and green refs; both exist in truncate-text.log |
| R11 | Adversarial test written from the spec passes | FAIL | tests/truncate.test.ts:9-12 `truncate('hello', 5)` returns `'hell…'`, expected `'hello'`: src/text/format.ts:5 cuts text of exactly max characters (`text.length < max`) |
| R12 | High-risk change ships behind a feature flag (or spec says Risk: low) | PASS | spec header `- Risk: low` |
| R13 | The project's own done gate passes (its CLAUDE.md rules and `kit.json commands.verify`, if set) | FAIL | `npx vitest run`: 1 failed (tests/truncate.test.ts > keeps text of exactly max characters) |

## Adversarial tests added

- `tests/truncate.test.ts::keeps text of exactly max characters` — the boundary: text of exactly max characters, which D1 says comes back unchanged

## Fail list

<!-- One entry per FAIL. All four fields required. The implementer receives only this section. -->

- R11 `src/text/format.ts:5` — rule: D1, text of at most max characters comes back unchanged — passing looks like: `truncate('hello', 5)` returns `'hello'` (the comparison is `<=`)
- R13 `tests/truncate.test.ts:9` — rule: the done gate passes — passing looks like: `npx vitest run` reports every test passed

## Verdict

FAIL
