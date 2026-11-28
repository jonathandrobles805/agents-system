// Hardening plan Step 10, "A drawer that opens each file": the server reads a lane's own files, read-only, from an
// allowlist built from the kit's path functions (3d, G3). Same Host and Origin checks as every other request (step 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { git } from './fixtures.js';
import { runScript, setEnv } from './helpers.js';
import { project, review } from './testdata.js';
import * as S from '../../dashboard/server.js';

const SLUG = 'refund-route';

async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

/** A served project with a started lane holding every kind of lane file, plus files that must never be served. */
async function withLane(t, fn) {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  const wt = JSON.parse(runScript('lane.js', ['start', SLUG, '--repo', root]).stdout).worktree;
  const spec = path.join(wt, 'docs', 'specs', `${SLUG}.md`);
  write(spec, fs.readFileSync(spec, 'utf8').replace(/^- Research: .*$/m, '- Research: refunds-api, payment-flow'));
  write(path.join(wt, 'docs', 'goals', `${SLUG}.md`), '# Goal: refund route\n\n## Summary\n\nA refund route.\n');
  write(path.join(wt, 'docs', 'research', 'refunds-api.md'), '# Research: refunds API\n');
  write(path.join(wt, 'docs', 'research', 'payment-flow.md'), '# Research: payment flow\n');
  write(path.join(wt, 'docs', 'research', 'unrelated.md'), '# Research: not this lane\n');
  const head = git(['rev-parse', 'HEAD'], wt).trim();
  write(path.join(wt, 'docs', 'specs', `${SLUG}.review.md`), review({ head: head.slice(0, 7), verdict: 'PASS' }));
  write(path.join(wt, 'docs', 'specs', `${SLUG}.events.jsonl`), '{"event":"read","result":"ok"}\n');
  write(path.join(wt, '.env'), 'SECRET=1\n');
  write(path.join(wt, 'docs', 'decisions', '0001-x.md'), '# Decision\n');
  const outside = path.join(fs.realpathSync(os.tmpdir()), `board-files-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, 'outside the worktree\n');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(wt, 'docs', 'specs', `${SLUG}.checks.txt`)); // an allowed name, pointing out
  const port = await freePort();
  const httpd = S.serve([root], port, false, 0.2);
  await once(httpd, 'listening');
  try {
    await fn({ port, root, wt });
  } finally {
    httpd.close();
  }
}

const q = (root, rel) => `?project=${encodeURIComponent(root)}${rel === undefined ? '' : `&path=${encodeURIComponent(rel)}`}`;
const ALLOWED = [
  'docs/goals/refund-route.md', 'docs/specs/refund-route.md', 'docs/research/refunds-api.md', 'docs/research/payment-flow.md',
  'docs/specs/refund-route.progress.md', 'docs/specs/refund-route.review.md', 'docs/specs/refund-route.events.jsonl',
];

test('3d: the list names every lane file that exists, with its size and, for a review, its verdict', async (t) => {
  await withLane(t, async ({ port, root, wt }) => {
    const r = await get(port, `/api/lane-files/${SLUG}${q(root)}`);
    assert.equal(r.status, 200, r.body);
    const files = JSON.parse(r.body);
    assert.deepEqual(files.map((f) => f.path).sort(), [...ALLOWED].sort(), 'the checks.txt symlink out of the worktree is not listed');
    for (const f of files) assert.equal(f.size, fs.statSync(path.join(wt, f.path)).size, f.path);
    assert.equal(files.find((f) => f.path.endsWith('.review.md')).verdict, 'PASS');
    assert.equal(files.find((f) => f.path.endsWith('.progress.md')).verdict, null);
  });
});

test('3d: every allowed file reads, as it is on disk', async (t) => {
  await withLane(t, async ({ port, root, wt }) => {
    for (const rel of ALLOWED) {
      const r = await get(port, `/api/lane-file/${SLUG}${q(root, rel)}`);
      assert.equal(r.status, 200, `${rel}: ${r.body}`);
      const j = JSON.parse(r.body);
      assert.equal(j.path, rel);
      assert.equal(j.text, fs.readFileSync(path.join(wt, rel), 'utf8'), rel);
    }
  });
});

test('3d: "..", absolute paths, a symlink out of the worktree, .env and any other file are refused (403)', async (t) => {
  await withLane(t, async ({ port, root, wt }) => {
    for (const rel of [
      '../../etc/passwd', 'docs/specs/../../.env', 'docs/specs/./refund-route.md', path.join(wt, 'docs', 'specs', `${SLUG}.md`), '/etc/passwd',
      `docs/specs/${SLUG}.checks.txt`, '.env', 'src/domain/payment.ts', 'docs/research/unrelated.md', 'docs/decisions/0001-x.md',
      '.claude/kit.json', '',
    ]) {
      const r = await get(port, `/api/lane-file/${SLUG}${q(root, rel)}`);
      assert.equal(r.status, 403, `${JSON.stringify(rel)} got ${r.status}: ${r.body}`);
      assert.ok(!r.body.includes('SECRET') && !r.body.includes('outside the worktree'), rel);
    }
    // a slug that is not one of the project's lanes
    assert.equal((await get(port, `/api/lane-file/nope${q(root, 'docs/goals/nope.md')}`)).status, 404);
  });
});

test('3d: the same Host and Origin checks as step 0', async (t) => {
  await withLane(t, async ({ port, root }) => {
    for (const p of [`/api/lane-files/${SLUG}${q(root)}`, `/api/lane-file/${SLUG}${q(root, ALLOWED[0])}`]) {
      assert.equal((await get(port, p, { Host: 'evil.example' })).status, 421, p);
      assert.equal((await get(port, p, { Origin: 'http://evil.example' })).status, 403, p);
      assert.equal((await get(port, p, { Origin: `http://127.0.0.1:${port}` })).status, 200, p);
    }
  });
});
