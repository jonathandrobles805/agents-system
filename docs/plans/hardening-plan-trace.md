# Hardening plan: traceability

Every rule in `docs/plans/hardening-plan.md` is listed once, with the place in `docs/decisions/0016-direction-vs-reference-factory.md` that states it, cited by its label and line. A rule with no 0016 place, or an amendment line with no rule here, is a defect in this pair of documents. Line numbers are for 0016 on branch `docs/0016-amendments-e6-e8`; the labels stay valid if lines move. Every cited line was checked by a script when this file was written (2026-11-18).

"F" rows are the planted-fault table (plan: How we prove it works; 0016 E.9). Plan Steps 1–3, 5–8 and 10 are E.2 steps 1–8; Step 0 comes from 0017, Step 11 from Consequences, and Steps 4 and 9 are added by the plan.

## Decisions taken

| ID | Rule in the plan | Plan section | 0016 | Proof |
|---|---|---|---|---|
| Q1a | The agents' identity is a GitHub App, used only to push lane and spec branches and open PRs | Decisions taken; Summary 1 | E.7 item 1 (L280); E.7 item 2 (L281) | Faults F1, F2 |
| Q1b | Every lane that pushes runs in the container, attended or not, with limited network | Decisions taken; Summary | E.7 item 5 (L284) | Fault F22 |
| Q2 | This repo follows the same rule as projects; the App opens its PRs; Claude merges them on your yes; GitHub Pro | Decisions taken | E.7 item 4 (L283); E.10 item 1 (L356) | S1 done-when 5 |
| Q3 | Automatic spec approval dropped; every spec pauses for you; if it returns, a short list of pre-approved change types | Decisions taken; Not in this plan | Alternatives: automatic spec approval (L396); E.1 Keep (L191) | Nothing to build |
| Q4 | License closed: personal, private use | Decisions taken; Not in this plan | Open question 1 (L407) | Nothing to build |
| Q5 | Reports start with `<reviewer>: PASS` or `FAIL`; S2–S8 stay open; structured output is the upgrade if misreads happen | Decisions taken | E.6 item 5 (L266) | Fault F29 |

## Design decisions

| ID | Rule in the plan | Plan section | 0016 | Proof |
|---|---|---|---|---|
| D1.1 | The App works in one layer, the push and PR, host-side with a short-lived token; not used for local work, CI, or your approval and merge | D1 | E.7 item 2 (L281); E.1 Add 5 (L198) | Fault F1 |
| D1.2 | App permissions: contents, pull requests and workflows, write; on the repos you install it on | D1 | E.7 item 1 (L280); Open question 6 (L412) | S1 read-back |
| D1.11 | Merging on your word: Claude merges only through `kit merge`, after green CI and your yes at an `ask` prompt; every other merge path, approving and settings changes denied | D1 | E.10 item 1 (L356); E.10 item 3 (L358); E.10 Why (L353) | Faults F1, F11 |
| D1.12 | Limit: your yes is enforced on your machine by Claude Code, not by GitHub; green CI is enforced by GitHub | D1 | E.10 Limit (L362) | Stated limit |
| D1.10 | The Anthropic keys move into an environment limited to `main`, so a workflow on an App branch cannot read them | D1; Step 1 | Open question 6 (L412) | Fault F4 |
| D1.3 | A ruleset lets the App push only `wt/*` and `spec/*`; creating, updating and deleting other branches restricted; a tag ruleset; only you on the bypass list; separate from the approval rules | D1 | E.7 item 3 (L282) | Fault F2 |
| D1.4 | The App cannot approve its own PR | D1 | E.7 item 4 (L283) | Fault F1 |
| D1.5 | Protection: real job names, `enforce_admins`, no force push or deletion; no required approving review and no code-owner review; GitHub Pro | D1 | E.7 item 4 (L283); E.10 item 2 (L357); E.8 item 5 (L299) | Faults F1, F2, F3 |
| D1.6 | You approve a spec by saying yes to its merge; `lane.js` records it in the store; the spec line is no longer needed and the `/zi-plan` instruction changes; no agent writes an approval | D1 | E.8 item 6 (L300); E.10 item 4 (L359) | Fault F5 |
| D1.8 | Fix and incident lanes push their spec as a `spec/<slug>` PR; `scope` refuses until you approve and merge it | D1 | E.8 item 6 (L300) | Fault F6 |
| D2.1 | `advance` is the only writer of the store; one table of legal moves; refusals name the reason; the dashboard reads the store | D2 | E.1 Add 1 (L194); E.2 step 2 (L206) | Fault F7 |
| D2.2 | Rounds and wall time replace tool-call budgets; a round is build, gate, review; a FAIL ends it; past the limit the lane parks | D2 | E.1 Add 6 (L199); E.8 item 8 (L302) | Fault F8 |
| D2.3 | Lanes may not run the state-changing scripts | D2 | E.4 §1 (L228); E.8 item 7 (L301) | Fault F9 |
| D2.4 | #63 first: a `kit` launcher on `PATH`; every rule proven to match | D2; Step 2 | E.8 item 7 (L301) | Fault F12 |
| D2.5 | Sessions outside the container keep `advance`, `gate`, `start`; merge only through `kit merge` behind the `ask` rule; denied approve, any other merge, protection or ruleset changes | Step 2 | E.8 item 7 (L301) | Fault F10 |
| D3 | Lane start fails closed unless the repo is local-only and records the base commit; a failed fetch is always refused; no remote needs `local_only`; fixtures updated | D3 | E.8 item 4 (L298) | Fault F14 |
| D4.1 | Gate fails on protected-file changes, including the spec after its approved commit (#56 S1.3 plus E.1 Add 4) | D4 | E.8 item 1 (L295) | Fault F16 |
| D4.2 | Gate runs contained, with a time limit and stdin closed (#56 S1.4) | D4 | E.8 item 2 (L296) | Fault F18 |
| D4.3 | Risk re-check against the actual diff | D4 | E.8 item 3 (L297) | Fault F19 |
| D5.1 | Reviewers: `code-`, `security-`, `ui-`, `ux-`, optional `architecture-reviewer`; our own names; when each runs, what it judges, the fault it must catch | D5; Reviewer system design | E.6 item 1 (L253); E.6 reviewer table (L255) | Faults F24–F28 |
| D5.2 | Rulebooks given to writer and reviewer; a FAIL cites a rule ID or criterion plus `file:line` | D5; Reviewer system design | E.6 item 4 (L265) | Faults F24–F28 |
| D5.3 | A script picks reviewers from the diff and the risk; no agent chooses | D5; Reviewer system design | E.6 item 3 (L264) | Faults F24–F28 |
| D5.4 | Verdict line, refused without it | D5; Reviewer system design | E.6 item 5 (L266) | Fault F29 |
| D5.5 | Targets #33, #34, #49 | D5; Known limits | E.6 Why (L250) | Faults F24–F28 |
| D5.6 | Review is the `/zi-review` skill; reviewers are agents in `kit/agents/`, fresh context | Reviewer system design | E.6 item 2 (L263) | Step 9 |
| D5.7 | Kept: never sees the builder's conversation; one adversarial test; writes only report and test | Reviewer system design | E.6 item 6 (L267) | Step 9 |
| D5.8 | No pretend reviews: no browser, report says so, lane parks | Reviewer system design | E.6 item 7 (L268) | Fault F30 |
| D5.9 | One report per reviewer, tied to the commit; a FAIL ends the round | Reviewer system design; Step 9 | E.6 item 8 (L269) | Step 9 |
| D5.10 | Open: rulebook format and location; eval score | Reviewer system design | E.6 Open (L273) | Open |
| D5.11 | Review stays advisory; GitHub, CI and you decide the merge | Reviewer system design | E.1 Add 3 (L196) | — |

## Steps

| ID | Rule in the plan | Plan section | 0016 | Proof |
|---|---|---|---|---|
| S0 | Finish the skills move: canary run, probe U3, merge PR #62 and PR #65; done when the canary finishes; the headless check moves to Step 8 | Step 0 | E.8 item 11 (L305); E.5 (L235); E.10 item 5 (L360) | Done-when |
| S1 | Judge: test project, App, ruleset, protection from job names, read-back, your yes to the spec PR merge recorded in the store; five done-whens | Step 1 | E.2 step 1 (L205); E.7 item 1 (L280); E.7 item 2 (L281); E.7 item 3 (L282); E.7 item 4 (L283); E.8 item 5 (L299); E.8 item 6 (L300); E.7 Done when (L286); E.7 Where it sits (L288) | Faults F1–F6 |
| S2 | Spine: `advance`, store, rounds, E.4, #63, outside-session denials, #57–#59, fail-closed start; seven done-whens | Step 2 | E.2 step 2 (L206); E.1 Add 1 (L194); E.1 Add 6 (L199); E.8 item 7 (L301); E.8 item 8 (L302); E.8 item 10 (L304); E.8 item 4 (L298); E.8 Where it sits (L308) | Faults F7–F14 |
| S3 | Gate from the base `kit.json`, tied to the commit, no reviewer on FAIL, re-run after sync, done-check reads the verdict; D4; five done-whens | Step 3 | E.1 Add 2 (L195); E.2 step 3 (L207); E.8 item 1 (L295); E.8 item 2 (L296); E.8 item 3 (L297) | Faults F15–F19 |
| S4 | One watched real run of a low-risk feature; file every problem first | Step 4 | E.8 item 9 (L303); E.3 (L220) | Issues filed |
| S5 | CI scope from base, red run recomputed, review report demoted; #56 CI scripts fetch the base; done-when | Step 5 | E.1 Add 3 (L196); E.2 step 4 (L208); E.8 item 12 (L306); Open question 3 (L409) | Faults F20, F21 |
| S6 | Planted faults first; KIT-SPEC rows 39–45 | Step 6 | E.2 step 5 (L209); E.8 item 12 (L306) | Fault table |
| S7 | Delete E.1's list; keep the guard hooks | Step 7 | E.1 Delete (L189); E.1 Keep (L191); E.2 step 6 (L210); Open question 2 (L408) | Each deletion with its fault passing |
| S8 | Container for every pushing lane, built as open question 5 answers (worktrees, `.git` hooks and config read-only, reference image and firewall, kit in the image, API key, headless lanes); probes P4 and P2-full; covers #55; headless start; done-when | Step 8 | E.2 step 7 (L211); E.7 item 5 (L284); E.4 §7 (L232); E.1 Add 5 (L198); Open question 5 (L411); E.10 item 5 (L360) | Faults F22, F23 |
| S9 | Specialist reviewers after E.6 is merged; done-when; today's reviewer stays until then | Step 9 | E.6 Where it sits (L271) | Faults F24–F30 |
| S10 | Dashboard: Runs view, drawer with `## Summary`, live strip with `agent_id`, events from the work root, lane list from the store | Step 10 | E.2 step 8 (L212); D.2 (L163); D.3 (L173); C.2 (L133) | Display only |
| S11 | Two field runs; done when both finish within their specs with no new enforcement issue | Step 11 | Consequences (L403); E.9 item 3 (L349) | Done-when |
| S-r1 | Each step writes its faults with the step | The plan, in order | E.9 item 1 (L313) | — |
| S-r2 | Nothing is deleted before its replacement passes its fault | The plan, in order | E.1 Delete (L189); E.2 step 6 (L210) | — |

## Proof (plan: How we prove it works)

| ID | Rule in the plan | Plan section | 0016 | Proof |
|---|---|---|---|---|
| P1 | A control counts only when a planted fault catches a deliberate bypass; each fault is written with its step | How we prove it works | E.9 item 1 (L313) | — |
| P2 | Where faults run: kit CI, test project, eval set | How we prove it works | E.9 item 2 (L314) | — |
| P3 | Definition of done (seven conditions) | How we prove it works | E.9 item 3 (L349) | — |
| F1 | A merge while a required check is red or pending, from any account | Fault table | E.9 fault row (L318) | Itself |
| F2 | App pushes to `main`, or to a branch outside `wt/*` and `spec/*` | Fault table | E.9 fault row (L319) | Itself |
| F3 | Required check name that no job reports | Fault table | E.9 fault row (L320) | Itself |
| F4 | A workflow on an App branch reads the Anthropic keys | Fault table | E.9 fault row (L321) | Itself |
| F5 | Agent writes the spec's approval line | Fault table | E.9 fault row (L322) | Itself |
| F6 | Fix or incident lane runs `lane.js scope` before its `spec/<slug>` PR is approved and merged | Fault table | E.9 fault row (L323) | Itself |
| F7 | Illegal stage move | Fault table | E.9 fault row (L324) | Itself |
| F8 | Round past the limit | Fault table | E.9 fault row (L325) | Itself |
| F9 | Lane agent runs `advance`, `gate`, `start` or a merge | Fault table | E.9 fault row (L326) | Itself |
| F10 | Session outside the container approves a PR, merges other than through `kit merge`, or changes protection or the ruleset | Fault table | E.9 fault row (L327) | Itself |
| F11 | `kit merge` runs without the owner's yes | Fault table | E.9 fault row (L328) | Itself |
| F12 | Kit permission rule that does not match its command | Fault table | E.9 fault row (L329) | Itself |
| F13 | Reproductions in #57, #58 and #59 | Fault table | E.9 fault row (L330) | Itself |
| F14 | Lane start with a failed fetch, or with no `origin` and no `local_only` | Fault table | E.9 fault row (L331) | Itself |
| F15 | Failing or missing required check | Fault table | E.9 fault row (L332) | Itself |
| F16 | Lane edits `kit.json` or a `package.json` script | Fault table | E.9 fault row (L333) | Itself |
| F17 | Gate verdict for an older commit | Fault table | E.9 fault row (L334) | Itself |
| F18 | A check that hangs | Fault table | E.9 fault row (L335) | Itself |
| F19 | Low-risk spec whose glob hides a high-risk path | Fault table | E.9 fault row (L336) | Itself |
| F20 | PR widens its own scope list | Fault table | E.9 fault row (L337) | Itself |
| F21 | New test already passes on the base | Fault table | E.9 fault row (L338) | Itself |
| F22 | From inside a lane: edit a guard, read the `gh` token, push to `main`, merge without approval | Fault table | E.9 fault row (L339) | Itself |
| F23 | From inside a lane: write the main repo's `.git/hooks` or `.git/config` | Fault table | E.9 fault row (L340) | Itself |
| F24 | Feature the spec did not ask for | Fault table | E.9 fault row (L341) | Itself |
| F25 | SQL injection | Fault table | E.9 fault row (L342) | Itself |
| F26 | Text below the contrast minimum | Fault table | E.9 fault row (L343) | Itself |
| F27 | Flow with no keyboard path | Fault table | E.9 fault row (L344) | Itself |
| F28 | Call across a forbidden boundary (when `architecture-reviewer` is enabled) | Fault table | E.9 fault row (L345) | Itself |
| F29 | Report without a verdict line | Fault table | E.9 fault row (L346) | Itself |
| F30 | UI review with no browser | Fault table | E.9 fault row (L347) | Itself |

## Known limits

| ID | Rule in the plan | Plan section | 0016 | Proof |
|---|---|---|---|---|
| K1 | No second human | Known limits | E.7 Limit (L290) | Stated |
| K1b | Sessions outside the container run as you and reach your `gh` login and the App key; denials are a guardrail; lane agents count until Step 8 is built | Known limits | E.7 Limit (L290); E.8 item 7 (L301); Open question 5 (L411) | Fault F10 |
| K2 | #46 persists while the Bash guard keeps that rule | Known limits | C.1 #46 (L114) | Stated |
| K3 | #33, #34, #49: reviewers reduce, not remove; the spec approval stays | Known limits | E.6 Why (L250); E.1 Keep (L191) | Faults F24–F28 |
| K4 | Open questions 2 and 3 stay open; 4 moot with the container | Known limits | Open question 2 (L408); Open question 3 (L409); Open question 4 (L410); E.7 item 5 (L284) | Steps 7, 5, 8 |
| K5 | #56 S2, S4–S8 stay undecided | Known limits | E.6 item 5 (L266) | Stated |
| K6 | None of the costs has been measured; the watched run is the first measurement | Cost and speed | Consequences (L403) | Step 4 |

## Reverse: amendment lines in 0016 → rules

| 0016 line | What it says | Rules |
|---|---|---|
| L3 | Header: E.6–E.9 merged in PR #65; E.10 takes effect when the owner merges PR #88 | All rows |
| L13 | License note (answered 2026-11-17) | Q4 |
| L85 | C table, reviewer routing note (see E.6) | D5.3 |
| L197 | E.1 Add 4 note (amended by E.7) | Q1a, Q2, D1.5 |
| L198 | E.1 Add 5 note (amended by E.7) | Q1b, S8 |
| L205 | E.2 step 1 note (a GitHub App) | Q1a, S1 |
| L211 | E.2 step 7 note (every lane that pushes) | Q1b, S8 |
| L214 | E.2 note: steps the amendments insert | S0, S4, S9 |
| L222 | E.3 note (12 steps in the work order) | S0–S11 |
| L248 | E.6 Pins and tags; owner decisions dated 2026-11-17 | Q1a, Q1b, Q2, Q5; this file |
| L250 | E.6 Why | D5.5, K3 |
| L255 | E.6 reviewer table | D5.1, D5.3, F24–F28 |
| L271 | E.6 Where it sits | S9 |
| L277 | E.7 Why | Q1a |
| L286 | E.7 Done when | S1 |
| L288 | E.7 Where it sits | S1, S8 |
| L308 | E.8 Where it sits | S0–S5 |
| L316 | E.9 fault table header | F1–F30 |
| L351 | E.10 heading: merging on the owner's word | D1.11, D1.12, D1.5, D1.6, Q2, S0, S8 |
| L395 | Alternatives: adopt as-is (license answered) | Q4 |
| L396 | Alternatives: automatic spec approval | Q3 |
| L403 | Consequences (12 steps; App, Pro, container; costs unmeasured; license answered) | K6, S11, Q4 |
| L407 | Open question 1 (closed 2026-11-17) | Q4 |
| L411 | Open question 5 (lane inside the container, answered 2026-11-18) | S8, K1b |
| L412 | Open question 6 (App and workflow files, answered 2026-11-18) | D1.2, D1.10 |

## Plan sections that add no rule

The Summary restates rules traced above (items 1–9: Q1a, Q1b, Q2, D1.6, D1.5, D3, D4.1–D4.3, S4, D5.1 and Q5). These inform and are not traced: Evidence baseline; Where the kit stands today (the 15 holes and the issue housekeeping for #29, #30 and #41); What a run looks like once built (the refunds example); the cost-and-speed table (0016 names only the App, GitHub Pro and the container as costs); Earlier versions of this doc; Sources.
