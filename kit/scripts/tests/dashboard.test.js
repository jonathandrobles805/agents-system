// Dashboard server: endpoints, live recompute on file change, SSE event streaming, open-claude guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { jsonDumps } from '../kitlib.js';
import { runScript, setEnv, tmpPath } from './helpers.js';
import { project } from './testdata.js';
import * as S from '../../dashboard/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const LAUNCHERS = ['osascript', 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];

/**
 * Make the server's "no claude on PATH" premise true on every machine: PATH loses every directory
 * that holds a claude executable, and gains a first directory of stand-in terminal launchers that
 * only record that they ran. Returns the record file; it exists only if a launcher was called.
 */
function noClaudeOnPath(t) {
  const dir = tmpPath(t);
  const record = path.join(dir, 'launched');
  for (const name of LAUNCHERS) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${record}"\n`, { mode: 0o755 });
  }
  const hasClaude = (d) => ['claude', 'claude.exe', 'claude.cmd'].some((n) => fs.existsSync(path.join(d, n)));
  const kept = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !hasClaude(d));
  setEnv(t, 'PATH', [dir, ...kept].join(path.delimiter));
  return record;
}

async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** One HTTP request without connection pooling: {status, headers, body (string)}. */
function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

/** GET: [status, parsed JSON when the response is application/json, otherwise the text]. */
async function get(url) {
  const r = await request(url);
  return [r.status, (r.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(r.body) : r.body];
}

/** Line-by-line reader over an open response stream; readLine(ms) resolves to a line, or null on timeout / end of stream. */
function lineReader(stream) {
  stream.setEncoding('utf8');
  const lines = [];
  let buf = '';
  let ended = false;
  let wake = null;
  const notify = () => {
    if (wake) wake();
  };
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i + 1));
      buf = buf.slice(i + 1);
    }
    notify();
  });
  for (const ev of ['end', 'close', 'error']) {
    stream.on(ev, () => {
      ended = true;
      notify();
    });
  }
  return async function readLine(ms) {
    if (!lines.length && !ended) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
    return lines.length ? lines.shift() : null;
  };
}

test('server endpoints and live updates', { timeout: 120000 }, async (t) => {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const launched = noClaudeOnPath(t);
  assert.equal(S.which('claude'), null, 'test premise: no claude on PATH');
  const { root } = project(t);
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const wt = out.worktree;
  const port = await freePort();
  const httpd = S.serve([root], port, false, 0.2);
  await once(httpd, 'listening');
  try {
    const base = `http://127.0.0.1:${port}`;
    let [code, html] = await get(`${base}/`);
    assert.ok(code === 200 && html.includes('agent-kit'));
    let st;
    [code, st] = await get(`${base}/api/status`);
    let lane = st.lanes.find((l) => l.slug === 'refund-route');
    assert.equal(lane.position, 'building');

    // SSE: connect, then change a watched file and append an event; both must arrive
    const stream = await new Promise((resolve, reject) => {
      http.get(`${base}/api/stream`, { agent: false }, resolve).on('error', reject);
    });
    const readLine = lineReader(stream);
    await new Promise((r) => setTimeout(r, 300));
    const prog = path.join(wt, 'docs/specs/refund-route.progress.md');
    fs.writeFileSync(
      prog,
      fs.readFileSync(prog, 'utf8').replaceAll('- Attempts: {{n}} of 3', '- Attempts: 3 of 3').replaceAll('- Failure: {{what fails}}', '- Failure: mock never called'),
    );
    fs.appendFileSync(
      path.join(wt, 'docs/specs/refund-route.events.jsonl'),
      jsonDumps({ ts: '2026-11-08T18:00:00', event: 'blocked', tool: 'Edit', path: 'src/x.ts', result: 'blocked' }) + '\n',
    );
    let gotStatus = false;
    let gotEvent = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !(gotStatus && gotEvent)) {
      const line = await readLine(deadline - Date.now());
      if (line === null) continue;
      if (line.startsWith('data: ')) {
        const msg = JSON.parse(line.slice(6));
        if (msg.type === 'status') {
          gotStatus = true;
          lane = msg.data[0].lanes.find((l) => l.slug === 'refund-route');
          assert.equal(lane.position, 'escalated');
        }
        if (msg.type === 'event' && msg.lane === 'refund-route') {
          gotEvent = true;
          assert.equal(msg.data.event, 'blocked');
        }
      }
    }
    stream.destroy();
    assert.ok(gotStatus && gotEvent);

    let events;
    [code, events] = await get(`${base}/api/events/refund-route`);
    assert.ok(code === 200 && events[events.length - 1].event === 'blocked');

    // open: local, but no `claude` on PATH here -> clean error, never a crash
    const r = await request(`${base}/api/open/refund-route`, 'POST');
    assert.ok([500, 404].includes(r.status), `expected 500, got ${r.status}`);
    const body = JSON.parse(r.body);
    assert.ok(body.ok === false && body.error);
    assert.ok(!fs.existsSync(launched), `a terminal launcher ran: ${fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : ''}`);
  } finally {
    await new Promise((resolve) => httpd.close(resolve));
  }
});

test('index html is self contained', () => {
  const html = fs.readFileSync(path.resolve(HERE, '..', '..', 'dashboard', 'index.html'), 'utf8');
  // No external loads of any kind: no script/link/img/iframe sources, no CDN, no web fonts.
  assert.ok(!/<script[^>]*\ssrc=/i.test(html), 'no external <script src>');
  assert.ok(!/<link\b/i.test(html), 'no <link> (stylesheets, fonts)');
  assert.ok(!/@import|@font-face|url\(\s*['"]?https?:/i.test(html), 'no CSS imports or remote fonts');
  assert.ok(!/<(img|iframe|embed|object)\b[^>]*\ssrc=['"]?https?:/i.test(html), 'no remote media');
  assert.ok(!/cdn|unpkg|jsdelivr|googleapis/i.test(html), 'no CDN');
  assert.ok(html.includes('status.json') && html.includes('/api/stream') && html.includes('/api/open/'));
  assert.ok(html.includes('/api/architecture') && html.includes("import('./model.js')"));
});

test('the dashboard watches the lane store, so a stage move refreshes it (hardening plan Step 2)', (t) => {
  const { root } = project(t);
  assert.equal(runScript('lane.js', ['start', 'refund-route', '--repo', root]).returncode, 0);
  assert.ok(S.watchedFiles([root]).includes(path.join(root, '.claude', 'session', 'lanes', 'refund-route.json')));
});
