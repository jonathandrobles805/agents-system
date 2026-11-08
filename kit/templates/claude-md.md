# {{project}}

Kit: agent-kit {{kit_version}} · bootstrapped {{date}}

## Read first, every session
- `ROADMAP.md` — what is in flight and what is next
- `ARCHITECTURE.md` — boundaries that must not break
- `LESSONS.md` — top section is debt: rules not yet enforced by a check
- The spec for the current lane, if `.claude/kit.json` names one

## Rules the hooks enforce (listed so you know why an action was blocked)
- Read a file before editing it.
- Edit only files the current spec lists.
- Tests before code; a red run must exist before a green one.
- No reads of `.env*`, keys, or credential directories.
- No force pushes, no edits to `.claude/`, no destructive commands.
- Every claim in a research file, spec, or review carries a provenance tag.

## Rules not yet enforced by a check (keep this list short; move items to hooks)
- {{none}}

## Project map
- `{{dir}}/` — {{what lives here}}

## Commands
- test: `{{test_cmd}}` · typecheck: `{{typecheck_cmd}}` · lint: `{{lint_cmd}}`
