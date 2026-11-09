import json
import os
from pathlib import Path

import fixtures as F
from conftest import run_script
from test_lane import project
from test_ci_scripts import REVIEW

ENV = {**os.environ, "KIT_STATUS_NO_GH": "1"}


def status(root: Path) -> dict:
    import subprocess, sys
    from conftest import SCRIPTS
    r = subprocess.run([sys.executable, "-I", str(SCRIPTS / "kit_status.py"), "--repo", str(root), "--json"], capture_output=True, text=True, env=ENV)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def lane_of(s: dict, slug: str) -> dict:
    return next(l for l in s["lanes"] if l["slug"] == slug)


def test_positions_follow_files_not_claims(tmp_path):
    root, commit = project(tmp_path, status="waiting-approval", approved=False)
    s = status(root)
    l = lane_of(s, "refund-route")
    assert l["position"] == "waiting-approval" and l["needs_you"] is True
    assert lane_of(s, "other")["position"] == "queued"
    assert s["needs_you"][0]["slug"] == "refund-route"

    # approve: still no worktree -> approved
    sp = root / "docs" / "specs" / "refund-route.md"
    sp.write_text(sp.read_text().replace("- Status: waiting-approval", "- Status: approved").replace("Approved by: — on — at —", f"Approved by: Jonathan Robles on 2026-11-08 at {commit[:7]}"))
    F.commit_all(root, "approve")
    assert lane_of(status(root), "refund-route")["position"] == "approved"

    # start lane -> building, derived from the worktree + lane.json
    out = json.loads(run_script("lane.py", ["start", "refund-route", "--repo", str(root)]).stdout)
    wt = Path(out["worktree"])
    s = status(root)
    l = lane_of(s, "refund-route")
    assert l["position"] == "building" and l["worktree"] == str(wt) and l["behind_base"] == 0 and l["progress"]["criteria"] == 1
    assert s["wip"]["in_flight"] == 1

    # events + a red test run show up without any agent writing a summary
    (wt / "docs/specs/refund-route.events.jsonl").write_text(
        '{"ts":"2026-11-08T16:00:00","event":"blocked","tool":"Edit","path":"src/x.ts","result":"blocked"}\n'
        '{"ts":"2026-11-08T16:00:05","event":"test","result":"fail","summary":"1 failed, 2 passed","ref":"refund-route.log#1"}\n')
    l = lane_of(status(root), "refund-route")
    assert l["events"]["blocked"] == 1 and l["last_check"]["result"] == "fail" and "1 failed" in l["last_check"]["summary"]

    # escalation in progress.md -> escalated, needs you
    prog = wt / "docs/specs/refund-route.progress.md"
    prog.write_text(prog.read_text().replace("- Attempts: {{n}} of 3", "- Attempts: 3 of 3").replace("- Failure: {{what fails}}", "- Failure: routes.test.ts keeps failing: mock never called"))
    s = status(root)
    l = lane_of(s, "refund-route")
    assert l["position"] == "escalated" and l["needs_you"] and "mock never called" in s["needs_you"][0]["failure"]

    # clear escalation, add a passing review for the lane HEAD -> ready-to-merge
    prog.write_text(prog.read_text().replace("- Attempts: 3 of 3", "- Attempts: {{n}} of 3").replace("- Failure: routes.test.ts keeps failing: mock never called", "- Failure: {{what fails}}"))
    head = F.git(["rev-parse", "HEAD"], wt).strip()
    (wt / "docs/specs/refund-route.review.md").write_text(REVIEW.format(head=head[:10], verdict="PASS"))
    l = lane_of(status(root), "refund-route")
    assert l["position"] == "ready-to-merge" and l["review"]["valid"] and l["review"]["head_matches"]

    # a commit after the review drops it back to in-review
    (wt / "src" / "api" / "routes.ts").write_text("// late change\n")
    F.commit_all(wt, "late")
    l = lane_of(status(root), "refund-route")
    assert l["position"] == "in-review" and l["review"]["head_matches"] is False and l["ahead_base"] == 1

    # merged in ROADMAP wins
    run_script("lane.py", ["finish", "refund-route", "--repo", str(root)])
    assert lane_of(status(root), "refund-route")["position"] == "merged"


def test_debt_and_research_summary(tmp_path):
    root, commit = project(tmp_path)
    (root / "LESSONS.md").write_text("# Lessons\n\n## Debt\n\n- webhook handlers must be idempotent (text-only)\n- never log card numbers (text-only)\n")
    run_script("lane.py", ["index", "add", "q1", "--repo", str(root), "--slug", "q1", "--keywords", "a b", "--files", "src/domain/payment.ts", "--commit", commit[:7]])
    (root / "src" / "domain" / "payment.ts").write_text("//\n"); F.commit_all(root, "chg")
    s = status(root)
    assert s["debt"]["text_only_lessons"] == 2 and s["debt"]["bootstrap_todos"] > 0
    assert s["research"] == {"questions": 1, "current": 1, "stale": 1}


def test_render_text(tmp_path):
    root, _ = project(tmp_path)
    import subprocess, sys
    from conftest import SCRIPTS
    r = subprocess.run([sys.executable, "-I", str(SCRIPTS / "kit_status.py"), "--repo", str(root)], capture_output=True, text=True, env=ENV)
    assert r.returncode == 0 and "needs you:" in r.stdout and "queued: refund-route, other" not in r.stdout  # refund-route is approved, not queued
    assert "refund-route: approved" in r.stdout


def test_merged_is_derived_from_git_even_if_roadmap_not_updated(tmp_path):
    root, _ = project(tmp_path)
    out = json.loads(run_script("lane.py", ["start", "refund-route", "--repo", str(root)]).stdout)
    wt = Path(out["worktree"])
    (wt / "src" / "api" / "routes.ts").write_text("// done\n")
    F.commit_all(wt, "work")
    # lane.py merged refuses before the merge
    r = run_script("lane.py", ["merged", "refund-route", "--repo", str(root)])
    assert r.returncode == 2 and "not merged" in r.stderr
    # merge into main without touching ROADMAP or running retro
    F.git(["merge", "-q", "--no-ff", "wt/refund-route", "-m", "merge"], root)
    s = status(root)
    assert lane_of(s, "refund-route")["position"] == "merged"
    assert "| refund-route | M1 | building |" in (root / "ROADMAP.md").read_text()  # roadmap still stale: git wins
    r = run_script("lane.py", ["merged", "refund-route", "--repo", str(root), "--pr", "https://x/pr/1"])
    assert r.returncode == 0
    assert "| refund-route | M1 | merged | — | — | https://x/pr/1 |" in (root / "ROADMAP.md").read_text()
