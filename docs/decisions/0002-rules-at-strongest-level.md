# 0002 Rules live at the strongest level available

Date: 2026-11-08

## Context
Rules written only in CLAUDE.md or specs are skimmed under long context. Agents take the fastest path unless something fails.

## Decision
Every rule is placed at the strongest level that can hold it: code (hook, lint, test, CI, branch protection) over process (gate, fresh reviewer, retry limit) over text. Retro pushes text-only rules down. Text-only rules are tracked as debt in LESSONS.md.

## Alternatives rejected
- Longer, stricter prompts: does not survive compaction or long sessions.
- Trusting a careful model: carefulness is a trait and traits fail; hooks run every time.

## Consequences
More scripts to maintain. CLAUDE.md stays short because enforced rules leave it.
