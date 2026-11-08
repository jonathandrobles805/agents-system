"""Shared helpers for kit scripts. Standard library only."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

HEDGE_WORDS = re.compile(
    r"\b(should|probably|likely|i think|i assume|assume|assuming|presumably|might be|seems to|appears to)\b",
    re.IGNORECASE,
)
PLACEHOLDER = re.compile(r"\{\{[^}]*\}\}")

TAG_VERIFIED_LINES = re.compile(r"\[verified:\s*([^\]\s:]+):(\d+)(?:-(\d+))?\]")
TAG_VERIFIED_CMD = re.compile(r"\[verified:\s*cmd\]")
TAG_DOCS = re.compile(r"\[docs:\s*(\S+)\s*@\s*([^\]]+)\]")
TAG_INFERRED = re.compile(r"\[inferred:\s*from\s+([^\]]+)\]")
TAG_UNKNOWN = re.compile(r"\[unknown\]")
ANY_TAG = re.compile(r"\[(verified|docs|inferred|unknown)\b[^\]]*\]")

DEFAULT_HIGH_RISK_PATHS = ["auth", "payment", "billing", "migration", "migrations", "infra", "deploy", "secrets", "public-api", "api/public"]
HIGH_RISK_KEYWORDS = re.compile(r"\b(auth(entication|orization)?|payment|billing|delete|drop table|migration|public api|secret|credential|token)\b", re.IGNORECASE)


@dataclass
class Violation:
    path: str
    line: int
    rule: str
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.rule}: {self.message}"


@dataclass
class Section:
    title: str
    start: int  # 1-based line number of the heading
    lines: list[tuple[int, str]] = field(default_factory=list)  # (lineno, text)

    def bullets(self) -> list[tuple[int, str]]:
        return [(n, t) for n, t in self.lines if t.lstrip().startswith("- ")]

    def table_rows(self) -> list[tuple[int, list[str]]]:
        rows = []
        for n, t in self.lines:
            s = t.strip()
            if s.startswith("|") and not re.match(r"^\|\s*-{2,}", s):
                cells = [c.strip() for c in s.strip("|").split("|")]
                rows.append((n, cells))
        return rows[1:] if rows else []  # drop header row

    def text(self) -> str:
        return "\n".join(t for _, t in self.lines)


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def parse_sections(lines: list[str]) -> dict[str, Section]:
    """Split a markdown document into '## ' sections. Keys are lowercase titles."""
    sections: dict[str, Section] = {}
    current: Section | None = None
    in_fence = False
    for i, raw in enumerate(lines, start=1):
        if raw.strip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and raw.startswith("## "):
            current = Section(title=raw[3:].strip(), start=i)
            sections[current.title.lower()] = current
            continue
        if current is not None:
            current.lines.append((i, raw))
    return sections


def header_fields(lines: list[str]) -> dict[str, tuple[int, str]]:
    """Collect '- Key: value' lines before the first '## ' heading."""
    fields: dict[str, tuple[int, str]] = {}
    for i, raw in enumerate(lines, start=1):
        if raw.startswith("## "):
            break
        m = re.match(r"^-\s*([A-Za-z][A-Za-z ]*):\s*(.*)$", raw)
        if m:
            fields[m.group(1).strip().lower()] = (i, m.group(2).strip())
    return fields


def strip_html_comments(lines: list[str]) -> list[str]:
    out, in_comment = [], False
    for raw in lines:
        s = raw
        if in_comment:
            if "-->" in s:
                s = s.split("-->", 1)[1]
                in_comment = False
            else:
                out.append("")
                continue
        while "<!--" in s:
            before, rest = s.split("<!--", 1)
            if "-->" in rest:
                s = before + rest.split("-->", 1)[1]
            else:
                s = before
                in_comment = True
                break
        out.append(s)
    return out


def git(args: list[str], cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def repo_root(start: Path) -> Path:
    try:
        return Path(git(["rev-parse", "--show-toplevel"], start if start.is_dir() else start.parent).strip())
    except Exception:
        return start if start.is_dir() else start.parent


def file_lines_at(root: Path, rel: str, commit: str | None) -> list[str] | None:
    """Return the lines of a file at a commit (or working tree). None if missing."""
    if commit:
        try:
            return git(["show", f"{commit}:{rel}"], root).splitlines()
        except subprocess.CalledProcessError:
            return None
    p = root / rel
    if not p.is_file():
        return None
    try:
        return p.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def load_kit_json(root: Path) -> dict:
    p = root / ".claude" / "kit.json"
    if p.is_file():
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def read_hook_input() -> dict:
    data = sys.stdin.read()
    if not data.strip():
        return {}
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return {}


def changed_docs(root: Path) -> list[Path]:
    """Modified or untracked files under docs/ and LESSONS.md, per git status."""
    try:
        out = git(["status", "--porcelain", "--untracked-files=all"], root)
    except Exception:
        return []
    paths = []
    for line in out.splitlines():
        rel = line[3:].strip()
        if " -> " in rel:
            rel = rel.split(" -> ", 1)[1]
        if (rel.startswith("docs/") and rel.endswith(".md")) or rel == "LESSONS.md":
            paths.append(root / rel)
    return paths
