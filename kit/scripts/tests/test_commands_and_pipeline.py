"""Structural checks on the command files, plus a mechanical end-to-end run of the pipeline scripts on the Node fixture:
bootstrap -> research index -> spec -> approve -> lane start -> hooks during build -> done-check -> review report -> CI checks -> finish.
Agents are not run here (they need Claude Code); every script they call is."""
import json
import re
import subprocess
import sys
from pathlib import Path

import fixtures as F
from conftest import SCRIPTS, run_script
from test_ci_scripts import SPEC, REVIEW

KIT = SCRIPTS.parent
COMMANDS = sorted((KIT / "commands").glob("*.md"))
EXPECTED = {"bootstrap", "research", "plan", "implement", "review", "sync", "retro", "status", "dashboard"}


def test_all_commands_exist_with_frontmatter():
    assert {p.stem for p in COMMANDS} == EXPECTED
    for p in COMMANDS:
        text = p.read_text()
        m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
        assert m, p
        assert re.search(r"^description:\s*\S", m.group(1), re.M), p
        assert re.search(r"^allowed-tools:\s*\S", m.group(1), re.M), p


def test_commands_reference_real_scripts_and_subcommands():
    lane_subs = {"precheck", "start", "stage", "wip", "unknowns", "roadmap-set", "index", "finish"}
    for p in COMMANDS:
        text = p.read_text()
        for m in re.finditer(r'kit/scripts/([a-z_]+\.py)', text):
            assert (SCRIPTS / m.group(1)).is_file(), (p.name, m.group(1))
        for m in re.finditer(r'lane\.py"? (\w[\w-]*)', text):
            assert m.group(1) in lane_subs, (p.name, m.group(1))


def test_commands_never_merge_or_approve_for_the_human():
    for p in COMMANDS:
        text = p.read_text().lower()
        assert "gh pr merge" not in text, p.name
    assert "nothing is built before that" in (KIT / "commands" / "plan.md").read_text().lower()
    assert "this command never merges" in (KIT / "commands" / "review.md").read_text().lower()


def hook(name: str, payload: dict):
    return run_script(name, [], stdin=json.dumps(payload))


def test_pipeline_mechanics_end_to_end(tmp_path):
    # --- bootstrap + roadmap
    root = F.node_api(tmp_path / "node-api")
    run_script("bootstrap.py", ["--repo", str(root)])
    rm = root / "ROADMAP.md"
    rm.write_text(rm.read_text().replace("| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |", "| Refund route | refund-route | M1 | queued | — | — | — |"))
    # the fixture has no node_modules; give the lane a fake test command that reads a marker file so we can flip red/green
    kj = root / ".claude" / "kit.json"; kit = json.loads(kj.read_text())
    kit["commands"] = {"test": f"sh -c 'if [ -f {root}/.green ]; then echo \"3 passed\"; else echo \"1 failed, 2 passed\"; exit 1; fi'"}
    kj.write_text(json.dumps(kit))
    commit = F.commit_all(root, "bootstrap")

    # --- research registered in the index
    r = run_script("lane.py", ["index", "add", "How does routes() expose the service?", "--repo", str(root), "--slug", "routes-shape", "--keywords", "routes service export", "--files", "src/api/routes.ts", "--commit", commit[:7]])
    assert r.returncode == 0
    assert json.loads(run_script("lane.py", ["index", "lookup", "how does routes expose the service", "--repo", str(root), "--json"]).stdout)["decision"] == "reuse"

    # --- spec waiting approval: implement must refuse
    spec = root / "docs" / "specs" / "refund-route.md"
    spec.write_text(SPEC.format(commit=commit[:7], deps="none", extra="").replace("- Status: approved", "- Status: waiting-approval").replace(f"Approved by: Jonathan Robles on 2026-11-08 at {commit[:7]}", "Approved by: — on — at —"))
    assert run_script("validate_docs.py", [str(spec), "--repo", str(root)]).returncode == 0
    run_script("lane.py", ["roadmap-set", "refund-route", "waiting-approval", "--repo", str(root)])
    F.commit_all(root, "spec")
    assert run_script("lane.py", ["start", "refund-route", "--repo", str(root)]).returncode == 2

    # --- human approves
    spec.write_text(SPEC.format(commit=commit[:7], deps="none", extra=""))
    F.commit_all(root, "approve")
    out = json.loads(run_script("lane.py", ["start", "refund-route", "--repo", str(root)]).stdout)
    wt = Path(out["worktree"]); sid = "lane-session"
    base = {"session_id": sid, "cwd": str(wt)}

    # --- implementer behaviour under hooks
    # edit before reading: blocked
    r = hook("hook_guard_edit.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "src/api/routes.ts"}})
    assert r.returncode == 2
    # read spec files, then a file outside the spec: blocked
    for f in ("docs/specs/refund-route.md", "src/domain/payment.ts", "src/api/routes.ts"):
        hook("hook_read_log.py", {**base, "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": {"file_path": f}})
    r = hook("hook_guard_edit.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "src/domain/payment.ts"}})
    assert r.returncode == 2 and "not in the spec" in r.stderr
    # secret read: blocked
    assert hook("hook_guard_read.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": ".env"}}).returncode == 2
    # allowed edit: write the test (Files to create) and the route (Files to change, read above)
    assert hook("hook_guard_edit.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": "tests/routes.test.ts"}}).returncode == 0
    (wt / "tests" / "routes.test.ts").write_text("import { it, expect } from 'vitest';\nit('exposes refund', () => { expect(1).toBe(1); });\n")
    # post-edit check: red (marker absent) -> block decision + log + event
    r = hook("hook_post_edit_check.py", {**base, "hook_event_name": "PostToolUse", "tool_name": "Write", "tool_input": {"file_path": "tests/routes.test.ts"}})
    assert json.loads(r.stdout)["decision"] == "block"
    log = wt / "docs/specs/refund-route.log"; events = wt / "docs/specs/refund-route.events.jsonl"
    assert "1 failed, 2 passed" in log.read_text()
    red_line = next(i for i, l in enumerate(log.read_text().splitlines(), 1) if l.startswith("=== "))
    # stop now: refused (no green run)
    prog = wt / "docs/specs/refund-route.progress.md"
    prog.write_text(prog.read_text().replace("| D1 | routes exposes refund | `tests/routes.test.ts::exposes refund` | — | — |", f"| D1 | routes exposes refund | `tests/routes.test.ts::exposes refund` | refund-route.log#{red_line} | — |"))
    r = hook("hook_done_check.py", {**base, "hook_event_name": "Stop", "stop_hook_active": False})
    assert json.loads(r.stdout)["decision"] == "block" and "D1" in json.loads(r.stdout)["reason"]
    # implement, go green
    assert hook("hook_guard_edit.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "src/api/routes.ts"}}).returncode == 0
    (wt / "src" / "api" / "routes.ts").write_text("import { PaymentService } from '../domain/payment';\nexport function routes(s: PaymentService) {\n  return { charge: (u: string) => s.charge(u), refund: (i: string) => s.refund(i) };\n}\n")
    (root / ".green").write_text("1")
    r = hook("hook_post_edit_check.py", {**base, "hook_event_name": "PostToolUse", "tool_name": "Edit", "tool_input": {"file_path": "src/api/routes.ts"}})
    assert r.stdout.strip() == ""
    green_line = [i for i, l in enumerate(log.read_text().splitlines(), 1) if l.startswith("=== ")][-1]
    prog.write_text(prog.read_text().replace(f"| refund-route.log#{red_line} | — |", f"| refund-route.log#{red_line} | refund-route.log#{green_line} |"))
    # commit inside the lane (guard-bash allows a normal commit)
    assert hook("hook_guard_bash.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git add -A && git commit -m 'refund-route: D1'"}}).returncode == 0
    F.commit_all(wt, "refund-route: D1 routes exposes refund")
    # stop: accepted
    r = hook("hook_done_check.py", {**base, "hook_event_name": "Stop", "stop_hook_active": False})
    assert r.returncode == 0 and r.stdout.strip() == ""
    kinds = [json.loads(l)["event"] for l in events.read_text().splitlines()]
    assert "blocked" in kinds and "test" in kinds and "stop_refused" in kinds and kinds[-1] == "stop"

    # --- CI checks on the lane branch (scope, test count, deps, docs)
    for script in ("ci_scope_diff.py", "ci_test_count.py", "ci_dep_diff.py", "ci_changed_docs.py"):
        r = run_script(script, ["--repo", str(wt), "--base", "main"])
        assert r.returncode == 0, (script, r.stderr)
    # review report missing -> CI fails; status says in-review? no: building (no report yet)
    assert run_script("ci_review_report.py", ["--repo", str(wt)]).returncode == 1
    head = F.git(["rev-parse", "HEAD"], wt).strip()
    (wt / "docs/specs/refund-route.review.md").write_text(REVIEW.format(head=head[:10], verdict="PASS"))
    assert run_script("validate_docs.py", [str(wt / "docs/specs/refund-route.review.md"), "--repo", str(wt)]).returncode == 0
    F.commit_all(wt, "review: PASS")
    assert run_script("ci_review_report.py", ["--repo", str(wt)]).returncode == 0
    st = json.loads(subprocess.run([sys.executable, "-I", str(SCRIPTS / "kit_status.py"), "--repo", str(root), "--json"], capture_output=True, text=True, env={"KIT_STATUS_NO_GH": "1", "PATH": "/usr/bin:/bin:/usr/local/bin"}).stdout)
    lane = next(l for l in st["lanes"] if l["slug"] == "refund-route")
    assert lane["position"] == "ready-to-merge" and lane["progress"]["green"] == 1 and lane["events"]["blocked"] >= 2

    # --- merge (fast-forward main to the lane) and finish
    F.git(["merge", "-q", "--no-ff", "wt/refund-route", "-m", "merge refund-route"], root)
    assert run_script("lane.py", ["finish", "refund-route", "--repo", str(root)]).returncode == 0
    assert not wt.exists() and "| refund-route | M1 | merged |" in (root / "ROADMAP.md").read_text()
