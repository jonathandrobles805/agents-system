---
description: "A change to the declared architecture or design model: start it as work type `architecture` and carry it through the `architecture` workflow profile (kit/workflows/architecture.json). The controller decides every stage from files; this command only classifies and hands off."
argument-hint: "<what you want, in one sentence>"
---

A change to the declared architecture or design model. The human said: the arguments

## What this kind of work is

Research, propose, critique, human approval; the approved model is then implemented as ordinary lanes. The only route that may change `architecture/model.yaml` or `design/system.yaml`.

Profile `architecture`: `start → research → plan → approve → lane → build → review → wait-merge → done`. Human pauses: approve, wait-merge.

## Step 1: classify, then start

Follow `/kit start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: architecture
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `node "$HOME/.claude/kit/scripts/validate_docs.js" docs/goals/<slug>.md --repo "$PWD"`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

Run the loop in SKILL.md for `<slug>` (what `/kit <slug>` does). The loop asks `lane.js next-step`, which reads the profile and names the one agent allowed for each stage (`lane.js agent-for architecture <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
