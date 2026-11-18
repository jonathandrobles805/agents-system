#!/usr/bin/env node
// CI: the project's hooks and kit scripts are intact: every kit hook is present and unchanged (project hooks may sit
// next to them), disableAllHooks is not set,
// and kit-owned files match the manifest written at bootstrap/upgrade.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import { isMain } from './kitlib.js';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** Python set(v) for a decoded JSON value. */
function pySet(v) {
  if (Array.isArray(v)) return new Set(v);
  if (typeof v === 'string') return new Set([...v]);
  if (C.isPlainObject(v)) return new Set(Object.keys(v));
  throw new TypeError(`'${C.pyTypeName(v)}' object is not iterable`);
}

export function main(argv) {
  const defaultKit = path.dirname(path.dirname(K.realResolve(fileURLToPath(import.meta.url))));
  const ap = C.makeParser('ci_guards_present.js', [{ flag: '--repo', default: '.' }, { flag: '--kit', default: defaultKit }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const kit = K.realResolve(a.kit);
  const problems = [];
  const settingsP = C.joinPath(root, '.claude', 'settings.json');
  if (!K.isFile(settingsP)) return C.fail('guards-present: .claude/settings.json missing; run /kit-setup');
  const settings = readJson(settingsP);
  if (C.truthy(C.dictGet(settings, 'disableAllHooks', null))) problems.push('disableAllHooks is set');
  const frag = readJson(C.joinPath(kit, 'hooks', 'settings.project.json'));
  const stale = K.staleHookScripts(settings, kit);
  if (stale.length) {
    problems.push(`hooks point at kit scripts that do not exist in this kit (${stale.join(', ')}): this project was set up by an older kit version; run /kit-setup --upgrade`);
  }
  // Every kit hook must be present and unchanged; the project's own hooks may sit next to them (field test #10).
  // An entry that runs a kit script but matches no fragment entry is a modified kit hook and fails.
  const hooks = C.dictGet(settings, 'hooks', null);
  const have = C.truthy(hooks) && typeof hooks === 'object' && !Array.isArray(hooks) ? hooks : {};
  for (const [ev, entries] of Object.entries(frag.hooks)) {
    const got = Array.isArray(have[ev]) ? have[ev] : [];
    const missing = entries.filter((e) => !got.some((g) => isDeepStrictEqual(g, e)));
    if (missing.length) problems.push(`hooks.${ev}: ${missing.length} kit hook entr${missing.length === 1 ? 'y is' : 'ies are'} missing or changed (run /kit-setup --upgrade)`);
  }
  for (const [ev, entries] of Object.entries(have)) {
    if (!Array.isArray(entries)) continue;
    const kitEntries = Array.isArray(frag.hooks[ev]) ? frag.hooks[ev] : [];
    for (const e of entries) {
      if (K.isKitHookEntry(e) && !kitEntries.some((k) => isDeepStrictEqual(k, e))) {
        problems.push(`hooks.${ev}: an entry runs a kit script but is not the kit's hook (modified kit hook)`);
      }
    }
  }
  const perms = C.dictGet(settings, 'permissions', null);
  const deny = pySet(C.dictGet(C.truthy(perms) ? perms : {}, 'deny', []));
  for (const d of frag.permissions.deny) {
    if (!deny.has(d)) problems.push(`permissions.deny missing ${d}`);
  }
  const manP = C.joinPath(root, '.claude', 'kit-manifest.json');
  if (K.isFile(manP)) {
    const man = readJson(manP);
    for (const [rel, h] of Object.entries(C.dictGet(man, 'files', {}))) {
      const p = C.joinPath(root, rel);
      if (!K.isFile(p)) problems.push(`${rel} missing`);
      else if (C.sha256File(p) !== h) problems.push(`${rel} changed since bootstrap (edit through /kit-setup --upgrade)`);
    }
    for (const [name, h] of Object.entries(C.dictGet(man, 'kit_scripts', {}))) {
      const p = C.joinPath(kit, 'scripts', name);
      if (K.isFile(p) && C.sha256File(p) !== h) {
        problems.push(`kit script ${name} differs from the version this project was bootstrapped with; run /kit-setup --upgrade`);
      }
    }
  } else {
    problems.push('.claude/kit-manifest.json missing');
  }
  if (problems.length) return C.fail('guards-present:\n  ' + problems.join('\n  '));
  return C.ok('guards-present: hooks, permissions, and kit-owned files intact');
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
