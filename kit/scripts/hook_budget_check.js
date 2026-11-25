#!/usr/bin/env node
// PostToolUse on every tool inside a lane: enforce the lane's time and tool-call budget.
// On exceed: write an Escalation into progress.md (if not present) and return a block decision.
// The stage, its clock and its budget are read from the lane store (.claude/session/lanes/<slug>.json in the main
// checkout, written only by lane.js advance; hardening plan Step 2), never from the lane's own lane.json, which the
// lane can rewrite. A lane started before the store falls back to lane.json until its first move:
// lane.json: {"feature": "...", "stage": "build", "started": "<iso>", "budget": {"hours": 4, "tool_calls": 800},
//             "budget_override": {"review": {"hours": 4, "tool_calls": 400}}}   (a human's raise; survives lane.js advance)
import fs from 'node:fs';
import path from 'node:path';
import * as K from './kitlib.js';

const DEFAULT_BUDGET = {
  research: { hours: 1, tool_calls: 200 },
  plan: { hours: 1, tool_calls: 200 },
  build: { hours: 4, tool_calls: 800 },
  review: { hours: 1, tool_calls: 200 },
};

/**
 * Where a human raises a stage's budget, and the only place one is read from (#41): lane.json budget_override.<stage>.
 * The hook merges it over the stage budget on every call, and lane.js advance merges it again when the stage changes,
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
  // The budget is the lane's, not the session's: elapsed hours come from the lane store, so any session
  // working on the lane is over budget once the lane is. A subagent reports the main repo as cwd, which is how
  // 6h43m ran against a 1-hour budget with no event.
  const r = K.laneForHook(d);
  if (r.via === 'ambiguous') {
    return K.feedbackBlock(`budget check: ${r.slugs.length} lanes are open (${r.slugs.join(', ')}) and this call reports no worktree, so no budget can be attributed to it. Work from the lane's worktree, or finish the other lanes first.`);
  }
  const lane = r.lane;
  if (!lane) return 0;
  const rec = K.laneStoreRecord(lane);
  const inStore = Boolean(rec && typeof rec.stage === 'string');
  const clock = inStore ? K.storeClock(rec) : null;
  const stage = inStore ? rec.stage : lane.data.stage ?? 'build';
  // the stage's start: the store's (a move that re-enters the stage does not restart it); lane.json's for a legacy lane
  const started = inStore ? clock.stage_started : lane.data.started;
  const stored = inStore && rec.budget && typeof rec.budget === 'object' ? rec.budget : inStore ? {} : lane.data.budget;
  const override = lane.data.budget_override && typeof lane.data.budget_override === 'object' ? lane.data.budget_override[stage] : null;
  const budget = {
    ...(Object.hasOwn(DEFAULT_BUDGET, stage) ? DEFAULT_BUDGET[stage] : DEFAULT_BUDGET.build),
    ...stored,
    ...(override && typeof override === 'object' ? override : {}),
  };
  // #41: one counter per lane, stage and that stage's start. It was one file per session_id that nothing reset, so
  // every stage after the first was measured against the lane's lifetime calls while its hours ran from its own start.
  // A stage entered again (review → build) starts a new count, as its clock does.
  const key = `${stage}.${String(started ?? 'unstarted')}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  const counter = path.join(lane.root, K.SESSION_DIR, `budget.${key}.calls`);
  fs.mkdirSync(path.dirname(counter), { recursive: true });
  const n = (K.isFile(counter) ? parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0 : 0) + 1;
  fs.writeFileSync(counter, String(n));
  const hours = inStore ? clock.stage_hours ?? 0 : K.hoursSince(started);
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
