# 0012 Agent, skill, template and workflow changes are measured by the eval harness before release

Date: 2026-11-10

## Context
A one-word change in an agent prompt can remove a behaviour the whole system depends on (write the failing test first; tag every claim) and no unit test notices, because prompts are not code. The planted-fault suite proves the scripts; nothing proved the agents.

## Decision
1. `kit/eval/` holds benchmark tasks as files, a harness, a scorer, and committed baselines per kit version. KIT-SPEC §11A.
2. Mechanical checks are hard metrics and block on their own; the rubric judge grades the end state, never the transcript, with the task's calibration examples. *Narrowed in the fifth eval review round (PR #105): the judge also gets the Bash commands the worker ran with the output Claude Code handed back, taken from its transcript and redacted, and the lane's check log, so it can grade whether a review's evidence supports its row. The agent's own narration is still never given.*
3. A smoke set runs on every kit PR that touches agents, skills, templates, the workflow table or the eval itself; the full set runs weekly and before a tag, and a regression beyond the baseline's variance blocks the tag. *Where the smoke set runs in CI is superseded by [0016](0016-direction-vs-reference-factory.md) E.11 item 3: on `main` after the merge, never on a pull request.*
4. Where it runs is the owner's choice: locally under the logged-in session by default (subscription, no key), in CI only when a credential secret is present; the CI step passes with a notice otherwise. Only the fixture self-check is mandatory in CI. *Superseded by 0016 E.11 item 3: in CI the credential comes from the `main` environment, the `main` and weekly jobs fail without it, and no credential reaches a pull request.*
5. Two runners: `claude` (headless session, sandboxed fixture, the kit installed) and `fixture` (replays recorded outputs). The runner is recorded with every result; fixture results are never baselines. The kit's own tests use the fixture runner, so the harness is proven without an API key; the gate in CI requires the key and fails loudly without it rather than passing by skipping.

## Alternatives rejected
- Reviewing prompt diffs by eye: that is how the red-run rule gets lost.
- Grading transcripts: agents narrate success; only files and git show it.
- Making the real-agent run mandatory in CI: it forces a credential into the repository for a kit with one owner who can run the same command locally under their subscription. The fixture self-check stays mandatory, so CI still proves the gate; the agent run is the owner's responsibility before merging.

## Consequences
- Planted faults 32 (prompt edit that skips the red run → smoke fails) and 33 (seeded quality drop → regression → tag blocked), both proven with the fixture runner.
- A credential secret is optional (*since 0016 E.11 item 3: required, as a secret of the `main` environment, for the `main` and weekly jobs*): `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (the owner's subscription; preferred) or `ANTHROPIC_API_KEY` (billed per token). The token is tied to the person who generated it and lasts about a year. Locally, the eval uses the logged-in session and needs neither.
- The full set runs weekly rather than nightly, because on a subscription it shares the owner's usage limits.
- Baselines are committed files; the weekly run proposes, a human commits.
