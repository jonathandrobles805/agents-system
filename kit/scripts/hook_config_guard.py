#!/usr/bin/env python3
"""ConfigChange hook: block changes to project settings while a lane is active. Exit 2 blocks."""
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
    lane = K.find_lane(cwd)
    source = d.get("source") or d.get("config_type") or d.get("matcher") or ""
    if lane and source in ("project_settings", "local_settings", ""):
        K.append_event(lane.events_path, {"event": "blocked", "tool": "ConfigChange", "result": "blocked", "summary": f"settings change during lane ({source or 'unknown source'})"})
        return K.block("config-guard: settings cannot change while a lane is active. Finish or escalate the lane, then change settings by hand.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
