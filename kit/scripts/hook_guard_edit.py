#!/usr/bin/env python3
"""PreToolUse on Edit|Write|MultiEdit|NotebookEdit.

Blocks (exit 2):
  - editing an existing file that this session has not read
  - in a lane: editing a file outside the spec's 'Files to change' + 'Files to create' lists
  - always: .claude/settings*, .claude/lane.json, .claude/kit.json, .claude/hooks/*, .github/workflows/*
  - in a lane: editing the spec itself (changes need re-approval) or any other spec
Outside a lane only the read-before-edit and always-blocked rules apply.
"""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cwd = Path(d.get("cwd") or ".")
    root = K.project_root(cwd)
    sid = d.get("session_id", "")
    ti = d.get("tool_input") or {}
    fp = ti.get("file_path") or ti.get("notebook_path")
    if not fp:
        return 0
    abs_path = Path(fp) if Path(fp).is_absolute() else (cwd / fp)
    rel = K.rel_to(root, abs_path)
    lane = K.find_lane(cwd)
    events = (lane.events_path if lane else root / ".claude" / "session" / "events.jsonl")

    def deny(reason: str) -> int:
        K.append_event(events, {"event": "blocked", "tool": d.get("tool_name"), "path": rel, "result": "blocked", "summary": reason.split("\n")[0]})
        return K.block(reason)

    if rel.startswith("/") or rel.startswith(".."):
        return deny(f"guard-edit: '{rel}' is outside the project root.")

    if K.glob_match(rel, K.ALWAYS_BLOCKED_EDIT):
        return deny(f"guard-edit: '{rel}' is kit configuration. Agents never edit it; change it through /bootstrap or by hand.")

    exists = abs_path.exists()

    if lane:
        read_first, change, create = K.spec_file_lists(lane.spec_path)
        allowed = change + create + lane.always_allowed()
        spec_rel = K.rel_to(root, lane.spec_path)
        if rel == spec_rel or (rel.startswith("docs/specs/") and rel.endswith(".md") and not rel.endswith(".progress.md") and rel != spec_rel and ".review." not in rel):
            if rel == spec_rel:
                return deny(f"guard-edit: '{rel}' is the approved spec. Changing it requires re-approval; write the needed change in progress.md under Escalation.")
            return deny(f"guard-edit: '{rel}' is another feature's spec. Lanes edit only their own files.")
        if not (change + create):
            return deny(f"guard-edit: lane '{lane.slug}' has no 'Files to change' list in {spec_rel}; nothing may be edited until the spec names its files.")
        if not K.glob_match(rel, allowed):
            return deny(
                f"guard-edit: '{rel}' is not in the spec's Files to change / Files to create.\n"
                f"Allowed: {', '.join(allowed)}\n"
                f"If this file must change, stop and record it under Escalation in progress.md; the spec needs amending and re-approval."
            )

    if exists and not K.was_read(root, sid, rel):
        return deny(f"guard-edit: '{rel}' has not been read in this session. Read the file first, then edit it.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
