---
name: zi-status
description: "Shows where every feature stands and what is waiting for the human: positions, lane drift, debt and stale research, all read from files and git. Use to see the state of the work."
argument-hint: "[--all]"
allowed-tools: Bash
---

```
kit kit_status --repo "$PWD" $ARGUMENTS --out .claude/session/status.json
```
Print the output as-is. Then, in at most three lines, say what the human should do next, in this order: escalations first, then specs waiting for approval, then PRs ready to merge, then stale research or branches behind the default branch. If nothing needs them, say so and name the next queued feature `/zi-plan` would pick.

Do not add information that is not in the output.
