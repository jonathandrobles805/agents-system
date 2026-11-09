---
description: After a merge, run the retro agent on a lane, show the proposed lessons and enforcement changes, write LESSONS.md on the human's approval, flag global lessons for the kit, and clean up the worktree.
argument-hint: <feature slug>
allowed-tools: Bash, Read, Edit, Agent, AskUserQuestion
---

Retro for feature: $ARGUMENTS

## Step 1: confirm merged
`gh pr view <PR url from ROADMAP.md> --json state,mergedAt`. If not merged, stop; retro runs on merged work only.
Then `git fetch origin && python3 "$HOME/.claude/kit/scripts/lane.py" merged <slug> --repo "$PWD"` so ROADMAP.md says merged even if nothing else recorded it (the script verifies it in git first).

## Step 2: retro agent
Spawn `retro` with: the spec, progress, review, log, events (from the lane worktree if it still exists, else from `main`), the merged PR number, and `LESSONS.md`. It prints proposed lesson entries and stops. It does not write.

## Step 3: human decides
For each proposed lesson, ask the human: accept, edit, or drop. Use AskUserQuestion when available. Do not accept on their behalf.

## Step 4: write
For accepted lessons:
- Append the entry to `LESSONS.md` under a `## <date> — <slug> — <title>` heading using the lesson template fields. `Enforced by: text-only` entries also get a one-line bullet under `## Debt` at the top.
- Apply the proposed change when it is a project file (a test template under `docs/specs/`, a lint rule, a CI step), on a branch `retro/<slug>`, and open a PR. Hook or kit-script changes are not applied here: open an issue on the kit repo instead (`gh issue create --repo jonathandrobles805/agents-system`) with the lesson text and `scope: global`.
- Run `python3 "$HOME/.claude/kit/scripts/validate_docs.py" LESSONS.md --repo "$PWD"`.
- If `CLAUDE.md` lists a rule that is now enforced by a check, remove it from `CLAUDE.md` in the same PR (the cap exists for this reason).

## Step 5: clean up
```
python3 "$HOME/.claude/kit/scripts/lane.py" finish <slug> --repo "$PWD"
```
Report: lessons written, debt count now, kit issues opened, worktree removed.
