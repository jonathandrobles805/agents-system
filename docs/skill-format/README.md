# Skill format

Rewriting the 23 `zi-` skills so each is short, clean and built the same way, following Anthropic's
[skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

- Branch: `docs/skill-format` (its own worktree, `../agents-system-skills`)
- Status: interview in progress
- Decisions: [decisions.md](decisions.md), each with its reason, newest last

## Why

- Too dense: `zi-run` is 48 lines but 9,644 characters, and 20 lines across the skills are over 400 characters.
- No reference files: every detail sits in `SKILL.md`.
- The same rule is written in several places (skill, agent, workflow JSON), so Claude can't tell which one wins.
- Missing per-command sections (run, resume, stop, schedule) that the reference factory skill has.

## How to add a decision

Add a numbered entry to `decisions.md`: what was chosen, why, who decided, and what was rejected.
Never edit an old entry; add a new one that replaces it and say which one.
