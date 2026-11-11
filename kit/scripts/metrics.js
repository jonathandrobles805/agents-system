#!/usr/bin/env node
// Metrics from telemetry, and from nothing else (KIT-SPEC 9.4, decision 0010).
//
// Reads the collector's store ($CLAUDE_HOME/kit-telemetry/*.jsonl) and reports, per lane or per project: cost (sum of
// cost_usd on claude_code.api_request events), tokens by type, API requests and errors, tool calls by tool and outcome,
// models, and the time range covered. Every figure carries its source. A lane with no records gets null and
// source "telemetry-missing"; nothing is ever derived from .events.jsonl, durations or a price table.
//
//   node metrics.js lane <slug> [--project <name>] [--json]
//   node metrics.js project <name> [--json]
//   node metrics.js --dir <store dir>   (tests)
import fs from 'node:fs';
import path from 'node:path';
import { ArgumentParser } from './args.js';
import * as K from './kitlib.js';
import { storeDir } from '../telemetry/collector.js';

export const SOURCE = 'telemetry';
export const MISSING = 'telemetry-missing';

/** Every record in the store, oldest file first. Malformed lines are counted, not thrown. */
export function readStore(dir = storeDir()) {
  const out = [];
  let bad = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return { records: out, bad, files: 0 };
  }
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        bad++;
      }
    }
  }
  return { records: out, bad, files: files.length };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const cents = (x) => Math.round(x * 100) / 100;

/** Aggregate a set of records (already filtered to one lane or project). Pure. */
export function aggregate(records) {
  const a = {
    source: SOURCE,
    cost_usd: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    api_requests: 0,
    api_errors: 0,
    tool_calls: {},
    models: {},
    sessions: new Set(),
    first: null,
    last: null,
    records: records.length,
  };
  for (const r of records) {
    const ts = r.ts ?? r.received ?? null;
    if (ts) {
      if (!a.first || ts < a.first) a.first = ts;
      if (!a.last || ts > a.last) a.last = ts;
    }
    const sid = r.attributes?.['session.id'] ?? r.resource?.['session.id'];
    if (sid) a.sessions.add(sid);
    if (r.signal !== 'log') continue;
    const at = r.attributes ?? {};
    const ev = String(r.event ?? '');
    if (ev.endsWith('api_request')) {
      a.api_requests++;
      const c = num(at.cost_usd);
      if (c != null) a.cost_usd += c;
      a.tokens.input += num(at.input_tokens) ?? 0;
      a.tokens.output += num(at.output_tokens) ?? 0;
      a.tokens.cache_read += num(at.cache_read_tokens) ?? 0;
      a.tokens.cache_creation += num(at.cache_creation_tokens) ?? 0;
      if (at.model) a.models[at.model] = (a.models[at.model] ?? 0) + 1;
    } else if (ev.endsWith('api_error')) {
      a.api_errors++;
    } else if (ev.endsWith('tool_result')) {
      const name = at.tool_name ?? at.name ?? 'unknown';
      const t = (a.tool_calls[name] ??= { ok: 0, failed: 0 });
      if (at.success === false || at.success === 'false') t.failed++;
      else t.ok++;
    }
  }
  a.cost_usd = cents(a.cost_usd);
  a.sessions = a.sessions.size;
  return a;
}

/** The empty answer: never a number. */
export function missing(why) {
  return { source: MISSING, cost_usd: null, tokens: null, api_requests: null, api_errors: null, tool_calls: null, models: null, sessions: 0, first: null, last: null, records: 0, why };
}

const byLane = (slug, project) => (r) => r.resource?.['kit.lane'] === slug && (!project || r.resource?.['kit.project'] === project);
const byProject = (project) => (r) => r.resource?.['kit.project'] === project;

export function laneMetrics(slug, { project = null, dir = storeDir() } = {}) {
  const { records, files } = readStore(dir);
  if (!files) return missing('no telemetry store; the lane session ran with the exporter off or the collector was not running');
  const mine = records.filter(byLane(slug, project));
  if (!mine.length) return missing(`no telemetry records for lane ${slug}; exporter off, collector down, or OTEL_RESOURCE_ATTRIBUTES missing kit.lane`);
  return aggregate(mine);
}

export function projectMetrics(project, { dir = storeDir() } = {}) {
  const { records, files } = readStore(dir);
  if (!files) return missing('no telemetry store');
  const mine = records.filter(byProject(project));
  if (!mine.length) return missing(`no telemetry records for project ${project}`);
  const agg = aggregate(mine);
  const lanes = {};
  for (const r of mine) {
    const l = r.resource?.['kit.lane'];
    if (l) (lanes[l] ??= []).push(r);
  }
  agg.lanes = Object.fromEntries(Object.entries(lanes).map(([l, rs]) => [l, { cost_usd: aggregate(rs).cost_usd, records: rs.length }]));
  return agg;
}

function fmt(m, label) {
  if (m.source === MISSING) return `${label}: cost n/a (${m.source}: ${m.why})\n`;
  const tools = Object.entries(m.tool_calls).map(([t, c]) => `${t} ${c.ok}${c.failed ? `/${c.failed} failed` : ''}`).join(', ') || 'none';
  return `${label}: $${m.cost_usd.toFixed(2)} (${m.source}; API-equivalent, Claude Code's approximate figure; on a subscription this is not what you pay) · ${m.api_requests} API requests, ${m.api_errors} errors · tokens in ${m.tokens.input} out ${m.tokens.output} cache ${m.tokens.cache_read}/${m.tokens.cache_creation} · tools: ${tools} · models: ${Object.keys(m.models).join(', ') || 'none'} · ${m.first ?? '?'} → ${m.last ?? '?'}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const ap = new ArgumentParser({ prog: 'metrics.js' });
  ap.addArgument('scope', { choices: ['lane', 'project'] });
  ap.addArgument('name');
  ap.addArgument('--project');
  ap.addArgument('--dir');
  ap.addArgument('--json', { action: 'store_true' });
  const a = ap.parseArgs(argv);
  const dir = a.dir || storeDir();
  const m = a.scope === 'lane' ? laneMetrics(a.name, { project: a.project ?? null, dir }) : projectMetrics(a.name, { dir });
  process.stdout.write(a.json ? K.jsonDumps(m, { indent: 2 }) + '\n' : fmt(m, `${a.scope} ${a.name}`));
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
