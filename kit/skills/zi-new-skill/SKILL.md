---
name: zi-new-skill
description: "Starts adding or changing a kit skill as work type skill-development. Its plan and build stages need the skill-smith agent, which does not exist yet (#59). Use when a kit skill should be added or changed."
argument-hint: "<what you want, in one sentence>"
allowed-tools: Read, Write, Bash, AskUserQuestion
---

A new or changed kit skill. The human said: $ARGUMENTS

## What this kind of work is

Kit-level: gap, research, draft by the skill-smith on a kit branch, review, eval against its tasks, human approval, versioned release. A skill is never installed by the agent that drafted it.

Profile `skill-development`: `start → research → plan → approve → lane → build → review → wait-merge → done`. Human pauses: approve, wait-merge.

**Not built yet.** The `skill-smith` agent its plan and build stages name does not exist yet. `lane.js next-step` and `lane.js start` refuse this work type with that reason (#57-#59); building it is on the hardening plan's to-do list. Tell the human so before writing a goal, and stop unless they want the goal recorded for later.

## Step 1: classify, then start

Follow `/zi-start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: skill-development
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `node "$HOME/.claude/kit/scripts/validate_docs.js" docs/goals/<slug>.md --repo "$PWD"`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

`/zi-run <slug>`. The loop asks `lane.js next-step`, which reads the profile and names the one agent allowed for each stage (`lane.js agent-for skill-development <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
