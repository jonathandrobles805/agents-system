#!/usr/bin/env python3
"""kit-status: derive the state of a project from files and git. Nothing here comes from an agent's summary.

  kit_status.py --repo R [--json] [--out status.json]
  kit_status.py --all [--json]            every project listed in ~/.claude/kit/projects.json

Lane position rules (first match wins):
  merged            ROADMAP status merged
  escalated         progress.md Escalation filled (Attempts/Failure without placeholders)
  ready-to-merge    review report exists, validates, Verdict PASS, Head matches lane HEAD
  in-review         review report exists (any verdict) or lane stage == review
  building          worktree exists with lane.json
  waiting-approval  spec exists, no approval line
  planning          spec exists with status draft, or ROADMAP says planning
  researching       research INDEX has a row whose slug/keywords match the feature, no spec
  queued            otherwise
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K  # noqa: E402
import lane as L  # noqa: E402
import validate_docs as V  # noqa: E402


def git_or(args: list[str], cwd: Path, default: str = "") -> str:
    try:
        return K.git(args, cwd).strip()
    except Exception:
        return default


def last_event(events: Path, kinds: set[str]) -> dict | None:
    if not events.is_file():
        return None
    last = None
    for line in events.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("event") in kinds:
            last = e
    return last


def events_summary(events: Path) -> dict:
    out = {"total": 0, "blocked": 0, "tests_red": 0, "tests_green": 0, "stop_refused": 0, "last_ts": None}
    if not events.is_file():
        return out
    for line in events.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        out["total"] += 1
        out["last_ts"] = e.get("ts") or out["last_ts"]
        ev = e.get("event")
        if ev == "blocked":
            out["blocked"] += 1
        elif ev == "test":
            out["tests_red" if e.get("result") == "fail" else "tests_green"] += 1
        elif ev == "stop_refused":
            out["stop_refused"] += 1
    return out


def progress_info(prog: Path) -> dict:
    info = {"exists": prog.is_file(), "criteria": 0, "green": 0, "red": 0, "escalated": False, "attempts": None, "current_step": None, "failure": None}
    if not prog.is_file():
        return info
    lines = K.strip_html_comments(K.read_lines(prog))
    secs = K.parse_sections(lines)
    dc = secs.get("done-criteria")
    if dc:
        for _, cells in dc.table_rows():
            if len(cells) >= 5:
                info["criteria"] += 1
                if "#" in cells[3]:
                    info["red"] += 1
                if "#" in cells[4]:
                    info["green"] += 1
    cs = secs.get("current step")
    if cs:
        info["current_step"] = cs.text().strip().splitlines()[0][:120] if cs.text().strip() else None
    esc = secs.get("escalation")
    if esc:
        t = esc.text()
        att = re.search(r"^- Attempts:\s*(\S.*)$", t, re.M)
        fail = re.search(r"^- Failure:\s*(\S.*)$", t, re.M)
        if att and fail and "{{" not in att.group(1) and "{{" not in fail.group(1):
            info["escalated"] = True
            info["attempts"] = att.group(1).strip()
            info["failure"] = fail.group(1).strip()[:200]
    return info


def review_info(root: Path, rep: Path, lane_head: str | None) -> dict:
    info = {"exists": rep.is_file(), "valid": None, "verdict": None, "head_matches": None, "fails": 0}
    if not rep.is_file():
        return info
    v = V.Validator(root, None, K.load_kit_json(root))
    v.run(rep, "review")
    info["valid"] = not v.v
    text = rep.read_text()
    m = re.search(r"^## Verdict\s*\n+\s*(PASS|FAIL)", text, re.M)
    info["verdict"] = m.group(1) if m else None
    info["fails"] = len(re.findall(r"^\|\s*R\d+\s*\|[^|]*\|\s*FAIL\s*\|", text, re.M))
    h = re.search(r"^- Head:\s*([0-9a-f]{7,40})", text, re.M)
    if h and lane_head:
        info["head_matches"] = K.review_head_ok(root, h.group(1))
    return info


def lane_state(root: Path, row: dict, kit: dict) -> dict:
    slug = row["slug"]
    spec = root / "docs" / "specs" / f"{slug}.md"
    lanes = kit.get("lanes", {})
    wt = Path(lanes[slug]["worktree"]) if slug in lanes else L.lanes_dir(root) / slug
    has_wt = (wt / ".claude" / "lane.json").is_file()
    base = kit.get("default_branch", "main")
    lane_json = json.loads((wt / ".claude" / "lane.json").read_text()) if has_wt else {}
    docs_root = wt if has_wt else root
    prog = progress_info(docs_root / "docs" / "specs" / f"{slug}.progress.md")
    head = git_or(["rev-parse", "HEAD"], wt) if has_wt else None
    rev = review_info(docs_root, docs_root / "docs" / "specs" / f"{slug}.review.md", head)
    ev = events_summary(docs_root / "docs" / "specs" / f"{slug}.events.jsonl")
    spec_hdr = L.spec_header(spec) if spec.is_file() else {}
    approved = bool(spec.is_file() and re.search(r"Approved by:\s*(?!—)\S.*\s+on\s+\d{4}-\d{2}-\d{2}\s+at\s+[0-9a-f]{7,40}", spec.read_text()))
    behind = ahead = None
    if has_wt:
        counts = git_or(["rev-list", "--left-right", "--count", f"{base}...HEAD"], wt)
        if counts:
            behind, ahead = (int(x) for x in counts.split())
    # position
    if row["status"] == "merged":
        pos = "merged"
    elif prog["escalated"]:
        pos = "escalated"
    elif rev["exists"] and rev["valid"] and rev["verdict"] == "PASS" and rev["head_matches"]:
        pos = "ready-to-merge"
    elif rev["exists"] or lane_json.get("stage") == "review":
        pos = "in-review"
    elif has_wt:
        pos = "building"
    elif spec.is_file() and not approved:
        pos = "waiting-approval"
    elif spec.is_file() and approved:
        pos = "approved"
    elif row["status"] in ("planning", "researching"):
        pos = row["status"]
    else:
        pos = "queued"
    needs_you = pos in ("waiting-approval", "ready-to-merge", "escalated")
    last_check = last_event(docs_root / "docs" / "specs" / f"{slug}.events.jsonl", {"test", "typecheck", "lint"})
    return {
        "feature": row["feature"], "slug": slug, "milestone": row["milestone"], "roadmap_status": row["status"], "position": pos, "needs_you": needs_you,
        "risk": spec_hdr.get("risk"), "spec": str(spec.relative_to(root)) if spec.is_file() else None, "approved": approved,
        "worktree": str(wt) if has_wt else None, "branch": lane_json.get("branch"), "stage": lane_json.get("stage"), "started": lane_json.get("started"),
        "behind_base": behind, "ahead_base": ahead, "head": head[:10] if head else None,
        "progress": prog, "review": rev, "events": ev,
        "last_check": {"kind": last_check.get("event"), "result": last_check.get("result"), "summary": last_check.get("summary"), "ts": last_check.get("ts")} if last_check else None,
        "pr": row.get("pr") if row.get("pr") not in ("—", "-", "") else None,
    }


def text_only_debt(root: Path) -> int:
    p = root / "LESSONS.md"
    if not p.is_file():
        return 0
    sec = K.parse_sections(K.strip_html_comments(K.read_lines(p))).get("debt")
    if not sec:
        return 0
    return len([b for _, b in sec.bullets() if b.strip()[2:].strip().lower() not in {"none", "none."}])


def research_index_summary(root: Path) -> dict:
    rows = L.index_rows(root)
    stale = 0
    for r in rows:
        cited = [f for f in re.split(r"[,\s]+", r["files"]) if f and f not in ("—", "-", "none")]
        if r["status"] == "current" and L.files_changed_since(root, r["commit"], cited):
            stale += 1
    return {"questions": len(rows), "current": sum(1 for r in rows if r["status"] == "current"), "stale": stale}


def project_status(root: Path) -> dict:
    kit = K.load_kit_json(root)
    rows = L.roadmap_rows(root)
    lanes = [lane_state(root, r, kit) for r in rows]
    in_flight = [l for l in lanes if l["position"] in L.IN_FLIGHT or l["position"] == "in-review"]
    ci = None
    if os.environ.get("KIT_STATUS_NO_GH") is None and (root / ".github").is_dir():
        try:
            out = subprocess.run(["gh", "run", "list", "--branch", kit.get("default_branch", "main"), "--limit", "1", "--json", "conclusion,status,createdAt"],
                                 cwd=root, capture_output=True, text=True, timeout=20)
            if out.returncode == 0 and out.stdout.strip():
                runs = json.loads(out.stdout)
                ci = runs[0] if runs else None
        except Exception:
            ci = None
    claude_md = root / "CLAUDE.md"
    return {
        "project": kit.get("project", root.name), "root": str(root), "kit_version": kit.get("kit_version"), "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "wip": {"in_flight": len(in_flight), "limit": kit.get("wip_limit", 2)},
        "needs_you": [{"slug": l["slug"], "position": l["position"], "failure": l["progress"].get("failure")} for l in lanes if l["needs_you"]],
        "lanes": lanes,
        "ci_main": ci,
        "debt": {"text_only_lessons": text_only_debt(root), "claude_md_bytes": len(claude_md.read_bytes()) if claude_md.is_file() else 0, "claude_md_cap": kit.get("claude_md_cap_bytes", 4000),
                 "bootstrap_todos": sum(f.read_text().count("TODO(bootstrap") for f in (root / "ROADMAP.md", root / "ARCHITECTURE.md", root / "DESIGN.md", claude_md) if f.is_file())},
        "research": research_index_summary(root),
    }


def render(s: dict) -> str:
    out = [f"{s['project']} · kit {s['kit_version']} · WIP {s['wip']['in_flight']}/{s['wip']['limit']}"]
    if s["needs_you"]:
        out.append("needs you:")
        for n in s["needs_you"]:
            out.append(f"  - {n['slug']}: {n['position']}" + (f" — {n['failure']}" if n.get("failure") else ""))
    else:
        out.append("needs you: nothing")
    out.append("lanes:")
    for l in s["lanes"]:
        if l["position"] in ("queued", "merged"):
            continue
        p = l["progress"]
        extra = []
        if l["worktree"]:
            extra.append(f"{l['behind_base']} behind {('/' + str(l['ahead_base']) + ' ahead') if l['ahead_base'] is not None else ''}".strip())
        if p["criteria"]:
            extra.append(f"criteria {p['green']}/{p['criteria']} green")
        if l["last_check"]:
            extra.append(f"last {l['last_check']['kind']}: {l['last_check']['result']} ({l['last_check']['summary']})")
        if l["events"]["blocked"]:
            extra.append(f"{l['events']['blocked']} blocked")
        out.append(f"  - {l['slug']}: {l['position']}" + (f"  [{'; '.join(extra)}]" if extra else ""))
    q = [l["slug"] for l in s["lanes"] if l["position"] == "queued"]
    if q:
        out.append(f"queued: {', '.join(q)}")
    d = s["debt"]
    out.append(f"debt: {d['text_only_lessons']} text-only lesson(s) · CLAUDE.md {d['claude_md_bytes']}/{d['claude_md_cap']} B · {d['bootstrap_todos']} bootstrap TODO(s)")
    r = s["research"]
    out.append(f"research: {r['questions']} question(s), {r['stale']} stale")
    if s["ci_main"]:
        out.append(f"CI on main: {s['ci_main'].get('conclusion') or s['ci_main'].get('status')}")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out", help="also write status.json here")
    a = ap.parse_args(argv)
    if a.all:
        reg = Path(os.environ.get("CLAUDE_HOME", Path.home() / ".claude")) / "kit" / "projects.json"
        projects = json.loads(reg.read_text()) if reg.is_file() else []
        results = [project_status(Path(p).expanduser().resolve()) for p in projects if Path(p).expanduser().is_dir()]
        if a.json:
            print(json.dumps(results, indent=2))
        else:
            for s in results:
                print(f"{s['project']}: {len(s['needs_you'])} waiting on you · {s['wip']['in_flight']}/{s['wip']['limit']} lanes · debt {s['debt']['text_only_lessons']}")
        if a.out:
            Path(a.out).write_text(json.dumps(results, indent=2))
        return 0
    s = project_status(Path(a.repo).resolve())
    if a.out:
        Path(a.out).write_text(json.dumps(s, indent=2))
    print(json.dumps(s, indent=2) if a.json else render(s))
    return 0


if __name__ == "__main__":
    sys.exit(main())
