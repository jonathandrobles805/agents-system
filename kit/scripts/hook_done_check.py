#!/usr/bin/env python3
"""Stop hook inside a lane: refuse to end the turn while done-criteria lack a green run and no escalation is written.
Allows the stop when: every done-criterion row in progress.md has a green run ref that exists in the log,
or the Escalation section is filled in, or stop_hook_active is set (we already asked once).
"""
from __future__ import annotations
import re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K


def main() -> int:
    d = K.read_hook_input()
    if not d or d.get("stop_hook_active"):
        return 0
    cwd = Path(d.get("cwd") or ".")
    lane = K.find_lane(cwd)
    if not lane or lane.data.get("stage", "build") != "build":
        return 0
    prog = lane.progress_path
    if not prog.is_file():
        return K.feedback_block(f"done-check: {K.rel_to(lane.root, prog)} does not exist. Create it from the progress template, fill the done-criteria table from the spec, then stop.")
    lines = K.strip_html_comments(K.read_lines(prog))
    sections = K.parse_sections(lines)
    esc = sections.get("escalation")
    if esc:
        t = esc.text()
        m = re.search(r"^- Attempts:\s*(\S.*)$", t, re.M)
        f = re.search(r"^- Failure:\s*(\S.*)$", t, re.M)
        if m and f and "{{" not in t and f.group(1).strip() not in {"", "—", "-"}:
            K.append_event(lane.events_path, {"event": "stop", "tool": "hook", "result": "ok", "summary": "stopped with escalation"})
            return 0
    dc = sections.get("done-criteria")
    rows = dc.table_rows() if dc else []
    if not rows:
        return K.feedback_block("done-check: progress.md has no done-criteria rows. Copy them from the spec before stopping.")
    log_lines = K.read_lines(lane.log_path) if lane.log_path.is_file() else []
    missing = []
    for n, cells in rows:
        if len(cells) < 5:
            missing.append(f"line {n}: row needs #, criterion, test, red run, green run")
            continue
        rid, red, green = cells[0], cells[3], cells[4]
        for label, ref in (("red", red), ("green", green)):
            m = re.search(r"#(\d+)", ref)
            if not m:
                missing.append(f"{rid}: no {label} run reference (expected {lane.log_path.name}#<line>)")
            elif int(m.group(1)) > len(log_lines):
                missing.append(f"{rid}: {label} run ref {ref} points past the end of {lane.log_path.name} ({len(log_lines)} lines)")
    if missing:
        K.append_event(lane.events_path, {"event": "stop_refused", "tool": "hook", "result": "fail", "summary": f"{len(missing)} criteria incomplete"})
        return K.feedback_block("done-check: not done.\n- " + "\n- ".join(missing) + "\nEither finish the criteria (each needs a red run and a green run in the log) or fill in the Escalation section, then stop.")
    K.append_event(lane.events_path, {"event": "stop", "tool": "hook", "result": "ok", "summary": "all done-criteria green"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
