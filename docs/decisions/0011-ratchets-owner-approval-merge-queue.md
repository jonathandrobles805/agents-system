# 0011 Quality gates are ratchets, CI configuration needs the owner, merges go through a queue

Date: 2026-11-10

## Context
A coverage threshold chosen on day one is either too high (nobody can merge) or too low (it never bites). A CI file an agent can edit is a gate an agent can remove. Two lanes merging green on top of a stale base can still break `main` together.

## Decision
1. **Ratchets, not cliffs.** The coverage floor starts at whatever the project measures today and only rises: `ci_coverage_floor.js` fails a PR below the floor or one that lowers the floor against the base branch, and `--ratchet` on the default branch raises it to the measured value. The mutation threshold already follows the same idea (warning first, then blocking). KIT-SPEC §7.4.
2. **CI and kit configuration need the owner.** `/bootstrap` writes `.github/CODEOWNERS` for `.github/workflows/`, `.claude/`, `CLAUDE.md`, `ARCHITECTURE.md`; `--protect` requires a code owner's review for those paths and nothing else (`required_approving_review_count: 0`). Agents already cannot edit `.claude/` or the workflows (guard-edit, §7.2); this closes the route through a pull request.
3. **Merge queue.** `--protect` creates a `merge_queue` ruleset (squash, all green) and the workflow runs on `merge_group`, so every merge is tested on top of the real `main`. Best effort: when the GitHub plan does not offer rulesets, the result says so and the strict up-to-date requirement remains.

## Alternatives rejected
- A fixed coverage threshold: either blocks all work or protects nothing.
- Requiring a review on every PR: turns the owner into a bottleneck for work the kit already verifies independently.
- Relying on the strict up-to-date check alone instead of a queue: correct but serial; with parallel lanes it means constant rebases.

## Consequences
- Planted faults 30 (CI/kit config change without owner review → blocked; GitHub-enforced, kit verifies the configuration) and 31 (coverage below floor or floor lowered → CI fail).
- `kit.json` gains `coverage_floor`, written only by `--ratchet`.
- Stack definitions gain `format` and `coverage` commands (prettier, black, ruff; vitest, jest, pytest-cov).
