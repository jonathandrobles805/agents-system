// The agents' GitHub identity (hardening plan D1, 0016 E.7): the App's token is minted on the owner's machine from a
// key outside every repository, scoped to one repository, and handed to git and gh through the environment only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitAll } from './fixtures.js';
import { runScript, setEnv, tmpPath } from './helpers.js';
import { project } from './testdata.js';
import * as APP from '../app_token.js';
import { publish } from '../lane.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

test('appConfig: environment first, then ~/.claude/kit-app.json, with a reason when neither is usable', (t) => {
  const home = tmpPath(t);
  assert.deepEqual(APP.appConfig({ KIT_APP_ID: '5840689', KIT_APP_PRIVATE_KEY: '/k.pem' }, home), { config: { app_id: '5840689', private_key: '/k.pem', source: 'environment' }, reason: '' });
  assert.match(APP.appConfig({ KIT_APP_ID: '5840689' }, home).reason, /set both KIT_APP_ID and KIT_APP_PRIVATE_KEY/);
  assert.match(APP.appConfig({}, home).reason, /no GitHub App configured: write .*kit-app\.json/);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'kit-app.json'), '{"app_id": 5840689}');
  assert.match(APP.appConfig({}, home).reason, /needs "app_id" and "private_key"/);
  fs.writeFileSync(path.join(home, '.claude', 'kit-app.json'), JSON.stringify({ app_id: 5840689, private_key: '/k.pem' }));
  const c = APP.appConfig({}, home);
  assert.equal(c.config.app_id, '5840689');
  assert.equal(c.config.private_key, '/k.pem');
});

test('appJwt: RS256, issued a minute ago, valid nine minutes, issuer = the App id', () => {
  const now = 1_800_000_000;
  const jwt = APP.appJwt(5840689, PEM, now);
  const [h, p, s] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(dec(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(dec(p), { iat: now - 60, exp: now + 540, iss: '5840689' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.equal(ok, true, 'the signature verifies with the public key');
});

test('installationToken: finds the installation for the repository, asks for a token limited to it, never wider', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const body = (status, data) => ({ status, text: async () => JSON.stringify(data) });
    if (url.endsWith('/repos/o/proj/installation')) return body(200, { id: 77 });
    if (url.endsWith('/app/installations/77/access_tokens')) return body(201, { token: 'ghs_secret', expires_at: '2026-11-20T23:00:00Z' });
    return body(500, { message: 'unexpected' });
  };
  const r = await APP.installationToken({ appId: 5840689, privateKeyPem: PEM, owner: 'o', repo: 'proj', fetchFn, now: 1_800_000_000 });
  assert.deepEqual(r, { ok: true, token: 'ghs_secret', expires_at: '2026-11-20T23:00:00Z', installation_id: 77, reason: '' });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.init.headers.Authorization, /^Bearer eyJ/, 'the JWT, as the App itself');
    assert.equal(c.init.headers['X-GitHub-Api-Version'], '2022-11-28');
  }
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { repositories: ['proj'], permissions: { contents: 'write', pull_requests: 'write' } });
});

test('installationToken: an App that is not installed on the repository, or a refused token, is a reason, not a throw', async () => {
  const notInstalled = async () => ({ status: 404, text: async () => JSON.stringify({ message: 'Not Found' }) });
  let r = await APP.installationToken({ appId: 1, privateKeyPem: PEM, owner: 'o', repo: 'proj', fetchFn: notInstalled });
  assert.equal(r.ok, false);
  assert.match(r.reason, /the App is not installed on o\/proj/);
  const refused = async (url) => (url.endsWith('/installation') ? { status: 200, text: async () => '{"id": 3}' } : { status: 422, text: async () => JSON.stringify({ message: 'The permissions requested are not granted to this installation.' }) });
  r = await APP.installationToken({ appId: 1, privateKeyPem: PEM, owner: 'o', repo: 'proj', fetchFn: refused });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not create an installation token: The permissions requested are not granted/);
});

test('readPrivateKey: refuses a key inside the repository, a missing file and a non-PEM file', (t) => {
  const dir = tmpPath(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const inside = path.join(repo, 'app.pem');
  fs.writeFileSync(inside, PEM);
  assert.match(APP.readPrivateKey({ private_key: inside }, repo).reason, /inside the repository; move it outside/);
  assert.match(APP.readPrivateKey({ private_key: path.join(dir, 'missing.pem') }, repo).reason, /does not exist/);
  fs.writeFileSync(path.join(dir, 'not.pem'), 'hello');
  assert.match(APP.readPrivateKey({ private_key: path.join(dir, 'not.pem') }, repo).reason, /is not a PEM private key/);
  const outside = path.join(dir, 'app.pem');
  fs.writeFileSync(outside, PEM);
  assert.equal(APP.readPrivateKey({ private_key: outside }, repo).pem, PEM);
});

/** A fake gh on PATH that records `pr create` with whether GH_TOKEN was set, and answers with a PR URL. */
function fakeGh(t) {
  const dir = tmpPath(t);
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, token: process.env.GH_TOKEN || '' }) + '\\n');
if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write('https://github.com/o/proj/pull/12\\n'); process.exit(0); }
process.stderr.write('fake gh: unexpected ' + args.join(' ')); process.exit(9);
`, { mode: 0o755 });
  setEnv(t, 'PATH', `${dir}${path.delimiter}${process.env.PATH}`);
  return () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A project with a started lane, a GitHub-looking origin, a bare repository to push to, and the App configured. */
function laneProject(t) {
  const { root } = project(t);
  assert.equal(runScript('lane.js', ['start', 'refund-route', '--repo', root]).returncode, 0);
  const wt = path.join(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route');
  if (git(['status', '--porcelain'], wt).trim()) commitAll(wt, 'lane skeleton');
  git(['remote', 'add', 'origin', 'https://github.com/o/proj.git'], root);
  const bare = path.join(tmpPath(t), 'origin.git');
  git(['init', '-q', '--bare', bare], path.dirname(bare));
  const pem = path.join(tmpPath(t), 'agents-system-bot.pem');
  fs.writeFileSync(pem, PEM);
  setEnv(t, 'KIT_APP_ID', '5840689');
  setEnv(t, 'KIT_APP_PRIVATE_KEY', pem);
  return { root, wt, bare };
}

test('publish: pushes the lane branch with the App token through GIT_ASKPASS and opens the PR as the App (D1, 0016 E.7)', async (t) => {
  const { root, wt, bare } = laneProject(t);
  const calls = fakeGh(t);
  const minted = [];
  const token = async (req) => { minted.push(req); return { ok: true, token: 'ghs_secret', expires_at: null, installation_id: 7, reason: '' }; };
  // the push goes to the bare repository standing in for GitHub; everything else is as in production
  const bareUrlSeen = [];
  const out = [];
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  let rc;
  try {
    rc = await publish(root, { slug: 'refund-route' }, { token, pushTarget: (o, r) => { bareUrlSeen.push(`${o}/${r}`); return bare; } });
  } finally { process.stdout.write = w; }
  assert.equal(rc, 0, out.join(''));
  assert.deepEqual(bareUrlSeen, ['o/proj'], 'owner and repository come from origin');
  assert.equal(minted.length, 1);
  assert.equal(minted[0].owner, 'o'); assert.equal(minted[0].repo, 'proj'); assert.equal(minted[0].appId, '5840689'); assert.equal(minted[0].privateKeyPem, PEM);
  assert.equal(git(['rev-parse', 'wt/refund-route'], bare).trim(), git(['rev-parse', 'HEAD'], wt).trim(), 'the branch arrived');
  const pr = calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(pr, 'a PR was opened');
  assert.equal(pr.token, 'ghs_secret', 'gh ran as the App, not as the owner');
  assert.deepEqual(pr.args.slice(2, 10), ['--repo', 'o/proj', '--head', 'wt/refund-route', '--base', 'main', '--title', 'refund-route: Refund route']);
  assert.equal(pr.args[10], '--body-file');
  assert.ok(pr.args[11].endsWith(path.join('docs', 'specs', 'refund-route.progress.md')));
  assert.deepEqual(out, ['https://github.com/o/proj/pull/12\n']);
  // the upstream is recorded from what was pushed, with no fetch (nothing in publish runs as the owner)
  assert.equal(git(['rev-parse', '--abbrev-ref', 'wt/refund-route@{upstream}'], wt).trim(), 'origin/wt/refund-route');
  assert.equal(git(['rev-parse', 'refs/remotes/origin/wt/refund-route'], wt).trim(), git(['rev-parse', 'HEAD'], wt).trim());
});

test('publish ignores the owner\'s git configuration: a global pushInsteadOf cannot divert the push to the owner\'s identity; a local one is refused', async (t) => {
  const { root, wt, bare } = laneProject(t);
  fakeGh(t);
  // the common "fetch over HTTPS, push over SSH" setup, aimed at the test's push target: without protection git would
  // silently push over SSH as the owner (here: to a closed port, so the push would fail instead of landing)
  const gcfg = path.join(tmpPath(t), 'gitconfig');
  fs.writeFileSync(gcfg, `[url "ssh://nobody@localhost:1/"]\n\tpushInsteadOf = ${bare}\n`);
  const control = spawnSync('git', ['push', bare, 'wt/refund-route:wt/refund-route'], { cwd: wt, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'false' } });
  assert.notEqual(control.status, 0, 'control: the rewrite does divert a plain push');
  assert.match(control.stderr, /ssh/i, control.stderr);
  setEnv(t, 'GIT_CONFIG_GLOBAL', gcfg);
  const token = async () => ({ ok: true, token: 'ghs_secret', reason: '' });
  const quiet = async (fn) => { const w = process.stdout.write.bind(process.stdout); process.stdout.write = () => true; try { return await fn(); } finally { process.stdout.write = w; } };
  const rc = await quiet(() => publish(root, { slug: 'refund-route' }, { token, pushTarget: () => bare }));
  assert.equal(rc, 0);
  assert.equal(git(['rev-parse', 'wt/refund-route'], bare).trim(), git(['rev-parse', 'HEAD'], wt).trim(), 'the push landed where publish aimed, not where the owner\'s config pointed');
  // the same rewrite in the repository's own config is refused before anything is pushed
  git(['config', 'url.ssh://nobody@localhost:1/.pushInsteadOf', bare], wt);
  const errs = [];
  const e = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    assert.equal(await publish(root, { slug: 'refund-route' }, { token, pushTarget: () => bare }), 2);
  } finally { process.stderr.write = e; }
  assert.match(errs.at(-1), /rewrites or authenticates pushes itself.*pushinsteadof/i);
  // an unscoped auth header in the repository's config would authenticate the push as the owner before askpass is asked
  git(['config', '--unset', 'url.ssh://nobody@localhost:1/.pushInsteadOf'], wt);
  git(['config', 'http.extraHeader', 'Authorization: basic b3duZXI6c2VjcmV0'], wt);
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    assert.equal(await publish(root, { slug: 'refund-route' }, { token, pushTarget: () => bare }), 2);
  } finally { process.stderr.write = e; }
  assert.match(errs.at(-1), /rewrites or authenticates pushes itself.*http\.extraheader/i);
});

test('publish refuses: a branch outside wt/* and spec/*, a dirty worktree, no App configured, a token GitHub refused', async (t) => {
  const { root, wt, bare } = laneProject(t);
  fakeGh(t);
  const errs = [];
  const e = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  const token = async () => ({ ok: true, token: 'ghs_secret', reason: '' });
  const deps = { token, pushTarget: () => bare };
  try {
    assert.equal(await publish(root, { slug: 'refund-route', branch: 'feature/x' }, deps), 2);
    assert.match(errs.at(-1), /not a lane \(wt\/\*\) or spec \(spec\/\*\) branch/);
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x');
    assert.equal(await publish(root, { slug: 'refund-route' }, deps), 2);
    assert.match(errs.at(-1), /uncommitted changes/);
    fs.rmSync(path.join(wt, 'scratch.txt'));
    assert.equal(await publish(root, { slug: 'refund-route' }, { ...deps, token: async () => ({ ok: false, reason: 'could not find the App\'s installation on o/proj: the App is not installed on o/proj' }) }), 2);
    assert.match(errs.at(-1), /the App is not installed on o\/proj/);
    delete process.env.KIT_APP_ID; delete process.env.KIT_APP_PRIVATE_KEY;
    setEnv(t, 'HOME', tmpPath(t));
    assert.equal(await publish(root, { slug: 'refund-route' }, deps), 2);
    assert.match(errs.at(-1), /no GitHub App configured/);
  } finally { process.stderr.write = e; }
  assert.throws(() => git(['rev-parse', '--verify', 'wt/refund-route'], bare), 'nothing was pushed');
});

test('publish commits the lane\'s events log, which the kit\'s own hooks keep dirty, and still refuses any other dirty file (#143)', async (t) => {
  const { root, wt, bare } = laneProject(t);
  fakeGh(t);
  const token = async () => ({ ok: true, token: 'ghs_secret', expires_at: null, installation_id: 7, reason: '' });
  const deps = { token, pushTarget: () => bare };
  const events = path.join(wt, 'docs', 'specs', 'refund-route.events.jsonl');
  const errs = [];
  const e = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    // another file dirty as well: refused, nothing committed
    fs.appendFileSync(events, '{"event":"tool","result":"ok"}\n');
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x');
    assert.equal(await publish(root, { slug: 'refund-route', title: 't', body: 'b' }, deps), 2);
    assert.match(errs.at(-1), /uncommitted changes/);
    fs.rmSync(path.join(wt, 'scratch.txt'));
    // only the events log dirty: publish commits it and goes on
    assert.equal(await publish(root, { slug: 'refund-route', title: 't', body: 'b' }, deps), 0, errs.join(''));
  } finally { process.stderr.write = e; }
  assert.equal(git(['status', '--porcelain'], wt).trim(), '');
  assert.equal(git(['log', '-1', '--format=%s'], wt).trim(), 'chore(refund-route): events log');
  assert.equal(git(['rev-parse', 'wt/refund-route'], bare).trim(), git(['rev-parse', 'HEAD'], wt).trim(), 'the commit was pushed');
});
