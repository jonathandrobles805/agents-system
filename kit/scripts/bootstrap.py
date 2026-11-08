#!/usr/bin/env python3
"""bootstrap: detect a repository's stack and generate the kit's project layer.

Usage:
  bootstrap.py --repo PATH [--answers answers.json] [--dry-run] [--json] [--protect]
  bootstrap.py --repo PATH --detect-only --json        print detection and the questions, write nothing
  bootstrap.py --repo PATH --upgrade [--json]          refresh kit-owned files, back up what is replaced

Kit-owned files (regenerated on --upgrade): .claude/settings.json, .claude/kit.json (version, commands),
.claude/kit-manifest.json, scripts/sync.sh, the CI workflow. Human-owned files (written once, then only the
version stamp is touched): CLAUDE.md, ROADMAP.md, ARCHITECTURE.md, DESIGN.md, LESSONS.md, docs/.

Answers file (all optional; unanswered items become TODO(bootstrap) lines the human fills):
  {"project": "name", "wip_limit": 2, "milestones": [{"name": "...", "target": "..."}],
   "features": [{"name": "...", "slug": "...", "milestone": "M1"}],
   "layers": [{"name": "ui", "dirs": ["src/ui"], "imports": "application"}],
   "invariants": ["..."], "high_risk_paths": ["src/auth", "src/billing"],
   "commands": {"test": "...", "typecheck": "...", "lint": "..."}, "ci": "github"}
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K  # noqa: E402

KIT_DIR = Path(__file__).resolve().parents[1]
KIT_VERSION = (KIT_DIR.parent / "VERSION").read_text().strip() if (KIT_DIR.parent / "VERSION").is_file() else "0.0.0"
TODAY = dt.date.today().isoformat()
KIT_OWNED = [".claude/settings.json", ".claude/kit.json", ".claude/kit-manifest.json", "scripts/sync.sh"]
HUMAN_OWNED = ["CLAUDE.md", "ROADMAP.md", "ARCHITECTURE.md", "DESIGN.md", "LESSONS.md"]
DEFAULT_BUDGETS = {"research": {"hours": 1, "tool_calls": 200}, "plan": {"hours": 1, "tool_calls": 200}, "build": {"hours": 4, "tool_calls": 800}, "review": {"hours": 1, "tool_calls": 200}}


# ----------------------------------------------------------------------------- detection

def load_stacks() -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted((KIT_DIR / "stacks").glob("*.json"))]


def read_json(p: Path) -> dict:
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def node_deps(root: Path) -> dict[str, str]:
    pj = read_json(root / "package.json")
    deps = {}
    for k in ("dependencies", "devDependencies"):
        deps.update(pj.get(k, {}) or {})
    return deps


def python_deps(root: Path) -> set[str]:
    names: set[str] = set()
    pp = root / "pyproject.toml"
    if pp.is_file():
        txt = pp.read_text(errors="replace")
        # quoted requirement specs anywhere: "fastapi>=0.110", "pytest", "ruff>=0.5; python_version>'3.8'"
        for m in re.finditer(r'"([A-Za-z][A-Za-z0-9_.\-]*)(?:\[[^\]]*\])?\s*(?:[>=<~!;,@ ][^"]*)?"', txt):
            names.add(m.group(1).lower())
        # poetry-style tables: requests = "^2.0" / pytest = {version = "..."}
        for m in re.finditer(r'^\s*([A-Za-z][A-Za-z0-9_.\-]*)\s*=\s*["{^]', txt, re.M):
            names.add(m.group(1).lower())
        for tool in ("pytest", "mypy", "ruff", "pyright", "importlinter", "mutmut"):
            if f"[tool.{tool}" in txt:
                names.add("import-linter" if tool == "importlinter" else tool)
    for req in list(root.glob("requirements*.txt")) + [root / "Pipfile"]:
        if req.is_file():
            for line in req.read_text(errors="replace").splitlines():
                m = re.match(r"^\s*([A-Za-z0-9_.\-]+)", line)
                if m and not line.strip().startswith("#"):
                    names.add(m.group(1).lower())
    return names


def detect(root: Path) -> dict:
    stacks = load_stacks()
    found = []
    for s in stacks:
        if any((root / f).is_file() for f in s["detect"]):
            found.append(s)
    result: dict = {"stacks": [], "frameworks": [], "commands": {}, "missing_tools": {}, "lockfiles": [], "ci": None,
                    "dirs": [], "existing_docs": [], "tokens_file": None, "branches": [], "worktrees": [], "credential_files": []}
    for s in found:
        result["stacks"].append(s["name"])
        result["lockfiles"] += [lf for lf in s["lockfiles"] if (root / lf).is_file()]
        present: set[str] = set()
        if s["name"] == "node":
            deps = node_deps(root)
            present = set(deps)
            result["frameworks"] += [v for k, v in s["frameworks"].items() if k in deps]
        elif s["name"] == "python":
            present = python_deps(root)
            result["frameworks"] += [v for k, v in s["frameworks"].items() if k in present]
        elif s["name"] == "go":
            present = {"go"}
            gm = (root / "go.mod").read_text(errors="replace") if (root / "go.mod").is_file() else ""
            result["frameworks"] += [v for k, v in s["frameworks"].items() if k in gm]
            if shutil.which("golangci-lint"):
                present.add("golangci-lint")
        elif s["name"] == "rust":
            present = {"cargo"}
            ct = (root / "Cargo.toml").read_text(errors="replace") if (root / "Cargo.toml").is_file() else ""
            result["frameworks"] += [v for k, v in s["frameworks"].items() if k in ct]
        for tool, cmds in s["tools"].items():
            if tool in present:
                for k, v in cmds.items():
                    result["commands"].setdefault(k, v)
        result["commands"].setdefault("audit", s["audit"])
        for want, hint in s.get("install_hint", {}).items():
            if want not in result["commands"]:
                result["missing_tools"][want] = hint
    # CI
    if (root / ".github").is_dir():
        result["ci"] = "github"
    elif (root / ".gitlab-ci.yml").is_file():
        result["ci"] = "gitlab"
    # Folder map
    for d in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".") and p.name not in {"node_modules", "venv", ".venv", "dist", "build", "target", "__pycache__"}):
        files = [f for f in d.rglob("*") if f.is_file() and "node_modules" not in f.parts][:2000]
        if not files:
            continue
        ext = {}
        for f in files:
            ext[f.suffix] = ext.get(f.suffix, 0) + 1
        top = max(ext, key=ext.get) if ext else ""
        result["dirs"].append({"dir": d.name, "files": len(files), "main_ext": top})
    # Existing docs and tokens
    for name in ("README.md", "ARCHITECTURE.md", "DESIGN.md", "CONTRIBUTING.md", "docs"):
        if (root / name).exists():
            result["existing_docs"].append(name)
    for cand in ("tokens.css", "src/tokens.css", "src/styles/tokens.css", "tailwind.config.js", "tailwind.config.ts", "src/theme.ts", "theme.json", "design-tokens.json"):
        if (root / cand).is_file():
            result["tokens_file"] = cand
            break
    # Credential files that must never be readable by a lane
    for pat in (".env", ".env.local", ".env.production", "*.pem", "*.key", "service-account*.json", ".aws/credentials"):
        for p in root.glob(pat):
            if p.is_file():
                result["credential_files"].append(p.relative_to(root).as_posix())
    # Git state
    try:
        result["default_branch"] = K.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root).strip().split("/")[-1]
    except Exception:
        result["default_branch"] = "main"
    try:
        for line in K.git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root).splitlines():
            b = line.strip()
            if not b or b == result["default_branch"]:
                continue
            try:
                behind, ahead = K.git(["rev-list", "--left-right", "--count", f"{result['default_branch']}...{b}"], root).split()
            except Exception:
                behind, ahead = "?", "?"
            result["branches"].append({"branch": b, "behind": behind, "ahead": ahead})
    except Exception:
        pass
    try:
        for line in K.git(["worktree", "list", "--porcelain"], root).split("\n\n"):
            m = re.search(r"^worktree (.+)$", line, re.M)
            b = re.search(r"^branch (.+)$", line, re.M)
            if m:
                result["worktrees"].append({"path": m.group(1), "branch": b.group(1).replace("refs/heads/", "") if b else "(detached)"})
    except Exception:
        pass
    return result


def questions(det: dict, answers: dict) -> list[dict]:
    q = []
    if not answers.get("milestones") or not answers.get("features"):
        q.append({"id": "roadmap", "question": "What are the milestones and the first features (name + slug) in order?", "why": "ROADMAP.md is the single source of truth; it is not guessed."})
    if "wip_limit" not in answers:
        q.append({"id": "wip_limit", "question": "WIP limit (features in flight at once)?", "default": 2})
    if not answers.get("layers"):
        q.append({"id": "layers", "question": "Architecture layers and allowed dependency direction?", "draft": [d["dir"] for d in det["dirs"]], "why": "Becomes the import-boundary lint config."})
    if not answers.get("high_risk_paths"):
        q.append({"id": "high_risk_paths", "question": "High-risk paths (auth, payments, migrations, public API, infra)?", "default": K.DEFAULT_HIGH_RISK_PATHS})
    if not answers.get("commands"):
        q.append({"id": "commands", "question": "Are these detected commands correct?", "draft": det["commands"], "missing": det["missing_tools"]})
    if det["credential_files"]:
        q.append({"id": "credentials", "question": f"Credential files found: {det['credential_files']}. Lanes will be denied reading them. Confirm, or move them out of the repo.", "blocking": True})
    if det["branches"]:
        stale = [b for b in det["branches"] if b["behind"] not in ("0", "?") and int(b["behind"]) > 20]
        if stale:
            q.append({"id": "drift", "question": f"{len(stale)} branch(es) are more than 20 commits behind {det['default_branch']}. Merge, sync, or delete them before bootstrapping lanes.", "branches": stale, "blocking": False})
    return q


# ----------------------------------------------------------------------------- generation

def tmpl(name: str) -> str:
    return (KIT_DIR / "templates" / name).read_text()


def fill(text: str, values: dict[str, str]) -> str:
    for k, v in values.items():
        text = text.replace("{{" + k + "}}", str(v))
    return text


def todo(text: str, label: str) -> str:
    """Replace any remaining {{placeholder}} with a TODO(bootstrap) marker the human can grep for."""
    return re.sub(r"\{\{([^}]*)\}\}", lambda m: f"TODO(bootstrap: {label} — {m.group(1).strip()})", text)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Bootstrap:
    def __init__(self, root: Path, answers: dict, dry: bool, upgrade: bool):
        self.root, self.answers, self.dry, self.upgrade = root, answers, dry, upgrade
        self.det = detect(root)
        self.written: list[str] = []
        self.skipped: list[str] = []
        self.backed_up: list[str] = []

    def write(self, rel: str, content: str, owned: str) -> None:
        p = self.root / rel
        if p.exists():
            if owned == "human" and not self.upgrade:
                self.skipped.append(rel + " (exists, human-owned)")
                return
            if owned == "human" and self.upgrade:
                # only refresh the kit version stamp line
                old = p.read_text()
                new = re.sub(r"agent-kit \d+\.\d+\.\d+", f"agent-kit {KIT_VERSION}", old)
                if new != old and not self.dry:
                    p.write_text(new)
                    self.written.append(rel + " (version stamp)")
                else:
                    self.skipped.append(rel + " (exists, human-owned)")
                return
            if owned == "kit" and p.read_text() == content:
                self.skipped.append(rel + " (unchanged)")
                return
            if owned == "kit" and self.upgrade and not self.dry:
                bdir = self.root / ".claude" / "backup" / KIT_VERSION
                bdir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, bdir / rel.replace("/", "__"))
                self.backed_up.append(rel)
        if not self.dry:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            if rel.endswith(".sh"):
                p.chmod(0o755)
        self.written.append(rel)

    # -- individual files
    def commands(self) -> dict:
        c = dict(self.det["commands"])
        c.update(self.answers.get("commands", {}))
        return c

    def kit_json(self) -> dict:
        existing = read_json(self.root / ".claude" / "kit.json")
        return {
            "kit_version": KIT_VERSION,
            "bootstrapped": existing.get("bootstrapped", TODAY),
            "upgraded": TODAY if self.upgrade else existing.get("upgraded"),
            "project": self.answers.get("project", existing.get("project", self.root.name)),
            "stack": self.det["stacks"],
            "frameworks": self.det["frameworks"],
            "default_branch": self.det.get("default_branch", "main"),
            "ci": self.answers.get("ci", existing.get("ci", self.det["ci"] or "github")),
            "commands": self.commands(),
            "wip_limit": self.answers.get("wip_limit", existing.get("wip_limit", 2)),
            "high_risk_paths": self.answers.get("high_risk_paths", existing.get("high_risk_paths", K.DEFAULT_HIGH_RISK_PATHS)),
            "secret_patterns": existing.get("secret_patterns", []),
            "budgets": existing.get("budgets", DEFAULT_BUDGETS),
            "mutation_threshold": existing.get("mutation_threshold", 70),
            "mutation_blocking_after_features": existing.get("mutation_blocking_after_features", 2),
            "claude_md_cap_bytes": existing.get("claude_md_cap_bytes", 4000),
            "lanes": existing.get("lanes", {}),
        }

    def settings_json(self) -> str:
        frag = read_json(KIT_DIR / "hooks" / "settings.project.json")
        frag.pop("$comment", None)
        existing = read_json(self.root / ".claude" / "settings.json")
        merged = dict(existing)
        merged["hooks"] = frag["hooks"]
        deny = set((existing.get("permissions") or {}).get("deny", [])) | set(frag["permissions"]["deny"])
        for cf in self.det["credential_files"]:
            deny.add(f"Read({cf})")
        merged["permissions"] = {**(existing.get("permissions") or {}), "deny": sorted(deny)}
        return json.dumps(merged, indent=2) + "\n"

    def claude_md(self) -> str:
        cmds = self.commands()
        dirs = "\n".join(f"- `{d['dir']}/` — {d['files']} file{'s' if d['files'] != 1 else ''}, mostly `{d['main_ext'] or 'mixed'}`" for d in self.det["dirs"]) or "- TODO(bootstrap: project map)"
        text = fill(tmpl("claude-md.md"), {
            "project": self.answers.get("project", self.root.name), "kit_version": KIT_VERSION, "date": TODAY,
            "test_cmd": cmds.get("test", "TODO"), "typecheck_cmd": cmds.get("typecheck", "none"), "lint_cmd": cmds.get("lint_all", cmds.get("lint", "none")),
        })
        text = text.replace("- `{{dir}}/` — {{what lives here}}", dirs).replace("- {{none}}", "- none yet")
        return todo(text, "CLAUDE.md")

    def roadmap(self) -> str:
        ms = self.answers.get("milestones") or []
        fs = self.answers.get("features") or []
        text = fill(tmpl("roadmap.md"), {"version": KIT_VERSION, "n": self.answers.get("wip_limit", 2), "date": TODAY})
        if ms:
            rows = "\n".join(f"| M{i+1} | {m['name']} | {m.get('target', '—')} | {m.get('status', 'planned')} |" for i, m in enumerate(ms))
            text = re.sub(r"\| M1 \| \{\{milestone\}\} \|.*\|", rows, text)
        if fs:
            rows = "\n".join(f"| {f['name']} | {f['slug']} | {f.get('milestone', 'M1')} | queued | — | — | — |" for f in fs)
            text = re.sub(r"\| \{\{feature\}\} \| \{\{slug\}\} \|.*\|", rows, text)
            text = text.replace("1. {{slug}}", "\n".join(f"{i+1}. {f['slug']}" for i, f in enumerate(fs)))
        return todo(text, "ROADMAP.md")

    def architecture(self) -> str:
        text = tmpl("architecture.md").replace("{{date}}", TODAY)
        layers = self.answers.get("layers")
        if layers:
            rows = "\n".join(f"| {l['name']} | `{'`, `'.join(l.get('dirs', []))}` | {l.get('imports', 'nothing in the app')} |" for l in layers)
            text = re.sub(r"\| \{\{ui\}\} \|.*\n\| \{\{application\}\} \|.*\n\| \{\{domain\}\} \|.*\n\| \{\{infrastructure\}\} \|.*", rows, text)
        else:
            draft = "\n".join(f"| TODO(bootstrap: layer name) | `{d['dir']}` | TODO(bootstrap: may import from) |" for d in self.det["dirs"]) or "| TODO(bootstrap: layer) | TODO | TODO |"
            text = re.sub(r"\| \{\{ui\}\} \|.*\n\| \{\{application\}\} \|.*\n\| \{\{domain\}\} \|.*\n\| \{\{infrastructure\}\} \|.*", draft, text)
        inv = self.answers.get("invariants") or []
        if inv:
            text = text.replace("- [ ] {{invariant, stated so it can be checked}}", "\n".join(f"- [ ] {i}" for i in inv))
        hr = self.answers.get("high_risk_paths") or K.DEFAULT_HIGH_RISK_PATHS
        text = text.replace("- `{{path}}`", "\n".join(f"- `{p}`" for p in hr))
        return todo(text, "ARCHITECTURE.md")

    def design(self) -> str:
        text = tmpl("design.md").replace("{{date}}", TODAY).replace("{{path}}", self.det["tokens_file"] or "TODO(bootstrap: tokens file path)")
        return todo(text, "DESIGN.md")

    def lessons(self) -> str:
        return "# Lessons\n\nRules the system learned. The Debt section lists rules not yet enforced by a check; keep it short.\n\n## Debt\n\n- none\n"

    def sync_sh(self) -> str:
        cmds = self.commands()
        return f"""#!/usr/bin/env bash
# sync: bring this worktree up to date with {self.det.get('default_branch', 'main')} and prove it still passes. Generated by agent-kit {KIT_VERSION}.
set -euo pipefail
BASE="${{1:-{self.det.get('default_branch', 'main')}}}"
git fetch origin "$BASE"
if ! git merge --no-edit "origin/$BASE"; then
  echo "sync: merge conflict with $BASE. Resolve once (counts as a failed attempt), re-run tests, or escalate." >&2
  exit 3
fi
{cmds.get('test', 'echo "no test command configured"')}
echo "sync: up to date with $BASE and tests pass"
"""

    def ci_workflow(self) -> tuple[str, str]:
        cmds = self.commands()
        kit = self.kit_json()
        tpl = (KIT_DIR / "ci" / "github.yml").read_text()
        text = fill(tpl, {
            "test": cmds.get("test", "echo no tests"), "typecheck": cmds.get("typecheck", "echo no typecheck"),
            "lint": cmds.get("lint_all", cmds.get("lint", "echo no lint").replace("{file}", ".")),
            "boundaries": cmds.get("boundaries", "echo no boundaries lint configured"), "audit": cmds.get("audit", "echo no audit"),
            "mutation": cmds.get("mutation", "echo no mutation testing configured"), "default_branch": kit["default_branch"],
            "kit_version": KIT_VERSION, "kit_ref": "main", "mutation_threshold": str(kit["mutation_threshold"]),
        })
        return ".github/workflows/kit.yml", text

    def gitignore(self) -> None:
        p = self.root / ".gitignore"
        wanted = [".claude/session/", ".claude/lane.json", ".claude/backup/", ".claude/settings.local.json"]
        existing = p.read_text().splitlines() if p.is_file() else []
        add = [w for w in wanted if w not in existing]
        if add and not self.dry:
            p.write_text("\n".join(existing + ["", "# agent-kit"] + add) + "\n")
        if add:
            self.written.append(".gitignore (+%d)" % len(add))

    def manifest(self) -> str:
        files = {}
        for rel in KIT_OWNED + [".github/workflows/kit.yml"]:
            p = self.root / rel
            if p.is_file() and rel != ".claude/kit-manifest.json":
                files[rel] = sha(p)
        scripts = {p.name: sha(p) for p in sorted((KIT_DIR / "scripts").glob("*.py"))}
        return json.dumps({"kit_version": KIT_VERSION, "generated": TODAY, "files": files, "kit_scripts": scripts}, indent=2) + "\n"

    def run(self) -> dict:
        if not self.upgrade:
            self.write("CLAUDE.md", self.claude_md(), "human")
            self.write("ROADMAP.md", self.roadmap(), "human")
            self.write("ARCHITECTURE.md", self.architecture(), "human")
            self.write("DESIGN.md", self.design(), "human")
            self.write("LESSONS.md", self.lessons(), "human")
            self.write("docs/research/INDEX.md", tmpl("index.md"), "human")
            self.write("docs/specs/README.md", "# Specs\n\nOne file per feature, from `~/.claude/kit/templates/spec.md`. Companion files: `<slug>.progress.md`, `<slug>.review.md`, `<slug>.log`, `<slug>.events.jsonl`.\n", "human")
            self.write("docs/decisions/0001-adopt-agent-kit.md", fill(tmpl("decision.md"), {
                "NNNN": "0001", "title": "Adopt the agent kit", "date": TODAY,
                "what situation forced a decision": "Agents guessed, branches drifted, and rules lived only in prompts.",
                "what was decided": f"Adopt agent-kit {KIT_VERSION}: specs with provenance tags, hooks that block unread or out-of-spec edits, a fresh-context reviewer, one worktree per feature, retro after every merge.",
                "alternative": "Longer prompts and manual review", "why not": "Prompts are skimmed; manual review does not scale past one lane.",
                "what this makes easier, what it makes harder": "Easier: parallel features with gates. Harder: every rule must be expressible as a check.",
            }), "human")
        else:
            for rel in HUMAN_OWNED:
                if (self.root / rel).is_file():
                    self.write(rel, "", "human")
        self.write(".claude/kit.json", json.dumps(self.kit_json(), indent=2) + "\n", "kit")
        self.write(".claude/settings.json", self.settings_json(), "kit")
        self.write("scripts/sync.sh", self.sync_sh(), "kit")
        rel, text = self.ci_workflow()
        self.write(rel, text, "kit")
        self.gitignore()
        if not self.dry:
            self.write(".claude/kit-manifest.json", self.manifest(), "kit")
        return {"kit_version": KIT_VERSION, "written": self.written, "skipped": self.skipped, "backed_up": self.backed_up,
                "detection": self.det, "questions": questions(self.det, self.answers), "dry_run": self.dry}


def protect_branch(root: Path, branch: str, checks: list[str]) -> dict:
    """Set branch protection through gh. Returns a result dict; never raises."""
    if not shutil.which("gh"):
        return {"ok": False, "reason": "gh not installed"}
    try:
        remote = K.git(["config", "--get", "remote.origin.url"], root).strip()
        m = re.search(r"github\.com[:/]([^/]+)/([^/.]+)", remote)
        if not m:
            return {"ok": False, "reason": f"origin is not GitHub: {remote}"}
        owner, repo = m.group(1), m.group(2)
        body = {"required_status_checks": {"strict": True, "contexts": checks}, "enforce_admins": False,
                "required_pull_request_reviews": None, "restrictions": None, "allow_force_pushes": False, "allow_deletions": False}
        r = subprocess.run(["gh", "api", "-X", "PUT", f"repos/{owner}/{repo}/branches/{branch}/protection", "--input", "-"],
                           input=json.dumps(body), capture_output=True, text=True, timeout=60)
        return {"ok": r.returncode == 0, "reason": r.stderr.strip()[:300] if r.returncode else "", "repo": f"{owner}/{repo}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--answers")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--detect-only", action="store_true")
    ap.add_argument("--upgrade", action="store_true")
    ap.add_argument("--protect", action="store_true", help="set GitHub branch protection via gh")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    root = Path(a.repo).resolve()
    if not (root / ".git").exists():
        print(f"bootstrap: {root} is not a git repository", file=sys.stderr)
        return 1
    answers = read_json(Path(a.answers)) if a.answers else {}
    if a.detect_only:
        det = detect(root)
        out = {"detection": det, "questions": questions(det, answers)}
        print(json.dumps(out, indent=2) if a.json else f"stacks: {det['stacks']}\nframeworks: {det['frameworks']}\ncommands: {json.dumps(det['commands'], indent=2)}\nmissing tools: {det['missing_tools']}\nquestions: {len(out['questions'])}")
        return 0
    b = Bootstrap(root, answers, a.dry_run, a.upgrade)
    result = b.run()
    if a.protect and not a.dry_run:
        result["branch_protection"] = protect_branch(root, b.det.get("default_branch", "main"), ["tests", "typecheck", "lint", "boundaries", "scope-diff", "test-count", "dep-diff", "secrets", "claude-md-cap", "guards-present", "validate-docs", "review-report"])
    if a.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"agent-kit {KIT_VERSION} {'upgrade' if a.upgrade else 'bootstrap'}{' (dry run)' if a.dry_run else ''}: {root}")
        print(f"stacks: {', '.join(b.det['stacks']) or 'unknown'}  frameworks: {', '.join(b.det['frameworks']) or '-'}  ci: {b.det['ci'] or 'none'}")
        for w in result["written"]:
            print(f"  wrote   {w}")
        for s in result["skipped"]:
            print(f"  kept    {s}")
        for s in result["backed_up"]:
            print(f"  backup  {s}")
        if result["questions"]:
            print("\nQuestions for the human (bootstrap does not guess these):")
            for q in result["questions"]:
                print(f"  [{q['id']}] {q['question']}")
        if b.det["missing_tools"]:
            print("\nTools not found (proposed, not installed):")
            for k, v in b.det["missing_tools"].items():
                print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
