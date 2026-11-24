#!/usr/bin/env node
// PostToolUse on every tool inside a lane: enforce the lane's time and tool-call budget.
// On exceed: write an Escalation into progress.md (if not present) and return a block decision.
// lane.json: {"feature": "...", "stage": "build", "started": "<iso>", "budget": {"hours": 4, "tool_calls": 800},
//             "budget_override": {"review": {"hours": 4, "tool_calls": 400}}}   (a human's raise; survives lane.js stage)
import fs from 'node:fs';
import path from 'node:path';
import * as K from './kitlib.js';

const DEFAULT_BUDGET = {
  research: { hours: 1, tool_calls: 200 },
  plan: { hours: 1, tool_calls: 200 },
  build: { hours: 4, tool_calls: 800 },
  review: { hours: 1, tool_calls: 200 },
};

/** Hours since `started` ("YYYY-MM-DD[THH:MM[:SS[.ffffff]]]", local wall-clock time as /zi-implement writes it); 0 when it does not parse. */
function hoursSince(started) {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?)?$/.exec(typeof started === 'string' ? started : '');
  if (!m) return 0;
  const [y, mo, day, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0));
  const ms = Math.floor(Number(`0.${m[7] ?? 0}`) * 1000);
  const t = new Date(Date.UTC(y, mo - 1, day, h, mi, s, ms)); // wall-clock arithmetic: no time zone or DST involved
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== day || t.getUTCHours() !== h) return 0;
  const n = new Date();
  const nowWall = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds());
  return (nowWall - t) / 3.6e6;
}

/**
 * Where a human raises a stage's budget, and the only place one is read from (#41): lane.json budget_override.<stage>.
 * The hook merges it over the stage budget on every call, and lane.js stage merges it again when the stage changes,
 * so a raise is neither lost on the next stage change nor delayed until one. Nothing reads a budget from the spec.
 */
export function raiseHint(lane, stage) {
  return `raise budget_override.${stage} (tool_calls, hours) in ${K.relTo(lane.root, path.join(lane.root, K.LANE_FILE))}, or split the feature`;
}

export function ensureEscalation(progress, reason, needs = 'a human to raise the budget in lane.json budget_override, or split the feature') {
  const text = K.isFile(progress) ? fs.readFileSync(progress, 'utf8').replace(/\r\n?/g, '\n') : '# Progress\n\n## Escalation\n';
  if (/^- Attempts:/m.test(text) && text.toLowerCase().includes('budget')) return;
  const block = `\n## Escalation\n\n- Attempts: n/a of 3\n- Failure: ${reason}\n- Tried: see events log\n- Needs: a human to ${needs}\n`;
  fs.mkdirSync(path.dirname(progress), { recursive: true });
  fs.writeFileSync(progress, text.trimEnd() + '\n' + block);
}

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  // The budget is the lane's, not the session's: elapsed hours come from lane.json `started`, so any session
  // working on the lane is over budget once the lane is. A subagent reports the main repo as cwd, which is how
  // 6h43m ran against a 1-hour budget with no event.
  const r = K.laneForHook(d);
  if (r.via === 'ambiguous') {
    return K.feedbackBlock(`budget check: ${r.slugs.length} lanes are open (${r.slugs.join(', ')}) and this call reports no worktree, so no budget can be attributed to it. Work from the lane's worktree, or finish the other lanes first.`);
  }
  const lane = r.lane;
  if (!lane) return 0;
  const stage = lane.data.stage ?? 'build';
  const override = lane.data.budget_override && typeof lane.data.budget_override === 'object' ? lane.data.budget_override[stage] : null;
  const budget = {
    ...(Object.hasOwn(DEFAULT_BUDGET, stage) ? DEFAULT_BUDGET[stage] : DEFAULT_BUDGET.build),
    ...lane.data.budget,
    ...(override && typeof override === 'object' ? override : {}),
  };
  // #41: one counter per lane, stage and that stage's start. It was one file per session_id that nothing reset, so
  // every stage after the first was measured against the lane's lifetime calls while its hours ran from its own start.
  // lane.js stage writes a new `started`, so a stage that is re-entered starts a new count, as its clock does.
  const key = `${stage}.${String(lane.data.started ?? 'unstarted')}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  const counter = path.join(lane.root, K.SESSION_DIR, `budget.${key}.calls`);
  fs.mkdirSync(path.dirname(counter), { recursive: true });
  const n = (K.isFile(counter) ? parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0 : 0) + 1;
  fs.writeFileSync(counter, String(n));
  const hours = hoursSince(lane.data.started);
  const over = [];
  if (n > Math.trunc(Number(budget.tool_calls ?? 1e9))) over.push(`${n} tool calls > budget ${budget.tool_calls}`);
  if (hours > Number(budget.hours ?? 1e9)) over.push(`${hours.toFixed(1)}h elapsed > budget ${budget.hours}h`);
  if (!over.length) return 0;
  const reason = `budget exceeded for stage '${stage}': ` + over.join('; ');
  const hint = raiseHint(lane, stage);
  ensureEscalation(lane.progressPath, reason, hint);
  K.appendEvent(lane.eventLogPath, { event: 'budget_exceeded', tool: 'hook', result: 'fail', summary: reason });
  return K.feedbackBlock(reason + `.\nStop working. Make sure progress.md Escalation describes the state, then end the turn. A human will ${hint}.`);
}

if (K.isMain(import.meta.url)) process.exitCode = main();
