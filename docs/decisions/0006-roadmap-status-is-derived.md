# 0006 Lane position is derived; ROADMAP.md status is a record, not the source

Date: 2026-11-08

## Context
The spec says ROADMAP.md is edited only on main, but a lane needs to show it is building before anything reaches main, and an agent-written status is exactly the kind of claim the kit refuses to trust.

## Decision
`kit-status` derives each feature's position from facts: the spec and its approval line, the worktree and lane.json, progress.md (criteria refs, Escalation), the review report (validity, verdict, reviewed commit), git (HEAD, behind/ahead). ROADMAP.md's status column is updated by `lane.js` at fixed points (waiting-approval, building, in-review, ready-to-merge, escalated, merged) inside the lane branch or at merge, and `ci_scope_diff` allows ROADMAP.md changes on lane branches. When the two disagree, the derived position wins and the dashboard shows it; the ROADMAP column is for reading the file on main.

## Alternatives rejected
- Agents write status: unverifiable.
- ROADMAP only on main via direct commits: violates no-direct-push.

## Consequences
A review report must name the commit it reviewed (`- Head:`); a later commit that touches anything other than the report, lane-owned docs, or tests drops the lane back to in-review automatically.
