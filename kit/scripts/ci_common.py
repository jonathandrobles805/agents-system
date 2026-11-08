"""Shared helpers for the CI scripts."""
from __future__ import annotations
import re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K  # noqa: E402


def current_branch(root: Path) -> str:
    """The repo's own branch. CI checks out PRs with a detached HEAD; only then fall back to the CI env var."""
    import os
    try:
        b = K.git(["rev-parse", "--abbrev-ref", "HEAD"], root).strip()
    except Exception:
        b = ""
    if b and b != "HEAD":
        return b
    for env in ("GITHUB_HEAD_REF", "CI_COMMIT_REF_NAME"):
        if os.environ.get(env):
            return os.environ[env]
    return b


def lane_slug(root: Path) -> str | None:
    """Slug from .claude/lane.json (local) or from a wt/<slug> branch name (CI)."""
    lane = K.find_lane(root)
    if lane and lane.slug:
        return lane.slug
    b = current_branch(root)
    m = re.match(r"^(?:wt|lane|feature)/([A-Za-z0-9._-]+)$", b)
    return m.group(1) if m else None


def changed_files(root: Path, base: str) -> list[str]:
    try:
        out = K.git(["diff", "--name-only", f"{base}...HEAD"], root)
    except subprocess.CalledProcessError:
        out = K.git(["diff", "--name-only", base], root)
    return [l.strip() for l in out.splitlines() if l.strip()]


def fail(msg: str) -> int:
    print(msg, file=sys.stderr)
    return 1


def ok(msg: str) -> int:
    print(msg)
    return 0
