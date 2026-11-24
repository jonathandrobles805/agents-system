---
name: zi-sync
description: "Merges the default branch into a lane's worktree and runs the tests; a conflict is reported, with one attempt to resolve it. Use when a lane has fallen behind the default branch."
allowed-tools: Bash, Read
disable-model-invocation: true
---

Run in the current worktree:
```
bash scripts/sync.sh
```
- Exit 0: report "up to date, tests pass".
- Exit 3 (conflict): list the conflicting files. If a lane is active and this is its first conflict, the implementer may resolve it (it counts as one of the 3 attempts; record it under Uncertainties in progress.md). Otherwise write an Escalation and stop.
- Tests fail after a clean merge: that is a real integration failure. Record it by running the test command through `kit lane check <slug> sync "<test command>"`, quoted as one argument (edit nothing; never write `.claude/session/<slug>.log` by hand), and treat it as a failed attempt for the implementer.

Never use `--force`, `reset --hard`, or `checkout -- .` to make a conflict go away.
