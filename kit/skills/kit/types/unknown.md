---
description: "Use when you do not know what kind of work it is. Starts it as a provisional fix; the debugger's evidence then settles whether it is a fix, an incident or a refactor."
argument-hint: "<the symptom or wish, in your own words>"
---

Work: the arguments

## Step 1: one question at most

Read the words. If they clearly name a kind of work, use that work type instead and say so: a new capability → `/kit feature`; something broken → `/kit fix`; a screen or style → `/kit ui`; "why does", "how does", "where is" → `/kit investigation`; production down → `/kit incident`; a schema or data move → `/kit migration`; a security concern → `/kit security`; a restructure with no behaviour change → `/kit refactor`; docs → `/kit docs`.

If the words are ambiguous between two kinds, ask **one** question with two options. Otherwise do not ask.

## Step 2: route provisionally to fix

Write the goal through `/kit start` with:

```
- Work type: fix (provisional)
- Risk: {{normal|high}}
- Size: M
```

Size is M, never S, when the scope is unknown (KIT-SPEC 10.12). Then run the loop in SKILL.md for `<slug>` (what `/kit <slug>` does).

## Step 3: the evidence decides

The `fix` profile begins with the debugger, read-only. Its report ends with one line the controller reads:

- `cause: single defect in <file>` → stays `fix`.
- `cause: boot failure` or `cause: suite cannot run` → the controller rewrites the goal to `Work type: incident` and continues under that profile.
- `cause: design fault across <n> callers` → `Work type: refactor`; a spec is now required before any change.

You never rewrite the work type yourself; `lane.js next-step` reports `rerouted` with the new profile, and you continue the loop. Every profile still ends in tests, review and the human's merge, so a misroute costs time, never safety.
