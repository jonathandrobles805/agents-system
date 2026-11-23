#!/usr/bin/env node
// Eval harness (KIT-SPEC 11A, decision 0012): runs benchmark tasks through a runner, scores each outcome, compares
// with the committed baseline, and fails on a hard-metric violation (smoke and full) or a regression (full).
//
//   node kit/eval/harness.js run --set smoke|full [--runner claude|fixture] [--n N] [--baseline <file>] [--touched a,b,c] [--out <dir>] [--json]
//   node kit/eval/harness.js baseline --from <results dir> --out kit/eval/baselines/<version>.json   (fixture results are refused)
//   node kit/eval/harness.js list
//
// Smoke: one task per core role plus one per workflow kind whose files the change touched (--touched), N=1, hard
// metrics only. Full: every task, N=3; a regression is a mean drop beyond the baseline's standard deviation on any
// metric. Every result is written with the runner that produced it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgumentParser } from '../scripts/args.js';
import * as K from '../scripts/kitlib.js';
import { score } from './score.js';
import * as fixtureRunner from './runners/fixture.js';
import * as claudeRunner from './runners/claude.js';

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CORE_ROLES = ['researcher', 'planner', 'spec-critic', 'tester', 'implementer', 'reviewer', 'retro'];
export const RUNNERS = { fixture: fixtureRunner, claude: claudeRunner };
export const METRICS = ['score', 'rubric_score', 'hard_ok'];

/** Every task.json under benchmarks/, validated. */
export function loadTasks(dir = path.join(EVAL_DIR, 'benchmarks')) {
  const tasks = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'task.json') {
        const t = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const k of ['id', 'goal']) if (typeof t[k] !== 'string' || !t[k]) throw new Error(`${p}: missing ${k}`);
        if (!Array.isArray(t.checks)) throw new Error(`${p}: checks must be a list`);
        if (!Array.isArray(t.rubric)) throw new Error(`${p}: rubric must be a list`);
        for (const c of t.rubric) if (!c.id || !c.text) throw new Error(`${p}: rubric items need id and text`);
        t.path = path.relative(EVAL_DIR, p);
        tasks.push(t);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/** Which tasks a set runs. Smoke: one per core role (tagged smoke) plus one per touched workflow kind. */
export function selectTasks(tasks, set, touched = []) {
  if (set === 'full') return tasks;
  const picked = new Map();
  for (const role of CORE_ROLES) {
    const t = tasks.find((x) => x.role === role && (x.tags ?? []).includes('smoke')) ?? tasks.find((x) => x.role === role);
    if (t) picked.set(t.id, t);
  }
  const kinds = new Set();
  for (const f of touched) {
    const m = /kit\/(?:workflows|skills\/workflows)\/([a-z-]+)/.exec(f);
    if (m) kinds.add(m[1]);
  }
  for (const kind of kinds) {
    const t = tasks.find((x) => x.kind === kind && (x.tags ?? []).includes('smoke')) ?? tasks.find((x) => x.kind === kind);
    if (t) picked.set(t.id, t);
  }
  return [...picked.values()];
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Per-task metric series from attempts. */
export function summarize(attempts) {
  const series = { score: [], rubric_score: [], hard_ok: [] };
  for (const a of attempts) {
    series.score.push(a.scored.score);
    series.rubric_score.push(a.scored.rubric.score);
    series.hard_ok.push(a.scored.hard_ok ? 1 : 0);
  }
  const out = {};
  for (const m of METRICS) out[m] = { mean: mean(series[m]), std: std(series[m]), n: series[m].length };
  return out;
}

/**
 * Compare a run with a baseline. A regression on a metric: run mean < baseline mean − max(baseline std, floor).
 * The floor (default 0.05) keeps a zero-variance baseline from flagging noise.
 */
export function compare(results, baseline, { floor = 0.05 } = {}) {
  const regressions = [];
  for (const [id, r] of Object.entries(results)) {
    const b = baseline?.tasks?.[id];
    if (!b) continue;
    for (const m of METRICS) {
      const bm = b[m];
      if (!bm) continue;
      const allowed = Math.max(bm.std ?? 0, floor);
      if (r.summary[m].mean < bm.mean - allowed) regressions.push({ task: id, metric: m, baseline: bm.mean, run: r.summary[m].mean, allowed });
    }
  }
  return regressions;
}

export async function runSet({ set, runner = 'fixture', n = set === 'full' ? 3 : 1, touched = [], baseline = null, out = null, tasksDir, variant = undefined }) {
  const R = RUNNERS[runner];
  if (!R) throw new Error(`unknown runner '${runner}'`);
  const avail = R.available();
  if (!avail.ok) return { ok: false, error: `runner ${runner} unavailable: ${avail.why}`, results: {}, violations: [], regressions: [] };
  const tasks = selectTasks(loadTasks(tasksDir), set, touched);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${set}-${runner}`;
  const outDir = out ?? path.join(EVAL_DIR, 'results', runId);
  fs.mkdirSync(outDir, { recursive: true });
  const results = {};
  const violations = [];
  for (const task of tasks) {
    const attempts = [];
    for (let i = 0; i < n; i++) {
      // a real session's transcripts are kept beside the report (redacted), so a verdict can be traced to what the agent did
      const transcripts = path.join(outDir, 'transcripts', task.id, `attempt-${i}`);
      const outcome = await R.run(task, { attempt: i, transcripts, ...(variant ? { variant } : {}) });
      const scored = score(task, outcome);
      // the worker session's exit status and the tail of its stderr travel with the attempt: a session that never
      // started (no sandbox, no credential, a refused token) must be diagnosable from the report alone
      const worker = { status: outcome.worker_status ?? null, signal: outcome.worker_signal ?? null, error: outcome.worker_error ?? null, stderr: String(outcome.worker_stderr ?? '').slice(-2000) };
      if (outcome.worker_command) worker.command = outcome.worker_command;
      if ('worker_agent' in outcome) worker.agent = outcome.worker_agent;
      const warnings = outcome.warnings ?? [];
      const rel = (files) => (files ?? []).map((f) => path.relative(outDir, f));
      const kept = outcome.transcripts ? { transcripts: { worker: rel(outcome.transcripts.worker), judge: rel(outcome.transcripts.judge) } } : {};
      attempts.push({ attempt: i, runner: outcome.runner, variant: outcome.variant ?? null, ms: outcome.ms, worker, judge_session: outcome.judge_session ?? null, ...kept, ...(warnings.length ? { warnings } : {}), scored });
      if (!scored.hard_ok) violations.push({ task: task.id, attempt: i, checks: scored.violations, why: scored.violations.map((v) => `${v}: ${scored.hard[v].why}`) });
    }
    results[task.id] = { role: task.role ?? null, kind: task.kind ?? null, runner, attempts, summary: summarize(attempts) };
  }
  const base = baseline ? JSON.parse(fs.readFileSync(baseline, 'utf8')) : null;
  const regressions = set === 'full' && base ? compare(results, base) : [];
  // a check's `why` quotes the session's files and output (provenance_tags quotes a line, a worker's stderr is kept):
  // the whole report goes through the transcripts' redaction before it is written or returned
  const report = JSON.parse(claudeRunner.redact(K.jsonDumps({ run_id: runId, set, runner, n, tasks: tasks.length, touched, baseline: baseline ? path.basename(baseline) : null, violations, regressions, results, ok: violations.length === 0 && regressions.length === 0 })));
  fs.writeFileSync(path.join(outDir, 'report.json'), K.jsonDumps(report, { indent: 2 }) + '\n');
  return { ...report, out: outDir };
}

/** Write a baseline from a results report. Refuses fixture results. */
export function writeBaseline(reportPath, outPath, kitVersion) {
  const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (rep.runner !== 'claude') throw new Error(`refusing to write a baseline from runner '${rep.runner}'; baselines come from real runs only`);
  const tasks = {};
  for (const [id, r] of Object.entries(rep.results)) tasks[id] = r.summary;
  const baseline = { kit_version: kitVersion, from_run: rep.run_id, set: rep.set, n: rep.n, written: new Date().toISOString(), tasks };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, K.jsonDumps(baseline, { indent: 2 }) + '\n');
  return baseline;
}

export function fmt(rep) {
  if (rep.error) return `eval: ${rep.error}\n`;
  const lines = [`eval ${rep.set} (${rep.runner}, n=${rep.n}): ${rep.tasks} task(s)`];
  for (const [id, r] of Object.entries(rep.results)) lines.push(`  ${id.padEnd(34)} score ${r.summary.score.mean.toFixed(2)} ±${r.summary.score.std.toFixed(2)}  hard ${r.summary.hard_ok.mean === 1 ? 'ok' : 'VIOLATION'}`);
  for (const v of rep.violations) lines.push(`  VIOLATION ${v.task} attempt ${v.attempt}: ${v.why.join('; ')}`);
  for (const r of rep.regressions) lines.push(`  REGRESSION ${r.task} ${r.metric}: ${r.run.toFixed(2)} < ${r.baseline.toFixed(2)} − ${r.allowed.toFixed(2)}`);
  // a real session that did not exit 0 (non-zero, timed out, or never spawned) is the first thing to read when
  // every task violates; the fixture runner has no session and prints nothing here
  const how = (w) => (w.status !== null ? `exit ${w.status}` : w.signal ? `killed by ${w.signal} (timed out)` : `not started (${w.error || 'unknown'})`);
  const tail = (s) => String(s || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ') || '(empty)';
  for (const [id, r] of Object.entries(rep.results)) {
    for (const a of r.attempts ?? []) {
      if (a.runner === 'claude' && a.worker && a.worker.status !== 0) lines.push(`  WORKER ${id} attempt ${a.attempt}: ${how(a.worker)}; stderr: ${tail(a.worker.stderr)}`);
      if (a.runner === 'claude' && a.judge_session && a.judge_session.status !== 0) lines.push(`  JUDGE ${id} attempt ${a.attempt}: ${how(a.judge_session)}; stderr: ${tail(a.judge_session.stderr)}`);
      for (const w of a.warnings ?? []) lines.push(`  WARN ${id} attempt ${a.attempt}: ${w}`);
    }
  }
  lines.push(rep.ok ? 'eval: PASS' : 'eval: FAIL');
  return lines.join('\n') + '\n';
}

export async function main(argv = process.argv.slice(2)) {
  const ap = new ArgumentParser({ prog: 'harness.js' });
  const sub = ap.addSubparsers({ dest: 'cmd', required: true });
  let s = sub.addParser('run');
  s.addArgument('--set', { choices: ['smoke', 'full'], required: true });
  s.addArgument('--runner', { default: 'fixture' });
  s.addArgument('--n');
  s.addArgument('--baseline');
  s.addArgument('--touched');
  s.addArgument('--out');
  s.addArgument('--variant');
  s.addArgument('--json', { action: 'store_true' });
  s = sub.addParser('baseline');
  s.addArgument('--from', { required: true });
  s.addArgument('--out', { required: true });
  sub.addParser('list');
  const a = ap.parseArgs(argv);
  if (a.cmd === 'list') {
    for (const t of loadTasks()) process.stdout.write(`${t.id}  role=${t.role ?? '-'} kind=${t.kind ?? '-'} tags=${(t.tags ?? []).join(',')} checks=${t.checks.length} rubric=${t.rubric.length}\n`);
    return 0;
  }
  if (a.cmd === 'baseline') {
    const version = fs.readFileSync(path.join(K.KIT_DIR, '..', 'VERSION'), 'utf8').trim();
    const b = writeBaseline(a.from, a.out, version);
    process.stdout.write(`baseline written: ${a.out} (${Object.keys(b.tasks).length} tasks, from ${b.from_run})\n`);
    return 0;
  }
  const rep = await runSet({ set: a.set, runner: a.runner, n: a.n ? Number(a.n) : undefined, touched: a.touched ? a.touched.split(',').filter(Boolean) : [], baseline: a.baseline ?? null, out: a.out ?? null, variant: a.variant ?? undefined });
  process.stdout.write(a.json ? K.jsonDumps(rep, { indent: 2 }) + '\n' : fmt(rep));
  return rep.ok ? 0 : 1;
}

if (K.isMain(import.meta.url)) main().then((c) => { process.exitCode = c; });
