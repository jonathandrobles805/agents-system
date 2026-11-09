#!/usr/bin/env python3
"""Fallback import-boundary check driven by ARCHITECTURE.md when a project has no dependency-cruiser / import-linter.

Reads the Layers table:  | layer | `dir1`, `dir2` | may import from |
A file in layer A may import only from A itself and the layers named in its "May import from" cell
("nothing in the app" = only its own layer). Imports outside all layers (third-party) are ignored.
Supports JS/TS (import ... from '...', require('...')), Python (import x / from x import), Go (import "mod/..."), Rust (use crate::...).

  ci_boundaries_simple.py --repo R [--arch ARCHITECTURE.md]
Exit 1 on violations.
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, ci_common as C  # noqa: E402

SRC_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs"}
JS_IMPORT = re.compile(r"""(?:import\s+(?:[^'"]*?\s+from\s+)?|require\()\s*['"]([^'"]+)['"]""")
PY_IMPORT = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", re.M)
GO_IMPORT = re.compile(r'"([\w./-]+)"')
RS_USE = re.compile(r"^\s*use\s+crate::([\w:]+)", re.M)


def layers(arch: Path) -> list[dict]:
    if not arch.is_file():
        return []
    sec = K.parse_sections(K.strip_html_comments(K.read_lines(arch))).get("layers")
    out = []
    if sec:
        for _, cells in sec.table_rows():
            if len(cells) >= 3 and not cells[0].startswith("TODO"):
                dirs = [d.strip().strip("`") for d in cells[1].split(",") if d.strip().strip("`")]
                allowed = [a.strip() for a in re.split(r"[,/]| and ", cells[2]) if a.strip()]
                out.append({"name": cells[0], "dirs": dirs, "allowed": {a for a in allowed if a.lower() not in {"nothing in the app", "nothing", "none", "—", "-"}}})
    return out


def layer_of(rel: str, ls: list[dict]) -> str | None:
    best, blen = None, -1
    for l in ls:
        for d in l["dirs"]:
            d = d.rstrip("/")
            if (rel == d or rel.startswith(d + "/")) and len(d) > blen:
                best, blen = l["name"], len(d)
    return best


def resolve_import(src_rel: str, spec: str, root: Path) -> str | None:
    """Return the repo-relative path the import points at (directory or file, without extension), or None for third-party."""
    src = Path(src_rel)
    if spec.startswith("."):
        return (src.parent / spec).as_posix().replace("/./", "/").lstrip("./") if not spec.startswith("..") else _norm(src.parent / spec)
    if spec.startswith(("src/", "app/", "lib/", "internal/", "pkg/", "cmd/")):
        return spec
    if spec.startswith("@/"):
        return "src/" + spec[2:]
    # python dotted path relative to repo root
    if "." in spec and "/" not in spec:
        cand = spec.replace(".", "/")
        if (root / cand).exists() or (root / (cand + ".py")).exists() or (root / cand.split("/")[0]).is_dir():
            return cand
    if (root / spec).exists() or (root / (spec + ".py")).exists():
        return spec
    return None


def _norm(p: Path) -> str:
    parts: list[str] = []
    for part in p.as_posix().split("/"):
        if part == "..":
            if parts:
                parts.pop()
        elif part not in ("", "."):
            parts.append(part)
    return "/".join(parts)


def imports_in(path: Path) -> list[str]:
    text = path.read_text(errors="replace")
    if path.suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs"}:
        return JS_IMPORT.findall(text)
    if path.suffix == ".py":
        return [a or b for a, b in PY_IMPORT.findall(text)]
    if path.suffix == ".go":
        return GO_IMPORT.findall(text)
    if path.suffix == ".rs":
        return ["src/" + m.replace("::", "/") for m in RS_USE.findall(text)]
    return []


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default="."); ap.add_argument("--arch", default="ARCHITECTURE.md")
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    ls = layers(root / a.arch)
    if not ls:
        return C.ok("boundaries: no Layers table in ARCHITECTURE.md; nothing to check (fill it in, or configure a boundaries lint)")
    violations = []
    for f in K.git(["ls-files"], root).split():
        p = root / f
        if p.suffix not in SRC_EXT or not p.is_file():
            continue
        src_layer = layer_of(f, ls)
        if not src_layer:
            continue
        allowed = next(l for l in ls if l["name"] == src_layer)["allowed"] | {src_layer}
        for spec in imports_in(p):
            target = resolve_import(f, spec, root)
            if not target:
                continue
            tgt_layer = layer_of(target, ls)
            if tgt_layer and tgt_layer not in allowed:
                violations.append(f"{f}: imports '{spec}' ({tgt_layer}); layer '{src_layer}' may import only {sorted(allowed)}")
    if violations:
        return C.fail("boundaries: architecture violations:\n  " + "\n  ".join(violations))
    return C.ok(f"boundaries: ok across {len(ls)} layer(s)")


if __name__ == "__main__":
    sys.exit(main())
