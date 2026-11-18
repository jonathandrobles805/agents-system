---
description: "Bring the current worktree up to date with the default branch and run the tests. Conflicts are reported, not auto-resolved beyond one attempt."
---

Run in the current worktree:
```
bash scripts/sync.sh
```
- Exit 0: report "up to date, tests pass".
- Exit 3 (conflict): list the conflicting files. If a lane is active and this is its first conflict, the implementer may resolve it (it counts as one of the 3 attempts; record it under Uncertainties in progress.md). Otherwise write an Escalation and stop.
- Tests fail after a clean merge: that is a real integration failure. Record it in `.claude/session/<slug>.log` by running the test command through the normal hook path (edit nothing), and treat it as a failed attempt for the implementer.

Never use `--force`, `reset --hard`, or `checkout -- .` to make a conflict go away.
