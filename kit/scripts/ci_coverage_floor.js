#!/usr/bin/env node
// CI: the coverage floor only rises (KIT-SPEC 7.4, "ratchets, not cliffs").
//
// Reads the coverage summary the project's coverage command wrote (istanbul coverage-summary.json, coverage.py JSON,
// or lcov.info), compares the line percentage with kit.json coverage_floor, and fails when coverage is below the floor
// or when the floor itself was lowered relative to the base branch. With --ratchet (run on the default branch after
// merge) it raises the floor to the measured value when coverage went up. No summary file: passes with a note when no
// coverage command is configured, fails when one is (the command ran and produced nothing).
//
//   node ci_coverage_floor.js --repo . [--base origin/main] [--ratchet]
import fs from 'node:fs';
import path from 'node:path';
import * as K from './kitlib.js';
import * as C from './ci_common.js';

const CANDIDATES = ['coverage/coverage-summary.json', 'coverage/coverage.json', 'coverage/lcov.info', 'lcov.info'];

/** Line coverage percentage from a known summary format, or null. */
export function readCoverage(root) {
  for (const rel of CANDIDATES) {
    const p = path.join(root, rel);
    if (!K.isFile(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (rel.endsWith('coverage-summary.json')) {
      try {
        const pct = JSON.parse(text)?.total?.lines?.pct;
        if (typeof pct === 'number') return { pct, file: rel };
      } catch {
        /* fall through */
      }
    } else if (rel.endsWith('coverage.json')) {
      try {
        const j = JSON.parse(text);
        const pct = j?.totals?.percent_covered ?? j?.total?.lines?.pct;
        if (typeof pct === 'number') return { pct, file: rel };
      } catch {
        /* fall through */
      }
    } else if (rel.endsWith('lcov.info')) {
      let found = 0;
      let hit = 0;
      for (const line of text.split('\n')) {
        if (line.startsWith('LF:')) found += Number(line.slice(3)) || 0;
        else if (line.startsWith('LH:')) hit += Number(line.slice(3)) || 0;
      }
      if (found > 0) return { pct: Math.round((hit / found) * 10000) / 100, file: rel };
    }
  }
  return null;
}

/** kit.json coverage_floor on another ref, or null when absent or unreadable. */
export function floorAt(root, ref) {
  try {
    const text = K.git(['show', `${ref}:.claude/kit.json`], root);
    const v = JSON.parse(text)?.coverage_floor;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** Findings and the floor decision. Pure except for --ratchet writing kit.json. */
export function check({ root, base = null, ratchet = false }) {
  const kitPath = path.join(root, '.claude', 'kit.json');
  const kit = K.loadKitJson(root);
  const floor = typeof kit.coverage_floor === 'number' ? kit.coverage_floor : null;
  const hasCommand = typeof kit.commands?.coverage === 'string' && kit.commands.coverage;
  const cov = readCoverage(root);
  const problems = [];
  const notes = [];

  if (base) {
    const baseFloor = floorAt(root, base);
    if (baseFloor != null && floor != null && floor < baseFloor) problems.push(`coverage_floor lowered from ${baseFloor} (on ${base}) to ${floor}; the floor only rises`);
    if (baseFloor != null && floor == null) problems.push(`coverage_floor removed (was ${baseFloor} on ${base}); the floor only rises`);
  }
  if (!cov) {
    if (hasCommand) problems.push(`no coverage summary found (${CANDIDATES.join(', ')}) although kit.json commands.coverage is set; the coverage command ran and wrote nothing`);
    else notes.push('no coverage command configured; floor not checked');
    return { problems, notes, pct: null, floor };
  }
  if (floor != null && cov.pct < floor) problems.push(`line coverage ${cov.pct}% is below the floor ${floor}% (${cov.file})`);
  if (ratchet && !problems.length && (floor == null || cov.pct > floor)) {
    const next = Math.floor(cov.pct * 100) / 100;
    fs.writeFileSync(kitPath, K.jsonDumps({ ...kit, coverage_floor: next }, { indent: 2 }) + '\n');
    notes.push(`floor raised ${floor ?? 'none'} → ${next}`);
  } else if (floor == null) {
    notes.push(`no floor yet; measured ${cov.pct}% (run with --ratchet on the default branch to set it)`);
  }
  return { problems, notes, pct: cov.pct, floor };
}

export function main(argv) {
  const ap = C.makeParser('ci_coverage_floor.js', [{ flag: '--repo', default: '.' }, { flag: '--base', default: null }, { flag: '--ratchet', default: null }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const r = check({ root, base: a.base, ratchet: a.ratchet != null && a.ratchet !== 'false' });
  if (r.problems.length) return C.fail('coverage-floor:\n  ' + r.problems.join('\n  '));
  return C.ok(`coverage-floor: ${r.pct == null ? 'n/a' : `${r.pct}%`} against floor ${r.floor ?? 'none'}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
