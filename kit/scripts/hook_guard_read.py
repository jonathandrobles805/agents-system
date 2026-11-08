#!/usr/bin/env python3
"""PreToolUse on Read: block reads of secrets and credential files. Exit 2 blocks."""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K


TEMPLATE_EXCEPTIONS = [".env.example*", ".env.sample*", ".env.template*", "*.env.example", "*.env.sample"]


def is_secret(rel: str, extra: list[str]) -> bool:
    name = Path(rel).name
    if K.glob_match(name, TEMPLATE_EXCEPTIONS):
        return False
    pats = K.SECRET_READ_PATTERNS + list(extra)
    return K.glob_match(rel, pats) or K.glob_match(name, [p for p in pats if "/" not in p])


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cwd = Path(d.get("cwd") or ".")
    root = K.project_root(cwd)
    ti = d.get("tool_input") or {}
    fp = ti.get("file_path") or ti.get("notebook_path")
    if not fp:
        return 0
    rel = K.rel_to(root, (cwd / fp) if not Path(fp).is_absolute() else fp)
    extra = K.load_kit_json(root).get("secret_patterns", [])
    if is_secret(rel, extra):
        K.append_event(K.project_root(cwd) / ".claude" / "session" / "events.jsonl",
                       {"event": "blocked", "tool": "Read", "path": rel, "result": "blocked", "summary": "secret/credential file"})
        return K.block(f"guard-read: '{rel}' matches a secret/credential pattern. Lanes never read secrets. "
                       f"If this file is required, the spec must declare it and a human must provide a redacted copy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
