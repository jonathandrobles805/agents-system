# 0018 CI cost is cut only where no check is lost

Date: 2026-11-24 · Status: accepted · Decided by: the owner, in chat (2026-11-24) · Enforced by: test (`kit/scripts/tests/ci_policy.test.js`)

## Context

The repository is private, so GitHub bills every Actions minute. In November 2026 metered usage reached $38.13, against $18.13 included. Payment failed and GitHub stopped starting jobs. Most of the cost came from three sources:
- the real-agent eval, after every merge to main and every Sunday;
- the unit tests, run twice per push, once on Node 20 and once on Node 22;
- older runs that kept going after a newer push.

The real-agent eval also uses Claude API usage, which is billed separately.

## Decision

1. **The real-agent smoke set runs exactly when it can catch something.** `eval-smoke-main` lives in its own workflow, `kit-eval-main.yml`. It starts on a push to main only when that push changes `kit/agents/`, `kit/skills/`, `kit/templates/`, `kit/workflows/` or `kit/eval/` (a `paths` filter), and by hand. Any other merge starts nothing, so it costs no minutes and no Claude usage. The check is never skipped where it matters and never left to memory.
2. **The full set (all tasks, n=3) runs only by hand** (`kit-eval-weekly.yml`, `workflow_dispatch`, no `schedule`). Run it:
   - before tagging a release;
   - after a Claude or Claude Code update;
   - when the smoke set or a change calls for a closer measure.
3. **One supported Node major per matrix value, starting at 22.** Node 20 reached end of life on 2026-04-30, so the kit's minimum is Node 22: `package.json` `engines`, `install.sh` and the README say the same. The unit-test matrix covers every supported major, and no value below the minimum.
4. **A newer push to a pull request cancels its older run.** Runs on main are never cancelled.

## What stays the same (no check is lost)

Every pull request still runs the unit tests, the planted faults, the docs self-check and the recorded-fixture eval. A merge still needs every required check green.

## What this costs, and how it is covered

- A model or Claude Code update that hurts an agent is not caught on a schedule. Covered by running the full set after such an update (decision 2), and by the smoke set on the next agent change.

## Rule for any later CI change

A CI change that removes or narrows a check must:
- name what it stops catching;
- say what covers that instead;
- be recorded here, with `ci_policy.test.js` updated to match.

A cut that loses a check with nothing to cover it is not made.
