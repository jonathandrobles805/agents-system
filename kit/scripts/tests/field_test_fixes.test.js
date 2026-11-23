// Fixes from the first field test (hya-sandbox, 2026-11-11). Each test names the finding it closes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { advisories, check } from '../ci_audit.js';
import { ciRunBody, mergeHooks, verifyDetected, workspaceDirs, KIT_BLOCK_BEGIN } from '../bootstrap.js';
import * as F from './fixtures.js';
import { runScript, tmpPath, SCRIPTS } from './helpers.js';

const KIT = path.dirname(SCRIPTS);

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, t) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
};
const boot = (root, ...args) => {
  const r = runScript('bootstrap.js', ['--repo', root, '--json', ...args]);
  assert.equal(r.returncode, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const kitJson = (root) => JSON.parse(read(root, '.claude', 'kit.json'));
const PROJECT_HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: 'scripts/hooks/worktree-guard.sh' }] };

test('#1/#10 bootstrap keeps the project\'s own hooks, on first run and on upgrade; guards-present accepts them', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  write(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [PROJECT_HOOK] } }));
  boot(root);
  const has = () => JSON.parse(read(root, '.claude', 'settings.json')).hooks.PreToolUse.some((e) => JSON.stringify(e) === JSON.stringify(PROJECT_HOOK));
  assert.ok(has(), 'kept on bootstrap');
  boot(root, '--upgrade');
  assert.ok(has(), 'kept on upgrade');
  const once = JSON.parse(read(root, '.claude', 'settings.json')).hooks.PreToolUse.filter((e) => JSON.stringify(e) === JSON.stringify(PROJECT_HOOK));
  assert.equal(once.length, 1, 'never duplicated');
  const g = runScript('ci_guards_present.js', ['--repo', root, '--kit', KIT]);
  assert.equal(g.returncode, 0, g.stderr);
});

test('#10 guards-present still fails when a kit hook is removed or changed', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  const sp = path.join(root, '.claude', 'settings.json');
  const s = JSON.parse(read(sp));
  s.hooks.PreToolUse = s.hooks.PreToolUse.slice(1); // drop the edit guard
  fs.writeFileSync(sp, JSON.stringify(s));
  let g = runScript('ci_guards_present.js', ['--repo', root, '--kit', KIT]);
  assert.equal(g.returncode, 1);
  assert.ok(g.stderr.includes('missing or changed'), g.stderr);
  boot(root, '--upgrade');
  const s2 = JSON.parse(read(sp));
  s2.hooks.PreToolUse[0].hooks[0].command += ' || true'; // a weakened kit hook
  fs.writeFileSync(sp, JSON.stringify(s2));
  g = runScript('ci_guards_present.js', ['--repo', root, '--kit', KIT]);
  assert.equal(g.returncode, 1);
  assert.ok(g.stderr.includes('modified kit hook'), g.stderr);
});

test('mergeHooks: an old kit entry is replaced, not kept beside the new one', () => {
  const kit = { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node "$HOME/.claude/kit/scripts/hook_guard_edit.js"' }] }] };
  const old = { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'python3 "$HOME/.claude/kit/scripts/hook_guard_edit.py"' }] }, PROJECT_HOOK] };
  assert.deepEqual(mergeHooks(kit, old), { PreToolUse: [kit.PreToolUse[0], PROJECT_HOOK] });
});

test('#13 an existing CLAUDE.md gets the kit block appended once; the human text is untouched', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  const mine = '# HYA\n\nAsk before pushing.\n';
  write(path.join(root, 'CLAUDE.md'), mine);
  boot(root);
  const a = read(root, 'CLAUDE.md');
  assert.ok(a.startsWith(mine + '\n' + KIT_BLOCK_BEGIN), a);
  boot(root);
  boot(root, '--upgrade');
  assert.equal(read(root, 'CLAUDE.md'), a);
});

test('#21 upgrade without --answers keeps the commands the human confirmed', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  const kp = path.join(root, '.claude', 'kit.json');
  const k = kitJson(root);
  k.commands.boundaries = 'npx depcruise --config .dependency-cruiser.cjs apps packages';
  k.commands.typecheck = 'npm run typecheck';
  k.commands.audit = 'npm audit --audit-level=high'; // the old kit default: migrated, not the human's
  fs.writeFileSync(kp, JSON.stringify(k, null, 2));
  boot(root, '--upgrade');
  const c = kitJson(root).commands;
  assert.equal(c.boundaries, 'npx depcruise --config .dependency-cruiser.cjs apps packages');
  assert.equal(c.typecheck, 'npm run typecheck');
  assert.equal(c.audit, 'kit ci_audit --repo .'); // the launcher form (#63)
});

test('#8 a detected depcruise command is checked against the repo: no config → not proposed; no src → the folders that exist', (t) => {
  const root = path.join(tmpPath(t), 'mono');
  write(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'ui'), { recursive: true });
  assert.deepEqual(workspaceDirs(root), ['apps', 'packages']);
  const det = () => ({ commands: { boundaries: 'npx depcruise --config .dependency-cruiser.cjs src' }, command_evidence: {}, missing_tools: {} });
  let r = det();
  verifyDetected(root, r);
  assert.equal(r.commands.boundaries, undefined);
  assert.ok(r.missing_tools.boundaries.includes('no config'));
  write(path.join(root, '.dependency-cruiser.cjs'), 'module.exports = {};');
  r = det();
  verifyDetected(root, r);
  assert.equal(r.commands.boundaries, 'npx depcruise --config .dependency-cruiser.cjs apps packages');
  assert.ok(r.command_evidence.boundaries.includes('exists'));
});

test('#17–#20 generated CI: kit through its pinned action, setup and install before project commands, block scalars, no fake green', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  write(path.join(root, 'package-lock.json'), '{}');
  const res = boot(root);
  const wf = read(root, '.github', 'workflows', 'kit.yml');
  assert.ok(!wf.includes('actions/checkout@v4\n        with:\n          repository:'), 'no cross-repo checkout of the kit');
  assert.ok(/uses: [\w-]+\/[\w.-]+@[0-9a-f]{40}|uses: [\w-]+\/[\w.-]+@v\d+\.\d+\.\d+/.test(wf), 'kit action pinned');
  assert.ok(!wf.includes('@main'));
  const typecheck = wf.slice(wf.indexOf('  typecheck:'), wf.indexOf('  lint:'));
  assert.ok(typecheck.includes('actions/setup-node@v4') && typecheck.includes('npm ci'), typecheck);
  assert.ok(wf.includes('permissions:\n  contents: read'));
  assert.ok(!wf.includes('gitleaks/gitleaks-action') && wf.includes('sha256sum -c -'));
  assert.ok(!wf.includes('.kit/kit/') && !wf.includes('$HOME/.claude/kit/'));
  assert.ok(!/(?<!\$)\{\{/.test(wf), 'every placeholder filled');
  assert.ok(Array.isArray(res.warnings));
});

test('#20 a CI command: configured runs, "none: reason" warns and passes, missing errors and fails', () => {
  assert.ok(ciRunBody('lint', 'npm run lint:css').trim() === 'npm run lint:css');
  const off = ciRunBody('format', 'none: formatting is done in the editor');
  assert.ok(off.includes('::warning::format is off on purpose: formatting is done in the editor') && !off.includes('exit 1'));
  const missing = ciRunBody('format', null);
  assert.ok(missing.includes('::error::format is not configured') && missing.includes('exit 1'));
  // shell-unsafe text inside the reason is escaped, and parentheses never reach bash unquoted (#18)
  const odd = ciRunBody('integration', null, ' (kit.json db.lane_adapter: none)');
  assert.ok(odd.includes('echo "::error::integration is not configured (kit.json db.lane_adapter: none)'));
  assert.ok(ciRunBody('audit', 'node "$HOME/.claude/kit/scripts/ci_audit.js" --repo .').includes('"$KIT_DIR/scripts/ci_audit.js"'));
  // the launcher form runs the checked-out kit in CI, also after `&&`; another tool called `kit` is left alone
  assert.equal(ciRunBody('audit', 'kit ci_audit --repo .').trim(), 'node "$KIT_DIR/scripts/ci_audit.js" --repo .');
  assert.equal(ciRunBody('boundaries', 'npm run x && kit ci_boundaries_simple --repo .').trim(), 'npm run x && node "$KIT_DIR/scripts/ci_boundaries_simple.js" --repo .');
  assert.equal(ciRunBody('integration', 'kit pack model.yaml').trim(), 'kit pack model.yaml');
  assert.equal(ciRunBody('audit', '  (kit ci_audit --repo .)').trim(), '(node "$KIT_DIR/scripts/ci_audit.js" --repo .)');
  assert.equal(ciRunBody('audit', 'echo kit lane').trim(), 'echo kit lane');
});

const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    storybook: { name: 'storybook', severity: 'critical', via: [{ source: 1, name: 'storybook', title: 'bad thing', url: 'https://github.com/advisories/GHSA-px85-f4q5-jh77', severity: 'critical' }] },
    vite: { name: 'vite', severity: 'moderate', via: [{ source: 2, name: 'vite', title: 'minor', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'moderate' }] },
    wrapper: { name: 'wrapper', severity: 'critical', via: ['storybook'] },
  },
};

test('#22 audit ratchet: a new advisory fails; accepted with reason and expiry passes; expired fails; nothing accepted silently', (t) => {
  const found = advisories(REPORT, 'high');
  assert.deepEqual(found.map((a) => a.id), ['GHSA-px85-f4q5-jh77']);
  assert.equal(check(found, { accepted: [] }).failures.length, 1);
  const ok = check(found, { accepted: [{ id: 'GHSA-px85-f4q5-jh77', reason: 'dev only', by: 'jonathan', expires: '2999-01-01' }] }, '2026-11-11');
  assert.equal(ok.failures.length, 0);
  assert.equal(ok.warnings.length, 1);
  assert.equal(check(found, { accepted: [{ id: 'GHSA-px85-f4q5-jh77', reason: 'dev only', by: 'jonathan', expires: '2026-01-01' }] }, '2026-11-11').failures.length, 1);
  assert.equal(check(found, { accepted: [{ id: 'GHSA-px85-f4q5-jh77', by: 'jonathan', expires: '2999-01-01' }] }, '2026-11-11').failures.length, 1, 'no reason → fails');
  // the CLI end to end, from a saved report
  const root = path.join(tmpPath(t), 'p');
  write(path.join(root, 'package-lock.json'), '{}');
  const rep = path.join(root, 'audit.json');
  write(rep, JSON.stringify(REPORT));
  assert.equal(runScript('ci_audit.js', ['--repo', root, '--json', rep]).returncode, 1);
  const far = runScript('ci_audit.js', ['--repo', root, '--json', rep, '--accept', 'GHSA-px85-f4q5-jh77', '--reason', 'dev only', '--by', 'jonathan', '--expires', '2999-01-01']);
  assert.equal(far.returncode, 1, 'more than 90 days out is refused');
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const acc = runScript('ci_audit.js', ['--repo', root, '--json', rep, '--accept', 'GHSA-px85-f4q5-jh77', '--reason', 'dev only', '--by', 'jonathan', '--expires', soon]);
  assert.equal(acc.returncode, 0, acc.stderr);
  const r = runScript('ci_audit.js', ['--repo', root, '--json', rep]);
  assert.equal(r.returncode, 0, r.stderr);
  assert.ok(r.stdout.includes('::warning::audit: GHSA-px85-f4q5-jh77'));
});

test('#63 an upgrade moves the kit\'s gate commands from the "$HOME" form to the launcher form and keeps another tool called kit', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  // a fresh bootstrap writes the launcher form, and the allow rules come from Bash(kit *), never a "$HOME" rule
  let c = kitJson(root).commands;
  assert.equal(c.audit, 'kit ci_audit --repo .');
  assert.equal(c.boundaries, 'kit ci_boundaries_simple --repo .');
  const settings = () => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).permissions.allow;
  assert.ok(settings().includes('Bash(kit *)'));
  assert.ok(settings().every((r) => !r.includes('$HOME')), settings().join(', '));
  // a project an older kit set up: the "$HOME" forms are the kit's old defaults and are migrated
  const kp = path.join(root, '.claude', 'kit.json');
  const k = kitJson(root);
  k.commands.audit = 'node "$HOME/.claude/kit/scripts/ci_audit.js" --repo .';
  k.commands.boundaries = 'node "$HOME/.claude/kit/scripts/ci_boundaries_simple.js" --repo .';
  k.commands.integration = 'kit pack model.yaml'; // KitOps: the project's own tool, kept as is
  k.commands.mutation = 'node "$HOME/.claude/kit/scripts/ci_audit.js" --repo . --level critical'; // customised: arguments kept
  fs.writeFileSync(kp, JSON.stringify(k, null, 2));
  boot(root, '--upgrade');
  c = kitJson(root).commands;
  assert.equal(c.audit, 'kit ci_audit --repo .');
  assert.equal(c.boundaries, 'kit ci_boundaries_simple --repo .');
  assert.equal(c.integration, 'kit pack model.yaml');
  assert.equal(c.mutation, 'kit ci_audit --repo . --level critical');
  assert.ok(settings().every((r) => !r.includes('$HOME')), settings().join(', '));
});

test('#63 the human\'s decisions ask every time: bootstrap writes the kit\'s ask rules, an upgrade adds them, a project\'s own are kept', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  const sp = path.join(root, '.claude', 'settings.json');
  const perms = () => JSON.parse(fs.readFileSync(sp, 'utf8')).permissions;
  const kitAsk = ['Bash(kit bootstrap *)', 'Bash(kit lane merge *)', 'Bash(kit lane resume-all *)'];
  for (const r of kitAsk) assert.ok(perms().ask.includes(r), r);
  // a project set up before ask rules existed, with one ask rule of its own
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.permissions.ask = ['Bash(npm publish *)'];
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));
  boot(root, '--upgrade');
  for (const r of [...kitAsk, 'Bash(npm publish *)']) assert.ok(perms().ask.includes(r), r);
  assert.equal(runScript('ci_security_floor.js', ['--repo', root]).returncode, 0);
});
