---
description: Begin a feature the right way: a short discussion until the human and Claude agree on the end goal, then a goal file, a roadmap row, and a hand-off to /run. Use this instead of describing a feature in plain chat.
argument-hint: <what you want, in one sentence>
allowed-tools: Read, Write, Bash, AskUserQuestion
---

Start a feature. The human said: $ARGUMENTS

## Step 1: understand before anything else
Read `ROADMAP.md`, `ARCHITECTURE.md`, and skim `docs/goals/` so you do not propose something that exists or conflicts. Then ask, one question at a time, only what is still unclear:
- What does the end state look like when this is done? (observable, not "it works")
- Who or what benefits, and how will they notice?
- What is explicitly not part of this?
- Constraints: things that must not change, must be used, deadlines, performance, compatibility.
- Anything the human is assuming that the code might not support?

Push back when the goal is too large for one lane (more than ~5 done-criteria or more than a few files): propose a split and let the human choose. Push back when a stated outcome is not observable; rewrite it together until it is.

Stop asking when you can write every section of the goal template without inventing anything. Usually three to six questions.

## Step 2: agree
Show the human the filled `## Done looks like` and `## Not in this goal` lists and ask: "Is this the end goal, exactly?" Iterate until they say yes. Do not proceed on "sounds good" to a vague list.

## Step 3: record
- Choose a slug (kebab-case, ≤ 40 chars). Write `docs/goals/<slug>.md` from `~/.claude/kit/templates/goal.md` with `Status: agreed` and the agreed-by line.
- Add the feature to `ROADMAP.md` Features table (`| <feature> | <slug> | <milestone> | queued | — | — | — |`) and to the `## Queue` list (ask where in the order if other items are queued). Then confirm the system sees it: `node "$HOME/.claude/kit/scripts/lane.js" next-step <slug> --repo "$PWD"` must answer `research`.
- Commit both on a branch `goal/<slug>`, push, open a PR titled `goal: <feature>`, and merge it (docs only; the human's agreement in this conversation is the approval).

## Step 4: hand off
Ask: "Run it now (`/run <slug>`), queue it for later, or stop here?" On "run", invoke `/run <slug>`. Do not start research or write a spec inside this command.
