---
description: Carry a feature from its agreed goal to a merged PR and retro, stopping only where a human must act (approve the plan, merge, accept lessons). The next stage is always decided by `lane.js next-step` from files and git, never by this command's judgment. --queue drains the roadmap up to the WIP limit, one lane per worktree, in parallel.
argument-hint: <feature slug> | --queue
allowed-tools: Bash, Read, Edit, Agent, AskUserQuestion
---

Run: $ARGUMENTS

You orchestrate. You never write application code, tests, specs, reviews, or lessons yourself; every stage is a subagent or a kit script. You never guess what stage comes next; you ask the script. You stop only at `needs_human`, at `escalated`, or at `done`. Relay script refusals verbatim; never work around a precondition.

## The loop (one feature)

```
node "$HOME/.claude/kit/scripts/lane.js" next-step <slug> --repo "$PWD"
```
Read `stage` and act as below, then run `next-step` again. Repeat until `done`, or until a stage below says stop.

| stage | what you do |
|---|---|
| `start` | Stop. Say: "no agreed goal; run `/start`". Never invent a goal. |
| `research` | `lane.js goal-set <slug> running`; `lane.js roadmap-set <slug> researching`. Derive 2–5 questions from the goal's *Done looks like* and *Constraints* (how the relevant code works today, what calls what, external APIs at pinned versions, existing tests). Follow the `/research` procedure exactly: index lookup per question, researchers in parallel, register, validate. |
| `plan` | Follow `/plan` steps 2–4 exactly: planner → `lane.js unknowns` (exit 2: stop and tell the human research is insufficient; exit 3: a researcher per item, then planner again) → spec-critic → planner answers → `validate_docs` → `lane.js precheck` failing only on approval. `lane.js roadmap-set <slug> waiting-approval`. The planner must map every `G<n>` in the goal to a done-criterion; an unmapped outcome is a critique item. |
| `approve` | **Pause 1.** Print the spec's `## Summary` and the Critique items with answers. AskUserQuestion: Approve / Changes / Stop. *Changes*: give the human's text to the planner as a critique item and go back to `plan`. *Stop*: `roadmap-set <slug> queued`, `goal-set <slug> agreed`, end. *Approve*: edit the spec header to `Status: approved` and the Approval section to `Approved by: <Agreed by name from the goal file> on <today> at <git rev-parse --short HEAD>`; commit spec, research, ROADMAP on branch `spec/<slug>`; push; open PR `spec: <feature>`; merge it (docs only; the human approved in this conversation). |
| `lane` | `lane.js start <slug>` then `cd <worktree> && bash scripts/sync.sh`. Exit 3 from sync is a conflict: that counts as the lane's first attempt; a second conflict is an escalation. |
| `test` | `lane.js stage <slug> test`. Spawn `tester` (working directory = worktree): "Lane `<slug>`. Write the tests for every done-criterion and their negative/edge cases per your rules. Run them red. Fill the Red run column. Stop." Its Stop hook refuses until every criterion has a red run. |
| `build` | `lane.js stage <slug> build`. Spawn `implementer` (working directory = worktree): "Lane `<slug>`. Read lane.json, the spec, every file in Files to read first and Files to change, LESSONS.md, and the tests the tester wrote. They are red; make them green at the extension points the spec names, criterion by criterion, without changing their assertions. Update progress.md and commit after each. Stop when every criterion is green or Escalation is filled." The hooks count attempts and write the escalation themselves. |
| `review` | If the lane has no PR yet: `git push -u origin wt/<slug>`, `gh pr create --title "<slug>: <feature>" --body-file docs/specs/<slug>.progress.md`, `lane.js roadmap-set <slug> in-review --pr <url>`. Then `lane.js stage <slug> review` and follow `/review` exactly (second reviewer on high-risk; fail list back to the implementer; after 3 FAIL rounds set `escalated`). |
| `wait-merge` | **Pause 2.** Tell the human: PR link, CI state (`gh pr checks`), verdict, and from the events log the counts of edits blocked, red runs, green runs, stop refusals. Ask them to merge. **Do not merge.** In `--queue` mode continue other lanes and come back; otherwise end the turn here. |
| `retro` | `git fetch origin && lane.js merged <slug> --repo "$PWD" --pr <url>`. Follow `/retro`: retro agent proposes; AskUserQuestion per lesson (accept / edit / drop); write accepted ones; `lane.js finish <slug>`; `lane.js goal-set <slug> done`. |
| `escalated` | Stop. Show the Escalation section of progress.md verbatim. `roadmap-set <slug> escalated`. A human decides. |
| `done` | Report: PR, lessons written, debt count from `/status`. |

## Queue mode (`--queue`)

```
node "$HOME/.claude/kit/scripts/lane.js" next --repo "$PWD"
```
Exit 0 gives the next slug with an agreed goal under the WIP limit; run the loop for it. Exit 2 says why not (WIP full or no agreed goal). Run independent lanes in parallel: spawn their stage agents in the same turn, each with its own worktree as working directory. A pause in one lane never blocks the others. Stop when `next` returns exit 2 and every in-flight lane is at a pause.

## What the human sees

`/start`, a short discussion, then "approve", "merge", "accept". Everything else is this loop, the agents, and the hooks. `/dashboard` shows all of it live, from the same files `next-step` reads.
