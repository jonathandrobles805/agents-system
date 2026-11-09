#!/usr/bin/env python3
"""PostToolUse on Edit|Write|MultiEdit|Bash inside a lane: run typecheck, lint, and tests; log everything;
detect weakened tests; feed failures back as a block decision so the agent must respond.

Commands come from .claude/kit.json:
  {"commands": {"typecheck": "...", "lint": "... {file}", "test": "...", "test_affected": "... {file}"},
   "timeouts": {"check": 180}, "always_check": false}
Tokens: {file} = the edited file (repo-relative). A missing command is skipped.
"""
from __future__ import annotations
import json, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K

TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec)(/|$)|\.(test|spec)\.[a-z]+$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb)$")
REMOVED_ASSERT = re.compile(r"^-\s*.*\b(expect|assert|should|must)\b", re.IGNORECASE)
ADDED_SKIP = re.compile(r"^\+\s*.*(\.skip\(|\.only\(|\bxit\(|\bxdescribe\(|\bxtest\(|@pytest\.mark\.skip|pytest\.skip\(|\bt\.Skip\(|@unittest\.skip|#\[ignore\])")
FAIL_SIGNALS = re.compile(r"(\b\d+ failed\b|\bFAIL\b|\bFAILED\b|\bError:|\berror TS\d+|\bTypeError\b|✖|✗|\bpanic:)", re.IGNORECASE)
PASS_COUNT = re.compile(r"(\d+)\s+passed", re.IGNORECASE)
FAIL_COUNT = re.compile(r"(\d+)\s+failed", re.IGNORECASE)


MAX_ATTEMPTS = 3
FAILED_TEST = re.compile(r"(?:FAILED|FAIL|✗|×|✖)\s+([^\s].*?)(?:\s+-\s|\s+\(|$)", re.M)


def failure_signature(name: str, out: str) -> str:
    """Stable id for 'the same failure': the failing test names when parseable, else the last meaningful lines."""
    names = sorted({m.group(1).strip()[:120] for m in FAILED_TEST.finditer(out)})
    if names:
        return name + ":" + "|".join(names[:8])
    tail = [l.strip() for l in out.splitlines() if l.strip()][-5:]
    return name + ":" + "|".join(tail)[:400]


def attempts_path(lane: "K.Lane", sid: str) -> Path:
    d = lane.root / K.SESSION_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d / (re.sub(r"[^A-Za-z0-9_.-]", "_", sid or "s") + ".attempts.json")


def bump_attempt(lane: "K.Lane", sid: str, sig: str) -> int:
    p = attempts_path(lane, sid)
    data = json.loads(p.read_text()) if p.is_file() else {}
    data[sig] = int(data.get(sig, 0)) + 1
    p.write_text(json.dumps(data))
    return data[sig]


def reset_attempts(lane: "K.Lane", sid: str) -> None:
    p = attempts_path(lane, sid)
    if p.is_file():
        p.write_text("{}")


def write_escalation(lane: "K.Lane", sig: str, n: int, refs: list[str]) -> None:
    """Fill the Escalation section of progress.md so done-check accepts the stop and the human sees why."""
    prog = lane.progress_path
    text = prog.read_text() if prog.is_file() else f"# Progress: {lane.slug}\n\n## Escalation\n"
    block = (f"## Escalation\n\n- Attempts: {n} of {MAX_ATTEMPTS}\n- Failure: {sig[:300]}\n"
             f"- Tried: {len(refs)} fix attempt(s); see {', '.join(refs[-3:]) or 'log'}\n- Needs: a human decision: the approach, the spec, or the test is wrong\n")
    if "## Escalation" in text:
        head, _, _ = text.partition("## Escalation")
        text = head.rstrip() + "\n\n" + block
    else:
        text = text.rstrip() + "\n\n" + block
    prog.parent.mkdir(parents=True, exist_ok=True)
    prog.write_text(text)


def shell_scope_violations(lane: "K.Lane") -> list[str]:
    """After a Bash command: any modified or new file outside the spec allow-list (catches sed -i, redirects, cp, mv)."""
    try:
        out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=lane.root, capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return []
    _, change, create = K.spec_file_lists(lane.spec_path)
    allowed = change + create + lane.always_allowed() + ["ROADMAP.md"]
    bad = []
    for line in out.splitlines():
        rel = line[3:].strip()
        if " -> " in rel:
            rel = rel.split(" -> ", 1)[1]
        if rel.startswith(".claude/"):
            continue
        if not K.glob_match(rel, allowed):
            bad.append(rel)
    return bad


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
    sid = d.get("session_id", "s")
    red_sigs: list[tuple[str, str]] = []   # (signature, log ref) for failing test/typecheck steps this call
    any_test_green = False

    nonlocal_green = [False]

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
            if name in ("test", "typecheck"):
                red_sigs.append((failure_signature(name, out), f"{log.name}#{line}"))
        elif name == "test":
            nonlocal_green[0] = True

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

    # Shell edits outside the spec (sed -i, >, cp, mv) are invisible to the pre-edit hook; catch them here.
    if lane and d.get("tool_name") == "Bash":
        extras = shell_scope_violations(lane)
        if extras:
            K.append_event(events, {"event": "blocked", "tool": "Bash", "result": "blocked", "summary": "shell edit outside spec: " + ", ".join(extras[:5])})
            failures.append("[scope] files changed outside the spec's allow-list via shell: " + ", ".join(extras) +
                            "\nRevert them (git checkout -- <file>) or stop and record under Escalation that the spec needs amending.")

    # Attempt counter: the same failure red N times in a row is an escalation, not a fourth try.
    if lane:
        if nonlocal_green[0] and not red_sigs:
            reset_attempts(lane, sid)
        for sig, ref in red_sigs:
            n = bump_attempt(lane, sid, sig)
            K.append_event(events, {"event": "attempt", "tool": "hook", "result": "fail", "summary": f"attempt {n}/{MAX_ATTEMPTS}: {sig[:120]}", "ref": ref})
            if n >= MAX_ATTEMPTS:
                data = json.loads(attempts_path(lane, sid).read_text())
                write_escalation(lane, sig, n, [ref])
                K.append_event(events, {"event": "escalation", "tool": "hook", "result": "fail", "summary": f"{n} attempts on the same failure; escalation written"})
                return K.feedback_block(f"post-edit-check: this failure has now failed {n} times in a row:\n{sig[:300]}\n\n"
                                        "The Escalation section of progress.md has been written for you. Do not try again. "
                                        "Make sure Current step describes where things stand, then end the turn; a human decides next.")

    if failures:
        return K.feedback_block("post-edit-check found problems. Fix them before continuing; do not mark anything done.\n\n" + "\n\n".join(failures))
    return 0


if __name__ == "__main__":
    sys.exit(main())
