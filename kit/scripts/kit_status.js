#!/usr/bin/env node
// kit-status: derive the state of a project from files and git. Nothing here comes from an agent's summary.
//
//   kit_status.js --repo R [--json] [--out status.json]
//   kit_status.js --all [--json]            every project listed in ~/.claude/kit-projects.json
//
// Lane position rules (first match wins):
//   merged            ROADMAP status merged
//   escalated         progress.md Escalation filled (Attempts/Failure without placeholders)
//   ready-to-merge    review report exists, validates, Verdict PASS, Head matches lane HEAD
//   in-review         review report exists (any verdict) or lane stage == review
//   building          worktree exists with lane.json
//   waiting-approval  spec exists, no approval line
//   planning          spec exists with status draft, or ROADMAP says planning
//   researching       research INDEX has a row whose slug/keywords match the feature, no spec
//   queued            otherwise
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ArgumentParser } from './args.js';
import * as K from './kitlib.js';
import * as L from './lane.js';
import * as V from './validate_docs.js';

const DOC = `kit-status: derive the state of a project from files and git. Nothing here comes from an agent's summary.

  kit_status.js --repo R [--json] [--out status.json]
  kit_status.js --all [--json]            every project listed in ~/.claude/kit-projects.json

Lane position rules (first match wins):
  merged            ROADMAP status merged
  escalated         progress.md Escalation filled (Attempts/Failure without placeholders)
  ready-to-merge    review report exists, validates, Verdict PASS, Head matches lane HEAD
  in-review         review report exists (any verdict) or lane stage == review
  building          worktree exists with lane.json
  waiting-approval  spec exists, no approval line
  planning          spec exists with status draft, or ROADMAP says planning
  researching       research INDEX has a row whose slug/keywords match the feature, no spec
  queued            otherwise`;

const { pjoin, pyStrip, headCp, kget, pyStr, pyTruthy, relativeTo, readText, PYS_IN, APPROVAL_RE } = L;
const S = `[${PYS_IN}]`; // Python \s
const NS = `[^${PYS_IN}]`; // Python \S

export function gitOr(args, cwd, def = '') {
  try {
    return pyStrip(K.git(args, cwd));
  } catch {
    return def;
  }
}

/** Parsed events (one JSON object per line) in file order; unparsable lines are skipped. */
function eventLines(events) {
  const out = [];
  for (const line of K.splitlines(fs.readFileSync(events, 'utf8'))) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // Python calls e.get(...) on whatever json.loads returned and crashes on non-objects; keep that behaviour.
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Error(`AttributeError: ${L.pyRepr(e)} has no attribute 'get'`);
    out.push(e);
  }
  return out;
}

export function lastEvent(events, kinds) {
  if (!K.isFile(events)) return null;
  let last = null;
  for (const e of eventLines(events)) {
    const ev = kget(e, 'event', null);
    // Python hashes the value for the set lookup and raises TypeError for lists/dicts; keep that behaviour.
    if (ev !== null && typeof ev === 'object') throw new Error(`TypeError: unhashable type: '${Array.isArray(ev) ? 'list' : 'dict'}'`);
    if (kinds.has(ev)) last = e;
  }
  return last;
}

export function eventsSummary(events) {
  const out = { total: 0, blocked: 0, tests_red: 0, tests_green: 0, stop_refused: 0, last_ts: null };
  if (!K.isFile(events)) return out;
  for (const e of eventLines(events)) {
    out.total += 1;
    out.last_ts = L.pyTruthy(kget(e, 'ts', null)) ? e.ts : out.last_ts;
    const ev = kget(e, 'event', null);
    if (ev === 'blocked') out.blocked += 1;
    else if (ev === 'test') out[kget(e, 'result', null) === 'fail' ? 'tests_red' : 'tests_green'] += 1;
    else if (ev === 'stop_refused') out.stop_refused += 1;
  }
  return out;
}

export function progressInfo(prog) {
  const info = { exists: K.isFile(prog), criteria: 0, green: 0, red: 0, escalated: false, attempts: null, current_step: null, failure: null };
  if (!K.isFile(prog)) return info;
  const lines = K.stripHtmlComments(K.readLines(prog));
  const secs = K.parseSections(lines);
  const dc = secs.get('done-criteria');
  if (dc) {
    for (const [, cells] of dc.tableRows()) {
      if (cells.length >= 5) {
        info.criteria += 1;
        if (cells[3].includes('#')) info.red += 1;
        if (cells[4].includes('#')) info.green += 1;
      }
    }
  }
  const cs = secs.get('current step');
  if (cs) {
    const t = pyStrip(cs.text());
    info.current_step = t ? headCp(K.splitlines(t)[0], 120) : null;
  }
  const esc = secs.get('escalation');
  if (esc) {
    const t = esc.text();
    const att = new RegExp(`(?<![^\\n])- Attempts:${S}*(${NS}[^\\n]*)(?![^\\n])`, 'u').exec(t);
    const fail = new RegExp(`(?<![^\\n])- Failure:${S}*(${NS}[^\\n]*)(?![^\\n])`, 'u').exec(t);
    if (att && fail && !att[1].includes('{{') && !fail[1].includes('{{')) {
      info.escalated = true;
      info.attempts = pyStrip(att[1]);
      info.failure = headCp(pyStrip(fail[1]), 200);
    }
  }
  return info;
}

export function reviewInfo(root, rep, laneHead) {
  const info = { exists: K.isFile(rep), valid: null, verdict: null, head_matches: null, fails: 0 };
  if (!K.isFile(rep)) return info;
  const v = new V.Validator(root, null, K.loadKitJson(root));
  v.run(rep, 'review');
  info.valid = v.v.length === 0;
  const text = readText(rep);
  const m = new RegExp(`(?<![^\\n])## Verdict${S}*\\n+${S}*(PASS|FAIL)`, 'u').exec(text);
  info.verdict = m ? m[1] : null;
  info.fails = (text.match(new RegExp(`(?<![^\\n])\\|${S}*R\\p{Nd}+${S}*\\|[^|]*\\|${S}*FAIL${S}*\\|`, 'gu')) ?? []).length;
  const h = new RegExp(`(?<![^\\n])- Head:${S}*([0-9a-f]{7,40})`, 'u').exec(text);
  if (h && laneHead) info.head_matches = K.reviewHeadOk(root, h[1]);
  return info;
}

export function laneState(root, row, kit) {
  L.asDict(kit);
  const slug = row.slug;
  const spec = pjoin(root, 'docs', 'specs', `${slug}.md`);
  const lanes = kget(kit, 'lanes', {});
  const wt = Object.hasOwn(lanes, slug) ? pjoin(lanes[slug].worktree) : pjoin(L.lanesDir(root), slug);
  const hasWt = K.isFile(pjoin(wt, '.claude', 'lane.json'));
  const base = kget(kit, 'default_branch', 'main');
  const laneJson = hasWt ? L.asDict(JSON.parse(readText(pjoin(wt, '.claude', 'lane.json')))) : {};
  const docsRoot = hasWt ? wt : root;
  const prog = progressInfo(pjoin(docsRoot, 'docs', 'specs', `${slug}.progress.md`));
  const head = hasWt ? gitOr(['rev-parse', 'HEAD'], wt) : null;
  const rev = reviewInfo(docsRoot, pjoin(docsRoot, 'docs', 'specs', `${slug}.review.md`), head);
  const ev = eventsSummary(pjoin(docsRoot, 'docs', 'specs', `${slug}.events.jsonl`));
  const specHdr = K.isFile(spec) ? L.specHeader(spec) : new Map();
  const approved = Boolean(K.isFile(spec) && APPROVAL_RE.test(readText(spec)));
  let behind = null;
  let ahead = null;
  if (hasWt) {
    const counts = gitOr(['rev-list', '--left-right', '--count', `${base}...HEAD`], wt);
    if (counts) {
      const parts = counts.split(/\s+/).filter(Boolean);
      if (parts.length !== 2) throw new Error('ValueError: not enough values to unpack (expected 2)');
      [behind, ahead] = parts.map((x) => L.pyInt(x));
    }
  }
  // merged is a fact from git, not a word in ROADMAP: the lane branch (or its last commit) is an ancestor of base.
  let mergedInGit = false;
  const branch = kget(laneJson, 'branch', null) || `wt/${slug}`;
  const startCommit = kget(laneJson, 'start_commit', null) || kget(kget(lanes, slug, null) || {}, 'start_commit', null);
  const tip = gitOr(['rev-parse', '--verify', '--quiet', branch], root);
  if (tip && tip !== startCommit) {
    mergedInGit = spawnSync('git', ['merge-base', '--is-ancestor', tip, base], { cwd: root }).status === 0;
  }
  // position
  let pos;
  if (row.status === 'merged' || mergedInGit) pos = 'merged';
  else if (prog.escalated) pos = 'escalated';
  else if (rev.exists && rev.valid && rev.verdict === 'PASS' && rev.head_matches) pos = 'ready-to-merge';
  else if (rev.exists || kget(laneJson, 'stage', null) === 'review') pos = 'in-review';
  else if (hasWt) pos = 'building';
  else if (K.isFile(spec) && !approved) pos = 'waiting-approval';
  else if (K.isFile(spec) && approved) pos = 'approved';
  else if (['planning', 'researching'].includes(row.status)) pos = row.status;
  else pos = 'queued';
  const needsYou = ['waiting-approval', 'ready-to-merge', 'escalated'].includes(pos);
  const lastCheck = lastEvent(pjoin(docsRoot, 'docs', 'specs', `${slug}.events.jsonl`), new Set(['test', 'typecheck', 'lint']));
  return {
    feature: row.feature, slug, milestone: row.milestone, roadmap_status: row.status, position: pos, needs_you: needsYou,
    risk: specHdr.get('risk') ?? null, spec: K.isFile(spec) ? relativeTo(root, spec) : null, approved,
    worktree: hasWt ? wt : null, branch: kget(laneJson, 'branch', null), stage: kget(laneJson, 'stage', null), started: kget(laneJson, 'started', null),
    sandbox: hasWt ? L.asDict(kget(laneJson, 'sandbox', {})) : null, // runtime and state, derived at lane start (KIT-SPEC 10.9); never asserted by an agent
    behind_base: behind, ahead_base: ahead, head: head ? headCp(head, 10) : null,
    progress: prog, review: rev, events: ev,
    last_check: lastCheck ? { kind: kget(lastCheck, 'event', null), result: kget(lastCheck, 'result', null), summary: kget(lastCheck, 'summary', null), ts: kget(lastCheck, 'ts', null) } : null,
    pr: !['—', '-', ''].includes(row.pr) ? row.pr : null,
  };
}

export function textOnlyDebt(root) {
  const p = pjoin(root, 'LESSONS.md');
  if (!K.isFile(p)) return 0;
  const sec = K.parseSections(K.stripHtmlComments(K.readLines(p))).get('debt');
  if (!sec) return 0;
  return sec.bullets().filter(([, b]) => !['none', 'none.'].includes(pyStrip(Array.from(pyStrip(b)).slice(2).join('')).toLowerCase())).length;
}

export function researchIndexSummary(root) {
  const rows = L.indexRows(root);
  let stale = 0;
  for (const r of rows) {
    const cited = L.citedFiles(r.files);
    if (r.status === 'current' && L.filesChangedSince(root, r.commit, cited).length) stale += 1;
  }
  return { questions: rows.length, current: rows.filter((r) => r.status === 'current').length, stale };
}

export function projectStatus(root) {
  const kit = L.asDict(K.loadKitJson(root));
  const rows = L.roadmapRows(root);
  const lanes = rows.map((r) => laneState(root, r, kit));
  const inFlight = lanes.filter((l) => L.IN_FLIGHT.has(l.position) || l.position === 'in-review');
  let ci = null;
  if (process.env.KIT_STATUS_NO_GH === undefined && K.isDir(pjoin(root, '.github'))) {
    try {
      const out = spawnSync('gh', ['run', 'list', '--branch', kget(kit, 'default_branch', 'main'), '--limit', '1', '--json', 'conclusion,status,createdAt'], {
        cwd: root, encoding: 'utf8', timeout: 20000,
      });
      if (out.error) throw out.error;
      if (out.status === 0 && pyStrip(out.stdout)) {
        const runs = JSON.parse(out.stdout);
        if (typeof runs === 'string') ci = runs.length ? Array.from(runs)[0] : null; // Python indexes a str too
        else if (!Array.isArray(runs)) throw new Error('not a list');
        else ci = runs.length ? runs[0] : null;
      }
    } catch {
      ci = null;
    }
  }
  const claudeMd = pjoin(root, 'CLAUDE.md');
  let todos = 0;
  for (const f of [pjoin(root, 'ROADMAP.md'), pjoin(root, 'ARCHITECTURE.md'), pjoin(root, 'DESIGN.md'), claudeMd]) {
    if (K.isFile(f)) todos += fs.readFileSync(f, 'utf8').split('TODO(bootstrap').length - 1;
  }
  return {
    project: kget(kit, 'project', path.basename(root)), root, kit_version: kget(kit, 'kit_version', null), generated: K.isoSeconds(),
    wip: { in_flight: inFlight.length, limit: kget(kit, 'wip_limit', 2) },
    needs_you: lanes.filter((l) => l.needs_you).map((l) => ({ slug: l.slug, position: l.position, failure: kget(l.progress, 'failure', null) })),
    lanes,
    ci_main: ci,
    debt: {
      text_only_lessons: textOnlyDebt(root), claude_md_bytes: K.isFile(claudeMd) ? fs.readFileSync(claudeMd).length : 0, claude_md_cap: kget(kit, 'claude_md_cap_bytes', 4000),
      bootstrap_todos: todos,
    },
    research: researchIndexSummary(root),
  };
}

export function render(s) {
  const out = [`${pyStr(s.project)} · kit ${pyStr(s.kit_version)} · WIP ${s.wip.in_flight}/${pyStr(s.wip.limit)}`];
  if (s.needs_you.length) {
    out.push('needs you:');
    for (const n of s.needs_you) out.push(`  - ${n.slug}: ${n.position}` + (pyTruthy(kget(n, 'failure', null)) ? ` — ${n.failure}` : ''));
  } else {
    out.push('needs you: nothing');
  }
  out.push('lanes:');
  for (const l of s.lanes) {
    if (l.position === 'queued' || l.position === 'merged') continue;
    const p = l.progress;
    const extra = [];
    if (l.worktree) {
      extra.push(pyStrip(`${pyStr(l.behind_base)} behind ${l.ahead_base !== null ? '/' + pyStr(l.ahead_base) + ' ahead' : ''}`));
    }
    if (p.criteria) extra.push(`criteria ${p.green}/${p.criteria} green`);
    if (l.last_check) extra.push(`last ${pyStr(l.last_check.kind)}: ${pyStr(l.last_check.result)} (${pyStr(l.last_check.summary)})`);
    if (l.events.blocked) extra.push(`${l.events.blocked} blocked`);
    out.push(`  - ${l.slug}: ${l.position}` + (extra.length ? `  [${extra.join('; ')}]` : ''));
  }
  const q = s.lanes.filter((l) => l.position === 'queued').map((l) => l.slug);
  if (q.length) out.push(`queued: ${q.join(', ')}`);
  const d = s.debt;
  out.push(`debt: ${d.text_only_lessons} text-only lesson(s) · CLAUDE.md ${d.claude_md_bytes}/${pyStr(d.claude_md_cap)} B · ${d.bootstrap_todos} bootstrap TODO(s)`);
  const r = s.research;
  out.push(`research: ${r.questions} question(s), ${r.stale} stale`);
  if (pyTruthy(s.ci_main)) {
    const ci = L.asDict(s.ci_main);
    out.push(`CI on main: ${pyStr(pyTruthy(kget(ci, 'conclusion', null)) ? ci.conclusion : kget(ci, 'status', null))}`);
  }
  return out.join('\n');
}

/** Python iteration over a parsed JSON value: list items, dict keys, str characters; anything else raises TypeError. */
function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return Array.from(v);
  if (v !== null && typeof v === 'object') return Object.keys(v);
  throw new Error(`TypeError: '${v === null ? 'NoneType' : typeof v === 'boolean' ? 'bool' : 'int'}' object is not iterable`);
}

/** Path(p) accepts only strings. */
function asPath(p) {
  if (typeof p !== 'string') throw new Error('TypeError: argument should be a str or an os.PathLike object');
  return p;
}

export function main(argv = process.argv.slice(2)) {
  const ap = new ArgumentParser({ prog: 'kit_status.js', description: DOC });
  ap.addArgument('--repo', { default: '.' });
  ap.addArgument('--all', { action: 'store_true' });
  ap.addArgument('--json', { action: 'store_true' });
  ap.addArgument('--out', { help: 'also write status.json here' });
  const a = ap.parseArgs(argv);
  if (a.all) {
    const home = process.env.CLAUDE_HOME !== undefined ? pjoin(process.env.CLAUDE_HOME) : pjoin(os.homedir(), '.claude');
    const reg = pjoin(home, 'kit-projects.json');
    const projects = K.isFile(reg) ? JSON.parse(readText(reg)) : [];
    const results = pyIter(projects).filter((p) => K.isDir(L.expandUser(asPath(p)))).map((p) => projectStatus(K.realResolve(L.expandUser(asPath(p)))));
    if (a.json) process.stdout.write(K.jsonDumps(results, { indent: 2 }) + '\n');
    else {
      for (const s of results) {
        process.stdout.write(`${pyStr(s.project)}: ${s.needs_you.length} waiting on you · ${s.wip.in_flight}/${pyStr(s.wip.limit)} lanes · debt ${s.debt.text_only_lessons}\n`);
      }
    }
    if (a.out) fs.writeFileSync(a.out, K.jsonDumps(results, { indent: 2 }), 'utf8');
    return 0;
  }
  const s = projectStatus(K.realResolve(a.repo));
  if (a.out) fs.writeFileSync(a.out, K.jsonDumps(s, { indent: 2 }), 'utf8');
  process.stdout.write((a.json ? K.jsonDumps(s, { indent: 2 }) : render(s)) + '\n');
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
