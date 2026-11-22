---
name: zi-fix
description: "Starts a fix for a described bug as work type fix: reproduce, spec, approval, tests, build, review, merge, retro. Use when something is broken and the symptom can be described."
argument-hint: "<what you want, in one sentence>"
allowed-tools: Read, Write, Bash, AskUserQuestion
---

A defect with a symptom you can describe. The human said: $ARGUMENTS

## What this kind of work is

The lane opens from the agreed goal alone. Inside it, the debugger reproduces and localizes (it writes only the progress file, ending with a `cause:` line); the planner writes a short spec from the goal and the reproduction; you approve it; then the usual test → build → review. No research stage. If the debugger's report says the service does not boot or the suite cannot run, the controller re-routes to `incident`; if it finds a design fault, to `refactor`.

Profile `fix`: `start → lane → reproduce → plan → approve → scope → test → build → review → wait-merge → retro → done`. Human pauses: approve, wait-merge.

## Step 1: classify, then start

Follow `/zi-start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: fix
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `kit validate_docs docs/goals/<slug>.md --repo "$PWD"`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

`/zi-run <slug>`. The loop asks `kit lane next-step`, which reads the profile and names the one agent allowed for each stage (`kit lane agent-for fix <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
