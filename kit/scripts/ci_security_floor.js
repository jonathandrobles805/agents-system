#!/usr/bin/env node
// CI: the project's effective permissions never fall below the kit's security floor (KIT-SPEC 10.9, decision 0008).
//
// Reads every settings scope Claude Code merges (managed, user, project, project-local) and fails when any of them
// loosens the floor: a floor deny entry missing from the project's settings.json, an allow entry in any scope that
// would grant what the floor denies, disableAllHooks anywhere, or a project trying to override the floor itself.
// Deny lists are additive across scopes in Claude Code, so only the project file must carry the floor; allow lists
// are checked in every scope because an allow in a wider scope reaches the lane.
//
//   node ci_security_floor.js --repo . [--home ~/.claude] [--managed <path>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as K from './kitlib.js';
import * as C from './ci_common.js';

const WILDCARD_ONLY = new Set(['', '*', '**', '*:*']);

/** Split "Tool(pattern)" into [tool, pattern]; a bare "Tool" is the whole tool. */
export function splitRule(rule) {
  const m = /^([A-Za-z_]+)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
  if (!m) return null;
  return [m[1], (m[2] ?? '').trim()];
}

/** True when an allow rule grants something a floor deny rule forbids. */
export function allowLoosens(allowRule, denyRule) {
  const a = splitRule(allowRule);
  const d = splitRule(denyRule);
  if (!a || !d || a[0] !== d[0]) return false;
  const [, ap] = a;
  const [, dp] = d;
  if (WILDCARD_ONLY.has(ap)) return true; // the whole tool
  if (ap === dp) return true;
  // the deny names a concrete path or command prefix and the allow's glob covers it
  const concrete = !/[*?[]/.test(dp.replace(/\*$/, ''));
  if (concrete && K.globMatch(dp.replace(/\*$/, ''), [ap])) return true;
  return false;
}

/** Default managed-settings locations per platform (Claude Code reads one of these when present). */
export function managedPaths() {
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (process.platform === 'win32') return ['C:\\ProgramData\\ClaudeCode\\managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

function readSettings(p) {
  if (!K.isFile(p)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return C.isPlainObject(v) ? v : {};
  } catch {
    return { __invalid: true };
  }
}

/** All findings for one project. Pure: no process exit, no output. */
export function check({ root, home, managed }) {
  const floor = K.loadFloor();
  const problems = [];
  const scopes = [
    ...managed.map((p) => ['managed', p]),
    ['user', path.join(home, 'settings.json')],
    ['project', path.join(root, '.claude', 'settings.json')],
    ['project-local', path.join(root, '.claude', 'settings.local.json')],
  ];
  const project = readSettings(path.join(root, '.claude', 'settings.json'));
  if (!project) return ['.claude/settings.json missing; run /bootstrap'];
  if (project.__invalid) return ['.claude/settings.json is not valid JSON'];

  // 1. the project file carries every floor deny entry
  const deny = new Set(Array.isArray(project.permissions?.deny) ? project.permissions.deny : []);
  for (const d of floor.deny) if (!deny.has(d)) problems.push(`permissions.deny is missing floor entry ${d} (project scope)`);

  // 2. no scope grants what the floor denies, and none disables hooks
  for (const [name, p] of scopes) {
    const s = readSettings(p);
    if (!s) continue;
    if (s.__invalid) {
      problems.push(`${name} settings (${p}) is not valid JSON`);
      continue;
    }
    if (C.truthy(s.disableAllHooks)) problems.push(`disableAllHooks is set in ${name} scope (${p})`);
    const allow = Array.isArray(s.permissions?.allow) ? s.permissions.allow : [];
    for (const a of allow) {
      if (typeof a !== 'string') continue;
      for (const d of floor.deny) if (allowLoosens(a, d)) problems.push(`${name} scope allows "${a}", which the floor denies (${d})`);
    }
  }

  // 3. the project may add to the floor, never redefine it
  const kit = K.loadKitJson(root);
  if (Object.prototype.hasOwnProperty.call(kit, 'floor')) problems.push('kit.json has a "floor" key; the floor is kit-owned and may only be extended through secret_patterns and permissions.deny');
  const extra = kit.secret_patterns;
  if (extra !== undefined && !(Array.isArray(extra) && extra.every((x) => typeof x === 'string'))) problems.push('kit.json secret_patterns must be a list of strings');

  return problems;
}

export function main(argv) {
  const ap = C.makeParser('ci_security_floor.js', [
    { flag: '--repo', default: '.' },
    { flag: '--home', default: process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude') },
    { flag: '--managed', default: null },
  ]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const managed = a.managed ? [a.managed] : managedPaths();
  const problems = check({ root, home: a.home, managed });
  if (problems.length) return C.fail('security-floor:\n  ' + problems.join('\n  '));
  return C.ok(`security-floor: effective permissions at or above floor v${K.loadFloor().version} (${K.loadFloor().deny.length} deny entries)`);
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
