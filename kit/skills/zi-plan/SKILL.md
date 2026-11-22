---
name: zi-plan
description: "Writes the spec for a feature: the planner drafts it, open unknowns are researched, the spec critic reviews it, and it is validated. Refuses at the WIP limit, on file overlap, or with too little research. Use when the research for a feature is done; the human approves the spec afterwards."
argument-hint: "<feature slug>"
allowed-tools: Bash, Read, Agent
arguments: [slug]
---

Plan feature: `$slug`

## Step 1: preconditions
```
kit lane wip --repo "$PWD"
```
If exit code is 2, stop: the WIP limit is reached. Say which lanes are in flight and what the human can merge or escalate.

Confirm the slug has a row in `ROADMAP.md` and at least one research file in `docs/research/INDEX.md` whose keywords match. If there is no research, stop and tell the human to run `/zi-research $slug` first. Planning without research is guessing.

## Step 2: plan
Spawn the `planner` agent with: the slug, the research slugs, the paths of `ARCHITECTURE.md`, `DESIGN.md`, `LESSONS.md`, `ROADMAP.md`, and the list of other specs under `docs/specs/`. It writes `docs/specs/$slug.md`. It lists its unknowns; it does not resolve them itself. Step 2b decides what happens to them.

## Step 2b: unknown budget (script decides, not the planner)
```
kit lane unknowns docs/specs/$slug.md --repo "$PWD" --json
```
- exit 2 (`research`): more than 3 unknowns. Stop. Tell the human which questions are open and that `/zi-research $slug` must run again. Do not continue to critique.
- exit 3 (`resolve`): 1–3 unknowns. For each item spawn a `researcher` with the item's `Resolve by` method (an item without a method goes back to the planner first). Then re-run the planner with the answers and run this step again.
- exit 0 (`none`): continue.

## Step 3: critique
Spawn `spec-critic` on `docs/specs/$slug.md`. Then spawn the `planner` again with the instruction "answer each Critique item inline (C1 → response) and amend the spec where the critic is right; do not delete critique items". Up to two rounds.

## Step 4: validate
```
kit validate_docs docs/specs/$slug.md --repo "$PWD"
kit lane precheck $slug --repo "$PWD"
```
`precheck` is expected to fail only on "needs 'approved'" and "no approval line" at this point. Any other reason (open questions, overlap, invalid spec) goes back to the planner. Repeat until those are the only two.

## Step 5: hand to the human
```
kit lane roadmap-set $slug waiting-approval --repo "$PWD" --spec docs/specs/$slug.md
```
Commit `docs/specs/$slug.md`, `docs/research/*`, `ROADMAP.md` on a branch `spec/$slug`, then `kit lane publish $slug --repo "$PWD" --branch spec/$slug --title "spec: <feature>" --body-file <a file holding the spec's Summary section, e.g. /tmp/$slug-summary.md>`: it pushes the branch and opens the PR as the kit's GitHub App (never with your login) and prints the PR URL. Tell the human: to approve, set `Status: approved`, fill `Approved by: <name> on <date> at <commit>`, and merge, or say "merge" and you run `kit lane merge --pr <url> --by <name>`, which waits for CI. Nothing is built before that.
