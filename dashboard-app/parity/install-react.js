#!/usr/bin/env node
// Put the React build next to the original: a second clean checkout of the kit at the fixture's commit
// (.data/kit-react), with only kit/dashboard/index.html replaced by dist/index.html. Same server.js, same data.
//   node parity/install-react.js [DATA_DIR ...]     default: parity/.data
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BUILD = path.resolve(HERE, '..', 'dist', 'index.html');
if (!fs.existsSync(BUILD)) throw new Error(`no build at ${BUILD}; run npm run build`);

for (const dir of (process.argv.length > 2 ? process.argv.slice(2) : [path.join(HERE, '.data')]).map((d) => path.resolve(d))) {
  const { kit_commit } = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
  const wt = path.join(dir, 'kit-react');
  if (!fs.existsSync(wt)) execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, kit_commit], { cwd: REPO });
  fs.copyFileSync(BUILD, path.join(wt, 'kit', 'dashboard', 'index.html'));
  console.log(`${wt} @ ${kit_commit.slice(0, 7)}: kit/dashboard/index.html ← dist/index.html`);
}
