#!/usr/bin/env node
// Notification / Stop hook: tell the human something needs them. Desktop notification by default;
// optional webhook from ~/.claude/kit-notify.json: {"webhook": "https://...", "desktop": true}. Exit 0 always.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from './kitlib.js';

const text = (v) => (typeof v === 'string' ? v : '');

function desktop(title, body) {
  const snippet = Array.from(body.slice(0, 400)).slice(0, 200).join('');
  const commands = {
    darwin: ['osascript', ['-e', `display notification "${snippet}" with title "${title}"`]],
    linux: ['notify-send', [title, snippet]],
    win32: ['powershell', ['-c', `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('${snippet}','${title}')`]],
  };
  const command = commands[process.platform];
  if (!command) return;
  try {
    spawnSync(command[0], command[1], { stdio: 'inherit', timeout: 5000 });
  } catch { /* a title the OS cannot accept (e.g. a NUL byte) must never fail the hook */ }
}

export async function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  // one resolver for every lane-scoped hook (#29); notification text only, so ambiguity just means no lane name
  const lane = K.laneForHook(d).lane;
  const cfgPath = path.join(process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude'), 'kit-notify.json');
  let cfg = {};
  if (K.isFile(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {
      cfg = {};
    }
  }
  if (!cfg || typeof cfg !== 'object') cfg = {};
  let title, body;
  if (d.hook_event_name === 'Notification') {
    title = 'Claude needs you';
    body = text(d.message) || text(d.notification_type) || 'waiting for input';
  } else if (d.hook_event_name === 'Stop' && lane) {
    const prog = K.isFile(lane.progressPath) ? fs.readFileSync(lane.progressPath, 'utf8') : '';
    const state = prog.includes('- Attempts:') && !prog.includes('{{') ? 'escalated' : 'stopped';
    title = `Lane ${lane.slug}: ${state}`;
    body = 'Check /kit-status or the dashboard.';
  } else {
    return 0;
  }
  if (Object.hasOwn(cfg, 'desktop') ? cfg.desktop : true) desktop(title, body);
  if (cfg.webhook && typeof cfg.webhook === 'string') {
    try {
      const res = await fetch(cfg.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: K.jsonDumps({ text: `${title}: ${body}` }),
        signal: AbortSignal.timeout(5000),
      });
      await res.body?.cancel();
    } catch {
      // a notification that cannot be delivered must never fail the hook
    }
  }
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = await main();
