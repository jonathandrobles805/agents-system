#!/usr/bin/env node
// CI: the project's hooks and kit scripts are intact: settings.json hooks equal the kit fragment, disableAllHooks is not set,
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
  if (!K.isFile(settingsP)) return C.fail('guards-present: .claude/settings.json missing; run /bootstrap');
  const settings = readJson(settingsP);
  if (C.truthy(C.dictGet(settings, 'disableAllHooks', null))) problems.push('disableAllHooks is set');
  const frag = readJson(C.joinPath(kit, 'hooks', 'settings.project.json'));
  const hooks = C.dictGet(settings, 'hooks', null);
  if (!isDeepStrictEqual(hooks, frag.hooks)) {
    const have = C.truthy(hooks) ? hooks : {};
    const missing = Object.keys(frag.hooks).filter((ev) => !Object.prototype.hasOwnProperty.call(have, ev));
    problems.push(`hooks block differs from kit fragment (missing events: ${missing.length ? C.pyListRepr(missing) : 'none; entries changed'})`);
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
      else if (C.sha256File(p) !== h) problems.push(`${rel} changed since bootstrap (edit through /bootstrap --upgrade)`);
    }
    for (const [name, h] of Object.entries(C.dictGet(man, 'kit_scripts', {}))) {
      const p = C.joinPath(kit, 'scripts', name);
      if (K.isFile(p) && C.sha256File(p) !== h) {
        problems.push(`kit script ${name} differs from the version this project was bootstrapped with; run /bootstrap --upgrade`);
      }
    }
  } else {
    problems.push('.claude/kit-manifest.json missing');
  }
  if (problems.length) return C.fail('guards-present:\n  ' + problems.join('\n  '));
  return C.ok('guards-present: hooks, permissions, and kit-owned files intact');
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
