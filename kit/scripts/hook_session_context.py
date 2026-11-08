#!/usr/bin/env python3
"""SessionStart (compact|resume): re-inject the lane's spec summary, progress, and LESSONS debt so a compacted
or resumed session does not lose the rules. Prints plain text to stdout (added to Claude's context). Exit 0."""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K


def section(path: Path, title: str, max_lines: int = 40) -> str:
    if not path.is_file():
        return ""
    lines = K.strip_html_comments(K.read_lines(path))
    secs = K.parse_sections(lines)
    sec = secs.get(title.lower())
    if not sec:
        return ""
    body = [t for _, t in sec.lines][:max_lines]
    return f"## {title}\n" + "\n".join(body).strip()


def main() -> int:
    d = K.read_hook_input()
    cwd = Path((d or {}).get("cwd") or ".")
    lane = K.find_lane(cwd)
    root = lane.root if lane else K.project_root(cwd)
    out = []
    lessons = root / "LESSONS.md"
    debt = section(lessons, "Debt", 20)
    if debt:
        out.append("# Kit context restored after compaction/resume\n\n# Rules not yet enforced by a check (from LESSONS.md)\n" + debt)
    if lane:
        out.append(f"# Active lane: {lane.slug}\nSpec: {K.rel_to(root, lane.spec_path)}\n")
        out.append(section(lane.spec_path, "Summary"))
        out.append(section(lane.spec_path, "Files to change"))
        out.append(section(lane.spec_path, "Done-criteria"))
        out.append(section(lane.progress_path, "Current step"))
        out.append(section(lane.progress_path, "Escalation", 12))
        out.append("Reminder: edits are limited to the spec's files; every file must be read in this session before editing; tests before code; stop only when every criterion has a red and a green run or Escalation is filled.")
    text = "\n\n".join(x for x in out if x)
    if text:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
