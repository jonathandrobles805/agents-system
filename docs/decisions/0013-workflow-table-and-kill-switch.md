# 0013 One workflow table routes every kind of work; the goal carries work type, risk and size; the kill switch is checked at every entry point

Date: 2026-11-11

## Context
Until now the kit had one route: research → plan → approve → tests → build → review → merge → retro. A one-line fix and a schema migration got the same stages; a UI tweak triggered research; nothing could stop every lane at once. The operating model (§4) calls for a version-controlled table keyed by kind of work, a `size` that scales effort without touching safety, a router for users who do not know the kind, and one kill switch.

## Decision
1. `kit/workflows/<work_type>.json` is the only source of stages, allowed agents, human pauses, size gating and risk additions. `lane.js next-step` keeps deriving position from files and git, then maps it onto the profile. Unknown type: refused. Unlisted agent for a stage: refused. KIT-SPEC §10.12.
2. The goal file carries `Work type`, `Risk`, `Size`, `Domain`. Defaults (`feature`, `normal`, `M`) keep every existing goal on today's route, so nothing breaks for a project that never fills them in.
3. One command per kind (`/new-feature`, `/fix`, `/ui`, …) is a thin wrapper that classifies and hands off to `/start` + `/run`. `/work` routes provisionally to `fix`; the debugger's `cause:` line re-routes to `incident` or `refactor`, written by the controller and logged, never by the command.
4. The debugger is a read-only agent (tests and the progress file only): diagnosis and correction are separate roles.
5. `lane.js stop --by --reason` and `resume-all --by`: every entry point (hooks, `next-step`, `start`, launcher) checks the flag; the flag alone does nothing. KIT-SPEC §10.13.

## Alternatives rejected
- Letting the orchestrating command pick stages by judgment: that is the dynamically invented workflow the operating model forbids (constraint 2).
- Asking the user to classify every time: `/work` exists so the evidence classifies when the words do not.
- A stop flag that only the orchestrator reads: a running lane's hooks would keep allowing edits; each enforcement point must check it.

## Consequences
- Planted faults 34–38. Existing lane tests pass unchanged, which is the proof that defaults preserve the old route.
- The physical lane artifact tree (2d-ii) and the workflow *skills* per kind (with `criteria` sections) remain to be written; step 7 ships the table, commands and debugger. Workflow skills land with step 8's skills library, since they share the deployment path.
