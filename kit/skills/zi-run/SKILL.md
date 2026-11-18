---
name: zi-run
description: "Carries a feature through every stage (research, spec, approval, tests, build, review, merge, retro), asking lane.js next-step what comes next each time and stopping only where a human must act. Use to start or resume work on a feature that has an agreed goal, or with --queue to work through the roadmap."
argument-hint: "<feature slug> | --queue"
allowed-tools: Bash, Read, Edit, Agent, AskUserQuestion
---

Run: $ARGUMENTS

You orchestrate. You never write application code, tests, specs, reviews, or lessons yourself; every stage is a subagent or a kit script. You never guess what stage comes next; you ask the script. You stop only at `needs_human`, at `escalated`, or at `done`. Relay script refusals verbatim; never work around a precondition.

## The loop (one feature)

```
node "$HOME/.claude/kit/scripts/lane.js" next-step <slug> --repo "$PWD"
```
Read `stage` and act as below, then run `next-step` again. Repeat until `done`, or until a stage below says stop. The answer also carries `work_type`, `size`, `risk` and `agent`: the one agent the workflow profile allows for this stage (`kit/workflows/<work_type>.json`). Spawn that agent and no other; when `agent` is null the stage is the human's or a script's. A `rerouted` field means the controller changed the work type from the debugger's evidence; continue under the new profile. A stage below that the profile lacks will never be returned for that work type.

| stage | what you do |
|---|---|
| `start` | Stop. Say: "no agreed goal; run `/zi-start`". Never invent a goal. |
| `research` | `lane.js goal-set <slug> running`; `lane.js roadmap-set <slug> researching`. Derive 2–5 questions from the goal's *Done looks like* and *Constraints* (how the relevant code works today, what calls what, external APIs at pinned versions, existing tests). Follow the `/zi-research` procedure exactly: index lookup per question, researchers in parallel, register, validate. |
| `plan` | fix/incident: spawn `planner` (working directory = worktree): "Lane `<slug>`. Write docs/specs/<slug>.md from the goal and progress.md ## Reproduction: Files to change from its `files:` list, one done-criterion per *Done looks like* item plus the pinning test it proposes. Set status waiting-approval. Stop." Then validate_docs and stop for approval. Otherwise follow `/zi-plan` steps 2–4 exactly: planner → `lane.js unknowns` (exit 2: stop and tell the human research is insufficient; exit 3: a researcher per item, then planner again) → spec-critic → planner answers → `validate_docs` → `lane.js precheck` failing only on approval. `lane.js roadmap-set <slug> waiting-approval`. The planner must map every `G<n>` in the goal to a done-criterion; an unmapped outcome is a critique item. |
| `approve` | **Pause 1.** Print the spec's `## Summary` and the Critique items with answers. AskUserQuestion: Approve / Changes / Stop. *Changes*: give the human's text to the planner as a critique item and go back to `plan`. *Stop*: `roadmap-set <slug> queued`, `goal-set <slug> agreed`, end. *Approve*: edit the spec header to `Status: approved` and the Approval section to `Approved by: <Agreed by name from the goal file> on <today> at <git rev-parse --short HEAD>`; commit spec, research, ROADMAP on branch `spec/<slug>`; push; open PR `spec: <feature>`; merge it with `lane.js merge --pr <url> --by <approver>` (docs only; the human approved in this conversation). It waits for CI and merges only when every required check passed; if it refuses, show its reasons and stop. |
| `lane` | `lane.js start <slug>` then `cd <worktree> && bash scripts/sync.sh`. Exit 3 from sync is a conflict: that counts as the lane's first attempt; a second conflict is an escalation. Exit 4: no test command is configured, so nothing proves the lane passes; stop and ask the human for one. Sync installs dependencies itself when the worktree has none or a lockfile changed. |
| `test` | `lane.js stage <slug> test`. Spawn `tester` (working directory = worktree): "Lane `<slug>`. Write the tests for every done-criterion and their negative/edge cases per your rules. Run them red. Fill the Red run column. Stop." Its Stop hook refuses until every criterion has a red run. |
| `build` | `lane.js stage <slug> build`. Spawn `implementer` (working directory = worktree): "Lane `<slug>`. Read lane.json, the spec, every file in Files to read first and Files to change, LESSONS.md, and the tests the tester wrote. They are red; make them green at the extension points the spec names, criterion by criterion, without changing their assertions. Update progress.md and commit after each. Stop when every criterion is green or Escalation is filled." The hooks count attempts and write the escalation themselves. |
| `review` | If the lane has no PR yet: `git push -u origin wt/<slug>`, `gh pr create --title "<slug>: <feature>" --body-file docs/specs/<slug>.progress.md`, `lane.js roadmap-set <slug> in-review --pr <url>`. Then `lane.js stage <slug> review` and follow `/zi-review` exactly (second reviewer on high-risk; fail list back to the implementer; after 3 FAIL rounds set `escalated`). |
| `wait-merge` | **Pause 2.** Run `lane.js ci <slug> --wait` and tell the human: PR link, the CI state it prints (never from `gh pr checks`, which says "no checks reported" before CI has started), verdict, and from the events log the counts of edits blocked, red runs, green runs, stop refusals. Ask whether to merge. **Merge only when they say so**, and only with `lane.js merge <slug> --by <their name>`: it waits for every required check on the PR head and refuses red or pending CI. Never `gh pr merge` (the bash guard blocks it). If it refuses, show the reasons and stop. In `--queue` mode continue other lanes and come back; otherwise end the turn here. |
| `retro` | `git fetch origin && lane.js merged <slug> --repo "$PWD" --pr <url>`. Follow `/zi-retro`: retro agent proposes; AskUserQuestion per lesson (accept / edit / drop); write accepted ones; `lane.js finish <slug>`; `lane.js goal-set <slug> done`. |
| `escalated` | Stop. Show the Escalation section of progress.md verbatim. `roadmap-set <slug> escalated`. A human decides. |
| `stopped` | Stop. The kill switch is set (`.claude/STOP`); show its `by` and `reason`. Nothing runs until a human runs `lane.js resume-all --by <name>`. |
| `refused` | Stop. Show the reason verbatim: the goal's `Work type` has no profile. The human fixes the goal header; never pick a profile yourself. |
| `done` | Report: PR, lessons written, debt count from `/zi-status`. |
| `reproduce` | fix/incident only. `lane.js stage <slug> reproduce`. Spawn `debugger` (working directory = worktree): "Lane `<slug>`. Reproduce the goal's symptom, localize the cause, propose the pinning test and list the files the fix needs, all in progress.md under ## Reproduction, ending with one `cause:` line. Stop." It can write only the progress file. |
| `scope` | fix/incident only, after the human approved the spec the planner wrote in the lane: `lane.js scope <slug>`. It refuses unless the spec is valid, approved and overlaps no other lane; then it copies the done-criteria into progress and moves the lane to test. |

## Queue mode (`--queue`)

```
node "$HOME/.claude/kit/scripts/lane.js" next --repo "$PWD"
```
Exit 0 gives the next slug with an agreed goal under the WIP limit; run the loop for it. Exit 2 says why not (WIP full or no agreed goal). Run independent lanes in parallel: spawn their stage agents in the same turn, each with its own worktree as working directory. A pause in one lane never blocks the others. Stop when `next` returns exit 2 and every in-flight lane is at a pause.

## What the human sees

`/zi-start`, a short discussion, then "approve", "merge", "accept". Everything else is this loop, the agents, and the hooks. `/zi-dashboard` shows all of it live, from the same files `next-step` reads.
