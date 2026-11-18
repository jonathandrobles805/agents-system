---
description: "Use when a lane has merged, or with --incident when a production incident got past every gate. The retro agent proposes lessons and the check that would have caught the problem; you accept, edit or drop each; accepted lessons are written and the worktree is cleaned up."
argument-hint: "<feature slug> | --incident \"<what happened>\" [--slug <feature it came from>]"
---

Retro for: the arguments

## Incident mode (`--incident "<what happened>"`)
An incident is a mistake that passed every gate. It gets the same treatment as a review failure, with the gate that should have caught it named explicitly.
1. Record it: `node "$HOME/.claude/kit/scripts/lane.js" incident --repo "$PWD" --what "<what happened>" [--slug <feature>] [--pr <url>]`. This writes `docs/incidents/<date>-<n>.md` from the incident template (what, when, impact, how detected, rollback used) and prints its path.
2. Spawn `retro` with the incident file, `LESSONS.md`, and, if a feature is named, that lane's spec, review report, and events. Its question is different from the merge retro: "which gate should have caught this, and what check would have?" The answer must name a hook, lint, test, or CI check; `text-only` requires a reason.
3. Continue at Step 3 below (human decides, write, apply). Skip Step 5 (no worktree). Set the incident file's `Status` to `lesson-written` with the lesson's heading.

## Step 1: confirm merged
`gh pr view <PR url from ROADMAP.md> --json state,mergedAt`. If not merged, stop; retro runs on merged work only.
Then `git fetch origin && node "$HOME/.claude/kit/scripts/lane.js" merged <slug> --repo "$PWD"` so ROADMAP.md says merged even if nothing else recorded it (the script verifies it in git first).

## Step 2: retro agent
Spawn `retro` with: the spec, progress, review, log, events (from the lane worktree if it still exists, else from `main`), the merged PR number, and `LESSONS.md`. It prints proposed lesson entries and stops. It does not write.

## Step 3: human decides
For each proposed lesson, ask the human: accept, edit, or drop. Use AskUserQuestion when available. Do not accept on their behalf.

## Step 4: write
For accepted lessons:
- Append the entry to `LESSONS.md` under a `## <date> — <slug> — <title>` heading using the lesson template fields. `Enforced by: text-only` entries also get a one-line bullet under `## Debt` at the top.
- Apply the proposed change when it is a project file (a test template under `docs/specs/`, a lint rule, a CI step), on a branch `retro/<slug>`, and open a PR. Hook or kit-script changes are not applied here: open an issue on the kit repo instead (`gh issue create --repo jonathandrobles805/agents-system`) with the lesson text and `scope: global`.
- Run `node "$HOME/.claude/kit/scripts/validate_docs.js" LESSONS.md --repo "$PWD"`.
- If `CLAUDE.md` lists a rule that is now enforced by a check, remove it from `CLAUDE.md` in the same PR (the cap exists for this reason).

## Step 5: clean up
```
node "$HOME/.claude/kit/scripts/lane.js" finish <slug> --repo "$PWD"
```
Report: lessons written, debt count now, kit issues opened, worktree removed.
