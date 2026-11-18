---
name: zi-dashboard
description: "Start the live agent-kit dashboard for this project (or all registered projects): pipeline positions derived from files and git, lane details, live hook events, and a button to open Claude in a lane's worktree."
argument-hint: "[--all] [--port 8765]"
allowed-tools: Bash
disable-model-invocation: true
---

Start the dashboard server in the background and open it:
```
nohup node "$HOME/.claude/kit/dashboard/server.js" --repo "$PWD" $ARGUMENTS > .claude/session/dashboard.log 2>&1 &
sleep 1; tail -2 .claude/session/dashboard.log
```
Tell the human the URL (default http://127.0.0.1:8765/). For a static copy that CI can publish: `node "$HOME/.claude/kit/scripts/kit_status.js" --repo "$PWD" --out status.json` next to `index.html`.

Everything on the page is read from files and git; nothing on it is an agent's claim.
