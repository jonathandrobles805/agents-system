#!/usr/bin/env bash
# Install the agent kit into ~/.claude. Idempotent. Re-run after pulling a new kit version.
#
# Usage: ./install.sh [--copy]
#   default: symlink kit/agents/* and kit/commands/* into ~/.claude, and symlink kit/ as ~/.claude/kit
#   --copy : copy instead of symlink (for machines where ~/.claude must not point outside itself)
set -euo pipefail

KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
MODE="link"
[[ "${1:-}" == "--copy" ]] && MODE="copy"

mkdir -p "$CLAUDE_HOME/agents" "$CLAUDE_HOME/commands"

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
for f in "$KIT_ROOT"/kit/commands/*.md; do
  place "$f" "$CLAUDE_HOME/commands/$(basename "$f")"
done
place "$KIT_ROOT/kit" "$CLAUDE_HOME/kit"

# Scripts need a Python 3 interpreter; verify once.
if ! command -v python3 >/dev/null; then
  echo "python3 is required for kit scripts" >&2; exit 1
fi
python3 -c 'import yaml' 2>/dev/null || echo "note: python3 'pyyaml' not found; install with: pip install pyyaml" >&2

echo "agent-kit $(cat "$KIT_ROOT/VERSION") installed into $CLAUDE_HOME ($MODE)"
echo "agents:   $(ls "$KIT_ROOT"/kit/agents/*.md 2>/dev/null | wc -l | tr -d ' ')"
echo "commands: $(ls "$KIT_ROOT"/kit/commands/*.md 2>/dev/null | wc -l | tr -d ' ')"
