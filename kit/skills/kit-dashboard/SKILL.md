---
name: kit-dashboard
description: "Use when you want to watch the kit live. Starts the dashboard for this project (or every project with --all): where each feature is, lane details, and hook events as they happen."
argument-hint: "[--all] [--port 8765]"
allowed-tools: Bash
---

Start the dashboard server in the background and open it:
```
nohup node "$HOME/.claude/kit/dashboard/server.js" --repo "$PWD" $ARGUMENTS > .claude/session/dashboard.log 2>&1 &
sleep 1; tail -2 .claude/session/dashboard.log
```
Tell the human the URL (default http://127.0.0.1:8765/). For a static copy that CI can publish: `node "$HOME/.claude/kit/scripts/kit_status.js" --repo "$PWD" --out status.json` next to `index.html`.

Everything on the page is read from files and git; nothing on it is an agent's claim.
