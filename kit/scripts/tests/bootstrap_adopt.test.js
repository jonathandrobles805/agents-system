// Step 2c (KIT-SPEC 10.10, 10.11): database detection and the lane adapter; adopting an existing decisions convention
// instead of duplicating it; the regenerable CLAUDE.md kit block; a second bootstrap changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDatabase, KIT_BLOCK_BEGIN, KIT_BLOCK_END } from '../bootstrap.js';
import * as F from './fixtures.js';
import { runScript, tmpPath } from './helpers.js';

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
const addDep = (root, name) => {
  const pj = path.join(root, 'package.json');
  const p = JSON.parse(read(pj));
  p.dependencies = { ...(p.dependencies ?? {}), [name]: '1.0.0' };
  fs.writeFileSync(pj, JSON.stringify(p, null, 2));
};

test('detectDatabase maps evidence to the adapter the spec names', (t) => {
  const cases = [
    ['@supabase/supabase-js', null, 'supabase', 'emulator'],
    ['firebase-admin', null, 'firebase', 'emulator'],
    ['@neondatabase/serverless', null, 'neon', 'branch'],
    ['@planetscale/database', null, 'planetscale', 'branch'],
    ['pg', null, 'postgres', 'local'],
    ['mongoose', null, 'mongodb', 'local'],
    ['better-sqlite3', null, 'sqlite', 'local'],
    [null, ['prisma/schema.prisma', 'datasource db {\n  provider = "mysql"\n}\n'], 'mysql', 'local'],
    [null, ['docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n'], 'postgres', 'local'],
  ];
  for (const [dep, file, kind, adapter] of cases) {
    const root = F.nodeApi(path.join(tmpPath(t), `db-${kind}-${dep ?? 'file'}`.replace(/[^a-z0-9-]/gi, '_')));
    if (dep) addDep(root, dep);
    if (file) write(path.join(root, file[0]), file[1]);
    const d = detectDatabase(root);
    assert.equal(d.kind, kind, `${dep ?? file[0]} → kind`);
    assert.equal(d.adapter, adapter, `${dep ?? file[0]} → adapter`);
  }
  const none = detectDatabase(F.nodeApi(path.join(tmpPath(t), 'db-none')));
  assert.deepEqual([none.kind, none.adapter], [null, 'none']);
});

test('bootstrap records db.lane_adapter and paths; an answer overrides detection; a second run keeps them', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  addDep(root, '@supabase/supabase-js');
  const out = boot(root);
  assert.equal(kitJson(root).db.lane_adapter, 'emulator');
  assert.equal(kitJson(root).db.kind, 'supabase');
  assert.deepEqual(kitJson(root).paths, { decisions: 'docs/decisions', work: 'docs/specs' });
  assert.ok(!out.questions.some((q) => q.id === 'db_adapter'), 'no question when the database was detected');
  // the project without a database is asked, and the answer is recorded
  const root2 = F.nodeApi(path.join(tmpPath(t), 'node-api-2'));
  const out2 = boot(root2);
  assert.ok(out2.questions.some((q) => q.id === 'db_adapter'));
  assert.equal(kitJson(root2).db.lane_adapter, 'none');
  const ans = path.join(tmpPath(t), 'answers.json');
  fs.writeFileSync(ans, JSON.stringify({ db_adapter: 'branch' }));
  fs.rmSync(path.join(root2, '.claude', 'kit.json'));
  boot(root2, '--answers', ans);
  assert.equal(kitJson(root2).db.lane_adapter, 'branch');
  // an existing value is never overwritten by re-detection
  const kj = kitJson(root2);
  kj.db.lane_adapter = 'local';
  fs.writeFileSync(path.join(root2, '.claude', 'kit.json'), JSON.stringify(kj));
  boot(root2, '--upgrade');
  assert.equal(kitJson(root2).db.lane_adapter, 'local');
});

test('an existing ADR folder is adopted with its own numbering; no second decisions folder appears (fault 26)', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  write(path.join(root, 'docs', 'adr', '001-use-postgres.md'), '# 001 Use Postgres\n');
  write(path.join(root, 'docs', 'adr', '002-monorepo.md'), '# 002 Monorepo\n');
  const out = boot(root);
  assert.ok(!fs.existsSync(path.join(root, 'docs', 'decisions')), 'kit must not create docs/decisions next to docs/adr');
  assert.ok(fs.existsSync(path.join(root, 'docs', 'adr', '003-adopt-agent-kit.md')), fs.readdirSync(path.join(root, 'docs', 'adr')).join(','));
  assert.equal(kitJson(root).paths.decisions, 'docs/adr');
  assert.ok(out.written.includes('docs/adr/003-adopt-agent-kit.md'));
  assert.ok(read(root, 'CLAUDE.md').includes('Decisions: `docs/adr/`'));
  // a fresh project gets the kit's default and four-digit numbering
  const root2 = F.nodeApi(path.join(tmpPath(t), 'node-api-2'));
  boot(root2);
  assert.ok(fs.existsSync(path.join(root2, 'docs', 'decisions', '0001-adopt-agent-kit.md')));
});

test('a second bootstrap is a no-op for human files and reports every skip', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  const before = Object.fromEntries(['CLAUDE.md', 'ROADMAP.md', 'ARCHITECTURE.md', 'DESIGN.md', 'LESSONS.md', 'docs/decisions/0001-adopt-agent-kit.md'].map((f) => [f, read(root, f)]));
  const out = boot(root);
  for (const [f, text] of Object.entries(before)) assert.equal(read(root, f), text, `${f} unchanged`);
  assert.ok(out.skipped.some((s) => s.startsWith('CLAUDE.md')));
  assert.ok(!fs.existsSync(path.join(root, 'docs', 'decisions', '0002-adopt-agent-kit.md')), 'the adoption decision is written once');
});

test('CLAUDE.md: the kit block is regenerated on upgrade and the human text outside it is kept byte for byte', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  const cm = path.join(root, 'CLAUDE.md');
  const text = read(cm);
  assert.ok(text.includes(KIT_BLOCK_BEGIN) && text.includes(KIT_BLOCK_END));
  // a human edits above and below the block, and stales the block's content
  const human = text.replace('## Project map', '## Project map\n- `vendor/` — third-party code, never edited by lanes\n').replace(/lane db: none/, 'lane db: STALE') + '\n## Team notes\n- deploy on Fridays only\n';
  fs.writeFileSync(cm, human);
  const kj = kitJson(root);
  kj.db.lane_adapter = 'local';
  fs.writeFileSync(path.join(root, '.claude', 'kit.json'), JSON.stringify(kj));
  boot(root, '--upgrade');
  const after = read(cm);
  assert.ok(after.includes('- `vendor/` — third-party code, never edited by lanes'));
  assert.ok(after.endsWith('\n## Team notes\n- deploy on Fridays only\n'));
  assert.ok(after.includes('lane db: local'), 'kit block regenerated from kit.json');
  assert.ok(!after.includes('STALE'));
  const outside = (s) => s.slice(0, s.indexOf(KIT_BLOCK_BEGIN)) + s.slice(s.indexOf(KIT_BLOCK_END) + KIT_BLOCK_END.length);
  assert.equal(outside(after), outside(human).replace(/agent-kit \d+\.\d+\.\d+/g, (m) => m));
  // a CLAUDE.md without markers (a project's own, or pre-2c): its text is kept byte for byte and the kit block is
  // appended once (field test #13); a second upgrade does not add a second block
  const ver = read(path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), '..', 'VERSION')).trim();
  fs.writeFileSync(cm, '# Mine\n\nKit: agent-kit 0.1.0\n\nhand-written only\n');
  boot(root, '--upgrade');
  const once = read(cm);
  assert.ok(once.startsWith(`# Mine\n\nKit: agent-kit ${ver}\n\nhand-written only\n\n${KIT_BLOCK_BEGIN}\n`), once);
  assert.equal(once.split(KIT_BLOCK_BEGIN).length, 2);
  boot(root, '--upgrade');
  assert.equal(read(cm), once);
});
