import json
import re
from pathlib import Path

import fixtures as F
from conftest import run_script

KIT = Path(__file__).resolve().parents[2]
FRAG = json.loads((KIT / "hooks" / "settings.project.json").read_text())


def boot(root: Path, *args: str):
    r = run_script("bootstrap.py", ["--repo", str(root), "--json", *args])
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_detect_node(tmp_path):
    root = F.node_api(tmp_path / "node-api")
    r = run_script("bootstrap.py", ["--repo", str(root), "--detect-only", "--json"])
    det = json.loads(r.stdout)["detection"]
    assert det["stacks"] == ["node"] and "Express" in det["frameworks"]
    assert det["commands"]["test"].startswith("npx vitest") and det["commands"]["typecheck"].startswith("npx tsc") and "eslint" in det["commands"]["lint"]
    assert det["ci"] == "github" and ".env" in det["credential_files"]
    assert "boundaries" in det["missing_tools"] and "mutation" in det["missing_tools"]
    assert {d["dir"] for d in det["dirs"]} == {"src", "tests"}


def test_detect_python(tmp_path):
    root = F.python_service(tmp_path / "py")
    det = json.loads(run_script("bootstrap.py", ["--repo", str(root), "--detect-only", "--json"]).stdout)["detection"]
    assert det["stacks"] == ["python"] and "FastAPI" in det["frameworks"]
    assert det["commands"]["test"].startswith("python -m pytest") and "ruff" in det["commands"]["lint"] and "mypy" in det["commands"]["typecheck"]
    assert det["ci"] == "gitlab"


def test_bootstrap_generates_project_layer(tmp_path):
    root = F.node_api(tmp_path / "node-api")
    res = boot(root)
    for rel in ("CLAUDE.md", "ROADMAP.md", "ARCHITECTURE.md", "DESIGN.md", "LESSONS.md", "docs/research/INDEX.md", "docs/specs/README.md",
                "docs/decisions/0001-adopt-agent-kit.md", ".claude/kit.json", ".claude/settings.json", ".claude/kit-manifest.json", "scripts/sync.sh", ".github/workflows/kit.yml"):
        assert (root / rel).is_file(), rel
    # no template placeholders survive; unknowns become TODO(bootstrap) markers
    for rel in ("CLAUDE.md", "ROADMAP.md", "ARCHITECTURE.md", "DESIGN.md"):
        text = (root / rel).read_text()
        assert "{{" not in text, rel
    assert "TODO(bootstrap" in (root / "ROADMAP.md").read_text()
    kit = json.loads((root / ".claude" / "kit.json").read_text())
    assert kit["stack"] == ["node"] and kit["wip_limit"] == 2 and kit["commands"]["test"].startswith("npx vitest")
    settings = json.loads((root / ".claude" / "settings.json").read_text())
    assert settings["hooks"] == FRAG["hooks"]
    assert "Read(.env)" in settings["permissions"]["deny"]
    assert len((root / "CLAUDE.md").read_bytes()) <= kit["claude_md_cap_bytes"]
    gi = (root / ".gitignore").read_text()
    assert ".claude/session/" in gi and ".claude/lane.json" in gi
    assert (root / "scripts" / "sync.sh").stat().st_mode & 0o111
    wf = (root / ".github" / "workflows" / "kit.yml").read_text()
    assert "npx vitest run" in wf and "ci_scope_diff.py" in wf and not re.search(r"(?<!\$)\{\{", wf)
    assert any(q["id"] == "roadmap" for q in res["questions"]) and any(q["id"] == "credentials" for q in res["questions"])


def test_bootstrap_with_answers_fills_roadmap_and_architecture(tmp_path):
    root = F.python_service(tmp_path / "py")
    ans = tmp_path / "answers.json"
    ans.write_text(json.dumps({
        "project": "billing-svc", "wip_limit": 1,
        "milestones": [{"name": "MVP", "target": "Dec 2026"}],
        "features": [{"name": "Refund endpoint", "slug": "refund-endpoint", "milestone": "M1"}, {"name": "Invoices", "slug": "invoices"}],
        "layers": [{"name": "api", "dirs": ["app/api"], "imports": "domain"}, {"name": "domain", "dirs": ["app"], "imports": "nothing in the app"}],
        "invariants": ["app/domain never imports app/api"], "high_risk_paths": ["app/billing.py"],
        "commands": {"test": "python -m pytest -q tests"},
    }))
    res = boot(root, "--answers", str(ans))
    rm = (root / "ROADMAP.md").read_text()
    assert "| M1 | MVP | Dec 2026 | planned |" in rm and "| Refund endpoint | refund-endpoint | M1 | queued |" in rm and "1. refund-endpoint\n2. invoices" in rm
    assert "TODO(bootstrap" not in rm
    arch = (root / "ARCHITECTURE.md").read_text()
    assert "| api | `app/api` | domain |" in arch and "- [ ] app/domain never imports app/api" in arch and "- `app/billing.py`" in arch
    kit = json.loads((root / ".claude" / "kit.json").read_text())
    assert kit["wip_limit"] == 1 and kit["project"] == "billing-svc" and kit["commands"]["test"] == "python -m pytest -q tests" and kit["high_risk_paths"] == ["app/billing.py"]
    assert not any(q["id"] in ("roadmap", "layers", "wip_limit") for q in res["questions"])


def test_bootstrap_is_idempotent_and_keeps_human_files(tmp_path):
    root = F.node_api(tmp_path / "node-api")
    boot(root)
    (root / "CLAUDE.md").write_text((root / "CLAUDE.md").read_text() + "\n## Team notes\n- we deploy on Fridays\n")
    res = boot(root)
    assert "CLAUDE.md (exists, human-owned)" in res["skipped"]
    assert "we deploy on Fridays" in (root / "CLAUDE.md").read_text()
    assert ".claude/settings.json (unchanged)" in res["skipped"]


def test_upgrade_backs_up_kit_files_and_touches_only_version_stamp(tmp_path):
    root = F.node_api(tmp_path / "node-api")
    boot(root)
    (root / "CLAUDE.md").write_text((root / "CLAUDE.md").read_text().replace("agent-kit 0.1.0", "agent-kit 0.0.9") + "\n## Team notes\n- keep\n")
    # simulate an older settings.json that needs refreshing
    s = json.loads((root / ".claude" / "settings.json").read_text()); s["hooks"].pop("Stop"); (root / ".claude" / "settings.json").write_text(json.dumps(s))
    res = boot(root, "--upgrade")
    assert ".claude/settings.json" in res["backed_up"]
    assert (root / ".claude" / "backup").is_dir()
    assert json.loads((root / ".claude" / "settings.json").read_text())["hooks"] == FRAG["hooks"]
    text = (root / "CLAUDE.md").read_text()
    assert "- keep" in text and "agent-kit 0.1.0" in text and "agent-kit 0.0.9" not in text


def test_dry_run_writes_nothing(tmp_path):
    root = F.python_service(tmp_path / "py")
    res = boot(root, "--dry-run")
    assert res["dry_run"] and res["written"]
    assert not (root / "CLAUDE.md").exists() and not (root / ".claude" / "kit.json").exists()


def test_not_a_git_repo_fails(tmp_path):
    (tmp_path / "x").mkdir()
    r = run_script("bootstrap.py", ["--repo", str(tmp_path / "x")])
    assert r.returncode == 1


def test_drift_question_appears_for_stale_branches(tmp_path):
    root = F.node_api(tmp_path / "node-api")
    F.git(["checkout", "-q", "-b", "old-feature"], root)
    F.git(["checkout", "-q", "main"], root)
    for i in range(25):
        (root / f"f{i}.txt").write_text(str(i))
        F.commit_all(root, f"c{i}")
    det = json.loads(run_script("bootstrap.py", ["--repo", str(root), "--detect-only", "--json"]).stdout)
    assert any(q["id"] == "drift" for q in det["questions"])
    assert det["detection"]["branches"][0]["behind"] == "25"
