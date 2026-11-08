#!/usr/bin/env python3
"""PostToolUse on Read (and Bash file reads): record which files this session has read.
guard-edit consults this log. Exit 0 always; never blocks."""
from __future__ import annotations
import re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K

READ_CMDS = re.compile(r"\b(cat|head|tail|less|more|bat)\s+(?:-[A-Za-z0-9]+\s+)*([^\s|;&><]+)")
SED_CMD = re.compile(r"\bsed\s+-n\s+\S+\s+([^\s|;&><]+)")


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cwd = Path(d.get("cwd") or ".")
    root = K.project_root(cwd)
    sid = d.get("session_id", "")
    tool = d.get("tool_name", "")
    ti = d.get("tool_input") or {}
    paths: list[str] = []
    if tool in ("Read", "NotebookRead"):
        fp = ti.get("file_path") or ti.get("notebook_path")
        if fp:
            paths.append(fp)
    elif tool == "Bash":
        cmd = ti.get("command", "")
        for m in READ_CMDS.finditer(cmd):
            paths.append(m.group(2))
        for m in SED_CMD.finditer(cmd):
            paths.append(m.group(1))
    for p in paths:
        p = p.strip("'\"")
        if p.startswith("-"):
            continue
        rel = K.rel_to(root, (cwd / p) if not Path(p).is_absolute() else p)
        K.record_read(root, sid, rel)
    return 0


if __name__ == "__main__":
    sys.exit(main())
