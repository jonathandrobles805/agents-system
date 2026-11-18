---
name: zi-incident
description: "Starts the handling of a production incident as work type incident: reproduce, spec, approval, tests, build, review, merge, retro. Use when production is broken."
argument-hint: "<what you want, in one sentence>"
allowed-tools: Read, Write, Bash, AskUserQuestion
---

Production is broken. The human said: $ARGUMENTS

## What this kind of work is

Triage, contain, diagnose (debugger), recover, verify, retrospective.

Profile `incident`: `start → lane → reproduce → plan → approve → scope → test → build → review → wait-merge → retro → done`. The lane opens from the goal; the debugger works inside it; the planner writes the recovery spec; a human approves it. Human pauses: approve, wait-merge, retro.

## Step 1: classify, then start

Follow `/zi-start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: incident
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `node "$HOME/.claude/kit/scripts/validate_docs.js" docs/goals/<slug>.md --repo "$PWD"`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

`/zi-run <slug>`. The loop asks `lane.js next-step`, which reads the profile and names the one agent allowed for each stage (`lane.js agent-for incident <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
