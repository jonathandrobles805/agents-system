// Serve one build of the dashboard against the fixture data (register #77).
// Both builds run the same kit/dashboard/server.js from a checkout of the kit at fixture.json's kit_commit; the only
// difference between the two checkouts is kit/dashboard/index.html.
//
//   target   'original' → .data/kit-original (the commit as is)
//            'react'    → .data/kit-react (same commit, index.html replaced by the React build)
//   scenario 'live2'    server.js --repo node-api --repo python-service
//            'live1'    server.js --repo node-api
//            'livedup'  server.js --repo node-api --repo repos-dup/node-api (same project name twice, #63)
//            'pages'    a static server over index.html + status.json, no model.js (the Pages job, #7, #43, #64)
//            'empty'    a static server over index.html alone (#36)
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
// PARITY_DATA: another fixture build. Interaction tests that append to event logs use their own copy, so they never
// touch the data the captures read.
export const DATA = path.resolve(process.env.PARITY_DATA ?? path.join(HERE, '.data'));
export const FIXTURE = JSON.parse(fs.readFileSync(path.join(DATA, 'fixture.json'), 'utf8'));

export const kitDir = (target) => path.join(DATA, `kit-${target}`, 'kit');

/** PATH without any directory holding a `claude` executable, as kit/scripts/tests/dashboard.test.js does. */
function pathWithoutClaude() {
  return (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'claude'))).join(path.delimiter);
}

async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** Static file server for one directory; every request is logged (80c). Unknown files → 404 like GitHub Pages. */
async function staticServer(dir, log) {
  const port = await freePort();
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript; charset=utf-8' };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, rel === '/' ? 'index.html' : rel);
    const ok = file.startsWith(dir) && fs.existsSync(file) && fs.statSync(file).isFile();
    log.push(`${req.method} ${req.url} ${ok ? 200 : 404}`);
    if (!ok) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  srv.listen(port, '127.0.0.1');
  await once(srv, 'listening');
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

export async function serve(target, scenario) {
  const kit = kitDir(target);
  if (!fs.existsSync(path.join(kit, 'dashboard', 'index.html'))) throw new Error(`no build for target ${target} at ${kit}`);
  const log = [];
  if (scenario === 'pages' || scenario === 'empty') {
    const dir = path.join(DATA, `static-${target}-${scenario}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(kit, 'dashboard', 'index.html'), path.join(dir, 'index.html'));
    if (scenario === 'pages') fs.copyFileSync(path.join(DATA, 'pages', 'status.json'), path.join(dir, 'status.json'));
    return { ...(await staticServer(dir, log)), log };
  }
  const repos = { live2: [FIXTURE.repos.nodeApi, FIXTURE.repos.pySvc], live1: [FIXTURE.repos.nodeApi], livedup: [FIXTURE.repos.nodeApi, FIXTURE.repos.dup] }[scenario];
  if (!repos) throw new Error(`unknown scenario ${scenario}`);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(kit, 'dashboard', 'server.js'), ...repos.flatMap((r) => ['--repo', r]), '--port', String(port), '--no-open'], {
    env: { ...process.env, PATH: pathWithoutClaude(), CLAUDE_HOME: path.join(DATA, 'claude-home'), KIT_STATUS_NO_GH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => log.push(`stderr ${d}`));
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('agent-kit dashboard:')) resolve(); });
    child.once('exit', (code) => reject(new Error(`server.js exited ${code}: ${log.join('')}`)));
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    log,
    close: async () => { child.kill('SIGINT'); await once(child, 'exit'); },
  };
}
