# CI checks: what each one checks, and how to turn one on

`/zi-bootstrap` writes a CI workflow into every project. This page explains, in plain words, what each check does, why some of them check nothing at first, and how to turn them on.

## The short version

The kit is a referee. It runs the project's own tools; it does not bring them. If the project has no linter, there is nothing for the lint check to run.

During `/zi-bootstrap` you answer, for each check the kit could not find a tool for, either a command or `none: <reason>`.

| What `kit.json` says | What the CI job does | What a green tick means |
|---|---|---|
| a command, e.g. `npm run lint` | runs it; fails when it fails | checked and OK |
| `none: <reason>` | prints a warning with your reason and passes | **checked nothing** (off on purpose) |
| nothing | prints "is not configured" and fails | (never green) |

So a green tick on a `none` check is not a pass. Open the run and read its warnings: each `none` check names itself and your reason.

## Each check

Checks that use a tool from your project:

| Check | Tool it usually runs (Node example) | What it catches | How the tool knows what is wrong |
|---|---|---|---|
| `tests` | `node --test`, Vitest, Jest | broken behaviour | the tests: the tester agent writes them from the spec for every feature |
| coverage (inside `tests`) | `c8`, `vitest --coverage` | code no test runs | a floor in `kit.json` that can only go up |
| `lint` | ESLint | mistakes and risky patterns (unused variables, `==`, unhandled promises) | a rule list; start from a standard set such as `recommended` |
| `typecheck` | TypeScript `tsc` | wrong types, e.g. text passed where a number is expected | the types written in the code and `tsconfig.json` |
| `format` | Prettier (check mode) | inconsistent formatting | one fixed style; nothing to decide |
| `boundaries` | dependency-cruiser | code importing from a layer it must not use | the layer rules you approved during `/zi-bootstrap` |
| `integration` | the project's integration tests | parts that work alone but break together | the tests: someone has to write them; the tool knows nothing by itself |
| `mutation` | Stryker | tests that pass but would not catch a bug | it changes the code on purpose and checks a test fails; warning-only until enough features have merged |
| `audit` | the kit's audit script (npm), or the stack's audit command | dependencies with known security advisories | the public advisory database |

Checks that come with the kit (nothing to set up):

| Check | What it catches |
|---|---|
| `kit-checks` | broken kit rules: files changed outside the spec, tests deleted, a review that does not match the code, and so on |
| `secrets` | keys and passwords committed to the repository (gitleaks) |

## Example: kit-test

kit-test is a tiny practice project with no linter, type checker, formatter, integration tests or layer config. Its `kit.json` says `none: <reason>` for those, so `lint`, `typecheck`, `format`, `integration` and `boundaries` are green but checked nothing. The checks that really checked something were `kit-checks`, `secrets`, `tests`, `mutation-gate` and `audit`.

## Turning a check on

1. Add the tool to the project: install it, add its config file, and add an npm script (for ESLint: `npm i -D eslint`, `npx eslint --init`, and `"lint": "eslint ."` in `package.json`). Adding a tool is a new dependency, so do it in a lane (its spec lists it under `## New dependencies`) or with a decision record on the same branch.
2. Open `.claude/kit.json` and replace that check's `none: <reason>` with the command, e.g. `"lint": "npm run lint"`. You edit this file yourself; the kit's guards stop agents from editing `.claude/`. A value already in `kit.json` wins over what the kit detects, so this step is needed even after the tool is installed.
3. Run `/zi-bootstrap --upgrade`. It regenerates the CI workflow with the new command and opens a PR. Merge it; from then on that check really checks.

During the first `/zi-bootstrap` the kit also offers to install missing tools; it installs only when you say yes.

## Rules behind this page

- No check is green while checking nothing: `docs/KIT-SPEC.md` (field-test corrections) and decision `0014`. Planted fault 40 proves a missing command fails CI.
