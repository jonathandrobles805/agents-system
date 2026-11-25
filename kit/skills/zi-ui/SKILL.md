---
name: zi-ui
description: "Starts a change to a screen or its style as work type ui, checked against the design model; at size L it runs as a feature. Use when the change is to what the user sees."
argument-hint: "<what you want, in one sentence>"
allowed-tools: Read, Write, Bash, AskUserQuestion
---

A user-interface change against the design model. The human said: $ARGUMENTS

## What this kind of work is

No research at size S or M: inspect, build, visual and accessibility verification, review. At size L the lane takes the feature shape (research, plan, critique, approval).

Profile `ui`: `start → inspect → lane → build → verify-ui → review → wait-merge → done`. Human pauses: wait-merge.

**Not built yet.** At size S and M nothing runs the `inspect` and `verify-ui` stages yet; size L runs as a feature and is not affected. `kit lane next-step` and `kit lane start` refuse this work type with that reason (#57-#59); building it is on the hardening plan's to-do list. Tell the human so before writing a goal, and stop unless they want the goal recorded for later.

## Step 1: classify, then start

Follow `/zi-start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: ui
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `kit validate_docs docs/goals/<slug>.md --repo .`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

`/zi-run <slug>`. The loop asks `kit lane next-step`, which reads the profile and names the one agent allowed for each stage (`kit lane agent-for ui <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
