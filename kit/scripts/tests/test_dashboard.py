"""Dashboard server: endpoints, live recompute on file change, SSE event streaming, open-claude guard."""
import json
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

import fixtures as F
from conftest import run_script
from test_lane import project

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "dashboard"))
import server as S  # noqa: E402


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def get(url: str):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, json.loads(r.read().decode()) if r.headers.get("Content-Type", "").startswith("application/json") else r.read().decode()


def test_server_endpoints_and_live_updates(tmp_path, monkeypatch):
    monkeypatch.setenv("KIT_STATUS_NO_GH", "1")
    root, _ = project(tmp_path)
    out = json.loads(run_script("lane.py", ["start", "refund-route", "--repo", str(root)]).stdout)
    wt = Path(out["worktree"])
    port = free_port()
    httpd = S.serve([root], port, open_browser=False, interval=0.2)
    t = threading.Thread(target=httpd.serve_forever, daemon=True); t.start()
    try:
        base = f"http://127.0.0.1:{port}"
        code, html = get(base + "/")
        assert code == 200 and "agent-kit" in html
        code, st = get(base + "/api/status")
        lane = next(l for l in st["lanes"] if l["slug"] == "refund-route")
        assert lane["position"] == "building"

        # SSE: connect, then change a watched file and append an event; both must arrive
        req = urllib.request.Request(base + "/api/stream")
        stream = urllib.request.urlopen(req, timeout=10)
        time.sleep(0.3)
        prog = wt / "docs/specs/refund-route.progress.md"
        prog.write_text(prog.read_text().replace("- Attempts: {{n}} of 3", "- Attempts: 3 of 3").replace("- Failure: {{what fails}}", "- Failure: mock never called"))
        with (wt / "docs/specs/refund-route.events.jsonl").open("a") as f:
            f.write(json.dumps({"ts": "2026-11-08T18:00:00", "event": "blocked", "tool": "Edit", "path": "src/x.ts", "result": "blocked"}) + "\n")
        got_status = got_event = False
        deadline = time.time() + 6
        while time.time() < deadline and not (got_status and got_event):
            line = stream.readline().decode()
            if line.startswith("data: "):
                msg = json.loads(line[6:])
                if msg["type"] == "status":
                    got_status = True
                    lane = next(l for l in msg["data"][0]["lanes"] if l["slug"] == "refund-route")
                    assert lane["position"] == "escalated"
                if msg["type"] == "event" and msg["lane"] == "refund-route":
                    got_event = True
                    assert msg["data"]["event"] == "blocked"
        stream.close()
        assert got_status and got_event

        code, events = get(base + "/api/events/refund-route")
        assert code == 200 and events[-1]["event"] == "blocked"

        # open: local, but no `claude` on PATH here -> clean error, never a crash
        req = urllib.request.Request(base + "/api/open/refund-route", method="POST")
        try:
            urllib.request.urlopen(req, timeout=5)
            assert False, "expected 500"
        except urllib.error.HTTPError as e:
            body = json.loads(e.read().decode())
            assert e.code in (500, 404) and body["ok"] is False and body["error"]
    finally:
        httpd.shutdown()


def test_index_html_is_self_contained():
    html = (Path(__file__).resolve().parents[2] / "dashboard" / "index.html").read_text()
    assert "<script src=" not in html and "https://" not in html.split("<script>")[1] or "cdn" not in html
    assert "status.json" in html and "/api/stream" in html and "/api/open/" in html
