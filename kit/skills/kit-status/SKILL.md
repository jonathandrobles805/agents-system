---
name: kit-status
description: "Use when you want to know where every feature stands and what is waiting for you. Shows positions, what needs you, lane drift, debt and stale research, all read from files and git."
argument-hint: "[--all]"
allowed-tools: Bash
---

```
node "$HOME/.claude/kit/scripts/kit_status.js" --repo "$PWD" $ARGUMENTS --out .claude/session/status.json
```
Print the output as-is. Then, in at most three lines, say what the human should do next, in this order: escalations first, then specs waiting for approval, then PRs ready to merge, then stale research or branches behind the default branch. If nothing needs them, say so and name the next queued feature `/kit plan` would pick.

Do not add information that is not in the output.
