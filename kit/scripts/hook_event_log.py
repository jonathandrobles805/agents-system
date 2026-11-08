#!/usr/bin/env python3
"""PostToolUse / PostToolUseFailure / SubagentStart / SubagentStop on every tool: append one event line.
The dashboard reads this file. Agents never write it. Exit 0 always."""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K

EVENT_BY_TOOL = {"Read": "read", "NotebookRead": "read", "Edit": "edit", "MultiEdit": "edit", "NotebookEdit": "edit", "Write": "write",
                 "Bash": "bash", "Grep": "search", "Glob": "search", "WebFetch": "web", "WebSearch": "web", "Agent": "subagent", "Task": "subagent"}


def first_line(x) -> str:
    if x is None:
        return ""
    if isinstance(x, dict):
        for k in ("stdout", "output", "content", "result", "error", "message"):
            if k in x and isinstance(x[k], str):
                return x[k].strip().splitlines()[0][:200] if x[k].strip() else ""
        return str(x)[:200]
    s = str(x).strip()
    return s.splitlines()[0][:200] if s else ""


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cwd = Path(d.get("cwd") or ".")
    lane = K.find_lane(cwd)
    root = lane.root if lane else K.project_root(cwd)
    path = lane.events_path if lane else root / ".claude" / "session" / "events.jsonl"
    ev = d.get("hook_event_name", "")
    tool = d.get("tool_name", "")
    ti = d.get("tool_input") or {}
    e: dict = {"session_id": d.get("session_id"), "lane": lane.slug if lane else None, "hook": ev, "tool": tool}
    if ev in ("SubagentStart", "SubagentStop"):
        e["event"] = "subagent_start" if ev == "SubagentStart" else "subagent_stop"
        e["agent"] = d.get("agent_type") or d.get("agent_name")
    else:
        e["event"] = EVENT_BY_TOOL.get(tool, "tool")
        fp = ti.get("file_path") or ti.get("notebook_path")
        if fp:
            e["path"] = K.rel_to(root, (cwd / fp) if not Path(fp).is_absolute() else fp)
        if tool == "Bash":
            e["command"] = (ti.get("command") or "")[:300]
        if tool in ("Grep", "Glob"):
            e["pattern"] = ti.get("pattern")
        e["result"] = "fail" if ev == "PostToolUseFailure" else "ok"
        e["summary"] = first_line(d.get("tool_response") or d.get("error"))
    K.append_event(path, e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
