import json
from pathlib import Path

import fixtures as F
from conftest import run_script
from test_ci_scripts import SPEC


def project(tmp_path: Path, status="approved", approved=True, wip_limit=2) -> tuple[Path, str]:
    root = F.node_api(tmp_path / "node-api")
    run_script("bootstrap.py", ["--repo", str(root)])
    kj = root / ".claude" / "kit.json"; d = json.loads(kj.read_text()); d["wip_limit"] = wip_limit; kj.write_text(json.dumps(d))
    rm = root / "ROADMAP.md"
    rm.write_text(rm.read_text().replace("| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |",
                                         "| Refund route | refund-route | M1 | queued | — | — | — |\n| Other | other | M1 | queued | — | — | — |"))
    commit = F.commit_all(root, "bootstrap")
    text = SPEC.format(commit=commit[:7], deps="none", extra="").replace("- Status: approved", f"- Status: {status}")
    if not approved:
        text = text.replace(f"Approved by: Jonathan Robles on 2026-11-08 at {commit[:7]}", "Approved by: — on — at —")
    (root / "docs" / "specs" / "refund-route.md").write_text(text)
    F.commit_all(root, "spec")
    return root, commit


def lane(*args, **kw):
    return run_script("lane.py", list(args), **kw)


def test_precheck_passes_for_approved_spec(tmp_path):
    root, _ = project(tmp_path)
    r = lane("precheck", "refund-route", "--repo", str(root))
    assert r.returncode == 0, r.stderr


def test_precheck_refuses_unapproved(tmp_path):
    root, _ = project(tmp_path, status="waiting-approval", approved=False)
    r = lane("precheck", "refund-route", "--repo", str(root))
    assert r.returncode == 2 and "approval line" in r.stderr and "needs 'approved'" in r.stderr


def test_precheck_refuses_open_question(tmp_path):
    root, _ = project(tmp_path)
    sp = root / "docs" / "specs" / "refund-route.md"
    sp.write_text(sp.read_text().replace("## Open questions\n\n- none", "## Open questions\n\n- is refund idempotent?"))
    r = lane("precheck", "refund-route", "--repo", str(root))
    assert r.returncode == 2 and "open-questions" in r.stderr


def test_precheck_refuses_overlap_and_wip(tmp_path):
    root, commit = project(tmp_path, wip_limit=1)
    other = SPEC.format(commit=commit[:7], deps="none", extra="").replace("refund-route", "other").replace("Refund route", "Other")
    (root / "docs" / "specs" / "other.md").write_text(other)
    rm = root / "ROADMAP.md"; rm.write_text(rm.read_text().replace("| Other | other | M1 | queued |", "| Other | other | M1 | building |"))
    r = lane("precheck", "refund-route", "--repo", str(root))
    assert r.returncode == 2 and "file overlap with active spec 'other'" in r.stderr and "WIP limit reached: 1/1" in r.stderr


def test_start_creates_worktree_lane_and_progress(tmp_path):
    root, _ = project(tmp_path)
    r = lane("start", "refund-route", "--repo", str(root))
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    wt = Path(out["worktree"])
    assert wt.is_dir() and (wt / ".claude" / "lane.json").is_file()
    lj = json.loads((wt / ".claude" / "lane.json").read_text())
    assert lj["feature"] == "refund-route" and lj["stage"] == "build" and lj["branch"] == "wt/refund-route"
    prog = (wt / "docs" / "specs" / "refund-route.progress.md").read_text()
    assert "| D1 | routes exposes refund | `tests/routes.test.ts::exposes refund` | — | — |" in prog
    assert "| Refund route | refund-route | M1 | building |" in (wt / "ROADMAP.md").read_text()
    assert F.git(["branch", "--show-current"], wt).strip() == "wt/refund-route"
    kit = json.loads((root / ".claude" / "kit.json").read_text())
    assert "refund-route" in kit["lanes"]
    # lane.json is ignored by git inside the worktree
    assert ".claude/lane.json" not in F.git(["status", "--porcelain", "--untracked-files=all"], wt)
    # second start is refused
    r2 = lane("start", "refund-route", "--repo", str(root))
    assert r2.returncode == 2 and "already exists" in r2.stderr


def test_stage_and_finish(tmp_path):
    root, _ = project(tmp_path)
    out = json.loads(lane("start", "refund-route", "--repo", str(root)).stdout)
    wt = Path(out["worktree"])
    assert lane("stage", "refund-route", "review", "--repo", str(root)).returncode == 0
    assert json.loads((wt / ".claude" / "lane.json").read_text())["stage"] == "review"
    r = lane("finish", "refund-route", "--repo", str(root))
    assert r.returncode == 0, r.stderr
    assert not wt.exists()
    assert "wt/refund-route" not in F.git(["branch"], root)
    assert "| Refund route | refund-route | M1 | merged |" in (root / "ROADMAP.md").read_text()
    assert "refund-route" not in json.loads((root / ".claude" / "kit.json").read_text())["lanes"]


def test_wip_count(tmp_path):
    root, _ = project(tmp_path, wip_limit=1)
    r = lane("wip", "--repo", str(root))
    assert r.returncode == 0 and json.loads(r.stdout)["in_flight"] == 0
    lane("start", "refund-route", "--repo", str(root))
    rm = root / "ROADMAP.md"; rm.write_text(rm.read_text().replace("| refund-route | M1 | queued |", "| refund-route | M1 | building |"))
    r = lane("wip", "--repo", str(root))
    assert r.returncode == 2 and json.loads(r.stdout)["in_flight"] == 1


def test_index_lookup_reuse_stale_new(tmp_path):
    root, commit = project(tmp_path)
    r = lane("index", "add", "How does PaymentService charge a user?", "--repo", str(root), "--slug", "payment-charge",
             "--keywords", "payment charge service", "--files", "src/domain/payment.ts", "--commit", commit[:7])
    assert r.returncode == 0, r.stderr
    res = json.loads(lane("index", "lookup", "how does the payment service charge users", "--repo", str(root), "--json").stdout)
    assert res["decision"] == "reuse" and res["match"]["slug"] == "payment-charge"
    res = json.loads(lane("index", "lookup", "what does the webhook retry policy look like", "--repo", str(root), "--json").stdout)
    assert res["decision"] == "new"
    (root / "src" / "domain" / "payment.ts").write_text("// changed\n" + (root / "src" / "domain" / "payment.ts").read_text())
    F.commit_all(root, "change payment")
    res = json.loads(lane("index", "lookup", "How does PaymentService charge a user?", "--repo", str(root), "--json").stdout)
    assert res["decision"] == "reverify" and res["stale_files"] == ["src/domain/payment.ts"]
    # re-adding the same slug supersedes the old row
    lane("index", "add", "How does PaymentService charge a user?", "--repo", str(root), "--slug", "payment-charge", "--keywords", "payment charge", "--files", "src/domain/payment.ts", "--commit", "deadbee")
    text = (root / "docs" / "research" / "INDEX.md").read_text()
    assert text.count("| payment-charge |") == 2 and "| superseded |" in text


def test_unknowns_budget(tmp_path):
    root, commit = project(tmp_path)
    sp = root / "docs" / "specs" / "refund-route.md"
    base = sp.read_text()
    r = lane("unknowns", "docs/specs/refund-route.md", "--repo", str(root), "--json")
    assert r.returncode == 0 and json.loads(r.stdout)["decision"] == "none"
    two = base.replace("- A1. routes returns a plain object [verified: src/api/routes.ts:3-3]",
                       "- A1. routes returns a plain object [verified: src/api/routes.ts:3-3]\n- A2. refund idempotent at provider [unknown] Resolve by: call sandbox twice\n- A3. rate limit [unknown]")
    sp.write_text(two)
    r = lane("unknowns", "docs/specs/refund-route.md", "--repo", str(root), "--json")
    out = json.loads(r.stdout)
    assert r.returncode == 3 and out["decision"] == "resolve" and out["count"] == 2 and out["missing_method"] == 1
    four = two.replace("## Open questions\n\n- none", "## Open questions\n\n- who owns refunds?\n- which currency?")
    sp.write_text(four)
    r = lane("unknowns", "docs/specs/refund-route.md", "--repo", str(root), "--json")
    out = json.loads(r.stdout)
    assert r.returncode == 2 and out["decision"] == "research" and out["count"] == 4


def test_incident_record(tmp_path):
    root, _ = project(tmp_path)
    r = lane("incident", "--repo", str(root), "--what", "refund charged twice on retry", "--slug", "refund-route", "--pr", "https://x/pr/9")
    assert r.returncode == 0, r.stderr
    p = root / r.stdout.strip()
    assert p.is_file() and p.parent.name == "incidents"
    t = p.read_text()
    assert "refund charged twice on retry" in t and "- Feature: refund-route" in t and "- Status: open" in t and "{{" not in t.split("## Impact")[0]
    r2 = lane("incident", "--repo", str(root), "--what", "second")
    assert r2.stdout.strip() != r.stdout.strip()
