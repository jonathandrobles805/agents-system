// Dashboard server security: Host check, cross-site POST, terminal command, read-only GET.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { runScript, setEnv } from './helpers.js';
import * as L from '../lane.js';
import { project } from './testdata.js';
import * as S from '../../dashboard/server.js';

async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** One request to 127.0.0.1:port with exact headers; resolves {status, body}. */
function raw(port, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function withServer(t, fn) {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  const port = await freePort();
  const httpd = S.serve([root], port, false, 0.2);
  await once(httpd, 'listening');
  try {
    await fn({ port, root });
  } finally {
    httpd.close();
  }
}

test('0a: only a Host of 127.0.0.1:<port> or localhost:<port> is answered', async (t) => {
  await withServer(t, async ({ port }) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      assert.equal((await raw(port, 'GET', '/api/status', { Host: host })).status, 200, host);
    }
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost:${port + 1}`, '127.0.0.1']) {
      const r = await raw(port, 'GET', '/api/status', { Host: host });
      assert.ok([403, 421].includes(r.status), `Host ${JSON.stringify(host)} got ${r.status}`);
    }
    // no Host header at all (HTTP/1.0 over a raw socket; Node's client would fill one in)
    const status = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET /api/status HTTP/1.0\r\n\r\n'));
      let buf = '';
      sock.on('data', (d) => (buf += d));
      sock.on('end', () => resolve(Number(buf.split(' ')[1])));
      sock.on('error', reject);
    });
    assert.ok([403, 421].includes(status), `no Host got ${status}`);
  });
});

test('0b: a POST whose Origin is present and not this server\'s own is refused with 403', async (t) => {
  await withServer(t, async ({ port }) => {
    const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    // an unknown lane answers 404 once the request is let through; 403 means it was refused before that
    for (const origin of own) {
      const r = await raw(port, 'POST', '/api/open/nope?project=x', { Host: `127.0.0.1:${port}`, Origin: origin });
      assert.equal(r.status, 404, `own origin ${origin}`);
    }
    const none = await raw(port, 'POST', '/api/open/nope?project=x', { Host: `127.0.0.1:${port}` });
    assert.equal(none.status, 404, 'no Origin header (curl, same-origin fetch in some browsers)');
    for (const origin of ['https://evil.example', 'http://evil.example', `http://127.0.0.1.evil.example:${port}`, `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, 'null']) {
      const r = await raw(port, 'POST', '/api/open/nope?project=x', { Host: `127.0.0.1:${port}`, Origin: origin });
      assert.equal(r.status, 403, `Origin ${origin}`);
    }
  });
});

/** path -> content hash of every file under dir except .git. */
function snapshot(dir, out = new Map(), base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(p, out, base);
    else if (e.isFile()) out.set(path.relative(base, p), crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
  }
  return out;
}

test('0d: GET /api/architecture writes no file and appends no event, even when the lane would be rerouted', async (t) => {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  const goal = path.join(root, 'docs', 'goals', 'refund-route.md');
  fs.mkdirSync(path.dirname(goal), { recursive: true });
  fs.writeFileSync(goal, '# Goal: refund-route\n\n- Slug: refund-route\n- Date: 2026-11-11\n- Agreed by: Jonathan and Claude on 2026-11-11\n- Status: agreed\n\n## What we want\n\nA refund route.\n\n## Done looks like\n\n- G1. routes exposes refund\n');
  L.setGoalField(root, 'refund-route', 'Work type', 'fix (provisional)');
  const started = runScript('lane.js', ['start', 'refund-route', '--repo', root]);
  assert.equal(started.returncode, 0, started.stderr);
  const wt = JSON.parse(started.stdout).worktree;
  const prog = path.join(wt, 'docs', 'specs', 'refund-route.progress.md');
  fs.appendFileSync(prog, '\n## Reproduction\n\ncause: boot failure\n'); // the debugger's evidence: a provisional fix becomes an incident
  const port = await freePort();
  const httpd = S.serve([root], port, false, 60);
  await once(httpd, 'listening');
  try {
    const before = [snapshot(root), snapshot(wt)];
    const r = await raw(port, 'GET', '/api/architecture', { Host: `127.0.0.1:${port}` });
    assert.equal(r.status, 200);
    assert.deepEqual([snapshot(root), snapshot(wt)], before, 'a GET changed a file');
    assert.ok(fs.readFileSync(path.join(root, 'docs', 'goals', 'refund-route.md'), 'utf8').includes('(provisional)'), 'the goal file was rewritten');
    // the answer still says what the controller would do
    const lane = JSON.parse(r.body).projects[0].lanes.find((l) => l.slug === 'refund-route');
    assert.equal(lane.reroute_pending?.to, 'incident');
  } finally {
    httpd.close();
  }
});
