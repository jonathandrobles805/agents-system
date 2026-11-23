# agents-system: hardening plan, built on decision 0016

2026-11-17, revised 2026-11-19 · Jonathan Robles

## Summary

This is the work order for [decision 0016](https://github.com/jonathandrobles805/agents-system/blob/main/docs/decisions/0016-direction-vs-reference-factory.md) (accepted) and [decision 0017](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0017-commands-to-skills.md) (accepted; 23 `zi-` skills). It follows 0016's migration in full and adds what today's reviews found it doesn't cover. Those additions are recorded in 0016 as amendments E.6–E.9. Additions are marked **(this plan)**.

**The model:** agents do the work; scripts decide what happens next; GitHub enforces green CI; CI re-checks what matters. The pipeline runs on its own up to a merge-ready PR. **Nothing merges without your yes:** Claude asks, you say yes, Claude merges.

**Your touchpoints:**

- Agree the goal with `/zi-start`.
- Say yes to merging the spec PR.
- Say yes to merging the code PR.

Agents push and open PRs through a GitHub App, never your account.

**What this plan adds to 0016:**

1. **A GitHub App as the agents' identity.** It is used only to push branches and open PRs, and may push only to `wt/*` (lane) and `spec/*` (spec) branches.
2. **A container for every lane that pushes,** attended or not, with limited network access.
3. **This repo follows the same merge rule as projects.**
4. **You approve a spec by saying yes to its merge, and `lane.js` records it in the store;** the spec file no longer needs an approval line.
5. **The required checks use the real CI job names.**
6. **The lane start stops if it can't fetch the base** (a repo with no remote must set `"local_only": true`).
7. **Extra gate checks:** protected files, containment, and a risk re-check against the actual diff.
8. **One watched real run, early.**
9. **Specialist reviewers** (0016 E.6), with a fixed first-line verdict.

**Settled on 2026-11-17:**

- automatic spec approval stays dropped;
- the license question is closed (personal, private use);
- the defaults for the bot identity, this repo and the output contract are confirmed.

## Decisions taken

All five were settled by you in chat on 2026-11-17. Each is compared with GitHub's documentation and with an enterprise system that solves the same problem: GitHub Copilot's coding agent, ITIL change management, and Anthropic's structured outputs.

| # | Decision | GitHub or enterprise practice | Where this plan stands |
| --- | --- | --- | --- |
| Q1 | **Agents' identity: a GitHub App,** used only to push lane and spec branches and open PRs. **Every lane that pushes runs in the container,** attended or not. | GitHub recommends a GitHub App for long-lived integrations, and its tokens are short-lived. Copilot's agent has its own identity, can push to one branch only, has restricted internet, and cannot approve or merge. | **Matches**, once the App is limited to `wt/*` and `spec/*` branches by a ruleset and the container limits network access. Both are in Steps 1 and 8. |
| Q2 | **This repo follows the same rule as projects.** The App opens its PRs; Claude merges them on your yes (0016 E.10). | GitHub: the author of a pull request cannot approve it. Copilot goes further: the person who asked for the PR cannot approve it either, which needs a second human. | **Below Copilot, by necessity.** A one-person project can't have a second reviewer. Your yes to each merge is the solo setup. Protecting this private, personally owned repo needs GitHub Pro. |
| Q3 | **Automatic spec approval: dropped.** Every spec pauses for you. | ITIL pre-approves only named, low-risk change types, through a catalogue of templates with a track record. | **Stricter than ITIL.** If it ever returns, model it as a short list of change types you pre-approve. |
| Q4 | **License: closed.** The kit is personal and private, and is not shared. | The GPL's duties apply when you convey copies to others; running the program or modifying a private copy is not conveying. Copyright protects expression, not ideas. | **Settled.** Revisit only before publishing or sharing the kit. Nothing is copied from Factory v2 anyway. |
| Q5 | **Output contract: pick up #56 S3 now.** Each reviewer's report starts with a fixed line, `<reviewer>: PASS` or `FAIL`, which the scripts check. The rest of S2–S8 stays open. | Factory v2's scripts refuse to advance without a fixed first line. Anthropic's structured outputs constrain a response to a schema. | **Matches Factory.** Structured output is the upgrade if misreads ever happen. |

## Evidence baseline

Repo links point to `main` at [`3a34247`](https://github.com/jonathandrobles805/agents-system/tree/3a34247f08515ed8f3b328f01bb9531970cbb222), checked 2026-11-17 22:50. Between `f1da557` (PR #54) and `3a34247` only docs changed, so every code line cited here is the same as at `f1da557`. Code has changed on `main` since (#62, #79, #80, #81); this baseline stays at `3a34247`, and later facts give their own commit.

**Checks on this code (at `3a34247`; on `main` at `4fa12cf`: 367 of 367 tests, 48 of 48 faults; after PR #90: 368 and 49):**

- `npm test`: 347 of 347 pass.
- `planted-faults/run.js`: 46 of 46 caught.
- On the skills branch, PR #62 (then a draft, merged since) reported 358 of 358 tests (as reported in #62, not re-run here).

**GitHub:**

- `main` is unprotected.
- The repo is private and owned by a personal account.
- PRs #54, #60 and #61 were opened and merged by your own account.

**The Bash guard against bypass commands** (`hook_guard_bash.js`, at `3a34247`; since #81 it blocks the first two when they start a command, while `env gh pr merge 1` still passes):

| Command | Result |
| --- | --- |
| `gh pr merge 1` | ALLOW |
| `gh api -X PUT repos/o/r/pulls/1/merge` | ALLOW |
| `cd $HOME/.claude/kit/scripts && echo x > hook_guard_bash.js` | ALLOW |
| `git push origin HEAD:main` | ALLOW |
| `git push --force origin main` | BLOCK |

**Issue #63 makes it worse.** The kit's skills keep full `Bash`, which pre-approves every shell command, `git push` and `gh pr merge` included. The kit's own permission rule may never match, because it names commands through `"$HOME"`. So green CI is enforced by GitHub and your yes by an `ask` rule (0016 E.10); the guard stays a guardrail.

**Outside facts this plan relies on** (GitHub's pages were opened in full on 2026-11-17; the GNU, ServiceNow and Anthropic lines come from search excerpts of their official pages):

- **GitHub Apps:** for a long-lived integration GitHub recommends building a GitHub App; GitHub Apps use short-lived tokens ([GitHub docs](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)).
- **Copilot's coding agent:**
    - it cannot mark its PRs ready, approve or merge;
    - the person who asked for a PR cannot approve it;
    - it can push to a single branch;
    - its internet access is restricted ([GitHub docs](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations)).
- **Protected branches:**
    - they need GitHub Pro, Team or Enterprise on private repos;
    - by default they don't bind admins, unless "Do not allow bypassing" is set;
    - an optional rule requires the most recent push to be approved by someone other than its pusher ([GitHub docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
- **Self-approval:** pull request authors cannot approve their own PRs ([GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)).
- **The GPL:** you have responsibilities if you distribute copies; to "convey" means enabling others to make or receive copies ([GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.en.html)).
- **ITIL:** a standard change is pre-authorized, low-risk, and follows a documented procedure from a catalogue of templates ([ServiceNow docs](https://www.servicenow.com/docs/r/it-service-management/change-management/change-types.html)).
- **Structured outputs:** they constrain a response to a schema for downstream processing ([Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).

## Where the kit stands today

Fifteen holes were open on `main` at `3a34247`; hole 14 has since closed (#62), and holes 4 and 6 are partly fixed (#81).

- **0016 and 0017 close 6:** holes 1, 3, 7, 8, 11 and 14.
- **This plan closes 5:** holes 2, 4, 5, 13 and 15.
- **Both together close 4:** this plan adds #56's rules to hole 12 (the gate), the GitHub App to holes 6 and 9, and the #63 fix to hole 10.

| # | Open hole | Evidence | Closed by | Step |
| --- | --- | --- | --- | --- |
| 1 | `lane.js stage` writes any stage | [lane.js L717–729](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L717-L729) | 0016 E.1 Add 1 | 2 |
| 2 | If the fetch fails or there is no `origin`, a lane quietly starts from local `main` | [lane.js L562–573](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L562-L573) | This plan | 2 |
| 3 | Protection is set with admin enforcement off, and code-owner review on CODEOWNERS paths | [bootstrap.js L1396–1400](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/bootstrap.js#L1396-L1400) | 0016 E.1 Add 4 | 1 |
| 4 | 7 of the 12 required checks are steps inside the `kit-checks` job, so they never report and protection would block every PR | [bootstrap.js L1578](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/bootstrap.js#L1578); [github.yml L81–109](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/ci/github.yml#L81-L109) | This plan | 1 |
| 5 | This repo's own `main` is unprotected | GitHub API | This plan (Q2) | 1 |
| 6 | Merging is only an instruction; the guard can be bypassed; skills keep full `Bash` | [run.md L23–28](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/commands/run.md#L23-L28); Evidence baseline; #63 | 0016 E.1 Add 4, plus the App (Q1) | 1 |
| 7 | The review round limit is only an instruction | [run.md L27](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/commands/run.md#L27) | 0016 E.1 Add 6 | 2 |
| 8 | Evidence is written inside the lane, and CI trusts the branch's copy | 0016 B.2 | 0016 E.1 Add 3 | 5 |
| 9 | Agents can reach your GitHub login; the credential scan only checks the lane's files | [lane.js L607](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L607); PRs #54, #60, #61 | 0016 E.1 Add 5 for unattended lanes; this plan for every lane that pushes (Q1) | 1, 8 |
| 10 | Every lane may run any kit script, and the kit's permission rule may not match at all because it names `"$HOME"` | [settings.project.json L8](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/hooks/settings.project.json#L8); #63 | 0016 E.4, plus #63's fix | 2 |
| 11 | Controller bugs: docs and ui lanes jump to done (#57); listed stages never run (#58); a missing agent (#59) | Issues #57–#59 | 0016 E.5 (filed for E.2) | 2 |
| 12 | No gate exists; #56 adds rules for it: fail on protected-file changes, and run contained with a time limit | Issue #56 S1.3, S1.4 | 0016 E.1 Add 2, plus #56 | 3 |
| 13 | One reviewer, plus a second security-focused pass at high risk | [review.md L17–18](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/commands/review.md#L17-L18) | E.6 (this plan) | 9 |
| 14 | 23 commands, not skills | 0017; PR #62, merged | 0017 | 0 |
| 15 | On macOS, Claude Code's docs say searches run through Bash, so the read guard may never see secret reads (not yet observed) | Issue #55 | This plan: a container for every lane that pushes | 8 |

**Already fixed on `main`** (these commits reached `main` through PR #54's squash merge `f1da557`):

- The date-dependent test (`e24b7df`).
- A red run must name its test as failing (`59d54ab`, #30).
- Hooks find the lane the same way everywhere (`4208aeb`, #29).
- A human's budget raise survives a stage change (`b3d4f54`, #41).

Issues #29, #30 and #41 are still open; check what's left in each before closing them.

## Design decisions

### D1. GitHub enforces you, through a GitHub App (0016 E.1 Add 4 and 5, plus Q1 and Q2)

**Where the App is used.** In exactly one layer: pushing a lane or spec branch and opening its PR.

- That step runs on your machine, outside the lane's container, with a short-lived App token. This follows 0016's "the push done host-side".
- **Not used for:**
    - local work, tests and the gate, which need no GitHub identity;
    - CI, which uses GitHub Actions' own token;
    - merging: Claude merges with your account through `kit merge`, on your yes (see "Merging on your word" below).

**What the App may do:**

- Write contents, pull requests and workflows, on the repos you install it on. Workflows lets it change `.github/workflows/` ([GitHub docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)).
- Because a pull request from a branch in the same repo runs its own workflow file with the repo's secrets ([GitHub Security Lab](https://securitylab.github.com/research/github-actions-preventing-pwn-requests)), the two Anthropic keys move into a GitHub environment limited to `main` ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)). The real-agent eval, today a pull-request-only step in `kit.yml`, moves to `main` and to the weekly workflow (`kit-eval-weekly.yml`); each job names the environment and fails when the keys are missing. Pull requests run the recorded-fixture eval only. This follows GitHub's default for its own agent, whose pull-request workflows wait for a person's approval ([GitHub docs](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)); that approval exists only for Copilot (0016 E.11).
- A ruleset lets it push only to `wt/*` branches, the kit's lane branches ([lane.js L559](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L559)), and `spec/*` branches, where specs are proposed ([plan.md L42](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/commands/plan.md#L42)). The ruleset restricts creating, updating and deleting every other branch, a tag ruleset stops it creating tags, and only you are on the bypass list. These rules sit in their own ruleset, apart from branch protection.
- It cannot merge: the ruleset lets only you update `main`.

**Branch protection, for projects and this repo alike:**

- The required checks use the real job names.
- "Do not allow bypassing the above settings" (`enforce_admins: true`).
- No force push and no deletion.
- No required approving review and no code-owner review: you say yes to each merge in Claude Code instead (0016 E.10). Bootstrap's code-owner review today ([bootstrap.js L1399](https://github.com/jonathandrobles805/agents-system/blob/main/kit/scripts/bootstrap.js#L1399)) is removed.
- This needs GitHub Pro, because the repo is private and personally owned.

**Merging on your word (owner decision, 2026-11-18; 0016 E.10).** You do not merge every PR by hand. Claude merges when you say so, with `lane.js merge` (#81): it waits until every required check has reported on the PR head and passed, and merges exactly that commit. Because it runs with your account, GitHub cannot tell it from you, so your word is enforced on your machine, not by GitHub:
- **CI green:** branch protection with the real job names and no bypass (Step 1), and `lane.js merge` refusing red or pending CI. `lane.js merge` was used on kit-test (PRs #7–#12, as reported); branch protection with no bypass is set since #92 (`enforce_admins: true`, read back) and was applied to kit-test and this repo on 2026-11-21; `lane.js merge` passes `--admin` (the ruleset bypass only) where `enforce_admins` is on (#98).
- **Your yes:** a Claude Code `ask` permission rule on the merge command, so Claude Code prompts you before every merge and the model cannot skip it. It needs the `kit` launcher from Step 2 (#63: rules naming `"$HOME"` do not match).
- **Still denied to every session:** an approving review, any other merge (`gh pr merge`, its `gh api` and GraphQL forms; the bash guard blocks them when they start a command, a guardrail, since prefixes such as `env` slip past), and changes to protection or rulesets.

**The approval line.** Today `lane.js` needs `Status: approved` and an approval line before a lane starts ([L375-L376](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L375-L376), [L502-L506](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L502-L506)). That changes: you approve a spec by saying yes to its spec PR's merge, and `lane.js` records who, when and the merged commit in the store, so the spec file no longer needs the line, and `/zi-plan`'s instruction to fill it changes too ([plan.md L42](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/commands/plan.md#L42)). No agent writes an approval.

**Fix and incident lanes.** Their planner writes the spec inside the lane. It is pushed the same way, as a `spec/<slug>` PR, and `lane.js scope` refuses until you have approved and merged it.

**Limit.** Copilot's model also blocks the person who asked for the PR from approving it. That needs a second human, which a one-person project doesn't have. Your yes is enforced on your machine by Claude Code, not by GitHub; green CI is enforced by GitHub.

### D2. One script moves the stage (0016 E.1 Add 1 and 6, E.4)

- **The store:** `lane.js advance` is the only writer of a store in the main checkout, using one table of allowed moves. The dashboard reads the store.
- **Rounds and time:** rounds and wall time replace tool-call budgets. A round is one build, gate and review cycle; a gate FAIL or a review FAIL ends it.
- **Who can call it (E.4):** lanes are no longer allowed to run the scripts that change state (`advance`, `gate`, `start`, merges).
- **#63 comes first.** The kit's permission rules name scripts through `"$HOME"`. A probe found that a skill rule naming a command through `"$PWD"` did not match, and the `"$HOME"` rule is untested and may not match either. So the narrowing needs #63's way out: a `kit` launcher on `PATH`, so rules can name exact commands. Each rule must be proven to match by a probe or a planted fault (#63's own rule).

### D3. The lane start stops if it can't fetch the base, unless the repo is local-only (this plan)

`lane.js start` refuses when the fetch fails or there is no `origin`, and records the base commit.

- **Local-only repos:** a repo with no remote must say so with `"local_only": true` in `kit.json`. A failed fetch is always refused.
- **Tests:** the `lane.test.js` fixtures, which start lanes with no `origin`, are updated in the same change.

### D4. The gate's extra checks (this plan, from #56)

On top of 0016's `lane.js gate` ([E.1 Add 2](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0016-direction-vs-reference-factory.md#L195)):

- **Protected files (#56 S1.3, plus `package.json` scripts and test config from 0016 E.1 Add 4):** the gate fails if the lane changed the spec after its approved commit, `kit.json`, `.claude/`, CI config, `package.json` scripts or test config.
- **Containment (#56 S1.4):** the checks run contained and non-interactive, with a time limit and stdin closed; only the exit code and output come back.
- **Risk re-check:** high-risk paths are matched against the actual diff. Today they are matched only by substring against the spec's file bullets ([validate_docs.js L494–500](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/validate_docs.js#L494-L500); defaults in [kitlib.js L27](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/kitlib.js#L27)), so a glob like `src/**` hides a billing change. A low-risk lane that touches a high-risk path is stopped for you.

### D5. Specialist reviewers and their verdict line (0016 E.6, plus #56 S3)

- **The reviewers:** the single reviewer is replaced by `code-reviewer` (always runs), `security-reviewer`, `ui-reviewer`, `ux-reviewer` and an optional `architecture-reviewer`.
- **Rulebooks:** each has a numbered rulebook that the writer is also given. A reviewer fails a change only by citing a rule ID or spec criterion plus `file:line`.
- **Routing:** a script picks the reviewers from the diff.
- **The verdict line (Q5):** every report's first line is `<reviewer>: PASS` or `<reviewer>: FAIL`. The scripts read that line, and refuse a report without it.
- **Names:** these are our own, not the reference's.
- **Targets:** issues #33, #34 and #49 (spec and review quality).

## The plan, in order

Twelve steps.

- **From 0016's migration** ([E.2](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0016-direction-vs-reference-factory.md#L201-L214)): Steps 1–3, 5–8 and 10.
- **From 0017:** Step 0.
- **From 0016's Consequences:** Step 11.
- **Added by this plan:** Steps 4 and 9.

Two rules hold throughout:

- Each step writes its planted faults *with* the step, and is not done until they pass.
- Nothing is deleted before its replacement passes its fault.

### Step 0. Finish the skills move (0017; PR #62, merged)

Steps 1–9 of the skills work are done on branch `commands-to-skills`: 23 `zi-` skills, install, version 0.3.0, and a tested rollback. The probe showed that a skill with `disable-model-invocation` does start under `claude -p`.

- [x] Run one real feature on a canary project (PR #62, its Step 10). Done on kit-test, twice: `footer-text` (PRs #1–#5) and `project-name-constant` (PRs #7–#12, all merged by `lane.js merge` with the 10 required checks green). Findings filed as #66–#77 and #82–#86.
- [x] Check that a flagged skill also starts when you type it (probe item U3 in PR #62's plan). Typed `/zi-bootstrap` ran on kit-test.
- [x] You review and merge PR #62, and the PR that adds 0016 E.6–E.9 (PR #65, branch docs/0016-amendments-e6-e8). Both merged.
- **Done when:** the canary run finishes. The headless check (`lane.js launch <slug> --exec` starts `claude -p "/zi-run <slug>"`) moves to Step 8, where lanes first run headless (0016 E.10).

### Step 1. Judge: GitHub enforces you (0016 step 1, plus D1)

- [x] Fix the matrix job names first (PR #90, planted fault 49): the kit must name each matrix value as GitHub reports it (`script unit tests (node 20)`, `(node 22)`), not `script unit tests (node ${{ matrix.node }})` ([pr_gate.js L26–48](https://github.com/jonathandrobles805/agents-system/blob/4fa12cf51030656bba5aef5c73522bfb95be965e/kit/scripts/pr_gate.js#L26-L48)). Until then `lane.js merge` on this repo stops after 30 minutes, and protection built from that name would block every PR (0016 E.11).
- [x] Use kit-test as the test project on GitHub (Step 0 ran there). Create the GitHub App (contents, pull requests and workflows: write), and install it on the test project and this repo. Done by the owner on 2026-11-19: `agents-system-bot`, App ID 5840689, installed on both; its private key stays on the owner's machine, outside every repo.
- [x] Move the Anthropic keys into an environment limited to `main` (done by the owner on 2026-11-19: environment `main`, deployment branch rule `main`, both secrets); move the real-agent eval from pull requests to `main` and the weekly workflow, each job naming the environment and failing when the keys are missing (PR #91: `eval-smoke-main` and the weekly `full` job declare `environment: main`; the PR job runs the recorded fixtures only). Proof: merged in `3d3cca2`; the first `eval-smoke-main` run on `main` went green with the credential from the environment ([run 44649476053](https://github.com/jonathandrobles805/agents-system/actions/runs/44649476053)); the repository has no repository-level secrets (owner's screenshot, 2026-11-20).
- [x] Add a ruleset so the App may push only `wt/*` and `spec/*` branches. Code in PR #93 (`agentRulesets` in bootstrap.js: `kit agent branches` restricts create, update and delete outside those patterns; `kit tags` the same for every tag; only the owner on the bypass list; both read back); proven when it runs on kit-test and the App's push to `main` is refused (done-when below). Proven 2026-11-21: applied to kit-test and this repo by the owner (both rulesets read back, only the owner as bypass); on kit-test the App's pushes to `main` and to `feature/protect-check` were refused with GitHub's `GH013 Repository rule violations`.
- [x] Set protection as in D1, with `enforce_admins` on. Build the required checks from the real job names (`kit-checks`, not its 7 steps; done since #81, [bootstrap.js L1578–1586](https://github.com/jonathandrobles805/agents-system/blob/4fa12cf51030656bba5aef5c73522bfb95be965e/kit/scripts/bootstrap.js#L1578-L1586)). Read the settings back from GitHub. Code done in PR #92 (`protectBranch` sends `enforce_admins: true`, no code-owner review; `readBackProtection` compares what GitHub holds and fails on any difference); running it on kit-test and this repo is the done-when below. Proven 2026-11-21: applied to kit-test (10 required checks) and this repo (3), read back `ok`; on kit-test #14 GitHub refused `gh pr merge --admin` while checks were pending ("10 of 10 required status checks are expected").
- [x] Rewrite planted fault 30, which tests the code-owner review 0016 E.10 removed, to test the ruleset and protection. Protection half in PR #92 (admin bypass and an unknown required check are planted against a fake `gh`; both refused; MISSED on the old code). Ruleset half in PR #93 (what is sent is checked; a second bypass actor is planted and refused; MISSED on the code before it).
- [x] The push-and-open-PR step runs on your machine with an App token. Code in PR #94: `lane.js publish <slug> [--branch spec/<slug>]` mints a ten-minute JWT from the App's key (`~/.claude/kit-app.json` or `KIT_APP_ID` + `KIT_APP_PRIVATE_KEY`, outside every repo), exchanges it for an installation token limited to that repository, pushes through `GIT_ASKPASS` and opens the PR under `GH_TOKEN`; `zi-implement`, `zi-run` and `zi-plan` call it instead of `git push` + `gh pr create` (planted fault 50). Proven when a lane on kit-test publishes as `agents-system-bot` (done-when below). Proven 2026-11-21: kit-test #13 and #14 were opened by `app/agents-system-bot` through `lane.js publish`. #98 made `lane.js merge` use the owner's ruleset bypass (`--admin`) where `enforce_admins` is on; kit-test #14 was then merged with it.
- **Done when, tested on the test project (and, for the merge, on this repo):**
    - GitHub refuses a merge while a required check is red or pending, admins included;
    - the App can't push to `main`, or to any branch outside `wt/*` and `spec/*`;
    - every required check reports on a test PR;
    - a required name that no job reports fails the read-back;
    - `lane.js merge` merges the App's green PR, on the test project and on this repo (the prompt before it comes in Step 2);
    - a workflow on an App branch cannot read the Anthropic keys, and the real-agent eval runs on `main`.
- **Done-when results (2026-11-21; kit-test results are from the owner's terminal output, as kit-test is not readable from the Claude session; this repo's were re-read from the session):** refused merge while pending, admins included: kit-test #14. App refused on `main` and outside `wt/*`/`spec/*`: kit-test, `GH013`. Every required check reported on a test PR: kit-test #13 (all 10). Read-back: matches on both repos, and an expected name GitHub does not hold fails it (live, this repo, run from the session); the reverse, a required name no job reports, is planted fault 30 and a test. `lane.js merge` merged the App's green PR: kit-test #14; on this repo: this PR, merged with `lane.js merge`. Keys: only the `main` environment holds them, no repository-level secrets, and PR jobs run fixtures only (#91). **Open:** the real-agent eval on `main` now runs agents on GitHub's runner (after #102–#103, `eval-smoke-main` run 45081939311): researcher, planner and retro 1.00; spec-critic 0.00; tester, implementer and reviewer 0.00 with hard violations. The low scores were the eval's, not the agents' (a run on the owner's Mac with full transcripts, 2026-11-22): four tasks named a spec, a lane and a review file the fixture did not have, and the agents rightly refused to invent them; every task ran as plain Claude rather than the kit's agent; `red_before_green` read an `event: 'test'` that no Bash call is ever logged as; and no transcript was kept. The fix is the eval-setup PR (`eval/measure-kit-agents`): those inputs made with `lane.js` for a low-risk feature (no high-risk waiver), each task run as its agent (`--agent`), test runs read from the hook events (the implementer credited with the tester's red run), the tester checked for a red run, no check that the setup alone satisfies (reviewer, retro), the judge given the session's own diff, and redacted transcripts uploaded with the report. Proof is the next `eval-smoke-main` run.

### Step 2. Spine: one script moves the stage (0016 step 2, E.4, E.5; plus D2, D3)

- [ ] Add `lane.js advance`, the table of allowed moves and the store. The dashboard reads the store. A progress cell containing `#` no longer moves a stage (#56).
- [ ] `lane.js` records your yes to the spec PR's merge in the store (D1, "The approval line").
- [ ] `lane.js` records a named human's security sign-off in the store; `next-step` and `lane.js merge` accept it (#58). Until then a lane that needs one cannot merge.
- [ ] Rounds and wall time move into the store. `lane.js stage` becomes a call to `advance`.
- [ ] Fix #63 first: add a `kit` launcher on `PATH`, prove with a probe that the new permission rules match, then narrow the lanes' rules (E.4) and the skills' `Bash` so lanes can't call `advance`, `gate`, `start` or a merge. Sessions outside the container keep `advance`, `gate` and `start`, and may merge only through `kit merge` behind an `ask` rule (D1, "Merging on your word"); they are denied an approving review, any other merge, and changes to protection or the ruleset (`gh pr review --approve`, `gh pr merge` and their `gh api` forms). Unattended lanes and the real-agent eval get their grants per run (`--settings` naming only what that run needs), since a headless session does not use a project's allow rules unless the folder was trusted, and a probe showed `--settings` rules approved in an untrusted repository (2026-11-22). Launcher, probe and the agents' commands: PR #103 (`kit` on PATH; `Bash(kit *)`; `kit lane template`); the probe on the owner's Mac (Claude Code 2.1.328, 2026-11-22) gave 7/7 as expected. The kit's gate commands in each project's `kit.json` (audit, boundaries): PR #104. The rules `/bootstrap` derives from a project's own commands (`Bash(npx vitest run *)`, …) are plain commands, not yet probed. Still to do here: the per-run settings, then the narrowing (which also ends `Bash(kit *)` approving a different tool called `kit`, such as KitOps, in a project that uses one).
- [x] Fix #57 (stages a profile lacks are refused, not mapped to done), #58 (listed stages are produced or removed, and `requires` blocks) and #59 (`skill-development` is refused until its agent exists). Code in PR #101, by the owner's choice on 2026-11-21 to refuse rather than build: `next-step` and `lane.js start` refuse docs, ui at S and M, investigation and skill-development (a stage nothing runs, or a missing agent); a stage with no equivalent is refused, never mapped to done; a high-risk lane that needs a security sign-off stops at `security-signoff` and `lane.js merge` refuses it, also when the PR is passed under another lane's slug, until the sign-off item above records it; the queue skips goals kept for later (planted fault 52). Merged in #101.
- [x] Make the lane start fail closed, with `local_only` (D3), and update the `lane.test.js` fixtures. PR #100 (`lane.js start` refuses a failed fetch and, unless `"local_only": true`, a missing `origin`; fetches the base with an explicit refspec; records `base_commit`; planted fault 51).
- **Done when:**
    - an illegal move is refused with a reason;
    - a round past the limit parks the lane;
    - a lane agent calling `advance`, `gate`, `start` or a merge is denied, as proven by a planted fault;
    - every shipped permission rule matches its command, as proven by a probe;
    - a session outside the container is denied an approval, any merge other than `kit merge`, or a change to protection or the ruleset, as proven by a planted fault;
    - `kit merge` prompts the human every time (the `ask` rule matches, as proven by the probe) and refuses red or pending CI;
    - the reproductions in #57–#59 behave as their issues require;
    - a lane start with a failed fetch is refused, and one with no `origin` is refused unless `local_only` is set.

### Step 3. Gate (0016 step 3, plus D4)

- [ ] Add `lane.js gate`:
    - it runs the commands from the base branch's `kit.json`;
    - its verdict is tied to the commit;
    - no reviewer starts on a FAIL;
    - it runs again after updating from the base, and on a merge conflict it refuses and the lane parks for you (#56 S1.5);
    - a missing recorded command, or `none` without a reason, fails it (#56 S1.2);
    - done-check reads the verdict, not the lane's log.
- [ ] Add D4's protected-file check, containment (non-interactive, with a time limit and closed stdin; only the exit code and output come back), and the risk re-check.
- **Done when:**
    - a failing or missing check starts no reviewer;
    - a lane that edits `kit.json` or a `package.json` script fails the gate;
    - a stale verdict is refused;
    - a hanging check is stopped by the time limit;
    - a low-risk lane whose glob hides a high-risk path is stopped;
    - a missing command fails the gate, and a merge conflict parks the lane.

### Step 4. One real run that you watch (this plan)

- [ ] Run one low-risk feature end to end on the test project with Steps 0–3 in place.
- [ ] File every problem as an issue before going on. The last two field runs found 10 and 11 issues (0016 E.3).

### Step 5. CI re-checks things itself (0016 step 4)

- [ ] CI reads the scope list from the base branch's spec.
- [ ] CI checks that new tests fail on the base code, on an assertion and not a load error, and pass on the head (#56 (d)).
- [ ] (#56 S1.5) The same gate runs in project CI.
- [ ] The review report stays as a record, not a required check.
- [ ] (#56) Make `ci_scope_diff`, `ci_test_count`, `ci_dep_diff` and `ci_pr_size` fetch the base before comparing.
- **Done when:** a PR that widens its own scope list fails, and a new test that already passes on the base, or fails there only with a load error, is flagged. Whether this works for every language is still open (0016 open question 3).

### Step 6. Planted faults first (0016 step 5)

- [ ] Point the existing faults for the #30 class, budgets and evidence at the new gates.
- [ ] (#56) Add KIT-SPEC's missing rows for planted faults 39–45.

### Step 7. Delete what the new controls replace (0016 step 6)

- [ ] Delete 0016's list ([E.1 Delete, L189](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0016-direction-vs-reference-factory.md#L189)):
    - `hook_done_check` as the evidence gate;
    - `hook_post_edit_check`'s log and attempt counter;
    - `hook_budget_check`;
    - `hook_read_log`, only if Claude Code's own read check holds (0016 open question 2);
    - the red-run lint;
    - `lane.js stage` as a free writer;
    - lane records in `kit.json`;
    - tier 3 of `laneForHook`;
    - the stage, start and budget fields of `lane.json`.
- [ ] **Keep** the guard hooks as guardrails (0016 C.2): `hook_guard_bash` (without its lane-state rules), `hook_guard_edit`, `hook_guard_read`, `hook_guard_tests_only`, `hook_config_guard`, `hook_event_log`, `hook_notify`, `hook_session_context` and `validate_docs --hook`.

### Step 8. Wall: the container (0016 step 7, extended by Q1)

- [ ] **Every lane that pushes** runs in the container, attended or not: only the worktree and scratch space mounted, plus the main repo's `.git` with `hooks/` and `config` read-only, none of your credentials inside, and network access limited.
- [ ] Run E.4's probes P4 and P2-full.
- [ ] Build it as 0016 open question 5 answers: keep worktrees, and mount the main repo's `.git` at its own path with `hooks/` and `config` read-only; start the image from Anthropic's reference dev container and its default-deny firewall ([Anthropic docs](https://code.claude.com/docs/en/sandbox-environments)); build the kit into the image, read-only; give Claude Code an Anthropic API key, the only secret inside; run each lane as its own headless `claude -p` through `lane.js launch`, with `/zi-run` on your machine only coordinating.
- **Done when:** four attempts from inside a lane fail: edit a guard, read the `gh` token, push to `main`, merge without approval; a lane cannot write the main repo's `.git/hooks` or `.git/config`; and `lane.js launch <slug> --exec` starts `claude -p "/zi-run <slug>"` in the container. This also covers #55.

### Step 9. Specialist reviewers (D5; 0016 E.6)

- [ ] Confirm 0016 E.6 is merged (Step 0).
- [ ] Write the rulebooks, the reviewers, the routing script and the `<reviewer>: PASS|FAIL` first line, with one report per reviewer tied to the commit. `verify-ui` stops being an alias of `review` (#56).
- **Done when:** each reviewer catches its planted fault with a rule ID, the scripts refuse a report without a verdict line, and a UI review with no browser parks the lane. Until then, today's reviewer stays.

### Step 10. Dashboard (0016 step 8, D.2–D.3)

- [ ] A Runs view: a card per lane with the round, the gate verdict and commit, a chip per reviewer, CI state, time and cost (or a stated "no telemetry").
- [ ] A drawer that opens each file at its `## Summary`; add `## Summary` to the progress, review, gate and escalation templates, and make `validate_docs` require it.
- [ ] A live strip: add `agent_id` to `hook_event_log`.
- [ ] Read events from the work root, and the lane list from the store. Remove the old Worktrees view once Runs shows the same facts.

### Step 11. Two field runs to re-prove the system (0016 Consequences)

- [ ] Run two real features end to end on the finished system.
- **Done when:** both finish within their approved specs, with no new enforcement issue.

## Reviewer system design (D5)

Review judges what the gate and CI can't: whether a change is correct, safe, usable and no bigger than the spec. Review stays advisory. GitHub, CI and you decide the merge (0016 E.1 Add 3).

**Where it lives.** Review is the `/zi-review` skill (0017). The reviewers are agents in `kit/agents/`, each started in a fresh context.

**Which reviewers run.** A script decides from `git diff --name-only <base>...<HEAD>` and the spec's risk, using a table in the workflow profile. No agent chooses.

| Reviewer | Runs when | Judges | Planted fault it must catch |
| --- | --- | --- | --- |
| `code-reviewer` | Every change | Correctness, simplicity, test quality, nothing beyond the spec, plus one adversarial test | A feature the spec didn't ask for |
| `security-reviewer` | Risk is high, or the diff touches login, permissions, secrets, payments, user data or trust boundaries | Security, data loss, idempotency, irreversible migrations | A SQL injection |
| `ui-reviewer` | The diff touches screens, styles or components | Layout and visuals in the running app at desktop and mobile sizes | Text below the rulebook's contrast minimum |
| `ux-reviewer` | The diff touches user flows, copy or form states | Workflows, states, copy, accessibility, keyboard and mobile use | A flow with no keyboard path |
| `architecture-reviewer` (optional) | The diff crosses component boundaries, public contracts or data ownership | Boundaries and contracts against `ARCHITECTURE.md` | A call across a forbidden boundary |

**Rules every reviewer follows:**

- **First line is the verdict:** `<reviewer>: PASS` or `<reviewer>: FAIL`. A report without it is refused.
- **Kept from today's reviewer:**
    - it never sees the builder's conversation ([reviewer.md L3](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/agents/reviewer.md#L3));
    - it writes one adversarial test ([L38](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/agents/reviewer.md#L38));
    - it writes only its report and that test, and never fixes code ([L47](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/agents/reviewer.md#L47)).
- **One rulebook, two users:** numbered rules (for example `SEC-3`) are given to the writer and the reviewer.
- **No FAIL without a rule:** each FAIL cites a rule ID or spec criterion plus `file:line`, as today's fail list already does ([L44](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/agents/reviewer.md#L44)).
- **No pretend reviews:** if UI or UX review needs a browser the lane doesn't have, the report says so and the lane parks.
- **Tied to the commit:** each report names the commit the gate checked. A FAIL ends the round.

**Open:** the rulebook format and location, and the eval score each reviewer must reach.

## What a run looks like once built

This assumes all 12 steps are done. You act three times: agree the goal, say yes to merging the spec PR, and say yes to merging the code PR.

### Example: refunds in your app (high-risk)

1. **Goal.** `/zi-start refunds for app users`. You and the agent agree the goal, and `/zi-run` takes over.
2. **Spec.** Agents research the code. The planner writes the spec, and the `spec-critic` challenges it. The planner answers each point, for up to two rounds. `validate_docs` and `lane.js precheck` check the spec. It lists `src/billing`, a high-risk path, so it is marked high-risk.
3. **You approve the spec.** The App opens the spec PR. Claude asks to merge it; you say yes, Claude merges, and `lane.js` records your yes.
4. **Lane start.** `advance` moves the lane on. `lane.js start` fetches the base, stopping if it can't, and records the base commit. The lane runs in the container, with none of your credentials inside.
5. **Tests first.** The tester writes one test per criterion, for example "a refund over the order total is rejected".
6. **Round 1.** The implementer makes the tests pass. It also edits a `package.json` test script and leaves a lint error. The gate fails on the protected-file change and on lint, so no reviewer starts.
7. **Round 2.** The implementer fixes both, and the gate passes. The risk re-check sees billing files, which matches the spec.
    - Routing picks `code-reviewer` and `security-reviewer`.
    - `security-reviewer` returns `security-reviewer: FAIL`, citing `SEC-3` at `refunds.js:42`: a refund can be submitted twice.
8. **Round 3.** The implementer fixes it. The gate passes, and the reports' first lines read `code-reviewer: PASS` and `security-reviewer: PASS` on the same commit. Had the round limit been hit first, `advance` would have parked the lane and told you why.
9. **Ready.** The gate re-runs after updating from the base. On your machine, the push step pushes `wt/refunds` with the App token and opens the PR.
10. **CI** reads the scope list from the base spec, and checks the new tests fail on the base and pass on the head.
11. **You say yes, Claude merges.** Claude Code asks you first, and GitHub refuses the merge unless every required check is green, admins included.
12. **Retro.** Lessons are proposed, and you accept or edit them. A recurring finding becomes a gate or CI check.

## How we prove it works

A control counts only when a planted fault shows it catching a deliberate bypass. Each fault is written with its step.

**Where each fault runs:**

- **Kit CI:** script faults. Today `planted-faults/run.js` catches 52 of 52.
- **Test project:** GitHub faults, run as a scripted check, because they need a live repo and the App.
- **Eval set:** reviewer faults, because a reviewer's catch rate is model behaviour.

| Planted fault | Must be caught by | Runs in | Step |
| --- | --- | --- | --- |
| A merge while a required check is red or pending, from any account | GitHub refuses (protection, admins included) | Test project | 1 |
| App pushes to or merges into `main`, or pushes to a branch outside `wt/*` and `spec/*` | GitHub refuses (protection, ruleset) | Test project | 1 |
| Required check name that no job reports | Bootstrap read-back fails | Test project | 1 |
| A workflow on an App branch reads the Anthropic keys | The environment limited to `main` withholds them | Test project | 1 |
| Workflow with a matrix job | The required list names each value as GitHub reports it (`script unit tests (node 20)`) | Kit CI | 1 |
| Agent writes the spec's approval line | `lane.js` ignores it; only your yes to the spec PR's merge counts | Kit CI | 2 |
| Fix or incident lane runs `lane.js scope` before its `spec/<slug>` PR is approved and merged | `lane.js scope` refuses | Kit CI | 2 |
| Illegal stage move | `advance` refuses with a reason | Kit CI | 2 |
| Round past the limit | `advance` parks the lane | Kit CI | 2 |
| Lane agent runs `advance`, `gate`, `start` or a merge | Denied by the narrowed permission rules | Kit CI | 2 |
| Session outside the container approves a PR, merges other than through `kit merge`, or changes protection or the ruleset | Denied by the permission rules | Kit CI | 2 |
| `kit merge` runs without your yes | Claude Code prompts every time (the `ask` rule matches, proven by the probe) | Kit CI | 2 |
| Kit permission rule that doesn't match its command | Probe fails (#63) | Kit CI | 2 |
| Reproductions in #57, #58 and #59 | Refused as the issues require | Kit CI | 2 |
| A progress cell containing `#` | The stage does not move | Kit CI | 2 |
| Lane start with a failed fetch, or with no `origin` and no `local_only` | Refused | Kit CI | 2 |
| Failing or missing required check | Gate fails; no reviewer starts | Kit CI | 3 |
| Recorded command missing, or `none` without a reason | Gate fails | Kit CI | 3 |
| Merge conflict when the gate re-runs after syncing with the base | Gate refuses; the lane parks | Kit CI | 3 |
| Lane edits `kit.json` or a `package.json` script | Gate fails on a protected-file change | Kit CI | 3 |
| Gate verdict for an older commit | Refused as stale | Kit CI | 3 |
| A check that hangs | Stopped by the time limit | Kit CI | 3 |
| Low-risk spec whose glob hides a high-risk path | Gate risk re-check stops the lane | Kit CI | 3 |
| PR widens its own scope list | CI reads the base spec and fails | Kit CI | 5 |
| New test already passes on the base | CI flags it | Kit CI | 5 |
| New test fails on the base with a load error, not an assertion | CI flags it | Kit CI | 5 |
| From inside a lane: edit a guard, read the `gh` token, push to `main`, merge without approval | All four fail | Test project | 8 |
| From inside a lane: write the main repo's `.git/hooks` or `.git/config` | Refused by the read-only mounts | Test project | 8 |
| Feature the spec didn't ask for | `code-reviewer: FAIL` with a rule ID | Eval | 9 |
| SQL injection | `security-reviewer: FAIL` with a rule ID | Eval | 9 |
| Text below the contrast minimum | `ui-reviewer: FAIL` with a rule ID | Eval | 9 |
| Flow with no keyboard path | `ux-reviewer: FAIL` with a rule ID | Eval | 9 |
| Call across a forbidden boundary (when `architecture-reviewer` is enabled) | `architecture-reviewer: FAIL` with a rule ID | Eval | 9 |
| Report without a verdict line | Refused by the script | Kit CI | 9 |
| UI review with no browser | Report says it didn't run; lane parks | Kit CI | 9 |

**Definition of done:**

- Only `advance` moves the stage, and lanes can't call it.
- No reviewer runs on a failing gate.
- Every merge needs green CI, enforced by GitHub for admins too, and your yes at the `kit merge` prompt; the App can push only `wt/*` and `spec/*`.
- CI recomputes scope and the red run.
- Every lane that pushes runs in the container and passes the four bypass attempts.
- Every fault above is caught.
- The two field runs in Step 11 finish within their approved specs, with no new enforcement issue.

## Known limits, cost and speed

**Known limits after the plan is built:**

- **Sessions outside the container.** The orchestrator, planning and retro still run as you and can reach your `gh` login and the App's key. Approving, any merge other than `kit merge`, and changing protection or the ruleset are denied by permission rules (Step 2), which are a guardrail, not a wall. A scheduled or headless session cannot merge, because nobody is there to answer the prompt. Until Step 8 is built, `/zi-run`'s lane agents are among these sessions.
- **No second human.** You say yes to the App's PRs yourself. Copilot also blocks the person who asked for a PR from approving it, and a one-person project can't match that (Q2).
- **#46** (`rm -rf` parsing) persists while the Bash guard keeps that rule. It is a guardrail, not a wall (0016 C.1).
- **#33, #34 and #49** (spec and review quality): the `spec-critic` is judgment, not a test. Specialist reviewers (Step 9) reduce these misses but can't remove them, which is why your spec approval stays.
- **Still open in 0016:** open question 2 (Claude Code's own read check, before Step 7) and open question 3 (CI re-checking the red run in every language, in Step 5). Open question 4 (the Keychain under `srt`) no longer matters once every pushing lane uses the container.
- **#56's output contract S2 and S4–S8** stay undecided. S3 is picked up in Step 9.
- **To do later (owner's decision, 2026-11-21): docs, ui at S and M, investigation and skill-development work.** Step 2 refuses them because nothing runs their `inspect`, `report` and `verify-ui` stages and the `skill-smith` agent does not exist (#57–#59). Building those stages and the agent is its own step, not yet scheduled.

**Cost and speed:**

| Change | Added cost | What it saves |
| --- | --- | --- |
| GitHub App | A one-time setup; its tokens are fetched automatically | Agents push as the App, not as you |
| GitHub Pro | A paid plan, needed to protect a private repo | Makes the merge rule enforceable on this repo |
| A container for every pushing lane | Start-up time per lane, and Docker running on your Mac | Closes #55, and keeps your credentials away from lanes |
| The gate | One local run of the checks per round | Reviewers don't spend tokens on code that fails lint or tests |
| Specialist reviewers | More review tokens on changes that touch several areas | Rule-based findings, and fewer of the misses in #33, #34 and #49 |
| Verdict line | Almost none | No lane moves on a misread report |

None of these costs has been measured yet. Step 4's watched run is the first measurement.

**Not in this plan:**

- automatic spec approval (Q3);
- license work (Q4).

**Earlier versions of this doc** (all in its history):

- **v1:** built on `704cb46`, before 0016 was found. It blocked `gh pr merge` in the guard, which can be bypassed.
- **v2:** rebuilt on 0016.
- **v3:** fixed the 19 findings of an independent review, and added five decisions to settle.
- **This version:** your decisions on Q1–Q5, 0017's `zi-` skills and PR #62, issue #63, and the GitHub App, recorded in 0016 as E.6–E.9.

## Sources

Repo links point to `main` at `3a34247`.

**Decisions:**

- [0016 Direction: the kit against a working reference factory](https://github.com/jonathandrobles805/agents-system/blob/main/docs/decisions/0016-direction-vs-reference-factory.md)
- [0017 Commands become 23 skills, each named zi- plus its old name](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0017-commands-to-skills.md)

**Code:**

- [kit/scripts/lane.js](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js)
- [kit/scripts/bootstrap.js](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/bootstrap.js)
- [kit/scripts/validate_docs.js](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/validate_docs.js)
- [kit/scripts/kitlib.js](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/kitlib.js)
- [kit/ci/github.yml](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/ci/github.yml)
- [kit/hooks/settings.project.json](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/hooks/settings.project.json)
- [kit/commands/run.md](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/commands/run.md)
- [kit/commands/review.md](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/commands/review.md)
- [kit/agents/reviewer.md](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/agents/reviewer.md)

**Pull requests and issues:**

- [PR #62, commands become 23 zi- skills (merged)](https://github.com/jonathandrobles805/agents-system/pull/62)
- Issues [#55](https://github.com/jonathandrobles805/agents-system/issues/55), [#56](https://github.com/jonathandrobles805/agents-system/issues/56), [#57](https://github.com/jonathandrobles805/agents-system/issues/57), [#58](https://github.com/jonathandrobles805/agents-system/issues/58), [#59](https://github.com/jonathandrobles805/agents-system/issues/59) and [#63](https://github.com/jonathandrobles805/agents-system/issues/63)

**Outside references:**

- [GitHub: deciding when to build a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [GitHub: Copilot cloud agent risks and mitigations](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations)
- [GitHub: about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub: approving a pull request with required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)
- [GitHub: available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GNU General Public License v3](https://www.gnu.org/licenses/gpl-3.0.en.html)
- [ServiceNow: change types (ITIL)](https://www.servicenow.com/docs/r/it-service-management/change-management/change-types.html)
- [Anthropic: structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
