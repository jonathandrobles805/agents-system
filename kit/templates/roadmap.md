# Roadmap

- Kit version: {{version}}
- WIP limit: set in `.claude/kit.json` (`wip_limit`, or `max_concurrent_lanes` when present) and enforced from there. Run `lane.js wip` for the live count. Deliberately not repeated here: this file is human-owned, so a number written at bootstrap is never refreshed and would drift from the one that actually stops a lane opening.
- Updated: {{date}}

## Milestones

| # | Milestone | Target | Status |
|---|---|---|---|
| M1 | {{milestone}} | {{date or sprint}} | {{planned|active|done}} |

## Features

<!-- Status values: queued, researching, planning, waiting-approval, building, in-review, escalated, ready-to-merge, merged, dropped. Only edited on main. -->

| Feature | Slug | Milestone | Status | Spec | Lane | PR |
|---|---|---|---|---|---|---|
| {{feature}} | {{slug}} | M1 | queued | — | — | — |

## Queue

<!-- Order in which /plan picks the next feature when a lane frees up. -->

1. {{slug}}
