---
name: zi-architecture
description: "Starts a change to the declared architecture or design model as work type architecture: research, plan, approval, build, review, merge. Use when the structure of the system should change."
argument-hint: "<what you want, in one sentence>"
allowed-tools: Read, Write, Bash, AskUserQuestion
---

A change to the declared architecture or design model. The human said: $ARGUMENTS

## What this kind of work is

Research, propose, critique, human approval; the approved model is then implemented as ordinary lanes. The only route that may change `architecture/model.yaml` or `design/system.yaml`.

Profile `architecture`: `start → research → plan → approve → lane → build → review → wait-merge → done`. Human pauses: approve, wait-merge.

## Step 1: classify, then start

Follow `/zi-start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: architecture
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `kit validate_docs docs/goals/<slug>.md --repo .`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

`/zi-run <slug>`. The loop asks `kit lane next-step`, which reads the profile and names the one agent allowed for each stage (`kit lane agent-for architecture <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
