#!/usr/bin/env python3
"""PreToolUse on Bash: block destructive and policy-violating commands. Exit 2 blocks.

Blocked everywhere:
  git push --force / -f, git push to main/master, git reset --hard, git clean -f, git checkout -- . ,
  rm -rf on anything outside /tmp or the worktree, sudo, curl|sh / wget|sh, --no-verify,
  writes into .claude/ or .github/workflows via redirection, sed -i, tee, cp, mv,
  chmod/chown on .claude/hooks, printing secrets (cat .env), git commit when staged files match secret patterns.
In a lane additionally: git worktree remove/prune, git branch -D, checkout/switch to another branch.
"""
from __future__ import annotations
import re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K

RULES: list[tuple[str, str]] = [
    (r"\bgit\s+push\b[^|;&]*\s(--force|-f|--force-with-lease)\b", "force push"),
    (r"\bgit\s+push\b[^|;&]*\s(origin\s+)?(main|master)\b", "direct push to main; open a PR"),
    (r"\bgit\s+reset\s+--hard\b", "git reset --hard discards work"),
    (r"\bgit\s+clean\s+-[a-zA-Z]*f", "git clean -f deletes untracked files"),
    (r"\bgit\s+checkout\s+--\s+\.", "git checkout -- . discards all changes"),
    (r"\bgit\s+(commit|push|merge|rebase)\b[^|;&]*--no-verify", "--no-verify skips hooks"),
    (r"\bsudo\b", "sudo"),
    (r"\b(curl|wget)\b[^|;&]*\|\s*(ba|z|da)?sh\b", "piping a download into a shell"),
    (r"(>|>>|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b)[^|;&]*\.claude/", "writing into .claude/ (kit configuration)"),
    (r"(>|>>|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b)[^|;&]*\.github/workflows", "writing into CI configuration"),
    (r"\bch(mod|own)\b[^|;&]*\.claude/", "changing permissions on kit hooks"),
    (r"\b(cat|less|more|head|tail|bat|grep|rg)\b[^|;&]*(\.env\b|\.env\.|\.pem\b|id_rsa|\.aws/credentials|\.netrc)", "printing a secrets file"),
    (r"\b(printenv|env)\s*$", "dumping the environment (may contain secrets)"),
    (r"\becho\s+\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)", "echoing a secret variable"),
]
LANE_RULES: list[tuple[str, str]] = [
    (r"\bgit\s+worktree\s+(remove|prune)\b", "removing worktrees from inside a lane"),
    (r"\bgit\s+branch\s+-D\b", "deleting branches from inside a lane"),
    (r"\bgit\s+(checkout|switch)\s+(?!-b\b)(?!--\s)[A-Za-z0-9._/-]+\s*$", "switching branches inside a lane; each lane stays on its branch"),
]
RM_RF = re.compile(r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(.+)")
SECRET_CONTENT = re.compile(r"(AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{10,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{30,})")


def rm_targets_ok(cmd: str, root: Path, cwd: Path) -> str | None:
    for m in RM_RF.finditer(cmd):
        for tok in m.group(2).split():
            if tok.startswith("-"):
                continue
            tok = tok.strip("'\"")
            if tok in ("/", "~", "$HOME", "*", ".", "..") or tok.startswith("/") and not tok.startswith("/tmp"):
                return f"rm -rf {tok}"
            p = (cwd / tok) if not Path(tok).is_absolute() else Path(tok)
            try:
                p.resolve().relative_to(root.resolve())
            except ValueError:
                # Only an explicit absolute /tmp path may be removed outside the project.
                if not tok.startswith("/tmp/"):
                    return f"rm -rf outside the project: {tok}"
            if tok.startswith(".git") or tok.startswith(".claude") or tok.startswith("docs"):
                return f"rm -rf {tok}"
    return None


def staged_secrets(cwd: Path) -> list[str]:
    try:
        names = subprocess.run(["git", "diff", "--cached", "--name-only"], cwd=cwd, capture_output=True, text=True, timeout=20).stdout.split()
    except Exception:
        return []
    hits = []
    for n in names:
        if K.glob_match(n, K.SECRET_READ_PATTERNS) or K.glob_match(Path(n).name, [p for p in K.SECRET_READ_PATTERNS if "/" not in p]):
            hits.append(f"{n} (secret-looking filename)")
            continue
        try:
            content = subprocess.run(["git", "show", f":{n}"], cwd=cwd, capture_output=True, text=True, timeout=20).stdout
        except Exception:
            continue
        if SECRET_CONTENT.search(content):
            hits.append(f"{n} (secret-looking content)")
    return hits


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cmd = (d.get("tool_input") or {}).get("command", "")
    if not cmd:
        return 0
    cwd = Path(d.get("cwd") or ".")
    root = K.project_root(cwd)
    lane = K.find_lane(cwd)
    events = lane.events_path if lane else root / ".claude" / "session" / "events.jsonl"

    def deny(reason: str) -> int:
        K.append_event(events, {"event": "blocked", "tool": "Bash", "command": cmd[:200], "result": "blocked", "summary": reason})
        return K.block(f"guard-bash: blocked ({reason}).\nCommand: {cmd}")

    for pat, why in RULES:
        if re.search(pat, cmd):
            return deny(why)
    if lane:
        for pat, why in LANE_RULES:
            if re.search(pat, cmd):
                return deny(why)
    bad = rm_targets_ok(cmd, root, cwd)
    if bad:
        return deny(bad)
    if re.search(r"\bgit\s+commit\b", cmd):
        hits = staged_secrets(cwd)
        if hits:
            return deny("staged files look like secrets: " + "; ".join(hits))
    return 0


if __name__ == "__main__":
    sys.exit(main())
