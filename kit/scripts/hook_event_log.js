#!/usr/bin/env node
// PostToolUse / PostToolUseFailure / SubagentStart / SubagentStop on every tool: append one event line.
// The dashboard reads this file. Agents never write it. Exit 0 always.
import path from 'node:path';
import * as K from './kitlib.js';

const EVENT_BY_TOOL = new Map(Object.entries({
  Read: 'read', NotebookRead: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write',
  Bash: 'bash', Grep: 'search', Glob: 'search', WebFetch: 'web', WebSearch: 'web', Agent: 'subagent', Task: 'subagent',
}));
const SUMMARY_KEYS = ['stdout', 'output', 'content', 'result', 'error', 'message'];

const text = (v) => (typeof v === 'string' ? v : '');
/** First n code points. */
const clip = (s, n) => Array.from(s.slice(0, 2 * n)).slice(0, n).join('');
/** Python truthiness: empty objects and arrays count as absent. */
const present = (v) => (v && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v));

const firstLine = (s) => {
  s = s.trim();
  return s ? clip(K.splitlines(s)[0], 200) : '';
};

function summarize(x) {
  if (x === null || x === undefined) return '';
  if (typeof x === 'string') return firstLine(x);
  if (typeof x === 'object' && !Array.isArray(x)) {
    const key = SUMMARY_KEYS.find((k) => typeof x[k] === 'string');
    return key ? firstLine(x[key]) : clip(JSON.stringify(x), 200);
  }
  return firstLine(typeof x === 'object' ? JSON.stringify(x) : String(x));
}

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cwd = text(d.cwd) || '.';
  // The log never blocks, so ambiguity is recorded rather than resolved: an event filed against a guessed lane is
  // worse than one that says it could not tell. A subagent reports the main repo as cwd, which is why the field
  // run has 373 events with lane:null and the lane's own events file has no stop events at all.
  const r = K.laneForHook(d);
  const lane = r.lane;
  const root = lane ? lane.root : K.repoRoot(cwd);
  const file = lane ? lane.eventLogPath : path.join(root, '.claude', 'session', 'events.jsonl');
  const ev = text(d.hook_event_name);
  const tool = text(d.tool_name);
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const e = { session_id: d.session_id ?? null, lane: lane ? lane.slug : null, hook: ev, tool };
  if (r.via === 'ambiguous') e.lane_ambiguous = r.slugs;
  if (ev === 'SubagentStart' || ev === 'SubagentStop') {
    e.event = ev === 'SubagentStart' ? 'subagent_start' : 'subagent_stop';
    e.agent = (d.agent_type || d.agent_name) ?? null;
  } else {
    e.event = EVENT_BY_TOOL.get(tool) ?? 'tool';
    const fp = text(ti.file_path) || text(ti.notebook_path);
    if (fp) e.path = K.relTo(root, path.isAbsolute(fp) ? fp : path.join(cwd, fp));
    if (tool === 'Bash') e.command = clip(text(ti.command), 300);
    if (tool === 'Grep' || tool === 'Glob') e.pattern = ti.pattern ?? null;
    e.result = ev === 'PostToolUseFailure' ? 'fail' : 'ok';
    e.summary = summarize(present(d.tool_response) ? d.tool_response : d.error);
  }
  K.appendEvent(file, e);
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
