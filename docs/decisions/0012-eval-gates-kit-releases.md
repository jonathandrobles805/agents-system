# 0012 Agent, skill, template and workflow changes are measured by the eval harness before release

Date: 2026-11-10

## Context
A one-word change in an agent prompt can remove a behaviour the whole system depends on (write the failing test first; tag every claim) and no unit test notices, because prompts are not code. The planted-fault suite proves the scripts; nothing proved the agents.

## Decision
1. `kit/eval/` holds benchmark tasks as files, a harness, a scorer, and committed baselines per kit version. KIT-SPEC §11A.
2. Mechanical checks are hard metrics and block on their own; the rubric judge grades the end state, never the transcript, with the task's calibration examples.
3. A smoke set runs on every kit PR that touches agents, skills, templates, the workflow table or the eval itself; the full set runs weekly and before a tag, and a regression beyond the baseline's variance blocks the tag.
4. Two runners: `claude` (headless session, sandboxed fixture, the kit installed) and `fixture` (replays recorded outputs). The runner is recorded with every result; fixture results are never baselines. The kit's own tests use the fixture runner, so the harness is proven without an API key; the gate in CI requires the key and fails loudly without it rather than passing by skipping.

## Alternatives rejected
- Reviewing prompt diffs by eye: that is how the red-run rule gets lost.
- Grading transcripts: agents narrate success; only files and git show it.
- Skipping the eval when the key is missing: a gate that passes when it cannot run is not a gate.

## Consequences
- Planted faults 32 (prompt edit that skips the red run → smoke fails) and 33 (seeded quality drop → regression → tag blocked), both proven with the fixture runner.
- A credential must be added as a repository secret before the first PR that touches a gated path can go green: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (the owner's subscription; preferred) or `ANTHROPIC_API_KEY` (billed per token). The token is tied to the person who generated it and lasts about a year. Locally, the eval uses the logged-in session and needs neither.
- The full set runs weekly rather than nightly, because on a subscription it shares the owner's usage limits.
- Baselines are committed files; the weekly run proposes, a human commits.
