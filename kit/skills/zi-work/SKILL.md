---
name: zi-work
description: "Starts work whose kind is unknown as a provisional fix; the debugger's evidence then settles whether it is a fix, an incident or a refactor. Use when something is wrong and the kind of work is not clear."
argument-hint: "<the symptom or wish, in your own words>"
allowed-tools: Read, Write, Bash, AskUserQuestion
---

Work: $ARGUMENTS

## Step 1: one question at most

Read the words. If they clearly name a kind of work, use that command instead and say so: a new capability → `/zi-new-feature`; something broken → `/zi-fix`; a screen or style → `/zi-ui`; "why does", "how does", "where is" → `/zi-investigate`; production down → `/zi-incident`; a schema or data move → `/zi-migrate`; a security concern → `/zi-security`; a restructure with no behaviour change → `/zi-refactor`; docs → `/zi-docs`.

If the words are ambiguous between two kinds, ask **one** question with two options. Otherwise do not ask.

## Step 2: route provisionally to fix

Write the goal through `/zi-start` with:

```
- Work type: fix (provisional)
- Risk: {{normal|high}}
- Size: M
- Domain: {{comma-separated domains this touches}}
```

Size is M, never S, when the scope is unknown: S promises one domain and no interface, schema, data or dependency change, which nobody can promise before the debugger has looked. Then `/zi-run <slug>`.

## Step 3: the evidence decides

The `fix` profile begins with the debugger, read-only. Its report ends with one line the controller reads:

- `cause: single defect in <file>` → stays `fix`.
- `cause: boot failure` or `cause: suite cannot run` → the controller rewrites the goal to `Work type: incident` and continues under that profile.
- `cause: design fault across <n> callers` → `Work type: refactor`; a spec is now required before any change.

You never rewrite the work type yourself; `kit lane next-step` reports `rerouted` with the new profile, and you continue the loop. Every profile still ends in tests, review and the human's merge, so a misroute costs time, never safety.
