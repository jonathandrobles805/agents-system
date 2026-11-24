#!/usr/bin/env node
// Checks on the committed kit/dashboard/index.html (decision 0018). Exits 1 on any failure.
//  1. drift: a fresh build from source is byte-identical to the committed file
//  2. the literal import('./model.js') survives the build (register #75; kit test "index html is self contained")
//  3. self-contained: no <script src>, no <link> (register #8)
//  4. the original's head, lines 1-181 of kit/dashboard/index.html at the fixture's kit commit (doctype, meta, title,
//     the whole <style>), is byte-identical in the build (register #1-#3)
//  5. no favicon link (80c)
//   node parity/check-build.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..');
const COMMITTED = path.join(REPO, 'kit', 'dashboard', 'index.html');
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-build-'));
execFileSync('npx', ['vite', 'build'], { cwd: APP, env: { ...process.env, DASHBOARD_OUT: out }, stdio: 'ignore' });
const fresh = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const committed = fs.readFileSync(COMMITTED, 'utf8');

check(fresh === committed, `drift: fresh build (${fresh.length} bytes) is byte-identical to kit/dashboard/index.html (${committed.length} bytes)`);
check(committed.includes("import('./model.js')"), "literal import('./model.js') is present");
check(!/<script[^>]*\bsrc=/i.test(committed) && !/<link\b/i.test(committed), 'no <script src> and no <link>');
const { kit_commit } = JSON.parse(fs.readFileSync(path.join(HERE, 'baseline', 'FIXTURE.json'), 'utf8'));
const originalHead = execFileSync('git', ['show', `${kit_commit}:kit/dashboard/index.html`], { cwd: REPO, encoding: 'utf8' }).split('\n').slice(0, 181).join('\n');
check(committed.split('\n').slice(0, 181).join('\n') === originalHead, `lines 1-181 (head and the whole <style>) identical to the original at ${kit_commit.slice(0, 7)}`);
check(!/rel=["']?(shortcut )?icon/i.test(committed), 'no favicon link');
fs.rmSync(out, { recursive: true, force: true });
process.exitCode = failures.length ? 1 : 0;
