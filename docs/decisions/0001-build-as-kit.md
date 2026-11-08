# 0001 Build as a kit in its own repository

Date: 2026-11-08

## Context
Rules, agents, and checks were previously recreated per project and drifted. Research and work lived in separate folders with no single source of truth.

## Decision
Build one versioned kit in this repository. Install once per machine into `~/.claude/`. Generate each project's layer with `/bootstrap`. Promote project lessons to the kit through versioned upgrades.

## Alternatives rejected
- Per-project setup by hand: drifts, cannot be upgraded, lessons do not transfer.
- A hosted service: adds infrastructure and a trust boundary for no gain at this scale.

## Consequences
Every project carries a kit version stamp. Changing a rule everywhere means one kit release plus `/bootstrap --upgrade` per project.
