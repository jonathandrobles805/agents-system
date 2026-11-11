#!/usr/bin/env node
// CI: dependency audit as a ratchet (field test finding #22). `npm audit --json` lists advisories; every advisory at or
// above --level must either be fixed or be accepted in .claude/audit-baseline.json by a named human, with a reason and an
// expiry date at most 90 days out. A new advisory fails; an expired acceptance fails; nothing is accepted silently.
//
//   ci_audit.js --repo R [--level high] [--json FILE]                 check (FILE: a saved `npm audit --json`, for tests)
//   ci_audit.js --repo R --accept GHSA-… --reason "…" --by NAME --expires YYYY-MM-DD   record a human's acceptance
//
// .claude/ is kit configuration: agents are blocked from editing it and CODEOWNERS requires the owner's review.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as K from './kitlib.js';
import { isMain } from './kitlib.js';

export const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
export const BASELINE = path.join('.claude', 'audit-baseline.json');
export const MAX_DAYS = 90;

const today = () => K.isoSeconds().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/** Advisories at or above `level` from npm audit v2 JSON: [{id, package, severity, title, url}], one per id. */
export function advisories(report, level = 'high') {
  if (report && report.error) throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  const min = LEVELS.indexOf(level);
  if (min < 0) throw new Error(`unknown level '${level}' (one of ${LEVELS.join(', ')})`);
  const out = new Map();
  for (const v of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (!via || typeof via !== 'object') continue; // a string names another package; its advisory is listed there
      if (LEVELS.indexOf(via.severity) < min) continue;
      const id = /GHSA-[\w-]+/.exec(via.url ?? '')?.[0] ?? `npm-${via.source}`;
      if (!out.has(id)) out.set(id, { id, package: via.name ?? v.name, severity: via.severity, title: via.title ?? '', url: via.url ?? '' });
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function loadBaseline(root) {
  const p = path.join(root, BASELINE);
  if (!K.isFile(p)) return { accepted: [] };
  const b = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { accepted: Array.isArray(b?.accepted) ? b.accepted : [] };
}

/** Compare found advisories with the baseline: {failures, warnings}. */
export function check(found, baseline, now = today()) {
  const failures = [];
  const warnings = [];
  const byId = new Map(baseline.accepted.map((e) => [e?.id, e]));
  for (const a of found) {
    const e = byId.get(a.id);
    if (!e) {
      failures.push(`${a.id} ${a.severity} in ${a.package}: ${a.title} ${a.url} — fix it, or a human accepts it: ci_audit.js --accept ${a.id} --reason … --by … --expires YYYY-MM-DD`);
      continue;
    }
    const missing = ['reason', 'by', 'expires'].filter((k) => typeof e[k] !== 'string' || e[k].trim() === '');
    if (missing.length) failures.push(`${a.id}: baseline entry lacks ${missing.join(', ')}`);
    else if (e.expires < now) failures.push(`${a.id}: acceptance by ${e.by} expired on ${e.expires}; fix it or re-accept with a new reason`);
    else warnings.push(`${a.id} ${a.severity} in ${a.package} accepted by ${e.by} until ${e.expires}: ${e.reason}`);
  }
  const ids = new Set(found.map((a) => a.id));
  for (const e of baseline.accepted) {
    if (e?.id && !ids.has(e.id)) warnings.push(`${e.id} is accepted in ${BASELINE} but no longer reported; remove the entry`);
  }
  return { failures, warnings };
}

function npmAudit(root) {
  if (!K.isFile(path.join(root, 'package-lock.json')) && !K.isFile(path.join(root, 'npm-shrinkwrap.json'))) {
    throw new Error('ci_audit.js reads npm lockfiles only (package-lock.json); for another package manager set kit.json commands.audit to its own audit command');
  }
  const r = spawnSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`npm audit could not run: ${r.error.message}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`npm audit gave no JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
}

export function main(argv) {
  const { values: o } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' }, level: { type: 'string', default: 'high' }, json: { type: 'string' },
      accept: { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' }, expires: { type: 'string' },
    },
  });
  const root = K.realResolve(o.repo);
  try {
    if (o.accept) {
      const now = today();
      if (!o.reason || !o.by || !o.expires) throw new Error('--accept needs --reason, --by and --expires');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.expires) || o.expires <= now) throw new Error('--expires must be a future date, YYYY-MM-DD');
      if (daysBetween(now, o.expires) > MAX_DAYS) throw new Error(`--expires is more than ${MAX_DAYS} days out; accept for less and review again`);
      const found = advisories(o.json ? JSON.parse(fs.readFileSync(o.json, 'utf8')) : npmAudit(root), 'info');
      const a = found.find((x) => x.id === o.accept);
      if (!a) throw new Error(`${o.accept} is not in the current audit; nothing to accept`);
      const b = loadBaseline(root);
      b.accepted = b.accepted.filter((e) => e?.id !== o.accept);
      b.accepted.push({ id: a.id, package: a.package, severity: a.severity, reason: o.reason, by: o.by, accepted: now, expires: o.expires });
      b.accepted.sort((x, y) => String(x.id).localeCompare(String(y.id)));
      const p = path.join(root, BASELINE);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(b, null, 2) + '\n');
      process.stdout.write(`audit: ${a.id} accepted by ${o.by} until ${o.expires} (${BASELINE})\n`);
      return 0;
    }
    const found = advisories(o.json ? JSON.parse(fs.readFileSync(o.json, 'utf8')) : npmAudit(root), o.level);
    const { failures, warnings } = check(found, loadBaseline(root));
    for (const w of warnings) process.stdout.write(`::warning::audit: ${w}\n`);
    if (failures.length) {
      process.stderr.write(`audit: ${failures.length} advisor${failures.length === 1 ? 'y' : 'ies'} at ${o.level} or above not fixed or accepted:\n  ${failures.join('\n  ')}\n`);
      return 1;
    }
    process.stdout.write(`audit: no unaccepted advisories at ${o.level} or above (${found.length} found, ${found.length - failures.length} accepted)\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`audit: ${e.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
