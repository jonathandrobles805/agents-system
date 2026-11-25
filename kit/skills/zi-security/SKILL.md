---
name: zi-security
description: "Starts work on a security finding or review as work type security, always at high risk. Use when there is a security finding or a security review to do."
argument-hint: "<what you want, in one sentence>"
allowed-tools: Read, Write, Bash, AskUserQuestion
---

A security finding or review. The human said: $ARGUMENTS

## What this kind of work is

Always high risk: threat model, second reviewer on a different model family, and a named human's security sign-off before merge (`kit lane signoff <slug> --by <name>`, recorded in the lane store for the lane's HEAD; a line in a file does not count). Requires the container sandbox runtime or a recorded waiver.

Profile `security`: `start → research → plan → approve → lane → test → build → review → security-signoff → wait-merge → retro → done`. Human pauses: approve, security-signoff, wait-merge, retro. Risk is forced to **high** by this profile.

## Step 1: classify, then start

Follow `/zi-start` exactly (understand before anything else; agree the goal; write `docs/goals/<slug>.md`), with these header fields set:

```
- Work type: security
- Risk: high
- Size: {{S|M|L}}
- Domain: {{comma-separated domains this touches}}
```

Size, from the goal's scope: **S** one domain, no interface/schema/data change, no new dependency; **M** two domains or one such change; **L** more, or unknowns the research cannot settle. Size changes research width and whether the critic runs; it never removes a stage risk adds. When unsure, choose the larger; the controller re-derives it from the spec and may only raise it.

Run `kit validate_docs docs/goals/<slug>.md --repo .`; a `goal-work-type`, `goal-risk` or `goal-size` violation means the header is wrong. Fix it, never remove the field.

## Step 2: hand off

`/zi-run <slug>`. The loop asks `kit lane next-step`, which reads the profile and names the one agent allowed for each stage (`kit lane agent-for security <stage>`). Spawn only that agent. If `next-step` returns `refused`, stop and show its reason; never pick a stage yourself.
