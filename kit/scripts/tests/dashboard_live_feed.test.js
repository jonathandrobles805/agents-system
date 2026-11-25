// Dashboard live feed: the SSE stream loses no event line (half-written lines, rewritten files, same slug in two projects, both event files).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { jsonDumps } from '../kitlib.js';
import { runScript, setEnv, tmpPath } from './helpers.js';
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

/** Serve `roots`, connect to /api/stream, and collect every `event` message. */
async function liveFeed(t, roots) {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const port = await freePort();
  const httpd = S.serve(roots, port, false, 0.1);
  await once(httpd, 'listening');
  const messages = [];
  const res = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/stream`, { agent: false }, resolve).on('error', reject);
  });
  res.setEncoding('utf8');
  let buf = '';
  res.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (block.startsWith('data: ')) messages.push(JSON.parse(block.slice(6)));
    }
  });
  await new Promise((r) => setTimeout(r, 400)); // the watcher has seeded its offsets
  const events = () => messages.filter((m) => m.type === 'event');
  const waitFor = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  t.after(async () => {
    res.destroy();
    await new Promise((resolve) => httpd.close(resolve));
  });
  return { events, waitFor };
}

function startLane(root) {
  const out = runScript('lane.js', ['start', 'refund-route', '--repo', root]);
  assert.equal(out.returncode, 0, out.stderr);
  return JSON.parse(out.stdout).worktree;
}

const line = (event, extra = {}) => jsonDumps({ ts: '2026-11-24T10:00:00', event, ...extra }) + '\n';
const is = (name) => (m) => m.data?.event === name;

test('1a: a half-written line is not consumed; once finished it arrives', async (t) => {
  const { root } = project(t);
  const wt = startLane(root);
  const file = path.join(wt, 'docs', 'specs', 'refund-route.events.jsonl');
  const feed = await liveFeed(t, [root]);
  const whole = line('test_half_finished');
  fs.appendFileSync(file, line('test_good') + whole.slice(0, 20)); // a good line and half of the next, landing together
  assert.ok(await feed.waitFor(is('test_good')), 'the good line arrives');
  await new Promise((r) => setTimeout(r, 400)); // several ticks pass with the half line unfinished
  fs.appendFileSync(file, whole.slice(20)); // the writer finishes its line
  assert.ok(await feed.waitFor(is('test_half_finished')), 'the finished line never arrived');
  assert.equal(feed.events().filter(is('test_half_finished')).length, 1);
});

test('1b: a rewritten (shorter) file is noticed once, and the line appended after it arrives', async (t) => {
  const { root } = project(t);
  const wt = startLane(root);
  const file = path.join(wt, 'docs', 'specs', 'refund-route.events.jsonl');
  const feed = await liveFeed(t, [root]);
  fs.appendFileSync(file, line('test_before_1', { pad: 'x'.repeat(200) }) + line('test_before_2', { pad: 'y'.repeat(200) }));
  assert.ok(await feed.waitFor(is('test_before_2')), 'the lines before the rewrite arrive');
  fs.writeFileSync(file, line('test_rewritten')); // the file is rewritten, shorter than the offset the server holds
  const notice = await feed.waitFor(is('events_file_rewritten'));
  assert.ok(notice, 'the rewrite is announced, not silent');
  assert.equal(notice.lane, 'refund-route');
  fs.appendFileSync(file, line('test_after_rewrite')); // a hook appends
  assert.ok(await feed.waitFor(is('test_after_rewrite')), 'the line appended after the rewrite never arrived');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(feed.events().filter(is('events_file_rewritten')).length, 1, 'the notice is sent once');
});

test('1c: two projects with the same slug do not share an offset', async (t) => {
  const a = project(t, { dir: tmpPath(t) });
  const b = project(t, { dir: tmpPath(t) });
  const wtA = startLane(a.root);
  const wtB = startLane(b.root);
  const fileA = path.join(wtA, 'docs', 'specs', 'refund-route.events.jsonl');
  const fileB = path.join(wtB, 'docs', 'specs', 'refund-route.events.jsonl');
  fs.appendFileSync(fileA, line('test_old_a', { pad: 'x'.repeat(300) })); // A has history before the server starts; B has none
  const feed = await liveFeed(t, [a.root, b.root]);
  fs.appendFileSync(fileB, line('test_new_b'));
  assert.ok(await feed.waitFor(is('test_new_b')), 'B\'s new line arrives');
  fs.appendFileSync(fileA, line('test_new_a'));
  assert.ok(await feed.waitFor(is('test_new_a')), 'A\'s new line arrives');
  assert.equal(feed.events().filter(is('test_old_a')).length, 0, 'A\'s history is not replayed because B shared its offset');
  assert.equal(feed.events().find(is('test_new_a')).root, a.root);
  assert.equal(feed.events().find(is('test_new_b')).root, b.root);
});

