#!/usr/bin/env python3
"""PostToolUse on Edit|Write|MultiEdit|Bash inside a lane: run typecheck, lint, and tests; log everything;
detect weakened tests; feed failures back as a block decision so the agent must respond.

Commands come from .claude/kit.json:
  {"commands": {"typecheck": "...", "lint": "... {file}", "test": "...", "test_affected": "... {file}"},
   "timeouts": {"check": 180}, "always_check": false}
Tokens: {file} = the edited file (repo-relative). A missing command is skipped.
"""
from __future__ import annotations
import re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K

TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec)(/|$)|\.(test|spec)\.[a-z]+$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb)$")
REMOVED_ASSERT = re.compile(r"^-\s*.*\b(expect|assert|should|must)\b", re.IGNORECASE)
ADDED_SKIP = re.compile(r"^\+\s*.*(\.skip\(|\.only\(|\bxit\(|\bxdescribe\(|\bxtest\(|@pytest\.mark\.skip|pytest\.skip\(|\bt\.Skip\(|@unittest\.skip|#\[ignore\])")
FAIL_SIGNALS = re.compile(r"(\b\d+ failed\b|\bFAIL\b|\bFAILED\b|\bError:|\berror TS\d+|\bTypeError\b|✖|✗|\bpanic:)", re.IGNORECASE)
PASS_COUNT = re.compile(r"(\d+)\s+passed", re.IGNORECASE)
FAIL_COUNT = re.compile(r"(\d+)\s+failed", re.IGNORECASE)


def run(cmd: str, cwd: Path, timeout: int) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + ("\n" + p.stderr if p.stderr else "")).strip()
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"


def weakened_tests(cwd: Path) -> list[str]:
    try:
        names = subprocess.run(["git", "diff", "--name-only", "HEAD"], cwd=cwd, capture_output=True, text=True, timeout=20).stdout.split()
        untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=cwd, capture_output=True, text=True, timeout=20).stdout.split()
    except Exception:
        return []
    problems = []
    for n in names:
        if not TEST_FILE.search(n):
            continue
        diff = subprocess.run(["git", "diff", "-U0", "HEAD", "--", n], cwd=cwd, capture_output=True, text=True, timeout=20).stdout
        removed = [l for l in diff.splitlines() if REMOVED_ASSERT.match(l) and not l.startswith("---")]
        skips = [l for l in diff.splitlines() if ADDED_SKIP.match(l) and not l.startswith("+++")]
        if removed:
            problems.append(f"{n}: {len(removed)} assertion line(s) removed")
        if skips:
            problems.append(f"{n}: test skip/only added")
    for n in untracked:
        if TEST_FILE.search(n):
            try:
                txt = (cwd / n).read_text(errors="replace")
            except OSError:
                continue
            if ADDED_SKIP.search("+" + txt.replace("\n", "\n+")):
                problems.append(f"{n}: new test file contains skip/only")
    return problems


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cwd = Path(d.get("cwd") or ".")
    lane = K.find_lane(cwd)
    root = lane.root if lane else K.project_root(cwd)
    kit = K.load_kit_json(root)
    if not lane and not kit.get("always_check"):
        return 0
    cmds = kit.get("commands", {})
    timeout = int(kit.get("timeouts", {}).get("check", 180))
    ti = d.get("tool_input") or {}
    fp = ti.get("file_path") or ti.get("notebook_path")
    rel = K.rel_to(root, (cwd / fp) if fp and not Path(fp).is_absolute() else fp) if fp else None
    if d.get("tool_name") == "Bash" and not re.search(r"(>|>>|\bsed\s+-i|\btee\b|\bmv\b|\bcp\b|\brm\b|npm\s+(i|install|add|rm|remove)|pip\s+install|git\s+(apply|checkout|merge|rebase|stash))", ti.get("command", "")):
        return 0  # read-only shell command; nothing to check

    log = lane.log_path if lane else root / ".claude" / "session" / "checks.log"
    events = lane.events_path if lane else root / ".claude" / "session" / "events.jsonl"
    failures: list[str] = []

    def step(name: str, cmd: str | None):
        if not cmd:
            return
        if "{file}" in cmd:
            if not rel:
                return
            cmd = cmd.replace("{file}", rel)
        code, out = run(cmd, root, timeout)
        line = K.append_log(log, f"{name}: {cmd} -> exit {code}", out)
        passed, failed = PASS_COUNT.search(out), FAIL_COUNT.search(out)
        summary = f"exit {code}"
        if passed or failed:
            summary = f"{failed.group(1) if failed else 0} failed, {passed.group(1) if passed else 0} passed"
        K.append_event(events, {"event": name, "tool": "hook", "command": cmd, "result": "ok" if code == 0 else "fail",
                               "summary": summary, "ref": f"{log.name}#{line}", "path": rel})
        if code != 0:
            tail = "\n".join(out.splitlines()[-40:])
            failures.append(f"[{name}] {cmd} -> exit {code} (log {log.name}#{line})\n{tail}")

    step("typecheck", cmds.get("typecheck"))
    step("lint", cmds.get("lint"))
    if rel and cmds.get("test_affected"):
        step("test", cmds.get("test_affected"))
    else:
        step("test", cmds.get("test"))

    weak = weakened_tests(root)
    if weak:
        K.append_event(events, {"event": "test_weakened", "tool": "hook", "result": "fail", "summary": "; ".join(weak)})
        failures.append("[tests weakened] " + "; ".join(weak) + "\nRemoving assertions or skipping tests is not a fix. Restore them, or record why in progress.md under Uncertainties and let the reviewer decide.")

    if failures:
        return K.feedback_block("post-edit-check found problems. Fix them before continuing; do not mark anything done.\n\n" + "\n\n".join(failures))
    return 0


if __name__ == "__main__":
    sys.exit(main())
