---
description: Write the spec for a feature from existing research: planner agent, unknown resolution, spec-critic, validation. Refuses when WIP limit is hit, files overlap another active spec, or research is insufficient. Human approval happens after.
argument-hint: <feature slug>
allowed-tools: Bash, Read, Agent
---

Plan feature: $ARGUMENTS

## Step 1: preconditions
```
python3 "$HOME/.claude/kit/scripts/lane.py" wip --repo "$PWD"
```
If exit code is 2, stop: the WIP limit is reached. Say which lanes are in flight and what the human can merge or escalate.

Confirm the slug has a row in `ROADMAP.md` and at least one research file in `docs/research/INDEX.md` whose keywords match. If there is no research, stop and tell the human to run `/research <slug>` first. Planning without research is guessing.

## Step 2: plan
Spawn the `planner` agent with: the slug, the research slugs, the paths of `ARCHITECTURE.md`, `DESIGN.md`, `LESSONS.md`, `ROADMAP.md`, and the list of other specs under `docs/specs/`. It writes `docs/specs/<slug>.md`. It resolves 1–3 unknowns itself by spawning researchers; it stops with "research insufficient" at more than 3. If it stops, relay the list to the human and end.

## Step 3: critique
Spawn `spec-critic` on `docs/specs/<slug>.md`. Then spawn the `planner` again with the instruction "answer each Critique item inline (C1 → response) and amend the spec where the critic is right; do not delete critique items". Up to two rounds.

## Step 4: validate
```
python3 "$HOME/.claude/kit/scripts/validate_docs.py" docs/specs/<slug>.md --repo "$PWD"
python3 "$HOME/.claude/kit/scripts/lane.py" precheck <slug> --repo "$PWD"
```
`precheck` is expected to fail only on "needs 'approved'" and "no approval line" at this point. Any other reason (open questions, overlap, invalid spec) goes back to the planner. Repeat until those are the only two.

## Step 5: hand to the human
```
python3 "$HOME/.claude/kit/scripts/lane.py" roadmap-set <slug> waiting-approval --repo "$PWD" --spec docs/specs/<slug>.md
```
Commit `docs/specs/<slug>.md`, `docs/research/*`, `ROADMAP.md` on a branch `spec/<slug>` and open a PR titled `spec: <feature>` whose body is the spec's Summary section. Tell the human: to approve, set `Status: approved`, fill `Approved by: <name> on <date> at <commit>`, and merge. Nothing is built before that.
