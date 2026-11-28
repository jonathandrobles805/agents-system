#!/usr/bin/env node
// lane: the mechanical half of the pipeline commands. Agents do the thinking; this does the git and file bookkeeping.
//
//   lane.js precheck <slug> --repo R          may /zi-implement start? (spec valid + approved, no open questions, WIP, no file overlap)
//   lane.js scope <slug> --repo R             fix/incident: after the human approved the in-lane spec, check it and copy its criteria
//   lane.js check <slug> <criterion> --repo R -- <command>   run a criterion's command in the lane, log it, print the log ref
//   lane.js start <slug> --repo R [--base B]  precheck, then worktree ../<repo>-lanes/<slug> on branch wt/<slug> from fresh base; lane.json; progress skeleton
//   lane.js advance <slug> <stage> --repo R   move the lane's stage in the store, if the table allows the move and its files justify it
//   lane.js stage <slug> <stage> --repo R     the old name of advance, the same call
//   lane.js advance <slug> build --by NAME    let a lane parked past the round limit (kit.json max_rounds) go on for one more round
//   lane.js gate <slug> --repo R              run the base's recorded checks on the lane's HEAD, contained; verdict bound to the commit (exit 0 PASS, 1 FAIL)
//   lane.js gate <slug> --sync --repo R       update the lane from the base's tip first (a conflict parks the lane), then gate it; the merge needs this
//   lane.js launch <slug> --repo R [--exec]   host side: the command that starts the lane's headless session inside its sandbox (KIT-SPEC 10.9)
//   lane.js resume <slug> --repo R            host side: next step from files alone, logged, plus the launch command (KIT-SPEC 10.11)
//   lane.js stop --repo R --by N --reason T    kill switch: every lane refuses transitions and mutations (KIT-SPEC 10.13)
//   lane.js resume-all --repo R --by N         lift the kill switch (named human)
//   lane.js profiles --repo R                  the workflow table: stages and human pauses per work_type (KIT-SPEC 10.12)
//   lane.js agent-for <work_type> <stage>      the one agent allowed for a stage; refuses unknown types and unlisted stages
//   lane.js wip --repo R                      active lanes vs WIP limit
//   lane.js unknowns <draft spec> --repo R    exit 0 none / 3 resolve (1..3, one researcher each) / 2 research insufficient (>3)
//   lane.js evidence <slug> --repo R          copy the check log to <work>/<slug>.checks.txt
//   lane.js roadmap-set <slug> <status> --repo R
//   lane.js index lookup "<question>" --repo R [--json]   reuse | stale | new, from docs/research/INDEX.md
//   lane.js index add "<question>" --repo R --slug S --keywords K --files F --commit C
//   lane.js next-step <slug> --repo R         JSON: the next stage for this feature, derived from files and git
//   lane.js next --repo R                     JSON: next queued slug with an agreed goal (exit 2 if none / WIP full)
//   lane.js goal-set <slug> agreed|running|done --repo R
//   lane.js incident --repo R --what "..." [--slug S] [--pr URL]   record a production incident for /zi-retro --incident
//   lane.js ci [<slug>] --repo R [--pr N] [--wait]       CI on the PR head: exit 0 green, 1 red or timed out, 3 pending
//   lane.js publish <slug> --repo R [--branch spec/<slug>] [--title T] [--body-file F | --body T] [--base B]  host side: push the lane or spec branch and open its PR as the kit's GitHub App
//   lane.js merge [<slug>] --repo R [--pr N] --by NAME  wait for every required check, then squash-merge pinned to that head
//   lane.js signoff <slug> --repo R --by NAME   a named human's security sign-off of the lane's HEAD (high risk; the ask rule prompts)
//   lane.js merged <slug> --repo R [--pr URL] at merge time: verify in git, mark ROADMAP merged (idempotent)
//   lane.js template <goal|spec|research|review|lesson> [--slug S] --repo R   print a kit template with slug, date and commit filled in
//   lane.js finish <slug> --repo R            after retro: remove worktree and local branch, mark roadmap merged
// Exit 0 ok, 2 refused (reasons on stderr), 1 usage/git error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgumentParser } from './args.js';
import * as K from './kitlib.js';
import * as G from './pr_gate.js';
import * as V from './validate_docs.js';
import * as SB from './sandbox.js';
import * as APP from './app_token.js';
import { CI_COMMANDS, isConfigured } from './bootstrap.js';

const DOC = `lane: the mechanical half of the pipeline commands. Agents do the thinking; this does the git and file bookkeeping.

  lane.js precheck <slug> --repo R          may /zi-implement start? (spec valid + approved, no open questions, WIP, no file overlap)
  lane.js start <slug> --repo R [--base B]  precheck, then worktree ../<repo>-lanes/<slug> on branch wt/<slug> from fresh base; lane.json; progress skeleton
  lane.js advance <slug> <stage> --repo R   move the lane's stage in the store, if the table allows the move and its files justify it
  lane.js stage <slug> <stage> --repo R     the old name of advance, the same call
  lane.js advance <slug> build --by NAME    let a lane parked past the round limit (kit.json max_rounds) go on for one more round
  lane.js wip --repo R                      active lanes vs WIP limit
  lane.js unknowns <draft spec> --repo R    exit 0 none / 3 resolve (1..3, one researcher each) / 2 research insufficient (>3)
  lane.js roadmap-set <slug> <status> --repo R
  lane.js index lookup "<question>" --repo R [--json]   reuse | stale | new, from docs/research/INDEX.md
  lane.js index add "<question>" --repo R --slug S --keywords K --files F --commit C
  lane.js next-step <slug> --repo R         JSON: the next stage for this feature, derived from files and git
  lane.js next --repo R                     JSON: next queued slug with an agreed goal (exit 2 if none / WIP full)
  lane.js goal-set <slug> agreed|running|done --repo R
  lane.js incident --repo R --what "..." [--slug S] [--pr URL]   record a production incident for /zi-retro --incident
  lane.js ci [<slug>] --repo R [--pr N] [--wait]       CI on the PR head: exit 0 green, 1 red or timed out, 3 pending
  lane.js publish <slug> --repo R [--branch spec/<slug>] [--title T] [--body-file F | --body T] [--base B]  host side: push the lane or spec branch and open its PR as the kit's GitHub App
  lane.js merge [<slug>] --repo R [--pr N] --by NAME  wait for every required check, then squash-merge pinned to that head
  lane.js merged <slug> --repo R [--pr URL] at merge time: verify in git, mark ROADMAP merged (idempotent)
  lane.js template <goal|spec|research|review|lesson> [--slug S] --repo R   print a kit template with slug, date and commit filled in
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
const D = '\\p{Nd}'; // \d (Unicode decimal digits)

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

/** The mutation gate's rule: blocking once `mutation_blocking_after_features` (default 2) ROADMAP rows are merged. */
export function mutationBlocking(root) {
  const after = pyInt(kget(asDict(K.loadKitJson(root)), 'mutation_blocking_after_features', 2));
  const merged = roadmapRows(root).filter((r) => r.status === 'merged').length;
  return { blocking: merged >= after, merged, after };
}

/** The PR number for a lane: --pr, else the PR cell of its ROADMAP row. */
export function lanePr(root, slug, prArg) {
  const row = slug ? roadmapRows(root).find((r) => r.slug === slug) : undefined;
  return G.resolvePr(prArg, row?.pr);
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
  if (!['agreed', 'running'].includes(g ?? '')) problems.push(`goal docs/goals/${slug}.md is '${g ?? 'missing'}', needs 'agreed' (run /zi-start)`);
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
  if (!K.isFile(lj)) return refuse([`no lane for ${slug}; run kit lane start ${slug} first`]);
  const sp = specPath(wt, slug);
  if (!K.isFile(sp)) return refuse([`spec ${relativeTo(wt, sp)} does not exist in the lane; the planner writes it after the reproduction`]);
  const problems = [];
  const v = new V.Validator(wt, null, K.loadKitJson(wt));
  v.run(sp, 'spec');
  for (const x of v.v) problems.push(`spec invalid: ${x}`);
  const status = (specHeader(sp).get('status') ?? '').toLowerCase();
  if (!['approved', 'building'].includes(status)) problems.push(`spec status is '${specHeader(sp).get('status') ?? ''}', needs 'approved' (set it on the spec/${slug} PR; merging that PR with kit lane merge is the approval)`);
  // The planner wrote the spec in the lane; it counts only once the owner merged it as a spec/<slug> PR, and the lane
  // must build exactly what was merged (hardening plan D1, "Fix and incident lanes").
  const approval = specApproval(root, slug);
  if (!approval) problems.push(approvalProblem(root, slug));
  else {
    const rel = relativeTo(wt, sp);
    const merged = specAt(root, approval.commit, rel);
    const known = spawnSync('git', ['cat-file', '-e', `${approval.commit}^{commit}`], { cwd: root }).status === 0;
    if (!known) problems.push(`the approved merge ${approval.commit.slice(0, 7)} is not in this clone yet; run git fetch origin, then kit lane scope ${slug} again`);
    else if (merged === null) problems.push(`the recorded approval of ${slug} (merge ${approval.commit.slice(0, 7)}) has no ${rel}; merge the spec PR that carries it with kit lane merge`);
    else if (merged !== readText(sp)) {
      problems.push(`the lane's ${rel} differs from the spec you approved (merged as ${approval.commit.slice(0, 7)}); take the approved one (git -C ${wt} checkout ${approval.commit.slice(0, 7)} -- ${rel}), or approve the change through a new spec/${slug} PR`);
    }
  }
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
  writeText(lj, K.jsonDumps(laneData, { indent: 2 }) + '\n');
  const moved = moveLane(root, slug, 'test');
  if (moved.length) return refuse(moved);
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
  if (!K.isFile(pjoin(wt, '.claude', 'lane.json'))) return refuse([`no lane for ${slug}; run kit lane start ${slug} first`]);
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

/**
 * What a lane would lose on merge. The check log lives in the gitignored `.claude/session/`, so every `log#N`
 * citation in the merged progress and review files resolves against nothing once the worktree is removed, and the
 * retro has no evidence to read. The events file is in the work root but nothing required it to be committed.
 *
 * Returns the problems, so `merged` can refuse and say which, and `evidence` can fix them.
 */
export function evidenceGaps(root, slug) {
  const kit = asDict(K.loadKitJson(root));
  const wt = laneWorktree(root, kit, slug);
  const repo = wt ?? root;
  const work = K.workRoot(repo);
  const out = [];
  const tracked = (rel) => pyStrip(K.git(['ls-files', '--', rel], repo)) !== '';
  // The gate protects evidence that exists; it does not demand that evidence exist. A lane that ran no checks has
  // nothing to lose, and whether a criterion needed a run is done-check's question, asked long before this one.
  const lane = K.findLane(repo);
  const liveLog = lane && K.isFile(lane.logPath);
  for (const rel of [`${work}/${slug}.events.jsonl`, `${work}/${slug}.checks.txt`]) {
    const exists = K.isFile(pjoin(repo, rel));
    if (exists && !tracked(rel)) out.push(`${rel} exists but is not committed`);
    else if (!exists && rel.endsWith('.checks.txt') && liveLog) {
      out.push(`${rel} does not exist, but ${relativeTo(repo, lane.logPath)} does and is gitignored, so its log#N citations die with the worktree`);
    }
  }
  return out;
}

/** Copy the live check log to the committed copy, line for line, so `log#N` citations keep resolving after merge. */
export function evidence(root, slug) {
  const kit = asDict(K.loadKitJson(root));
  const wt = laneWorktree(root, kit, slug) ?? root;
  const lane = K.findLane(wt);
  if (!lane) return [`no lane.json for '${slug}'`];
  const dest = pjoin(wt, lane.work, `${slug}.checks.txt`);
  if (!K.isFile(lane.logPath)) return [`no check log at ${relativeTo(wt, lane.logPath)}; nothing has run yet`];
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(lane.logPath, dest);
  process.stdout.write(K.jsonDumps({ copied: relativeTo(wt, dest), from: relativeTo(wt, lane.logPath), lines: K.readLines(dest).length }) + '\n');
  return [];
}

// ---------------------------------------------------------------------------
// The owner's spec approval (hardening plan Step 2, D1 "The approval line")
// ---------------------------------------------------------------------------

/**
 * The owner approves a spec by saying yes to merging its spec/<slug> PR: `kit lane merge`, which Claude Code asks
 * about every time. lane.js merge then records that yes in the lane store: who, when, the PR, its head and the commit
 * the merge made on the base. That record is the only approval lane.js accepts. An `Approved by:` line in the spec is
 * not read, so an agent that writes one approves nothing. lane.js start keeps the record when it starts the lane.
 */
export function recordSpecApproval(root, slug, approval) {
  const p = storePath(root, slug);
  const prev = K.isFile(p) ? asDict(JSON.parse(readText(p))) : {};
  const rec = { version: 1, slug, ...prev, spec_approval: { ...approval } };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeText(tmp, K.jsonDumps(rec, { indent: 2 }) + '\n');
  fs.renameSync(tmp, p);
  return rec.spec_approval;
}

/** The recorded approval of the slug's spec ({ by, at, pr, head, commit }), or null when there is none. */
export function specApproval(root, slug) {
  const a = readStore(root, slug)?.spec_approval;
  return a && typeof a === 'object' && typeof a.commit === 'string' && a.commit ? a : null;
}

/** Why the slug's spec counts as not approved, or null when its approval is recorded. */
export function approvalProblem(root, slug) {
  if (specApproval(root, slug)) return null;
  return `no recorded approval for ${slug}: merge the spec PR first, with kit lane merge --pr <the spec/${slug} PR> --by <your name>; ` +
    "it asks for your yes and records it. An 'Approved by:' line in the spec does not count. If that PR is already merged, run the same command: it records the merge.";
}

// ---------------------------------------------------------------------------
// A human's security sign-off (hardening plan Step 2, #58)
// ---------------------------------------------------------------------------

/**
 * A high-risk lane whose profile asks for one is merged only after a named human signs it off: `kit lane signoff <slug>
 * --by <name>`, which Claude Code asks about every time (an ask rule, like merging). It records who, when and the lane's
 * HEAD commit in the lane store, field `security_signoff`. That record is the only sign-off next-step and lane.js merge
 * accept, and only for that commit: a later commit on the lane makes it stale. A sign-off written in a file is not read.
 */
export function signoff(root, slug, by) {
  const name = String(by ?? '').trim();
  if (!name) return refuse(['--by <name> is required: the human who reviewed the lane and signs it off']);
  if (!K.isFile(pjoin(lanesDir(root), slug, '.claude', 'lane.json'))) return refuse([`no lane for ${slug}; a sign-off is for a lane's commits, so start the lane first (kit lane start ${slug})`]);
  const fields = laneFields(root, slug);
  if (!signoffRequired(fields)) {
    return refuse([`${slug} does not need a security sign-off (risk ${fields.risk}, work type ${fields.work_type}); nothing is recorded. Merge it with kit lane merge ${slug} --by <your name> when its review passes.`]);
  }
  const { branch, tip, own } = laneRefs(root, slug);
  if (!tip || !own) return refuse([`${branch} has no commits of its own, so there is nothing to sign off; sign off once the lane's work is committed`]);
  const p = storePath(root, slug);
  const prev = K.isFile(p) ? asDict(JSON.parse(readText(p))) : {};
  const rec = { version: 1, slug, ...prev, security_signoff: { by: name, at: K.isoSeconds(), commit: tip, branch } };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeText(tmp, K.jsonDumps(rec, { indent: 2 }) + '\n');
  fs.renameSync(tmp, p);
  process.stdout.write(`lane ${slug}: security sign-off by ${name} recorded for ${branch} at ${tip.slice(0, 7)}; a later commit on the lane needs a new sign-off\n`);
  return 0;
}

const noSignoff = (slug) => `none is recorded: a named human reviews the lane, then runs kit lane signoff ${slug} --by <your name>, which asks for your yes and records it in the lane store with the lane's HEAD commit; a sign-off written in a file does not count`;

/** The recorded sign-off of the lane ({ by, at, commit, branch }), or null when there is none. */
export function securitySignoff(root, slug) {
  const s = readStore(root, slug)?.security_signoff;
  return s && typeof s === 'object' && typeof s.by === 'string' && s.by.trim() && typeof s.commit === 'string' && /^[0-9a-f]{40,64}$/.test(s.commit) ? s : null;
}

/**
 * Why the lane's sign-off does not cover `heads` (the commits about to be merged: the PR's head, the local lane tip), or
 * null when it does. Phrased to follow "needs a human security sign-off before the merge and".
 */
export function signoffProblem(root, slug, heads) {
  const s = securitySignoff(root, slug);
  const again = `kit lane signoff ${slug} --by <your name>`;
  if (!s) return noSignoff(slug);
  const known = [...new Set(heads.filter(Boolean))];
  if (!known.length) return `the recorded one (${s.by}, ${s.commit.slice(0, 7)}) cannot be checked: the lane's branch is not here; restore it, or pass the PR to kit lane merge, which reads its head`;
  const moved = known.filter((h) => h !== s.commit);
  if (!moved.length) return null;
  return `the recorded one is stale: ${s.by} signed off ${s.commit.slice(0, 7)} at ${s.at}, and the lane is now at ${moved.map((h) => h.slice(0, 7)).join(' / ')}; review the commits since, push them if the PR lacks them, then run ${again} again`;
}

/** The spec's text at a commit, or null when the commit does not have it. */
function specAt(root, commit, rel) {
  try {
    return K.git(['show', `${commit}:${rel}`], root);
  } catch (e) {
    if (!isCalledProcessError(e)) throw e;
    return null;
  }
}

/**
 * lane.js start, for a lane that builds from a spec: the spec must be on the base the lane starts from, say it is
 * approved, and the recorded approval's merge must be in that base. [] when all hold, else what to do.
 */
export function approvedOnBase(root, slug, rel, startPoint, baseCommit) {
  const text = specAt(root, baseCommit, rel);
  if (text === null) return [`spec ${rel} is not on ${startPoint}: merge the spec PR first (kit lane merge --pr <the spec/${slug} PR> --by <your name>), then start the lane again`];
  const status = K.headerFields(K.stripHtmlComments(K.splitlines(text))).get('status')?.[1] ?? '';
  if (!['approved', 'building', 'escalated'].includes(status.toLowerCase())) {
    return [`the spec on ${startPoint} says Status: ${status || '(none)'}; it is approved when a spec/${slug} PR that sets Status: approved is merged with kit lane merge. Do that, then start the lane again.`];
  }
  const a = specApproval(root, slug);
  if (!a) return [approvalProblem(root, slug)];
  if (spawnSync('git', ['merge-base', '--is-ancestor', a.commit, baseCommit], { cwd: root }).status !== 0) {
    return [`the recorded approval of ${slug} (${a.pr ? `PR #${a.pr}, ` : ''}merged as ${a.commit.slice(0, 7)}) is not in ${startPoint}; if that merge was reverted, merge a new spec/${slug} PR with kit lane merge, then start the lane again`];
  }
  return [];
}

export function precheck(root, slug) {
  const problems = [];
  const sp = specPath(root, slug);
  if (!K.isFile(sp)) return [`spec ${relativeTo(root, sp)} does not exist; run /zi-plan ${slug}`];
  const v = new V.Validator(root, null, K.loadKitJson(root));
  v.run(sp, 'spec');
  for (const x of v.v) problems.push(`spec invalid: ${x}`);
  const hdr = specHeader(sp);
  const status = (hdr.get('status') ?? '').toLowerCase();
  if (!['approved', 'building', 'escalated'].includes(status)) {
    problems.push(`spec status is '${hdr.get('status') ?? ''}', needs 'approved' (set it on the spec/${slug} PR; merging that PR with kit lane merge is the approval)`);
  }
  const unapproved = approvalProblem(root, slug);
  if (unapproved) problems.push(unapproved);
  const [n, limit, lanes] = wip(root);
  if (status === 'approved' && n >= limit) {
    problems.push(`WIP limit reached: ${n}/${limit} in flight (${lanes.join(', ')}). Merge or escalate one first.`);
  }
  // Derived state and the board must agree: a lane kit.json records as open is one main should show in flight.
  // When they disagree the board is the stale one, and nobody reading it can tell (#36).
  const byStatus = new Map(roadmapRows(root).map((r) => [r.slug, r.status]));
  for (const s of Object.keys(asDict(kget(asDict(K.loadKitJson(root)), 'lanes', {})))) {
    const st = byStatus.get(s);
    if (st !== undefined && !IN_FLIGHT.has(st)) {
      problems.push(`kit.json records lane '${s}' as open but main's ROADMAP row reads '${st}', which is not in flight; run kit lane roadmap-set ${s} building --repo <main repo>`);
    }
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
  if (isStopped(root)) return refuse([`kill switch set; kit lane resume-all --by <name> first`]);
  const fields = goalFields(root, slug);
  if (!profileFor(fields.work_type)) return refuse([`unknown work_type '${fields.work_type}' in docs/goals/${slug}.md; profiles: ${Object.keys(loadProfiles()).join(', ')}`]);
  const unbuilt = notBuilt(fields);
  if (unbuilt.length) return refuse(unbuilt);
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
  if (fs.existsSync(wt)) return refuse([`worktree ${wt} already exists; resume with /zi-implement ${slug} inside it, or run kit lane finish first`]);
  // The lane starts from the base as the remote has it, never from a stale local copy (hardening plan D3): a failed
  // fetch is refused; a repo with no origin is refused unless kit.json says it is local-only.
  const hasOrigin = K.git(['remote'], root).split(/\s+/).filter(Boolean).includes('origin');
  const localOnly = kget(kit, 'local_only', false) === true;
  let startPoint;
  if (hasOrigin) {
    try {
      // an explicit refspec: a fetch by branch name alone updates origin/<base> only when the remote's refspec covers it
      K.git(['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], root);
      startPoint = `origin/${base}`;
    } catch (e) {
      if (!isCalledProcessError(e)) throw e;
      const lines = pyStrip(e.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      const why = (lines.find((l) => /^fatal:/.test(l)) ?? lines[0] ?? 'git fetch failed').replace(/\.+$/, '');
      return refuse([`could not fetch '${base}' from origin, so the lane would start from a stale base (${why}). Fix the network or the remote and start again.`]);
    }
  } else if (localOnly) {
    startPoint = base;
  } else {
    return refuse([`this repo has no 'origin' remote, so the lane cannot start from the shared base. Add the remote, or, if the repo really has none, set "local_only": true in .claude/kit.json.`]);
  }
  let baseCommit;
  try {
    baseCommit = pyStrip(K.git(['rev-parse', '--verify', `${startPoint}^{commit}`], root));
  } catch (e) {
    if (!isCalledProcessError(e)) throw e;
    return refuse([`base '${startPoint}' does not exist`]);
  }
  // A lane builds only a spec the owner approved by merging it (hardening plan D1): on the base it starts from, approved,
  // with the recorded merge in that base. A fix/incident lane has no spec yet; lane.js scope checks it later.
  if (!reproFirst) {
    const unapproved = approvedOnBase(root, slug, `${work}/${slug}.md`, startPoint, baseCommit);
    if (unapproved.length) return refuse(unapproved);
  }
  // kept on the lane's new record; a fix/incident lane has no approved spec yet, so an older record's approval is dropped
  const approval = reproFirst ? null : specApproval(root, slug);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const wtArgs = ['worktree', 'add', '-q', '-b', branch, wt, baseCommit];
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
      'The waiver is written to the lane and the events log and shown by /zi-status.',
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
    base, base_commit: baseCommit, branch, start_commit: startCommit, budget: kget(kget(kit, 'budgets', {}), 'build', {}),
    risk: highRisk ? 'high' : 'normal',
    work_type: fields.work_type, size: fields.size, domain: fields.domain,
    sandbox: { runtime: sandbox.runtime, state: sandbox.state, how: sandbox.how, settings: relativeTo(wt, sandboxSettings), allowed_domains: sandbox.allowedDomains.length,
      ...(highRisk && sandbox.runtime !== 'container' ? { high_risk_waiver: { by: kget(waiver, 'by', ''), reason: kget(waiver, 'reason', '') } } : {}) },
  };
  writeText(pjoin(wt, '.claude', 'lane.json'), K.jsonDumps(lane, { indent: 2 }) + '\n');
  recordMove(root, slug, wt, null, lane.stage, { mirror: false }); // a new record: the lane's first stage
  if (approval) recordSpecApproval(root, slug, approval); // the new record keeps the owner's recorded yes
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
  // The status goes on MAIN, which is the only copy anyone reads to see what is in flight. Writing it into the
  // worktree left the main checkout at waiting-approval through build and both reviews of the field run, and
  // waiting-approval is not in IN_FLIGHT, so a WIP check there counted nothing. cbfaeb5 worked around that by
  // deriving the count from kit.json; this fixes the writer. Uncommitted on main, exactly as the kit.json
  // registration below is: the lane does not own main's history.
  roadmapSet(root, slug, 'building', { lane: relativeTo(path.dirname(root), wt) });
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
  if (!K.isFile(lj)) return refuse([`no lane for ${slug}; run kit lane start ${slug} first`]);
  const data = asDict(JSON.parse(readText(lj)));
  const cfg = SB.sandboxConfig({ root, wt, slug });
  const recorded = asDict(kget(data, 'sandbox', {}));
  if (kget(recorded, 'runtime', null) !== cfg.runtime) {
    return refuse([`sandbox runtime changed since start (recorded '${kget(recorded, 'runtime', null)}', now '${cfg.runtime}'); a lane keeps one runtime: finish it and start again`]);
  }
  if (kget(data, 'risk', 'normal') === 'high' && cfg.runtime !== 'container' && !pyTruthy(kget(asDict(kget(recorded, 'high_risk_waiver', {})), 'by', ''))) return refuse(['high-risk lane without the container runtime and no recorded waiver']);
  const settingsPath = pjoin(wt, '.claude', 'session', 'sandbox.json');
  writeText(settingsPath, K.jsonDumps(SB.srtSettings(cfg), { indent: 2 }) + '\n');
  const text = prompt ?? `/zi-run ${slug}`;
  // the session's own grants (hardening plan Step 2): only what a lane runs, never advance, gate, start or a merge
  const claudeSettings = SB.writeRunSettings(pjoin(wt, '.claude', 'session', 'claude-settings.json'), { root, wt });
  const cmd = SB.launchCommand(cfg, { wt, settingsPath, prompt: text, claudeSettings });
  // telemetry (KIT-SPEC 9.4): exporter on, records tagged with project, lane and stage; the collector runs on the host side
  const project = kget(asDict(K.loadKitJson(root)), 'project', path.basename(root));
  const telemetry = SB.telemetryEnv({ project, slug, stage: kget(data, 'stage', 'build') });
  K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'launch', runtime: cfg.runtime, state: cfg.state, exec, telemetry: telemetry.OTEL_EXPORTER_OTLP_ENDPOINT, summary: cmd.slice(0, 3).join(' ') });
  if (!exec) {
    process.stdout.write(K.jsonDumps({ runtime: cfg.runtime, state: cfg.state, cwd: wt, command: cmd, settings: relativeTo(wt, settingsPath), claude_settings: relativeTo(wt, claudeSettings), env: telemetry }, { indent: 2 }) + '\n');
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

// ---------------------------------------------------------------------------
// The lane store and lane.js advance (hardening plan Step 2, D2; 0016 E.1 Add 1)
// ---------------------------------------------------------------------------

/**
 * A lane's record: one JSON file per lane in the MAIN checkout, under the gitignored .claude/session/, so it is outside
 * the lane's worktree and never committed. advance (with start, scope and merged, which move through it) is its only
 * writer. Fields: version, slug, stage, updated, and moves (each: from, to, at, the lane's HEAD commit). Later steps add
 * their own fields beside these (the spec approval, a security sign-off, rounds, and `merge`, which lane.js merge and
 * merged write through recordMerge); a move keeps every field it does not write.
 */
export function storeDir(root) {
  return pjoin(root, '.claude', 'session', 'lanes');
}

export function storePath(root, slug) {
  return pjoin(storeDir(root), `${slug}.json`);
}

/** The lane's record, or null when it has none (no lane, or a lane started before the store). */
export function readStore(root, slug) {
  const p = storePath(root, slug);
  return K.isFile(p) ? asDict(JSON.parse(readText(p))) : null;
}

/** The lane's stage: the store's; for a lane started before the store, its lane.json's until its first move. */
export function laneStage(root, slug) {
  const rec = readStore(root, slug);
  // a record may hold only the spec approval (merged before the lane, or for a lane started before the store)
  if (rec && Object.hasOwn(rec, 'stage')) return kget(rec, 'stage', null);
  const lj = pjoin(lanesDir(root), slug, '.claude', 'lane.json');
  return K.isFile(lj) ? kget(asDict(JSON.parse(readText(lj))), 'stage', null) : null;
}

/**
 * The allowed moves: from each stage, the stages a lane may go to and what must justify the move (null: nothing; the
 * move re-enters a stage or sends the work back). A move not listed is refused. lane.js start writes the first stage:
 * build, or reproduce for a lane that opens before its spec (fix, incident).
 *   scoped  the lane's spec is approved and its criteria are in progress.md (lane.js scope makes this move)
 *   red     every criterion except a preserved (P) one cites a logged run of its test that failed
 *   green   every criterion cites both runs it needs: red as above, and a logged run of its test that passed
 *   gated   green as above, and the gate (lane.js gate) PASSED on the lane's HEAD: no reviewer starts on a FAIL, on a
 *           verdict for an older commit, or with no verdict (hardening plan Step 3; 0016 E.1 Add 2)
 *   merged  the lane branch is merged into the base (lane.js merged makes this move). A merge is a fact in git, gated
 *           by GitHub and the owner's yes, so it is recorded from whatever stage the lane had reached.
 *   human   a named human (--by) lets a parked lane go on. A lane is parked by advance itself, never moved there: a
 *           review → build move that would start a round past the limit parks it (moveLane).
 */
export const MOVES = {
  reproduce: { reproduce: null, test: 'scoped', retro: 'merged' },
  test: { test: null, build: 'red', retro: 'merged' },
  build: { build: null, test: null, review: 'gated', retro: 'merged' },
  review: { review: 'gated', build: null, retro: 'merged' },
  parked: { build: 'human', retro: 'merged' },
  retro: { retro: null },
};

/**
 * The lane's criteria, and how many cite a real red and a real green run in its check log. A cell counts only when
 * it names a logged run of the row's test with the right outcome, never because it contains `#` (#56).
 */
export function laneRuns(wt) {
  const out = { criteria: 0, red: 0, green: 0, problems: { red: [], green: [] } };
  const lane = wt ? K.findLane(wt) : null;
  if (!lane || !K.isFile(lane.progressPath)) return out;
  const logLines = K.isFile(lane.logPath) ? K.readLines(lane.logPath) : [];
  const dc = K.parseSections(K.stripHtmlComments(K.readLines(lane.progressPath))).get('done-criteria');
  for (const [, cells] of dc ? dc.tableRows() : []) {
    if (cells.length < 5) continue;
    out.criteria += 1;
    const red = /^P\d+$/.test(cells[0].trim()) ? null : K.runRefProblem(lane, logLines, cells, 'red');
    const green = K.runRefProblem(lane, logLines, cells, 'green');
    if (red) out.problems.red.push(red);
    else out.red += 1;
    if (green) out.problems.green.push(green);
    else out.green += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Is the lane merged? (#67, #82) One answer for lane.js merged and advance, kit_status, next-step and the dashboard.
// ---------------------------------------------------------------------------

const gitRaw = (root, args, input) => spawnSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const gitLine = (root, args) => {
  const r = gitRaw(root, args);
  return r.status === 0 ? r.stdout.trim() : '';
};
const isAncestor = (root, a, b) => gitRaw(root, ['merge-base', '--is-ancestor', a, b]).status === 0;

/** The lane's base, branch, tip, start commit and number of its own commits (first parent, no merges). */
export function laneRefs(root, slug) {
  const kit = asDict(K.loadKitJson(root));
  const base = kget(kit, 'default_branch', 'main');
  const kl = asDict(kget(kget(kit, 'lanes', {}), slug, null) || {});
  const lj = pjoin(kl.worktree ? pjoin(kl.worktree) : pjoin(lanesDir(root), slug), '.claude', 'lane.json');
  const laneJson = K.isFile(lj) ? asDict(JSON.parse(readText(lj))) : {};
  const branch = kget(laneJson, 'branch', null) || `wt/${slug}`;
  const start = kget(laneJson, 'start_commit', null) || kget(kl, 'start_commit', null);
  const tip = gitLine(root, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  const own = tip && start && tip !== start ? Number(gitLine(root, ['rev-list', '--first-parent', '--no-merges', '--count', `${start}..${tip}`]) || 0) : 0;
  return { base, branch, tip, start, own };
}

/** `git patch-id` of a diff, whitespace kept where this git can (`--verbatim`, git 2.39+). Lines: `<patch-id> <commit>`. */
function patchIds(root, diff) {
  if (!diff) return [];
  let r = gitRaw(root, ['patch-id', '--stable', '--verbatim'], diff);
  if (r.status !== 0) r = gitRaw(root, ['patch-id', '--stable'], diff);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')) : [];
}

const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary'];

/**
 * Whether the lane is merged into the base, from git and the store alone (no network), and how:
 *   ancestor  the lane tip is an ancestor of the base (a merge commit or a fast-forward)
 *   recorded  lane.js merge or lane.js merged read the merge from GitHub and wrote it in the store, for this tip
 *   squash    one commit on the base since the lane's merge-base has the patch of the lane's whole diff
 *             (`merge-base..tip`), single- or multi-commit; `git cherry` compares commit by commit and misses this.
 *             A one-commit lane's rebase merge reads as this too.
 *   rebase    every lane commit not in the base has an equal patch in the base (`git cherry`: GitHub's rebase merge)
 * A lane with no commits of its own, or no start commit to count them from, is never merged (field test #38); with no
 * branch, the state is 'no-branch' and nothing is claimed. Each signal is a fact about content, so a false 'merged' needs
 * a base commit carrying the lane's exact patch. A revert on the base does not un-merge a lane: the lane was merged and
 * its retro is due; undoing the change is new work. A lane that moved on after its merge (a commit the merge did not
 * carry) is not merged. Not detected (safe): a squash whose diff differs from the lane's (conflicts resolved, or base
 * changes inside a hunk's context); `lane.js merged --pr` then asks GitHub.
 */
export function laneMerge(root, slug) {
  const { base, branch, tip, start, own } = laneRefs(root, slug);
  if (!tip) return { merged: false, state: 'no-branch', why: `no branch ${branch}` };
  const no = (why) => ({ merged: false, state: 'not-merged', why: `${branch} is not merged into ${base} yet (${why})` });
  if (!start) return no('no start_commit recorded, so the lane\'s own commits cannot be told from the base\'s');
  if (!own) return no(`no lane commits in ${base}: the lane has no commits of its own`);
  const yes = (how, commit = null) => ({ merged: true, state: 'merged', how, commit });
  if (isAncestor(root, tip, base)) return yes('ancestor', tip);
  const rec = asDict(kget(readStore(root, slug) ?? {}, 'merge', {}));
  if (typeof rec.head === 'string' && (rec.head === tip || isAncestor(root, tip, rec.head))) return yes('recorded', rec.commit ?? null);
  const mb = gitLine(root, ['merge-base', base, tip]);
  if (!mb) return no(`no lane commits in ${base}`);
  const lane = patchIds(root, gitRaw(root, ['diff', ...DIFF_OPTS, mb, tip]).stdout)[0]?.[0];
  if (lane) {
    const log = gitRaw(root, ['log', '-p', '--no-merges', '--format=commit %H', ...DIFF_OPTS, `${mb}..${base}`]).stdout;
    const hit = patchIds(root, log).find(([pid]) => pid === lane);
    if (hit) return yes('squash', hit[1]);
  }
  const cherry = gitLine(root, ['cherry', base, tip, mb]).split('\n').filter(Boolean);
  if (cherry.length && cherry.every((l) => l.startsWith('- '))) return yes('rebase');
  return no(`no lane commits in ${base}`);
}

/**
 * Ask GitHub whether PR `pr` merged this lane: MERGED, from the lane's branch into the base, with a head that holds the
 * local tip (a later local commit was not merged). The answer is GitHub's, so the merge commit need not be fetched.
 */
export function githubMerge(root, slug, pr) {
  const { base, branch, tip, own } = laneRefs(root, slug);
  const no = (why) => ({ merged: false, why: `PR ${pr}: ${why}` });
  if (!tip || !own) return no(`${branch} has no commits of its own`);
  let info;
  try {
    info = asDict(JSON.parse(G.gh(root, ['pr', 'view', String(pr), '--json', 'number,state,mergeCommit,headRefOid,headRefName,baseRefName'])));
  } catch (e) {
    return no(`GitHub could not be read (${e.message})`);
  }
  if (info.state !== 'MERGED' || !info.mergeCommit?.oid) return no(`GitHub says ${String(info.state ?? 'unknown').toLowerCase()}, not merged`);
  if (info.headRefName !== branch || info.baseRefName !== base) return no(`merged ${info.headRefName} into ${info.baseRefName}, not ${branch} into ${base}`);
  if (info.headRefOid !== tip && !isAncestor(root, tip, info.headRefOid)) return no(`merged head ${String(info.headRefOid).slice(0, 7)} does not hold ${branch} at ${tip.slice(0, 7)}`);
  return { merged: true, how: 'github', pr: info.number ?? pr, commit: info.mergeCommit.oid, head: info.headRefOid };
}

/**
 * Write a merge GitHub reported into the lane store (field `merge`: pr, commit, head, at), the copy laneMerge trusts,
 * and into the lane's lane.json for the hooks to read. lane.json is in the lane's worktree, so laneMerge never reads it.
 */
export function recordMerge(root, slug, fact) {
  const merge = { pr: fact.pr, commit: fact.commit, head: fact.head, at: K.isoSeconds() };
  const lf = pjoin(lanesDir(root), slug, '.claude', 'lane.json');
  const p = storePath(root, slug);
  const prev = readStore(root, slug);
  if (prev || K.isFile(lf)) {
    // a lane started before the store gets its record here, at the stage its lane.json holds
    const rec = { version: 1, slug, stage: laneStage(root, slug), moves: [], ...(prev ?? {}), merge };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeText(tmp, K.jsonDumps(rec, { indent: 2 }) + '\n');
    fs.renameSync(tmp, p);
  }
  if (K.isFile(lf)) writeText(lf, K.jsonDumps({ ...asDict(JSON.parse(readText(lf))), merge }, { indent: 2 }) + '\n');
}

/** Why the lane does not count as merged into the base, or null when it does (or its branch is gone: nothing to check). */
export function notMerged(root, slug) {
  const m = laneMerge(root, slug);
  return m.merged || m.state === 'no-branch' ? null : m.why;
}

/** What is missing for a move that needs `why` (see MOVES); [] when nothing is. */
function justify(root, slug, wt, why, { by = null } = {}) {
  if (why === 'human') return by && pyStrip(String(by)) ? [] : [`the lane is parked; only a named human lets it go on: kit lane advance ${slug} build --by <name>`];
  if (why === 'red' || why === 'green' || why === 'gated') {
    const runs = laneRuns(wt);
    if (!runs.criteria) return ['progress.md has no done-criteria rows'];
    if (why === 'red') return runs.problems.red;
    const runProblems = [...runs.problems.red, ...runs.problems.green];
    return why === 'green' ? runProblems : [...runProblems, ...gateProblem(root, slug, wt)];
  }
  if (why === 'scoped') {
    const sp = pjoin(wt, K.findLane(wt).work, `${slug}.md`);
    if (!K.isFile(sp) || !specApproval(root, slug)) return ["the lane's spec is not approved yet: its spec/<slug> PR has not been merged with kit lane merge"];
    return laneRuns(wt).criteria ? [] : ['progress.md has no done-criteria rows; kit lane scope copies them from the approved spec'];
  }
  if (why === 'merged') {
    const m = notMerged(root, slug);
    return m ? [m] : [];
  }
  return [];
}

/**
 * Write the move to the store, keeping the record's other fields; a lane's first stage starts a new record. Then copy
 * the stage into the lane's lane.json, which the in-lane hooks read (budget, done-check), with a fresh clock and that
 * stage's budget, as lane.js stage did.
 */
function recordMove(root, slug, wt, from, to, { mirror = true, fields = {} } = {}) {
  const now = K.isoSeconds();
  let commit = null;
  try {
    commit = pyStrip(K.git(['rev-parse', 'HEAD'], wt));
  } catch (e) {
    if (!isCalledProcessError(e)) throw e;
  }
  const p = storePath(root, slug);
  const prev = from !== null && K.isFile(p) ? asDict(JSON.parse(readText(p))) : {};
  const moves = Array.isArray(prev.moves) ? prev.moves : [];
  const lf = pjoin(wt, '.claude', 'lane.json');
  const data = K.isFile(lf) ? asDict(JSON.parse(readText(lf))) : {};
  // #41: a human's raise (budget_override.<stage>) outlives the stage change; it used to be overwritten by the default.
  const budget = { ...asDict(kget(kget(asDict(K.loadKitJson(root)), 'budgets', {}), to, {})), ...asDict(kget(asDict(kget(data, 'budget_override', {})), to, {})) };
  // wall time: `started` is the lane's first move (kept by every later move); each move has its `at`
  const started = typeof prev.started === 'string' ? prev.started : moves[0]?.at ?? now;
  const rec = { version: 1, slug, ...prev, started, ...fields, stage: to, updated: now, budget, moves: [...moves, { from, to, at: now, commit }] };
  for (const [k, v] of Object.entries(rec)) if (v === undefined) delete rec[k];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeText(tmp, K.jsonDumps(rec, { indent: 2 }) + '\n');
  fs.renameSync(tmp, p);
  if (!mirror || !K.isFile(lf)) return;
  // a copy for the in-lane hooks that still read lane.json; the budget hook reads the store
  data.stage = to;
  data.started = now;
  data.budget = budget;
  writeText(lf, K.jsonDumps(data, { indent: 2 }) + '\n');
}

// ---------------------------------------------------------------------------
// Rounds (hardening plan Step 2, D2; 0016 E.1 Add 6 and E.8 item 8)
// ---------------------------------------------------------------------------

/** The round limit when kit.json sets none: three review FAIL rounds, then the owner decides (/zi-review). */
export const DEFAULT_MAX_ROUNDS = 3;

/** kit.json `max_rounds` in the main checkout (a whole number from 1), else DEFAULT_MAX_ROUNDS. */
export function maxRounds(root) {
  const n = kget(asDict(K.loadKitJson(root)), 'max_rounds', DEFAULT_MAX_ROUNDS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_ROUNDS;
}

/**
 * A lane's rounds, from its store record alone. A round is one build, gate and review cycle; a review FAIL ends it,
 * and advance counts it on the review → build move that sends the work back (`failed_rounds`). The lane is in round
 * failed + 1 of `limit`: kit.json max_rounds, or the `round_limit` a named human set when the lane was let go on
 * after it parked. A record without the fields (a lane started before them) counts from 0.
 */
export function laneRounds(root, rec) {
  const r = asDict(rec ?? {});
  const failed = Number.isInteger(r.failed_rounds) && r.failed_rounds >= 0 ? r.failed_rounds : 0;
  const limit = Number.isInteger(r.round_limit) && r.round_limit >= 1 ? r.round_limit : maxRounds(root);
  const parked = r.stage === 'parked' ? asDict(kget(r, 'parked', {})) : null;
  return { round: parked ? failed : failed + 1, limit, failed, parked: parked ? { reason: kget(parked, 'reason', 'parked'), at: kget(parked, 'at', null) } : null };
}

/** What a named human runs to let a parked lane go on, one more round. */
export const unparkHint = (slug) => `a human reads the review and decides: kit lane advance ${slug} build --by <name> allows one more round, or kit lane finish ${slug} ends the lane`;

/**
 * Move a lane to `to` when MOVES allows it and the lane's files justify it. [] when moved, else why not. A review →
 * build move counts a FAIL round; when it would start a round past the limit the lane is parked instead (stage
 * `parked`, with the reason) and the move is refused. From `parked` only a named human (`by`) moves it back to build,
 * for one more round.
 */
export function moveLane(root, slug, to, { by = null } = {}) {
  if (isStopped(root)) return ['kill switch set; kit lane resume-all --by <name> first'];
  const wt = pjoin(lanesDir(root), slug);
  if (!K.isFile(pjoin(wt, '.claude', 'lane.json'))) return [`no lane for ${slug}; run kit lane start ${slug} first`];
  const from = laneStage(root, slug);
  if (!Object.hasOwn(MOVES, from)) return [`${slug} is at '${from}', which is not a lane stage (${Object.keys(MOVES).join(', ')})`];
  const allowed = MOVES[from];
  const rec = readStore(root, slug);
  const rounds = laneRounds(root, rec);
  if (!Object.hasOwn(allowed, to)) {
    const parked = from === 'parked' ? [`  parked: ${rounds.parked?.reason ?? 'past the round limit'}`, `  ${unparkHint(slug)}`] : [];
    return [`${slug}: ${from} → ${to} is not an allowed move; from ${from} a lane may go to ${Object.keys(allowed).join(', ')}`, ...parked];
  }
  const missing = justify(root, slug, wt, allowed[to], { by });
  if (missing.length) return [`${slug}: ${from} → ${to} refused:`, ...missing.map((m) => `  ${m}`)];
  let fields = {};
  if (from === 'review' && to === 'build') {
    const failed = rounds.failed + 1;
    if (failed + 1 > rounds.limit) {
      const reason = `${failed} review FAIL round${failed === 1 ? '' : 's'}; round ${failed + 1} would pass the limit of ${rounds.limit} (kit.json max_rounds)`;
      recordMove(root, slug, wt, from, 'parked', { fields: { failed_rounds: failed, parked: { reason, at: K.isoSeconds(), round: failed } } });
      roadmapSet(root, slug, 'escalated');
      K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'parked', result: 'fail', summary: `lane parked: ${reason}` });
      return [`${slug}: review → build refused: the lane is parked`, `  ${reason}`, `  ${unparkHint(slug)}`];
    }
    fields = { failed_rounds: failed };
  }
  const unpark = from === 'parked' && to === 'build';
  if (unpark) {
    // a named human lets the lane go on: one more round, after which the next FAIL parks it again
    const unparked = Array.isArray(rec?.unparked) ? rec.unparked : [];
    fields = { parked: undefined, round_limit: rounds.failed + 1, unparked: [...unparked, { by: pyStrip(String(by)), at: K.isoSeconds(), round: rounds.failed + 1, reason: rounds.parked?.reason ?? null }] };
  }
  recordMove(root, slug, wt, from, to, { fields });
  if (unpark) roadmapSet(root, slug, 'building');
  return [];
}

/** lane.js advance, and lane.js stage, its old name (the same call): the only way a lane's stage moves. */
export function advance(root, slug, to, { by = null } = {}) {
  const problems = moveLane(root, slug, to, { by });
  if (problems.length) return refuse(problems);
  process.stdout.write(`lane ${slug}: stage ${to}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Gate (hardening plan Step 3; 0016 E.1 Add 2; #56 S1.1, S1.2, S1.4)
// ---------------------------------------------------------------------------

/** Per-check time limit when the base's kit.json sets no `gate_timeout_min`. */
export const GATE_TIMEOUT_MIN = 20;
/** How much of a check's output the report keeps (its end, where test runners print the failures). */
const GATE_OUTPUT_TAIL = 64 * 1024;
/** Credentials a check never gets: it runs agent-written code (tests, build scripts). */
const GATE_ENV_DROP = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'KIT_APP_TOKEN', 'KIT_APP_PRIVATE_KEY', 'KIT_APP_ID', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * The base branch's kit.json as committed, never the lane's copy or the main checkout's working file (0016 E.1 Add 2):
 * origin's base branch when the repo has an origin, else the local base branch (a local_only repo). Null when neither
 * has one.
 */
export function baseKitJson(root, base) {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    const commit = gitLine(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!commit) continue;
    const r = gitRaw(root, ['show', `${commit}:.claude/kit.json`]);
    if (r.status !== 0) return { ref, commit, kit: null, why: `${ref} has no .claude/kit.json` };
    try {
      return { ref, commit, kit: asDict(JSON.parse(r.stdout)) };
    } catch (e) {
      return { ref, commit, kit: null, why: `${ref}:.claude/kit.json is not valid JSON (${e.message})` };
    }
  }
  return null;
}

/**
 * What the gate runs: the checks CI runs on a pull request (bootstrap CI_COMMANDS; mutation only when kit.json
 * mutation_in_ci is "pr"), each from the base's kit.json commands, lint as CI resolves it. A check is `run` (a command),
 * `off` ("none: <reason>", a reason given) or `missing` (absent, empty, or "none" with no reason), and a missing check
 * fails the gate: it never passes by default (#56 S1.2).
 */
export function gateChecks(kit) {
  const cmds = asDict(kget(kit, 'commands', {}));
  const names = CI_COMMANDS.filter((n) => n !== 'mutation' || kget(kit, 'mutation_in_ci', 'manual') === 'pr');
  return names.map((name) => {
    let v = kget(cmds, name, null);
    if (name === 'lint') {
      const all = kget(cmds, 'lint_all', null);
      v = all !== null ? all : v === null ? null : pyStr(v).replaceAll('{file}', '.');
    }
    if (isConfigured(v)) return { name, status: 'run', command: pyStr(v) };
    const off = typeof v === 'string' ? /^\s*none\s*:?\s*(\S[\s\S]*)$/i.exec(v) : null;
    if (off) return { name, status: 'off', reason: pyStrip(off[1]) };
    return { name, status: 'missing', reason: v === null ? 'not recorded in kit.json commands' : '"none" with no reason' };
  });
}

/** Changes in the worktree outside the lane's own bookkeeping files (progress, review, events, checks, decisions). */
function gateDirty(root, wt, slug) {
  const work = K.workRoot(root);
  const own = new Set(K.laneArtifacts(work, slug, root).filter((p) => !p.includes('*')));
  const decisions = `${K.decisionsRoot(root)}/`;
  const r = gitRaw(wt, ['status', '--porcelain', '--untracked-files=all']);
  if (r.status !== 0) return [`git status failed in the worktree: ${pyStrip(r.stderr)}`];
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop())
    .filter((p) => !own.has(p) && !p.startsWith(decisions));
}

/**
 * Run one check contained: the same launcher as the lane (srt, the container, or no boundary when there is none,
 * recorded as `degraded`), with `sh -c <command>` in place of claude. Non-interactive: stdin closed, CI=1, no
 * credentials. The whole process group is killed at the time limit. Only the exit code and the output come back.
 */
function runContained(launch, wt, command, timeoutMs, env) {
  const i = launch.indexOf('claude');
  const argv = [...(i >= 0 ? launch.slice(0, i) : []), 'sh', '-c', command];
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let timedOut = false;
    const keep = (b) => {
      out += b.toString('utf8');
      if (out.length > GATE_OUTPUT_TAIL * 2) out = out.slice(-GATE_OUTPUT_TAIL);
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: wt, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ exit: null, signal: null, timedOut: false, seconds: 0, output: `could not start ${argv[0]}: ${e.message}` });
      return;
    }
    const killAll = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killAll(); }, timeoutMs);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => keep(Buffer.from(`\n${argv[0]}: ${e.message}\n`)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      killAll(); // a background child the check left behind dies with it
      resolve({ exit: code, signal, timedOut, seconds: Math.round((Date.now() - t0) / 100) / 10, output: out.slice(-GATE_OUTPUT_TAIL) });
    });
  });
}

/** The gate's last verdict for the lane, as the store holds it, or null. */
export function laneGate(root, slug) {
  const g = kget(readStore(root, slug) ?? {}, 'gate', null);
  return g && typeof g === 'object' ? g : null;
}

/**
 * The gate's verdict for the lane's HEAD: `pass`, `fail` (a FAIL for this commit), `stale` (a verdict for another
 * commit) or `none`. Only a PASS for the exact HEAD lets a reviewer start (0016 E.1 Add 2).
 */
export function gateState(root, slug, wt = pjoin(lanesDir(root), slug)) {
  const g = laneGate(root, slug);
  let head = '';
  try { head = pyStrip(K.git(['rev-parse', 'HEAD'], wt)); } catch (e) { if (!isCalledProcessError(e)) throw e; }
  if (!g) return { state: 'none', head };
  if (g.commit !== head) return { state: 'stale', head, gate: g };
  return { state: g.verdict === 'PASS' ? 'pass' : 'fail', head, gate: g };
}

/** Why no reviewer may start on the lane's HEAD; [] when the gate passed it. */
export function gateProblem(root, slug, wt) {
  const s = gateState(root, slug, wt);
  const run = `kit lane gate ${slug}`;
  if (s.state === 'pass') return [];
  if (s.state === 'none') return [`the gate has not run on this lane: ${run}`];
  if (s.state === 'stale') return [`the gate's verdict is for ${String(s.gate.commit).slice(0, 7)}, not the lane's HEAD ${s.head.slice(0, 7)} (stale): ${run}`];
  return [`the gate FAILED on ${s.head.slice(0, 7)} (${(s.gate.failed ?? []).join(', ') || 'see the report'}); fix it, commit, then ${run}. Report: ${s.gate.report ?? 'none'}`];
}

/** CI configuration a lane may never change: the files that decide what CI runs (D4; 0016 E.1 Add 4). */
const CI_CONFIG = /^(\.github\/(workflows|actions)\/|\.gitlab-ci\.yml$|\.circleci\/|\.buildkite\/|azure-pipelines\.ya?ml$|bitbucket-pipelines\.yml$|Jenkinsfile$)/;
/** Test configuration (the runner's own config files; a test's helpers and fixtures are test code, not config). */
const TEST_CONFIG = /(^|\/)((vitest|vite|jest|playwright|cypress|karma|ava|wdio)\.(config|workspace|conf)\.[cm]?[jt]s|\.mocharc(\.[a-z]+)?|pytest\.ini|tox\.ini|noxfile\.py|phpunit\.xml(\.dist)?|\.rspec)$/;

const gitShow = (cwd, rev, file) => {
  const r = gitRaw(cwd, ['show', `${rev}:${file}`]);
  return r.status === 0 ? r.stdout : null;
};

/** The `scripts` of a package.json at a commit, as canonical JSON ('' when the file or the field is absent). */
function packageScripts(cwd, rev, file) {
  const t = gitShow(cwd, rev, file);
  if (t === null) return '';
  try {
    const sc = asDict(JSON.parse(t)).scripts;
    return sc && typeof sc === 'object' ? JSON.stringify(Object.keys(sc).sort().map((k) => [k, sc[k]])) : '';
  } catch {
    return `unparseable:${t}`;
  }
}

/**
 * The protected files the lane changed since it left the base (D4; #56 S1.3; 0016 E.1 Add 4), so a lane cannot change
 * what the base's commands run or what was approved: its spec after the approved commit, anything under `.claude/`
 * (kit.json, settings, hooks), CI configuration, the `scripts` of any package.json, and test configuration. Each is a
 * human's change, outside the lane. [] when none.
 */
export function protectedChanges(root, wt, slug, mergeBase, head) {
  const changed = gitRaw(wt, ['diff', '--name-only', '--no-renames', mergeBase, head]).stdout.split('\n').filter(Boolean);
  const out = [];
  for (const f of changed) {
    if (f.startsWith('.claude/')) out.push(`${f}: the kit's configuration (.claude/) is the owner's`);
    else if (CI_CONFIG.test(f)) out.push(`${f}: CI configuration`);
    else if (TEST_CONFIG.test(f)) out.push(`${f}: test configuration`);
    else if (f === 'package.json' || f.endsWith('/package.json')) {
      if (packageScripts(wt, mergeBase, f) !== packageScripts(wt, head, f)) out.push(`${f}: its "scripts" changed (dependencies may change; scripts decide what the checks run)`);
    }
  }
  // the spec must be the one the owner approved: compared with its approved commit, not with the lane's start
  const spec = `${K.workRoot(root)}/${slug}.md`;
  const approval = specApproval(root, slug);
  const approvedAt = approval?.commit && gitLine(wt, ['rev-parse', '--verify', '--quiet', `${approval.commit}^{commit}`]) ? approval.commit : mergeBase;
  const was = gitShow(wt, approvedAt, spec);
  if (was !== null && gitShow(wt, head, spec) !== was) out.push(`${spec}: the spec changed after its approved commit ${String(approvedAt).slice(0, 7)}`);
  return out;
}

/** A high-risk path matched as whole path parts: `src/auth/x.ts`, `payment.ts`, `billing-api/` yes; `author.ts` no. */
function riskPathRe(q) {
  const e = String(q).toLowerCase().replace(/^\/+|\/+$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[/._-])${e}s?([/._-]|$)`, 'i');
}

/**
 * The risk re-check (D4; 0016 E.1 Add 2 item 3): a lane that is not high risk, by its approved spec and its goal,
 * whose own diff touches a high-risk path (the base's kit.json `high_risk_paths`, or the kit's defaults). Today's
 * classification reads only the spec's file bullets, so a glob like `src/**` could hide a billing change. [] when the
 * lane is high risk (it was classified and approved as such) or touches none.
 */
export function riskChanges(root, wt, slug, baseKit, mergeBase, head) {
  const approval = specApproval(root, slug);
  const spec = `${K.workRoot(root)}/${slug}.md`;
  const text = (approval?.commit && gitShow(wt, approval.commit, spec)) || gitShow(wt, mergeBase, spec) || '';
  const h = K.headerFields(K.stripHtmlComments(text.split('\n')));
  const specRisk = h.has('risk') ? pyStrip(h.get('risk')[1]).toLowerCase() : '';
  if (specRisk.includes('high') || goalFields(root, slug).risk === 'high') return [];
  const paths = Object.hasOwn(baseKit, 'high_risk_paths') && Array.isArray(baseKit.high_risk_paths) ? baseKit.high_risk_paths : K.DEFAULT_HIGH_RISK_PATHS;
  const res = paths.filter((q) => typeof q === 'string' && q.trim()).map((q) => [q, riskPathRe(q)]);
  const changed = gitRaw(wt, ['diff', '--name-only', '--no-renames', mergeBase, head]).stdout.split('\n').filter(Boolean);
  const out = [];
  for (const f of changed) {
    const hit = res.find(([, re]) => re.test(f));
    if (hit) out.push(`${f}: a high-risk path ('${hit[0]}'), in a lane approved as ${specRisk || 'not high risk'}`);
  }
  return out;
}

/**
 * The base branch's tip: origin's when the repo has an origin (fetched first when `fetch`), else the local base.
 * { ref, tip } or { why } when it cannot be read.
 */
export function baseTip(root, base, { fetch = false } = {}) {
  const origin = gitLine(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]) || gitRaw(root, ['remote']).stdout.split(/\s+/).includes('origin');
  if (origin && fetch) {
    const f = gitRaw(root, ['fetch', '-q', 'origin', base]);
    if (f.status !== 0) return { why: `git fetch origin ${base} failed: ${pyStrip(f.stderr) || `exit ${f.status}`}` };
  }
  const ref = origin ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
  const tip = gitLine(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return tip ? { ref, tip } : { why: `no ${origin ? `origin/${base}` : base} to update from` };
}

/**
 * Why the lane may not go on to its sign-off or merge: the gate must have PASSED `head` after the lane was updated from
 * the base, i.e. `head` contains the base's tip (#56 S1.5: it runs again before merge after syncing). null when it did.
 */
export function syncProblem(root, slug, head, { fetch = false } = {}) {
  const base = kget(asDict(K.loadKitJson(root)), 'default_branch', 'main');
  const run = `kit lane gate ${slug} --sync (then kit lane publish ${slug} to push it)`;
  const bt = baseTip(root, base, { fetch });
  if (bt.why) return `the base cannot be read (${bt.why})`;
  const g = laneGate(root, slug);
  if (!head) return `the lane has no commit to merge`;
  if (!g) return `the gate has not run on this lane: ${run}`;
  if (g.commit !== head) return `the gate's verdict is for ${String(g.commit).slice(0, 7)}, not ${head.slice(0, 7)}: ${run}`;
  if (g.verdict !== 'PASS') return `the gate FAILED on ${head.slice(0, 7)} (${(g.failed ?? []).join(', ')}): fix it, then ${run}`;
  if (gitRaw(root, ['merge-base', '--is-ancestor', bt.tip, head]).status !== 0) return `${head.slice(0, 7)} does not contain ${base}'s tip ${bt.tip.slice(0, 7)}: update it from the base and gate it again: ${run}`;
  return null;
}

/**
 * Why the review does not cover `head`, or null when it does (#146 O2): the report at that commit must say PASS and
 * name a commit whose change is the one at `head` (kitlib.reviewHeadOk). A commit after the review that touched a
 * test or code file needs a new review; an update from the base that left the lane's change alone does not.
 */
export function reviewProblem(root, slug, head) {
  const rel = `${K.workRoot(root)}/${slug}.review.md`;
  let text;
  try {
    text = K.git(['show', `${head}:${rel}`], root);
  } catch {
    return `${String(head).slice(0, 7)} has no ${rel}; run /zi-review`;
  }
  if (!/(?<![^\n])## Verdict[ \t]*\n+[ \t]*PASS[ \t]*(?=\n|$)/.test(text)) return `the review at ${String(head).slice(0, 7)} is not a PASS; run /zi-review`;
  const h = /(?<![^\n])- Head:[ \t]*([0-9a-f]{7,40})/.exec(text);
  if (!h) return `${rel} names no '- Head: <sha>', so it covers no commit; run /zi-review`;
  const base = K.loadKitJson(root)?.default_branch || 'main';
  if (!K.reviewHeadOk(root, h[1], head, base)) return `the review PASS is for ${h[1].slice(0, 7)}, and ${String(head).slice(0, 7)} changed tests or code after it; run /zi-review again`;
  return null;
}

/** The next numbered gate report for a lane: `<slug>.gate.1.txt`, `<slug>.gate.2.txt`, ... (#147 O4). Never reuses a number. */
export function nextGateReport(root, slug) {
  const dir = storeDir(root);
  const re = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.gate\\.(\\d+)\\.txt$`);
  let n = 0;
  if (K.isDir(dir)) for (const f of fs.readdirSync(dir)) {
    const m = re.exec(f);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return pjoin(dir, `${slug}.gate.${n + 1}.txt`);
}

/** Write fields into the lane's store record without a move (the gate's verdict). */
function writeStoreFields(root, slug, fields) {
  const p = storePath(root, slug);
  const rec = { ...(readStore(root, slug) ?? { version: 1, slug }), ...fields, updated: K.isoSeconds() };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeText(tmp, K.jsonDumps(rec, { indent: 2 }) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * lane.js gate: re-run the base's recorded checks on the lane's HEAD, in its worktree, contained, and write the
 * verdict, bound to that commit, into the store, with a report for humans. The orchestrator runs it (lanes are denied
 * it, Step 2); reviewers start only on PASS (advance build → review). A FAIL ends the round (D2): it counts as a
 * failed round, once per commit, and the lane is parked when another round would pass the limit. Exit 0 PASS,
 * 1 FAIL, 2 refused.
 */
export async function gate(root, slug, { sync = false } = {}) {
  if (isStopped(root)) return refuse(['kill switch set; kit lane resume-all --by <name> first']);
  const wt = pjoin(lanesDir(root), slug);
  if (!K.isFile(pjoin(wt, '.claude', 'lane.json'))) return refuse([`no lane for ${slug}; run kit lane start ${slug} first`]);
  const stage = laneStage(root, slug);
  if (!['build', 'review'].includes(String(stage))) return refuse([`${slug} is at '${stage}': the gate runs on a lane at build or review`]);
  const dirty = gateDirty(root, wt, slug);
  if (dirty.length) return refuse([`the gate checks a commit, and the worktree has changes that are not committed; commit them first:`, ...dirty.slice(0, 20).map((p) => `  ${p}`)]);
  const base = kget(asDict(K.loadKitJson(root)), 'default_branch', 'main');
  // --sync: update the lane from the base's tip first, and gate the result (#56 S1.5). A merge conflict is undone and
  // parks the lane for a human: the gate never resolves one, and no agent is sent to guess
  let synced = null;
  if (sync) {
    const bt = baseTip(root, base, { fetch: true });
    if (bt.why) return refuse([`cannot update from the base: ${bt.why}`]);
    const before = pyStrip(K.git(['rev-parse', 'HEAD'], wt));
    // the merge commit is the repo's configured identity; with none set (a fresh machine, a CI runner), the kit's own,
    // so the update never fails for want of a name
    const ident = gitLine(wt, ['config', 'user.email']) ? [] : ['-c', 'user.name=agent-kit gate', '-c', 'user.email=agent-kit@localhost'];
    const mr = gitRaw(wt, [...ident, 'merge', '--no-edit', '-m', `Merge ${base} (${bt.tip.slice(0, 7)}) into wt/${slug}: the gate's update from the base`, bt.tip]);
    if (mr.status !== 0) {
      const conflicts = gitRaw(wt, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
      gitRaw(wt, ['merge', '--abort']);
      if (!conflicts.length) return refuse([`updating from ${base} failed: ${pyStrip(mr.stderr) || pyStrip(mr.stdout) || `exit ${mr.status}`}`]);
      const reason = `a merge conflict with ${base} at ${bt.tip.slice(0, 7)} in ${conflicts.join(', ')}; the merge was undone`;
      recordMove(root, slug, wt, stage, 'parked', { fields: { parked: { reason, at: K.isoSeconds(), conflict: conflicts, base_tip: bt.tip } } });
      roadmapSet(root, slug, 'escalated');
      K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'parked', result: 'fail', summary: `lane parked: ${reason}` });
      return refuse([`lane ${slug} is parked: ${reason}. A human resolves it (in the worktree ${wt}), then ${unparkHint(slug)}`]);
    }
    synced = { base_tip: bt.tip, from: before, merged: pyStrip(K.git(['rev-parse', 'HEAD'], wt)) !== before };
  }
  const src = baseKitJson(root, base);
  if (!src) return refuse([`no ${base} branch to read the recorded checks from (origin/${base} or ${base})`]);
  if (!src.kit) return refuse([`the recorded checks cannot be read: ${src.why}`]);
  const head = pyStrip(K.git(['rev-parse', 'HEAD'], wt));
  const minutes = Number(kget(src.kit, 'gate_timeout_min', GATE_TIMEOUT_MIN));
  const timeoutMs = Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : GATE_TIMEOUT_MIN) * 60000);
  // the sandbox settings are the gate's own, outside the worktree, so the lane cannot loosen them
  const cfg = SB.sandboxConfig({ root, wt, slug });
  // the container runtime needs the lane image, built in Step 8; until then the checks run with no boundary, recorded
  // as such (no weaker than the lane itself, which has none either before Step 8)
  if (cfg.runtime === 'container' && spawnSync(cfg.engine || 'docker', ['image', 'inspect', 'kit-lane:latest'], { stdio: 'ignore', timeout: 15000 }).status !== 0) {
    Object.assign(cfg, { runtime: null, state: 'degraded', how: `the container image kit-lane:latest is not built yet (hardening plan Step 8)` });
  }
  const tmp = fs.mkdtempSync(pjoin(os.tmpdir(), `kit-gate-${slug}-`));
  const settingsPath = pjoin(tmp, 'sandbox.json');
  writeText(settingsPath, K.jsonDumps(SB.srtSettings(cfg), { indent: 2 }) + '\n');
  const launch = cfg.runtime ? SB.launchCommand(cfg, { wt, settingsPath, prompt: '' }) : ['claude'];
  const env = { ...process.env, CI: '1', KIT_GATE: slug };
  for (const k of GATE_ENV_DROP) delete env[k];
  // under srt a check's TMPDIR is the lane scratch, which exists and is writable inside the sandbox (#139)
  fs.mkdirSync(cfg.scratch, { recursive: true });
  Object.assign(env, SB.sandboxTmpEnv(cfg));
  const checks = [];
  // the lane's own changes since it left the base: protected files and the risk re-check come first (D4)
  const mergeBase = gitLine(wt, ['merge-base', src.commit, head]);
  const prot = mergeBase ? protectedChanges(root, wt, slug, mergeBase, head) : [`no common commit with ${src.ref}: the lane's changes cannot be told apart`];
  const risk = mergeBase ? riskChanges(root, wt, slug, src.kit, mergeBase, head) : [];
  checks.push({ name: 'protected-files', status: 'kit', result: prot.length ? 'FAIL' : 'pass', problems: prot });
  checks.push({ name: 'risk', status: 'kit', result: risk.length ? 'FAIL' : 'pass', problems: risk });
  try {
    for (const c of gateChecks(src.kit)) {
      // with a protected file changed, the checks would run what the lane changed: they are not run at all
      if (prot.length && c.status === 'run') {
        checks.push({ ...c, result: 'skipped', reason: 'a protected file changed' });
        continue;
      }
      if (c.status !== 'run') {
        checks.push({ ...c, result: c.status === 'off' ? 'off' : 'FAIL' });
        continue;
      }
      const r = await runContained(launch, wt, c.command, timeoutMs, env);
      const result = r.timedOut ? 'FAIL' : r.exit === 0 ? 'pass' : 'FAIL';
      checks.push({ ...c, result, exit: r.exit, signal: r.signal, timed_out: r.timedOut, seconds: r.seconds, output: r.output });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => c.result === 'FAIL').map((c) => c.name);
  const verdict = failed.length ? 'FAIL' : 'PASS';
  const now = K.isoSeconds();
  // every run keeps its own report (#147 O4): the first FAIL's output is what a retro quotes, and it used to be
  // overwritten by the next run. `<slug>.gate.txt` stays as a copy of the latest, for people and older skills.
  const reportPath = nextGateReport(root, slug);
  const latestPath = pjoin(storeDir(root), `${slug}.gate.txt`);
  const line = (c) => c.status === 'kit'
    ? [`${c.result === 'pass' ? 'pass' : 'FAIL'}  ${c.name}${c.name === 'risk' && c.result === 'FAIL' ? ': the owner decides: revert these, or approve the spec again as high risk' : ''}`, ...c.problems.map((x) => `        ${x}`)].join('\n')
    : c.result === 'skipped' ? `skip  ${c.name}: ${c.command}  (not run: ${c.reason})`
    : c.status === 'run'
    ? `${c.result === 'pass' ? 'pass' : 'FAIL'}  ${c.name}: ${c.command}  (${c.timed_out ? `stopped at the time limit, ${Math.round(timeoutMs / 1000)}s` : `exit ${c.exit ?? c.signal}`}, ${c.seconds}s)`
    : c.status === 'off' ? `off   ${c.name}: none: ${c.reason}` : `FAIL  ${c.name}: missing (${c.reason}); record a command or "none: <reason>" in kit.json on ${base}`;
  const report = [
    `GATE: ${verdict}`,
    `lane ${slug} at ${head}, ${now}`,
    `checks from ${src.ref} (${src.commit.slice(0, 7)}) .claude/kit.json; ${cfg.runtime ? `contained (${cfg.runtime})` : `degraded: no sandbox runtime (${cfg.how})`}; stdin closed; limit ${Math.round(timeoutMs / 1000)}s a check`,
    '',
    ...checks.map(line),
    ...checks.filter((c) => c.result === 'FAIL' && c.status === 'run').flatMap((c) => ['', `--- ${c.name} (last output) ---`, c.output.trimEnd()]),
    '',
  ].join('\n');
  fs.mkdirSync(storeDir(root), { recursive: true });
  writeText(reportPath, report);
  writeText(latestPath, report);
  const prev = laneGate(root, slug);
  const record = {
    verdict, commit: head, at: now, base_ref: src.ref, base_commit: src.commit, runtime: cfg.runtime ?? null, state: cfg.state,
    timeout_s: Math.round(timeoutMs / 1000), failed, report: reportPath, synced,
    checks: checks.map(({ output, ...c }) => c),
  };
  writeStoreFields(root, slug, { gate: record });
  K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'gate', result: verdict === 'PASS' ? 'ok' : 'fail', summary: `gate ${verdict} on ${head.slice(0, 7)}${failed.length ? `: ${failed.join(', ')}` : ''}` });
  const cut = report.indexOf('\n--- ');
  process.stdout.write(`${(cut >= 0 ? report.slice(0, cut) : report).trimEnd()}\nreport: ${reportPath}\n`);
  if (verdict === 'PASS') return 0;
  // a gate FAIL ends the round (D2): counted once per commit, and the lane parks when another round would pass the limit
  if (stage === 'build' && !(prev && prev.verdict === 'FAIL' && prev.commit === head)) {
    const rounds = laneRounds(root, readStore(root, slug));
    const n = rounds.failed + 1;
    if (n + 1 > rounds.limit) {
      const reason = `${n} failed round${n === 1 ? '' : 's'} (the last a gate FAIL); round ${n + 1} would pass the limit of ${rounds.limit} (kit.json max_rounds)`;
      recordMove(root, slug, wt, stage, 'parked', { fields: { failed_rounds: n, parked: { reason, at: K.isoSeconds(), round: n } } });
      roadmapSet(root, slug, 'escalated');
      K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'parked', result: 'fail', summary: `lane parked: ${reason}` });
      process.stderr.write(`lane ${slug} is parked: ${reason}\n  ${unparkHint(slug)}\n`);
    } else {
      writeStoreFields(root, slug, { failed_rounds: n });
    }
  }
  return 1;
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
 * method required); over 3 -> research insufficient, back to /zi-research. Open questions count as unknowns.
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
      research: `${count} unknowns > ${MAX_UNKNOWNS}: research insufficient; stop planning and run /zi-research`,
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

/**
 * Stages a profile lists that nothing produces or runs yet (#57, #58). Building them is on the hardening plan's to-do
 * list; until then a work type that needs one is refused, never mapped to done.
 */
export const NOT_BUILT_STAGES = ['inspect', 'report', 'verify-ui'];

/**
 * Why a work type cannot run yet, or [] when it can: a listed stage nothing runs (#57, #58), or an agent the profile
 * names that does not exist in kit/agents (#59). ui at size L takes the feature shape, so it is judged by that shape.
 */
export function notBuilt(fields) {
  const prof = profileFor(fields.work_type);
  if (!prof) return [];
  const shape = fields.work_type === 'ui' && fields.size === 'L' ? profileFor('feature') : prof;
  const why = [];
  const stages = shape.stages.filter((s) => NOT_BUILT_STAGES.includes(s));
  if (stages.length) why.push(`its ${stages.map((s) => `'${s}'`).join(', ')} stage${stages.length > 1 ? 's have' : ' has'} no runner yet`);
  const agents = [...new Set(Object.values(asDict(kget(shape, 'agents', {}))))].filter((a) => !K.isFile(path.join(kitDir(), 'agents', `${a}.md`)));
  if (agents.length) why.push(`it names ${agents.map((a) => `'${a}'`).join(', ')}, which ${agents.length > 1 ? 'are' : 'is'} not in kit/agents`);
  return why.length ? [`${fields.work_type} work is not built yet: ${why.join('; ')}. It is on the hardening plan's to-do list (#57-#59).`] : [];
}

/** A high-risk lane whose profile asks for a human security sign-off before the merge (#58). */
export function signoffRequired(fields) {
  const prof = profileFor(fields.work_type);
  if (!prof || fields.risk !== 'high') return false;
  return (prof.risk_adds ?? []).includes('security-signoff') || prof.stages.includes('security-signoff');
}

/** The goal's fields, with the risk raised (never lowered) by the spec on main or in the lane. */
export function laneFields(root, slug) {
  let fields = goalFields(root, slug);
  const laneSpec = (() => {
    const l = K.findLane(pjoin(lanesDir(root), slug));
    return l ? pjoin(l.root, l.work, `${slug}.md`) : null;
  })();
  for (const sp of [specPath(root, slug), ...(laneSpec ? [laneSpec] : [])]) {
    if (K.isFile(sp) && (specHeader(sp).get('risk') ?? '').toLowerCase().includes('high')) fields = { ...fields, risk: 'high' };
  }
  return fields;
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
  process.stdout.write(`stopped: every lane refuses transitions and mutations until kit lane resume-all --by <name>\n`);
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

/**
 * Decide the next stage for a feature from files and git only. Used by /zi-run; never from an agent's claim.
 * `{ reroute: false }` answers without writing: a reroute the evidence calls for is reported as `reroute_pending`
 * and left to the controller's own next-step (a reader such as the dashboard's GET must not rewrite the goal file).
 */
export async function nextStep(root, slug, { reroute = true } = {}) {
  const KS = await import('./kit_status.js');
  const kit = K.loadKitJson(root);
  if (isStopped(root)) return { slug, stage: 'stopped', reason: `kill switch set (${pyStrip(readText(stopPath(root)))}); kit lane resume-all --by <name> to continue`, needs_human: true };
  const rows = new Map(roadmapRows(root).map((r) => [r.slug, r]));
  const row = rows.get(slug);
  const g = goalStatus(root, slug);
  if (g === null) return { slug, stage: 'start', reason: 'no agreed goal file; run /zi-start' };
  if (g === 'done') return { slug, stage: 'done', reason: 'goal file says done' };
  let fields = goalFields(root, slug);
  let prof = profileFor(fields.work_type);
  if (!prof) return { slug, stage: 'refused', reason: `unknown work_type '${fields.work_type}' in the goal; profiles: ${Object.keys(loadProfiles()).join(', ')}`, needs_human: true };
  // /zi-work routed provisionally; the debugger's cause line settles the kind (KIT-SPEC 10.12)
  const rerouted = rerouteFromEvidence(root, slug, fields, prof, { write: reroute });
  if (rerouted && reroute) {
    fields = goalFields(root, slug);
    prof = profileFor(fields.work_type);
  }
  // The spec may raise the risk the goal declared (the validator derives it from the paths touched); never lower it.
  fields = laneFields(root, slug);
  const unbuilt = notBuilt(fields);
  if (unbuilt.length) return { slug, stage: 'refused', reason: unbuilt[0], work_type: fields.work_type, risk: fields.risk, size: fields.size, needs_human: true };
  const ctx = { KS, kit, rows, row, g };
  let raw = isReproFirst(prof) ? await nextStepRepro(root, slug, ctx) : await nextStepFeature(root, slug, ctx);
  if (['test', 'build'].includes(raw.stage)) raw = inLanePlanning(root, slug) ?? raw;
  // reviewed: before the sign-off and the merge, the gate runs again on the lane updated from the base (#56 S1.5)
  if (raw.stage === 'wait-merge' && laneRefs(root, slug).tip) {
    const why = syncProblem(root, slug, laneRefs(root, slug).tip);
    if (why) raw = { slug, stage: 'gate', sync: true, reason: `reviewed; before the merge ${why}` };
  }
  const signoff = raw.stage === 'wait-merge' && signoffRequired(fields) ? signoffProblem(root, slug, [laneRefs(root, slug).tip]) : undefined;
  const out = withProfile(raw, prof, fields, { signoff });
  if (rerouted) out[reroute ? 'rerouted' : 'reroute_pending'] = rerouted;
  // the lane's round and wall time, from the store alone (hardening plan Step 2)
  const rec = readStore(root, slug);
  if (rec && Object.hasOwn(rec, 'stage')) {
    const r = laneRounds(root, rec);
    out.rounds = { round: r.round, limit: r.limit, failed: r.failed, parked: Boolean(r.parked) };
    out.elapsed_hours = K.storeClock(rec).elapsed_hours;
  }
  return out;
}

/** Read the debugger's `cause:` line from the lane's progress file; rewrite a provisional work type when the profile says so. */
export function rerouteFromEvidence(root, slug, fields, prof, { write = true } = {}) {
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
    if (fields.provisional && write) setGoalField(root, slug, 'Work type', fields.work_type); // the evidence confirmed it; drop "(provisional)"
    return null;
  }
  if (write) {
    setGoalField(root, slug, 'Work type', target);
    K.appendEvent(pjoin(wt, '.claude', 'session', 'events.jsonl'), { event: 'reroute', from: fields.work_type, to: target, cause: m[1], summary: `rerouted ${fields.work_type} → ${target}: ${m[1]}` });
  }
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

/**
 * Map the derived position onto the profile: a stage the profile lacks is skipped forward; the allowed agent is named.
 * `signoff` is why the lane's security sign-off does not cover its HEAD (signoffProblem), null when it does; left out,
 * none counts as recorded.
 */
export function withProfile(step, prof, fields, { signoff } = {}) {
  const out = { ...step, work_type: fields.work_type, risk: fields.risk, size: fields.size };
  if (['start', 'done', 'escalated', 'stopped', 'refused'].includes(step.stage)) return out;
  // ui at size L takes the feature shape (KIT-SPEC 10.12)
  const shape = fields.work_type === 'ui' && fields.size === 'L' ? profileFor('feature') : prof;
  const stages = shape.stages;
  let stage = step.stage;
  // a stage the profile lacks maps forward (fix/incident derive their own early stages in nextStepRepro)
  // scope (lane.js scope) is a script stage any profile may need after a re-route from fix/incident; never map it away
  // the gate (lane.js gate) is a script stage too, between build and review in every profile that has a review
  if (stage === 'scope' || (stage === 'gate' && stages.includes('review'))) {
    out.stage = stage;
    out.agent = null;
    return out;
  }
  if (!stages.includes(stage)) {
    // a generic stage maps forward only to a stage the profile has; retro → done is the one mapping to done, for a
    // profile without retro after its merge. Anything else is refused with a reason, never mapped to done (#57).
    const alias = { research: 'reproduce', plan: 'reproduce', approve: 'lane', retro: 'done', test: 'build', 'verify-ui': 'review' };
    let cur = stage;
    for (let i = 0; i < 6 && cur !== undefined && !stages.includes(cur); i++) cur = alias[cur];
    if (cur === undefined || !stages.includes(cur)) {
      return { ...out, stage: 'refused', mapped_from: stage, agent: null, needs_human: true,
        reason: `stage '${stage}' has no equivalent in the ${shape.work_type} profile (${stages.join(' → ')}); not mapped to done (#57)` };
    }
    out.mapped_from = stage;
    stage = cur;
  }
  out.stage = stage;
  const a = allowedAgent(shape.work_type, stage);
  out.agent = a.ok ? a.agent : null;
  if (a.ok && a.human) out.needs_human = true;
  // A requires entry blocks the stage until it is met (#58): a lane that needs a security sign-off waits here until the
  // store records one for the lane's HEAD (`signoff`: signoffProblem's answer, from nextStep), and lane.js merge refuses it.
  if (stage === 'wait-merge' && signoffRequired(fields)) {
    if (signoff === null) return out;
    return { ...out, stage: 'security-signoff', requires: ['security-signoff'], agent: null, needs_human: true,
      reason: `a human security sign-off is required before the merge and ${signoff ?? noSignoff(step.slug)} (high risk, ${fields.work_type})` };
  }
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
  // a lane past scope (test, build, review, retro) was scoped from an approved spec already
  const stage = laneStage(root, slug);
  if (stage !== null && !['reproduce', 'plan', 'approve'].includes(String(stage))) return null;
  if (!K.isFile(sp)) return { slug, stage: 'plan', reason: 'the lane has no spec yet' };
  // approved means the owner merged its spec/<slug> PR (kit lane merge records it); an approval line does not count
  if (!specApproval(root, slug)) {
    const status = (specHeader(sp).get('status') ?? '').toLowerCase();
    if (['waiting-approval', 'approved'].includes(status)) return { slug, stage: 'approve', reason: 'spec waits for the human: its spec/<slug> PR is not merged yet', needs_human: true };
    return { slug, stage: 'plan', reason: `spec status '${status}' is not waiting-approval; finish planning` };
  }
  return { slug, stage: 'scope', reason: 'spec approved; kit lane scope copies its criteria and moves the lane to test' };
}

async function nextStepFeature(root, slug, { KS, kit, rows, row, g }) {
  if (row === undefined) return { slug, stage: 'start', reason: 'goal exists but no ROADMAP row; /zi-start adds it' };
  const st = KS.laneState(root, row, kit);
  const pos = st.position;
  const sp = specPath(root, slug);
  const dashed = slug.replaceAll('-', ' ');
  const research = indexRows(root).filter((r) => r.status === 'current' && (r.slug.includes(slug) || r.question.toLowerCase().includes(dashed) || r.keywords.includes(slug)));
  if (pos === 'merged') return { slug, stage: g !== 'done' ? 'retro' : 'done', reason: 'merged in git; retro not yet run (goal not done)' };
  if (pos === 'escalated') return { slug, stage: 'escalated', reason: st.rounds?.parked ? `parked: ${st.rounds.parked.reason}; ${unparkHint(slug)}` : st.progress.failure || 'escalation written', needs_human: true };
  if (pos === 'ready-to-merge') return { slug, stage: 'wait-merge', reason: 'review PASS for HEAD; human merges', needs_human: true, pr: st.pr ?? null };
  if (pos === 'in-review') return { slug, stage: 'review', reason: 'lane built or review stale; run reviewer' };
  if (pos === 'building') {
    // a criterion counts only when its cell names a logged run of its test with the right outcome, never for a bare
    // `#` (#56); lane.js advance checks the same runs before it moves the lane
    const prog = laneRuns(st.worktree);
    if (prog.criteria && prog.red < prog.criteria) return { slug, stage: 'test', reason: `${prog.red}/${prog.criteria} criteria have a red run; tester first` };
    if (prog.criteria && prog.green === prog.criteria) {
      // a reviewer starts only on the gate's PASS for the lane's HEAD (hardening plan Step 3)
      const gs = gateState(root, slug, st.worktree);
      if (gs.state === 'pass') return { slug, stage: 'review', reason: `all criteria green; the gate passed ${gs.head.slice(0, 7)}; review` };
      // a low-risk lane that touched a high-risk path is stopped for the owner, not sent back to the implementer (D4)
      if (gs.state === 'fail' && (gs.gate.failed ?? []).includes('risk')) return { slug, stage: 'escalated', needs_human: true, reason: `the gate's risk re-check stopped the lane on ${gs.head.slice(0, 7)}: it changed high-risk paths its approved spec does not cover; the owner decides (revert them, or approve the spec again as high risk). Report: ${gs.gate.report}` };
      if (gs.state === 'fail') return { slug, stage: 'build', reason: `the gate FAILED on ${gs.head.slice(0, 7)} (${(gs.gate.failed ?? []).join(', ')}); the implementer fixes what its report shows: ${gs.gate.report}` };
      return { slug, stage: 'gate', reason: gs.state === 'stale' ? `all criteria green; the gate's verdict is for ${String(gs.gate.commit).slice(0, 7)}, not HEAD ${gs.head.slice(0, 7)}; run the gate` : 'all criteria green; run the gate before any reviewer' };
    }
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
    // a goal whose work type is not built yet is skipped, so a refused goal kept for later never holds the queue (#57)
    if (row && ['queued', 'researching', 'planning'].includes(row.status) && goalStatus(root, slug) === 'agreed' && !notBuilt(goalFields(root, slug)).length) {
      return { slug, reason: 'next in queue with an agreed goal', in_flight: lanes };
    }
  }
  return { slug: null, reason: 'queue has no item with an agreed goal (run /zi-start)', in_flight: lanes };
}

// ---------------------------------------------------------------- incidents

/**
 * The kit templates an agent fills, printed with what the kit already knows: the slug, today's date and the repo's
 * commit. Agents get them from here instead of reading ~/.claude/kit/templates/ themselves: that folder is outside the
 * project, so an unattended session (claude -p, nobody to approve) cannot read it, and with a linked install a Read
 * rule would have to name the machine-specific checkout path too (eval evidence 2026-11-22; permissions docs, symlinks).
 * Agents run it as `kit lane template <name>`, which the project's `Bash(kit lane template *)` rule approves (#63). The progress
 * file is not here: `lane.js start` writes it with the spec's done-criteria rows.
 */
export const TEMPLATE_NAMES = ['goal', 'spec', 'research', 'review', 'lesson'];
export function templateText(name, { slug = null, date = todayIso(), commit = null } = {}) {
  if (!TEMPLATE_NAMES.includes(name)) throw new Error(`unknown template '${name}' (one of ${TEMPLATE_NAMES.join(', ')})`);
  if (slug !== null && !(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 40)) throw new Error(`slug '${slug}' is not kebab-case of at most 40 characters`);
  // filled on the header lines only (`- Slug:`, `- Date:`, `- Commit:`, the lesson's `## {{date}} — …` heading). A
  // `… by:` line is the person's to write with the date of their own decision, never the draft's: the goal's
  // `- Agreed by: … on {{date}}`. The spec's `Approved by:` line is written by nobody (kit lane merge records it)
  const fill = (line) => {
    if (!(/^- [A-Z][A-Za-z ]*:/.test(line) || /^## \{\{date\}\} /.test(line)) || /\bby:/i.test(line)) return line;
    let l = line;
    if (slug !== null) l = l.replaceAll('{{slug}}', slug);
    l = l.replaceAll('{{date}}', date);
    if (commit) l = l.replaceAll('{{commit}}', commit);
    return l;
  };
  return readText(path.join(kitDir(), 'templates', `${name}.md`)).split('\n').map(fill).join('\n');
}

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

const GITHUB_REMOTE_RE = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/**
 * lane.js publish: push a lane (`wt/<slug>`) or spec (`spec/<slug>`) branch and open its PR as the kit's GitHub App
 * (hardening plan D1, 0016 E.7). Host side, on the owner's machine: the App's private key never enters a lane. The
 * installation token lives in the children's environment only; git gets it through GIT_ASKPASS with the owner's git
 * configuration ignored (no credential helper, no URL rewrite, no auth header can route the push through the owner's
 * identity), gh through GH_TOKEN, and neither is ever printed. The branch must be checked out with nothing
 * uncommitted. `deps` is for tests: `token` mints the token, `pushTarget` names where to push.
 */
export async function publish(root, { slug, branch, title, bodyFile, body, base } = {}, deps = {}) {
  const kit = asDict(K.loadKitJson(root));
  branch = branch || `wt/${slug}`;
  if (!/^(wt|spec)\/\S+$/.test(branch)) return refuse([`branch '${branch}' is not a lane (wt/*) or spec (spec/*) branch; the App may push nothing else, by the repository's rulesets`]);
  const cwd = branch.startsWith('wt/') ? laneWorktree(root, kit, slug) : root;
  if (!cwd) return refuse([`no lane for ${slug}; run kit lane start ${slug} first`]);
  let head, dirty, remote = '';
  try {
    head = pyStrip(K.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd));
    dirty = pyStrip(K.git(['status', '--porcelain'], cwd));
  } catch (e) {
    return refuse([`git in ${cwd}: ${String(e.stderr || e.message).trim().split('\n')[0]}`]);
  }
  try { remote = pyStrip(K.git(['remote', 'get-url', 'origin'], cwd)); } catch { remote = ''; }
  if (head !== branch) return refuse([`${cwd} has '${head}' checked out, not '${branch}'`]);
  if (dirty) return refuse([`${cwd} has uncommitted changes; commit them first`]);
  const m = GITHUB_REMOTE_RE.exec(remote);
  if (!m) return refuse([`origin is not GitHub: ${remote || '(none)'}`]);
  const [owner, repo] = [m[1], m[2]];
  const { config, reason } = APP.appConfig();
  if (!config) return refuse([reason]);
  const key = APP.readPrivateKey(config, root);
  if (!key.pem) return refuse([key.reason]);
  const mint = deps.token ?? APP.installationToken;
  let tok;
  try { tok = await mint({ appId: config.app_id, privateKeyPem: key.pem, owner, repo }); } catch (e) { tok = { ok: false, reason: `could not mint the App's token: ${String(e && e.message || e).split('\n')[0]}` }; }
  if (!tok.ok) return refuse([tok.reason]);
  // push: the token through GIT_ASKPASS (never in the command line), the owner's credential helpers off
  const dir = fs.mkdtempSync(pjoin(os.tmpdir(), 'kit-askpass-'));
  const askpass = pjoin(dir, 'askpass.sh');
  fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x-access-token ;; *) printf %s "$KIT_APP_TOKEN" ;; esac\n', { mode: 0o700 });
  const target = (deps.pushTarget ?? ((o, r) => `https://github.com/${o}/${r}.git`))(owner, repo);
  // the owner's global and system git configuration is ignored for the push: a url.*.pushInsteadOf, an
  // http.*.extraHeader or a credential helper there would route it through the owner's identity unnoticed
  const pushEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KIT_APP_TOKEN: tok.token };
  let rewrites = '';
  // GIT_CONFIG_GLOBAL needs git 2.32 (2021); an older git would read the owner's configuration after all
  const gv = /(\d+)\.(\d+)/.exec(pyStrip(K.git(['--version'], cwd)));
  if (gv && (Number(gv[1]) < 2 || (Number(gv[1]) === 2 && Number(gv[2]) < 32))) { fs.rmSync(dir, { recursive: true, force: true }); return refuse([`git ${gv[0]} is too old: publish needs git 2.32 or newer to ignore the owner's git configuration for the push`]); }
  try { rewrites = pyStrip(K.git(['config', '--get-regexp', '^(url\\..*\\.(push)?insteadof|http\\.(.*\\.)?extraheader)$'], cwd, pushEnv)); } catch { rewrites = ''; }
  if (rewrites) { fs.rmSync(dir, { recursive: true, force: true }); return refuse([`the repository's git config (or GIT_CONFIG_* in the environment) rewrites or authenticates pushes itself, so the push could leave as the owner; remove it first: ${rewrites.split('\n').join('; ')}`]); }
  try {
    K.git(['-c', 'credential.helper=', 'push', target, `${branch}:${branch}`], cwd, pushEnv);
  } catch (e) {
    const err = String(e.stderr || e.message).replaceAll(tok.token, '***');
    return refuse([`push of ${branch} refused: ${err.trim().split('\n').filter(Boolean).slice(-3).join(' | ')}`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // record what was pushed and set the upstream, with no fetch: nothing here touches the network as the owner
  try { K.git(['update-ref', `refs/remotes/origin/${branch}`, pyStrip(K.git(['rev-parse', 'HEAD'], cwd))], cwd); K.git(['branch', `--set-upstream-to=origin/${branch}`, branch], cwd); } catch { /* upstream is a convenience; the push is done */ }
  // the PR, opened by the App
  const row = roadmapRows(root).find((r) => r.slug === slug);
  const baseBranch = base || kget(kit, 'default_branch', 'main');
  const progress = pjoin(cwd, K.workRoot(root), `${slug}.progress.md`);
  const bodyArgs = bodyFile ? ['--body-file', bodyFile] : body ? ['--body', body] : K.isFile(progress) ? ['--body-file', progress] : ['--body', `Opened by lane.js publish for ${slug}.`];
  const args = ['pr', 'create', '--repo', `${owner}/${repo}`, '--head', branch, '--base', baseBranch, '--title', title || `${slug}: ${row?.feature ?? slug}`, ...bodyArgs];
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, GH_TOKEN: tok.token } });
  if (r.error) return refuse([r.error.code === 'ENOENT' ? 'gh is not installed' : `gh pr create: ${r.error.message}`]);
  const urlOf = (t) => (/(https:\/\/github\.com\/\S+\/pull\/\d+)/.exec(t || '') ?? [])[1];
  let url = urlOf(r.stdout);
  if (r.status !== 0) url = /already exists/i.test(r.stderr) ? urlOf(r.stderr) : null;
  if (!url) return refuse([`gh pr create: ${(r.stderr || r.stdout || 'printed no PR URL').replaceAll(tok.token, '***').trim().slice(0, 300)}`]);
  process.stdout.write(`${url}\n`);
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
  for (const name of ['advance', 'stage']) {
    s = sub.addParser(name);
    s.addArgument('slug'); s.addArgument('stage', { choices: Object.keys(MOVES) }); s.addArgument('--repo', { default: '.' }); s.addArgument('--by');
  }
  s = sub.addParser('gate');
  s.addArgument('slug'); s.addArgument('--repo', { default: '.' }); s.addArgument('--sync', { action: 'store_true' });
  s = sub.addParser('ci');
  s.addArgument('slug', { nargs: '?' }); s.addArgument('--repo', { default: '.' }); s.addArgument('--pr'); s.addArgument('--wait', { action: 'store_true' }); s.addArgument('--timeout-min', { type: parseInt, default: 30 });
  s = sub.addParser('publish');
  s.addArgument('slug'); s.addArgument('--repo', { default: '.' }); s.addArgument('--branch'); s.addArgument('--title'); s.addArgument('--body-file'); s.addArgument('--body'); s.addArgument('--base');
  s = sub.addParser('merge');
  s.addArgument('slug', { nargs: '?' }); s.addArgument('--repo', { default: '.' }); s.addArgument('--pr'); s.addArgument('--by'); s.addArgument('--timeout-min', { type: parseInt, default: 30 });
  s = sub.addParser('signoff');
  s.addArgument('slug'); s.addArgument('--repo', { default: '.' }); s.addArgument('--by');
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
  s = sub.addParser('evidence');
  s.addArgument('slug'); s.addArgument('--repo', { default: '.' });
  s = sub.addParser('roadmap-set');
  s.addArgument('slug'); s.addArgument('status'); s.addArgument('--repo', { default: '.' }); s.addArgument('--pr'); s.addArgument('--spec');
  s = sub.addParser('template');
  s.addArgument('name'); s.addArgument('--slug'); s.addArgument('--repo', { default: '.' });
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
  if (a.cmd === 'advance' || a.cmd === 'stage') return advance(root, a.slug, a.stage, { by: a.by ?? null });
  if (a.cmd === 'gate') return gate(root, a.slug, { sync: !!a.sync });
  if (a.cmd === 'finish') return finish(root, a.slug);
  if (a.cmd === 'signoff') return signoff(root, a.slug, a.by);
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
  if (a.cmd === 'evidence') {
    const problems = evidence(root, a.slug);
    return problems.length ? refuse(problems) : 0;
  }
  if (a.cmd === 'ci' || a.cmd === 'merge') {
    // The merge gate (#68): wait for every required check on the PR head; merge only when all passed.
    const pr = lanePr(root, a.slug, a.pr);
    if (!pr) return refuse([a.slug ? `no PR for '${a.slug}': pass --pr <number|url> or set the ROADMAP row's PR cell` : 'pass a slug or --pr <number|url>']);
    const opts = { timeoutMin: a.timeout_min, mutationBlocking: mutationBlocking(root).blocking };
    let lane = null;
    try {
      if (a.cmd === 'merge') {
        // a lane that needs a security sign-off is not merged until one is recorded (#58). The PR names its own lane:
        // its head branch is read from GitHub, whether the PR came from --pr or the slug's ROADMAP row. A wt/<slug>
        // head is that lane, and a different slug on the command line is refused; any other head (spec/, goal/) is
        // not a lane and needs no sign-off.
        const info = G.prInfo(root, pr);
        // a spec/<slug> PR: merging it is the owner's approval of the spec, and lane.js records that yes (hardening
        // plan D1). One already merged (from GitHub's page) is recorded too, as this command still asks the owner.
        const sm = /^spec\/(.+)$/.exec(info.headRefName ?? '');
        if (sm) {
          if (a.slug && sm[1] !== a.slug) return refuse([`PR ${pr} is the spec of '${sm[1]}', not '${a.slug}'; pass its own slug`]);
          if (!a.by || !String(a.by).trim()) return refuse(['--by <name> is required: the human who decided to merge']);
          if (info.state !== 'MERGED') {
            const code = G.mergeCommand(root, pr, { ...opts, by: a.by });
            if (code !== 0) return code;
          }
          const done = JSON.parse(G.gh(root, ['pr', 'view', String(pr), '--json', 'number,state,headRefOid,mergeCommit,mergedAt']));
          if (done.state !== 'MERGED' || !done.mergeCommit?.oid) return refuse([`PR #${done.number ?? pr} is not merged on GitHub, so no approval of ${sm[1]} is recorded`]);
          const ap = recordSpecApproval(root, sm[1], { by: String(a.by).trim(), at: K.isoSeconds(), merged_at: done.mergedAt ?? null, pr: done.number ?? info.number, head: done.headRefOid ?? info.headRefOid, commit: done.mergeCommit.oid });
          process.stdout.write(`spec ${sm[1]}: approval by ${ap.by} recorded (PR #${ap.pr}, merged as ${ap.commit.slice(0, 7)})\n`);
          return 0;
        }
        const m = /^wt\/(.+)$/.exec(info.headRefName ?? '');
        lane = m?.[1] ?? null;
        if (m) {
          if (a.slug && m[1] !== a.slug) return refuse([`PR ${pr} is the lane '${m[1]}', not '${a.slug}'; pass the lane's own slug`]);
          // the sign-off counts only for the commit it names: the PR's head on GitHub, and the local lane tip when the
          // branch is here, must both be that commit; mergeCommand then merges only that head (a push while it waits for
          // CI is refused)
          if (signoffRequired(laneFields(root, m[1]))) {
            const why = signoffProblem(root, m[1], [info.headRefOid, laneRefs(root, m[1]).tip]);
            if (why) return refuse([`${m[1]} needs a human security sign-off before the merge (high risk) and ${why}`]);
            opts.head = securitySignoff(root, m[1]).commit;
          }
          // the gate passed the PR's exact head after it was updated from the base's current tip (#56 S1.5)
          if (a.cmd === 'merge') {
            const why = syncProblem(root, m[1], info.headRefOid, { fetch: true }) ?? reviewProblem(root, m[1], info.headRefOid);
            if (why) return refuse([`${m[1]} cannot merge PR ${pr}: ${why}`]);
            opts.head = info.headRefOid;
          }
        }
      }
      if (a.cmd === 'ci') return G.ciCommand(root, pr, { ...opts, wait: !!a.wait });
      const code = G.mergeCommand(root, pr, { ...opts, by: a.by });
      if (code !== 0 || !lane || !laneRefs(root, lane).tip) return code;
      // record the merge this command just made (#82), so its squash reads as merged before main is pulled. The merge
      // is done whatever happens here: a failure to record only says so, and lane.js merged asks GitHub again.
      try {
        const gm = githubMerge(root, lane, pr);
        if (gm.merged) recordMerge(root, lane, gm);
        else process.stderr.write(`lane: merge not recorded (${gm.why}); kit lane merged ${lane} --pr ${pr} asks GitHub again\n`);
      } catch (e) {
        process.stderr.write(`lane: merge not recorded (${e.message}); kit lane merged ${lane} --pr ${pr} asks GitHub again\n`);
      }
      return code;
    } catch (e) {
      return refuse([e.message]);
    }
  }
  if (a.cmd === 'publish') {
    return publish(root, { slug: a.slug, branch: a.branch, title: a.title, bodyFile: a.body_file, body: a.body, base: a.base });
  }
  if (a.cmd === 'merged') {
    // Verify before writing the word: git first (laneMerge: ancestry, a recorded merge, a rebase or squash merge); then,
    // when the lane's PR is known (--pr, else its ROADMAP row), GitHub's own answer, which is recorded so every
    // later reader (advance below, kit_status, next-step) agrees (#67, #82).
    let unmerged = notMerged(root, a.slug);
    const pr = unmerged ? lanePr(root, a.slug, a.pr) : null;
    if (pr) {
      const gm = githubMerge(root, a.slug, pr);
      if (gm.merged) {
        recordMerge(root, a.slug, gm);
        unmerged = null;
      } else unmerged = [unmerged, gm.why];
    }
    if (unmerged) return refuse([unmerged].flat());
    // The worktree is about to go, and with it the gitignored check log every log#N citation points at (#35).
    const gaps = evidenceGaps(root, a.slug);
    if (gaps.length) {
      return refuse([...gaps.map((g) => `evidence: ${g}`),
        `Run: kit lane evidence ${a.slug} --repo <main repo>, then commit the result on the lane branch before merging. Without it the merged progress and review files cite a log nobody can open.`]);
    }
    // the lane's stage moves to retro: its evidence is committed and merged (#107 reads this to seal it)
    if (K.isFile(pjoin(lanesDir(root), a.slug, '.claude', 'lane.json'))) {
      const moved = moveLane(root, a.slug, 'retro');
      if (moved.length) return refuse(moved);
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
  if (a.cmd === 'template') {
    // the commit of the checkout the agent works in (a lane worktree or the main checkout), not always main's
    const head = spawnSync('git', ['-C', K.realResolve(a.repo), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    try {
      process.stdout.write(templateText(a.name, { slug: a.slug ?? null, commit: head.status === 0 ? head.stdout.trim() : null }));
      return 0;
    } catch (e) {
      return refuse([e.message]);
    }
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
