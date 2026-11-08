#!/usr/bin/env python3
"""CI: the project's hooks and kit scripts are intact: settings.json hooks equal the kit fragment, disableAllHooks is not set,
and kit-owned files match the manifest written at bootstrap/upgrade."""
from __future__ import annotations
import argparse, hashlib, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, ci_common as C  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default="."); ap.add_argument("--kit", default=str(Path(__file__).resolve().parents[1]))
    a = ap.parse_args(argv); root = Path(a.repo).resolve(); kit = Path(a.kit).resolve()
    problems = []
    settings_p = root / ".claude" / "settings.json"
    if not settings_p.is_file():
        return C.fail("guards-present: .claude/settings.json missing; run /bootstrap")
    settings = json.loads(settings_p.read_text())
    if settings.get("disableAllHooks"):
        problems.append("disableAllHooks is set")
    frag = json.loads((kit / "hooks" / "settings.project.json").read_text())
    if settings.get("hooks") != frag["hooks"]:
        missing = [ev for ev in frag["hooks"] if ev not in (settings.get("hooks") or {})]
        problems.append(f"hooks block differs from kit fragment (missing events: {missing or 'none; entries changed'})")
    deny = set((settings.get("permissions") or {}).get("deny", []))
    for d in frag["permissions"]["deny"]:
        if d not in deny:
            problems.append(f"permissions.deny missing {d}")
    man_p = root / ".claude" / "kit-manifest.json"
    if man_p.is_file():
        man = json.loads(man_p.read_text())
        for rel, h in man.get("files", {}).items():
            p = root / rel
            if not p.is_file():
                problems.append(f"{rel} missing")
            elif hashlib.sha256(p.read_bytes()).hexdigest() != h:
                problems.append(f"{rel} changed since bootstrap (edit through /bootstrap --upgrade)")
        for name, h in man.get("kit_scripts", {}).items():
            p = kit / "scripts" / name
            if p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest() != h:
                problems.append(f"kit script {name} differs from the version this project was bootstrapped with; run /bootstrap --upgrade")
    else:
        problems.append(".claude/kit-manifest.json missing")
    if problems:
        return C.fail("guards-present:\n  " + "\n  ".join(problems))
    return C.ok("guards-present: hooks, permissions, and kit-owned files intact")


if __name__ == "__main__":
    sys.exit(main())
