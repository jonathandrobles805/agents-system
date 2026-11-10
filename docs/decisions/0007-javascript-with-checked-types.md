# 0007 The kit is plain JavaScript with checked types; Node is the only runtime

Date: 2026-11-10

## Context
The kit was written in Python and ported to JavaScript in PR #10 (hardened in PR #11). Each script kept its name, flags, exit codes and output bytes, and was checked against the Python original on the same inputs before the Python was removed. Claude Code runs on Node wherever it runs, so a Node-only kit installs with nothing extra. Two questions remained open after the port: whether to go further to TypeScript, and what to do with the helpers that reproduce Python failure behaviour (`dictGet`, `pyInt`, `relativeTo`, in `kitlib`, `ci_common`, `lane`, `validate_docs`, `bootstrap`).

## Decision
1. The kit's implementation language is plain JavaScript (ES modules, Node 20+), with no build step and no runtime npm dependencies. This is not revisited.
2. Types are added as JSDoc with `// @ts-check` at the top of a file, file by file, starting with `kitlib.js`. A file that opts in must pass `tsc --noEmit` (`allowJs`, `checkJs`). The CI job that runs `tsc` over opted-in files lands in the same PR as the first opted-in file, together with `typescript` and `@types/node` as **dev** dependencies only; the runtime stays dependency-free. Until then no CI typecheck exists, and this document says so rather than pretending.
3. The Python-emulation helpers stay until each has a native JavaScript replacement with its own tests. They were part of the proof that the port changed no behaviour; removing them is a behaviour change and goes through the normal route (test first, then change), not through housekeeping.
4. Python remains a supported *target-project* stack (`kit/stacks/python.json`, detection, boundaries and dependency checks). Only the kit's own language changed.

## Alternatives rejected
- TypeScript with a build step: adds a toolchain to every install and a compiled artefact to review; the kit's scripts are small enough that JSDoc gives the same checking without either.
- Removing the emulation helpers in this housekeeping PR: changes error behaviour the tests pin today; no test yet describes the replacement behaviour.
- Adding `tsc` to CI now over all files: fails on every file (`process` undefined without `@types/node`); a red gate nobody can pass is worse than no gate.

## Consequences
- `package.json` gains `devDependencies` only when the first `@ts-check` file lands; `install.sh` and projects are unaffected.
- `docs/OPERATING-MODEL.md` §2 and §16 (step 0) refer to this decision.
- CHANGELOG entries that mention `.py` files describe the kit as it was when they were written.
