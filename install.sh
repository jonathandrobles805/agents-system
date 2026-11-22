#!/usr/bin/env bash
# Install the agent kit into ~/.claude. Idempotent. Re-run after pulling a new kit version.
#
# Usage: ./install.sh [--copy]
#   default: symlink kit/agents/* and the skill folders kit/skills/<name>/ into ~/.claude, and symlink kit/ as ~/.claude/kit
#   --copy : copy instead of symlink (for machines where ~/.claude must not point outside itself)
set -euo pipefail
shopt -s nullglob

KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
MODE="link"
[[ "${1:-}" == "--copy" ]] && MODE="copy"

# The `kit` launcher goes on PATH (#63). Checked before anything is installed: a `kit` that is not the kit's own is
# never replaced, and the kit's path is written into the launcher inside single quotes.
BIN_DIR="${KIT_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/kit"
if [[ -e "$LAUNCHER" || -L "$LAUNCHER" ]] && ! grep -q '^# agent-kit launcher' "$LAUNCHER" 2>/dev/null; then
  echo "install: $LAUNCHER exists and is not the agent-kit launcher; move it away or set KIT_BIN_DIR" >&2; exit 1
fi
case "$CLAUDE_HOME" in *"'"*) echo "install: CLAUDE_HOME must not contain a single quote" >&2; exit 1 ;; esac

mkdir -p "$CLAUDE_HOME/agents" "$CLAUDE_HOME/skills"

place() {
  local src="$1" dst="$2"
  if [[ "$MODE" == "copy" ]]; then
    rm -rf "$dst"; cp -R "$src" "$dst"
  else
    if [[ -e "$dst" && ! -L "$dst" ]]; then
      echo "refusing to replace non-symlink $dst (remove it or use --copy)" >&2; exit 1
    fi
    ln -sfn "$src" "$dst"
  fi
}

for f in "$KIT_ROOT"/kit/agents/*.md; do
  place "$f" "$CLAUDE_HOME/agents/$(basename "$f")"
done
# Skills (decision 0017: one per job, named zi-<old command name>). kit/skills/domains/ and kit/skills/workflows/ are reserved for domain and workflow
# skills (OPERATING-MODEL §3), which /kit-setup copies into projects; they are never installed per machine.
for d in "$KIT_ROOT"/kit/skills/*/; do
  name="$(basename "$d")"
  [[ "$name" == "domains" || "$name" == "workflows" ]] && continue
  place "${d%/}" "$CLAUDE_HOME/skills/$name"
done

# Up to kit 0.2.0 the kit installed 23 slash commands into ~/.claude/commands/. Remove the kit's own copies only:
# a symlink that points into a kit's commands folder is removed; a regular file of the same name (a --copy install)
# that matches the old kit copy or calls the kit's scripts is moved to ~/.claude/kit-backup/, never deleted.
# Anything else is left alone. This runs before ~/.claude/kit is replaced, so the old copy can still be compared.
OLD_COMMANDS=(architecture bootstrap dashboard docs fix implement incident investigate migrate new-feature new-skill
  plan refactor research retro review run security start status sync ui work)
moved=0
for n in "${OLD_COMMANDS[@]}"; do
  f="$CLAUDE_HOME/commands/$n.md"
  if [[ -L "$f" ]]; then
    case "$(readlink "$f")" in */kit/commands/"$n".md) rm -f "$f"; moved=$((moved + 1)) ;; esac
  elif [[ -f "$f" ]] && { cmp -s "$f" "$CLAUDE_HOME/kit/commands/$n.md" || grep -Eq '\.claude/kit/|lane\.js|scripts/sync\.sh' "$f"; }; then
    backup="$CLAUDE_HOME/kit-backup/commands-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup"; mv "$f" "$backup/"; moved=$((moved + 1))
  fi
done
if (( moved > 0 )); then
  cat <<'MAP'
The kit's slash commands are now skills with the prefix zi- (decision 0017): /run -> /zi-run, /plan -> /zi-plan,
/review -> /zi-review, /status -> /zi-status, /fix -> /zi-fix, ... every command keeps its name after zi-.
MAP
  echo "removed $moved old kit command file(s) from $CLAUDE_HOME/commands"
fi
place "$KIT_ROOT/kit" "$CLAUDE_HOME/kit"

# Scripts need Node.js 20 or newer (no npm packages); verify once.
if ! command -v node >/dev/null; then
  echo "node (v20 or newer) is required for kit scripts" >&2; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "node v20 or newer is required for kit scripts (found $(node -v))" >&2; exit 1
fi

# The launcher: agents run kit scripts as `kit <script> ...`, which the project's `Bash(kit *)` rule approves (#63).
# Written in place of any earlier launcher (a fresh file, not through a link), always pointing at this install.
mkdir -p "$BIN_DIR"
launcher_src="$(cat "$KIT_ROOT/kit/bin/kit.in")"
printf '%s\n' "${launcher_src//@KIT_DIR@/$CLAUDE_HOME/kit}" > "$LAUNCHER.tmp.$$"
chmod 755 "$LAUNCHER.tmp.$$"
mv -f "$LAUNCHER.tmp.$$" "$LAUNCHER"
on_path="$(PATH="$PATH" command -v kit || true)"
if [[ "$on_path" != "$LAUNCHER" ]]; then
  echo "warning: 'kit' on your PATH is ${on_path:-missing}, not $LAUNCHER. Add $BIN_DIR to PATH (before any other kit) so agents can run the kit's scripts." >&2
fi

# Projects set up by an older kit version keep hooks that point at scripts that no longer exist; say so.
node "$KIT_ROOT/kit/scripts/check_projects.js" --kit "$KIT_ROOT/kit" || true

echo "agent-kit $(cat "$KIT_ROOT/VERSION") installed into $CLAUDE_HOME ($MODE)"
echo "agents:   $(ls "$KIT_ROOT"/kit/agents/*.md 2>/dev/null | wc -l | tr -d ' ')"
echo "launcher: $LAUNCHER"
echo "skills:   $(for d in "$KIT_ROOT"/kit/skills/*/; do n="$(basename "$d")"; [[ "$n" == domains || "$n" == workflows ]] || echo "$n"; done | wc -l | tr -d ' ')"
