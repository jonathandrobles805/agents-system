#!/usr/bin/env bash
# kit-skill-probe.sh: Step 0b of the commands -> skills plan (decision 0017).
# Answers six questions about how Claude Code treats skill frontmatter, before the kit relies on it.
#
# Safe by design:
# - Everything happens in a new temporary folder (printed at the start). Your repos are not touched.
# - The only thing created outside it is ONE symlink, ~/.claude/skills/kit-probe-link, for question 4.
#   It is created only if that name is free, and removed when the script ends (also on Ctrl-C).
# - Uses your signed-in Claude Code, about 6 short headless runs (a few cents of usage).
#
# Usage: bash docs/research/claude-code-skill-probe.sh   (from anywhere; it works in its own temporary folder)
# Output: a results file whose path is printed at the end. Send it back (or paste it) to continue.

set -u

if ! command -v claude >/dev/null 2>&1; then echo "claude is not on PATH" >&2; exit 1; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/kit-skill-probe.XXXXXX")"
P="$WORK/project"
LOGS="$WORK/logs"
RESULTS="$WORK/claude-code-skill-probe.md"
LINK="$HOME/.claude/skills/kit-probe-link"
MADE_SKILLS_DIR=0
MADE_LINK=0

cleanup() {
  if [ "$MADE_LINK" = 1 ] && [ -L "$LINK" ]; then rm -f "$LINK"; fi
  if [ "$MADE_SKILLS_DIR" = 1 ]; then rmdir "$HOME/.claude/skills" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

mkdir -p "$P/.claude/skills" "$P/.claude/agents" "$LOGS" "$WORK/linked/kit-probe-link"
cd "$P" || exit 1
git init -q . 2>/dev/null || true

echo "Probe folder: $WORK"

# ---------- test fixtures (all inside the probe folder) ----------

cat > .claude/agents/probe-writer.md <<'EOF'
---
name: probe-writer
description: Writes one file the caller names, with the content the caller gives. Used only by the kit skill probe.
tools: Write
---
Write exactly the file the caller names, with exactly the content given. Do nothing else.
EOF

mkdir -p .claude/skills/kit-probe-q1
cat > .claude/skills/kit-probe-q1/SKILL.md <<'EOF'
---
name: kit-probe-q1
description: "Probe only. Checks whether disallowed-tools reaches subagents."
disallowed-tools: Edit, Write
---
Do these steps in order and do not skip any.
1. Use the Write tool yourself to create the file main.txt containing the word main. If the tool is not available to you, say "Write unavailable in main session" and continue.
2. Use the Agent tool to run the probe-writer subagent with this instruction: "Create the file sub.txt containing the word sub."
3. Report which files exist now.
EOF

mkdir -p .claude/skills/kit-probe-restrict
cat > .claude/skills/kit-probe-restrict/SKILL.md <<'EOF'
---
name: kit-probe-restrict
description: "Probe only. A skill that removes Edit and Write while it is active."
disallowed-tools: Edit, Write
---
Reply with the words "restricted skill loaded". Do nothing else.
EOF

mkdir -p .claude/skills/kit-probe-outer
cat > .claude/skills/kit-probe-outer/SKILL.md <<'EOF'
---
name: kit-probe-outer
description: "Probe only. Checks whether a restriction outlasts the skill that set it."
---
Do these steps in order and do not skip any.
1. Invoke the skill kit-probe-restrict with the Skill tool and follow it.
2. After that, use the Write tool to create the file after.txt containing the word after. If the tool is not available to you, say "Write unavailable after restricted skill".
3. Report whether after.txt exists.
EOF

mkdir -p .claude/skills/kit-probe-dmi
cat > .claude/skills/kit-probe-dmi/SKILL.md <<'EOF'
---
name: kit-probe-dmi
description: "Probe only. Checks that a user-only skill still runs when started by name."
disable-model-invocation: true
---
Use the Write tool to create the file dmi.txt containing the word dmi. Then reply "done".
EOF

mkdir -p .claude/skills/kit-probe-args
cat > .claude/skills/kit-probe-args/SKILL.md <<'EOF'
---
name: kit-probe-args
description: "Probe only. Checks named argument substitution."
arguments: [slug]
---
Use the Write tool to create the file named arg-$slug.txt containing the word arg. Then reply with the file name you created.
EOF

cat > "$WORK/linked/kit-probe-link/SKILL.md" <<'EOF'
---
name: kit-probe-link
description: "Probe only. Checks that a symlinked personal skill folder is discovered."
---
Use the Write tool to create the file link.txt containing the word link. Then reply "done".
EOF

mkdir -p .claude/skills/kit-probe-perm sub
cat > mark.sh <<'EOF'
#!/usr/bin/env bash
# leaves proof that a command really ran: <name>.txt next to this script
touch "$(cd "$(dirname "$0")" && pwd)/$1.txt"
EOF
chmod +x mark.sh
cat > .claude/skills/kit-probe-perm/SKILL.md <<'EOF'
---
name: kit-probe-perm
description: "Probe only. Checks which Bash commands a skill's allowed-tools patterns approve in a headless run."
allowed-tools: Bash(./mark.sh p1*), Bash(cd *), Bash(../mark.sh p3*), Bash(bash "$PWD/mark.sh" p4*)
---
Run each of these four commands with the Bash tool, exactly as written, one per call, even if an earlier one is refused. Then report which ran and which were refused.
1. `./mark.sh p1 extra`
2. `./mark.sh p2`
3. `cd sub && ../mark.sh p3`
4. `bash "$PWD/mark.sh" p4`
EOF

# ---------- runner ----------

TO=""
if command -v timeout >/dev/null 2>&1; then TO="timeout 300"; elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 300"; fi

run() { # run <name> <prompt>
  local name="$1" prompt="$2"
  echo "  running $name ..."
  # acceptEdits lets file writes happen without a prompt; the skill's own frontmatter is what is being tested.
  $TO claude -p "$prompt" --permission-mode acceptEdits --allowedTools "Skill,Agent,Read,Write,Edit" --max-turns 12 \
    > "$LOGS/$name.out.txt" 2> "$LOGS/$name.err.txt" < /dev/null
  echo "$?" > "$LOGS/$name.exit.txt"
}
has() { [ -f "$P/$1" ] && echo yes || echo no; }

# ---------- the five questions ----------

VERSION="$(claude --version 2>/dev/null | head -1)"
echo "Claude Code: $VERSION"

echo "Q1 disallowed-tools vs subagents"
run q1 "/kit-probe-q1"

echo "Q2 does the restriction outlast the skill"
run q2 "/kit-probe-outer"

echo "Q3 disable-model-invocation, started by name in a headless run"
run q3 "/kit-probe-dmi"

echo "Q4 symlinked personal skill folder"
Q4_NOTE=""
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  Q4_NOTE="skipped: $LINK already exists, left untouched"
else
  if [ ! -d "$HOME/.claude/skills" ]; then mkdir -p "$HOME/.claude/skills" && MADE_SKILLS_DIR=1; fi
  ln -s "$WORK/linked/kit-probe-link" "$LINK" && MADE_LINK=1
  run q4 "/kit-probe-link"
fi

echo "Q5 arguments: [slug] substitution"
run q5 "/kit-probe-args hello"

echo "Q6 which Bash commands a skill's allowed-tools approve (headless, default permissions)"
# no --allowedTools and default mode here: only the skill's own allowed-tools can approve a command
$TO claude -p "/kit-probe-perm" --permission-mode default --max-turns 12 > "$LOGS/q6.out.txt" 2> "$LOGS/q6.err.txt" < /dev/null
echo "$?" > "$LOGS/q6.exit.txt"

# ---------- results ----------

ex() { cat "$LOGS/$1.exit.txt" 2>/dev/null || echo "-"; }
{
  echo "# Claude Code skill probe (decision 0017, Step 0b)"
  echo
  echo "Date: $(date '+%Y-%m-%d %H:%M %Z') · Claude Code: $VERSION · OS: $(uname -sr)"
  echo "Each run: \`claude -p \"/<skill>\" --permission-mode acceptEdits --allowedTools \"Skill,Agent,Read,Write,Edit\"\` in a fresh temporary project."
  echo
  echo "| # | Question | Observed | Good for the kit when | Exit |"
  echo "|---|---|---|---|---|"
  echo "| 1a | Main session under \`disallowed-tools: Edit, Write\` can still write | main.txt: $(has main.txt) | no | $(ex q1) |"
  echo "| 1b | A subagent started from that skill can still write | sub.txt: $(has sub.txt) | yes | $(ex q1) |"
  echo "| 2 | Write works again later in the same turn, after a restricted skill ran | after.txt: $(has after.txt) | yes (no means the restriction leaks into the orchestrator) | $(ex q2) |"
  echo "| 3 | A \`disable-model-invocation: true\` skill runs when started as \`claude -p \"/name\"\` | dmi.txt: $(has dmi.txt) | yes | $(ex q3) |"
  if [ -n "$Q4_NOTE" ]; then
    echo "| 4 | A symlinked folder in \`~/.claude/skills\` is discovered | $Q4_NOTE | yes | - |"
  else
    echo "| 4 | A symlinked folder in \`~/.claude/skills\` is discovered | link.txt: $(has link.txt) | yes | $(ex q4) |"
  fi
  echo "| 5 | \`arguments: [slug]\` substitutes \`\$slug\` | arg-hello.txt: $(has arg-hello.txt) | yes | $(ex q5) |"
  echo "| 6a | \`Bash(./mark.sh p1*)\` approves \`./mark.sh p1 extra\` | p1.txt: $(has p1.txt) | yes | $(ex q6) |"
  echo "| 6b | A command no pattern matches is refused (\`./mark.sh p2\`) | p2.txt: $(has p2.txt) | no | $(ex q6) |"
  echo "| 6c | \`cd sub && ../mark.sh p3\` runs when each part has a pattern | p3.txt: $(has p3.txt) | yes | $(ex q6) |"
  echo "| 6d | A pattern with a literal \`\$PWD\` matches the same literal command | p4.txt: $(has p4.txt) | yes | $(ex q6) |"
  echo
  echo "Files in the probe project: $(cd "$P" && ls -1 *.txt 2>/dev/null | tr '\n' ' ')"
  echo
  echo "Not covered by this script, check by hand: open \`claude\` in $P and type \`/kit-probe-dmi\` (Q3 typed). It should create dmi.txt; delete dmi.txt first if it exists."
  echo
  echo "## Raw output"
  for q in q1 q2 q3 q4 q5 q6; do
    [ -f "$LOGS/$q.out.txt" ] || continue
    echo
    echo "### $q (exit $(ex $q))"
    echo '```'
    cat "$LOGS/$q.out.txt"
    if [ -s "$LOGS/$q.err.txt" ]; then echo "--- stderr ---"; cat "$LOGS/$q.err.txt"; fi
    echo '```'
  done
} > "$RESULTS"

echo
echo "Done. Results: $RESULTS"
echo "Send that file back to continue. The probe folder can be deleted afterwards: rm -rf \"$WORK\""
