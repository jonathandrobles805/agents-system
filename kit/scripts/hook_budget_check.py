#!/usr/bin/env python3
"""PostToolUse on every tool inside a lane: enforce the lane's time and tool-call budget.
On exceed: write an Escalation into progress.md (if not present) and return a block decision.
lane.json: {"feature": "...", "stage": "build", "started": "<iso>", "budget": {"hours": 4, "tool_calls": 800}}
"""
from __future__ import annotations
import datetime as dt, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K

DEFAULT_BUDGET = {"research": {"hours": 1, "tool_calls": 200}, "plan": {"hours": 1, "tool_calls": 200},
                  "build": {"hours": 4, "tool_calls": 800}, "review": {"hours": 1, "tool_calls": 200}}


def ensure_escalation(progress: Path, reason: str) -> None:
    text = progress.read_text() if progress.is_file() else f"# Progress\n\n## Escalation\n"
    if re.search(r"^- Attempts:", text, re.M) and "budget" in text.lower():
        return
    block = f"\n## Escalation\n\n- Attempts: n/a of 3\n- Failure: {reason}\n- Tried: see events log\n- Needs: a human to raise the budget in the spec or split the feature\n"
    progress.parent.mkdir(parents=True, exist_ok=True)
    progress.write_text(text.rstrip() + "\n" + block)


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cwd = Path(d.get("cwd") or ".")
    lane = K.find_lane(cwd)
    if not lane:
        return 0
    stage = lane.data.get("stage", "build")
    budget = {**DEFAULT_BUDGET.get(stage, DEFAULT_BUDGET["build"]), **lane.data.get("budget", {})}
    sid = d.get("session_id", "s")
    counter = lane.root / K.SESSION_DIR / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', sid)}.calls"
    counter.parent.mkdir(parents=True, exist_ok=True)
    n = int(counter.read_text() or 0) + 1 if counter.is_file() else 1
    counter.write_text(str(n))
    started = lane.data.get("started")
    hours = 0.0
    if started:
        try:
            hours = (dt.datetime.now() - dt.datetime.fromisoformat(started)).total_seconds() / 3600
        except ValueError:
            pass
    over = []
    if n > int(budget.get("tool_calls", 10**9)):
        over.append(f"{n} tool calls > budget {budget['tool_calls']}")
    if hours > float(budget.get("hours", 10**9)):
        over.append(f"{hours:.1f}h elapsed > budget {budget['hours']}h")
    if not over:
        return 0
    reason = f"budget exceeded for stage '{stage}': " + "; ".join(over)
    ensure_escalation(lane.progress_path, reason)
    K.append_event(lane.events_path, {"event": "budget_exceeded", "tool": "hook", "result": "fail", "summary": reason})
    return K.feedback_block(reason + ".\nStop working. Make sure progress.md Escalation describes the state, then end the turn. A human will raise the budget or split the feature.")


if __name__ == "__main__":
    sys.exit(main())
