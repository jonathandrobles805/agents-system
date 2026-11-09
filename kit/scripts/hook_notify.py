#!/usr/bin/env python3
"""Notification / Stop hook: tell the human something needs them. Desktop notification by default;
optional webhook from ~/.claude/kit-notify.json: {"webhook": "https://...", "desktop": true}. Exit 0 always."""
from __future__ import annotations
import json, os, platform, subprocess, sys, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K


def desktop(title: str, body: str) -> None:
    try:
        sysname = platform.system()
        if sysname == "Darwin":
            subprocess.run(["osascript", "-e", f'display notification "{body[:200]}" with title "{title}"'], timeout=5)
        elif sysname == "Linux":
            subprocess.run(["notify-send", title, body[:200]], timeout=5)
        elif sysname == "Windows":
            subprocess.run(["powershell", "-c", f"[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('{body[:200]}','{title}')"], timeout=5)
    except Exception:
        pass


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cwd = Path(d.get("cwd") or ".")
    lane = K.find_lane(cwd)
    ev = d.get("hook_event_name", "")
    cfg_path = Path(os.environ.get("CLAUDE_HOME", Path.home() / ".claude")) / "kit-notify.json"
    cfg = {}
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text())
        except json.JSONDecodeError:
            cfg = {}
    if ev == "Notification":
        title, body = "Claude needs you", d.get("message") or d.get("notification_type") or "waiting for input"
    elif ev == "Stop" and lane:
        prog = lane.progress_path.read_text() if lane.progress_path.is_file() else ""
        state = "escalated" if "- Attempts:" in prog and "{{" not in prog else "stopped"
        title, body = f"Lane {lane.slug}: {state}", "Check /status or the dashboard."
    else:
        return 0
    if cfg.get("desktop", True):
        desktop(title, body)
    if cfg.get("webhook"):
        try:
            req = urllib.request.Request(cfg["webhook"], data=json.dumps({"text": f"{title}: {body}"}).encode(), headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
