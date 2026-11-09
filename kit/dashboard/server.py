#!/usr/bin/env python3
"""Live dashboard server. Standard library only. Local use.

  python3 ~/.claude/kit/dashboard/server.py --repo PATH [--repo PATH ...] [--port 8765] [--no-open]
  python3 ~/.claude/kit/dashboard/server.py --all          projects from ~/.claude/kit-projects.json

Endpoints
  GET  /                      the dashboard page
  GET  /api/status            status for all served projects (kit_status.project_status), recomputed on change
  GET  /api/events/<slug>?project=NAME   the lane's events.jsonl as JSON (last 500)
  GET  /api/stream            Server-Sent Events: {"type":"status"} on any change, {"type":"event","lane":slug} per new event line
  POST /api/open/<slug>?project=NAME     open a terminal running `claude` in the lane worktree (localhost only)

Everything shown is read from files and git. The server never asks an agent anything.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import kit_status as KS  # noqa: E402
import kitlib as K  # noqa: E402
import lane as L  # noqa: E402

INDEX = HERE / "index.html"


class State:
    def __init__(self, repos: list[Path]):
        self.repos = repos
        self.lock = threading.Lock()
        self.status: list[dict] = []
        self.listeners: list[list] = []  # per-client queues (lists) of SSE messages
        self.event_offsets: dict[str, int] = {}
        self.fingerprint = ""

    def recompute(self) -> None:
        with self.lock:
            self.status = [KS.project_status(r) for r in self.repos]

    def project(self, name: str | None) -> dict | None:
        with self.lock:
            if not self.status:
                return None
            if name is None:
                return self.status[0]
            return next((s for s in self.status if s["project"] == name), None)

    def broadcast(self, msg: dict) -> None:
        data = json.dumps(msg)
        with self.lock:
            for q in self.listeners:
                q.append(data)


def watched_files(repos: list[Path]) -> list[Path]:
    files: list[Path] = []
    for r in repos:
        for rel in ("ROADMAP.md", "LESSONS.md", "CLAUDE.md", ".claude/kit.json"):
            files.append(r / rel)
        files += list((r / "docs" / "specs").glob("*")) if (r / "docs" / "specs").is_dir() else []
        files += list((r / "docs" / "research").glob("*.md")) if (r / "docs" / "research").is_dir() else []
        kit = K.load_kit_json(r)
        for slug, info in kit.get("lanes", {}).items():
            wt = Path(info.get("worktree", ""))
            if wt.is_dir():
                files += list((wt / "docs" / "specs").glob(f"{slug}*"))
                files.append(wt / ".claude" / "lane.json")
                files.append(wt / ".git")  # worktree HEAD pointer file
    return files


def fingerprint(files: list[Path]) -> str:
    parts = []
    for f in files:
        try:
            st = f.stat()
            parts.append(f"{f}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append(f"{f}:missing")
    return "|".join(parts)


def tail_events(path: Path, offset: int) -> tuple[list[dict], int]:
    if not path.is_file():
        return [], 0
    with path.open("rb") as f:
        f.seek(offset)
        chunk = f.read()
    out = []
    for line in chunk.decode("utf-8", errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out, offset + len(chunk)


def watcher(state: State, interval: float) -> None:
    # seed offsets so we stream only new events
    for s in state.status:
        for l in s["lanes"]:
            if l.get("worktree"):
                p = Path(l["worktree"]) / "docs" / "specs" / f"{l['slug']}.events.jsonl"
                state.event_offsets[l["slug"]] = p.stat().st_size if p.is_file() else 0
    while True:
        time.sleep(interval)
        try:
            fp = fingerprint(watched_files(state.repos))
            if fp != state.fingerprint:
                state.fingerprint = fp
                state.recompute()
                state.broadcast({"type": "status", "data": state.status})
            for s in state.status:
                for l in s["lanes"]:
                    if not l.get("worktree"):
                        continue
                    p = Path(l["worktree"]) / "docs" / "specs" / f"{l['slug']}.events.jsonl"
                    new, off = tail_events(p, state.event_offsets.get(l["slug"], 0))
                    if new:
                        state.event_offsets[l["slug"]] = off
                        for e in new:
                            state.broadcast({"type": "event", "lane": l["slug"], "project": s["project"], "data": e})
        except Exception as exc:  # noqa: BLE001
            print(f"watcher: {exc}", file=sys.stderr)


def open_terminal(worktree: Path, slug: str) -> tuple[bool, str]:
    """Open a terminal window running `claude` in the worktree. Best effort per platform."""
    if not worktree.is_dir():
        return False, f"worktree {worktree} does not exist"
    claude = shutil.which("claude")
    if not claude:
        return False, "claude CLI not found on PATH"
    cmd = f'cd "{worktree}" && claude'
    sysname = platform.system()
    try:
        if sysname == "Darwin":
            script = f'tell application "Terminal" to do script "{cmd.replace(chr(34), chr(92) + chr(34))}"'
            subprocess.Popen(["osascript", "-e", script])
        elif sysname == "Linux":
            for term in ("x-terminal-emulator", "gnome-terminal", "konsole", "xterm"):
                if shutil.which(term):
                    args = [term, "--", "bash", "-lc", f"{cmd}; exec bash"] if term in ("gnome-terminal", "x-terminal-emulator") else [term, "-e", f"bash -lc '{cmd}; exec bash'"]
                    subprocess.Popen(args)
                    break
            else:
                return False, "no terminal emulator found"
        elif sysname == "Windows":
            subprocess.Popen(["cmd", "/c", "start", "cmd", "/k", f'cd /d "{worktree}" && claude'])
        else:
            return False, f"unsupported platform {sysname}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
    return True, f"opened claude in {worktree}"


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        server_version = "agent-kit-dashboard/0.1"

        def log_message(self, fmt, *args):  # quiet
            pass

        def _json(self, code: int, obj) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _local(self) -> bool:
            return self.client_address[0] in ("127.0.0.1", "::1")

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path in ("/", "/index.html"):
                body = INDEX.read_bytes()
                self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
                return
            if u.path == "/api/status":
                if not state.status:
                    state.recompute()
                return self._json(200, state.status if len(state.status) > 1 else (state.status[0] if state.status else {}))
            if u.path.startswith("/api/events/"):
                slug = u.path.rsplit("/", 1)[1]
                proj = state.project((q.get("project") or [None])[0])
                if not proj:
                    return self._json(404, {"error": "project not found"})
                lane_ = next((l for l in proj["lanes"] if l["slug"] == slug), None)
                root = Path(lane_["worktree"]) if lane_ and lane_.get("worktree") else Path(proj["root"])
                events, _ = tail_events(root / "docs" / "specs" / f"{slug}.events.jsonl", 0)
                return self._json(200, events[-500:])
            if u.path == "/api/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-store"); self.send_header("Connection", "keep-alive")
                self.end_headers()
                queue: list[str] = []
                with state.lock:
                    state.listeners.append(queue)
                try:
                    self.wfile.write(b": connected\n\n"); self.wfile.flush()
                    last_ping = time.time()
                    while True:
                        while queue:
                            self.wfile.write(f"data: {queue.pop(0)}\n\n".encode()); self.wfile.flush()
                        if time.time() - last_ping > 15:
                            self.wfile.write(b": ping\n\n"); self.wfile.flush(); last_ping = time.time()
                        time.sleep(0.25)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with state.lock:
                        if queue in state.listeners:
                            state.listeners.remove(queue)
                return
            self._json(404, {"error": "not found"})

        def do_POST(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path.startswith("/api/open/"):
                if not self._local():
                    return self._json(403, {"ok": False, "error": "localhost only"})
                slug = u.path.rsplit("/", 1)[1]
                proj = state.project((q.get("project") or [None])[0])
                lane_ = next((l for l in (proj or {}).get("lanes", []) if l["slug"] == slug), None)
                if not lane_ or not lane_.get("worktree"):
                    return self._json(404, {"ok": False, "error": "lane has no worktree"})
                ok, msg = open_terminal(Path(lane_["worktree"]), slug)
                return self._json(200 if ok else 500, {"ok": ok, "error": None if ok else msg, "message": msg})
            self._json(404, {"ok": False, "error": "not found"})

    return Handler


def serve(repos: list[Path], port: int, open_browser: bool, interval: float = 1.0) -> ThreadingHTTPServer:
    state = State(repos)
    state.recompute()
    state.fingerprint = fingerprint(watched_files(repos))
    threading.Thread(target=watcher, args=(state, interval), daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    httpd.state = state  # type: ignore[attr-defined]
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()
    return httpd


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", action="append", default=[])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args(argv)
    repos = [Path(r).expanduser().resolve() for r in a.repo]
    if a.all or not repos:
        reg = Path(os.environ.get("CLAUDE_HOME", Path.home() / ".claude")) / "kit-projects.json"
        if reg.is_file():
            repos += [Path(p).expanduser().resolve() for p in json.loads(reg.read_text())]
    repos = [r for r in repos if r.is_dir()]
    if not repos:
        print("no projects: pass --repo PATH or register projects in ~/.claude/kit-projects.json (bootstrap does this)", file=sys.stderr)
        return 1
    httpd = serve(repos, a.port, not a.no_open)
    print(f"agent-kit dashboard: http://127.0.0.1:{a.port}/  ({len(repos)} project(s))")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
