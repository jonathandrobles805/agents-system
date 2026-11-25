// Dashboard server security: Host check, cross-site POST, terminal command, read-only GET.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setEnv } from './helpers.js';
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
