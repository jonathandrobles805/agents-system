#!/usr/bin/env node
// Warn about registered projects whose hooks point at kit scripts that no longer exist (set up by an older kit version).
// A hook whose script is missing fails without blocking anything, so the project's guards would be silently off.
// Informational: always exits 0. install.sh runs it after installing.
//   check_projects.js [--kit DIR]   (default: the kit this script belongs to)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as K from './kitlib.js';

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

export function main(argv) {
  const i = argv.indexOf('--kit');
  const kitDir = i !== -1 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.dirname(path.dirname(K.realResolve(fileURLToPath(import.meta.url))));
  const home = process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
  const projects = readJson(path.join(home, 'kit-projects.json'));
  let stale = 0;
  for (const proj of Array.isArray(projects) ? projects : []) {
    if (typeof proj !== 'string') continue;
    const missing = K.staleHookScripts(readJson(path.join(proj, '.claude', 'settings.json')), kitDir);
    if (!missing.length) continue;
    stale++;
    process.stdout.write(`WARNING: ${proj}\n  its hooks point at kit scripts that no longer exist (${missing.join(', ')}), so its guards are not running.\n` +
      `  fix: node "${path.join(kitDir, 'scripts', 'bootstrap.js')}" --repo "${proj}" --upgrade\n`);
  }
  if (stale) process.stdout.write(`${stale} project(s) need an upgrade (or run: bootstrap.js --upgrade --all).\n`);
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
