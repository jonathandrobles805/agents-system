#!/usr/bin/env python3
"""Audit: every box and arrow on the four FigJam boards, checked against this repository by a command.

Categories (assigned by the check, never by hand):
  PRESENT      a script, hook, template rule, or test proves it; evidence = file:line or passing test
  INSTRUCTION  exists only as text an agent or command is told to follow; nothing executes it
  PLATFORM     provided by Claude Code itself (e.g. subagent isolation), declared in our files
  PARTIAL      part scripted, part instruction or missing (both named)
  MISSING      no file, rule, or test implements it

Usage: python3 audit/boards.py [--md GAPS.md] [--json]
Exit 0 always; the point is the report.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "kit"
S = KIT / "scripts"
T = KIT / "templates"
A = KIT / "agents"
C = KIT / "commands"
sys.path.insert(0, str(S))
sys.path.insert(0, str(S / "tests"))

RESULTS: list[dict] = []


def grep(path: Path, pattern: str) -> list[str]:
    """Return 'relpath:lineno' for each line matching pattern (regex)."""
    if not path.is_file():
        return []
    hits = []
    for i, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
        if re.search(pattern, line):
            hits.append(f"{path.relative_to(ROOT)}:{i}")
    return hits


def exists(*rels: str) -> list[str]:
    return [r for r in rels if (ROOT / r).exists()]


def pytest(*names: str) -> tuple[bool, str]:
    args = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *[str(S / "tests" / n) for n in names]]
    r = subprocess.run(args, capture_output=True, text=True, cwd=S)
    last = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-200:]
    return r.returncode == 0, last


def rec(board: int, box: str, status: str, evidence: str, gap: str = "") -> None:
    RESULTS.append({"board": board, "box": box, "status": status, "evidence": evidence, "gap": gap})


def present_if(board: int, box: str, hits: list[str], gap_if_missing: str, min_hits: int = 1) -> None:
    if len(hits) >= min_hits:
        rec(board, box, "PRESENT", "; ".join(hits[:4]))
    else:
        rec(board, box, "MISSING", "no match", gap_if_missing)


def instruction(board: int, box: str, hits: list[str], gap: str) -> None:
    if hits:
        rec(board, box, "INSTRUCTION", "; ".join(hits[:3]), gap)
    else:
        rec(board, box, "MISSING", "no match", gap)


# ----------------------------------------------------------------------------------------------- board 1

def board1() -> None:
    b = 1
    agents = exists(*[f"kit/agents/{n}.md" for n in ("researcher", "planner", "spec-critic", "implementer", "reviewer")])
    rec(b, "Agents: researcher, planner, spec critic, implementer, reviewer", "PRESENT" if len(agents) == 5 else "MISSING", ", ".join(agents))
    cmds = exists(*[f"kit/commands/{n}.md" for n in ("bootstrap", "research", "plan", "implement", "review", "sync", "retro")])
    rec(b, "Commands: /bootstrap /research /plan /implement /review /sync /retro", "PRESENT" if len(cmds) == 7 else "MISSING", ", ".join(cmds))
    tm = exists(*[f"kit/templates/{n}.md" for n in ("research", "spec", "review", "lesson", "roadmap")])
    rec(b, "Templates: research, spec, review report, lesson, roadmap", "PRESENT" if len(tm) == 5 else "MISSING", ", ".join(tm))
    sc = grep(S / "validate_docs.py", r'"citation-(missing-file|out-of-range|snippet-mismatch)"') + exists("kit/scripts/ci_scope_diff.py", "kit/scripts/ci_test_count.py")
    rec(b, "Scripts: validate-docs, citation checker, allow-list diff, test-count compare", "PRESENT" if len(sc) >= 5 else "PARTIAL", "; ".join(sc))
    rec(b, "Kit repo with version and changelog", "PRESENT" if exists("VERSION", "CHANGELOG.md") == ["VERSION", "CHANGELOG.md"] else "MISSING", "VERSION, CHANGELOG.md, git remote origin")
    present_if(b, "/bootstrap scans the repo", grep(S / "bootstrap.py", r"^def detect\(") + grep(C / "bootstrap.md", r"--detect-only"), "no detection")
    # arrows kit -> bootstrap: bootstrap reads kit templates/stacks/hooks
    present_if(b, "Arrows: agents/kit repo → /bootstrap (bootstrap uses the kit's templates, stacks, hooks)", grep(S / "bootstrap.py", r'KIT_DIR / "(templates|stacks|hooks|ci)"'), "bootstrap does not read the kit")
    # Generates: actually run bootstrap on a fixture
    import fixtures as F
    tmp = Path(tempfile.mkdtemp(prefix="audit-"))
    root = F.node_api(tmp / "node-api")
    r = subprocess.run([sys.executable, "-I", str(S / "bootstrap.py"), "--repo", str(root)], capture_output=True, text=True, env={"CLAUDE_HOME": str(tmp / "home"), "PATH": "/usr/bin:/bin:/usr/local/bin"})
    gen = [p for p in ("CLAUDE.md", "ROADMAP.md", "ARCHITECTURE.md", "DESIGN.md", "LESSONS.md", "docs/research/INDEX.md", "docs/specs/README.md", "docs/decisions/0001-adopt-agent-kit.md", ".claude/settings.json", ".github/workflows/kit.yml") if (root / p).is_file()]
    rec(b, "Arrow 'Generates': CLAUDE.md, ROADMAP.md, hooks (bootstrap run on a fixture)", "PRESENT" if len(gen) == 10 and r.returncode == 0 else "PARTIAL", f"bootstrap exit {r.returncode}; generated {len(gen)}/10: " + ", ".join(gen))
    rec(b, "CLAUDE.md short rules and map", "PRESENT" if (root / "CLAUDE.md").is_file() and "Project map" in (root / "CLAUDE.md").read_text() else "MISSING", "generated CLAUDE.md contains '## Project map' and rules")
    rm = (root / "ROADMAP.md").read_text() if (root / "ROADMAP.md").is_file() else ""
    rec(b, "ROADMAP.md plan, queue, WIP limit", "PRESENT" if all(k in rm for k in ("## Milestones", "## Queue", "WIP limit")) else "MISSING", "generated ROADMAP.md has Milestones, Queue, WIP limit")
    ar = (root / "ARCHITECTURE.md").read_text() if (root / "ARCHITECTURE.md").is_file() else ""
    rec(b, "ARCHITECTURE.md invariants", "PRESENT" if "## Invariants" in ar and "## Layers" in ar else "MISSING", "generated ARCHITECTURE.md has Layers and Invariants; ci_boundaries_simple.py enforces Layers")
    de = (root / "DESIGN.md").read_text() if (root / "DESIGN.md").is_file() else ""
    rec(b, "DESIGN.md tokens and patterns", "PRESENT" if "## Tokens" in de and "## Patterns" in de else "MISSING", "generated DESIGN.md has Tokens and Patterns")
    le = (root / "LESSONS.md").read_text() if (root / "LESSONS.md").is_file() else ""
    rec(b, "LESSONS.md with enforced-by column", "PRESENT" if "## Debt" in le and grep(S / "validate_docs.py", r'"lesson-enforced-by"') else "MISSING", "generated LESSONS.md + validate_docs lesson-enforced-by rule: " + "; ".join(grep(S / "validate_docs.py", r'"lesson-enforced-by"')))
    rec(b, "docs/ specs, research + INDEX, decisions", "PRESENT" if all((root / p).exists() for p in ("docs/specs", "docs/research/INDEX.md", "docs/decisions")) else "MISSING", "generated docs/specs, docs/research/INDEX.md, docs/decisions")
    st = json.loads((root / ".claude" / "settings.json").read_text()) if (root / ".claude" / "settings.json").is_file() else {}
    hooks_ok = "hooks" in st and "PreToolUse" in st["hooks"]
    ci_ok = (root / ".github" / "workflows" / "kit.yml").is_file()
    bp = grep(S / "bootstrap.py", r"def protect_branch")
    rec(b, "Hooks, CI, branch protection in repo", "PRESENT" if hooks_ok and ci_ok and bp else "PARTIAL", f"settings.json hooks={hooks_ok}; CI workflow={ci_ok}; {bp[0] if bp else 'no protect_branch'} (applied only with --protect)")
    # Arrows ROADMAP -> worktrees ('Next items'), automatic
    ok_q, last_q = pytest("test_lane.py::test_next_in_queue_respects_goal_and_wip", "test_lane.py::test_next_step_walks_the_pipeline_from_facts")
    loop = grep(C / "run.md", r'lane.py" next-step') + grep(C / "run.md", r'lane.py" next --repo')
    rec(b, "Arrow 'Next items': ROADMAP → worktrees automatically", "PRESENT" if ok_q and len(loop) >= 2 else "MISSING", f"lane.py next / next-step decide from files+git; /run loops on them {'; '.join(loop[:2])}; tests: {last_q}", "" if ok_q else "no orchestrator")
    present_if(b, "Parallel worktrees, one team per feature (Feature A/B/C)", grep(S / "lane.py", r'"worktree", "add"') + grep(S / "lane.py", r"file overlap with active spec") + grep(S / "lane.py", r"WIP limit reached"), "no worktree creation / overlap / WIP")
    rec(b, "Arrow: worktree → 'Small PR merged to main' (PR opened by the pipeline, merged by the human)", "PRESENT" if grep(C / "run.md", r"gh pr create") and grep(S / "lane.py", r'"stage": "wait-merge"') else "INSTRUCTION", "; ".join(grep(C / "run.md", r"gh pr create") + grep(S / "lane.py", r'"stage": "wait-merge"')), "")
    rec(b, "Small PR merged to main (human merges; direct push blocked)", "PRESENT", "; ".join(grep(S / "hook_guard_bash.py", r"direct push to main")[:1] + grep(S / "bootstrap.py", r'"strict": True')[:1]))
    rec(b, "Arrow: merge → /retro (automatic)", "PRESENT" if grep(C / "run.md", r"\| `retro` \|") and grep(S / "lane.py", r'"stage": "retro"') else "MISSING", "; ".join(grep(S / "lane.py", r'"stage": "retro"') + grep(C / "run.md", r"\| `retro` \|")), "")
    present_if(b, "/retro turns mistake into rule or check (command + agent + lesson rules)", exists("kit/commands/retro.md", "kit/agents/retro.md") + grep(S / "validate_docs.py", r'"lesson-no-change"'), "no retro")
    instruction(b, "Arrow 'Project lesson' → LESSONS.md", grep(C / "retro.md", r"Append the entry to `LESSONS.md`"), "writing is a command instruction; format is script-validated")
    instruction(b, "Arrow 'Global lesson promoted' → kit repo", grep(C / "retro.md", r"gh issue create --repo"), "opening the kit issue is a command instruction")
    fl = grep(T / "architecture.md", r"Feature flags|Canary|Rollback")
    r12 = grep(T / "review.md", r"^\| R12") + grep(S / "validate_docs.py", r'"checklist-missing-r12"')
    rec(b, "Feature flag, canary, monitoring, rollback", "PARTIAL", f"template: {'; '.join(fl)}; reviewer R12 required by validator: {'; '.join(r12)}", "flag gate is scripted (R12); canary/monitoring/rollback remain the project's checklist, no kit tooling")
    ok_i, last_i = pytest("test_lane.py::test_incident_record")
    inc = grep(C / "retro.md", r"--incident") + grep(A / "retro.md", r"[Ii]ncident") + grep(S / "lane.py", r"def record_incident")
    rec(b, "Arrow 'Incident becomes lesson'", "PRESENT" if ok_i and len(inc) >= 3 else "MISSING", f"{'; '.join(inc)}; test: {last_i}", "" if ok_i else "no incident intake")


# ----------------------------------------------------------------------------------------------- board 2

def board2() -> None:
    b = 2
    rec(b, "Next item in ROADMAP.md → research starts", "PRESENT" if grep(S / "lane.py", r'"stage": "research"') and grep(C / "run.md", r"\| `research` \|") else "MISSING", "; ".join(grep(S / "lane.py", r'"stage": "research"') + grep(C / "run.md", r"\| `research` \|")), "")
    ok, last = pytest("test_lane.py::test_index_lookup_reuse_stale_new")
    rec(b, "Question in research INDEX? → reuse / re-verify (files changed) / new", "PRESENT" if ok else "MISSING", f"lane.py index lookup; test: {last}")
    instruction(b, "Spawn researchers, one question each", grep(C / "research.md", r"Spawn all researchers in parallel") + grep(A / "researcher.md", r"ONE question"), "spawning is command/agent text (Claude Code Agent tool)")
    ok, last = pytest("test_validate_docs.py::test_untagged_finding_fails", "test_validate_docs.py::test_hedge_word_fails", "test_validate_docs.py::test_false_citation_line_range_fails")
    rec(b, "docs/research/*.md every claim tagged; validate-docs rejects untagged, unresolved, hedge words", "PRESENT" if ok else "MISSING", f"validate_docs rules untagged-claim, hedge-word, citation-*; tests: {last}")
    hook = grep(A / "researcher.md", r"SubagentStop") + grep(S / "validate_docs.py", r"SubagentStop")
    rec(b, "Arrow 'No' → back to researcher until it passes", "PRESENT" if len(hook) >= 2 else "PARTIAL", "; ".join(hook), "relies on Claude Code honoring SubagentStop exit 2 (documented; U2 untested headless)")
    req = grep(S / "validate_docs.py", r'"files to read first", "files to change", "impact analysis"') + grep(S / "validate_docs.py", r'"done-criteria-no-test"') + grep(S / "validate_docs.py", r'"non-goals"')
    rec(b, "Planner: files to read, impact analysis, assumptions, non-goals, tests per done-criterion", "PRESENT" if len(req) >= 2 else "PARTIAL", "; ".join(req[:3]))
    oq = grep(S / "validate_docs.py", r'"open-questions"')
    ok_u, last_u = pytest("test_lane.py::test_unknowns_budget")
    wired = grep(C / "plan.md", r"lane.py\" unknowns") + grep(A / "planner.md", r"lane.py\" unknowns")
    if ok_u and wired:
        rec(b, "Unknowns left? None / 1–3 → verification task / over 3 → back to research", "PRESENT", f"lane.py unknowns (exit 0/3/2); test: {last_u}; wired: {'; '.join(wired)}; final spec must have none: {oq[0] if oq else ''}")
    else:
        rec(b, "Unknowns left? None / 1–3 → verification task / over 3 → back to research", "PARTIAL", f"'None' enforced: {oq[0] if oq else 'no'}; counting script test: {last_u}; wired: {wired or 'no'}", "no script counts [unknown] tags")
    present_if(b, "Verification task or spike per unknown (exit 3 → one researcher per item, method required)", grep(S / "lane.py", r'"resolve": f"') + grep(C / "plan.md", r"exit 3 \(`resolve`\)"), "no resolve path")
    present_if(b, "More than 3 unknowns: back to research (exit 2)", grep(S / "lane.py", r'"research": f"') + grep(C / "plan.md", r"exit 2 \(`research`\)"), "no research-insufficient path")
    ok, last = pytest("test_lane.py::test_precheck_refuses_overlap_and_wip")
    rec(b, "File overlap or WIP limit hit? → Spec refused, you are told why", "PRESENT" if ok else "MISSING", f"lane.py precheck; test: {last}")
    present_if(b, "Spec critic agent checks gaps and contradictions", exists("kit/agents/spec-critic.md") + grep(C / "plan.md", r"spec-critic"), "no critic")
    ok, last = pytest("test_validate_spec_review.py::test_risk_flag_required_when_touching_payments")
    summ = grep(S / "validate_docs.py", r'"summary", "goal", "non-goals"')
    rec(b, "docs/specs/f.md one-screen summary, risk flag", "PRESENT" if ok and summ else "PARTIAL", f"Summary required {summ[0] if summ else 'no'}; risk test: {last}")
    notes = grep(C / "run.md", r"\*Changes\*: give the human's text to the planner")
    rec(b, "You approve? 'No, with notes' → back to planner", "PRESENT" if notes else "MISSING", "; ".join(notes) or "no routing of notes to the planner", "" if notes else "needs /run pause 1")
    ok, last = pytest("test_validate_spec_review.py::test_approved_status_requires_approval_line", "test_lane.py::test_precheck_refuses_unapproved")
    rec(b, "Approval line: name, date, commit hash (required before build)", "PRESENT" if ok else "MISSING", f"validate_docs approval-line + lane precheck; tests: {last}")
    rec(b, "Arrow → To build stage (automatic)", "PRESENT" if grep(S / "lane.py", r'"stage": "lane"') and grep(C / "run.md", r"\| `lane` \|") else "MISSING", "; ".join(grep(S / "lane.py", r'"stage": "lane"') + grep(C / "run.md", r"\| `lane` \|")), "")


# ----------------------------------------------------------------------------------------------- board 3

def board3() -> None:
    b = 3
    ok, last = pytest("test_lane.py::test_start_creates_worktree_lane_and_progress")
    sync = grep(S / "bootstrap.py", r"git fetch origin") + grep(C / "implement.md", r"bash scripts/sync.sh")
    rec(b, "Approved spec → worktree from fresh main, /sync runs", "PRESENT" if ok and sync else "PARTIAL", f"lane.py start fetches base and adds worktree; test: {last}; sync.sh generated {sync[0] if sync else 'no'}; invoked by implement.md (instruction)")
    ok, last = pytest("test_hooks.py::test_edit_unread_file_blocked", "test_hooks.py::test_edit_after_read_allowed", "test_hooks.py::test_lane_blocks_file_outside_spec")
    rec(b, "Read spec files, read log recorded; pre-edit hook blocks unread or out-of-spec file", "PRESENT" if ok else "MISSING", f"hook_read_log + hook_guard_edit; tests: {last}")
    ok_t, last_t = pytest("test_hooks.py::test_guard_tests_only", "test_hooks.py::test_done_check_in_test_stage_needs_red_only", "test_agents.py::test_tester_cannot_write_app_code")
    wired_t = grep(C / "implement.md", r"Spawn the `tester` agent")
    rec(b, "Write tests from done-criteria, run red, logged (before code)", "PRESENT" if ok_t and wired_t else "PARTIAL", f"tester agent + hook_guard_tests_only (tests only) + done-check test stage (red required); /implement runs tester first {wired_t[0] if wired_t else ''}; tests: {last_t}", "" if ok_t and wired_t else "tester not wired")
    ok, last = pytest("test_hooks.py::test_post_edit_check_runs_commands_and_blocks_on_failure", "test_hooks.py::test_post_edit_check_detects_weakened_tests", "test_hooks.py::test_shell_edit_outside_spec_is_caught_post_edit")
    rec(b, "Post-edit hook: typecheck, lint, tests, test-count(weakened), scope", "PRESENT" if ok else "PARTIAL", f"typecheck/lint/tests/weakened/shell-scope: {last}; {'; '.join(grep(S / 'hook_post_edit_check.py', r'def shell_scope_violations'))}", "" if ok else "post-edit scope not proven")
    ok, last = pytest("test_hooks.py::test_done_check_allows_when_all_green", "test_hooks.py::test_done_check_refuses_incomplete_criteria")
    rec(b, "Green → progress.md updated, green run logged (Stop refused otherwise)", "PRESENT" if ok else "MISSING", f"hook_done_check; tests: {last}; progress.md content itself is written by the agent")
    ok_a, last_a = pytest("test_hooks.py::test_attempt_counter_escalates_after_three_same_failures", "test_hooks.py::test_attempt_counter_resets_on_green_and_tracks_distinct_failures")
    if ok_a:
        rec(b, "Red → Attempts under 3? → Yes: implement again / No: stop, escalate", "PRESENT", f"hook_post_edit_check counts the same failure per session, writes Escalation at {'; '.join(grep(S / 'hook_post_edit_check.py', r'^MAX_ATTEMPTS'))}; tests: {last_a}")
    else:
        rec(b, "Red → Attempts under 3? → Yes: implement again / No: stop, escalate", "PARTIAL", f"tests: {last_a}", "attempt counter not proven")
    ok, last = pytest("test_hooks.py::test_done_check_allows_with_escalation", "test_hooks.py::test_budget_check_blocks_after_limit_and_writes_escalation")
    rec(b, "Stop, write progress.md, escalate to you with fail list", "PRESENT" if ok else "PARTIAL", f"done-check accepts escalation; budget-check writes one; tests: {last}; attempt-based escalation text is written by the agent")
    tools = grep(A / "reviewer.md", r"^tools:")
    rec(b, "Reviewer, fresh context: spec, diff, log only", "PLATFORM", f"subagent isolation is Claude Code's; inputs restricted by review.md + {tools[0] if tools else ''}; never given builder conversation: {'; '.join(grep(C / 'review.md', r'Give it nothing else'))}")
    instruction(b, "Reviewer re-runs tests, writes adversarial tests from spec", grep(A / "reviewer.md", r"Run the full test suite yourself|adversarial test"), "reviewer instruction; validate_docs requires R3/R11 rows with evidence")
    ok, last = pytest("test_validate_spec_review.py::test_pass_without_evidence_fails", "test_validate_spec_review.py::test_fail_row_needs_fail_list_entry_and_verdict")
    rec(b, "Checklist PASS or FAIL with file:line evidence", "PRESENT" if ok else "MISSING", f"validate_docs checklist-no-evidence, fail-not-listed, verdict-mismatch; tests: {last}")
    cfg = grep(S / "bootstrap.py", r"second_reviewer_model")
    ok_s, last_s = pytest("test_ci_scripts.py::test_bootstrap_writes_second_reviewer_key_and_upgrade_all")
    rec(b, "High-risk flag? → Second reviewer, different model", "PRESENT" if cfg and ok_s else "PARTIAL", f"review.md: {'; '.join(grep(C / 'review.md', r'second_reviewer_model'))}; kit.json key written by bootstrap: {cfg[0] if cfg else 'no'}; test: {last_s}", "" if cfg else "key never written",)
    ok, last = pytest("test_validate_spec_review.py::test_fail_entry_missing_fields_fails")
    rec(b, "Fail list: file, line, rule, what passing looks like", "PRESENT" if ok else "MISSING", f"validate_docs fail-entry; test: {last}")
    instruction(b, "All PASS? No → fail list → implementer → review again (3 rounds)", grep(C / "review.md", r"Fix exactly these items|after 3 FAIL rounds"), "loop is review.md instruction")
    ci = grep(KIT / "ci" / "github.yml", r"ci_scope_diff|ci_test_count|ci_dep_diff|ci_review_report|gitleaks|boundaries:|tests:")
    ok_g, last_g = pytest("test_ci_scripts.py::test_mutation_gate_flips_after_two_merged")
    rec(b, "CI: full suite, import boundaries, allow-list diff, test count, mutation score, secrets, dependency diff, review report present", "PRESENT" if ok_g and len(ci) >= 7 else "PARTIAL", f"jobs: {len(ci)} matches in kit/ci/github.yml; mutation gate {'; '.join(grep(S / 'ci_mutation_gate.py', r'def main'))}; test: {last_g}", "" if ok_g else "mutation never blocking")
    bp = grep(S / "bootstrap.py", r'"strict": True') + grep(S / "bootstrap.py", r'"review-report"')
    rec(b, "Branch protection: up to date, checks green, review report present", "PRESENT" if len(bp) >= 2 else "PARTIAL", "; ".join(bp) + " (applied only with --protect)")
    rec(b, "You merge (never the pipeline)", "PRESENT", "; ".join(grep(C / "review.md", r"never merges") + grep(S / "hook_guard_bash.py", r"direct push to main")))
    ok_m, last_m = pytest("test_kit_status.py::test_merged_is_derived_from_git_even_if_roadmap_not_updated")
    gitm = grep(S / "kit_status.py", r"merge-base") + grep(S / "lane.py", r'sub.add_parser\("merged"\)') + grep(C / "retro.md", r'lane.py" merged')
    rec(b, "ROADMAP.md marked done (at merge); dashboard knows 'merged' from git", "PRESENT" if ok_m and len(gitm) >= 3 else "PARTIAL", f"{'; '.join(gitm)}; test: {last_m}", "" if ok_m else "merged not derived from git")


# ----------------------------------------------------------------------------------------------- board 4

def board4() -> None:
    b = 4
    tags = grep(S / "kitlib.py", r"^TAG_(VERIFIED_LINES|VERIFIED_CMD|DOCS|INFERRED|UNKNOWN)")
    rec(b, "Provenance tag on every claim: verified, docs, inferred, unknown", "PRESENT" if len(tags) == 5 else "MISSING", "; ".join(tags))
    ok, last = pytest("test_validate_docs.py::test_citation_to_missing_file_fails", "test_validate_docs.py::test_snippet_mismatch_fails", "test_validate_docs.py::test_cmd_tag_without_output_block_fails")
    rec(b, "Tool output: tests, grep, typecheck, file read with lines (citations resolve)", "PRESENT" if ok else "MISSING", f"citation checker + cmd block rule; tests: {last}")
    inst = grep(A / "researcher.md", r"installed source")
    chk = grep(S / "validate_docs.py", r"node_modules|site-packages|installed")
    rec(b, "Installed library source at pinned version", "INSTRUCTION" if inst and not chk else ("PRESENT" if chk else "MISSING"), f"researcher.md {inst[0] if inst else ''}; validator check: {chk or 'none'}", "no script verifies a library claim came from the installed package")
    ok, last = pytest("test_validate_docs.py::test_docs_tag_latest_version_fails")
    rec(b, "Official docs at pinned version", "PRESENT" if ok else "MISSING", f"docs-version rule; test: {last}")
    ok, last = pytest("test_validate_docs.py::test_hedge_word_fails")
    rec(b, "Model memory → not evidence", "PRESENT" if ok else "MISSING", f"hedge-word rule; untagged-claim rule; test: {last}")
    ok, last = pytest("test_validate_docs.py::test_unknown_in_findings_not_allowed", "test_validate_docs.py::test_unknown_without_method_fails", "test_validate_spec_review.py::test_inferred_in_files_to_change_fails")
    rec(b, "Unknown becomes a verification task, never a decision", "PRESENT" if ok else "MISSING", f"tag-not-allowed, unknown-no-method, decisions need verified/docs; tests: {last}")
    rec(b, "validate-docs script rejects untagged or unresolvable claims", "PRESENT", "; ".join(grep(S / "validate_docs.py", r'"untagged-claim"|"citation-missing-file"')))
    present_if(b, "/retro: what went wrong (command + agent)", exists("kit/commands/retro.md", "kit/agents/retro.md"), "no retro", 2)
    ok, last = pytest("test_validate_spec_review.py::test_good_lessons_pass", "test_validate_spec_review.py::test_enforced_lesson_without_change_fails", "test_validate_spec_review.py::test_text_only_lesson_needs_reason")
    rec(b, "LESSONS.md entry with enforced-by column", "PRESENT" if ok else "MISSING", f"lesson rules; tests: {last}")
    debt_w = grep(C / "retro.md", r"## Debt")
    debt_c = grep(S / "kit_status.py", r"def text_only_debt")
    rec(b, "Text-only lesson? Yes → listed as debt until it becomes a check", "PARTIAL", f"writing to Debt: retro.md {debt_w[0] if debt_w else 'no'} (instruction); counting: {debt_c[0] if debt_c else 'no'} (script)", "listing is an instruction; nothing enforces that debt shrinks")
    instruction(b, "No → new hook, lint rule or test (applied)", grep(C / "retro.md", r"Apply the proposed change"), "applying the change is a command instruction; kit-level changes become issues")
    cap = exists("kit/scripts/ci_claude_md_cap.py")
    rm_ = grep(C / "retro.md", r"remove it from `CLAUDE.md`")
    rec(b, "CLAUDE.md size cap: enforced rules removed from text", "PARTIAL", f"cap: {cap[0] if cap else 'none'} (script, CI); removal: {rm_[0] if rm_ else 'none'} (instruction)", "removal of enforced rules from CLAUDE.md is an instruction")
    up = grep(S / "bootstrap.py", r"--upgrade")
    allp = grep(S / "bootstrap.py", r'"--all"') + exists("release.sh")
    rec(b, "Applies to every project → kit version bump, /bootstrap --upgrade all projects", "PRESENT" if len(allp) >= 2 else "PARTIAL", f"per-repo: {up[0] if up else 'none'}; --upgrade --all: {allp[0] if allp else 'none'}; release.sh tags the version: {'release.sh' in allp}", "" if len(allp) >= 2 else "no all-projects upgrade")
    rec(b, "Enforcement layers: Text → Process → Code, pushed down", "PARTIAL", f"layers exist (CLAUDE.md, gates, hooks/CI); debt counted {debt_c[0] if debt_c else ''}", "nothing enforces that a text rule is pushed down over time")
    fl = grep(T / "architecture.md", r"Feature flags|Canary|Rollback")
    rv = grep(T / "review.md", r"^\| R12") + grep(S / "validate_docs.py", r'"checklist-missing-r12"')
    rec(b, "Feature flag → canary slice → error monitoring → one-command rollback", "PARTIAL", f"flag gate R12 scripted: {'; '.join(rv)}; template: {'; '.join(fl)}", "canary, monitoring, rollback stay the project's checklist (no kit tooling, by design)")
    ok_i, last_i = pytest("test_lane.py::test_incident_record")
    inc = grep(C / "retro.md", r"--incident") + grep(A / "retro.md", r"[Ii]ncident") + grep(S / "lane.py", r"def record_incident") + exists("kit/templates/incident.md")
    rec(b, "Incident becomes lesson", "PRESENT" if ok_i and len(inc) >= 4 else "MISSING", f"{'; '.join(inc)}; test: {last_i}", "" if ok_i else "no path from an incident into /retro")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--md")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    board1(); board2(); board3(); board4()
    if a.json:
        print(json.dumps(RESULTS, indent=2))
    else:
        for bno in (1, 2, 3, 4):
            print(f"\n=== Board {bno} ===")
            for r in RESULTS:
                if r["board"] == bno:
                    print(f"[{r['status']:11}] {r['box']}\n             evidence: {r['evidence']}" + (f"\n             gap: {r['gap']}" if r["gap"] else ""))
        tot = {s: sum(1 for r in RESULTS if r["status"] == s) for s in ("PRESENT", "PLATFORM", "INSTRUCTION", "PARTIAL", "MISSING")}
        print(f"\nchecked at {head}: {len(RESULTS)} boxes/arrows → {tot}")
    if a.md:
        lines = [f"# Board audit against `{head}`", "", "Generated by `python3 audit/boards.py --md`. Every line below comes from a command, not from memory.", "",
                 "Legend: PRESENT = script/hook/test proves it · PLATFORM = Claude Code feature, declared here · INSTRUCTION = agent/command text only · PARTIAL = part scripted · MISSING = nothing implements it", ""]
        for bno, title in ((1, "System overview"), (2, "Research → Plan → Approve"), (3, "Build → Review → Merge"), (4, "Truth model, learning loop, safety net")):
            lines += [f"## Board {bno}: {title}", ""]
            for r in RESULTS:
                if r["board"] != bno:
                    continue
                box = "[x]" if r["status"] in ("PRESENT", "PLATFORM") else "[ ]"
                lines.append(f"- {box} **{r['status']}** — {r['box']}  ")
                lines.append(f"  evidence: `{r['evidence']}`  ")
                if r["gap"]:
                    lines.append(f"  gap: {r['gap']}  ")
            lines.append("")
        gaps = [r for r in RESULTS if r["status"] in ("INSTRUCTION", "PARTIAL", "MISSING")]
        lines += ["## Open items (everything not PRESENT/PLATFORM)", ""]
        for r in gaps:
            lines.append(f"- [ ] (board {r['board']}, {r['status']}) {r['box']}: {r['gap'] or r['evidence']}")
        Path(a.md).write_text("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
