#!/usr/bin/env node
// lane: the mechanical half of the pipeline commands. Agents do the thinking; this does the git and file bookkeeping.
//
//   lane.js precheck <slug> --repo R          may /implement start? (spec valid + approved, no open questions, WIP, no file overlap)
//   lane.js scope <slug> --repo R             fix/incident: after the human approved the in-lane spec, check it and copy its criteria
//   lane.js check <slug> <criterion> --repo R -- <command>   run a criterion's command in the lane, log it, print the log ref
//   lane.js start <slug> --repo R [--base B]  precheck, then worktree ../<repo>-lanes/<slug> on branch wt/<slug> from fresh base; lane.json; progress skeleton
//   lane.js stage <slug> <stage> --repo R     set lane.json stage (research|plan|build|review) and reset its clock
//   lane.js launch <slug> --repo R [--exec]   host side: the command that starts the lane's headless session inside its sandbox (KIT-SPEC 10.9)
//   lane.js resume <slug> --repo R            host side: next step from files alone, logged, plus the launch command (KIT-SPEC 10.11)
//   lane.js stop --repo R --by N --reason T    kill switch: every lane refuses transitions and mutations (KIT-SPEC 10.13)
//   lane.js resume-all --repo R --by N         lift the kill switch (named human)
//   lane.js profiles --repo R                  the workflow table: stages and human pauses per work_type (KIT-SPEC 10.12)
//   lane.js agent-for <work_type> <stage>      the one agent allowed for a stage; refuses unknown types and unlisted stages
//   lane.js wip --repo R                      active lanes vs WIP limit
//   lane.js unknowns <draft spec> --repo R    exit 0 none / 3 resolve (1..3, one researcher each) / 2 research insufficient (>3)
//   lane.js roadmap-set <slug> <status> --repo R
//   lane.js index lookup "<question>" --repo R [--json]   reuse | stale | new, from docs/research/INDEX.md
//   lane.js index add "<question>" --repo R --slug S --keywords K --files F --commit C
//   lane.js next-step <slug> --repo R         JSON: the next stage for this feature, derived from files and git
//   lane.js next --repo R                     JSON: next queued slug with an agreed goal (exit 2 if none / WIP full)
//   lane.js goal-set <slug> agreed|running|done --repo R
//   lane.js incident --repo R --what "..." [--slug S] [--pr URL]   record a production incident for /retro --incident
//   lane.js merged <slug> --repo R [--pr URL] at merge time: verify in git, mark ROADMAP merged (idempotent)
//   lane.js finish <slug> --repo R            after retro: remove worktree and local branch, mark roadmap merged
// Exit 0 ok, 2 refused (reasons on stderr), 1 usage/git error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgumentParser } from './args.js';
import * as K from './kitlib.js';
import * as V from './validate_docs.js';
import * as SB from './sandbox.js';

const DOC = `lane: the mechanical half of the pipeline commands. Agents do the thinking; this does the git and file bookkeeping.

  lane.js precheck <slug> --repo R          may /implement start? (spec valid + approved, no open questions, WIP, no file overlap)
  lane.js start <slug> --repo R [--base B]  precheck, then worktree ../<repo>-lanes/<slug> on branch wt/<slug> from fresh base; lane.json; progress skeleton
  lane.js stage <slug> <stage> --repo R     set lane.json stage (research|plan|build|review) and reset its clock
  lane.js wip --repo R                      active lanes vs WIP limit
  lane.js unknowns <draft spec> --repo R    exit 0 none / 3 resolve (1..3, one researcher each) / 2 research insufficient (>3)
  lane.js roadmap-set <slug> <status> --repo R
  lane.js index lookup "<question>" --repo R [--json]   reuse | stale | new, from docs/research/INDEX.md
  lane.js index add "<question>" --repo R --slug S --keywords K --files F --commit C
  lane.js next-step <slug> --repo R         JSON: the next stage for this feature, derived from files and git
  lane.js next --repo R                     JSON: next queued slug with an agreed goal (exit 2 if none / WIP full)
  lane.js goal-set <slug> agreed|running|done --repo R
  lane.js incident --repo R --what "..." [--slug S] [--pr URL]   record a production incident for /retro --incident
  lane.js merged <slug> --repo R [--pr URL] at merge time: verify in git, mark ROADMAP merged (idempotent)
  lane.js finish <slug> --repo R            after retro: remove worktree and local branch, mark roadmap merged
Exit 0 ok, 2 refused (reasons on stderr), 1 usage/git error.`;

export const ACTIVE = new Set(['researching', 'planning', 'waiting-approval', 'building', 'in-review', 'escalated', 'ready-to-merge']);
/**
 * Positions that mean a lane is under way. Kept as the documented vocabulary (KIT-SPEC 9.2, decision 0006) and used
 * by readers of a lane's position; it is no longer the source of the WIP count, which wip() derives from the
 * worktrees themselves because ROADMAP status is a record, not a source.
 */
export const IN_FLIGHT = new Set(['building', 'in-review', 'escalated', 'ready-to-merge']);

// ---------------------------------------------------------------------------
// Python-compatible helpers (shared with kit_status.js)
// ---------------------------------------------------------------------------

/** Characters Python's str.strip() / regex \s treat as whitespace (Unicode), which differs from JS's \s / trim(). */
export const PY_WS = '\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
/** Body of a character class holding Python's \s (use inside [...]). */
export const PYS_IN = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const S = `[${PYS_IN}]`; // \s
const NS = `[^${PYS_IN}]`; // \S
const D = '\\p{Nd}'; // \d (Unicode decimal digits)

/** The approval line a spec must carry: "Approved by: <name> on <date> at <commit>". */
export const APPROVAL_RE = new RegExp(`Approved by:${S}*(?!—)${NS}[^\\n]*${S}+on${S}+${D}{4}-${D}{2}-${D}{2}${S}+at${S}+[0-9a-f]{7,40}`, 'u');

/** Python str.strip(). */
export const pyStrip = (s) => K.stripChars(s, PY_WS);

/** Python s[:n] (by code points, not UTF-16 units). */
export const headCp = (s, n) => {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
};

/** Python would raise AttributeError on `.get` for a JSON value that is not an object; do the same. */
export function asDict(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`AttributeError: '${v === null ? 'NoneType' : Array.isArray(v) ? 'list' : typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool' : 'int'}' object has no attribute 'get'`);
  return v;
}

/** Python `d.get(key, default)` on a parsed JSON object. */
export const kget = (o, k, d) => (o !== null && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k) ? o[k] : d);

/** Python int(x) for values read from JSON; throws like Python's int() would. */
export function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`ValueError: cannot convert float ${v} to integer`);
    return Math.trunc(v);
  }
  if (typeof v === 'string') {
    const m = new RegExp(`^${S}*([+-]?${D}+(?:_${D}+)*)${S}*$`, 'u').exec(v);
    if (!m) throw new Error(`ValueError: invalid literal for int() with base 10: ${pyRepr(v)}`);
    return parseInt(m[1].replaceAll('_', ''), 10);
  }
  throw new Error(`TypeError: int() argument must be a string, a bytes-like object or a real number, not '${v === null ? 'NoneType' : Array.isArray(v) ? 'list' : 'dict'}'`);
}

function pyStrRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === q || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch !== ' ' && /[\p{C}\p{Z}]/u.test(ch)) {
      out += cp < 0x100 ? '\\x' + cp.toString(16).padStart(2, '0') : cp < 0x10000 ? '\\u' + cp.toString(16).padStart(4, '0') : '\\U' + cp.toString(16).padStart(8, '0');
    } else out += ch;
  }
  return out + q;
}

/** Python repr() of a JSON-ish value. */
export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return pyStrRepr(v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  return '{' + Object.entries(v).map(([k, x]) => `${pyStrRepr(k)}: ${pyRepr(x)}`).join(', ') + '}';
}

/** Python str(x) / f"{x}" of a JSON-ish value (None, True, False, ...). */
export const pyStr = (v) => (typeof v === 'string' ? v : pyRepr(v));

/** Python truthiness of a JSON-ish value. */
export function pyTruthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** A float that json.dumps would print with a trailing ".0" when integral. */
class PyFloat {
  constructor(v) {
    this.v = v;
  }

  toJSON() {
    return `@@PYFLOAT:${Number.isInteger(this.v) ? this.v + '.0' : String(this.v)}@@`;
  }
}
export const pyFloatStr = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));
const dumps = (o, opts) => K.jsonDumps(o, opts).replace(/"@@PYFLOAT:([^@"]*)@@"/g, '$1');

/** Python round(x, 2) for x in [0, 1]: correctly rounded, exact ties go to the even digit. */
export function pyRound2(x) {
  const t = x * 100;
  const lo = Math.floor(t);
  if (t - lo === 0.5 && Number.isInteger(x * 8)) return (lo % 2 === 0 ? lo : lo + 1) / 100;
  return Number(x.toFixed(2));
}

/** pathlib-style join: no `..` resolution, duplicate slashes and `.` segments dropped, an absolute part resets. */
export function pjoin(...parts) {
  let abs = false;
  let segs = [];
  for (const p of parts) {
    if (p.startsWith('/')) {
      abs = true;
      segs = [];
    }
    for (const s of p.split('/')) if (s !== '' && s !== '.') segs.push(s);
  }
  if (segs.length === 0) return abs ? '/' : '.';
  return (abs ? '/' : '') + segs.join('/');
}

/** pathlib Path.relative_to (lexical). Throws ValueError when `p` is not under `base`. */
export function relativeTo(base, p) {
  if (p === base) return '.';
  const prefix = base.endsWith('/') ? base : base + '/';
  if (!p.startsWith(prefix)) throw new Error(`ValueError: ${pyRepr(p)} is not in the subpath of ${pyRepr(base)}`);
  return p.slice(prefix.length);
}

/** pathlib Path.stem. */
export function stemOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
}

/** Python Path.read_text(): UTF-8 with universal newlines (\r\n and \r become \n). */
export const readText = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');

const writeText = (p, text) => fs.writeFileSync(p, text, 'utf8');

/** subprocess.CalledProcessError equivalent: git ran and exited non-zero (or was killed). */
export const isCalledProcessError = (e) => Boolean(e) && (typeof e.status === 'number' || (e.signal ?? null) !== null);

function calledProcessErrorStr(e, args) {
  return `Command '${pyRepr(['git', ...args])}' returned non-zero exit status ${e.status}.`;
}

/** `~` expansion for Path.expanduser(). */
export function expandUser(p) {
  if (p === '~' || p.startsWith('~/')) return os.homedir() + p.slice(1);
  return p;
}

const todayIso = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const here = () => K.realResolve(fileURLToPath(import.meta.url));
/** kit/ directory (Path(__file__).resolve().parents[1]). */
const kitDir = () => path.dirname(path.dirname(here()));

const intersect = (a, b) => new Set([...a].filter((x) => b.has(x)));
const union = (a, b) => new Set([...a, ...b]);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------

export function refuse(msgs) {
  for (const m of msgs) process.stderr.write(`lane: ${m}\n`);
  return 2;
}

/** The spec for a slug, under the project's lane-artifact root (KIT-SPEC 10.11, kit.json paths.work). */
export function specPath(root, slug) {
  return pjoin(root, K.workRoot(root), `${slug}.md`);
}

/** Header fields of a spec as a Map of lowercase key -> value (empty when the file is missing). */
export function specHeader(p) {
  if (!K.isFile(p)) return new Map();
  const out = new Map();
  for (const [k, [, v]] of K.headerFields(K.stripHtmlComments(K.readLines(p)))) out.set(k, v);
  return out;
}

export function roadmapRows(root) {
  const p = pjoin(root, 'ROADMAP.md');
  if (!K.isFile(p)) return [];
  const sec = K.parseSections(K.stripHtmlComments(K.readLines(p))).get('features');
  const rows = [];
  if (sec) {
    for (const [n, cells] of sec.tableRows()) {
      if (cells.length >= 4 && !cells[0].startsWith('TODO')) {
        rows.push({
          line: n, feature: cells[0], slug: cells[1], milestone: cells[2], status: cells[3],
          spec: cells.length > 4 ? cells[4] : '', lane: cells.length > 5 ? cells[5] : '', pr: cells.length > 6 ? cells[6] : '',
        });
      }
    }
  }
  return rows;
}

/** Set a ROADMAP row's status (and optionally its spec/lane/pr cells). `cols` has any of {spec, lane, pr}. */
export function roadmapSet(root, slug, status, cols = {}) {
  const p = pjoin(root, 'ROADMAP.md');
  if (!K.isFile(p)) return false;
  const lines = K.splitlines(readText(p));
  for (const row of roadmapRows(root)) {
    if (row.slug === slug) {
      const cells = K.stripChars(pyStrip(lines[row.line - 1]), '|').split('|').map(pyStrip);
      while (cells.length < 7) cells.push('—');
      cells[3] = status;
      for (const [key, idx] of [['spec', 4], ['lane', 5], ['pr', 6]]) {
        if (Object.hasOwn(cols, key)) cells[idx] = cols[key];
      }
      lines[row.line - 1] = '| ' + cells.join(' | ') + ' |';
      writeText(p, lines.join('\n') + '\n');
      return true;
    }
  }
  return false;
}

/** Specs that are approved or in flight, with the set of files each one touches. Returns [[slug, Set]]. */
export function activeSpecs(root, exclude = null) {
  const out = [];
  const dir = pjoin(root, K.workRoot(root));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  names = names.filter((n) => n.endsWith('.md')).sort(cmp);
  const allowed = union(ACTIVE, new Set(['approved']));
  for (const name of names) {
    const stem = stemOf(name);
    if (name.endsWith('.progress.md') || name.endsWith('.review.md') || name === 'README.md' || stem === exclude) continue;
    const p = pjoin(dir, name);
    const hdr = specHeader(p);
    if (allowed.has((hdr.get('status') ?? '').toLowerCase())) {
      const [, change, create] = K.specFileLists(p);
      out.push([stem, new Set([...change, ...create])]);
    }
  }
  return out;
}

/**
 * The lane worktree for a slug, or null when there is no lane: the path the main checkout's kit.json recorded at
 * start, else the conventional one, and only when it holds a lane.json. This is the derivation kit-status has always
 * used for position `building`; wip() and laneState share it so the two cannot report different numbers.
 */
export function laneWorktree(root, kit, slug) {
  const lanes = asDict(kget(asDict(kit), 'lanes', {}));
  const recorded = Object.hasOwn(lanes, slug) ? kget(asDict(lanes[slug]), 'worktree', '') : '';
  const wt = recorded ? pjoin(recorded) : pjoin(lanesDir(root), slug);
  return K.isFile(pjoin(wt, '.claude', 'lane.json')) ? wt : null;
}

/**
 * [in flight, limit, slugs]. In flight means a worktree with a lane.json exists, derived from the filesystem.
 * It used to count ROADMAP rows whose status is in IN_FLIGHT, which lane.js start never writes: start calls
 * roadmapSet on the *worktree's* copy, so the main checkout's ROADMAP stayed `queued` and the limit was inert
 * (two lanes opened under max_concurrent_lanes 1). ROADMAP status is a record, not a source (decision 0006).
 */
export function wip(root) {
  const kit = asDict(K.loadKitJson(root));
  const limit = pyInt(kget(kit, 'max_concurrent_lanes', kget(kit, 'wip_limit', 2))); // KIT-SPEC 10.9; wip_limit is the older name
  const lanes = roadmapRows(root).map((r) => r.slug).filter((slug) => laneWorktree(root, kit, slug));
  return [lanes.length, limit, lanes];
}

/** A profile whose debugger works before any spec exists (fix, incident): its lane opens from the goal. */
export function isReproFirst(prof) {
  if (!prof || !Array.isArray(prof.stages)) return false;
  const l = prof.stages.indexOf('lane');
  const r = prof.stages.indexOf('reproduce');
  return l >= 0 && r > l;
}

/** May a fix/incident lane open from its goal? Agreed goal, kill switch off, WIP limit. The spec gate moves to lane.js scope. */
export function goalPrecheck(root, slug) {
  const problems = [];
  const g = goalStatus(root, slug);
  if (!['agreed', 'running'].includes(g ?? '')) problems.push(`goal docs/goals/${slug}.md is '${g ?? 'missing'}', needs 'agreed' (run /start)`);
  const [n, limit, lanes] = wip(root);
  if (n >= limit) problems.push(`WIP limit reached: ${n}/${limit} in flight (${lanes.join(', ')}). Merge or escalate one first.`);
  return problems;
}

/**
 * fix/incident, after the human approved the spec the planner wrote inside the lane: check it like precheck does
 * (valid, approved, no file overlap with other active lanes), fill the progress criteria from its done-criteria, and
 * move the lane to test. Idempotent: criteria rows already present are left alone.
 */
export function scope(root, slug) {
  const wt = pjoin(lanesDir(root), slug);
  const lj = pjoin(wt, '.claude', 'lane.json');
  if (!K.isFile(lj)) return refuse([`no lane for ${slug}; run lane.js start ${slug} first`]);
  const sp = specPath(wt, slug);
  if (!K.isFile(sp)) return refuse([`spec ${relativeTo(wt, sp)} does not exist in the lane; the planner writes it after the reproduction`]);
  const problems = [];
  const v = new V.Validator(wt, null, K.loadKitJson(wt));
  v.run(sp, 'spec');
  for (const x of v.v) problems.push(`spec invalid: ${x}`);
  const status = (specHeader(sp).get('status') ?? '').toLowerCase();
  if (!['approved', 'building'].includes(status)) problems.push(`spec status is '${specHeader(sp).get('status') ?? ''}', needs 'approved' (a human sets it with the approval line)`);
  if (!APPROVAL_RE.test(readText(sp))) problems.push('no approval line (Approved by: <name> on <date> at <commit>)');
  const [, change, create] = K.specFileLists(sp);
  const mine = new Set([...change, ...create]);
  if (!mine.size) problems.push('spec lists no files to change or create');
  for (const [other, files] of activeSpecs(root, slug)) {
    const overlap = [...intersect(mine, files)].sort(cmp);
    if (overlap.length) problems.push(`file overlap with active spec '${other}': ${overlap.join(', ')}`);
  }
  // The lane opened before its spec, from the goal's risk; the spec may raise it (the validator derives risk from the
  // paths it touches). Re-apply the high-risk sandbox rule here, as lane.js start does for a feature (field test #41).
  const laneData = asDict(JSON.parse(readText(lj)));
  const specHigh = (specHeader(sp).get('risk') ?? '').toLowerCase().includes('high');
  const kitR = asDict(K.loadKitJson(root));
  const waiverR = asDict(kget(asDict(kget(kitR, 'sandbox', {})), 'high_risk_waiver', {}));
  const waivedR = pyTruthy(kget(waiverR, 'reason', '')) && pyTruthy(kget(waiverR, 'by', ''));
  const runtime = kget(asDict(kget(laneData, 'sandbox', {})), 'runtime', null);
  if (specHigh && runtime !== 'container' && !waivedR) {
    problems.push(`spec is high-risk: a high-risk lane requires the container sandbox runtime; this lane runs '${runtime ?? 'none'}'. Install docker (or podman) and restart the lane, or record a waiver in .claude/kit.json: "sandbox": { "high_risk_waiver": { "by": "<name>", "reason": "<why>" } }.`);
  }
  if (problems.length) return refuse(problems);
  if (specHigh && laneData.risk !== 'high') {
    laneData.risk = 'high';
    if (runtime !== 'container') laneData.sandbox = { ...asDict(laneData.sandbox), high_risk_waiver: { by: kget(waiverR, 'by', ''), reason: kget(waiverR, 'reason', '') } };
    K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'risk', from: 'normal', to: 'high', summary: 'the approved spec raised the lane to high risk' });
    if (runtime !== 'container') K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'waiver', what: 'high-risk without container', by: kget(waiverR, 'by', ''), reason: kget(waiverR, 'reason', ''), summary: `high-risk lane without container, waived by ${kget(waiverR, 'by', '')}` });
  }
  const prog = pjoin(wt, K.findLane(wt).work, `${slug}.progress.md`);
  const text = K.isFile(prog) ? readText(prog) : '';
  const sep = '|---|---|---|---|---|\n';
  const at = text.indexOf(sep);
  const hasRows = at >= 0 && /^\| *\S+ *\|/.test(text.slice(at + sep.length));
  let added = 0;
  if (at >= 0 && !hasRows) {
    const rows = [];
    const dc = K.parseSections(K.stripHtmlComments(K.readLines(sp))).get('done-criteria');
    if (dc) for (const [, cells] of dc.tableRows()) if (cells.length >= 3) rows.push(`| ${cells[0]} | ${cells[1]} | ${cells[2]} | — | — |`);
    if (!rows.length) return refuse(['spec has no done-criteria rows to copy into the progress file']);
    writeText(prog, text.slice(0, at + sep.length) + rows.join('\n') + '\n' + text.slice(at + sep.length));
    added = rows.length;
  }
  laneData.stage = 'test';
  writeText(lj, K.jsonDumps(laneData, { indent: 2 }) + '\n');
  K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'scope', criteria: added, summary: `spec approved; ${added} criteria copied into progress; lane at test` });
  process.stdout.write(K.jsonDumps({ slug, stage: 'test', criteria_added: added, files: [...mine].sort(cmp) }) + '\n');
  return 0;
}

/**
 * Run a command for a done-criterion in the lane's worktree and append it to the lane log, the same way post-edit-check
 * does; prints the log reference to put in progress.md's Red run or Green run cell (field test #43).
 *
 * This is the ONE place in the kit where a check is executed by a host-side process rather than from inside the lane,
 * so it is the only point at which evidence could be made unforgeable — and it is not, today, for two reasons worth
 * stating rather than discovering later. The log it appends to is inside the worktree, which the lane may write in
 * every sandbox mode. And nothing routes the agent through here: kit/agents/implementer.md:50,53 has the agent copy
 * line numbers from post-edit-check's in-lane runs, so this command is a convenience a human runs, not a gate.
 *
 * Making evidence real means making this the only producer and moving its log out of the lane's reach, which needs a
 * way for the lane to ASK the host to run a check. KIT-SPEC 10.14 records that design and why it is not built.
 */
export function check(root, slug, criterion, cmd) {
  const wt = pjoin(lanesDir(root), slug);
  if (!K.isFile(pjoin(wt, '.claude', 'lane.json'))) return refuse([`no lane for ${slug}; run lane.js start ${slug} first`]);
  if (!cmd) return refuse(['give the command after --']);
  const r = spawnSync('bash', ['-c', cmd], { cwd: wt, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  const code = r.status ?? 1;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const lane = K.findLane(wt);
  const line = K.appendLog(lane.logPath, `${criterion}: ${cmd} -> exit ${code}`, out);
  const ref = `${path.basename(lane.logPath)}#${line}`;
  K.appendEvent(lane.eventsPath, { event: 'check', criterion, command: cmd, result: code === 0 ? 'ok' : 'fail', ref, summary: `${criterion}: exit ${code}` });
  process.stdout.write(K.jsonDumps({ criterion, exit: code, ref, tail: K.splitlines(out).slice(-8) }) + '\n');
  return 0;
}

export function precheck(root, slug) {
  const problems = [];
  const sp = specPath(root, slug);
  if (!K.isFile(sp)) return [`spec ${relativeTo(root, sp)} does not exist; run /plan ${slug}`];
  const v = new V.Validator(root, null, K.loadKitJson(root));
  v.run(sp, 'spec');
  for (const x of v.v) problems.push(`spec invalid: ${x}`);
  const hdr = specHeader(sp);
  const status = (hdr.get('status') ?? '').toLowerCase();
  if (!['approved', 'building', 'escalated'].includes(status)) {
    problems.push(`spec status is '${hdr.get('status') ?? ''}', needs 'approved' (a human sets it with the approval line)`);
  }
  const text = readText(sp);
  if (!APPROVAL_RE.test(text)) problems.push('no approval line (Approved by: <name> on <date> at <commit>)');
  const [n, limit, lanes] = wip(root);
  if (status === 'approved' && n >= limit) {
    problems.push(`WIP limit reached: ${n}/${limit} in flight (${lanes.join(', ')}). Merge or escalate one first.`);
  }
  const [, change, create] = K.specFileLists(sp);
  const mine = new Set([...change, ...create]);
  for (const [other, files] of activeSpecs(root, slug)) {
    const overlap = [...intersect(mine, files)].sort(cmp);
    if (overlap.length) problems.push(`file overlap with active spec '${other}': ${overlap.join(', ')}`);
  }
  return problems;
}

/** The main checkout for a path inside a lane worktree (it has .claude/lane.json); any other path is returned as is. */
export function mainCheckout(root) {
  if (!K.isFile(pjoin(root, '.claude', 'lane.json'))) return root;
  try {
    const common = pyStrip(K.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root));
    const main = path.dirname(common);
    return K.isDir(main) && main !== root ? K.realResolve(main) : root;
  } catch {
    return root;
  }
}

export function lanesDir(root) {
  return pjoin(path.dirname(root), `${path.basename(root)}-lanes`);
}

export function start(root, slug, base) {
  if (isStopped(root)) return refuse([`kill switch set; lane.js resume-all --by <name> first`]);
  const fields = goalFields(root, slug);
  if (!profileFor(fields.work_type)) return refuse([`unknown work_type '${fields.work_type}' in docs/goals/${slug}.md; profiles: ${Object.keys(loadProfiles()).join(', ')}`]);
  // fix/incident: the lane opens from the agreed goal alone; the debugger works inside it, the spec comes after (KIT-SPEC 10.12)
  const reproFirst = isReproFirst(profileFor(fields.work_type)) && !K.isFile(specPath(root, slug));
  const problems = reproFirst ? goalPrecheck(root, slug) : precheck(root, slug);
  if (problems.length) return refuse(problems);
  const kit = asDict(K.loadKitJson(root));
  base = base || kget(kit, 'default_branch', 'main');
  // The project's lane-artifact root, read once on the host side and recorded in lane.json's spec field, so every
  // reader inside the lane resolves the same directory for the life of the lane (Lane.work).
  const work = K.workRoot(root);
  const wt = pjoin(lanesDir(root), slug);
  const branch = `wt/${slug}`;
  if (fs.existsSync(wt)) return refuse([`worktree ${wt} already exists; resume with /implement ${slug} inside it, or run lane.js finish first`]);
  const hasOrigin = K.git(['remote'], root).split(/\s+/).filter(Boolean).includes('origin');
  let startPoint;
  if (hasOrigin) {
    try {
      K.git(['fetch', '-q', 'origin', base], root);
      startPoint = `origin/${base}`;
    } catch (e) {
      if (!isCalledProcessError(e)) throw e;
      startPoint = base;
    }
  } else {
    startPoint = base;
  }
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const wtArgs = ['worktree', 'add', '-q', '-b', branch, wt, startPoint];
  try {
    K.git(wtArgs, root);
  } catch (e) {
    if (!isCalledProcessError(e)) throw e;
    return refuse([`git worktree add failed: ${e.stderr ? pyStrip(e.stderr) : calledProcessErrorStr(e, wtArgs)}`]);
  }
  fs.mkdirSync(pjoin(wt, '.claude'), { recursive: true });
  // Sandbox (KIT-SPEC 10.9): decide the runtime, refuse what the runtime cannot hold, scan for credentials the lane could read.
  const sandbox = SB.sandboxConfig({ root, wt, slug });
  const highRisk = (specHeader(specPath(wt, slug)).get('risk') ?? '').toLowerCase().includes('high') || fields.risk === 'high';
  const undo = () => {
    try {
      K.git(['worktree', 'remove', '--force', wt], root);
      K.git(['branch', '-D', branch], root);
    } catch (e) {
      if (!isCalledProcessError(e)) throw e;
    }
  };
  // A high-risk lane needs the container runtime. A human may waive that in kit.json with a reason; the waiver is recorded
  // on the lane and in the events log, never applied silently (the same pattern as the second-reviewer waiver, KIT-SPEC 10.4).
  const waiver = asDict(kget(asDict(kget(kit, 'sandbox', {})), 'high_risk_waiver', {}));
  const waived = pyTruthy(kget(waiver, 'reason', '')) && pyTruthy(kget(waiver, 'by', ''));
  if (highRisk && sandbox.runtime !== 'container' && !waived) {
    undo();
    const why = sandbox.runtime ? `detected '${sandbox.runtime}' (${sandbox.how})` : `no sandbox runtime is available (${sandbox.how})`;
    return refuse([
      `spec is high-risk: a high-risk lane requires the container sandbox runtime; ${why}.`,
      'Install docker (or podman), or record a waiver in .claude/kit.json: "sandbox": { "high_risk_waiver": { "by": "<name>", "reason": "<why this is acceptable>" } }.',
      'The waiver is written to the lane and the events log and shown by /status.',
    ]);
  }
  const creds = SB.credentialScan(wt);
  if (creds.length) {
    undo();
    return refuse([`the lane could read credential-looking content; remove it or mark reviewed fixtures with '${SB.ALLOW_MARKER}':`, ...creds.map((h) => `  ${h.path}:${h.line} (${h.kind})`)]);
  }
  const sessionDir = pjoin(wt, '.claude', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sandboxSettings = pjoin(sessionDir, 'sandbox.json');
  writeText(sandboxSettings, K.jsonDumps(SB.srtSettings(sandbox), { indent: 2 }) + '\n');
  const now = K.isoSeconds();
  const startCommit = pyStrip(K.git(['rev-parse', 'HEAD'], wt));
  const lane = {
    feature: slug, spec: `${work}/${slug}.md`, stage: reproFirst ? 'reproduce' : 'build', started: now, created: now,
    base, branch, start_commit: startCommit, budget: kget(kget(kit, 'budgets', {}), 'build', {}),
    risk: highRisk ? 'high' : 'normal',
    work_type: fields.work_type, size: fields.size, domain: fields.domain,
    sandbox: { runtime: sandbox.runtime, state: sandbox.state, how: sandbox.how, settings: relativeTo(wt, sandboxSettings), allowed_domains: sandbox.allowedDomains.length,
      ...(highRisk && sandbox.runtime !== 'container' ? { high_risk_waiver: { by: kget(waiver, 'by', ''), reason: kget(waiver, 'reason', '') } } : {}) },
  };
  writeText(pjoin(wt, '.claude', 'lane.json'), K.jsonDumps(lane, { indent: 2 }) + '\n');
  K.appendEvent(pjoin(sessionDir, 'events.jsonl'), { event: 'sandbox', runtime: sandbox.runtime, state: sandbox.state, summary: sandbox.state === 'degraded' ? `DEGRADED: ${sandbox.how}` : `${sandbox.runtime}: ${sandbox.how}` });
  if (highRisk && sandbox.runtime !== 'container') {
    K.appendEvent(pjoin(sessionDir, 'events.jsonl'), { event: 'waiver', what: 'high-risk without container', by: kget(waiver, 'by', ''), reason: kget(waiver, 'reason', ''), summary: `high-risk lane without container, waived by ${kget(waiver, 'by', '')}` });
    process.stderr.write(`lane ${slug}: high-risk without the container runtime, WAIVED by ${kget(waiver, 'by', '')}: ${kget(waiver, 'reason', '')}\n`);
  }
  if (sandbox.state === 'degraded') process.stderr.write(`lane ${slug}: sandbox DEGRADED (${sandbox.how}); hooks and the floor still enforce; high-risk work is refused in this state\n`);
  // progress skeleton from the spec's done-criteria
  const sp = specPath(wt, slug);
  const rows = [];
  const dc = K.isFile(sp) ? K.parseSections(K.stripHtmlComments(K.readLines(sp))).get('done-criteria') : null;
  if (dc) {
    for (const [, cells] of dc.tableRows()) {
      if (cells.length >= 3) rows.push(`| ${cells[0]} | ${cells[1]} | ${cells[2]} | — | — |`);
    }
  }
  const prog = pjoin(wt, work, `${slug}.progress.md`);
  writeText(
    prog,
    `# Progress: ${slug}\n\n- Spec: \`${work}/${slug}.md\`\n- Worktree: \`${wt}\`\n- Branch: \`${branch}\`\n- Started: ${now}\n- Last update: ${now}\n\n` +
      '## Done-criteria\n\n| # | Criterion | Test | Red run | Green run |\n|---|---|---|---|---|\n' + rows.join('\n') +
      (reproFirst ? "\n\n## Reproduction\n\n<!-- debugger: the steps, what happens, what should happen, the failing command and its output; end with exactly one cause: line. The criteria table above is filled by lane.js scope once the spec is approved. -->\n" : '') +
      (reproFirst ? '\n## Current step\n\nreproducing' : "\n\n## Current step\n\nreading the spec's files") +
      '\n\n## Uncertainties\n\n- none\n\n## Escalation\n\n- Attempts: {{n}} of 3\n- Failure: {{what fails}}\n- Tried: {{what each attempt changed}}\n- Needs: {{decision or information}}\n',
  );
  roadmapSet(wt, slug, 'building', { lane: relativeTo(path.dirname(root), wt) });
  // register the lane in the main checkout's kit.json (not committed by the lane)
  const kj = pjoin(root, '.claude', 'kit.json');
  if (K.isFile(kj)) {
    const data = asDict(JSON.parse(readText(kj)));
    if (!Object.hasOwn(data, 'lanes')) data.lanes = {};
    data.lanes[slug] = { worktree: wt, branch, started: now, start_commit: startCommit };
    writeText(kj, K.jsonDumps(data, { indent: 2 }) + '\n');
  }
  process.stdout.write(K.jsonDumps({ worktree: wt, branch, spec: lane.spec, progress: relativeTo(wt, prog), sandbox: lane.sandbox.state, runtime: lane.sandbox.runtime }) + '\n');
  return 0;
}

/** Start the kit telemetry collector on the host side if nothing answers on its port; returns the child or null when one already runs. */
export function ensureCollector(port = Number(process.env.KIT_TELEMETRY_PORT || 4318)) {
  const probe = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`], { timeout: 3000 });
  if (probe.status === 0) return null;
  const child = spawn(process.execPath, [pjoin(K.KIT_DIR, 'telemetry', 'collector.js'), '--port', String(port)], { detached: true, stdio: 'ignore' });
  return child;
}

/** Host side: the command that starts the lane's headless session inside its sandbox. Prints it; runs it with --exec. */
export function launch(root, slug, { exec = false, prompt = null } = {}) {
  const wt = pjoin(lanesDir(root), slug);
  const lj = pjoin(wt, '.claude', 'lane.json');
  if (!K.isFile(lj)) return refuse([`no lane for ${slug}; run lane.js start ${slug} first`]);
  const data = asDict(JSON.parse(readText(lj)));
  const cfg = SB.sandboxConfig({ root, wt, slug });
  const recorded = asDict(kget(data, 'sandbox', {}));
  if (kget(recorded, 'runtime', null) !== cfg.runtime) {
    return refuse([`sandbox runtime changed since start (recorded '${kget(recorded, 'runtime', null)}', now '${cfg.runtime}'); a lane keeps one runtime: finish it and start again`]);
  }
  if (kget(data, 'risk', 'normal') === 'high' && cfg.runtime !== 'container' && !pyTruthy(kget(asDict(kget(recorded, 'high_risk_waiver', {})), 'by', ''))) return refuse(['high-risk lane without the container runtime and no recorded waiver']);
  const settingsPath = pjoin(wt, '.claude', 'session', 'sandbox.json');
  writeText(settingsPath, K.jsonDumps(SB.srtSettings(cfg), { indent: 2 }) + '\n');
  const text = prompt ?? `/run ${slug}`;
  const cmd = SB.launchCommand(cfg, { wt, settingsPath, prompt: text });
  // telemetry (KIT-SPEC 9.4): exporter on, records tagged with project, lane and stage; the collector runs on the host side
  const project = kget(asDict(K.loadKitJson(root)), 'project', path.basename(root));
  const telemetry = SB.telemetryEnv({ project, slug, stage: kget(data, 'stage', 'build') });
  K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'launch', runtime: cfg.runtime, state: cfg.state, exec, telemetry: telemetry.OTEL_EXPORTER_OTLP_ENDPOINT, summary: cmd.slice(0, 3).join(' ') });
  if (!exec) {
    process.stdout.write(K.jsonDumps({ runtime: cfg.runtime, state: cfg.state, cwd: wt, command: cmd, settings: relativeTo(wt, settingsPath), env: telemetry }, { indent: 2 }) + '\n');
    return 0;
  }
  const collector = ensureCollector();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: wt, stdio: 'inherit', env: { ...process.env, ...telemetry, KIT_LANE: slug } });
  if (collector) collector.unref();
  return r.status ?? 1;
}

/** Host side: resume a lane from its files alone. Prints the next step and the launch command; the transcript is never needed (KIT-SPEC 10.11). */
export async function resume(root, slug) {
  const wt = pjoin(lanesDir(root), slug);
  if (!K.isFile(pjoin(wt, '.claude', 'lane.json'))) return refuse([`no lane for ${slug}`]);
  const step = await nextStep(root, slug);
  K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'resume', step: kget(step, 'step', null), summary: `resumed from files at ${kget(step, 'step', '?')}` });
  process.stdout.write(K.jsonDumps({ slug, next: step, launch: `lane.js launch ${slug} --repo ${root}` }, { indent: 2 }) + '\n');
  return 0;
}

export function setStage(root, slug, stage) {
  const wt = pjoin(lanesDir(root), slug);
  const lf = pjoin(wt, '.claude', 'lane.json');
  if (!K.isFile(lf)) return refuse([`no lane.json at ${lf}`]);
  const data = asDict(JSON.parse(readText(lf)));
  data.stage = stage;
  data.started = K.isoSeconds();
  data.budget = kget(kget(asDict(K.loadKitJson(root)), 'budgets', {}), stage, {});
  writeText(lf, K.jsonDumps(data, { indent: 2 }) + '\n');
  process.stdout.write(`lane ${slug}: stage ${stage}\n`);
  return 0;
}

export function finish(root, slug) {
  const wt = pjoin(lanesDir(root), slug);
  const msgs = [];
  if (fs.existsSync(wt)) {
    try {
      K.git(['worktree', 'remove', '--force', wt], root);
      msgs.push(`removed worktree ${wt}`);
    } catch (e) {
      if (!isCalledProcessError(e)) throw e;
      return refuse([`worktree remove failed: ${e.stderr}`]);
    }
  }
  try {
    K.git(['branch', '-D', `wt/${slug}`], root);
    msgs.push(`deleted branch wt/${slug}`);
  } catch (e) {
    if (!isCalledProcessError(e)) throw e;
  }
  const kj = pjoin(root, '.claude', 'kit.json');
  if (K.isFile(kj)) {
    const data = asDict(JSON.parse(readText(kj)));
    if (Object.hasOwn(data, 'lanes')) delete data.lanes[slug];
    writeText(kj, K.jsonDumps(data, { indent: 2 }) + '\n');
  }
  roadmapSet(root, slug, 'merged', { lane: '—' });
  process.stdout.write((msgs.length ? msgs.join('\n') : 'nothing to clean') + '\n');
  return 0;
}

// ---------------------------------------------------------------- unknown budget

export const MAX_UNKNOWNS = 3;

/**
 * Count [unknown] tags in a draft spec and decide: none -> proceed; 1..3 -> resolve each (a researcher per item,
 * method required); over 3 -> research insufficient, back to /research. Open questions count as unknowns.
 */
export function unknowns(root, specOrDraft) {
  if (!K.isFile(specOrDraft)) return { count: 0, decision: 'missing', items: [], error: `${specOrDraft} not found` };
  const lines = K.stripHtmlComments(K.readLines(specOrDraft));
  const items = [];
  lines.forEach((t, idx) => {
    if (K.TAG_UNKNOWN.test(t)) {
      const m = new RegExp(`resolve by:${S}*([^\\n]+)$`, 'iu').exec(t);
      items.push({ line: idx + 1, text: headCp(pyStrip(t), 160), method: m ? pyStrip(m[1]) : null });
    }
  });
  const oq = K.parseSections(lines).get('open questions');
  if (oq) {
    for (const [n, t] of oq.bullets()) {
      const body = pyStrip(Array.from(pyStrip(t)).slice(2).join(''));
      if (!['none', 'none.'].includes(body.toLowerCase()) && !K.TAG_UNKNOWN.test(t)) {
        items.push({ line: n, text: headCp(body, 160), method: null });
      }
    }
  }
  const count = items.length;
  const decision = count === 0 ? 'none' : count > MAX_UNKNOWNS ? 'research' : 'resolve';
  const missingMethod = items.filter((i) => !i.method);
  return {
    count, max: MAX_UNKNOWNS, decision, items, missing_method: missingMethod.length,
    message: {
      none: 'no unknowns; proceed to critique',
      resolve: `${count} unknown(s): spawn one researcher per item with its method, fold answers in, re-run`,
      research: `${count} unknowns > ${MAX_UNKNOWNS}: research insufficient; stop planning and run /research`,
    }[decision],
  };
}

// ---------------------------------------------------------------- orchestration: what comes next, from facts

export const STAGES = ['start', 'research', 'plan', 'approve', 'lane', 'test', 'build', 'review', 'wait-merge', 'retro', 'done'];

// ------------------------------------------------------------ workflow table (KIT-SPEC 10.12)

const WORKFLOWS_DIR = path.join(kitDir(), 'workflows');
let profileCache = null;
/** Every profile in kit/workflows/*.json, keyed by work_type. The table is the only source of stages and allowed agents. */
export function loadProfiles() {
  if (profileCache) return profileCache;
  const out = {};
  for (const f of fs.readdirSync(WORKFLOWS_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const prof = asDict(JSON.parse(readText(path.join(WORKFLOWS_DIR, f))));
    const wt = kget(prof, 'work_type', f.replace(/\.json$/, ''));
    if (!Array.isArray(prof.stages) || !prof.stages.length) throw new Error(`workflow ${f}: stages missing`);
    out[wt] = { ...prof, work_type: wt };
  }
  profileCache = out;
  return out;
}

export function profileFor(workType) {
  const p = loadProfiles()[workType];
  if (!p) return null;
  return p;
}

/** work_type / risk / size / domain from the goal header; defaults keep today's behaviour (feature, normal, M). */
export function goalFields(root, slug) {
  const p = pjoin(root, 'docs', 'goals', `${slug}.md`);
  const out = { work_type: 'feature', risk: 'normal', size: 'M', domain: [], provisional: false };
  if (!K.isFile(p)) return out;
  const h = K.headerFields(K.stripHtmlComments(K.readLines(p)));
  const get = (k) => (h.has(k) ? pyStrip(h.get(k)[1]).toLowerCase() : '');
  if (get('work type') || get('work_type')) out.work_type = get('work type') || get('work_type');
  if (get('risk')) out.risk = get('risk');
  if (get('size')) out.size = get('size').toUpperCase();
  if (get('domain')) out.domain = get('domain').split(',').map((x) => pyStrip(x)).filter(Boolean);
  out.provisional = get('work type').endsWith('(provisional)') || get('work_type').endsWith('(provisional)');
  out.work_type = out.work_type.replace(/\s*\(provisional\)\s*$/, '');
  const prof = profileFor(out.work_type);
  if (prof && kget(prof, 'force_risk', null)) out.risk = kget(prof, 'force_risk', out.risk);
  return out;
}

/** Refuse a goal whose work_type has no profile; name the agent allowed for a stage; refuse an unlisted one. KIT-SPEC 10.12. */
export function allowedAgent(workType, stage) {
  const prof = profileFor(workType);
  if (!prof) return { ok: false, why: `unknown work_type '${workType}'; profiles: ${Object.keys(loadProfiles()).join(', ')}` };
  if (!prof.stages.includes(stage)) return { ok: false, why: `stage '${stage}' is not in the ${workType} profile (${prof.stages.join(' → ')})` };
  return { ok: true, agent: kget(asDict(kget(prof, 'agents', {})), stage, null), human: (prof.human ?? []).includes(stage) };
}

// ------------------------------------------------------------ kill switch (KIT-SPEC 10.13)

export function stopPath(root) {
  return pjoin(root, '.claude', 'STOP');
}
export function isStopped(root) {
  return K.isFile(stopPath(root));
}
export function stop(root, by, reason) {
  fs.mkdirSync(pjoin(root, '.claude'), { recursive: true });
  writeText(stopPath(root), K.jsonDumps({ by: by || 'unknown', reason: reason || '', at: K.isoSeconds() }, { indent: 2 }) + '\n');
  // terminate running lane sessions: every lane's session dir gets the flag too, so in-lane hooks refuse at once
  for (const slug of fs.existsSync(lanesDir(root)) ? fs.readdirSync(lanesDir(root)) : []) {
    const sd = pjoin(lanesDir(root), slug, '.claude', 'session');
    if (fs.existsSync(sd)) {
      writeText(pjoin(sd, 'STOP'), 'stopped by the kill switch; see .claude/STOP in the main checkout\n');
      K.appendEvent(pjoin(sd, 'events.jsonl'), { event: 'stop', by: by || 'unknown', reason: reason || '', summary: 'kill switch' });
    }
  }
  process.stdout.write(`stopped: every lane refuses transitions and mutations until lane.js resume-all --by <name>\n`);
  return 0;
}
export function resumeAll(root, by) {
  if (!by) return refuse(['resume-all requires --by <name>; the kill switch is lifted by a named human']);
  if (!isStopped(root)) return refuse(['not stopped']);
  fs.rmSync(stopPath(root), { force: true });
  for (const slug of fs.existsSync(lanesDir(root)) ? fs.readdirSync(lanesDir(root)) : []) {
    const sd = pjoin(lanesDir(root), slug, '.claude', 'session');
    if (fs.existsSync(pjoin(sd, 'STOP'))) {
      fs.rmSync(pjoin(sd, 'STOP'), { force: true });
      K.appendEvent(pjoin(sd, 'events.jsonl'), { event: 'resume-all', by, summary: `kill switch lifted by ${by}` });
    }
  }
  process.stdout.write(`resumed by ${by}\n`);
  return 0;
}

export function goalStatus(root, slug) {
  const p = pjoin(root, 'docs', 'goals', `${slug}.md`);
  if (!K.isFile(p)) return null;
  const h = K.headerFields(K.stripHtmlComments(K.readLines(p)));
  return (h.has('status') ? h.get('status')[1] : '').toLowerCase() || 'agreed';
}

/** Decide the next stage for a feature from files and git only. Used by /run; never from an agent's claim. */
export async function nextStep(root, slug) {
  const KS = await import('./kit_status.js');
  const kit = K.loadKitJson(root);
  if (isStopped(root)) return { slug, stage: 'stopped', reason: `kill switch set (${pyStrip(readText(stopPath(root)))}); lane.js resume-all --by <name> to continue`, needs_human: true };
  const rows = new Map(roadmapRows(root).map((r) => [r.slug, r]));
  const row = rows.get(slug);
  const g = goalStatus(root, slug);
  if (g === null) return { slug, stage: 'start', reason: 'no agreed goal file; run /start' };
  if (g === 'done') return { slug, stage: 'done', reason: 'goal file says done' };
  let fields = goalFields(root, slug);
  let prof = profileFor(fields.work_type);
  if (!prof) return { slug, stage: 'refused', reason: `unknown work_type '${fields.work_type}' in the goal; profiles: ${Object.keys(loadProfiles()).join(', ')}`, needs_human: true };
  // /work routed provisionally; the debugger's cause line settles the kind (KIT-SPEC 10.12)
  const rerouted = rerouteFromEvidence(root, slug, fields, prof);
  if (rerouted) {
    fields = goalFields(root, slug);
    prof = profileFor(fields.work_type);
  }
  // The spec may raise the risk the goal declared (the validator derives it from the paths touched); never lower it.
  const laneSpec = (() => {
    const l = K.findLane(pjoin(lanesDir(root), slug));
    return l ? pjoin(l.root, l.work, `${slug}.md`) : null;
  })();
  for (const sp of [specPath(root, slug), ...(laneSpec ? [laneSpec] : [])]) {
    if (K.isFile(sp) && (specHeader(sp).get('risk') ?? '').toLowerCase().includes('high')) fields = { ...fields, risk: 'high' };
  }
  const ctx = { KS, kit, rows, row, g };
  let raw = isReproFirst(prof) ? await nextStepRepro(root, slug, ctx) : await nextStepFeature(root, slug, ctx);
  if (['test', 'build'].includes(raw.stage)) raw = inLanePlanning(root, slug) ?? raw;
  const out = withProfile(raw, prof, fields);
  if (rerouted) out.rerouted = rerouted;
  return out;
}

/** Read the debugger's `cause:` line from the lane's progress file; rewrite a provisional work type when the profile says so. */
export function rerouteFromEvidence(root, slug, fields, prof) {
  const table = asDict(kget(prof, 'reroute', {}));
  if (!Object.keys(table).length) return null;
  const wt = pjoin(lanesDir(root), slug);
  const inLane = fs.existsSync(wt) ? K.findLane(wt) : null;
  const prog = pjoin(inLane ? wt : root, inLane ? inLane.work : K.workRoot(root), `${slug}.progress.md`);
  if (!K.isFile(prog)) return null;
  const m = /^cause:\s*(.+)$/m.exec(readText(prog));
  if (!m) return null;
  const cause = pyStrip(m[1]).toLowerCase();
  let target = null;
  if (/boot failure|suite cannot run/.test(cause)) target = kget(table, 'boot-failure', null);
  else if (/design fault/.test(cause)) target = kget(table, 'design-fault', null);
  if (!target || target === fields.work_type) {
    if (fields.provisional) setGoalField(root, slug, 'Work type', fields.work_type); // the evidence confirmed it; drop "(provisional)"
    return null;
  }
  setGoalField(root, slug, 'Work type', target);
  K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'reroute', from: fields.work_type, to: target, cause: m[1], summary: `rerouted ${fields.work_type} → ${target}: ${m[1]}` });
  return { from: fields.work_type, to: target, cause: pyStrip(m[1]) };
}

/** Rewrite one header field of the goal file in place (controller-only). */
export function setGoalField(root, slug, field, value) {
  const p = pjoin(root, 'docs', 'goals', `${slug}.md`);
  if (!K.isFile(p)) throw new Error(`no goal file for ${slug} (${p})`);
  const re = new RegExp(`^(- ${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:)\\s*.*$`, 'mi');
  const text = readText(p);
  writeText(p, re.test(text) ? text.replace(re, `$1 ${value}`) : text.replace(/^(- Status:.*)$/m, `$1\n- ${field}: ${value}`));
}

/** Map the derived position onto the profile: a stage the profile lacks is skipped forward; the allowed agent is named. */
function withProfile(step, prof, fields) {
  const out = { ...step, work_type: fields.work_type, risk: fields.risk, size: fields.size };
  if (['start', 'done', 'escalated', 'stopped', 'refused'].includes(step.stage)) return out;
  // ui at size L takes the feature shape (KIT-SPEC 10.12)
  const shape = fields.work_type === 'ui' && fields.size === 'L' ? profileFor('feature') : prof;
  const stages = shape.stages;
  let stage = step.stage;
  // a stage the profile lacks maps forward (fix/incident derive their own early stages in nextStepRepro)
  // scope (lane.js scope) is a script stage any profile may need after a re-route from fix/incident; never map it away
  if (stage === 'scope') {
    out.stage = 'scope';
    out.agent = null;
    return out;
  }
  if (!stages.includes(stage)) {
    const alias = { research: 'reproduce', plan: 'reproduce', approve: 'lane', retro: 'done', test: 'build', 'verify-ui': 'review' };
    let cur = stage;
    for (let i = 0; i < 6 && !stages.includes(cur); i++) cur = alias[cur] ?? 'done';
    out.mapped_from = stage;
    stage = cur;
  }
  out.stage = stage;
  const a = allowedAgent(shape.work_type, stage);
  out.agent = a.ok ? a.agent : null;
  if (a.ok && a.human) out.needs_human = true;
  if (fields.risk === 'high' && (prof.risk_adds ?? []).includes('security-signoff') && stage === 'wait-merge') out.requires = ['security-signoff'];
  return out;
}

/**
 * fix/incident: lane (from the goal) → reproduce (debugger, until a cause: line) → plan (planner writes the spec in the
 * lane) → approve (human) → scope (lane.js scope) → then the feature positions: test, build, review, wait-merge, retro.
 */
async function nextStepRepro(root, slug, ctx) {
  const feat = await nextStepFeature(root, slug, ctx);
  if (['start', 'retro', 'done', 'escalated', 'wait-merge', 'review'].includes(feat.stage)) return feat;
  const wt = pjoin(lanesDir(root), slug);
  if (!K.isFile(pjoin(wt, '.claude', 'lane.json'))) return { slug, stage: 'lane', reason: 'agreed goal; a fix lane opens from the goal alone' };
  const prog = pjoin(wt, K.findLane(wt).work, `${slug}.progress.md`);
  if (!/^cause:\s*\S/m.test(K.isFile(prog) ? readText(prog) : '')) return { slug, stage: 'reproduce', reason: 'no cause: line in the progress file yet' };
  return inLanePlanning(root, slug) ?? feat;
}

/**
 * A lane that opened before its spec (fix/incident, or one re-routed from them): plan → approve → scope inside the
 * lane, before any test or build. Null when the lane's spec is approved and scoped (or there is no lane). Every
 * profile goes through this, so no profile can send an agent to test or build a lane without an approved spec
 * (field test #47: a fix re-routed to refactor was sent straight to build with 0/0 criteria).
 */
export function inLanePlanning(root, slug) {
  const wt = pjoin(lanesDir(root), slug);
  const lj = pjoin(wt, '.claude', 'lane.json');
  if (!K.isFile(lj)) return null;
  const sp = pjoin(wt, K.findLane(wt).work, `${slug}.md`);
  if (!K.isFile(sp)) return { slug, stage: 'plan', reason: 'the lane has no spec yet' };
  if (!APPROVAL_RE.test(readText(sp))) {
    const status = (specHeader(sp).get('status') ?? '').toLowerCase();
    if (status === 'waiting-approval') return { slug, stage: 'approve', reason: 'spec waits for the human', needs_human: true };
    return { slug, stage: 'plan', reason: `spec status '${status}' is not waiting-approval; finish planning` };
  }
  const lane = asDict(JSON.parse(readText(lj)));
  if (['reproduce', 'plan', 'approve'].includes(String(kget(lane, 'stage', '')))) return { slug, stage: 'scope', reason: 'spec approved; lane.js scope copies its criteria and moves the lane to test' };
  return null;
}

async function nextStepFeature(root, slug, { KS, kit, rows, row, g }) {
  if (row === undefined) return { slug, stage: 'start', reason: 'goal exists but no ROADMAP row; /start adds it' };
  const st = KS.laneState(root, row, kit);
  const pos = st.position;
  const sp = specPath(root, slug);
  const dashed = slug.replaceAll('-', ' ');
  const research = indexRows(root).filter((r) => r.status === 'current' && (r.slug.includes(slug) || r.question.toLowerCase().includes(dashed) || r.keywords.includes(slug)));
  if (pos === 'merged') return { slug, stage: g !== 'done' ? 'retro' : 'done', reason: 'merged in git; retro not yet run (goal not done)' };
  if (pos === 'escalated') return { slug, stage: 'escalated', reason: st.progress.failure || 'escalation written', needs_human: true };
  if (pos === 'ready-to-merge') return { slug, stage: 'wait-merge', reason: 'review PASS for HEAD; human merges', needs_human: true, pr: st.pr ?? null };
  if (pos === 'in-review') return { slug, stage: 'review', reason: 'lane built or review stale; run reviewer' };
  if (pos === 'building') {
    const prog = st.progress;
    if (prog.criteria && prog.red < prog.criteria) return { slug, stage: 'test', reason: `${prog.red}/${prog.criteria} criteria have a red run; tester first` };
    if (prog.criteria && prog.green === prog.criteria) return { slug, stage: 'review', reason: 'all criteria green; review' };
    return { slug, stage: 'build', reason: `${prog.green}/${prog.criteria} green` };
  }
  if (pos === 'approved') return { slug, stage: 'lane', reason: 'approved spec, no worktree yet' };
  if (pos === 'waiting-approval') return { slug, stage: 'approve', reason: 'spec waits for the human', needs_human: true };
  if (K.isFile(sp)) return { slug, stage: 'plan', reason: 'spec draft exists but is not waiting-approval; finish planning' };
  if (research.length) return { slug, stage: 'plan', reason: `${research.length} research file(s) indexed; no spec` };
  return { slug, stage: 'research', reason: 'no research indexed for this feature' };
}

/** The next queued feature with an agreed goal, if WIP allows. */
export function nextInQueue(root) {
  const [n, limit, lanes] = wip(root);
  if (n >= limit) return { slug: null, reason: `WIP ${n}/${limit} reached`, in_flight: lanes };
  const p = pjoin(root, 'ROADMAP.md');
  const queue = [];
  if (K.isFile(p)) {
    const sec = K.parseSections(K.stripHtmlComments(K.readLines(p))).get('queue');
    if (sec) {
      const re = new RegExp(`^${S}*${D}+\\.${S}*([A-Za-z0-9._-]+)`, 'u');
      for (const [, t] of sec.lines) {
        const m = re.exec(t);
        if (m) queue.push(m[1]);
      }
    }
  }
  const rows = new Map(roadmapRows(root).map((r) => [r.slug, r]));
  for (const slug of queue) {
    const row = rows.get(slug);
    if (row && ['queued', 'researching', 'planning'].includes(row.status) && goalStatus(root, slug) === 'agreed') {
      return { slug, reason: 'next in queue with an agreed goal', in_flight: lanes };
    }
  }
  return { slug: null, reason: 'queue has no item with an agreed goal (run /start)', in_flight: lanes };
}

// ---------------------------------------------------------------- incidents

export function recordIncident(root, what, slug, pr) {
  const d = pjoin(root, 'docs', 'incidents');
  fs.mkdirSync(d, { recursive: true });
  const today = todayIso();
  const n = fs.readdirSync(d).filter((name) => K.fnmatch(name, `${today}-*.md`)).length + 1;
  const p = pjoin(d, `${today}-${n}.md`);
  const tmpl = readText(path.join(kitDir(), 'templates', 'incident.md'));
  const text = tmpl
    .replaceAll('{{short title}}', () => headCp(what, 80))
    .replaceAll('{{date}}-{{n}}', () => `${today}-${n}`)
    .replaceAll('{{date}}', () => today)
    .replaceAll('{{slug or unknown}}', () => slug || 'unknown')
    .replaceAll('{{url or unknown}}', () => pr || 'unknown')
    .replaceAll('{{open|lesson-written}}', () => 'open')
    .replaceAll('{{one paragraph, observable facts}}', () => what);
  writeText(p, text);
  return p;
}

// ---------------------------------------------------------------- research index

export function indexRows(root) {
  const p = pjoin(root, 'docs', 'research', 'INDEX.md');
  if (!K.isFile(p)) return [];
  const rows = [];
  for (const line of K.splitlines(readText(p))) {
    if (line.startsWith('|') && !/^\|\s*-{2,}/.test(line) && !line.split('|')[1].includes('Question')) {
      const c = K.stripChars(pyStrip(line), '|').split('|').map(pyStrip);
      if (c.length >= 7) rows.push({ question: c[0], slug: c[1], keywords: c[2], files: c[3], commit: c[4], date: c[5], status: c[6] });
    }
  }
  return rows;
}

const STOP_WORDS = new Set(['the', 'and', 'how', 'does', 'what', 'with', 'for', 'are', 'our', 'this', 'that']);

export function words(s) {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
}

export function filesChangedSince(root, commit, files) {
  if (!commit || commit === '—' || commit === '-') return files;
  let changed;
  try {
    changed = new Set(K.git(['diff', '--name-only', `${commit}..HEAD`], root).split(/\s+/).filter(Boolean));
  } catch (e) {
    if (!isCalledProcessError(e)) throw e;
    return files;
  }
  return files.filter((f) => changed.has(f));
}

const citedFiles = (files) => files.split(new RegExp(`[,${PYS_IN}]+`, 'u')).filter((f) => f && !['—', '-', 'none'].includes(f));
export { citedFiles };

export function indexLookup(root, question) {
  const q = words(question);
  let best = null;
  let score = 0.0;
  for (const r of indexRows(root)) {
    const rw = union(words(r.question), words(r.keywords));
    if (rw.size === 0) continue;
    const s = intersect(q, rw).size / Math.max(1, union(q, rw).size);
    if (s > score) {
      best = r;
      score = s;
    }
  }
  if (!best || score < 0.5) return { decision: 'new', score: new PyFloat(pyRound2(score)), match: best };
  const cited = citedFiles(best.files);
  const stale = filesChangedSince(root, best.commit, cited);
  if (best.status === 'superseded') return { decision: 'new', score: new PyFloat(pyRound2(score)), match: best, why: 'superseded' };
  if (stale.length) return { decision: 'reverify', score: new PyFloat(pyRound2(score)), match: best, stale_files: stale };
  return { decision: 'reuse', score: new PyFloat(pyRound2(score)), match: best };
}

export function indexAdd(root, question, slug, keywords, files, commit) {
  const p = pjoin(root, 'docs', 'research', 'INDEX.md');
  if (!K.isFile(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeText(p, readText(path.join(kitDir(), 'templates', 'index.md')));
  }
  const row = `| ${question} | ${pyStr(slug)} | ${keywords} | ${files} | ${commit} | ${todayIso()} | current |`;
  let lines = K.splitlines(readText(p).replace(/\n+$/, ''));
  lines = lines.map((l) => (!(l.startsWith('|') && l.includes(`| ${pyStr(slug)} |`)) ? l : l.replaceAll('| current |', '| superseded |')));
  lines.push(row);
  writeText(p, lines.join('\n') + '\n');
  process.stdout.write(`index: added ${pyStr(slug)}\n`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const ap = new ArgumentParser({ prog: 'lane.js', description: DOC });
  const sub = ap.addSubparsers({ dest: 'cmd', required: true });
  for (const name of ['precheck', 'start', 'finish', 'scope']) {
    const s = sub.addParser(name);
    s.addArgument('slug');
    s.addArgument('--repo', { default: '.' });
    if (name === 'start') s.addArgument('--base');
  }
  let s = sub.addParser('check');
  s.addArgument('slug'); s.addArgument('criterion'); s.addArgument('command', { nargs: '*' }); s.addArgument('--repo', { default: '.' });
  s = sub.addParser('stage');
  s.addArgument('slug'); s.addArgument('stage', { choices: ['research', 'reproduce', 'plan', 'test', 'build', 'review'] }); s.addArgument('--repo', { default: '.' });
  s = sub.addParser('merged');
  s.addArgument('slug'); s.addArgument('--repo', { default: '.' }); s.addArgument('--pr');
  s = sub.addParser('resume');
  s.addArgument('slug'); s.addArgument('--repo', { default: '.' });
  s = sub.addParser('stop');
  s.addArgument('--repo', { default: '.' }); s.addArgument('--by'); s.addArgument('--reason');
  s = sub.addParser('resume-all');
  s.addArgument('--repo', { default: '.' }); s.addArgument('--by');
  s = sub.addParser('profiles');
  s.addArgument('--repo', { default: '.' });
  s = sub.addParser('agent-for');
  s.addArgument('work_type'); s.addArgument('stage'); s.addArgument('--repo', { default: '.' });
  s = sub.addParser('launch');
  s.addArgument('slug'); s.addArgument('--repo', { default: '.' }); s.addArgument('--exec', { action: 'store_true' }); s.addArgument('--prompt');
  s = sub.addParser('next-step');
  s.addArgument('slug'); s.addArgument('--repo', { default: '.' });
  s = sub.addParser('next');
  s.addArgument('--repo', { default: '.' });
  s = sub.addParser('goal-set');
  s.addArgument('slug'); s.addArgument('status', { choices: ['agreed', 'running', 'done'] }); s.addArgument('--repo', { default: '.' });
  s = sub.addParser('incident');
  s.addArgument('--repo', { default: '.' }); s.addArgument('--what', { required: true }); s.addArgument('--slug'); s.addArgument('--pr');
  s = sub.addParser('wip');
  s.addArgument('--repo', { default: '.' });
  s = sub.addParser('unknowns');
  s.addArgument('spec'); s.addArgument('--repo', { default: '.' }); s.addArgument('--json', { action: 'store_true' });
  s = sub.addParser('roadmap-set');
  s.addArgument('slug'); s.addArgument('status'); s.addArgument('--repo', { default: '.' }); s.addArgument('--pr'); s.addArgument('--spec');
  s = sub.addParser('index');
  s.addArgument('action', { choices: ['lookup', 'add'] }); s.addArgument('question', { nargs: '?' }); s.addArgument('--repo', { default: '.' });
  s.addArgument('--json', { action: 'store_true' }); s.addArgument('--slug'); s.addArgument('--keywords', { default: '' }); s.addArgument('--files', { default: '' }); s.addArgument('--commit', { default: '' });
  const a = ap.parseArgs(argv);
  // --repo may name a lane worktree; lane.js always works on the main checkout (field test #38: next-step from a worktree said 'merged')
  const root = mainCheckout(K.realResolve(a.repo));
  if (a.cmd === 'precheck') {
    const p = precheck(root, a.slug);
    if (p.length) return refuse(p);
    process.stdout.write(`lane ${a.slug}: ready to start\n`);
    return 0;
  }
  if (a.cmd === 'start') return start(root, a.slug, a.base);
  if (a.cmd === 'scope') return scope(root, a.slug);
  if (a.cmd === 'check') return check(root, a.slug, a.criterion, (a.command ?? []).join(' '));
  if (a.cmd === 'resume') return resume(root, a.slug);
  if (a.cmd === 'stop') return stop(root, a.by, a.reason);
  if (a.cmd === 'resume-all') return resumeAll(root, a.by);
  if (a.cmd === 'profiles') {
    const ps = loadProfiles();
    process.stdout.write(K.jsonDumps(Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, { command: v.command, stages: v.stages, human: v.human ?? [] }])), { indent: 2 }) + '\n');
    return 0;
  }
  if (a.cmd === 'agent-for') {
    const r = allowedAgent(a.work_type, a.stage);
    if (!r.ok) return refuse([r.why]);
    process.stdout.write(K.jsonDumps(r) + '\n');
    return 0;
  }
  if (a.cmd === 'launch') return launch(root, a.slug, { exec: !!a.exec, prompt: a.prompt ?? null });
  if (a.cmd === 'stage') return setStage(root, a.slug, a.stage);
  if (a.cmd === 'finish') return finish(root, a.slug);
  if (a.cmd === 'next-step') {
    process.stdout.write(K.jsonDumps(await nextStep(root, a.slug)) + '\n');
    return 0;
  }
  if (a.cmd === 'next') {
    const res = nextInQueue(root);
    process.stdout.write(K.jsonDumps(res) + '\n');
    return res.slug ? 0 : 2;
  }
  if (a.cmd === 'goal-set') {
    const p = pjoin(root, 'docs', 'goals', `${a.slug}.md`);
    if (!K.isFile(p)) return refuse([`no goal file ${relativeTo(root, p)}`]);
    const text = readText(p).replace(/(?<![^\n])- Status:[^\n]*(?![^\n])/u, () => `- Status: ${a.status}`);
    writeText(p, text);
    process.stdout.write(`goal ${a.slug}: ${a.status}\n`);
    return 0;
  }
  if (a.cmd === 'incident') {
    const p = recordIncident(root, a.what, a.slug, a.pr);
    process.stdout.write(relativeTo(root, p) + '\n');
    return 0;
  }
  if (a.cmd === 'merged') {
    // Verify in git before writing the word: refuse to mark a lane merged that is not an ancestor of base.
    const kit = asDict(K.loadKitJson(root));
    const base = kget(kit, 'default_branch', 'main');
    let tip = '';
    try {
      tip = pyStrip(K.git(['rev-parse', '--verify', '--quiet', `wt/${a.slug}`], root));
    } catch (e) {
      if (!isCalledProcessError(e)) throw e;
    }
    const startC = kget(kget(kget(kit, 'lanes', {}), a.slug, null) || {}, 'start_commit', null);
    if (tip && (tip === startC || spawnSync('git', ['merge-base', '--is-ancestor', tip, base], { cwd: root }).status !== 0)) {
      return refuse([`wt/${a.slug} is not merged into ${base} yet (no lane commits in ${base})`]);
    }
    const cols = a.pr ? { pr: a.pr } : {};
    const ok = roadmapSet(root, a.slug, 'merged', { lane: '—', ...cols });
    process.stdout.write((ok ? `lane ${a.slug}: marked merged` : `lane ${a.slug}: no ROADMAP row`) + '\n');
    return ok ? 0 : 2;
  }
  if (a.cmd === 'unknowns') {
    const res = unknowns(root, path.isAbsolute(a.spec) ? pjoin(a.spec) : pjoin(root, a.spec));
    if (a.json) process.stdout.write(K.jsonDumps(res, { indent: 2 }) + '\n');
    else {
      if (!Object.hasOwn(res, 'message')) throw new Error("KeyError: 'message'");
      process.stdout.write(res.message + '\n');
    }
    return { none: 0, resolve: 3, research: 2, missing: 1 }[res.decision];
  }
  if (a.cmd === 'wip') {
    const [n, limit, lanes] = wip(root);
    process.stdout.write(K.jsonDumps({ in_flight: n, limit, lanes }) + '\n');
    return n < limit ? 0 : 2;
  }
  if (a.cmd === 'roadmap-set') {
    const cols = {};
    if (a.pr) cols.pr = a.pr;
    if (a.spec) cols.spec = a.spec;
    const ok = roadmapSet(root, a.slug, a.status, cols);
    return ok ? 0 : refuse([`no ROADMAP row for ${a.slug}`]);
  }
  if (a.cmd === 'index') {
    if (a.action === 'lookup') {
      const res = indexLookup(root, a.question || '');
      if (a.json) process.stdout.write(dumps(res) + '\n');
      else process.stdout.write(`${res.decision} (score ${pyFloatStr(res.score.v)})` + (pyTruthy(res.match) ? `: ${res.match.slug}` : '') + '\n');
      return 0;
    }
    return indexAdd(root, a.question || '', a.slug, a.keywords, a.files, a.commit);
  }
  return 1;
}

if (K.isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
