---
description: "Build an approved spec in its own worktree with the implementer agent under lane hooks. Refuses without an approval line, with open questions, past the WIP limit, or on file overlap. Resumes an existing lane."
argument-hint: "<feature slug>"
---

Implement feature: the arguments

## Step 1: start or resume the lane
```
node "$HOME/.claude/kit/scripts/lane.js" start <slug> --repo "$PWD"
```
- Exit 2 with reasons: stop and relay them verbatim. Do not work around a precondition. If the reason is "worktree already exists", this is a resume: read `<worktree>/docs/specs/<slug>.progress.md` and continue from "Current step".
- Exit 0: the JSON names the worktree, branch, spec, and progress file.

Then sync and record the clock:
```
cd <worktree> && bash scripts/sync.sh && node "$HOME/.claude/kit/scripts/lane.js" stage <slug> test --repo <main repo>
```
The stage is `test`, not `build`: the tester is about to make tests fail on purpose, and in `build` every one of
those red runs is counted against the three-strikes counter as a failed attempt to fix something (#32).
If `sync.sh` exits 3 (merge conflict), the implementer may resolve it once as its first attempt; a second conflict is an escalation.

## Step 2: tests first, by a different agent
Spawn the `tester` agent with working directory = the worktree: "Lane `<slug>`. Write the tests for every done-criterion and their negative/edge cases per your rules. Run them red. Fill the Red run column. Stop." A hook blocks it from writing anything but test files. When it stops, read progress.md: every criterion must have a red run; send the tester back for any that does not.

## Step 3: build
Move the lane to the stage where red counts as a failed fix, now that the tests are meant to pass:
```
node "$HOME/.claude/kit/scripts/lane.js" stage <slug> build --repo <main repo>
```
Then have the implementer commit a stub for every file in Files to create before writing any logic -- one that
throws or returns nothing, so the tester's red runs fail on an assertion rather than on a missing module. A run
that cannot load the code under test proves nothing about the test, and done-check now refuses it as a red run
(#30).

Spawn the `implementer` agent with its working directory set to the worktree and this instruction: "Your lane is `<slug>`. Read `.claude/lane.json`, then the spec, then every file in Files to read first and Files to change, then LESSONS.md, then the tests the tester wrote. The tests are red; make them green at the extension points the spec names, criterion by criterion, without changing their assertions. Update progress.md and commit after each. Stop when every criterion has a green run or Escalation is filled."

Do not give the implementer any summary of the code. It reads the files itself; the hook requires it.

## Step 4: after the implementer stops
Read `docs/specs/<slug>.progress.md` in the worktree.
- Escalation filled: `node "$HOME/.claude/kit/scripts/lane.js" roadmap-set <slug> escalated --repo <main repo>`, show the human the Escalation section, and stop. Nothing else.
- All criteria green: run the full test command from `.claude/kit.json` once more in the worktree and confirm green. Then:
```
cd <worktree> && git push -u origin wt/<slug>
gh pr create --title "<slug>: <feature>" --body-file docs/specs/<slug>.progress.md --base <default branch>
node "$HOME/.claude/kit/scripts/lane.js" roadmap-set <slug> in-review --repo <main repo> --pr <PR url>
node "$HOME/.claude/kit/scripts/lane.js" stage <slug> review --repo <main repo>
```
Then run `/kit review <slug>`.

Never edit code yourself in this command. Never mark anything done that the Stop hook did not accept.
