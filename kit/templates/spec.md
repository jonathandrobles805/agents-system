# Spec: {{feature}}

- Slug: {{slug}}
- Date: {{date}}
- Commit: {{commit}}
- Research: {{comma-separated research slugs}}
- Risk: {{low|high-risk}}
- Status: {{draft|waiting-approval|approved|building|in-review|merged}}

## Summary

<!-- One screen. The approver reads only this if pressed for time. -->

- Goal: {{one sentence}}
- Files changed: {{count}} ({{list of the most important}})
- Risks: {{top 1-3}}
- Done when: {{the done-criteria in one line each}}
- Open questions: {{none | list}}

## Goal

{{what and why, 3-6 sentences}}

## Non-goals

- {{explicitly out of scope}}

## Files to read first

<!-- The implementer must read every file here before any edit. guard-edit enforces it. -->

- `{{path}}` — {{why}} [verified: {{path}}:{{start}}-{{end}}]

## Files to change

<!-- The allow-list. Edits outside this list are blocked. Name the extension point, not just the file. -->

- `{{path}}` — {{what changes, where in the file}} [verified: {{path}}:{{start}}-{{end}}]

## Files to create

- `{{path}}` — {{purpose}}

## Impact analysis

<!-- For every existing symbol that changes: every caller, with file:line. Produced by grep/LSP, not memory. -->

- `{{symbol}}` is called from: `{{path}}:{{line}}`, `{{path}}:{{line}}` [verified: cmd]
  ```
  {{the grep or references command and its output}}
  ```

## Approach

{{how, referencing tagged findings and the files above}}

## Data changes

- {{none | migration name — reversible: yes/no — rollback: how}}

## New dependencies

- {{none | package@version — why}}

## Done-criteria

<!-- Each criterion maps to exactly one test name that does not exist yet. For non-code features, name the artifact and the checklist instead. -->

| # | Criterion | Test (or artifact + checklist) |
|---|---|---|
| D1 | {{observable behavior}} | `{{test file}}::{{test name}}` |

## Assumptions

<!-- Each is tagged. An untagged assumption is an open question. -->

- A1. {{assumption}} [verified: {{path}}:{{start}}-{{end}}]

## Open questions

<!-- Must be empty before approval. /zi-implement refuses otherwise. -->

- {{none}}

## Architecture checklist

<!-- Copied from ARCHITECTURE.md by the planner. Each item answered. -->

- [ ] {{invariant}} — {{how this spec respects it}}

## Critique

<!-- Written by spec-critic. Numbered gaps and contradictions. The planner answers each inline. -->

- C1. {{gap}} → {{planner response}}

## Approval

<!-- Nobody writes this section. The owner approves the spec by saying yes to merging its spec/<slug> PR (kit lane merge), and lane.js records who, when and the merged commit in the lane store. A name written here approves nothing. -->

Approved by: — (recorded by kit lane merge when the owner merges the spec PR)
