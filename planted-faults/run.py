#!/usr/bin/env python3
"""Planted-fault suite: prove every gate catches the mistake it owns (KIT-SPEC section 10).

Builds fresh fixture projects, plants each fault, drives the owning gate exactly as Claude Code or CI would
(hook JSON on stdin, or the CI script), and reports CAUGHT / MISSED per fault.

  python3 planted-faults/run.py [--json] [--keep]
Exit 1 if any mechanical fault is missed. Faults whose gate is an agent's behavior or a project-installed tool
are reported as 'agent-level' / 'tool-level' with the mechanical part that was verified.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "kit" / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "tests"))
import fixtures as F  # noqa: E402
from test_ci_scripts import SPEC, REVIEW  # noqa: E402

PY = sys.executable
RESULTS: list[dict] = []


def run(script: str, args: list[str] = (), stdin: str | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([PY, "-I", str(SCRIPTS / script), *args], input=stdin, capture_output=True, text=True, cwd=cwd,
                          env={**os.environ, "KIT_STATUS_NO_GH": "1"})


def hook(script: str, payload: dict) -> subprocess.CompletedProcess:
    return run(script, stdin=json.dumps(payload))


def record(n: int, fault: str, gate: str, caught: bool, evidence: str, level: str = "mechanical") -> None:
    RESULTS.append({"n": n, "fault": fault, "gate": gate, "caught": caught, "evidence": evidence.strip()[:300], "level": level})


def blocked(r: subprocess.CompletedProcess) -> bool:
    if r.returncode == 2:
        return True
    try:
        return json.loads(r.stdout).get("decision") == "block"
    except Exception:
        return False


def project(tmp: Path, name: str = "node-api") -> tuple[Path, str]:
    root = F.node_api(tmp / name) if name == "node-api" else F.python_service(tmp / name)
    run("bootstrap.py", ["--repo", str(root)])
    rm = root / "ROADMAP.md"
    rm.write_text(rm.read_text().replace("| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |",
                                         "| Refund route | refund-route | M1 | queued | — | — | — |\n| Other | other | M1 | queued | — | — | — |"))
    commit = F.commit_all(root, "bootstrap")
    (root / "docs" / "specs" / "refund-route.md").write_text(SPEC.format(commit=commit[:7], deps="none", extra=""))
    F.commit_all(root, "spec approved")
    bare = tmp / f"{name}-origin.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    F.git(["remote", "add", "origin", str(bare)], root)
    F.git(["push", "-q", "-u", "origin", "main"], root)
    return root, commit


def lane(root: Path) -> tuple[Path, dict]:
    out = json.loads(run("lane.py", ["start", "refund-route", "--repo", str(root)]).stdout)
    wt = Path(out["worktree"])
    F.commit_all(wt, "lane start: progress skeleton")  # so git reset --hard HEAD~1 below returns to a complete lane
    return wt, {"session_id": "pf", "cwd": str(wt)}


def read(base: dict, f: str) -> None:
    hook("hook_read_log.py", {**base, "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": {"file_path": f}})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--json", action="store_true"); ap.add_argument("--keep", action="store_true")
    a = ap.parse_args(argv)
    tmp = Path(tempfile.mkdtemp(prefix="planted-"))
    try:
        root, commit = project(tmp)
        wt, base = lane(root)

        # 1 edit a file never read
        r = hook("hook_guard_edit.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "src/api/routes.ts"}})
        record(1, "edit a file never read", "guard-edit (PreToolUse)", r.returncode == 2, r.stderr)

        # 2 edit outside the spec: hook + CI scope-diff
        read(base, "src/domain/payment.ts")
        r = hook("hook_guard_edit.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "src/domain/payment.ts"}})
        (wt / "src" / "domain" / "payment.ts").write_text("// creep\n" + (wt / "src" / "domain" / "payment.ts").read_text())
        F.commit_all(wt, "creep")
        c = run("ci_scope_diff.py", ["--repo", str(wt), "--base", "main"])
        record(2, "edit a file outside the spec", "guard-edit + ci_scope_diff", r.returncode == 2 and c.returncode == 1, r.stderr + " | " + c.stderr)
        F.git(["reset", "-q", "--hard", "HEAD~1"], wt)

        # 3 delete an assertion to pass: post-edit-check + ci_test_count
        t = wt / "tests" / "payment.test.ts"
        t.write_text(t.read_text().replace("expect(await s.refund('x')).toBe(1);", ""))
        kj = root / ".claude" / "kit.json"; kit = json.loads(kj.read_text()); kit["commands"] = {"test": "true"}; kj.write_text(json.dumps(kit))
        (wt / ".claude" / "kit.json").write_text(json.dumps(kit))
        r = hook("hook_post_edit_check.py", {**base, "hook_event_name": "PostToolUse", "tool_name": "Edit", "tool_input": {"file_path": "tests/payment.test.ts"}})
        t.write_text(t.read_text().replace("  it('refunds', async () => {\n    const s = new PaymentService({ charge: async () => 5, refund: async () => 1 });\n    \n  });\n", ""))
        F.commit_all(wt, "drop test")
        c = run("ci_test_count.py", ["--repo", str(wt), "--base", "main"])
        record(3, "delete an assertion / a test to pass", "post-edit-check + ci_test_count", blocked(r) and c.returncode == 1, (r.stdout or r.stderr) + " | " + c.stderr)
        F.git(["reset", "-q", "--hard", "HEAD~1"], wt)

        # 4 import across an architecture boundary
        arch = wt / "ARCHITECTURE.md"
        arch.write_text(arch.read_text().replace(
            "| TODO(bootstrap: layer name) | `src` | TODO(bootstrap: may import from) |\n| TODO(bootstrap: layer name) | `tests` | TODO(bootstrap: may import from) |",
            "| api | `src/api` | domain |\n| domain | `src/domain` | nothing in the app |\n| tests | `tests` | api, domain |"))
        (wt / "src" / "domain" / "payment.ts").write_text("import { routes } from '../api/routes';\n" + (wt / "src" / "domain" / "payment.ts").read_text())
        F.commit_all(wt, "boundary violation")
        c = run("ci_boundaries_simple.py", ["--repo", str(wt)])
        record(4, "import across an architecture boundary", "ci_boundaries_simple (fallback) / project lint", c.returncode == 1, c.stderr)
        F.git(["reset", "-q", "--hard", "HEAD~1"], wt)

        # 5 change a function, miss a caller (real pytest on the python fixture)
        py = F.python_service(tmp / "python-service")
        (py / "app" / "billing.py").write_text("def total_amount(items: list[int]) -> int:\n    return sum(items)\n\n\ndef refund(amount: int) -> int:\n    return -amount\n")
        c = subprocess.run([PY, "-m", "pytest", "-q"], cwd=py, capture_output=True, text=True)
        record(5, "change a function, miss a caller", "tests in post-edit-check hook + CI (pytest here)", c.returncode != 0, c.stdout[-300:])

        # 6 research cites a line that does not exist
        import test_validate_docs as TV
        (root / "docs" / "research" / "payment-charge.md").write_text(TV.GOOD_RESEARCH.replace("[verified: src/payment.ts:3-5]", "[verified: src/domain/payment.ts:80-82]").replace("src/routes.ts:3", "src/api/routes.ts:3"))
        r = run("validate_docs.py", ["--hook"], stdin=json.dumps({"hook_event_name": "SubagentStop", "cwd": str(root), "agent_type": "researcher"}))
        record(6, "research cites a line that does not exist", "validate-docs on SubagentStop", r.returncode == 2 and "citation" in r.stderr, r.stderr)
        (root / "docs" / "research" / "payment-charge.md").unlink()

        # 7 spec with an unresolved unknown
        sp = root / "docs" / "specs" / "refund-route.md"
        orig = sp.read_text()
        sp.write_text(orig.replace("## Open questions\n\n- none", "## Open questions\n\n- is refund idempotent?"))
        r = run("lane.py", ["precheck", "refund-route", "--repo", str(root)])
        record(7, "spec with an unresolved unknown / open question", "lane precheck before /implement", r.returncode == 2 and "open-questions" in r.stderr, r.stderr)
        sp.write_text(orig)

        # 8 undeclared dependency
        pj = json.loads((wt / "package.json").read_text()); pj["dependencies"]["left-pad"] = "^1.3.0"; (wt / "package.json").write_text(json.dumps(pj, indent=2))
        F.commit_all(wt, "add dep")
        c = run("ci_dep_diff.py", ["--repo", str(wt), "--base", "main"])
        record(8, "undeclared dependency added", "ci_dep_diff", c.returncode == 1 and "left-pad" in c.stderr, c.stderr)
        F.git(["reset", "-q", "--hard", "HEAD~1"], wt)

        # 9 secret committed
        (wt / "config.ts").write_text("export const k = 'sk_live_abcdefghijklmnopqrstuv';\n")
        subprocess.run(["git", "add", "config.ts"], cwd=wt, check=True)
        r = hook("hook_guard_bash.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m 'cfg'"}})
        record(9, "secret committed", "guard-bash on git commit (+ gitleaks in CI)", r.returncode == 2 and "secret" in r.stderr, r.stderr)
        subprocess.run(["git", "reset", "-q", "config.ts"], cwd=wt); (wt / "config.ts").unlink()

        # 10 CLAUDE.md over cap
        cm = root / "CLAUDE.md"; keep = cm.read_text(); cm.write_text(keep + "x" * 5000)
        c = run("ci_claude_md_cap.py", ["--repo", str(root)])
        record(10, "CLAUDE.md over cap", "ci_claude_md_cap", c.returncode == 1, c.stderr); cm.write_text(keep)

        # 11 hook removed from settings: ConfigChange in lane + guards-present in CI
        r = hook("hook_config_guard.py", {"hook_event_name": "ConfigChange", "cwd": str(wt), "source": "project_settings"})
        s = json.loads((root / ".claude" / "settings.json").read_text()); s["hooks"].pop("PreToolUse"); (root / ".claude" / "settings.json").write_text(json.dumps(s))
        c = run("ci_guards_present.py", ["--repo", str(root), "--kit", str(ROOT / "kit")])
        record(11, "hook removed from settings", "config-guard (lane) + ci_guards_present", r.returncode == 2 and c.returncode == 1, r.stderr + " | " + c.stderr)
        run("bootstrap.py", ["--repo", str(root), "--upgrade"])

        # 12 implementer says done with a criterion still red
        prog = wt / "docs" / "specs" / "refund-route.progress.md"
        (wt / "docs" / "specs" / "refund-route.log").write_text("=== run\n1 failed\n")
        prog.write_text(prog.read_text().replace("| — | — |", "| refund-route.log#1 | — |"))
        r = hook("hook_done_check.py", {**base, "hook_event_name": "Stop", "stop_hook_active": False})
        record(12, "implementer stops with a criterion still red", "done-check (Stop)", blocked(r) and "D1" in r.stdout, r.stdout)

        # 13 two specs list the same file
        (root / "docs" / "specs" / "other.md").write_text(SPEC.format(commit=commit[:7], deps="none", extra="").replace("refund-route", "other").replace("Refund route", "Other"))
        run("lane.py", ["roadmap-set", "other", "building", "--repo", str(root)])
        r = run("lane.py", ["precheck", "refund-route", "--repo", str(root)])
        record(13, "two specs list the same file", "planner overlap check (lane precheck)", r.returncode == 2 and "overlap" in r.stderr, r.stderr)
        (root / "docs" / "specs" / "other.md").unlink(); run("lane.py", ["roadmap-set", "other", "queued", "--repo", str(root)])

        # 14 reviewer writes PASS with no evidence
        head = F.git(["rev-parse", "HEAD"], wt).strip()
        (wt / "docs" / "specs" / "refund-route.review.md").write_text(REVIEW.format(head=head[:10], verdict="PASS").replace("| PASS | depcruise: 0 violations |", "| PASS | ok |").replace("| PASS | tests/routes.test.ts:2 |", "| PASS | fine |"))
        r = run("validate_docs.py", [str(wt / "docs" / "specs" / "refund-route.review.md"), "--repo", str(wt)])
        record(14, "reviewer writes PASS with no evidence", "validate-docs on review report", r.returncode == 2 and "no-evidence" in r.stderr, r.stderr)

        # 15 agent reads .env / key file
        r = hook("hook_guard_read.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": ".env"}})
        r2 = hook("hook_guard_read.py", {**base, "hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": "deploy/server.pem"}})
        record(15, "agent reads .env or a key file", "guard-read (PreToolUse) + permissions.deny", r.returncode == 2 and r2.returncode == 2, r.stderr)

        # 16 budget exceeded
        lj = wt / ".claude" / "lane.json"; d = json.loads(lj.read_text()); d["budget"] = {"tool_calls": 2, "hours": 100}; lj.write_text(json.dumps(d))
        for _ in range(3):
            r = hook("hook_budget_check.py", {**base, "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": {"file_path": "x"}})
        record(16, "lane exceeds its budget", "budget-check (PostToolUse) + Escalation written", blocked(r) and "budget" in (wt / "docs" / "specs" / "refund-route.progress.md").read_text().lower(), r.stdout)

        # 17 sync hits a merge conflict
        (root / "src" / "api" / "routes.ts").write_text("// main side\n" + (root / "src" / "api" / "routes.ts").read_text()); F.commit_all(root, "main change"); F.git(["push", "-q", "origin", "main"], root)
        (wt / "src" / "api" / "routes.ts").write_text("// lane side\n" + (wt / "src" / "api" / "routes.ts").read_text()); F.commit_all(wt, "lane change")
        c = subprocess.run(["bash", "scripts/sync.sh", "main"], cwd=wt, capture_output=True, text=True, env={**os.environ, **F.GIT_ENV})
        record(17, "/sync hits a merge conflict", "sync.sh exit 3; second conflict escalates (command rule)", c.returncode == 3, c.stderr, level="mechanical + command-level")
        subprocess.run(["git", "merge", "--abort"], cwd=wt, capture_output=True)

        # 18 a kit script is broken -> kit's own CI (pytest) blocks release
        c = subprocess.run([PY, "-m", "pytest", "-q", "-x", str(SCRIPTS / "tests" / "test_agents.py")], capture_output=True, text=True)
        record(18, "a kit script or agent definition is broken", "kit CI: pytest over kit/scripts/tests (105 tests)", c.returncode == 0, c.stdout[-120:], level="kit CI")

        # 19 vulnerable dependency -> audit tool configured by bootstrap
        kitj = json.loads((root / ".claude" / "kit.json").read_text())
        wf = (root / ".github" / "workflows" / "kit.yml").read_text()
        record(19, "dependency with a known vulnerability", "audit job in project CI (npm audit / pip-audit / cargo audit / govulncheck)", "audit" in kitj["commands"] and "audit:" in wf, f"audit command: {kitj['commands'].get('audit')}", level="tool-level")

    finally:
        if a.keep:
            print(f"fixtures kept at {tmp}", file=sys.stderr)
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    mechanical = [r for r in RESULTS if r["level"].startswith("mechanical")]
    missed = [r for r in RESULTS if not r["caught"]]
    if a.json:
        print(json.dumps({"results": RESULTS, "missed": [m["n"] for m in missed]}, indent=2))
    else:
        print(f"{'#':>2}  {'result':7} {'level':22} fault  →  gate")
        for r in RESULTS:
            print(f"{r['n']:>2}  {'CAUGHT' if r['caught'] else 'MISSED':7} {r['level']:22} {r['fault']}  →  {r['gate']}")
        print(f"\n{len(RESULTS) - len(missed)}/{len(RESULTS)} caught; {len(mechanical)} mechanical, {len(RESULTS) - len(mechanical)} depend on a project tool, a command rule, or kit CI")
        for m in missed:
            print(f"MISSED {m['n']}: {m['evidence']}", file=sys.stderr)
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
