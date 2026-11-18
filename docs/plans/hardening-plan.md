# agents-system: hardening plan, built on decision 0016

2026-11-17 · Jonathan Robles

## Summary

This is the work order for [decision 0016](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0016-direction-vs-reference-factory.md) (accepted) and [decision 0017](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0017-commands-to-skills.md) (accepted; 23 `zi-` skills). It follows 0016's migration in full and adds what today's reviews found it doesn't cover. Those additions are recorded in 0016 as amendments E.6–E.9. Additions are marked **(this plan)**.

**The model:** agents do the work; scripts decide what happens next; GitHub enforces your approval; CI re-checks what matters. The pipeline runs on its own up to a merge-ready PR. **Only you merge.**

**Your touchpoints:**

- Agree the goal with `/zi-start`.
- Approve the spec PR.
- Approve and merge the code PR.

Agents push and open PRs through a GitHub App, never your account.

**What this plan adds to 0016:**

1. **A GitHub App as the agents' identity.** It is used only to push branches and open PRs, and may push only to `wt/*`.
2. **A container for every lane that pushes,** attended or not, with limited network access.
3. **This repo follows the same merge rule as projects.**
4. **The spec's approval line is written from your GitHub approval.**
5. **The required checks use the real CI job names.**
6. **The lane start stops if it can't fetch the base.**
7. **Extra gate checks:** protected files, containment, and a risk re-check against the actual diff.
8. **One watched real run, early.**
9. **Specialist reviewers** (0016 E.6), with a fixed first-line verdict.

**Settled today:**

- automatic spec approval stays dropped;
- the license question is closed (personal, private use);
- the defaults for the bot identity, this repo and the output contract are confirmed.

## Decisions taken

All five were settled by you in chat on 2026-11-17. Each is compared with GitHub's documentation and with an enterprise system that solves the same problem: GitHub Copilot's coding agent, ITIL change management, and Anthropic's structured outputs.

| # | Decision | GitHub or enterprise practice | Where this plan stands |
| --- | --- | --- | --- |
| Q1 | **Agents' identity: a GitHub App,** used only to push lane branches and open PRs. **Every lane that pushes runs in the container,** attended or not. | GitHub recommends a GitHub App for long-lived integrations, and its tokens are short-lived. Copilot's agent has its own identity, can push to one branch only, has restricted internet, and cannot approve or merge. | **Matches**, once the App is limited to `wt/*` branches by a ruleset and the container limits network access. Both are in Steps 1 and 8. |
| Q2 | **This repo follows the same rule as projects.** The App opens its PRs; you approve and merge. GitHub's "most recent push must be approved by someone else" rule stays **off**. | GitHub: the author of a pull request cannot approve it. Copilot goes further: the person who asked for the PR cannot approve it either, which needs a second human. | **Below Copilot, by necessity.** A one-person project can't have a second reviewer. You approving the App's PR is the strongest solo setup. Protecting this private, personally owned repo needs GitHub Pro. |
| Q3 | **Automatic spec approval: dropped.** Every spec pauses for you. | ITIL pre-approves only named, low-risk change types, through a catalogue of templates with a track record, never by a per-case score. | **Stricter than ITIL.** If it ever returns, model it as a short list of change types you pre-approve. |
| Q4 | **License: closed.** The kit is personal and private, and is not shared. | The GPL's duties apply when you convey copies to others; running the program or modifying a private copy is not conveying. Copyright protects expression, not ideas. | **Settled.** Revisit only before publishing or sharing the kit. Nothing is copied from Factory v2 anyway. |
| Q5 | **Output contract: pick up #56 S3 now.** Each reviewer's report starts with a fixed line, `<reviewer>: PASS` or `FAIL`, which the scripts check. The rest of S2–S8 stays open. | Factory v2's scripts refuse to advance without a fixed first line. Anthropic's structured outputs constrain a response to a schema, so the format is guaranteed. | **Matches Factory.** Structured output is the upgrade if misreads ever happen. |

## Evidence baseline

Repo links point to `main` at [`3a34247`](https://github.com/jonathandrobles805/agents-system/tree/3a34247f08515ed8f3b328f01bb9531970cbb222), checked 2026-11-17 22:50. Since `f1da557` (PR #54), only docs have changed: #60, #61 and #64 amended 0016 E.5 and 0017. So every code line cited here is the same as at `f1da557`.

**Checks on this code:**

- `npm test`: 347 of 347 pass.
- `planted-faults/run.js`: 46 of 46 caught.
- On the skills branch, draft PR #62 reports 358 of 358 tests (as reported in #62, not re-run here).

**GitHub:**

- `main` is unprotected.
- The repo is private and owned by a personal account.
- PRs #54, #60 and #61 were opened and merged by your own account.

**The Bash guard against bypass commands** (`hook_guard_bash.js`):

| Command | Result |
| --- | --- |
| `gh pr merge 1` | ALLOW |
| `gh api -X PUT repos/o/r/pulls/1/merge` | ALLOW |
| `cd $HOME/.claude/kit/scripts && echo x > hook_guard_bash.js` | ALLOW |
| `git push origin HEAD:main` | ALLOW |
| `git push --force origin main` | BLOCK |

**Issue #63 makes it worse.** The kit's skills keep full `Bash`, which pre-approves every shell command, `git push` and `gh pr merge` included. The kit's own permission rule may never match, because it names commands through `"$HOME"`. So the merge has to be enforced by GitHub; the guard stays a guardrail.

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

Fifteen holes are open on `main`.

- **0016 and 0017 close 7:** holes 1, 3, 7, 8, 11, 12 (the gate) and 14.
- **This plan closes 5:** holes 2, 4, 5, 13 and 15.
- **Both together close 3:** this plan adds #56's rules to hole 12, the GitHub App to holes 6 and 9, and the #63 fix to hole 10.

| # | Open hole | Evidence | Closed by | Step |
| --- | --- | --- | --- | --- |
| 1 | `lane.js stage` writes any stage | [lane.js L717–729](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L717-L729) | 0016 E.1 Add 1 | 2 |
| 2 | If the fetch fails or there is no `origin`, a lane quietly starts from local `main` | [lane.js L562–573](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L562-L573) | This plan | 2 |
| 3 | Protection is set with admin enforcement off and 0 approvals | [bootstrap.js L1396–1400](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/bootstrap.js#L1396-L1400) | 0016 E.1 Add 4 | 1 |
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
| 14 | 23 commands, not skills | 0017; draft PR #62 | 0017 | 0 |
| 15 | On macOS, searches run through Bash, so the read guard never sees secret reads | Issue #55 | This plan: a container for every lane that pushes | 8 |

**Already fixed on `main`:**

- The date-dependent test (`e24b7df`).
- A red run must name its test as failing (`59d54ab`, #30).
- Hooks find the lane the same way everywhere (`4208aeb`, #29).
- A human's budget raise survives a stage change (`b3d4f54`, #41).

Issues #29, #30 and #41 are still open; check what's left in each before closing them.

## Design decisions

### D1. GitHub enforces you, through a GitHub App (0016 E.1 Add 4 and 5, plus Q1 and Q2)

**Where the App is used.** In exactly one layer: pushing a lane's branch and opening its PR.

- That step runs on your machine, outside the lane's container, with a short-lived App token. This follows 0016's "the push done host-side".
- **Not used for:**
    - local work, tests and the gate, which need no GitHub identity;
    - CI, which uses GitHub Actions' own token;
    - your approval and merge, which use your own account.

**What the App may do:**

- Write contents and pull requests, on the repos you install it on.
- A ruleset lets it push only to `wt/*` branches, the kit's lane branches ([lane.js L559](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L559)).
- It cannot approve its own PR, because GitHub never lets an author approve.

**Branch protection, for projects and this repo alike:**

- 1 required approval.
- "Do not allow bypassing the above settings" (`enforce_admins: true`).
- No force push and no deletion.
- The required checks use the real job names.
- CODEOWNERS adds `docs/specs/`, `.claude/kit.json`, `package.json` and the test config ([0016 L197](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0016-direction-vs-reference-factory.md#L197)).
- The "most recent push must be approved by someone else" rule stays off, because you are the only human.
- This needs GitHub Pro, because the repo is private and personally owned.

**The approval line.** Today `lane.js` needs `Status: approved` and an approval line before a lane starts ([L375-L376](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L375-L376), [L502-L506](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/lane.js#L502-L506)). `lane.js` will write that line from your approving review on the spec PR, read through the GitHub API. No agent writes it.

**Limit.** Copilot's model also blocks the person who asked for the PR from approving it. That needs a second human, which a one-person project doesn't have.

### D2. One script moves the stage (0016 E.1 Add 1 and 6, E.4)

- **The store:** `lane.js advance` is the only writer of a store in the main checkout, using one table of allowed moves. The dashboard reads the store.
- **Rounds and time:** rounds and wall time replace tool-call budgets. A round is one build, gate and review cycle; a gate FAIL or a review FAIL ends it.
- **Who can call it (E.4):** lanes are no longer allowed to run the scripts that change state (`advance`, `gate`, `start`, merges).
- **#63 comes first.** The kit's permission rules name scripts through `"$HOME"`, and a probe showed such a rule doesn't match. So the narrowing needs #63's way out: a `kit` launcher on `PATH`, so rules can name exact commands. Each rule must be proven to match by a probe or a planted fault (#63's own rule).

### D3. The lane start stops if it can't fetch the base (this plan)

`lane.js start` refuses when the fetch fails or there is no `origin`, and records the base commit.

- **Local-only repos:** a repo with no remote must say so with `"local_only": true` in `kit.json`. A failed fetch is always refused.
- **Tests:** the `lane.test.js` fixtures, which start lanes with no `origin`, are updated in the same change.

### D4. The gate's extra checks (this plan, from #56)

On top of 0016's `lane.js gate` ([E.1 Add 2](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0016-direction-vs-reference-factory.md#L195)):

- **Protected files (#56 S1.3):** the gate fails if the lane changed the spec, `kit.json`, `.claude/`, CI config, `package.json` scripts or test config.
- **Containment (#56 S1.4):** the checks run contained, with a time limit and stdin closed.
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

### Step 0. Finish the skills move (0017; draft PR #62)

Steps 1–9 of the skills work are done on branch `commands-to-skills`: 23 `zi-` skills, install, version 0.3.0, and a tested rollback. The probe showed that a skill with `disable-model-invocation` does start under `claude -p`.

- [ ] Run one real feature on a canary project (PR #62, its Step 10).
- [ ] Check that a flagged skill also starts when you type it (probe item U3).
- [ ] You review and merge PR #62, and the PR that adds 0016 E.6–E.9 (PR #65, branch docs/0016-amendments-e6-e8).
- **Done when:** the canary run finishes, and the launcher starts `claude -p "/zi-run <slug>"` headless.

### Step 1. Judge: GitHub enforces you (0016 step 1, plus D1)

- [ ] Put a test project on GitHub. Create the GitHub App (contents and pull requests: write), and install it on the test project and this repo.
- [ ] Add a ruleset so the App may push only `wt/*` branches.
- [ ] Set protection as in D1. Build the required checks from the real job names (`kit-checks`, not its 7 steps; [bootstrap.js L1578](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/kit/scripts/bootstrap.js#L1578)). Read the settings back from GitHub.
- [ ] The push-and-open-PR step runs on your machine with an App token; `lane.js` writes the approval line from your GitHub review.
- **Done when, tested on the test project:**
    - the App can't merge without your approval;
    - the App can't push to `main`, or to any branch outside `wt/*`;
    - every required check reports on a test PR;
    - a required name that no job reports fails the read-back;
    - you can approve and merge the App's PR, on the test project and on this repo.

### Step 2. Spine: one script moves the stage (0016 step 2, E.4, E.5; plus D2, D3)

- [ ] Add `lane.js advance`, the table of allowed moves and the store. The dashboard reads the store.
- [ ] Rounds and wall time move into the store. `lane.js stage` becomes a call to `advance`.
- [ ] Fix #63 first: add a `kit` launcher on `PATH`, prove with a probe that the new permission rules match, then narrow the lanes' rules (E.4) and the skills' `Bash` so lanes can't call `advance`, `gate`, `start` or a merge.
- [ ] Fix #57 (stages a profile lacks are refused, not mapped to done), #58 (listed stages are produced or removed, and `requires` blocks) and #59 (`skill-development` is refused until its agent exists).
- [ ] Make the lane start fail closed, with `local_only` (D3), and update the `lane.test.js` fixtures.
- **Done when:**
    - an illegal move is refused with a reason;
    - a round past the limit parks the lane;
    - a lane agent calling `advance` is denied, as proven by a planted fault;
    - the reproductions in #57–#59 behave as their issues require;
    - a lane start with a failed fetch is refused, and one with no `origin` is refused unless `local_only` is set.

### Step 3. Gate (0016 step 3, plus D4)

- [ ] Add `lane.js gate`:
    - it runs the commands from the base branch's `kit.json`;
    - its verdict is tied to the commit;
    - no reviewer starts on a FAIL;
    - it runs again after updating from the base;
    - done-check reads the verdict, not the lane's log.
- [ ] Add D4's protected-file check, containment with a time limit and closed stdin, and the risk re-check.
- **Done when:**
    - a failing or missing check starts no reviewer;
    - a lane that edits `kit.json` or a `package.json` script fails the gate;
    - a stale verdict is refused;
    - a hanging check is stopped by the time limit;
    - a low-risk lane whose glob hides a high-risk path is stopped.

### Step 4. One real run that you watch (this plan)

- [ ] Run one low-risk feature end to end on the test project with Steps 0–3 in place.
- [ ] File every problem as an issue before going on. The last two field runs found 10 and 11 issues (0016 E.3).

### Step 5. CI re-checks things itself (0016 step 4)

- [ ] CI reads the scope list from the base branch's spec.
- [ ] CI checks that new tests fail on the base code and pass on the head.
- [ ] The review report stays as a record, not a required check.
- [ ] (#56) Make `ci_scope_diff`, `ci_test_count`, `ci_dep_diff` and `ci_pr_size` fetch the base before comparing.
- **Done when:** a PR that widens its own scope list fails, and a new test that already passes on the base is flagged. Whether this works for every language is still open (0016 open question 3).

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

- [ ] **Every lane that pushes** runs in the container, attended or not: only the worktree and scratch space mounted, none of your credentials inside, and network access limited.
- [ ] Run E.4's probes P4 and P2-full.
- **Done when:** four attempts from inside a lane fail: edit a guard, read the `gh` token, push to `main`, merge without approval. This also covers #55.

### Step 9. Specialist reviewers (D5; 0016 E.6)

- [ ] Confirm 0016 E.6 is merged (Step 0).
- [ ] Write the rulebooks, the reviewers, the routing script and the `<reviewer>: PASS|FAIL` first line, with one report per reviewer tied to the commit.
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

This assumes all 12 steps are done. You act three times: agree the goal, approve and merge the spec PR, and approve and merge the code PR.

### Example: refunds in your app (high-risk)

1. **Goal.** `/zi-start refunds for app users`. You and the agent agree the goal, and `/zi-run` takes over.
2. **Spec.** Agents research the code. The planner writes the spec, and the `spec-critic` challenges it. The planner answers each point, for up to two rounds. `validate_docs` and `lane.js precheck` check the spec. It lists `src/billing`, a high-risk path, so it is marked high-risk.
3. **You approve the spec.** The App opens the spec PR. GitHub waits for you, because `docs/specs/` has you as code owner. You approve and merge, and `lane.js` writes the approval line from your review.
4. **Lane start.** `advance` moves the lane on. `lane.js start` fetches the base, stopping if it can't, and records the base commit. The lane runs in the container, with none of your credentials inside.
5. **Tests first.** The tester writes one test per criterion, for example "a refund over the order total is rejected".
6. **Round 1.** The implementer makes the tests pass. It also edits a `package.json` test script and leaves a lint error. The gate fails on the protected-file change and on lint, so no reviewer starts.
7. **Round 2.** The implementer fixes both, and the gate passes. The risk re-check sees billing files, which matches the spec.
    - Routing picks `code-reviewer` and `security-reviewer`.
    - `security-reviewer` returns `security-reviewer: FAIL`, citing `SEC-3` at `refunds.js:42`: a refund can be submitted twice.
8. **Round 3.** The implementer fixes it. The gate passes, and both reports start with `PASS` on the same commit. Had the round limit been hit first, `advance` would have parked the lane and told you why.
9. **Ready.** The gate re-runs after updating from the base. On your machine, the push step pushes `wt/refunds` with the App token and marks the PR ready.
10. **CI** reads the scope list from the base spec, and checks the new tests fail on the base and pass on the head.
11. **You approve and merge.** The App can't merge without you, and admin enforcement binds everyone.
12. **Retro.** Lessons are proposed, and you accept or edit them. A recurring finding becomes a gate or CI check.

## How we prove it works

A control counts only when a planted fault shows it catching a deliberate bypass. Each fault is written with its step.

**Where each fault runs:**

- **Kit CI:** script faults. Today `planted-faults/run.js` catches 46 of 46.
- **Test project:** GitHub faults, run as a scripted check, because they need a live repo and the App.
- **Eval set:** reviewer faults, because a reviewer's catch rate is model behaviour.

| Planted fault | Must be caught by | Runs in | Step |
| --- | --- | --- | --- |
| App merges without your approval | GitHub refuses | Test project | 1 |
| App pushes to `main`, or to a branch outside `wt/*` | GitHub refuses (protection, ruleset) | Test project | 1 |
| Required check name that no job reports | Bootstrap read-back fails | Kit CI | 1 |
| Agent writes the spec's approval line | `lane.js` ignores it; only your GitHub review counts | Kit CI | 1 |
| Illegal stage move | `advance` refuses with a reason | Kit CI | 2 |
| Round past the limit | `advance` parks the lane | Kit CI | 2 |
| Lane agent runs `advance`, `gate` or a merge | Denied by the narrowed permission rules | Kit CI | 2 |
| Kit permission rule that doesn't match its command | Probe fails (#63) | Kit CI | 2 |
| Reproductions in #57, #58 and #59 | Refused as the issues require | Kit CI | 2 |
| Lane start with a failed fetch, or with no `origin` and no `local_only` | Refused | Kit CI | 2 |
| Failing or missing required check | Gate fails; no reviewer starts | Kit CI | 3 |
| Lane edits `kit.json` or a `package.json` script | Gate fails on a protected-file change | Kit CI | 3 |
| Gate verdict for an older commit | Refused as stale | Kit CI | 3 |
| A check that hangs | Stopped by the time limit | Kit CI | 3 |
| Low-risk spec whose glob hides a high-risk path | Gate risk re-check stops the lane | Kit CI | 3 |
| PR widens its own scope list | CI reads the base spec and fails | Kit CI | 5 |
| New test already passes on the base | CI flags it | Kit CI | 5 |
| From inside a lane: edit a guard, read the `gh` token, push to `main`, merge without approval | All four fail | Test project | 8 |
| Feature the spec didn't ask for | `code-reviewer: FAIL` with a rule ID | Eval | 9 |
| SQL injection | `security-reviewer: FAIL` with a rule ID | Eval | 9 |
| Text below the contrast minimum | `ui-reviewer: FAIL` with a rule ID | Eval | 9 |
| Flow with no keyboard path | `ux-reviewer: FAIL` with a rule ID | Eval | 9 |
| Report without a verdict line | Refused by the script | Kit CI | 9 |
| UI review with no browser | Report says it didn't run; lane parks | Kit CI | 9 |

**Definition of done:**

- Only `advance` moves the stage, and lanes can't call it.
- No reviewer runs on a failing gate.
- GitHub requires your approval for every merge, admins included, and the App can push only `wt/*`.
- CI recomputes scope and the red run.
- Every lane that pushes runs in the container and passes the four bypass attempts.
- Every fault above is caught.
- The two field runs in Step 11 finish clean.

## Known limits, cost and speed

**Known limits after the plan is built:**

- **No second human.** You approve the App's PRs yourself. Copilot also blocks the person who asked for a PR from approving it, and a one-person project can't match that (Q2).
- **#46** (`rm -rf` parsing) persists while the Bash guard keeps that rule. It is a guardrail, not a wall (0016 C.1).
- **#33, #34 and #49** (spec and review quality): the `spec-critic` is judgment, not a test. Specialist reviewers (Step 9) reduce these misses but can't remove them, which is why your spec approval stays.
- **Still open in 0016:** open question 2 (Claude Code's own read check, before Step 7) and open question 3 (CI re-checking the red run in every language, in Step 5). Open question 4 (the Keychain under `srt`) no longer matters once every pushing lane uses the container.
- **#56's output contract S2 and S4–S8** stay undecided. S3 is picked up in Step 9.

**Cost and speed:**

| Change | Added cost | What it saves |
| --- | --- | --- |
| GitHub App | A one-time setup; its tokens are fetched automatically | Agents can no longer merge as you |
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

- [0016 Direction: the kit against a working reference factory](https://github.com/jonathandrobles805/agents-system/blob/3a34247f08515ed8f3b328f01bb9531970cbb222/docs/decisions/0016-direction-vs-reference-factory.md)
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

- [PR #62, commands become 23 zi- skills (draft)](https://github.com/jonathandrobles805/agents-system/pull/62)
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
