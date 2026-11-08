#!/usr/bin/env python3
"""CI: any dependency added versus the base branch must be declared under the spec's '## New dependencies'."""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, ci_common as C  # noqa: E402


def deps_at(root: Path, ref: str | None) -> set[str]:
    names: set[str] = set()
    pj = K.file_lines_at(root, "package.json", ref)
    if pj:
        try:
            d = json.loads("\n".join(pj))
            for k in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                names |= set((d.get(k) or {}).keys())
        except json.JSONDecodeError:
            pass
    pp = K.file_lines_at(root, "pyproject.toml", ref)
    if pp:
        txt = "\n".join(pp)
        for m in re.finditer(r'"([A-Za-z][A-Za-z0-9_.\-]*)(?:\[[^\]]*\])?\s*(?:[>=<~!;,@ ][^"]*)?"', txt):
            names.add(m.group(1).lower())
        for m in re.finditer(r'^\s*([A-Za-z][A-Za-z0-9_.\-]*)\s*=\s*(?:"\^|\{)', txt, re.M):
            names.add(m.group(1).lower())
    for f in ("requirements.txt", "requirements-dev.txt", "Pipfile"):
        lines = K.file_lines_at(root, f, ref)
        if lines:
            for l in lines:
                m = re.match(r"^\s*([A-Za-z][A-Za-z0-9_.\-]+)", l)
                if m and not l.strip().startswith(("#", "-", "[")):
                    names.add(m.group(1).lower())
    gm = K.file_lines_at(root, "go.mod", ref)
    if gm:
        names |= {l.split()[0] for l in gm if re.match(r"^\s*[a-z0-9.\-]+\.[a-z]+/\S+\s+v", l)}
    ct = K.file_lines_at(root, "Cargo.toml", ref)
    if ct:
        in_deps = False
        for l in ct:
            if l.startswith("["):
                in_deps = "dependencies" in l
            elif in_deps:
                m = re.match(r"^\s*([A-Za-z0-9_\-]+)\s*=", l)
                if m:
                    names.add(m.group(1).lower())
    return names


def declared(spec: Path) -> set[str]:
    if not spec.is_file():
        return set()
    sec = K.parse_sections(K.strip_html_comments(K.read_lines(spec))).get("new dependencies")
    out: set[str] = set()
    if sec:
        for _, t in sec.bullets():
            m = re.match(r"^\s*-\s*`?([@A-Za-z0-9_./\-]+)", t)
            if m and m.group(1).lower() != "none":
                out.add(m.group(1).lower().split("@")[0] if not m.group(1).startswith("@") else "@" + m.group(1)[1:].split("@")[0])
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default="."); ap.add_argument("--base", default="origin/main")
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    try:
        base = deps_at(root, a.base)
    except Exception as e:  # noqa: BLE001
        return C.ok(f"dep-diff: cannot read base ({e}); skipped")
    added = {d.lower() for d in deps_at(root, None)} - {d.lower() for d in base}
    if not added:
        return C.ok("dep-diff: no new dependencies")
    slug = C.lane_slug(root)
    decl = declared(root / "docs" / "specs" / f"{slug}.md") if slug else set()
    undeclared = sorted(d for d in added if d not in decl)
    if undeclared:
        return C.fail(f"dep-diff: dependencies added but not declared in the spec's New dependencies: {', '.join(undeclared)}")
    return C.ok(f"dep-diff: {len(added)} new dependenc{'y' if len(added) == 1 else 'ies'}, all declared")


if __name__ == "__main__":
    sys.exit(main())
