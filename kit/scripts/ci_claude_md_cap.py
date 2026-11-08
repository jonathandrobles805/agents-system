#!/usr/bin/env python3
"""CI: CLAUDE.md must stay under the cap in .claude/kit.json (default 4000 bytes). A long CLAUDE.md is skimmed; move rules into checks."""
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, ci_common as C  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default=".")
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    cap = int(K.load_kit_json(root).get("claude_md_cap_bytes", 4000))
    p = root / "CLAUDE.md"
    if not p.is_file():
        return C.fail("claude-md-cap: CLAUDE.md missing")
    n = len(p.read_bytes())
    if n > cap:
        return C.fail(f"claude-md-cap: CLAUDE.md is {n} bytes, cap {cap}. Move enforced rules out (they are in hooks) or raise the cap in .claude/kit.json with a decision record.")
    return C.ok(f"claude-md-cap: {n}/{cap} bytes")


if __name__ == "__main__":
    sys.exit(main())
