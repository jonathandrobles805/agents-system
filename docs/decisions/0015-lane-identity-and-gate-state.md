# 0015 Lane identity and where gate state lives

Date: 2026-11-14 · Status: proposed · Evidence: issues #43, #50, #51, #53; probe `docs/research/claude-code-hook-attribution-probe.md` (34 payloads); reproductions in this document

One root, five symptoms: **the kit guesses who is acting, and keeps the state its gates depend on where the agents those gates constrain can write it.** This proposes the design and recommends one option per question. It designs nothing outside that root.

Claims are tagged. `[verified: file:line]` was read in this repository at `5f6cd62`. `[observed: payloads.jsonl:N]` is a line of the committed probe log. `[unverified]` has not been observed anywhere.

## Context

### The five symptoms

| | What it is | Where |
|---|---|---|
| #50 | A hook call it cannot place by tool path or cwd resolves to "the single active lane", so the human's main session is treated as inside the lane | `kit/scripts/kitlib.js:898-899` [verified] |
| #51 | A lane agent rewrites its own `lane.json` through Bash: `cd .claude && echo`, `node -e`, or code the lane itself wrote and then ran | `kit/scripts/hook_guard_bash.js:31` [verified] |
| #53 | A lane agent runs `lane.js stage <slug> <same stage>` and both halves of its budget restart; the command is in the kit's own allow list | `kit/scripts/lane.js:723`, `:1247`; `kit/scripts/hook_budget_check.js:69` [verified] |
| 2+ lanes | With two lanes open and no worktree in the payload, no lane's rules apply, and the code says why: "Closing it needs a session-to-lane record, which the kit does not keep" | `kit/scripts/hook_guard_bash.js:144` [verified] |
| §10.14 | All gate evidence is advisory, because the lane writes it | `docs/KIT-SPEC.md` §10.14 |
| #43 | The lane registry lives in git-tracked `kit.json`, so lane records are committed by unrelated commits and come back after `finish` | issue #43 |
| **budget stop is advice** | The budget gate is a **PostToolUse** hook, so the call it objects to has already run, and it "blocks" with `feedbackBlock` — a JSON decision on **stdout** with **exit 0** — which is feedback the agent is asked to honour, not a refusal | `kit/scripts/kitlib.js:763-766` [verified] |

**Two corrections to the first draft of this document, both verified by re-reading and re-running.** It said `hook_budget_check` never reads the `budget` field `setStage` writes. **It reads it** — `...lane.data.budget` is merged between `DEFAULT_BUDGET[stage]` and `budget_override[stage]` [verified: kit/scripts/hook_budget_check.js:61-64]. The probe that appeared to show it ignored was wrong in its instrument, not its subject: the helper captured only stderr, and a block is written to stdout with exit 0 [verified: kit/scripts/kitlib.js:763-766], so the block was invisible. Re-run with stdout captured, a `budget` of `{hours: 1, tool_calls: 5}` on the lane file produces `budget exceeded for stage 'build': 7 tool calls > budget 5; 3.5h elapsed > budget 1h` with no override set. The same wrong claim is in the body of issue #53 and needs correcting there.

They are one fault seen from seven directions. Every gate in the kit asks two questions — *whose call is this* and *what is this lane's state* — and today the first is a guess and the second is a file the subject of the gate can write.

### What a hook can know about who is calling

- The main session's Bash call carries no `agent_id` or `agent_type`; both are null. [observed: payloads.jsonl:3]
- A subagent's Bash call carries `agent_id` and `agent_type` (`"researcher"`, `"general-purpose"`). [observed: payloads.jsonl:13, 16]
- Subagent and main session share one `session_id` and the same `cwd` (the main checkout), so neither distinguishes them. [observed: payloads.jsonl:3, 13, 16]
- **No key is present only for the main session**: its key list is the subagent's minus `agent_id` and `agent_type`. [observed: payloads.jsonl:20]
- Eight `SubagentStop` events carry `agent_type: ""` with `agent_id`s that never appear in a `SubagentStart`. [observed: payloads.jsonl:19]
- `agent_name` never appears as a key in any of the 34 payloads. [observed: payloads.jsonl — F6 count]
- **Edit and Write have not been observed**: every attribution line above is a Bash or Read call. [unverified]
- Whether a hook process inherits `KIT_LANE`, which `lane.js launch` sets on the headless `claude` [verified: kit/scripts/lane.js:702], has not been observed. [unverified]

### Where gate state lives now

| State | File | Writable by a lane agent? |
|---|---|---|
| stage, started, budget, budget_override | `<worktree>/.claude/lane.json` [verified: kit/scripts/kitlib.js:430] | Yes. Blocked for Edit/Write [verified: kit/scripts/kitlib.js:432], not for Bash (#51) or `lane.js stage` (#53) |
| per-stage call counter | `<lane root>/.claude/session/<stage>.<started>.calls` [verified: kit/scripts/hook_budget_check.js:69] | Yes, and resettable by changing `started` (#53) |
| check log | `<worktree>/.claude/session/<slug>.log` | Yes — §10.14 |
| events | `<worktree>/<work>/<slug>.events.jsonl` | Yes |
| lane registry | `<main>/.claude/kit.json` `lanes` | Tracked by git (#43) |
| worker list | **does not exist** | — |

Under `srt` the worktree is exactly what is granted: `allowWrite: [wt, scratch]` and `denyWrite: []` [verified: kit/scripts/sandbox.js:102, 119]. Under `KIT_SANDBOX_RUNTIME=none`, the default, there is no boundary at all: the lane runs as the same uid as everything else.

One host-side sink already exists and is worth noting now: the telemetry collector is spawned by `lane.js launch` before the sandboxed `claude` starts [verified: kit/scripts/lane.js:670, 701] and appends to `$CLAUDE_HOME/kit-telemetry/` — outside the worktree [verified: kit/telemetry/collector.js:5].

### Who owns a stage

Asked for explicitly: where is it defined? **It is not.** `STAGES` is a flat list of names [verified: kit/scripts/lane.js:802]. Agent frontmatter carries `name`, `description`, `tools`, `model`, `hooks` and no stage field [verified: kit/agents/implementer.md:1-6]. Every `lane.js stage` call in the prompts sits in a **command** — `/implement` [verified: kit/commands/implement.md:18, 30, 49], `/review` [verified: kit/commands/review.md:27], `/run` [verified: kit/commands/run.md:25-27, 34] — and never in an agent file. So the intended owner is the orchestrator, expressed only as *which prompt file the line appears in*. There is no machine-readable owner for any gate-state field, which is why `setStage` has no caller check to make.

### What the generated allow list grants

Derived from `kit.json` commands [verified: kit/scripts/bootstrap.js:62-73] plus the fragment's base. In a bootstrapped fixture, read from the file:

```
Bash(git add *), Bash(git commit *), Bash(node "$HOME/.claude/kit/scripts/*),
Bash(node ".../ci_audit.js" --repo .), Bash(node ".../ci_boundaries_simple.js" --repo .),
Bash(npm ci), Bash(npm ci *), Bash(npx eslint .), Bash(npx eslint *),
Bash(npx tsc --noEmit -p .), Bash(npx tsc --noEmit -p . *),
Bash(npx vitest run), Bash(npx vitest run *), Bash(npx vitest run --changed HEAD),
Bash(npx vitest run --coverage...), Edit(/**)
```

The third rule is the one that matters: `Bash(node "$HOME/.claude/kit/scripts/*)` grants **every** kit script, including `lane.js stage`. #53 is not a lane defeating a gate; it is a lane using a grant the kit wrote for it.

## Decision

### 1. Where gate state lives, and how a change is enforced rather than requested

**Under `KIT_SANDBOX_RUNTIME=none` — the default — no location makes state unwritable.** Same uid, no boundary. Any design claiming prevention in that mode is theatre. So the question splits: *prevent* where a boundary exists, *detect* where none does, and in both cases *stop handing the lane the tools*.

**Option A — host state directory.** Move stage/started/counters/workers to `$CLAUDE_HOME/kit-state/<repo>-<sha12>/<slug>/`, outside `allowWrite`.
*Under srt:* real prevention for anything the lane writes directly. *But* the hooks run inside the sandboxed `claude` process, so a hook cannot write there either — and hooks are the current writers of counters and events. This is the wall that stopped the §10.14 relocation: moving the file does not move the writer. [verified: KIT-SPEC §10.14 records that attempt and why it was reverted]
*Under none:* no effect but inconvenience.
*Cost:* every writer must become host-side, which is the runner in §10.14.

**Option B — host-side runner.** The lane requests a named operation; a host process outside the lane executes it and writes the state.
*Prevention:* real under srt and container; none under `none`. *Cost:* a long-lived process, a request protocol, a lifecycle, three runtime variants. Unchanged from §10.14, where it was deferred for exactly this reason.

**Option C — derive from a clock and a counter the lane does not keep.** Replace the file-based counter and the `started` field with values recorded by a process outside the lane: the collector, which `lane.js launch` spawns before the sandboxed `claude` starts [verified: kit/scripts/lane.js:670, 701] and which appends to `$CLAUDE_HOME/kit-telemetry/` outside the worktree [verified: kit/telemetry/collector.js:5]. Both the count and the time come from the collector's own receipt of each record, not from anything the lane writes.
*Not git time.* An earlier draft of this document proposed elapsed time from the worktree's git log. That is wrong: the lane makes the commits, and a committer date is an environment variable (`GIT_COMMITTER_DATE`, `git commit --date`), so git time is agent-authored like any other field. The claim is withdrawn; the only time source in this design the lane cannot write is a host process's own clock.
*Prevention:* the lane cannot *lower* a collector count or move a collector timestamp by writing a file. *Residue:* it can under-report by not emitting, and absence is not zero — a lane with commits and no spans is anomalous and detectable, which is option D's job. *Cost:* the budget gate gains a dependency on telemetry being up, and `metrics.js` already reads that store, so the shape exists.

**Option D — shadow and detect.** The host keeps a copy of gate state outside the lane and compares at every host-side moment (`precheck`, `roadmap-set`, `merged`, CI). Divergence is a refusal with both values shown.
*Prevention:* none. *Detection, stated per mode:* under `srt` or `container` the shadow is outside `allowWrite` [verified: kit/scripts/sandbox.js:102, 119], so a divergence means the live file was changed and the shadow was not — that is detection worth the name. **Under `KIT_SANDBOX_RUNTIME=none` the agent runs as the same uid and can rewrite the shadow too**, so what D catches there is an accident, a crash, or tampering that did not think to look for a second copy. It is not a defence against an agent that knows the design, and this document is in the repository the agent reads. *Cost:* small. *Honest limit in every mode:* it catches a rewrite at the next host-side moment, not before the lane acts on it.

**Option E — stop granting the tools.** Narrow `Bash(node "$HOME/.claude/kit/scripts/*)` to the specific read-only subcommands a lane needs, and make the bash guard refuse gate-state mutation when the caller has an `agent_id`.
*Why this is the enforcement point:* `lane.js stage` is a separate process with no hook payload — **the CLI cannot authenticate its caller**, and a caller check inside `setStage` has nothing to check. The PreToolUse hook does see `agent_id` [observed: payloads.jsonl:13, 16]. So the only layer where "a lane agent may not change the stage" is enforceable rather than requested is the hook plus the allow list. *Cost:* the allow list must enumerate the subcommands a lane legitimately runs; get it wrong and lanes stall. Not a denylist — the allow rule is the narrowing, and the guard rule keys on the *caller*, not on command text.

**Recommendation: E + D now (with §1b for where a stop is enforced and §1c for whose change it is), C next, B only when a machine with `srt` exists to exercise it.** E removes the grant and puts the refusal where identity is observable; D makes a successful write visible before it can be merged; C removes the forgeable input from the budget specifically. A is subsumed by B and should not be attempted alone — the §10.14 revert is the evidence.
State moves as follows: `stage`, `started` and the counters stay readable in `lane.json` (hooks need them without a boundary crossing) and become **shadowed** (D) and **unmutable-by-agent** (E); the worker list is new and lives in the shadow from the start; evidence stays as §10.14 describes it, with that section rewritten per mode rather than as one blanket "advisory".

### 1b. Where a budget stop is actually enforced

A budget that stops nothing is not a gate. Today the check runs on **PostToolUse** — after the call — and returns `feedbackBlock`: a decision on stdout, exit 0 [verified: kit/scripts/kitlib.js:763-766]. The over-budget call has already happened, and whether the agent then stops is the agent's choice. Every number in #41 and #53 was measured through that instrument.

**Options.**

- **Move the check to PreToolUse and deny.** A PreToolUse hook exiting 2 blocks the call before it runs and takes precedence over allow rules [docs: https://code.claude.com/docs/en/permissions.md @ 2026-11-13]. The over-budget call does not happen.
  *Cost:* the counter must be incremented somewhere, and incrementing in PreToolUse counts attempts rather than completed calls — a blocked call would otherwise increment forever. The shape: PreToolUse decides and refuses, PostToolUse counts what actually ran.
- **Keep PostToolUse, add a PreToolUse refusal that reads the same counter.** Two hooks, one state, no change to counting. *Cost:* two places to keep in step; the PostToolUse feedback becomes redundant once the PreToolUse refusal exists.
- **Leave it as feedback and rely on the Stop hook.** Today's behaviour. *Cost:* an agent that ignores the feedback runs until the Stop hook, which is where done-check lives; the budget then bounds nothing within a turn.

**Recommendation: PreToolUse denies, PostToolUse counts.** The refusal belongs where a refusal is possible, and the count belongs where a call is known to have happened. This also fixes the measurement problem the corrections above exposed: a gate whose only signal is stdout is one a test or a probe reads as a pass, which is how two of my own probes reported a block as silence.

**Unverified until P7:** whether a lane in practice keeps calling tools after a PostToolUse block. Nothing in this session observed an agent's response to `feedbackBlock`, so the sentence "the agent may ignore it" is a reading of the mechanism — stdout and exit 0 cannot refuse — and **not** an observation of a lane doing so. [unverified]

### 1c. How a stage or budget change becomes the human's, not the orchestrator's

The earlier draft said the human gets "a host-side command the agent does not have". That is wrong in an important way: **the main session is the human *and* the orchestrator AI**, they share one `session_id` and one `cwd` [observed: payloads.jsonl:3, 13, 16], and no key in any payload separates them. Anything host-side that the human can run, the orchestrator can run. "Not a lane agent" is not "a person".

So the distinction cannot come from the payload. It has to come from a layer that asks a person:

- **An `ask` rule in the generated settings**, on `Bash(node "$HOME/.claude/kit/scripts/lane.js" stage *)` and on edits to the lane file. Rules are evaluated deny → ask → allow with the first match winning [docs: https://code.claude.com/docs/en/permissions.md @ 2026-11-13], so an `ask` rule takes precedence over the broad `Bash(node "$HOME/.claude/kit/scripts/*)` grant without that grant being removed. In an attended session the human is prompted, and the approval *is* the human's act. In a headless lane, a call needing approval is **denied, not held** [docs: https://code.claude.com/docs/en/permission-modes.md @ 2026-11-13], so the same rule makes the change impossible rather than unattended. One rule, both halves.
  *Cost:* the human is prompted every time, including for the orchestrator's legitimate stage transitions in `/implement` and `/run` [verified: kit/commands/implement.md:18, 30, 49; kit/commands/run.md:25-27] — which is a prompt per stage change, four or five per lane. That is the price of the change being a person's.
  *Status of the mechanism:* both halves are documented; **neither has been observed in this session** — `claude -p` returns an authentication error here, so the headless-denial half in particular is docs-verified and not run. [unverified]
- **A PreToolUse hook returning `ask`.** Would allow the kit to decide *when* to prompt (for example, only when the new stage is not the next one in `STAGES` [verified: kit/scripts/lane.js:802]), rather than always.
  *Cost:* whether a PreToolUse hook may return an `ask` decision was not read in the hooks reference during this session. [unverified] If it cannot, this option does not exist.
- **Require a token only the human has** (a value typed into the command). Rejected: the orchestrator reads the same files and the same scrollback the human does, so any token in the repository or the session is available to it.

**Recommendation: the `ask` rule in the generated settings, scoped to stage changes and lane-file edits.** It is the only option whose attended and headless behaviour both follow from documented rules, and it is the only place in this design where "a person decided" is represented by a person actually deciding. Confirm the headless half with the probe list before relying on it.

### 2. How a lane learns its workers, from one source

**Bind at `SubagentStart`.** The hook receives `agent_id` and the agent's type; it writes `agent_id → {slug, agent_type, at}` into the lane's worker list. Every later call is attributed by looking up its `agent_id`, not by inferring from cwd.

- *Single source:* the shadow state from §1 (`workers.json`), written only at `SubagentStart`, read by every hook. One writer, one reader path.
- *Why not the agent frontmatter:* it has no stage or lane field [verified: kit/agents/implementer.md:1-6], and a prompt file cannot carry a per-run binding.
- *Why not `kit.json`:* that is #43.
- **Gap:** eight `SubagentStop` events carry `agent_type: ""` and `agent_id`s never seen at `SubagentStart` [observed: payloads.jsonl:19], so **some agents stop without having started**, as far as a hook can see. Until probe P3 explains them, a binding built only at `SubagentStart` has holes of unknown size. This is the single largest unknown in this design.

### 3. Identifying a headless worker with something the agent cannot change

Candidates, in order of strength:

1. **`agent_id` from the payload.** The agent does not author its own payload. Strongest — but observed for Bash and Read only [observed: payloads.jsonl:13, 16], and **not for Edit or Write** [unverified], which is where the scope guard lives.
2. **`KIT_LANE` in the hook's environment.** `lane.js launch` sets it on the headless `claude` [verified: kit/scripts/lane.js:702]. A lane agent can set an env var for a process *it* spawns, but not for the hook process Claude Code spawns. Whether hooks inherit it is **unobserved** [unverified] — probe P2.
3. **The worktree path in the tool payload.** Already used, already correct where present [verified: kit/scripts/kitlib.js:894-895], and absent for Bash and for stop events.

**Recommendation: `agent_id` as the identity, `KIT_LANE` as the lane it belongs to if P2 confirms inheritance, tool path as corroboration.** If P2 fails, the lane comes from the `SubagentStart` binding alone, with the §2 gap.

### 4. Fail-closed behaviour — and the honest answer about a missing `agent_id`

**Asked directly: is there any signal that tells "main session" from "`agent_id` dropped by a Claude Code change"? No.** The probe is explicit that no key is present only for the main session: its key list is the subagent's minus those two keys [observed: payloads.jsonl:20]. An absent `agent_id` and a removed `agent_id` are byte-identical to a hook. A design that reads absence as "this is the human" fails silently and completely the day that field is renamed, and the failure direction is *unguarded lane agents*.

Options for closing it, with costs:

- **Pin or check the Claude Code version.** The hook records the version it was validated against and refuses, or warns, when the running version differs. *Cost:* the version is not in any observed payload [observed: payloads.jsonl — F6 key lists], so the hook must shell out to `claude --version` — a process per hook call, on every tool call — or read a cached value that is itself writable by the lane. Brittle and either slow or forgeable.
- **Positive binding at `SubagentStart` (§2).** Then a lane agent is identified by *presence* in the binding, not by absence of a key. Unknown `agent_id` → unbound → fail closed. Removal of `agent_id` makes every subagent unbound rather than main-session, which fails *closed*. *Cost:* the §2 `SubagentStop` gap, and the binding must survive compaction and resume (§5).
- **A positive main-session marker the kit creates.** Rejected: a subagent shares the session [observed: payloads.jsonl:3, 13, 16 — one `session_id`], so it inherits anything session-scoped.

**Recommendation: positive binding, and never treat absence as authority.** Then the fail-closed table splits by what a gate does:

| Situation | A gate that *restricts* (bash rules, scope, config) | A gate that *attributes* (budget, events, evidence) |
|---|---|---|
| No `agent_id` | Apply the lane's restrictions **if** the call is otherwise placed in a lane (tool path, `KIT_LANE`); never place it by "single active lane" | Attribute to nothing; count nothing |
| `agent_id` not in the binding | Restrict, and record `unbound_agent` | Attribute to nothing; refuse at the next host-side gate (D) |
| 2+ lanes, no placement | Restrict under the union of open lanes' rules | Attribute to nothing; refuse `done`/`merged` until resolved |
| Binding lost (compaction, resume, crash) | Restrict; a lost binding is not a licence | Refuse to advance the lane until a host-side command rebinds |

Two consequences stated plainly. Restricting on uncertainty and attributing on certainty is deliberate: a false restriction costs a stalled call with a message; a false attribution costs an unguarded lane or a wrong budget. And "restrict under the union" for 2+ lanes is a change from today, where ambiguity applies no rules at all [verified: kit/scripts/hook_guard_bash.js:144-152]; it closes that residue at the cost of occasionally refusing a legitimate call in a two-lane repository.

### 5. Failure modes, per option

| Option | Forged binding | Stale state | Race between subagents | Human legitimately changes stage or budget |
|---|---|---|---|---|
| A host dir | Lane cannot write it under srt; under `none` it can forge freely | A crashed lane leaves state no one clears | Two hooks writing one file need a lock; none exists today | Works: the human is host-side |
| B runner | Lane can request, not write; it can still request a weak operation | Runner down = no state; §10.14's fail-closed-on-evidence applies | Serialised by the runner, which is its main advantage | Works, and is auditable |
| C derived | Cannot forge a collector count downward; can under-emit | Collector down = undercount, which looks like compliance | None: the store is append-only per record | A human raise must live somewhere else — `budget_override` stays a file (D shadows it) |
| D shadow | Forgery is detected, not prevented; detection is as good as the last host-side moment | Shadow and live diverge for legitimate reasons too; every divergence needs an owner | Two subagents diverging from one shadow is indistinguishable from one tampering | **The failure mode to watch:** a human editing `lane.json` by hand looks exactly like tampering unless the change goes through a host-side command |
| E narrow allow + guard | Nothing to forge: the refusal is on the caller, not on text | Allow list drifts from what lanes need; stalls | None | **The human must have a path the agent does not:** a host-side `lane.js stage` run outside any agent, which E permits by construction |

The recurring risk across D and E is the same: **a legitimate human change must be distinguishable from tampering.** The design answer is that a human's change goes through the same host-side command that writes the shadow, so "changed by a non-agent caller" is recorded rather than inferred. Any human edit made by hand to `lane.json` will — correctly — be reported as divergence.

### 6. What the existing fixes become

- **`b3d4f54` (#41a, per-stage counter + `budget_override` survives a stage change): keep the override merge, redo the counter key.** The key is `${stage}.${started}` [verified: kit/scripts/hook_budget_check.js:69] and `started` is agent-writable (#53), so the fix is correct in intent and resettable in practice. Under C the count comes from the collector; under D the `started` the hook trusts is the shadow's, not the lane's.
- **`#29` (`laneForHook`, one resolver, three tiers): keep tiers 1 and 2, remove tier 3.** Tier 3 *is* #50 [verified: kit/scripts/kitlib.js:898-899]. I added it deliberately and documented it as the subagent case; the probe shows the subagent case should be answered by `agent_id`, not by counting open lanes. The resolver stays — one derivation for every hook is still right — and its third tier becomes the binding lookup.
- **`#29`'s ambiguity policy: change.** `guard-bash` currently applies no lane rules with 2+ lanes open and logs `lane_unresolved` [verified: kit/scripts/hook_guard_bash.js:144-152]. Under §4 it applies the union and keeps the event.
- **`#35`'s evidence gate: unchanged by this design, and already known wrong elsewhere** (#45 — it runs after the merge it protects). Out of scope here.
- **§10.14: rewrite, do not delete.** Its claim that evidence is advisory *because the lane writes it* stays exactly true under `none`. It becomes a per-mode statement once E and D land: advisory under `none`, detected-after-the-fact under D, prevented for mutation-by-agent under E.

### 7. What must be observed before any code

Run on the Mac session, where a live `claude` exists. None of these can be run here: `claude -p` returns an authentication error in this environment, so no live session is available.

| | Probe | How |
|---|---|---|
| **P1** | **Do Edit and Write carry `agent_id`?** The scope guard is an Edit/Write hook, and no Edit or Write payload has ever been seen. | Extend the existing probe hook to PreToolUse/PostToolUse on `Edit|Write|MultiEdit|NotebookEdit`; have one subagent and the main session each edit a file; compare key lists as F4 did. |
| **P2** | **Does a hook process inherit `KIT_LANE`?** `lane.js launch` sets it [verified: kit/scripts/lane.js:702]; §3 option 2 depends on it entirely. | `lane.js launch <slug> --exec` with a probe hook that records `process.env.KIT_LANE`. Needs a real headless lane, which is also still unverified end to end. |
| **P3** | **What are the eight empty-`agent_type` `SubagentStop` events?** [observed: payloads.jsonl:19] They decide whether a `SubagentStart` binding has holes. | Log `SubagentStart` and `SubagentStop` for a long session and match `agent_id`s; if they still never pair, read the hooks reference for internal agents. |
| **P4** | **Can a hook write outside `allowWrite` under srt?** Decides whether option A can ever work without B. | On a machine with `srt`: a hook that writes to `$CLAUDE_HOME/kit-state/probe` inside a launched lane; record the error. |
| **P5** | **Is `claude --version` cheap and reachable from a hook?** Decides whether version-pinning in §4 is viable at all. | Time 100 `claude --version` calls; check it runs inside a sandboxed lane. |
| **P6** | **Does a headless lane reach `setStage` through an allowed command?** #53 shows the direct path; #51 raises the indirect one (a test file the lane wrote, run by `npm test`). | A lane whose test file calls `lane.js stage`; run the allowed `npm test`; read `lane.json`. |
| **P7** | **Does a lane keep calling tools after a budget block?** §1b rests on the mechanism — stdout and exit 0 cannot refuse [verified: kit/scripts/kitlib.js:763-766] — and on no observation of an agent's response. | Run a real lane with a budget set to a handful of calls; after the first `feedbackBlock`, count tool calls in the lane's events file and the collector store. Record whether it stopped, stopped after N more calls, or continued. Also confirm the other half: an `ask` rule on `lane.js stage *` prompts in an attended session and is denied under `claude -p --permission-mode default`. |

P1 and P3 gate §2 and §3. P4 gates option A. P7 gates §1b.

**What E + D actually cover, restated precisely.** The earlier draft said nothing in the recommendation depends on an unobserved fact. That was too strong, and the reason matters: **a headless lane's worker has no `agent_id`.** `lane.js launch` runs `claude -p` [verified: kit/scripts/sandbox.js:139 via issue #51; kit/scripts/lane.js:702], so inside that nested process the worker *is* a main session, and a main session carries no `agent_id` [observed: payloads.jsonl:3]. E therefore has two halves that cover different populations and neither covers both:

| | Attended lane (subagents in a human's session) | Headless lane (`launch --exec`) |
|---|---|---|
| Narrowed allow list + `ask` rule (§1c) | Covers it — prompts the human | Covers it — a call needing approval is denied [docs @ 2026-11-13, not observed] |
| Refusal keyed on `agent_id` (§4) | Covers it — subagent Bash carries `agent_id` [observed: payloads.jsonl:13, 16] | **Does not cover it** — no `agent_id` to key on |
| D, shadow and detect | Detects, per mode (§1 option D) | Detects, per mode |

So: the allow list and the permission mode are what hold in a headless lane; `agent_id` is what holds for attended subagents; D is the only part that applies to both without an unobserved fact. The parts of E that rest on documentation rather than observation are the two in §1c, and the `agent_id` half rests on Bash and Read only, never Edit or Write (P1).

## Alternatives rejected

- **Keep the single-active fallback and add a cwd check** — cwd is identical for main session and subagent [observed: payloads.jsonl:3, 13, 16]. There is nothing to check.
- **A caller check inside `setStage`** — the CLI is a separate process with no payload; it cannot authenticate its caller. The check has to be in the hook or the permission rules.
- **A host-side command as the human's channel** — rejected in §1c: the orchestrator AI shares the main session with the human [observed: payloads.jsonl:3, 13, 16], so every host-side path open to the human is open to it. Only a layer that prompts a person distinguishes them.
- **Elapsed time from git** — rejected in §1 option C: the lane makes the commits and a committer date is an environment variable, so git time is agent-authored.
- **Match the commands that write gate state** (`cd .claude &&`, `node -e`, …) — a denylist of ways to write a file, which #51 already shows is unbounded: the issue's own body could not be written with a heredoc because the guard matched the quoted text (#40).
- **Signing the state** — a key the forger can read signs forgeries, recorded in §10.14 and unchanged by anything here.
- **Treating absence of `agent_id` as "main session"** — §4: indistinguishable from the field being removed, and it fails open.

## Consequences

Easier: one place decides who is calling, and one place holds what a gate reads. A human's change is a person answering a prompt rather than an inference from a payload. The budget stops being resettable by its subject, and a budget stop refuses the call instead of asking the agent to stop. §10.14 can say what is enforced in which mode instead of one blanket disclaimer.

Harder: lanes can be stalled by a narrowed allow list that is missing a subcommand they need, and by restriction-on-uncertainty in a two-lane repository. A human who edits `lane.json` by hand will be reported as divergence, correctly and annoyingly. And the strongest part of the design — binding by `agent_id` — rests on an observation that covers Bash and Read on one machine and one Claude Code version [observed: payloads.jsonl], has never been seen for Edit or Write, and has an unexplained hole in `SubagentStart` pairing. **Nothing here should be built before P1 and P3.** Two more honest limits, after review: under `KIT_SANDBOX_RUNTIME=none` — the default — D detects accidents and tampering that did not look for a second copy, and nothing more, because the agent shares the uid and can rewrite the shadow; and in a headless lane the identity half of E does not apply at all, since that worker is a main session with no `agent_id`, leaving the allow list and the permission mode as the only things holding there.
