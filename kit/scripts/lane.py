#!/usr/bin/env python3
"""lane: the mechanical half of the pipeline commands. Agents do the thinking; this does the git and file bookkeeping.

  lane.py precheck <slug> --repo R          may /implement start? (spec valid + approved, no open questions, WIP, no file overlap)
  lane.py start <slug> --repo R [--base B]  precheck, then worktree ../<repo>-lanes/<slug> on branch wt/<slug> from fresh base; lane.json; progress skeleton
  lane.py stage <slug> <stage> --repo R     set lane.json stage (research|plan|build|review) and reset its clock
  lane.py wip --repo R                      active lanes vs WIP limit
  lane.py unknowns <draft spec> --repo R    exit 0 none / 3 resolve (1..3, one researcher each) / 2 research insufficient (>3)
  lane.py roadmap-set <slug> <status> --repo R
  lane.py index lookup "<question>" --repo R [--json]   reuse | stale | new, from docs/research/INDEX.md
  lane.py index add "<question>" --repo R --slug S --keywords K --files F --commit C
  lane.py next-step <slug> --repo R         JSON: the next stage for this feature, derived from files and git
  lane.py next --repo R                     JSON: next queued slug with an agreed goal (exit 2 if none / WIP full)
  lane.py goal-set <slug> agreed|running|done --repo R
  lane.py incident --repo R --what "..." [--slug S] [--pr URL]   record a production incident for /retro --incident
  lane.py merged <slug> --repo R [--pr URL] at merge time: verify in git, mark ROADMAP merged (idempotent)
  lane.py finish <slug> --repo R            after retro: remove worktree and local branch, mark roadmap merged
Exit 0 ok, 2 refused (reasons on stderr), 1 usage/git error.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K  # noqa: E402
import validate_docs as V  # noqa: E402

ACTIVE = {"researching", "planning", "waiting-approval", "building", "in-review", "escalated", "ready-to-merge"}
IN_FLIGHT = {"building", "in-review", "escalated", "ready-to-merge"}


def refuse(msgs: list[str]) -> int:
    for m in msgs:
        print(f"lane: {m}", file=sys.stderr)
    return 2


def spec_path(root: Path, slug: str) -> Path:
    return root / "docs" / "specs" / f"{slug}.md"


def spec_header(path: Path) -> dict[str, str]:
    return {k: v for k, (_, v) in K.header_fields(K.strip_html_comments(K.read_lines(path))).items()} if path.is_file() else {}


def roadmap_rows(root: Path) -> list[dict]:
    p = root / "ROADMAP.md"
    if not p.is_file():
        return []
    sec = K.parse_sections(K.strip_html_comments(K.read_lines(p))).get("features")
    rows = []
    if sec:
        for n, cells in sec.table_rows():
            if len(cells) >= 4 and not cells[0].startswith("TODO"):
                rows.append({"line": n, "feature": cells[0], "slug": cells[1], "milestone": cells[2], "status": cells[3],
                             "spec": cells[4] if len(cells) > 4 else "", "lane": cells[5] if len(cells) > 5 else "", "pr": cells[6] if len(cells) > 6 else ""})
    return rows


def roadmap_set(root: Path, slug: str, status: str, **cols: str) -> bool:
    p = root / "ROADMAP.md"
    if not p.is_file():
        return False
    lines = p.read_text().splitlines()
    for row in roadmap_rows(root):
        if row["slug"] == slug:
            cells = [c.strip() for c in lines[row["line"] - 1].strip().strip("|").split("|")]
            while len(cells) < 7:
                cells.append("—")
            cells[3] = status
            for key, idx in (("spec", 4), ("lane", 5), ("pr", 6)):
                if key in cols:
                    cells[idx] = cols[key]
            lines[row["line"] - 1] = "| " + " | ".join(cells) + " |"
            p.write_text("\n".join(lines) + "\n")
            return True
    return False


def active_specs(root: Path, exclude: str | None = None) -> list[tuple[str, set[str]]]:
    out = []
    for p in (root / "docs" / "specs").glob("*.md"):
        if p.name.endswith((".progress.md", ".review.md")) or p.name == "README.md" or p.stem == exclude:
            continue
        hdr = spec_header(p)
        if hdr.get("status", "").lower() in ACTIVE | {"approved"}:
            _, change, create = K.spec_file_lists(p)
            out.append((p.stem, set(change + create)))
    return out


def wip(root: Path) -> tuple[int, int, list[str]]:
    kit = K.load_kit_json(root)
    limit = int(kit.get("wip_limit", 2))
    lanes = [r["slug"] for r in roadmap_rows(root) if r["status"] in IN_FLIGHT]
    return len(lanes), limit, lanes


def precheck(root: Path, slug: str) -> list[str]:
    problems: list[str] = []
    sp = spec_path(root, slug)
    if not sp.is_file():
        return [f"spec {sp.relative_to(root)} does not exist; run /plan {slug}"]
    v = V.Validator(root, None, K.load_kit_json(root))
    v.run(sp, "spec")
    problems += [f"spec invalid: {x}" for x in v.v]
    hdr = spec_header(sp)
    if hdr.get("status", "").lower() not in {"approved", "building", "escalated"}:
        problems.append(f"spec status is '{hdr.get('status', '')}', needs 'approved' (a human sets it with the approval line)")
    text = sp.read_text()
    if not re.search(r"Approved by:\s*(?!—)\S.*\s+on\s+\d{4}-\d{2}-\d{2}\s+at\s+[0-9a-f]{7,40}", text):
        problems.append("no approval line (Approved by: <name> on <date> at <commit>)")
    n, limit, lanes = wip(root)
    if hdr.get("status", "").lower() == "approved" and n >= limit:
        problems.append(f"WIP limit reached: {n}/{limit} in flight ({', '.join(lanes)}). Merge or escalate one first.")
    _, change, create = K.spec_file_lists(sp)
    mine = set(change + create)
    for other, files in active_specs(root, exclude=slug):
        overlap = sorted(mine & files)
        if overlap:
            problems.append(f"file overlap with active spec '{other}': {', '.join(overlap)}")
    return problems


def lanes_dir(root: Path) -> Path:
    return root.parent / f"{root.name}-lanes"


def start(root: Path, slug: str, base: str | None) -> int:
    problems = precheck(root, slug)
    if problems:
        return refuse(problems)
    kit = K.load_kit_json(root)
    base = base or kit.get("default_branch", "main")
    wt = lanes_dir(root) / slug
    branch = f"wt/{slug}"
    if wt.exists():
        return refuse([f"worktree {wt} already exists; resume with /implement {slug} inside it, or run lane.py finish first"])
    has_origin = "origin" in K.git(["remote"], root).split()
    if has_origin:
        try:
            K.git(["fetch", "-q", "origin", base], root)
            start_point = f"origin/{base}"
        except subprocess.CalledProcessError:
            start_point = base
    else:
        start_point = base
    wt.parent.mkdir(parents=True, exist_ok=True)
    try:
        K.git(["worktree", "add", "-q", "-b", branch, str(wt), start_point], root)
    except subprocess.CalledProcessError as e:
        return refuse([f"git worktree add failed: {e.stderr.strip() if e.stderr else e}"])
    (wt / ".claude").mkdir(exist_ok=True)
    now = dt.datetime.now().isoformat(timespec="seconds")
    start_commit = K.git(["rev-parse", "HEAD"], wt).strip()
    lane = {"feature": slug, "spec": f"docs/specs/{slug}.md", "stage": "build", "started": now, "created": now,
            "base": base, "branch": branch, "start_commit": start_commit, "budget": kit.get("budgets", {}).get("build", {})}
    (wt / ".claude" / "lane.json").write_text(json.dumps(lane, indent=2) + "\n")
    # progress skeleton from the spec's done-criteria
    sp = spec_path(wt, slug)
    rows = []
    dc = K.parse_sections(K.strip_html_comments(K.read_lines(sp))).get("done-criteria")
    if dc:
        for _, cells in dc.table_rows():
            if len(cells) >= 3:
                rows.append(f"| {cells[0]} | {cells[1]} | {cells[2]} | — | — |")
    prog = (wt / "docs" / "specs" / f"{slug}.progress.md")
    prog.write_text(
        f"# Progress: {slug}\n\n- Spec: `docs/specs/{slug}.md`\n- Worktree: `{wt}`\n- Branch: `{branch}`\n- Started: {now}\n- Last update: {now}\n\n"
        "## Done-criteria\n\n| # | Criterion | Test | Red run | Green run |\n|---|---|---|---|---|\n" + "\n".join(rows) +
        "\n\n## Current step\n\nreading the spec's files\n\n## Uncertainties\n\n- none\n\n## Escalation\n\n- Attempts: {{n}} of 3\n- Failure: {{what fails}}\n- Tried: {{what each attempt changed}}\n- Needs: {{decision or information}}\n")
    roadmap_set(wt, slug, "building", lane=str(wt.relative_to(root.parent)))
    # register the lane in the main checkout's kit.json (not committed by the lane)
    kj = root / ".claude" / "kit.json"
    if kj.is_file():
        data = json.loads(kj.read_text())
        data.setdefault("lanes", {})[slug] = {"worktree": str(wt), "branch": branch, "started": now, "start_commit": start_commit}
        kj.write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps({"worktree": str(wt), "branch": branch, "spec": lane["spec"], "progress": str(prog.relative_to(wt))}))
    return 0


def set_stage(root: Path, slug: str, stage: str) -> int:
    wt = lanes_dir(root) / slug
    lf = wt / ".claude" / "lane.json"
    if not lf.is_file():
        return refuse([f"no lane.json at {lf}"])
    data = json.loads(lf.read_text())
    data["stage"] = stage
    data["started"] = dt.datetime.now().isoformat(timespec="seconds")
    data["budget"] = K.load_kit_json(root).get("budgets", {}).get(stage, {})
    lf.write_text(json.dumps(data, indent=2) + "\n")
    print(f"lane {slug}: stage {stage}")
    return 0


def finish(root: Path, slug: str) -> int:
    wt = lanes_dir(root) / slug
    msgs = []
    if wt.exists():
        try:
            K.git(["worktree", "remove", "--force", str(wt)], root)
            msgs.append(f"removed worktree {wt}")
        except subprocess.CalledProcessError as e:
            return refuse([f"worktree remove failed: {e.stderr}"])
    try:
        K.git(["branch", "-D", f"wt/{slug}"], root)
        msgs.append(f"deleted branch wt/{slug}")
    except subprocess.CalledProcessError:
        pass
    kj = root / ".claude" / "kit.json"
    if kj.is_file():
        data = json.loads(kj.read_text())
        data.get("lanes", {}).pop(slug, None)
        kj.write_text(json.dumps(data, indent=2) + "\n")
    roadmap_set(root, slug, "merged", lane="—")
    print("\n".join(msgs) or "nothing to clean")
    return 0


# ---------------------------------------------------------------- unknown budget

MAX_UNKNOWNS = 3


def unknowns(root: Path, spec_or_draft: Path) -> dict:
    """Count [unknown] tags in a draft spec and decide: none -> proceed; 1..3 -> resolve each (a researcher per item,
    method required); over 3 -> research insufficient, back to /research. Open questions count as unknowns."""
    if not spec_or_draft.is_file():
        return {"count": 0, "decision": "missing", "items": [], "error": f"{spec_or_draft} not found"}
    lines = K.strip_html_comments(K.read_lines(spec_or_draft))
    items = []
    for n, t in enumerate(lines, start=1):
        if K.TAG_UNKNOWN.search(t):
            m = re.search(r"resolve by:\s*(.+)$", t, re.IGNORECASE)
            items.append({"line": n, "text": t.strip()[:160], "method": m.group(1).strip() if m else None})
    oq = K.parse_sections(lines).get("open questions")
    if oq:
        for n, t in oq.bullets():
            body = t.strip()[2:].strip()
            if body.lower() not in {"none", "none."} and not K.TAG_UNKNOWN.search(t):
                items.append({"line": n, "text": body[:160], "method": None})
    count = len(items)
    if count == 0:
        decision = "none"
    elif count > MAX_UNKNOWNS:
        decision = "research"
    else:
        decision = "resolve"
    missing_method = [i for i in items if not i["method"]]
    return {"count": count, "max": MAX_UNKNOWNS, "decision": decision, "items": items,
            "missing_method": len(missing_method),
            "message": {"none": "no unknowns; proceed to critique",
                        "resolve": f"{count} unknown(s): spawn one researcher per item with its method, fold answers in, re-run",
                        "research": f"{count} unknowns > {MAX_UNKNOWNS}: research insufficient; stop planning and run /research"}[decision]}


# ---------------------------------------------------------------- orchestration: what comes next, from facts

STAGES = ["start", "research", "plan", "approve", "lane", "test", "build", "review", "wait-merge", "retro", "done"]


def goal_status(root: Path, slug: str) -> str | None:
    p = root / "docs" / "goals" / f"{slug}.md"
    if not p.is_file():
        return None
    h = K.header_fields(K.strip_html_comments(K.read_lines(p)))
    return h.get("status", (0, ""))[1].lower() or "agreed"


def next_step(root: Path, slug: str) -> dict:
    """Decide the next stage for a feature from files and git only. Used by /run; never from an agent's claim."""
    import kit_status as KS
    kit = K.load_kit_json(root)
    rows = {r["slug"]: r for r in roadmap_rows(root)}
    row = rows.get(slug)
    g = goal_status(root, slug)
    if g is None:
        return {"slug": slug, "stage": "start", "reason": "no agreed goal file; run /start"}
    if g == "done":
        return {"slug": slug, "stage": "done", "reason": "goal file says done"}
    if row is None:
        return {"slug": slug, "stage": "start", "reason": "goal exists but no ROADMAP row; /start adds it"}
    st = KS.lane_state(root, row, kit)
    pos = st["position"]
    sp = spec_path(root, slug)
    research = [r for r in index_rows(root) if r["status"] == "current" and (slug in r["slug"] or slug.replace("-", " ") in r["question"].lower() or slug in r["keywords"])]
    if pos == "merged":
        return {"slug": slug, "stage": "retro" if g != "done" else "done", "reason": "merged in git; retro not yet run (goal not done)"}
    if pos == "escalated":
        return {"slug": slug, "stage": "escalated", "reason": st["progress"].get("failure") or "escalation written", "needs_human": True}
    if pos == "ready-to-merge":
        return {"slug": slug, "stage": "wait-merge", "reason": "review PASS for HEAD; human merges", "needs_human": True, "pr": st.get("pr")}
    if pos == "in-review":
        return {"slug": slug, "stage": "review", "reason": "lane built or review stale; run reviewer"}
    if pos == "building":
        prog = st["progress"]
        if prog["criteria"] and prog["red"] < prog["criteria"]:
            return {"slug": slug, "stage": "test", "reason": f"{prog['red']}/{prog['criteria']} criteria have a red run; tester first"}
        if prog["criteria"] and prog["green"] == prog["criteria"]:
            return {"slug": slug, "stage": "review", "reason": "all criteria green; review"}
        return {"slug": slug, "stage": "build", "reason": f"{prog['green']}/{prog['criteria']} green"}
    if pos == "approved":
        return {"slug": slug, "stage": "lane", "reason": "approved spec, no worktree yet"}
    if pos == "waiting-approval":
        return {"slug": slug, "stage": "approve", "reason": "spec waits for the human", "needs_human": True}
    if sp.is_file():
        return {"slug": slug, "stage": "plan", "reason": "spec draft exists but is not waiting-approval; finish planning"}
    if research:
        return {"slug": slug, "stage": "plan", "reason": f"{len(research)} research file(s) indexed; no spec"}
    return {"slug": slug, "stage": "research", "reason": "no research indexed for this feature"}


def next_in_queue(root: Path) -> dict:
    """The next queued feature with an agreed goal, if WIP allows."""
    n, limit, lanes = wip(root)
    if n >= limit:
        return {"slug": None, "reason": f"WIP {n}/{limit} reached", "in_flight": lanes}
    p = root / "ROADMAP.md"
    queue: list[str] = []
    if p.is_file():
        sec = K.parse_sections(K.strip_html_comments(K.read_lines(p))).get("queue")
        if sec:
            for _, t in sec.lines:
                m = re.match(r"^\s*\d+\.\s*([A-Za-z0-9._-]+)", t)
                if m:
                    queue.append(m.group(1))
    rows = {r["slug"]: r for r in roadmap_rows(root)}
    for slug in queue:
        row = rows.get(slug)
        if row and row["status"] in ("queued", "researching", "planning") and goal_status(root, slug) == "agreed":
            return {"slug": slug, "reason": "next in queue with an agreed goal", "in_flight": lanes}
    return {"slug": None, "reason": "queue has no item with an agreed goal (run /start)", "in_flight": lanes}


# ---------------------------------------------------------------- incidents

def record_incident(root: Path, what: str, slug: str | None, pr: str | None) -> Path:
    d = root / "docs" / "incidents"
    d.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()
    n = len(list(d.glob(f"{today}-*.md"))) + 1
    path = d / f"{today}-{n}.md"
    tmpl = (Path(__file__).resolve().parents[1] / "templates" / "incident.md").read_text()
    text = (tmpl.replace("{{short title}}", what[:80]).replace("{{date}}-{{n}}", f"{today}-{n}").replace("{{date}}", today)
            .replace("{{slug or unknown}}", slug or "unknown").replace("{{url or unknown}}", pr or "unknown").replace("{{open|lesson-written}}", "open")
            .replace("{{one paragraph, observable facts}}", what))
    path.write_text(text)
    return path


# ---------------------------------------------------------------- research index

def index_rows(root: Path) -> list[dict]:
    p = root / "docs" / "research" / "INDEX.md"
    if not p.is_file():
        return []
    rows = []
    for line in p.read_text().splitlines():
        if line.startswith("|") and not re.match(r"^\|\s*-{2,}", line) and "Question" not in line.split("|")[1]:
            c = [x.strip() for x in line.strip().strip("|").split("|")]
            if len(c) >= 7:
                rows.append({"question": c[0], "slug": c[1], "keywords": c[2], "files": c[3], "commit": c[4], "date": c[5], "status": c[6]})
    return rows


def words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if len(w) > 2 and w not in {"the", "and", "how", "does", "what", "with", "for", "are", "our", "this", "that"}}


def files_changed_since(root: Path, commit: str, files: list[str]) -> list[str]:
    if not commit or commit in ("—", "-"):
        return files
    try:
        changed = set(K.git(["diff", "--name-only", f"{commit}..HEAD"], root).split())
    except subprocess.CalledProcessError:
        return files
    return [f for f in files if f in changed]


def index_lookup(root: Path, question: str) -> dict:
    q = words(question)
    best, score = None, 0.0
    for r in index_rows(root):
        rw = words(r["question"]) | words(r["keywords"])
        if not rw:
            continue
        s = len(q & rw) / max(1, len(q | rw))
        if s > score:
            best, score = r, s
    if not best or score < 0.5:
        return {"decision": "new", "score": round(score, 2), "match": best}
    cited = [f for f in re.split(r"[,\s]+", best["files"]) if f and f not in ("—", "-", "none")]
    stale = files_changed_since(root, best["commit"], cited)
    if best["status"] == "superseded":
        return {"decision": "new", "score": round(score, 2), "match": best, "why": "superseded"}
    if stale:
        return {"decision": "reverify", "score": round(score, 2), "match": best, "stale_files": stale}
    return {"decision": "reuse", "score": round(score, 2), "match": best}


def index_add(root: Path, question: str, slug: str, keywords: str, files: str, commit: str) -> int:
    p = root / "docs" / "research" / "INDEX.md"
    if not p.is_file():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text((Path(__file__).resolve().parents[1] / "templates" / "index.md").read_text())
    row = f"| {question} | {slug} | {keywords} | {files} | {commit} | {dt.date.today().isoformat()} | current |"
    lines = p.read_text().rstrip("\n").splitlines()
    lines = [l if not (l.startswith("|") and f"| {slug} |" in l) else l.replace("| current |", "| superseded |") for l in lines]
    lines.append(row)
    p.write_text("\n".join(lines) + "\n")
    print(f"index: added {slug}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("precheck", "start", "finish"):
        s = sub.add_parser(name); s.add_argument("slug"); s.add_argument("--repo", default=".")
        if name == "start":
            s.add_argument("--base")
    s = sub.add_parser("stage"); s.add_argument("slug"); s.add_argument("stage", choices=["research", "plan", "test", "build", "review"]); s.add_argument("--repo", default=".")
    s = sub.add_parser("merged"); s.add_argument("slug"); s.add_argument("--repo", default="."); s.add_argument("--pr")
    s = sub.add_parser("next-step"); s.add_argument("slug"); s.add_argument("--repo", default=".")
    s = sub.add_parser("next"); s.add_argument("--repo", default=".")
    s = sub.add_parser("goal-set"); s.add_argument("slug"); s.add_argument("status", choices=["agreed", "running", "done"]); s.add_argument("--repo", default=".")
    s = sub.add_parser("incident"); s.add_argument("--repo", default="."); s.add_argument("--what", required=True); s.add_argument("--slug"); s.add_argument("--pr")
    s = sub.add_parser("wip"); s.add_argument("--repo", default=".")
    s = sub.add_parser("unknowns"); s.add_argument("spec"); s.add_argument("--repo", default="."); s.add_argument("--json", action="store_true")
    s = sub.add_parser("roadmap-set"); s.add_argument("slug"); s.add_argument("status"); s.add_argument("--repo", default="."); s.add_argument("--pr"); s.add_argument("--spec")
    s = sub.add_parser("index"); s.add_argument("action", choices=["lookup", "add"]); s.add_argument("question", nargs="?"); s.add_argument("--repo", default=".")
    s.add_argument("--json", action="store_true"); s.add_argument("--slug"); s.add_argument("--keywords", default=""); s.add_argument("--files", default=""); s.add_argument("--commit", default="")
    a = ap.parse_args(argv)
    root = Path(a.repo).resolve()
    if a.cmd == "precheck":
        p = precheck(root, a.slug)
        if p:
            return refuse(p)
        print(f"lane {a.slug}: ready to start")
        return 0
    if a.cmd == "start":
        return start(root, a.slug, a.base)
    if a.cmd == "stage":
        return set_stage(root, a.slug, a.stage)
    if a.cmd == "finish":
        return finish(root, a.slug)
    if a.cmd == "next-step":
        print(json.dumps(next_step(root, a.slug)))
        return 0
    if a.cmd == "next":
        res = next_in_queue(root)
        print(json.dumps(res))
        return 0 if res["slug"] else 2
    if a.cmd == "goal-set":
        p = root / "docs" / "goals" / f"{a.slug}.md"
        if not p.is_file():
            return refuse([f"no goal file {p.relative_to(root)}"])
        text = re.sub(r"^- Status:.*$", f"- Status: {a.status}", p.read_text(), count=1, flags=re.M)
        p.write_text(text)
        print(f"goal {a.slug}: {a.status}")
        return 0
    if a.cmd == "incident":
        p = record_incident(root, a.what, a.slug, a.pr)
        print(str(p.relative_to(root)))
        return 0
    if a.cmd == "merged":
        # Verify in git before writing the word: refuse to mark a lane merged that is not an ancestor of base.
        kit = K.load_kit_json(root); base = kit.get("default_branch", "main")
        tip = ""
        try:
            tip = K.git(["rev-parse", "--verify", "--quiet", f"wt/{a.slug}"], root).strip()
        except subprocess.CalledProcessError:
            pass
        start_c = (kit.get("lanes", {}).get(a.slug) or {}).get("start_commit")
        if tip and (tip == start_c or subprocess.run(["git", "merge-base", "--is-ancestor", tip, base], cwd=root, capture_output=True).returncode != 0):
            return refuse([f"wt/{a.slug} is not merged into {base} yet (no lane commits in {base})"])
        cols = {"pr": a.pr} if a.pr else {}
        ok = roadmap_set(root, a.slug, "merged", lane="—", **cols)
        print(f"lane {a.slug}: marked merged" if ok else f"lane {a.slug}: no ROADMAP row")
        return 0 if ok else 2
    if a.cmd == "unknowns":
        res = unknowns(root, Path(a.spec) if Path(a.spec).is_absolute() else root / a.spec)
        print(json.dumps(res, indent=2) if a.json else res["message"])
        return {"none": 0, "resolve": 3, "research": 2, "missing": 1}[res["decision"]]
    if a.cmd == "wip":
        n, limit, lanes = wip(root)
        print(json.dumps({"in_flight": n, "limit": limit, "lanes": lanes}))
        return 0 if n < limit else 2
    if a.cmd == "roadmap-set":
        cols = {k: v for k, v in (("pr", a.pr), ("spec", a.spec)) if v}
        ok = roadmap_set(root, a.slug, a.status, **cols)
        return 0 if ok else refuse([f"no ROADMAP row for {a.slug}"])
    if a.cmd == "index":
        if a.action == "lookup":
            res = index_lookup(root, a.question or "")
            print(json.dumps(res) if a.json else f"{res['decision']} (score {res['score']})" + (f": {res['match']['slug']}" if res.get("match") else ""))
            return 0
        return index_add(root, a.question or "", a.slug, a.keywords, a.files, a.commit)
    return 1


if __name__ == "__main__":
    sys.exit(main())
