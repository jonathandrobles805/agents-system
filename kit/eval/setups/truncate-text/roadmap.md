# Roadmap

- Kit version: 0.3.0
- WIP limit: set in `.claude/kit.json` (`wip_limit`, or `max_concurrent_lanes` when present) and enforced from there. Run `lane.js wip` for the live count. Deliberately not repeated here: this file is human-owned, so a number written at bootstrap is never refreshed and would drift from the one that actually stops a lane opening.
- Updated: 2026-11-22

## Milestones

| # | Milestone | Target | Status |
|---|---|---|---|
| M1 | Readable lists | 2026-12 | active |

## Features

<!-- Status values: queued, researching, planning, waiting-approval, building, in-review, escalated, ready-to-merge, merged, dropped. Only edited on main. -->

| Feature | Slug | Milestone | Status | Spec | Lane | PR |
|---|---|---|---|---|---|---|
| Truncate long titles | truncate-text | M1 | queued | — | — | — |

## Queue

<!-- Order in which /zi-plan picks the next feature when a lane frees up. -->

1. truncate-text
