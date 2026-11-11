---
description: A defect with a symptom you can describe: start it as work type `fix` and carry it through the `fix` workflow profile (kit/workflows/fix.json). The controller decides every stage from files; this command only classifies and hands off.
argument-hint: <what you want, in one sentence>
allowed-tools: Read, Write, Bash, AskUserQuestion
---

A defect with a symptom you can describe. The human said: $ARGUMENTS

## What this kind of work is

The debugger reproduces and localizes first (read-only) and writes the failing test; no research or plan stage. If its report says the service does not boot or the suite cannot run, the controller re-routes to `incident`; if it finds a design fault, to `refactor` with a spec.

Profile `fix`: `start → reproduce → lane → test → build → review → wait-merge → retro → done`. Human pauses: wait-merge.

## Step 1: classify, then start

Follow `/start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: fix
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `node "$HOME/.claude/kit/scripts/validate_docs.js" docs/goals/<slug>.md --repo "$PWD"`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

`/run <slug>`. The loop asks `lane.js next-step`, which reads the profile and names the one agent allowed for each stage (`lane.js agent-for fix <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
