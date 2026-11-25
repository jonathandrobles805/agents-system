---
name: zi-new-feature
description: "Starts a new capability as work type feature: research, plan, approval, tests, build, review, merge, retro. Use when the user wants something the product does not do yet."
argument-hint: "<what you want, in one sentence>"
allowed-tools: Read, Write, Bash, AskUserQuestion
---

A new capability. The human said: $ARGUMENTS

## What this kind of work is

Follow `/zi-start` exactly, then `/zi-run`.

Profile `feature`: `start → research → plan → approve → lane → test → build → review → wait-merge → retro → done`. Human pauses: approve, wait-merge, retro.

## Step 1: classify, then start

Follow `/zi-start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: feature
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `kit validate_docs docs/goals/<slug>.md --repo .`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

`/zi-run <slug>`. The loop asks `kit lane next-step`, which reads the profile and names the one agent allowed for each stage (`kit lane agent-for feature <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
